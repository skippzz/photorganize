# photorganize

- Work in progress goes on feature branches; merge to `main` when ready (user-approved workflow). GitHub Pages serves `main:/docs`.
- Never commit `indexer/work/` (face crops) or the passphrase.
- `indexer/photorganize.py` and `docs/js/face.js` must keep identical preprocessing (MAX_SIDE, det letterbox, ArcFace alignment, int8 quantization) or selfie matching breaks.
