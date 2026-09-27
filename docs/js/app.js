import { decryptIndex } from './crypto.js';

const $view = document.getElementById('view');
const $title = document.getElementById('title');
const store = {
  get(k) { try { return localStorage.getItem('po:' + k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem('po:' + k) : localStorage.setItem('po:' + k, v); } catch { /* private mode */ } },
};

let idx = null;           // decrypted index
let byId = new Map();     // any person id (incl. merged aliases) -> person
let photoPeople = [];     // photo index -> [person]
let face = null;          // lazily imported face module

// ---------------------------------------------------------------- helpers

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

const label = (p) => p.name || `#${p.id}`;
// Photo "id" is a Drive file ID, or a relative URL (contains '/') for photos hosted with the site (demo).
const isLocal = (id) => id.includes('/');
const thumb = (id, w) => (isLocal(id) ? id : `https://drive.google.com/thumbnail?id=${id}&sz=w${w}`);
const thumbAlt = (id, w) => (isLocal(id) ? id : `https://lh3.googleusercontent.com/d/${id}=w${w}`);
const downloadUrl = (id) => (isLocal(id) ? id : `https://drive.usercontent.google.com/download?id=${id}&export=download`);
const viewUrl = (id) => (isLocal(id) ? id : `https://drive.google.com/file/d/${id}/view`);

function img(id, w, attrs = {}) {
  return h('img', {
    src: thumb(id, w), loading: 'lazy', decoding: 'async', alt: '', referrerpolicy: 'no-referrer', ...attrs,
    onerror(e) {
      const el = e.target;
      if (!el.dataset.alt) { el.dataset.alt = 1; el.src = thumbAlt(id, w); return; }
      // Both URLs failed: the photo was removed from Drive since the index was built.
      if (el.closest('.cell')) el.closest('.cell').hidden = true;
      else if (el.classList.contains('lb-img')) el.replaceWith(h('p', { class: 'muted' }, 'Bu fotoğraf kaldırılmış.'));
    },
  });
}

function toast(msg) {
  const t = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}

function avatar(p, size = '') {
  return h('img', { class: `avatar ${size}`, src: p.cover, alt: '' });
}

// Bottom sheet / dialog; tap outside to close.
function sheet(...kids) {
  const close = () => ov.remove();
  const ov = h('div', { class: 'sheet-bg', onclick(e) { if (e.target === ov) close(); } },
    h('div', { class: 'card sheet', role: 'dialog' }, ...kids));
  document.body.append(ov);
  return close;
}

// ---------------------------------------------------------------- wedding extras (index.wedding, optional)

const couple = () => {
  const w = idx.wedding;
  if (!w?.couple_ids) return null;
  const ps = w.couple_ids.map((i) => byId.get(i));
  return ps.every(Boolean) && ps[0] !== ps[1] ? ps : null;
};
const coupleName = () => idx.wedding.couple?.join(' & ') || '';

function marriedFor(date) {
  const d0 = new Date(`${date}T00:00:00`);
  const now = new Date();
  const days = Math.floor((now - d0) / 864e5);
  if (days < 0) return `Düğüne ${-days} gün kaldı`;
  if (days === 0) return 'Bugün evlendiler';
  if (days < 60) return `${days} gündür evliler`;
  const months = (now.getFullYear() - d0.getFullYear()) * 12 + now.getMonth() - d0.getMonth() - (now.getDate() < d0.getDate());
  return months < 24 ? `${months} aydır evliler` : `${Math.floor(months / 12)} yıldır evliler`;
}

function celebrate() {
  const w = idx.wedding;
  if (!w?.couple) return;
  const cp = couple();
  const canvas = h('canvas', { class: 'confetti', 'aria-hidden': 'true' });
  let stop = () => {};
  const close = () => { stop(); ov.classList.add('out'); setTimeout(() => ov.remove(), 250); };
  const ov = h('div', { class: 'celebrate', onclick(e) { if (e.target === ov || e.target === canvas) close(); } },
    canvas,
    h('div', { class: 'card celebrate-card', role: 'dialog', 'aria-label': coupleName() },
      cp ? h('div', { class: 'duo' }, avatar(cp[0], 'lg'), h('span', { class: 'ring' }, '💍'), avatar(cp[1], 'lg')) : h('div', { class: 'ring big-ring' }, '💍'),
      h('div', { class: 'celebrate-names' }, coupleName()),
      w.message ? h('p', { class: 'celebrate-msg' }, w.message) : '',
      w.from ? h('p', { class: 'muted' }, `— sevgiyle, ${w.from}`) : '',
      h('button', { class: 'primary', onclick: close }, 'Fotoğraflara geç')));
  document.body.append(ov);
  stop = confetti(canvas);
}

// Falling confetti + hearts for a few seconds; nothing if the viewer prefers reduced motion.
function confetti(canvas) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return () => {};
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const size = () => { canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr; };
  size();
  addEventListener('resize', size);
  const colors = ['#b5654a', '#d98b6f', '#e8c07d', '#f3e3d3', '#8fb3a0', '#ffffff'];
  const bits = [];
  const add = (n, spread) => {
    for (let i = 0; i < n; i++) {
      bits.push({
        x: Math.random() * innerWidth, y: -20 - Math.random() * spread, vx: (Math.random() - 0.5) * 1.5, vy: 1.6 + Math.random() * 2.4,
        a: Math.random() * 6.28, va: (Math.random() - 0.5) * 0.2, w: 6 + Math.random() * 6, h: 9 + Math.random() * 8,
        c: colors[(Math.random() * colors.length) | 0], heart: Math.random() < 0.18,
      });
    }
  };
  add(170, innerHeight * 0.6);
  const t0 = performance.now();
  let raf;
  const tick = (t) => {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const b of bits) {
      b.x += b.vx + Math.sin(t / 500 + b.a) * 0.6;
      b.y += b.vy;
      b.a += b.va;
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(b.a);
      ctx.fillStyle = b.c;
      if (b.heart) { ctx.font = `${b.h + 6}px serif`; ctx.fillText('♥', -b.w / 2, b.h / 2); }
      else ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h * Math.abs(Math.cos(b.a)));
      ctx.restore();
    }
    for (let i = bits.length - 1; i >= 0; i--) if (bits[i].y > innerHeight + 30) bits.splice(i, 1);
    if (t - t0 < 2500) add(3, 40);
    if (bits.length) raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => { cancelAnimationFrame(raf); removeEventListener('resize', size); };
}

