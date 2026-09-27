#!/usr/bin/env python3
"""photorganize indexer: one-time face scan -> person IDs -> encrypted index for the web app.

Steps (each resumable / re-runnable):
  scan     detect + embed every face in a local photo folder   (slow, resumable)
  cluster  group faces into person IDs, write contact sheet + names.csv template
  drive    map local file paths to Google Drive file IDs
  build    write docs/data/index.enc (encrypted with a passphrase), overlaying names.csv

Run `python photorganize.py all PHOTOS_DIR --drive-folder URL --api-key KEY` to do everything.
"""
import argparse
import base64
import csv
import gzip
import hashlib
import html
import json
import os
import re
import secrets
import struct
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort
from PIL import Image, ImageOps

try:
    import pillow_heif  # optional HEIC support
    pillow_heif.register_heif_opener()
    EXTS = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"}
except ImportError:
    EXTS = {".jpg", ".jpeg", ".png", ".webp"}

ROOT = Path(__file__).resolve().parent.parent
MODELS = ROOT / "docs" / "models"

# Must match docs/js/face.js
MAX_SIDE = 1600
DET_SIZE = 640
DET_THRESH = 0.5
NMS_THRESH = 0.4
ARCFACE_DST = np.array([[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366],
                        [41.5493, 92.3655], [70.7299, 92.2041]], dtype=np.float32)


# ---------------------------------------------------------------- face pipeline

class FacePipeline:
    def __init__(self, models=MODELS):
        opts = ort.SessionOptions()
        providers = [p for p in ("CUDAExecutionProvider", "CoreMLExecutionProvider", "CPUExecutionProvider")
                     if p in ort.get_available_providers()]
        self.det = ort.InferenceSession(str(models / "det_500m.onnx"), opts, providers=providers)
        self.rec = ort.InferenceSession(str(models / "w600k_mbf.onnx"), opts, providers=providers)
        self.det_in = self.det.get_inputs()[0].name
        self.rec_in = self.rec.get_inputs()[0].name
        self._anchors = {}

    def anchors(self, stride):
        if stride not in self._anchors:
            n = DET_SIZE // stride
            ys, xs = np.mgrid[:n, :n]
            c = np.stack([xs, ys], -1).reshape(-1, 2).astype(np.float32) * stride
            self._anchors[stride] = np.repeat(c, 2, axis=0)  # 2 anchors per location
        return self._anchors[stride]

    def detect(self, rgb):
        h, w = rgb.shape[:2]
        scale = min(DET_SIZE / w, DET_SIZE / h)
        nw, nh = round(w * scale), round(h * scale)
        canvas = np.zeros((DET_SIZE, DET_SIZE, 3), np.uint8)
        canvas[:nh, :nw] = cv2.resize(rgb, (nw, nh), interpolation=cv2.INTER_LINEAR)
        blob = ((canvas.astype(np.float32) - 127.5) / 128.0).transpose(2, 0, 1)[None]
        outs = self.det.run(None, {self.det_in: blob})
        boxes, scores, kpss = [], [], []
        for i, stride in enumerate((8, 16, 32)):
            sc = outs[i].reshape(-1)
            bb = outs[i + 3].reshape(-1, 4) * stride
            kp = outs[i + 6].reshape(-1, 10) * stride
            keep = np.where(sc >= DET_THRESH)[0]
            if not len(keep):
                continue
            a = self.anchors(stride)[keep]
            bb, kp = bb[keep], kp[keep]
            boxes.append(np.stack([a[:, 0] - bb[:, 0], a[:, 1] - bb[:, 1],
                                   a[:, 0] + bb[:, 2], a[:, 1] + bb[:, 3]], -1))
            kpss.append(kp.reshape(-1, 5, 2) + a[:, None, :])
            scores.append(sc[keep])
        if not boxes:
            return []
        boxes = np.concatenate(boxes) / scale
        kpss = np.concatenate(kpss) / scale
        scores = np.concatenate(scores)
        keep = nms(boxes, scores, NMS_THRESH)
        return [(boxes[k], kpss[k], float(scores[k])) for k in keep]

    def embed(self, rgb, kpss):
        crops = [cv2.warpAffine(rgb, similarity(k, ARCFACE_DST), (112, 112), flags=cv2.INTER_LINEAR,
                                borderValue=0) for k in kpss]
        blob = ((np.stack(crops).astype(np.float32) - 127.5) / 127.5).transpose(0, 3, 1, 2)
        embs = np.concatenate([self.rec.run(None, {self.rec_in: blob[i:i + 1]})[0] for i in range(len(blob))])
        return embs / np.linalg.norm(embs, axis=1, keepdims=True)


