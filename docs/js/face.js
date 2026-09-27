// Face detection (SCRFD det_500m) + embedding (ArcFace w600k_mbf) in the browser.
// Mirrors indexer/photorganize.py so selfie embeddings are comparable with the index.
import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.wasm.min.mjs';

ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/';

const MAX_SIDE = 1600;
const DET = 640;
const DET_THRESH = 0.5;
const NMS_THRESH = 0.4;
const DST = [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]];

let sessions = null;

async function fetchModel(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`model ${url}: ${res.status}`);
  const total = +res.headers.get('content-length') || 0;
  if (!res.body || !total) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const buf = new Uint8Array(total);
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf.set(value, got);
    got += value.length;
    onProgress?.(got, total);
  }
  return buf;
}

export async function loadModels(onProgress) {
  if (sessions) return sessions;
  const sizes = { det: 2524817, rec: 13616099 };
  const got = { det: 0, rec: 0 };
  const report = () => onProgress?.((got.det + got.rec) / (sizes.det + sizes.rec));
  const [det, rec] = await Promise.all([
    fetchModel('models/det_500m.onnx', (g) => { got.det = g; report(); }),
    fetchModel('models/w600k_mbf.onnx', (g) => { got.rec = g; report(); }),
  ]);
  const opts = { executionProviders: ['wasm'] };
  sessions = {
    det: await ort.InferenceSession.create(det, opts),
    rec: await ort.InferenceSession.create(rec, opts),
  };
  return sessions;
}

function canvas(w, h) {
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  return c;
}

// Any drawable (ImageBitmap, <video>, <img>) -> canvas no larger than MAX_SIDE.
export function toWorkingCanvas(src, w, h) {
  const s = Math.min(1, MAX_SIDE / Math.max(w, h));
  const c = canvas(Math.round(w * s), Math.round(h * s));
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c;
}

function toCHW(data, n, mean, std) {
  const out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    out[i] = (data[i * 4] - mean) / std;
    out[n + i] = (data[i * 4 + 1] - mean) / std;
    out[2 * n + i] = (data[i * 4 + 2] - mean) / std;
  }
  return out;
}

function iou(a, b) {
  const w = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const h = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = w * h;
  return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter);
}

export async function detect(src) {
  const { det } = sessions;
  const scale = Math.min(DET / src.width, DET / src.height);
  const c = canvas(DET, DET);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, DET, DET);
  ctx.drawImage(src, 0, 0, Math.round(src.width * scale), Math.round(src.height * scale));
  const input = toCHW(ctx.getImageData(0, 0, DET, DET).data, DET * DET, 127.5, 128);
  const outs = await det.run({ [det.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, DET, DET]) });
  const o = det.outputNames.map((n) => outs[n].data);
  const faces = [];
  [8, 16, 32].forEach((stride, si) => {
    const sc = o[si], bb = o[si + 3], kp = o[si + 6];
    const n = DET / stride;
    for (let i = 0; i < sc.length; i++) {
      if (sc[i] < DET_THRESH) continue;
      const loc = i >> 1; // 2 anchors per location
      const cx = (loc % n) * stride, cy = Math.floor(loc / n) * stride;
      const box = [cx - bb[i * 4] * stride, cy - bb[i * 4 + 1] * stride, cx + bb[i * 4 + 2] * stride, cy + bb[i * 4 + 3] * stride].map((v) => v / scale);
      const kps = [];
      for (let k = 0; k < 5; k++) kps.push([(cx + kp[i * 10 + k * 2] * stride) / scale, (cy + kp[i * 10 + k * 2 + 1] * stride) / scale]);
      faces.push({ box, kps, score: sc[i] });
    }
  });
  faces.sort((a, b) => b.score - a.score);
  const keep = [];
  for (const f of faces) if (keep.every((k) => iou(k.box, f.box) <= NMS_THRESH)) keep.push(f);
  return keep;
}

// Least-squares similarity transform src -> DST; same as similarity() in the indexer.
function similarity(src) {
  const m = (pts) => [pts.reduce((s, p) => s + p[0], 0) / 5, pts.reduce((s, p) => s + p[1], 0) / 5];
  const [sx, sy] = m(src), [dx, dy] = m(DST);
  let den = 0, a = 0, b = 0;
  for (let i = 0; i < 5; i++) {
    const px = src[i][0] - sx, py = src[i][1] - sy, qx = DST[i][0] - dx, qy = DST[i][1] - dy;
    den += px * px + py * py;
    a += px * qx + py * qy;
    b += px * qy - py * qx;
  }
  a /= den; b /= den;
  return [a, b, dx - (a * sx - b * sy), dy - (b * sx + a * sy)];
}

export async function embed(src, kps) {
  const { rec } = sessions;
  const [a, b, tx, ty] = similarity(kps);
  const c = canvas(112, 112);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 112, 112);
  ctx.setTransform(a, b, -b, a, tx, ty);
  ctx.drawImage(src, 0, 0);
  const input = toCHW(ctx.getImageData(0, 0, 112, 112).data, 112 * 112, 127.5, 127.5);
  const out = await rec.run({ [rec.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, 112, 112]) });
  return normalize(Float32Array.from(out[rec.outputNames[0]].data));
}

export function normalize(v) {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

// Largest face in the image -> embedding (or null).
export async function selfieEmbedding(src) {
  const faces = await detect(src);
  if (!faces.length) return null;
  const big = faces.reduce((a, f) => ((f.box[2] - f.box[0]) * (f.box[3] - f.box[1]) > (a.box[2] - a.box[0]) * (a.box[3] - a.box[1]) ? f : a));
  return { emb: await embed(src, big.kps), box: big.box, count: faces.length };
}