// Show the celebration once per device per index build; manual unlock always shows it.
function maybeCelebrate(force) {
  if (!idx.wedding?.couple) return;
  if (!force && store.get('celebrated') === idx.created) return;
  store.set('celebrated', idx.created);
  celebrate();
}

// Who shows up in the same photos as p most often.
function companions(p, k = 3) {
  const c = new Map();
  for (const pi of p.photos) for (const o of photoPeople[pi]) if (o !== p) c.set(o, (c.get(o) || 0) + 1);
  return [...c].sort((a, b) => b[1] - a[1]).slice(0, k);
}

function shuffle() {
  const list = idx.photos.map((_, i) => i).filter((i) => idx.photos[i][1]);
  for (let i = list.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [list[i], list[j]] = [list[j], list[i]]; }
  if (list.length) lightbox(list, 0);
}

function personCard(p) {
  return h('a', { class: 'person', href: `#/p/${p.id}` }, avatar(p), h('span', { class: 'pname' }, label(p)), h('span', { class: 'muted' }, `${p.n} photos`));
}

// ---------------------------------------------------------------- data

function prepare(data) {
  idx = data;
  byId = new Map();
  photoPeople = data.photos.map(() => []);
  for (const p of data.people) {
    for (const id of p.ids || [p.id]) byId.set(id, p);
    for (const pi of p.photos) photoPeople[pi].push(p);
    const raw = Uint8Array.from(atob(p.ex), (c) => c.charCodeAt(0));
    const q = new Int8Array(raw.buffer);
    const k = p.exq.length;
    p.emb = [];
    for (let e = 0; e < k; e++) {
      const v = new Float32Array(512);
      let n = 0;
      for (let i = 0; i < 512; i++) { v[i] = q[e * 512 + i] * p.exq[e]; n += v[i] * v[i]; }
      n = Math.sqrt(n);
      for (let i = 0; i < 512; i++) v[i] /= n;
      p.emb.push(v);
    }
  }
  $title.textContent = data.title;
  document.title = data.title;
}