def nms(boxes, scores, thresh):
    order = scores.argsort()[::-1]
    area = (boxes[:, 2] - boxes[:, 0]) * (boxes[:, 3] - boxes[:, 1])
    keep = []
    while len(order):
        i = order[0]
        keep.append(i)
        xx1 = np.maximum(boxes[i, 0], boxes[order[1:], 0])
        yy1 = np.maximum(boxes[i, 1], boxes[order[1:], 1])
        xx2 = np.minimum(boxes[i, 2], boxes[order[1:], 2])
        yy2 = np.minimum(boxes[i, 3], boxes[order[1:], 3])
        inter = np.maximum(0, xx2 - xx1) * np.maximum(0, yy2 - yy1)
        iou = inter / (area[i] + area[order[1:]] - inter)
        order = order[1:][iou <= thresh]
    return keep


def similarity(src, dst):
    """Least-squares 2D similarity transform (no reflection) mapping src -> dst, as 2x3 matrix."""
    sm, dm = src.mean(0), dst.mean(0)
    s, d = src - sm, dst - dm
    den = (s ** 2).sum()
    a = (s[:, 0] * d[:, 0] + s[:, 1] * d[:, 1]).sum() / den
    b = (s[:, 0] * d[:, 1] - s[:, 1] * d[:, 0]).sum() / den
    tx = dm[0] - (a * sm[0] - b * sm[1])
    ty = dm[1] - (b * sm[0] + a * sm[1])
    return np.array([[a, -b, tx], [b, a, ty]], dtype=np.float32)


def load_rgb(path):
    """Load, apply EXIF rotation, downscale to MAX_SIDE. Returns (rgb array, original w, h)."""
    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im).convert("RGB")
        ow, oh = im.size
        if max(ow, oh) > MAX_SIDE:
            im.thumbnail((MAX_SIDE, MAX_SIDE), Image.BILINEAR)
        return np.asarray(im), ow, oh


def face_crop(rgb, box, size=96):
    x1, y1, x2, y2 = box
    cx, cy, side = (x1 + x2) / 2, (y1 + y2) / 2, max(x2 - x1, y2 - y1) * 1.5
    s = size / side
    m = np.array([[s, 0, size / 2 - cx * s], [0, s, size / 2 - cy * s]], dtype=np.float32)
    crop = cv2.warpAffine(rgb, m, (size, size), flags=cv2.INTER_AREA, borderMode=cv2.BORDER_REPLICATE)
    ok, buf = cv2.imencode(".jpg", cv2.cvtColor(crop, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 82])
    return buf.tobytes()


# ---------------------------------------------------------------- embeddings <-> int8

def q8(v):
    """Quantize a unit vector to int8 with per-vector scale (matches docs/js/face.js)."""
    scale = float(np.abs(v).max()) / 127.0
    return np.round(v / scale).astype(np.int8), scale


def b64(b):
    return base64.b64encode(b).decode()


# ---------------------------------------------------------------- scan

