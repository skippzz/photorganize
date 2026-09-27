# photorganize

Wedding photo finder. Scan the photos once on your laptop, publish a static site to GitHub Pages, and guests take a selfie to see every photo they're in.

- **Python indexer** (`indexer/`): finds every face, groups faces into **person IDs**, maps files to Google Drive, and writes one encrypted `docs/data/index.enc`.
- **Guest PWA** (`docs/`): passphrase → selfie → matching person ID → that person's photos. Photos load from your public Drive folder. Face matching runs **on the phone**, so the selfie is never uploaded.
- **Names are optional.** An unnamed person shows as `#17`. Put `id,name` in `names.csv` and rebuild (takes seconds, no rescan).

```
local photos ──scan──▶ faces ──cluster──▶ person IDs ──build(+names.csv, +drive IDs)──▶ docs/data/index.enc
                                                                                         │
guest phone:  passphrase ▶ decrypt index ▶ selfie ▶ on-device embedding ▶ nearest person ▶ Drive photos
```

## 1. Put the photos on Drive

Upload the folder (subfolders are fine) to Google Drive. Set **Share → General access → Anyone with the link → Viewer**.

## 2. Get a Google API key (host only, guests don't need one)

1. https://console.cloud.google.com/ → create a project.
2. **APIs & Services → Library → Google Drive API → Enable**.
3. **Credentials → Create credentials → API key**. Optionally restrict it to the Drive API.

No key? Install [rclone](https://rclone.org), then `rclone lsjson -R gdrive:WeddingFolder > listing.json` and pass `--rclone-json listing.json` instead.

## 3. Run the indexer

```bash
cd indexer
pip install -r requirements.txt          # Python 3.9+
python photorganize.py all ~/Pictures/Wedding \
  --drive-folder "https://drive.google.com/drive/folders/XXXX" \
  --api-key "AIza..." \
  --passphrase "portakal2026" --title "Our Wedding"
```

4000 photos take about 10–20 minutes on a laptop CPU. The scan is **resumable**: Ctrl-C and rerun, and finished photos are skipped. Everything intermediate goes to `indexer/work/`, which is git-ignored and **contains faces, so don't publish it**.

Or run the steps one by one:

| step | what | rerun when |
|---|---|---|
| `scan PHOTOS` | detect + embed faces → `work/scan.jsonl`, `work/crops/` | new photos added |
| `cluster` | group faces → person IDs, `work/people.html`, `work/names.csv` | want different grouping |
| `drive --drive-folder URL --api-key K` | local path → Drive file ID | Drive folder changed |
| `build --passphrase P` | write `docs/data/index.enc` | names changed |

## 4. Names (optional, anytime)

Open `work/people.html`. It's a contact sheet with each person ID, their face crops and photo count. Edit `work/names.csv`:

```csv
id,name,photos
1,Bora,412
2,Yaren,380
7,Yaren,21     ← same name as #2 → merged into one person (fixes a split person)
9,-,15        ← "-" hides this ID (waiter, stranger)
```

Then run `python photorganize.py build --passphrase portakal2026`, then commit and push. Guests can also tap **"I know who this is"** on an unnamed `#ID` to send you a name.

## 5. Publish

Commit `docs/data/index.enc`. Then on GitHub: **Settings → Pages → Deploy from branch → `main` / `docs`**. Share the URL and the passphrase (a QR code on the tables works well). Guests can "Add to Home Screen" to install it.

## Tuning

- **One person split into several IDs:** give them the same name in `names.csv`, or run `cluster --merge-threshold 0.5`.
- **Two people merged into one ID:** run `cluster --threshold 0.48`. Person IDs are kept stable across reclusters where possible, so names survive.
- **Too many background strangers:** raise `cluster --min-photos 3` or `--min-size 48`.
- **Selfie matches:** 0.45 or higher shows as a strong match, 0.33–0.45 as possible. Guests confirm with "That's me".

## Privacy notes

- The index holds face *embeddings* (numbers, not images) plus one small cover crop per person. It's AES-256-GCM encrypted with your passphrase (PBKDF2 310k rounds). Use a passphrase that isn't a single dictionary word if the URL could leak.
- Photos themselves are "anyone with the link" on Drive. Their IDs are unguessable, and they only appear inside the encrypted index.
- Selfies never leave the phone.

## Tech

- Face models: InsightFace `buffalo_s` (SCRFD-500M detector + ArcFace MobileFaceNet, 16 MB), run with onnxruntime in Python and onnxruntime-web in the browser, with the same preprocessing in both. The models are for **non-commercial use** under the InsightFace license, which is fine for a personal wedding.
- Grouping: Chinese Whispers on a k-NN cosine graph, then a merge pass on similar group centroids.
- No build step, no backend. It's static files.

## Demo

`docs/data/demo.enc` is a small demo made from public-domain Obama/Biden photos, which are hosted in `docs/demo/`. The app tries every index in `INDEXES` (`docs/js/app.js`), and the passphrase decides which one opens, so the demo and the real wedding index can sit side by side. A photo "ID" containing `/` is treated as a URL relative to the site instead of a Drive file ID. Delete `docs/demo/` and `docs/data/demo.enc` to remove the demo.