// Every published index is tried; the passphrase picks which one opens (e.g. the real one vs the demo).
const INDEXES = ['data/index.enc', 'data/demo.enc'];

async function unlock(pass) {
  let found = 0;
  for (const url of INDEXES) {
    const res = await fetch(url, { cache: 'no-cache' }).catch(() => null);
    if (!res?.ok) continue;
    found++;
    try {
      prepare(await decryptIndex(await res.arrayBuffer(), pass));
      store.set('pass', pass);
      return;
    } catch (ex) {
      if (ex.message !== 'Wrong passphrase') throw ex;
    }
  }
  throw new Error(found ? 'Wrong passphrase' : 'No index published yet (data/index.enc missing)');
}

function match(emb) {
  return idx.people.map((p) => {
    let best = -1;
    for (const e of p.emb) {
      let s = 0;
      for (let i = 0; i < 512; i++) s += e[i] * emb[i];
      if (s > best) best = s;
    }
    return { p, s: best };
  }).sort((a, b) => b.s - a.s);
}

// ---------------------------------------------------------------- views

function viewLock(err) {
  const input = h('input', { type: 'password', placeholder: 'Passphrase', autocomplete: 'current-password', required: true, autofocus: true });
  const msg = h('p', { class: 'error' }, err || '');
  const btn = h('button', { class: 'primary', type: 'submit' }, 'Open');
  const form = h('form', {
    class: 'card lock',
    async onsubmit(e) {
      e.preventDefault();
      btn.disabled = true;
      btn.textContent = 'Unlocking…';
      try {
        await unlock(input.value.trim());
        await route();
        maybeCelebrate(true);
      } catch (ex) {
        msg.textContent = ex.message;
        btn.disabled = false;
        btn.textContent = 'Open';
      }
    },
  }, h('h2', {}, 'Welcome'), h('p', { class: 'muted' }, 'Enter the passphrase you got at the wedding.'), input, btn, msg);
  $view.replaceChildren(form);
}

function viewHome() {
  const me = byId.get(+store.get('me'));
  const linked = idx.photos.filter((p) => p[1]).length;
  const w = idx.wedding;
  const cp = couple();
  const other = new Set(cp?.[1].photos);
  const together = cp ? cp[0].photos.filter((x) => other.has(x)).length : 0;
  $view.replaceChildren(
    w?.couple && w.date ? h('button', { class: 'married', onclick: celebrate, title: 'Kutlamayı tekrar oynat' }, `💍 ${coupleName()} · ${marriedFor(w.date)}`) : '',
    cp ? h('a', { class: 'card action couple', href: `#/p/${cp[0].id}?with=${cp[1].id}` },
      h('span', { class: 'duo sm' }, avatar(cp[0]), avatar(cp[1])),
      h('div', {}, h('div', { class: 'big' }, coupleName()), h('div', { class: 'muted' }, `Birlikte ${together} fotoğraf`))) : '',
    me ? h('a', { class: 'card me', href: `#/p/${me.id}` }, avatar(me, 'lg'),
      h('div', {}, h('div', { class: 'muted' }, 'Your photos'), h('div', { class: 'big' }, label(me)), h('div', { class: 'muted' }, `${me.n} photos`))) : '',
    h('a', { class: 'card action', href: '#/selfie' }, h('span', { class: 'icon' }, '🤳'),
      h('div', {}, h('div', { class: 'big' }, me ? 'Not you? Take a selfie' : 'Find my photos'), h('div', { class: 'muted' }, 'Take a selfie to find every photo you’re in. It stays on your phone.'))),
    h('a', { class: 'card action', href: '#/people' }, h('span', { class: 'icon' }, '👥'),
      h('div', {}, h('div', { class: 'big' }, 'Browse people'), h('div', { class: 'muted' }, `${idx.people.filter((p) => p.name).length} named, ${idx.people.length} total`))),
    h('a', { class: 'card action', href: '#/all' }, h('span', { class: 'icon' }, '🖼️'),
      h('div', {}, h('div', { class: 'big' }, 'All photos'), h('div', { class: 'muted' }, `${linked} photos`))),
    h('button', { class: 'card action', onclick: shuffle }, h('span', { class: 'icon' }, '🎲'),
      h('div', {}, h('div', { class: 'big' }, 'Beni şaşırt'), h('div', { class: 'muted' }, 'Rastgele fotoğraflar, kaydırdıkça yenisi gelir.'))),
    h('p', { class: 'foot' }, h('button', { class: 'link', onclick() { store.set('pass', null); store.set('me', null); idx = null; location.hash = ''; route(); } }, 'Lock')),
  );
}