def cmd_scan(a):
    photos_dir = Path(a.photos).resolve()
    work = Path(a.work)
    (work / "crops").mkdir(parents=True, exist_ok=True)
    ckpt = work / "scan.jsonl"
    done = set()
    if ckpt.exists():
        with ckpt.open() as f:
            for line in f:
                try:
                    done.add(json.loads(line)["path"])
                except json.JSONDecodeError:
                    pass  # truncated last line from an interrupted run
    files = sorted(p for p in photos_dir.rglob("*") if p.suffix.lower() in EXTS and not p.name.startswith("."))
    todo = [p for p in files if p.relative_to(photos_dir).as_posix() not in done]
    print(f"{len(files)} photos, {len(done)} already scanned, {len(todo)} to go")
    if not todo:
        return
    fp = FacePipeline()
    t0 = time.time()
    nfaces = 0
    with ckpt.open("a") as out:
        for i, p in enumerate(todo, 1):
            rel = p.relative_to(photos_dir).as_posix()
            rec = {"path": rel, "faces": []}
            try:
                rgb, ow, oh = load_rgb(p)
                h, w = rgb.shape[:2]
                rec.update(w=ow, h=oh)
                dets = [d for d in fp.detect(rgb) if min(d[0][2] - d[0][0], d[0][3] - d[0][1]) >= a.min_size]
                if dets:
                    embs = fp.embed(rgb, [d[1] for d in dets])
                    fid = hashlib.sha1(rel.encode()).hexdigest()[:12]
                    for k, ((box, _, score), e) in enumerate(zip(dets, embs)):
                        qv, qs = q8(e)
                        name = f"{fid}_{k}"
                        (work / "crops" / f"{name}.jpg").write_bytes(face_crop(rgb, box))
                        x1, y1, x2, y2 = [float(v) for v in box]
                        rec["faces"].append({
                            "id": name, "s": round(score, 3),
                            "b": [round(x1 / w, 4), round(y1 / h, 4), round((x2 - x1) / w, 4), round((y2 - y1) / h, 4)],
                            "px": round(min(x2 - x1, y2 - y1)), "e": b64(qv.tobytes()), "q": qs,
                        })
                    nfaces += len(dets)
            except Exception as ex:  # corrupt file etc. -- record and move on
                rec["error"] = str(ex)
                print(f"  ! {rel}: {ex}", file=sys.stderr)
            out.write(json.dumps(rec) + "\n")
            if i % 25 == 0 or i == len(todo):
                out.flush()
                el = time.time() - t0
                print(f"  {i}/{len(todo)}  {nfaces} faces  {i / el:.1f} img/s  eta {(len(todo) - i) * el / i / 60:.1f} min",
                      flush=True)


def load_scan(work):
    photos, faces = [], []
    with (Path(work) / "scan.jsonl").open() as f:
        for line in f:
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            if "error" in r:
                continue
            pi = len(photos)
            photos.append({"path": r["path"], "w": r["w"], "h": r["h"]})
            for fc in r["faces"]:
                fc["p"] = pi
                faces.append(fc)
    return photos, faces


def dequant(faces):
    E = np.stack([np.frombuffer(base64.b64decode(f["e"]), np.int8).astype(np.float32) * f["q"] for f in faces])
    return E / np.linalg.norm(E, axis=1, keepdims=True)


# ---------------------------------------------------------------- cluster

def chinese_whispers(E, thresh, k=30, iters=30, seed=0):
    """Graph clustering on the k-NN similarity graph (edges with cosine >= thresh)."""
    n = len(E)
    nbrs, wts = [], []
    for s in range(0, n, 1024):
        sim = E[s:s + 1024] @ E.T
        kk = min(k + 1, n)
        idx = np.argpartition(-sim, kk - 1, axis=1)[:, :kk]
        for r in range(len(idx)):
            i = s + r
            j = idx[r][(idx[r] != i) & (sim[r, idx[r]] >= thresh)]
            nbrs.append(j)
            wts.append(sim[r, j])
    labels = np.arange(n)
    rng = np.random.default_rng(seed)
    for _ in range(iters):
        changed = 0
        for i in rng.permutation(n):
            if not len(nbrs[i]):
                continue
            acc = {}
            for j, w in zip(nbrs[i], wts[i]):
                acc[labels[j]] = acc.get(labels[j], 0.0) + w
            best = max(acc, key=acc.get)
            if best != labels[i]:
                labels[i] = best
                changed += 1
        if not changed:
            break
    return labels