function viewPeople() {
  let showAll = store.get('showUnnamed') === '1';
  let q = '';
  const grid = h('div', { class: 'people' });
  const draw = () => {
    const list = idx.people.filter((p) => (showAll || p.name) && (!q || label(p).toLowerCase().includes(q)));
    grid.replaceChildren(...list.map(personCard));
    if (!list.length) grid.append(h('p', { class: 'muted' }, showAll ? 'Nobody matches.' : 'No names yet. Turn on “Show unnamed”.'));
  };
  const toggle = h('input', { type: 'checkbox', checked: showAll, onchange(e) { showAll = e.target.checked; store.set('showUnnamed', showAll ? '1' : '0'); draw(); } });
  $view.replaceChildren(
    h('div', { class: 'bar' }, h('a', { href: '#/', class: 'back' }, '←'), h('h2', {}, 'People')),
    h('div', { class: 'filters' },
      h('input', { type: 'search', placeholder: 'Search name or #id', oninput(e) { q = e.target.value.trim().toLowerCase(); draw(); } }),
      h('label', { class: 'check' }, toggle, 'Show unnamed')),
    grid,
  );
  draw();
}

function viewPerson(id, withIds) {
  const p = byId.get(id);
  if (!p) return viewHome();
  const others = withIds.map((i) => byId.get(i)).filter(Boolean);
  let photos = p.photos;
  for (const o of others) {
    const s = new Set(o.photos);
    photos = photos.filter((x) => s.has(x));
  }
  const isMe = +store.get('me') === p.id;
  const addSel = h('select', {
    onchange(e) {
      if (!e.target.value) return;
      location.hash = `#/p/${p.id}?with=${[...withIds, +e.target.value].join(',')}`;
    },
  }, h('option', { value: '' }, '+ Together with…'),
  ...idx.people.filter((o) => o !== p && !others.includes(o) && (o.name || o.n >= 3))
    .sort((a, b) => (!a.name - !b.name) || label(a).localeCompare(label(b)))
    .map((o) => h('option', { value: o.id }, `${label(o)} (${o.n})`)));

  $view.replaceChildren(
    h('div', { class: 'bar' }, h('a', { href: '#/people', class: 'back' }, '←'), h('h2', {}, label(p))),
    h('div', { class: 'card hero' }, avatar(p, 'lg'),
      h('div', { class: 'grow' },
        h('div', { class: 'big' }, label(p)),
        h('div', { class: 'muted' }, `${photos.length} photo${photos.length === 1 ? '' : 's'}${others.length ? ' together' : ''}`),
        h('div', { class: 'row' },
          isMe ? h('span', { class: 'pill' }, 'This is you')
            : h('button', { class: 'small', onclick() { store.set('me', p.id); toast('Saved as you'); viewPerson(id, withIds); } }, 'This is me'),
          h('button', { class: 'small', onclick: () => suggestName(p) }, p.name ? 'Wrong name?' : 'I know who this is')))),
    others.length ? '' : stats(p, isMe),
    h('div', { class: 'filters' },
      ...others.map((o) => h('a', { class: 'chip', href: `#/p/${p.id}${withIds.length > 1 ? `?with=${withIds.filter((i) => i !== o.id).join(',')}` : ''}` }, avatar(o, 'xs'), label(o), ' ×')),
      addSel),
    grid(photos),
  );
}

function stats(p, isMe) {
  const top = companions(p);
  if (!top.length) return '';
  return h('div', { class: 'stats' },
    h('div', { class: 'muted' }, isMe ? `Sen ${p.n} fotoğraftasın! En çok birlikte olduğun kişiler:` : 'En çok birlikte:'),
    h('div', { class: 'row' }, ...top.map(([o, n]) => h('a', { class: 'chip', href: `#/p/${p.id}?with=${o.id}` }, avatar(o, 'xs'), `${label(o)} · ${n}`))));
}

// "I know who this is": guest types the name, picks who to tell, gets a ready WhatsApp message.
function suggestName(p) {
  const to = idx.wedding?.contacts?.length ? idx.wedding.contacts : [null];
  const link = `${location.origin}${location.pathname}#/p/${p.id}`;
  const name = h('input', { type: 'text', placeholder: 'Adı (ve soyadı)', autocomplete: 'off', enterkeyhint: 'done', value: '' });
  const who = h('div', { class: 'row' });
  const out = h('div', {});
  const compose = (rcpt) => {
    const n = name.value.trim();
    if (!n) { name.focus(); toast('Önce ismi yaz'); return; }
    const text = `${rcpt ? `Selam ${rcpt}! ` : ''}Düğün fotoğraflarındaki #${p.id} numaralı kişi${p.name ? ` (şu an "${p.name}" yazıyor)` : ''}: ${n} 🙂\n${link}`;
    for (const b of who.children) b.classList.toggle('primary', b.dataset.to === String(rcpt));
    out.replaceChildren(
      h('div', { class: 'bubble' }, text),
      h('div', { class: 'row' },
        h('a', { class: 'btn primary', href: `https://wa.me/?text=${encodeURIComponent(text)}`, target: '_blank', rel: 'noopener' }, 'WhatsApp’ta gönder'),
        h('button', { async onclick() { try { await navigator.clipboard.writeText(text); toast('Kopyalandı'); } catch { toast('Kopyalanamadı'); } } }, 'Kopyala')),
      h('p', { class: 'muted' }, rcpt ? `WhatsApp açılınca sohbetlerden seç: ${rcpt}` : 'WhatsApp açılınca kişiyi seç.'));
  };
  who.append(...to.map((r) => h('button', { class: 'small', 'data-to': String(r), onclick: () => compose(r) }, r || 'Mesajı hazırla')));
  sheet(
    h('div', { class: 'bar' }, avatar(p), h('div', { class: 'grow' }, h('div', { class: 'big' }, p.name ? 'Yanlış isim mi?' : 'Bu kim?'), h('div', { class: 'muted' }, label(p)))),
    name,
    h('div', { class: 'muted' }, to[0] ? 'Kime yazalım?' : ''),
    who,
    out,
  );
  name.focus();
}

function viewAll() {
  const all = idx.photos.map((_, i) => i);
  $view.replaceChildren(h('div', { class: 'bar' }, h('a', { href: '#/', class: 'back' }, '←'), h('h2', {}, 'All photos')), grid(all));
}

// Chunked lazy grid; tapping opens the lightbox.
function grid(list) {
  list = list.filter((i) => idx.photos[i][1]);
  const g = h('div', { class: 'grid' });
  if (!list.length) return h('p', { class: 'muted' }, 'No photos here yet.');
  let shown = 0;
  const more = () => {
    const base = shown;
    const next = list.slice(base, base + 120);
    g.append(...next.map((pi, k) => h('button', { class: 'cell', onclick: () => lightbox(list, base + k) }, img(idx.photos[pi][1], 400))));
    shown += next.length;
    if (shown >= list.length) io.disconnect();
  };
  const sentinel = h('div', { class: 'sentinel' });
  const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && more(), { rootMargin: '800px' });
  more();
  queueMicrotask(() => io.observe(sentinel));
  return h('div', {}, g, sentinel);
}