def merge_by_centroid(E, labels, thresh):
    """Merge clusters whose (normalized) centroids are very similar -- fixes pose/lighting splits.
    Singletons are left to the graph step; each round unions all pairs above thresh."""
    while True:
        uniq, inv = np.unique(labels, return_inverse=True)
        counts = np.bincount(inv)
        big = np.where(counts >= 2)[0]
        if len(big) < 2:
            return labels
        C = np.zeros((len(uniq), E.shape[1]), np.float32)
        np.add.at(C, inv, E)
        C = C[big] / np.linalg.norm(C[big], axis=1, keepdims=True)
        S = C @ C.T
        np.fill_diagonal(S, -1)
        pairs = np.argwhere(np.triu(S >= thresh))
        if not len(pairs):
            return labels
        parent = list(range(len(big)))

        def find(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x
        for i, j in pairs:
            parent[find(j)] = find(i)
        remap = {uniq[big[k]]: uniq[big[find(k)]] for k in range(len(big))}
        labels = np.array([remap.get(l, l) for l in labels])


def cmd_cluster(a):
    work = Path(a.work)
    photos, faces = load_scan(work)
    faces = [f for f in faces if f["s"] >= a.min_score and f["px"] >= a.min_size]
    print(f"{len(photos)} photos, {len(faces)} usable faces")
    if not faces:
        sys.exit("no faces found")
    E = dequant(faces)
    labels = chinese_whispers(E, a.threshold)
    labels = merge_by_centroid(E, labels, a.merge_threshold)

    groups = {}
    for fi, l in enumerate(labels):
        groups.setdefault(int(l), []).append(fi)
    # One face per photo per person (keep best), then drop tiny clusters.
    people = []
    for members in groups.values():
        by_photo = {}
        for fi in members:
            p = faces[fi]["p"]
            if p not in by_photo or faces[fi]["s"] * faces[fi]["px"] > faces[by_photo[p]]["s"] * faces[by_photo[p]]["px"]:
                by_photo[p] = fi
        if len(by_photo) >= a.min_photos:
            people.append(sorted(by_photo.values(), key=lambda fi: faces[fi]["p"]))

    # Stable-ish IDs: previous run's IDs are kept for clusters that overlap an old one.
    prev = {}
    old_path = work / "people.json"
    if old_path.exists():
        for pp in json.loads(old_path.read_text())["people"]:
            for fid in pp["faces"]:
                prev[fid] = pp["id"]
    people.sort(key=len, reverse=True)
    used, out, next_id = set(), [], max(prev.values(), default=0) + 1
    for members in people:
        votes = {}
        for fi in members:
            pid = prev.get(faces[fi]["id"])
            if pid is not None and pid not in used:
                votes[pid] = votes.get(pid, 0) + 1
        if votes and max(votes.values()) >= len(members) * 0.3:
            pid = max(votes, key=votes.get)
        else:
            pid, next_id = next_id, next_id + 1
        used.add(pid)
        cover = max(members, key=lambda fi: faces[fi]["s"] * min(faces[fi]["px"], 200))
        out.append({"id": pid, "faces": [faces[fi]["id"] for fi in members], "cover": faces[cover]["id"],
                    "photos": sorted({faces[fi]["p"] for fi in members})})
    out.sort(key=lambda p: -len(p["photos"]))
    old_path.write_text(json.dumps({"photos": photos, "people": out}))
    print(f"{len(out)} people with >= {a.min_photos} photos "
          f"(covering {len({p for pp in out for p in pp['photos']})} photos)")

    names = read_names(work / "names.csv")
    with (work / "names.csv").open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["id", "name", "photos"])
        for pp in out:
            w.writerow([pp["id"], names.get(pp["id"], ""), len(pp["photos"])])
    write_sheet(work, out, names)
    print(f"-> {work / 'people.html'} (contact sheet)  {work / 'names.csv'} (fill in names)")


def read_names(path):
    names = {}
    if Path(path).exists():
        with open(path, newline="", encoding="utf-8-sig") as f:
            for row in csv.DictReader(f):
                if row.get("id", "").strip().isdigit() and row.get("name", "").strip():
                    names[int(row["id"])] = row["name"].strip()
    return names