// ---------------------------------------------------------------- lightbox

const $lb = document.getElementById('lightbox');
let lbState = null;

function lightbox(list, i) {
  lbState = { list, i };
  $lb.hidden = false;
  document.body.classList.add('noscroll');
  drawLightbox();
}

function drawLightbox() {
  const { list, i } = lbState;
  const pi = list[i];
  const [path, id] = idx.photos[pi];
  const who = photoPeople[pi];
  $lb.replaceChildren(
    h('div', { class: 'lb-top' },
      h('span', { class: 'muted' }, `${i + 1} / ${list.length}`),
      h('span', { class: 'grow' }),
      h('a', { class: 'lb-btn', href: downloadUrl(id), download: isLocal(id) ? '' : null, title: 'Download original', 'aria-label': 'Download original' }, '⬇'),
      h('a', { class: 'lb-btn', href: viewUrl(id), target: '_blank', rel: 'noopener', title: 'Open in Google Drive (save to your Drive)', 'aria-label': 'Open in Google Drive' }, '↗'),
      h('button', { class: 'lb-btn', onclick: closeLightbox, 'aria-label': 'Close' }, '✕')),
    h('div', { class: 'lb-stage' },
      h('button', { class: 'lb-nav prev', onclick: () => step(-1), 'aria-label': 'Previous', disabled: i === 0 }, '‹'),
      img(id, 2000, { class: 'lb-img', loading: 'eager', alt: path }),
      h('button', { class: 'lb-nav next', onclick: () => step(1), 'aria-label': 'Next', disabled: i === list.length - 1 }, '›')),
    h('div', { class: 'lb-people' }, ...who.map((p) => h('a', { class: 'chip', href: `#/p/${p.id}`, onclick: closeLightbox }, avatar(p, 'xs'), label(p)))),
  );
  resetZoom();
  // Preload neighbours.
  for (const d of [-1, 1]) { const n = list[i + d]; if (n != null && idx.photos[n][1]) new Image().src = thumb(idx.photos[n][1], 2000); }
}

function step(d) {
  const n = lbState.i + d;
  if (n < 0 || n >= lbState.list.length) return;
  lbState.i = n;
  drawLightbox();
}

function closeLightbox() {
  $lb.hidden = true;
  lbState = null;
  document.body.classList.remove('noscroll');
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') document.querySelectorAll('.sheet-bg').forEach((s) => s.remove());
  if (!lbState) return;
  if (e.key === 'Escape') closeLightbox();
  if (e.key === 'ArrowLeft') step(-1);
  if (e.key === 'ArrowRight') step(1);
});

// Photo zoom/pan/swipe inside the lightbox (page zoom is disabled, so photos zoom here instead).
const zoom = { s: 1, x: 0, y: 0 };
const ptrs = new Map();
let gesture = null;
let lastTap = { t: 0, x: 0, y: 0 };

function applyZoom(animate) {
  const el = $lb.querySelector('.lb-img');
  if (!el) return;
  el.style.transition = animate ? 'transform .18s ease-out' : 'none';
  el.style.transform = `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.s})`;
  $lb.classList.toggle('zoomed', zoom.s > 1);
}

function resetZoom() { Object.assign(zoom, { s: 1, x: 0, y: 0 }); applyZoom(false); }

// Zoom to scale s keeping screen point (px, py) fixed.
function zoomAt(s, px, py) {
  const r = $lb.querySelector('.lb-stage').getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  s = Math.min(5, Math.max(1, s));
  const k = s / zoom.s;
  zoom.x = (px - cx) - ((px - cx) - zoom.x) * k;
  zoom.y = (py - cy) - ((py - cy) - zoom.y) * k;
  zoom.s = s;
  if (s === 1) zoom.x = zoom.y = 0;
}

$lb.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('.lb-stage') || e.target.closest('button')) return;
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  e.target.setPointerCapture?.(e.pointerId);
  const pts = [...ptrs.values()];
  if (pts.length === 1) gesture = { type: 'pan', x0: e.clientX, y0: e.clientY, lx: e.clientX, ly: e.clientY, t0: Date.now() };
  else if (pts.length === 2) {
    const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    gesture = { type: 'pinch', d0: d, s0: zoom.s, mx: (pts[0].x + pts[1].x) / 2, my: (pts[0].y + pts[1].y) / 2 };
  }
});

$lb.addEventListener('pointermove', (e) => {
  if (!ptrs.has(e.pointerId) || !gesture) return;
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const pts = [...ptrs.values()];
  if (gesture.type === 'pinch' && pts.length === 2) {
    const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    const mx = (pts[0].x + pts[1].x) / 2, my = (pts[0].y + pts[1].y) / 2;
    zoom.x += mx - gesture.mx;
    zoom.y += my - gesture.my;
    gesture.mx = mx; gesture.my = my;
    zoomAt(gesture.s0 * d / gesture.d0, mx, my);
    applyZoom(false);
  } else if (gesture.type === 'pan' && zoom.s > 1) {
    zoom.x += e.clientX - gesture.lx;
    zoom.y += e.clientY - gesture.ly;
    applyZoom(false);
  }
  if (gesture.type === 'pan') { gesture.lx = e.clientX; gesture.ly = e.clientY; }
});

function endPointer(e) {
  if (!ptrs.delete(e.pointerId) || !gesture) return;
  if (gesture.type === 'pinch') {
    if (ptrs.size === 0) { if (zoom.s < 1.05) resetZoom(); gesture = null; }
    else gesture = null; // one finger left: ignore until lifted
    return;
  }
  const dx = e.clientX - gesture.x0, dy = e.clientY - gesture.y0;
  const quick = Date.now() - gesture.t0 < 400;
  gesture = null;
  if (zoom.s === 1 && quick && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) { step(dx < 0 ? 1 : -1); return; }
  if (Math.hypot(dx, dy) < 10) {
    const now = Date.now();
    if (now - lastTap.t < 300 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
      zoomAt(zoom.s > 1 ? 1 : 2.5, e.clientX, e.clientY);
      applyZoom(true);
      lastTap.t = 0;
    } else lastTap = { t: now, x: e.clientX, y: e.clientY };
  }
}
$lb.addEventListener('pointerup', endPointer);
$lb.addEventListener('pointercancel', endPointer);
$lb.addEventListener('wheel', (e) => {
  if (!e.target.closest('.lb-stage')) return;
  e.preventDefault();
  zoomAt(zoom.s * Math.exp(-e.deltaY * 0.002), e.clientX, e.clientY);
  applyZoom(false);
}, { passive: false });

// iOS Safari ignores user-scalable=no; block its page pinch gestures explicitly.
for (const ev of ['gesturestart', 'gesturechange']) document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });

// ---------------------------------------------------------------- selfie

let stream = null;
function stopCamera() { stream?.getTracks().forEach((t) => t.stop()); stream = null; }