def write_sheet(work, people, names):
    cards = []
    for pp in people:
        samples = [pp["cover"]] + [f for f in pp["faces"] if f != pp["cover"]][:7]
        imgs = "".join(f'<img src="crops/{f}.jpg" loading="lazy">' for f in samples)
        nm = html.escape(names.get(pp["id"], ""))
        cards.append(f'<div class="c"><b>#{pp["id"]}</b> {nm} <small>{len(pp["photos"])} photos</small>'
                     f'<div>{imgs}</div></div>')
    (Path(work) / "people.html").write_text(
        "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'>"
        "<title>People</title><style>body{font:14px system-ui;margin:16px;background:#fafafa}"
        ".c{background:#fff;border:1px solid #ddd;border-radius:8px;padding:8px;margin:8px 0}"
        ".c img{width:72px;height:72px;border-radius:6px;margin:4px 4px 0 0}small{color:#777}</style>"
        "<h1>People</h1><p>Fill <code>names.csv</code> with <code>id,name</code>. Same name on two IDs merges them; "
        "name <code>-</code> hides an ID.</p>" + "".join(cards), encoding="utf-8")


# ---------------------------------------------------------------- drive

def drive_folder_id(url):
    m = re.search(r"folders/([A-Za-z0-9_-]+)", url) or re.search(r"[?&]id=([A-Za-z0-9_-]+)", url)
    return m.group(1) if m else url


def list_drive(folder, key, prefix=""):
    out, token = {}, None
    while True:
        q = {"q": f"'{folder}' in parents and trashed=false", "key": key, "pageSize": 1000,
             "fields": "nextPageToken,files(id,name,mimeType)", "supportsAllDrives": "true",
             "includeItemsFromAllDrives": "true"}
        if token:
            q["pageToken"] = token
        with urllib.request.urlopen("https://www.googleapis.com/drive/v3/files?" + urllib.parse.urlencode(q)) as r:
            data = json.load(r)
        for f in data.get("files", []):
            if f["mimeType"] == "application/vnd.google-apps.folder":
                out.update(list_drive(f["id"], key, prefix + f["name"] + "/"))
            else:
                out[prefix + f["name"]] = f["id"]
        token = data.get("nextPageToken")
        if not token:
            return out


def cmd_drive(a):
    work = Path(a.work)
    if a.rclone_json:  # rclone lsjson -R remote:folder > listing.json
        listing = {e["Path"]: e["ID"] for e in json.loads(Path(a.rclone_json).read_text(encoding="utf-8-sig")) if not e.get("IsDir")}
    else:
        if not a.api_key:
            sys.exit("need --api-key (or --rclone-json)")
        listing = list_drive(drive_folder_id(a.drive_folder), a.api_key)
    photos, _ = load_scan(work)
    by_base = {}
    for path, fid in listing.items():
        by_base.setdefault(path.rsplit("/", 1)[-1].lower(), []).append(fid)
    mapping, miss = {}, 0
    for p in photos:
        fid = listing.get(p["path"])
        if not fid:
            # Fall back to basename when unique (Drive upload may have flattened folders).
            c = by_base.get(p["path"].rsplit("/", 1)[-1].lower(), [])
            fid = c[0] if len(c) == 1 else None
        if fid:
            mapping[p["path"]] = fid
        else:
            miss += 1
    (work / "drive.json").write_text(json.dumps(mapping))
    print(f"matched {len(mapping)}/{len(photos)} photos to Drive files ({miss} missing)")


# ---------------------------------------------------------------- build

def cmd_build(a):
    work = Path(a.work)
    pdata = json.loads((work / "people.json").read_text())
    photos, people = pdata["photos"], pdata["people"]
    drive = json.loads((work / "drive.json").read_text()) if (work / "drive.json").exists() else {}
    if not drive:
        print("warning: no drive.json -- guests will not be able to see photos", file=sys.stderr)
    names = read_names(work / "names.csv")
    _, faces = load_scan(work)
    fmap = {f["id"]: f for f in faces}

    # Merge IDs sharing a name; drop hidden ('-').
    merged = {}
    for pp in people:
        nm = names.get(pp["id"])
        if nm == "-":
            continue
        key = ("n", nm.casefold()) if nm else ("i", pp["id"])
        m = merged.setdefault(key, {"id": pp["id"], "ids": [], "name": nm, "faces": [], "photos": set(), "cover": pp["cover"]})
        m["ids"].append(pp["id"])
        m["faces"] += pp["faces"]
        m["photos"] |= set(pp["photos"])

    # Photos deleted from Drive drop out of every person (and people left with none disappear).
    linked = {i for i, p in enumerate(photos) if drive.get(p["path"])} if drive else set(range(len(photos)))
    out_people = []
    for m in merged.values():
        m["photos"] &= linked
        if not m["photos"]:
            continue
        E = dequant([fmap[f] for f in m["faces"]])
        ex = exemplars(E, a.exemplars)
        qs = [q8(v) for v in ex]
        out_people.append({
            "id": m["id"], "ids": m["ids"], "name": m["name"], "n": len(m["photos"]),
            "cover": "data:image/jpeg;base64," + b64((work / "crops" / f"{m['cover']}.jpg").read_bytes()),
            "photos": sorted(m["photos"]),
            "ex": b64(b"".join(v.tobytes() for v, _ in qs)), "exq": [round(s, 8) for _, s in qs],
        })
    out_people.sort(key=lambda p: (p["name"] is None, -p["n"]))

    index = {
        "v": 1, "title": a.title, "created": time.strftime("%Y-%m-%d"),
        "photos": [[p["path"], drive.get(p["path"]), p["w"], p["h"]] for p in photos],
        "people": out_people,
    }
    # Optional couple/celebration settings; kept in work/ so names stay out of the public repo.
    wedding = Path(a.wedding) if a.wedding else work / "wedding.json"
    if wedding.exists():
        index["wedding"] = json.loads(wedding.read_text(encoding="utf-8"))
    passphrase = a.passphrase or os.environ.get("PHOTORGANIZE_PASSPHRASE")
    if not passphrase:
        sys.exit("need --passphrase or PHOTORGANIZE_PASSPHRASE")
    blob = encrypt(gzip.compress(json.dumps(index, separators=(",", ":")).encode()), passphrase)
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(blob)
    named = sum(1 for p in out_people if p["name"])
    print(f"-> {out}  {len(blob) / 1e6:.1f} MB  {len(out_people)} people ({named} named), "
          f"{sum(1 for p in photos if drive.get(p['path']))} photos linked")


def exemplars(E, k):
    """Centroid plus farthest-point picks so side profiles / different lighting still match."""
    c = E.mean(0)
    c /= np.linalg.norm(c)
    picks = [c]
    if len(E) > 1:
        d = E @ c
        for _ in range(min(k - 1, len(E))):
            i = int(d.argmin())
            if d[i] > 0.95:
                break
            picks.append(E[i])
            d = np.maximum(d, E @ E[i])
    return picks


MAGIC = b"PORG1"
ITER = 310_000


def encrypt(data, passphrase):
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    salt, iv = secrets.token_bytes(16), secrets.token_bytes(12)
    key = PBKDF2HMAC(hashes.SHA256(), 32, salt, ITER).derive(passphrase.encode())
    return MAGIC + salt + iv + struct.pack(">I", ITER) + AESGCM(key).encrypt(iv, data, None)



# ---------------------------------------------------------------- shrink (fit photos into Drive quota)

RAW_EXTS = {".cr2", ".cr3", ".nef", ".arw", ".dng", ".raf", ".orf", ".rw2"}
VIDEO_EXTS = {".mp4", ".mov", ".avi", ".mts", ".m4v", ".3gp"}
PRESETS = [(3000, 85), (2560, 82), (2048, 80), (1600, 80)]