async function viewSelfie() {
  const status = h('p', { class: 'muted' }, 'Loading face models (≈16 MB, once)…');
  const bar = h('progress', { max: 1, value: 0 });
  const video = h('video', { playsinline: true, muted: true, autoplay: true, class: 'mirror' });
  const results = h('div', {});
  const snap = h('button', { class: 'primary', disabled: true }, 'Take selfie');
  const file = h('input', { type: 'file', accept: 'image/*', hidden: true });
  const pick = h('button', { disabled: true, onclick: () => file.click() }, 'Choose a photo');
  $view.replaceChildren(
    h('div', { class: 'bar' }, h('a', { href: '#/', class: 'back' }, '←'), h('h2', {}, 'Find my photos')),
    h('div', { class: 'card selfie' }, h('div', { class: 'cam' }, video), h('div', { class: 'row' }, snap, pick), file, status, bar),
    results,
  );

  // Camera and models start together; the camera shows while models download.
  const camera = navigator.mediaDevices?.getUserMedia
    ? navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 } }, audio: false })
      .then((st) => {
        if (!video.isConnected) { st.getTracks().forEach((t) => t.stop()); return false; } // left the page meanwhile
        stream = st; video.srcObject = st; return true;
      }).catch(() => false)
    : Promise.resolve(false);

  try {
    face ??= await import('./face.js');
    await face.loadModels((f) => { bar.value = f; });
  } catch (ex) {
    status.textContent = `Could not load face models: ${ex.message}`;
    return;
  }
  bar.remove();
  pick.disabled = false;
  if (await camera) {
    snap.disabled = false;
    status.textContent = 'Look at the camera, good light, no sunglasses.';
  } else {
    video.parentElement.remove();
    snap.remove();
    status.textContent = 'No camera access. Choose a photo of yourself instead.';
  }

  const run = async (src, w, hgt) => {
    status.textContent = 'Looking…';
    const c = face.toWorkingCanvas(src, w, hgt);
    const r = await face.selfieEmbedding(c);
    if (!r) { status.textContent = 'No face found. Try again closer and in better light.'; return; }
    status.textContent = r.count > 1 ? 'Several faces seen, using the biggest one.' : '';
    showMatches(results, match(r.emb));
  };
  snap.onclick = () => run(video, video.videoWidth, video.videoHeight);
  file.onchange = async () => {
    const f = file.files[0];
    if (!f) return;
    const bmp = await createImageBitmap(f, { imageOrientation: 'from-image' });
    await run(bmp, bmp.width, bmp.height);
    file.value = '';
  };
}

function showMatches(el, ranked) {
  const top = ranked.filter((r) => r.s >= 0.25).slice(0, 4);
  if (!top.length) {
    el.replaceChildren(h('div', { class: 'card' }, h('p', {}, 'No match. Either you’re not in any photo yet, or try another selfie (face the camera, good light).')));
    return;
  }
  const conf = (s) => (s >= 0.45 ? 'Strong match' : s >= 0.33 ? 'Possible match' : 'Weak match');
  el.replaceChildren(
    h('h3', {}, top[0].s >= 0.45 ? 'Found you!' : 'Is one of these you?'),
    ...top.map(({ p, s }) => h('div', { class: 'card match' }, avatar(p, 'lg'),
      h('div', { class: 'grow' }, h('div', { class: 'big' }, label(p)), h('div', { class: 'muted' }, `${conf(s)} · ${p.n} photos`)),
      h('button', { class: 'primary small', onclick() { store.set('me', p.id); stopCamera(); location.hash = `#/p/${p.id}`; } }, 'That’s me'))),
  );
}

// ---------------------------------------------------------------- router

async function route() {
  stopCamera();
  if (lbState) closeLightbox();
  document.querySelectorAll('.sheet-bg').forEach((s) => s.remove());
  if (!idx) {
    const saved = store.get('pass');
    if (saved) {
      $view.replaceChildren(h('p', { class: 'muted center' }, 'Opening…'));
      try { await unlock(saved); } catch (ex) { store.set('pass', null); return viewLock(ex.message === 'Wrong passphrase' ? 'Passphrase changed, enter the new one.' : ex.message); }
      queueMicrotask(() => maybeCelebrate(false));
    } else return viewLock();
  }
  const [path, query] = location.hash.replace(/^#/, '').split('?');
  const params = new URLSearchParams(query || '');
  const m = path.match(/^\/p\/(\d+)$/);
  window.scrollTo(0, 0);
  if (m) viewPerson(+m[1], (params.get('with') || '').split(',').filter(Boolean).map(Number));
  else if (path === '/people') viewPeople();
  else if (path === '/selfie') viewSelfie();
  else if (path === '/all') viewAll();
  else viewHome();
}

window.addEventListener('hashchange', route);
route();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