def shrink_one(job):
    """Resize one photo to max_side and re-encode as JPEG, keeping EXIF (date taken etc.) and colour profile.
    Returns (in_bytes, out_bytes, error). With dst=None only measures (for estimates)."""
    src, dst, max_side, quality = job
    import io
    import shutil
    try:
        in_size = os.path.getsize(src)
        with Image.open(src) as im:
            small_enough = max(im.size) <= max_side and im.format == "JPEG"
            if small_enough:  # never upscale or re-encode an already small JPEG
                if dst:
                    shutil.copy2(src, dst)
                return in_size, in_size, None
            exif = im.getexif()
            icc = im.info.get("icc_profile")
            im = ImageOps.exif_transpose(im).convert("RGB")
            im.thumbnail((max_side, max_side), Image.LANCZOS)
            if 0x0112 in exif:
                del exif[0x0112]  # orientation already applied
            buf = io.BytesIO()
            im.save(buf, "JPEG", quality=quality, optimize=True, progressive=True,
                    exif=exif.tobytes(), icc_profile=icc)
        if dst:
            Path(dst).write_bytes(buf.getvalue())
            st = os.stat(src)
            os.utime(dst, (st.st_atime, st.st_mtime))
        return in_size, buf.tell(), None
    except Exception as ex:
        return os.path.getsize(src) if os.path.exists(src) else 0, 0, f"{src}: {ex}"


def gb(n):
    return f"{n / 1e9:.2f} GB"


def cmd_shrink(a):
    from concurrent.futures import ProcessPoolExecutor
    import random
    src = Path(a.src).resolve()
    all_files = [p for p in src.rglob("*") if p.is_file()]
    by_ext = {}
    for p in all_files:
        e = by_ext.setdefault(p.suffix.lower() or "(none)", [0, 0])
        e[0] += 1
        e[1] += p.stat().st_size
    print(f"{src}: {len(all_files)} files, {gb(sum(v[1] for v in by_ext.values()))}")
    for ext, (n, size) in sorted(by_ext.items(), key=lambda kv: -kv[1][1]):
        note = " (photo)" if ext in EXTS else " (RAW: skipped, export JPEGs)" if ext in RAW_EXTS else \
            " (video: skipped)" if ext in VIDEO_EXTS else " (skipped)"
        print(f"  {ext:8} {n:6}  {gb(size):>10}{note}")
    photos = sorted(p for p in all_files if p.suffix.lower() in EXTS and not p.name.startswith("."))
    if not photos:
        sys.exit("no photos found")
    in_total = sum(p.stat().st_size for p in photos)

    if a.estimate or not a.dst:
        sample = random.Random(0).sample(photos, min(40, len(photos)))
        sample_in = sum(p.stat().st_size for p in sample)
        print(f"\nEstimate from {len(sample)} sample photos ({len(photos)} photos, {gb(in_total)} now):")
        with ProcessPoolExecutor() as ex:
            for side, q in PRESETS:
                res = list(ex.map(shrink_one, [(str(p), None, side, q) for p in sample]))
                ratio = sum(r[1] for r in res) / max(1, sample_in)
                est = in_total * ratio
                fit = "fits" if est <= a.budget_gb * 1e9 else "too big"
                print(f"  --max-side {side} --quality {q}:  ~{gb(est)}  ({fit} in {a.budget_gb:g} GB)")
        print("\nThen: python photorganize.py shrink SRC DST --max-side N --quality Q")
        return

    dst = Path(a.dst).resolve()
    if dst == src or src in dst.parents:
        sys.exit("DST must be outside SRC")
    jobs, seen = [], set()
    for p in photos:
        rel = p.relative_to(src)
        out = (dst / rel).with_suffix(".jpg")
        if out.as_posix().lower() in seen:  # IMG_1.heic + IMG_1.jpg in one folder
            out = (dst / rel).with_name(p.name + ".jpg")
        seen.add(out.as_posix().lower())
        if out.exists() and out.stat().st_mtime >= p.stat().st_mtime - 1 and out.stat().st_size > 0:
            continue  # done in a previous run
        out.parent.mkdir(parents=True, exist_ok=True)
        jobs.append((str(p), str(out), a.max_side, a.quality))
    print(f"\nShrinking {len(jobs)} photos ({len(photos) - len(jobs)} already done) -> {dst}")
    t0, done, tin, tout, errs = time.time(), 0, 0, 0, []
    with ProcessPoolExecutor() as ex:
        for i, (bi, bo, err) in enumerate(ex.map(shrink_one, jobs, chunksize=4), 1):
            tin += bi
            tout += bo
            if err:
                errs.append(err)
            if i % 100 == 0 or i == len(jobs):
                el = time.time() - t0
                print(f"  {i}/{len(jobs)}  {gb(tin)} -> {gb(tout)}  eta {(len(jobs) - i) * el / i / 60:.1f} min", flush=True)
    out_total = sum(p.stat().st_size for p in dst.rglob("*.jpg"))
    print(f"\nDone: {gb(in_total)} -> {gb(out_total)} in {dst}"
          f"  ({'fits' if out_total <= a.budget_gb * 1e9 else 'still over'} {a.budget_gb:g} GB)")
    for e in errs[:20]:
        print("  !", e, file=sys.stderr)
    if errs:
        print(f"  {len(errs)} files failed (listed above)", file=sys.stderr)


# ---------------------------------------------------------------- cli

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--work", default="work", help="working dir for scan data (default: ./work)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def scan_args(p):
        p.add_argument("photos", help="local folder with the photos (scanned recursively)")
        p.add_argument("--min-size", type=int, default=24, help="skip faces smaller than N px (on 1600px image)")

    def cluster_args(p):
        p.add_argument("--threshold", type=float, default=0.42, help="cosine sim for same-person edge")
        p.add_argument("--merge-threshold", type=float, default=0.55, help="merge clusters with centroid sim above")
        p.add_argument("--min-score", type=float, default=0.6)
        p.add_argument("--min-photos", type=int, default=2, help="drop people seen in fewer photos")

    def drive_args(p):
        p.add_argument("--drive-folder", help="Drive folder URL or ID (set to 'anyone with the link')")
        p.add_argument("--api-key", default=os.environ.get("GOOGLE_API_KEY"), help="Google API key with Drive API on")
        p.add_argument("--rclone-json", help="alternative: output of `rclone lsjson -R remote:folder`")

    def build_args(p):
        p.add_argument("--passphrase", help="guests type this to unlock (or env PHOTORGANIZE_PASSPHRASE)")
        p.add_argument("--title", default="Our Wedding")
        p.add_argument("--exemplars", type=int, default=5)
        p.add_argument("--wedding", help="couple/celebration settings JSON (default: WORK/wedding.json if present)")
        p.add_argument("--out", default=str(ROOT / "docs" / "data" / "index.enc"))

    p = sub.add_parser("shrink", help="report folder size / write a compressed copy that fits your Drive")
    p.add_argument("src", help="original photo folder (never modified)")
    p.add_argument("dst", nargs="?", help="output folder; omit to only print a size estimate")
    p.add_argument("--max-side", type=int, default=2560, help="longest side in px (default 2560)")
    p.add_argument("--quality", type=int, default=82, help="JPEG quality (default 82)")
    p.add_argument("--budget-gb", type=float, default=5, help="Drive space you have (default 5)")
    p.add_argument("--estimate", action="store_true", help="only estimate, even if dst given")
    p = sub.add_parser("scan", help="detect + embed faces (resumable)")
    scan_args(p)
    p = sub.add_parser("cluster", help="group faces into person IDs")
    cluster_args(p)
    p.add_argument("--min-size", type=int, default=32, help="ignore faces smaller than N px when clustering")
    p = sub.add_parser("drive", help="map photos to Drive file IDs")
    drive_args(p)
    p = sub.add_parser("build", help="write encrypted index for the web app")
    build_args(p)
    p = sub.add_parser("all", help="scan + cluster + drive + build")
    scan_args(p)
    cluster_args(p)
    drive_args(p)
    build_args(p)

    a = ap.parse_args()
    if a.cmd == "all":
        cmd_scan(a)
        a.min_size = max(a.min_size, 32)
        cmd_cluster(a)
        if a.drive_folder or a.rclone_json:
            cmd_drive(a)
        cmd_build(a)
    else:
        {"shrink": cmd_shrink, "scan": cmd_scan, "cluster": cmd_cluster, "drive": cmd_drive, "build": cmd_build}[a.cmd](a)


if __name__ == "__main__":
    main()
