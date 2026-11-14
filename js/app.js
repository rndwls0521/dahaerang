import { db, uid } from './db.js';
import { icon, heartFill } from './icons.js';

/* ═════════════ 상수 ═════════════ */
const CATS = [
  { id: 'date', label: '데이트', emoji: '💕' },
  { id: 'trip', label: '여행', emoji: '✈️' },
  { id: 'food', label: '맛집·카페', emoji: '🍰' },
  { id: 'small', label: '사소한 것', emoji: '🌱' },
  { id: 'bucket', label: '버킷리스트', emoji: '⭐' },
];
const catOf = (id) => CATS.find((c) => c.id === id) || CATS[3];
const MOODS = ['🥰', '😆', '😌', '🥹', '😋', '🤭', '😴', '🔥'];
const THEMES = [
  { id: 'pink', color: '#ff7a93' },
  { id: 'peach', color: '#ff9466' },
  { id: 'lavender', color: '#a684ff' },
  { id: 'mint', color: '#3fc1a0' },
  { id: 'sky', color: '#5aa9ff' },
];
const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
const MAX_PHOTOS = 10;

/* ═════════════ 상태 ═════════════ */
const S = {
  profile: null,
  memories: [],
  wishes: [],
  photoURL: new Map(),
  cal: null,
  wishCat: 'all',
  wishTab: 'todo',
  memView: 'timeline',
  suggestId: null,
};

/* ═════════════ 날짜 유틸 ═════════════ */
const pad = (n) => String(n).padStart(2, '0');
const toKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseKey = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const todayKey = () => toKey(new Date());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const diffDays = (a, b) => Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 864e5);
const fmtDot = (k) => { const d = parseKey(k); return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`; };
const fmtFull = (k) => { const d = parseKey(k); return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEK[d.getDay()]})`; };
const fmtMD = (k) => { const d = parseKey(k); return `${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEK[d.getDay()]})`; };
const dLabel = (k) => { const n = diffDays(new Date(), parseKey(k)); return n === 0 ? 'D-DAY' : n > 0 ? `D-${n}` : `D+${-n}`; };
const offset = () => (S.profile.countFromOne === false ? 0 : 1);
const relDay = (k) => diffDays(parseKey(S.profile.startDate), parseKey(k)) + offset();

/* ═════════════ 기타 유틸 ═════════════ */
const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const haptic = (ms = 10) => { try { navigator.vibrate && navigator.vibrate(ms); } catch {} };
const live = (store) => S[store].filter((x) => !x.deleted);

/* ═════════════ 저장소 (나중에 동기화 계층으로 교체될 부분) ═════════════ */
async function saveRec(store, rec) {
  const now = Date.now();
  rec.updatedAt = now;
  if (!rec.createdAt) rec.createdAt = now;
  await db.put(store, rec);
  const arr = S[store];
  const i = arr.findIndex((x) => x.id === rec.id);
  if (i >= 0) arr[i] = rec; else arr.push(rec);
  return rec;
}
async function removeRec(store, rec) {
  if (rec.photoIds) for (const pid of rec.photoIds) await deletePhoto(pid);
  rec.deleted = true;
  rec.photoIds = [];
  await saveRec(store, rec);
}
async function saveProfile() {
  S.profile.updatedAt = Date.now();
  await db.put('meta', S.profile);
}

/* ═════════════ 사진 ═════════════ */
function loadImg(blob) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { res(img); setTimeout(() => URL.revokeObjectURL(url), 1000); };
    img.onerror = (e) => { URL.revokeObjectURL(url); rej(e); };
    img.src = url;
  });
}
async function resize(img, max, q) {
  const r = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * r), h = Math.round(img.naturalHeight * r);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(img, 0, 0, w, h);
  return new Promise((res) => c.toBlob((b) => res(b), 'image/jpeg', q));
}
async function processPhoto(file) {
  const img = await loadImg(file);
  const [blob, thumb] = await Promise.all([resize(img, 1600, 0.85), resize(img, 420, 0.8)]);
  return { id: uid(), blob, thumb, createdAt: Date.now() };
}
async function photoURL(id, full = false) {
  const key = id + (full ? ':f' : ':t');
  if (S.photoURL.has(key)) return S.photoURL.get(key);
  const rec = await db.get('photos', id);
  if (!rec) return '';
  const url = URL.createObjectURL(full ? rec.blob : rec.thumb || rec.blob);
  S.photoURL.set(key, url);
  return url;
}
async function deletePhoto(id) {
  for (const k of [id + ':t', id + ':f']) {
    if (S.photoURL.has(k)) { URL.revokeObjectURL(S.photoURL.get(k)); S.photoURL.delete(k); }
  }
  await db.del('photos', id);
}
function hydratePhotos(root = document) {
  $$('img[data-photo]', root).forEach(async (img) => {
    const url = await photoURL(img.dataset.photo, img.dataset.full === '1');
    if (url) img.src = url;
  });
}
const photoImg = (id, full = false, alt = '') => `<img data-photo="${esc(id)}" data-full="${full ? 1 : 0}" alt="${esc(alt)}" loading="lazy">`;

/* ═════════════ 기념일 계산 ═════════════ */
function anniversaries() {
  const p = S.profile, out = [];
  if (!p.startDate) return out;
  const s = parseKey(p.startDate), off = offset();
  out.push({ title: '처음 만난 날', date: p.startDate, emoji: '🌷', kind: 'start' });
  for (let n = 100; n <= 10000; n += 100) {
    out.push({ title: `${n}일`, date: toKey(addDays(s, n - off)), emoji: n % 1000 === 0 ? '👑' : n % 500 === 0 ? '🎉' : '💝', kind: 'day' });
  }
  for (let y = 1; y <= 30; y++) {
    out.push({ title: `${y}주년`, date: toKey(new Date(s.getFullYear() + y, s.getMonth(), s.getDate())), emoji: '🎂', kind: 'year' });
  }
  const now = new Date().getFullYear();
  const years = []; for (let y = Math.min(s.getFullYear(), now) - 1; y <= now + 3; y++) years.push(y);
  for (const who of [p.me, p.her]) {
    if (!who.birthday) continue;
    const b = parseKey(who.birthday);
    for (const y of years) out.push({ title: `${who.name || '?'} 생일`, date: toKey(new Date(y, b.getMonth(), b.getDate())), emoji: '🎈', kind: 'birthday' });
  }
  for (const c of p.custom || []) {
    if (c.repeat) {
      const b = parseKey(c.date);
      for (const y of years) if (y >= b.getFullYear()) out.push({ title: c.title, date: toKey(new Date(y, b.getMonth(), b.getDate())), emoji: c.emoji || '🎀', kind: 'custom', cid: c.id });
    } else out.push({ title: c.title, date: c.date, emoji: c.emoji || '🎀', kind: 'custom', cid: c.id });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
const upcomingAnniv = (n = 8) => { const t = todayKey(); return anniversaries().filter((a) => a.date >= t && a.kind !== 'start').slice(0, n); };

/* ═════════════ 공통 조각 ═════════════ */
function avatar(who, cls = '') {
  const inner = who.photoId ? photoImg(who.photoId) : esc(who.emoji || '🙂');
  return `<div class="avatar ${cls}">${inner}</div>`;
}
const memDates = (m) => {
  if (!m.endDate || m.endDate <= m.date) return [m.date];
  const out = []; let d = parseKey(m.date); const e = parseKey(m.endDate);
  while (d <= e && out.length < 60) { out.push(toKey(d)); d = addDays(d, 1); }
  return out;
};
const sortedMemories = () => live('memories').sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
const tripLen = (m) => { const n = diffDays(parseKey(m.date), parseKey(m.endDate)); return n > 0 ? `${n}박 ${n + 1}일` : ''; };

/* ═════════════ 라우터 ═════════════ */
const view = () => $('#view');
const parseRoute = () => { const [name, param] = (location.hash.replace(/^#\/?/, '') || 'home').split('/'); return { name, param }; };
let lastRoute = '';

function render(keepScroll = false) {
  if (!S.profile.startDate) return renderOnboarding();
  const { name, param } = parseRoute();
  const fn = { home: viewHome, calendar: viewCalendar, wish: viewWish, memories: viewMemories, memory: viewMemoryDetail, settings: viewSettings }[name] || viewHome;
  const v = view();
  const y = window.scrollY;
  const routeKey = name + '/' + (param || '');
  v.innerHTML = fn(param);
  const tabbed = ['home', 'calendar', 'wish', 'memories'].includes(name);
  v.classList.toggle('no-tab', !tabbed);
  renderTabbar(tabbed ? name : null);
  hydratePhotos(v);
  afterRender[name]?.(v);
  if (routeKey !== lastRoute) { window.scrollTo(0, 0); v.style.animation = 'none'; v.offsetHeight; v.style.animation = ''; }
  else if (keepScroll) window.scrollTo(0, y);
  lastRoute = routeKey;
}
const rerender = () => render(true);
const go = (to) => { location.hash = '#/' + to; };

function renderTabbar(active) {
  const tb = $('#tabbar');
  if (!active) { tb.classList.add('hidden'); return; }
  tb.classList.remove('hidden');
  const t = (id, ic, label) => `<button class="tab ${active === id ? 'on' : ''}" data-act="go" data-to="${id}">${icon(ic, 24)}<span>${label}</span></button>`;
  tb.innerHTML = t('home', 'home', '홈') + t('calendar', 'calendar', '캘린더') + `<button class="tab-plus" data-act="plus" aria-label="추가">${icon('plus', 28)}</button>` + t('wish', 'list', '위시') + t('memories', 'album', '추억');
}

/* ═════════════ 온보딩 ═════════════ */
function renderOnboarding() {
  $('#tabbar').classList.add('hidden');
  view().classList.add('no-tab');
  view().innerHTML = `
  <div class="onboard">
    <img class="logo" src="icons/icon-192.png" alt="">
    <h1>다해랑</h1>
    <p>다해랑 함께한 날들을 기록하고<br>앞으로 할 것들을 하나씩 모아봐요 💕</p>
    <form class="card" data-form="onboard">
      <div class="field"><label>내 이름</label><input class="input" name="me" placeholder="예) 나" required maxlength="12"></div>
      <div class="field"><label>여자친구 이름</label><input class="input" name="her" value="다해" required maxlength="12"></div>
      <div class="field"><label>우리가 사귄 날 💘</label><input class="input" type="date" name="start" required max="${todayKey()}"></div>
      <button class="btn block" type="submit">${heartFill(18)} 시작하기</button>
    </form>
  </div>`;
}

/* ═════════════ 홈 ═════════════ */
function viewHome() {
  const p = S.profile, t = todayKey();
  const n = relDay(t);
  const ups = upcomingAnniv(8);
  const wishes = live('wishes');
  const done = wishes.filter((w) => w.done).length;
  const pct = wishes.length ? Math.round((done / wishes.length) * 100) : 0;
  const mems = sortedMemories();
  const photos = mems.reduce((a, m) => a + (m.photoIds?.length || 0), 0);
  const next = wishes.filter((w) => !w.done && w.targetDate && w.targetDate >= t).sort((a, b) => a.targetDate.localeCompare(b.targetDate))[0];

  // 오늘 이거 어때?
  const todo = wishes.filter((w) => !w.done);
  let sug = todo.find((w) => w.id === S.suggestId);
  if (!sug && todo.length) { sug = todo[Math.floor(Math.random() * todo.length)]; S.suggestId = sug.id; }

  // N년 전 오늘 / 랜덤 추억
  const md = t.slice(5);
  let feat = mems.find((m) => m.date.slice(5) === md && m.date < t);
  let featLabel = feat ? `${parseKey(t).getFullYear() - parseKey(feat.date).getFullYear()}년 전 오늘 🕰️` : '';
  if (!feat) { const withPh = mems.filter((m) => m.photoIds?.length); const pool = withPh.length ? withPh : mems; feat = pool[(new Date().getDate()) % (pool.length || 1)]; featLabel = '우리의 추억 한 조각 📸'; }

  const R = 24, C = 2 * Math.PI * R;
  return `
  <header class="topbar">
    <div class="brand">다해랑 ${heartFill(20)}</div>
    <button class="icon-btn" data-act="go" data-to="settings" aria-label="설정">${icon('gear', 21)}</button>
  </header>

  <section class="card hero" data-act="hearts">
    <div class="couple">${avatar(p.me)}<div class="beat">${heartFill(30)}</div>${avatar(p.her)}</div>
    <div class="names">${esc(p.me.name)}<span>♥</span>${esc(p.her.name)}</div>
    <div class="dcount"><small>우리 함께한 지</small><b>${n > 0 ? n.toLocaleString() : 'D' + (n - 1)}</b><em>${n > 0 ? '일째' : ''}</em></div>
    <div class="since">${fmtDot(p.startDate)} 부터 함께 💕</div>
  </section>

  <section class="section">
    <div class="sec-head"><h3>다가오는 기념일</h3><button class="link" data-act="anniv-all">전체보기 ›</button></div>
    <div class="hscroll">
      ${ups.map((a) => `<div class="anniv-card ${a.date === t ? 'today' : ''}"><div class="em">${a.emoji}</div><div class="t">${esc(a.title)}</div><div class="d">${fmtDot(a.date)}</div><div class="dd">${dLabel(a.date)}</div></div>`).join('')}
    </div>
  </section>

  <section class="section">
    ${next ? `
    <button class="card next-date" style="width:100%;text-align:left" data-act="edit-wish" data-id="${next.id}">
      <div class="badge"><div><small>${next.targetDate === t ? '오늘' : 'D-'}</small><b>${next.targetDate === t ? '💕' : diffDays(new Date(), parseKey(next.targetDate))}</b></div></div>
      <div class="info"><div class="label">다음 데이트 ${catOf(next.category).emoji}</div><div class="title">${esc(next.title)}</div><div class="date">${fmtFull(next.targetDate)}</div></div>
      ${icon('right', 20)}
    </button>` : `
    <button class="card next-date" style="width:100%;text-align:left" data-act="new-plan">
      <div class="badge"><b>📅</b></div>
      <div class="info"><div class="label">다음 데이트</div><div class="title">아직 계획이 없어요</div><div class="date">다음 데이트 날짜를 정해볼까요?</div></div>
      ${icon('plus', 20)}
    </button>`}
  </section>

  <section class="section grid2">
    <button class="card stat" data-act="go" data-to="wish">
      <div class="label">위시 달성률</div>
      <div class="ring-wrap">
        <svg class="ring" viewBox="0 0 58 58"><circle class="bg" cx="29" cy="29" r="${R}"/><circle class="fg" cx="29" cy="29" r="${R}" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - pct / 100)}"/><text x="29" y="30">${pct}%</text></svg>
        <div class="val">${done}<small>/ ${wishes.length}</small></div>
      </div>
    </button>
    <button class="card stat" data-act="go" data-to="memories">
      <div class="label">쌓인 추억</div>
      <div class="val">${mems.length}<small>번의 기록</small></div>
      <div class="label">📸 사진 ${photos}장</div>
    </button>
  </section>

  ${sug ? `
  <section class="section card suggest">
    <div class="q"><span>오늘은 이거 어때? 🤔</span><button class="icon-btn" style="width:34px;height:34px" data-act="shuffle" aria-label="다른 거">${icon('shuffle', 16)}</button></div>
    <div class="w">${catOf(sug.category).emoji} ${esc(sug.title)}</div>
    <div class="row"><button class="btn sm" data-act="toggle-wish" data-id="${sug.id}">${icon('check', 16)} 했어요!</button><button class="btn sm ghost" data-act="plan-wish" data-id="${sug.id}">📅 날짜 정하기</button></div>
  </section>` : `
  <section class="section card suggest">
    <div class="q"><span>하고 싶은 거 있어? ✍️</span></div>
    <div class="w">사소한 것도 좋아요.<br>생각날 때 바로 적어두기!</div>
    <div class="row"><button class="btn sm" data-act="new-wish">${icon('plus', 16)} 위시 추가</button></div>
  </section>`}

  ${feat ? `
  <section class="section">
    <div class="sec-head"><h3>${featLabel}</h3></div>
    <button class="card memory-feature" style="width:100%;text-align:left" data-act="go" data-to="memory/${feat.id}">
      ${feat.photoIds?.length ? `<div class="ph">${photoImg(feat.photoIds[0])}</div>` : ''}
      <div class="body"><div class="title">${esc(feat.mood || '')} ${esc(feat.title)}</div><div class="meta">${fmtDot(feat.date)}${feat.place ? ' · ' + esc(feat.place) : ''} · D+${relDay(feat.date)}</div></div>
    </button>
  </section>` : `
  <section class="section card empty">
    <span class="big">📷</span>첫 번째 데이트 기록을 남겨볼까요?<br><button class="btn" data-act="new-memory">추억 기록하기</button>
  </section>`}
  `;
}

/* ═════════════ 캘린더 ═════════════ */
function calData() {
  const map = {};
  const add = (k, type, item) => { (map[k] ||= { mem: [], plan: [], anniv: [] })[type].push(item); };
  for (const m of live('memories')) for (const k of memDates(m)) add(k, 'mem', m);
  for (const w of live('wishes')) if (w.targetDate) add(w.targetDate, 'plan', w);
  for (const a of anniversaries()) add(a.date, 'anniv', a);
  return map;
}
function viewCalendar() {
  if (!S.cal) { const d = new Date(); S.cal = { y: d.getFullYear(), m: d.getMonth(), sel: todayKey() }; }
  const { y, m, sel } = S.cal;
  const data = calData();
  const first = new Date(y, m, 1);
  const start = addDays(first, -first.getDay());
  const lastDay = new Date(y, m + 1, 0);
  const cells = Math.ceil((first.getDay() + lastDay.getDate()) / 7) * 7;
  const t = todayKey();
  let html = '';
  for (let i = 0; i < cells; i++) {
    const d = addDays(start, i), k = toKey(d), info = data[k];
    const cover = info?.mem.find((x) => x.photoIds?.length);
    const cls = ['day', d.getMonth() !== m ? 'out' : '', k === t ? 'today' : '', k === sel ? 'sel' : '', d.getDay() === 0 ? 'sun' : '', d.getDay() === 6 ? 'sat' : '', cover ? 'has-photo' : ''].join(' ');
    const marks = info ? [
      info.mem.length ? `<span class="mk mem">${heartFill(10)}</span>` : '',
      info.plan.some((w) => !w.done) ? '<i class="mk plan"></i>' : info.plan.length ? '<i class="mk done"></i>' : '',
      info.anniv.length ? '<i class="mk anniv"></i>' : '',
    ].join('') : '';
    html += `<button class="${cls}" data-act="pick" data-date="${k}">${cover ? `<div class="bgimg">${photoImg(cover.photoIds[0])}</div>` : ''}<span class="n">${d.getDate()}</span><span class="marks">${marks}</span></button>`;
  }
  const info = data[sel] || { mem: [], plan: [], anniv: [] };
  const isPast = sel <= t;
  const items = [
    ...info.anniv.map((a) => `<div class="row-item"><div class="em anniv">${a.emoji}</div><div class="tx"><b>${esc(a.title)}</b><small>기념일 · ${dLabel(a.date)}</small></div></div>`),
    ...info.mem.map((x) => `<button class="row-item" style="width:100%;text-align:left" data-act="go" data-to="memory/${x.id}"><div class="em">${x.photoIds?.length ? photoImg(x.photoIds[0]) : esc(x.mood || '💗')}</div><div class="tx"><b>${esc(x.title)}</b><small>${x.type === 'trip' ? '✈️ 여행' : '💕 데이트'}${x.place ? ' · ' + esc(x.place) : ''}</small></div>${icon('right', 18)}</button>`),
    ...info.plan.map((w) => `<div class="row-item"><button class="check ${w.done ? 'on' : ''}" data-act="toggle-wish" data-id="${w.id}">${icon('check', 16)}</button><button class="tx" style="text-align:left" data-act="edit-wish" data-id="${w.id}"><b>${esc(w.title)}</b><small>${catOf(w.category).emoji} ${w.done ? '완료했어요' : '계획된 일정 · ' + dLabel(w.targetDate)}</small></button></div>`),
  ];
  return `
  <header class="topbar"><div><h1>캘린더</h1><div class="sub">우리의 하루하루 📅</div></div></header>
  <section class="card cal" id="cal">
    <div class="cal-head">
      <h2>${y}년 ${m + 1}월</h2>
      <div class="nav"><button class="today-btn" data-act="cal-today">오늘</button><button data-act="cal-prev" aria-label="이전 달">${icon('left', 18)}</button><button data-act="cal-next" aria-label="다음 달">${icon('right', 18)}</button></div>
    </div>
    <div class="weekdays">${WEEK.map((w) => `<div>${w}</div>`).join('')}</div>
    <div class="days">${html}</div>
    <div class="legend"><span><span class="mk mem">${heartFill(10)}</span>추억</span><span><i class="mk plan"></i>계획</span><span><i class="mk anniv"></i>기념일</span></div>
  </section>
  <section class="day-panel">
    <div class="head"><h3>${fmtMD(sel)}</h3><span class="dplus">${relDay(sel) > 0 ? '우리 ' + relDay(sel) + '일째' : ''}</span></div>
    ${items.join('') || `<div class="card empty" style="padding:22px">${isPast ? '이 날은 아직 기록이 없어요 🍃' : '이 날은 아직 계획이 없어요 🍃'}</div>`}
    <div class="actions">
      ${isPast ? `<button class="btn" data-act="new-memory" data-date="${sel}">${icon('camera', 18)} 추억 남기기</button>` : ''}
      <button class="btn ${isPast ? 'ghost' : ''}" data-act="new-plan" data-date="${sel}">${icon('calendar', 18)} 일정 추가</button>
    </div>
  </section>`;
}
function moveMonth(delta) {
  const d = new Date(S.cal.y, S.cal.m + delta, 1);
  S.cal.y = d.getFullYear(); S.cal.m = d.getMonth();
  const t = new Date();
  S.cal.sel = d.getFullYear() === t.getFullYear() && d.getMonth() === t.getMonth() ? todayKey() : toKey(d);
  rerender();
}

/* ═════════════ 위시리스트 ═════════════ */
function viewWish() {
  const all = live('wishes');
  const done = all.filter((w) => w.done).length;
  const pct = all.length ? Math.round((done / all.length) * 100) : 0;
  const inCat = all.filter((w) => S.wishCat === 'all' || w.category === S.wishCat);
  const todo = inCat.filter((w) => !w.done).sort((a, b) => (a.targetDate || '9999').localeCompare(b.targetDate || '9999') || b.createdAt - a.createdAt);
  const fin = inCat.filter((w) => w.done).sort((a, b) => (b.doneAt || '').localeCompare(a.doneAt || '') || b.updatedAt - a.updatedAt);
  const list = S.wishTab === 'todo' ? todo : fin;
  const msg = pct === 100 && all.length ? '전부 해냈어요! 대단해 🎉' : pct >= 50 ? '반 넘게 해냈어요 👏' : all.length ? '하나씩 같이 해봐요 💪' : '첫 위시를 적어볼까요?';
  const t = todayKey();
  return `
  <header class="topbar"><div><h1>우리 위시리스트</h1><div class="sub">하고 싶은 건 생각날 때마다 쏙 ✍️</div></div></header>
  <section class="card progress-card">
    <div class="top"><div class="big">${done}<small> / ${all.length} 완료</small></div><div class="msg">${msg}</div></div>
    <div class="bar"><i style="width:${pct}%"></i></div>
  </section>
  <div class="filters">
    <button class="filter ${S.wishCat === 'all' ? 'on' : ''}" data-act="wish-cat" data-cat="all">전체</button>
    ${CATS.map((c) => `<button class="filter ${S.wishCat === c.id ? 'on' : ''}" data-act="wish-cat" data-cat="${c.id}">${c.emoji} ${c.label}</button>`).join('')}
  </div>
  <form class="quick-add" data-form="quick-wish">
    <input name="title" placeholder="${S.wishCat === 'all' ? '하고 싶은 걸 바로 적어봐요' : catOf(S.wishCat).label + ' 위시 적기'}" maxlength="80" autocomplete="off" enterkeyhint="done">
    <button type="submit" aria-label="추가">${icon('plus', 20)}</button>
  </form>
  <div class="seg">
    <button class="${S.wishTab === 'todo' ? 'on' : ''}" data-act="wish-tab" data-tab="todo">하고 싶은 것 ${todo.length}</button>
    <button class="${S.wishTab === 'done' ? 'on' : ''}" data-act="wish-tab" data-tab="done">해낸 것 ${fin.length}</button>
  </div>
  <div class="wish-list">
    ${list.map((w, i) => `
    <div class="wish-item ${w.done ? 'done' : ''}" style="animation-delay:${Math.min(i, 10) * 30}ms">
      <button class="check ${w.done ? 'on' : ''}" data-act="toggle-wish" data-id="${w.id}" aria-label="완료">${icon('check', 16)}</button>
      <button class="wi-body" style="text-align:left" data-act="edit-wish" data-id="${w.id}">
        <div class="wt">${esc(w.title)}</div>
        <div class="wm">
          <span class="chip gray">${catOf(w.category).emoji} ${catOf(w.category).label}</span>
          ${!w.done && w.targetDate ? `<span class="chip plan">📅 ${fmtDot(w.targetDate).slice(5)} · ${dLabel(w.targetDate)}</span>` : ''}
          ${w.done && w.doneAt ? `<span class="chip">✓ ${fmtDot(w.doneAt)}</span>` : ''}
          ${w.note ? `<span class="chip gray">📝 메모</span>` : ''}
        </div>
      </button>
      ${w.done && w.memoryId && S.memories.find((m) => m.id === w.memoryId && !m.deleted) ? `<button class="icon-btn" style="width:36px;height:36px" data-act="go" data-to="memory/${w.memoryId}" aria-label="추억 보기">${icon('album', 17)}</button>` : ''}
    </div>`).join('') || `<div class="empty"><span class="big">${S.wishTab === 'todo' ? '🌱' : '🏅'}</span>${S.wishTab === 'todo' ? '같이 하고 싶은 걸 적어봐요<br>사소한 것도 다 좋아요!' : '아직 해낸 위시가 없어요<br>하나씩 체크해봐요 ✓'}</div>`}
  </div>`;
}

/* ═════════════ 추억 ═════════════ */
function viewMemories() {
  const mems = sortedMemories();
  const trips = mems.filter((m) => m.type === 'trip').length;
  const photos = mems.flatMap((m) => (m.photoIds || []).map((pid) => ({ pid, mid: m.id })));
  let body = '';
  if (!mems.length) {
    body = `<div class="card empty"><span class="big">📖</span>아직 기록된 추억이 없어요<br>다해랑 보낸 하루를 남겨볼까요?<br><button class="btn" data-act="new-memory">${icon('camera', 18)} 첫 추억 남기기</button></div>`;
  } else if (S.memView === 'album') {
    body = photos.length ? `<div class="album">${photos.map((p) => `<button data-act="go" data-to="memory/${p.mid}">${photoImg(p.pid)}</button>`).join('')}</div>` : `<div class="card empty"><span class="big">🖼️</span>아직 사진이 없어요</div>`;
  } else {
    let lastMonth = '';
    for (const m of mems) {
      const mk = m.date.slice(0, 7);
      if (mk !== lastMonth) { const [yy, mm] = mk.split('-'); body += `<div class="month-label">${yy}년 ${Number(mm)}월</div>`; lastMonth = mk; }
      const d = parseKey(m.date);
      body += `
      <button class="mem-card ${m.photoIds?.length ? '' : 'compact'}" data-act="go" data-to="memory/${m.id}">
        ${m.photoIds?.length ? `<div class="cover">${photoImg(m.photoIds[0])}${m.photoIds.length > 1 ? `<span class="cnt">${icon('album', 12)} ${m.photoIds.length}</span>` : ''}</div>` : ''}
        <div class="body">
          <div class="datebox"><b>${d.getDate()}</b><small>${WEEK[d.getDay()]}요일</small></div>
          <div class="tx">
            <div class="tt"><span>${esc(m.title)}</span>${m.mood ? `<span>${esc(m.mood)}</span>` : ''}</div>
            <div class="mt">${m.type === 'trip' ? '✈️ ' + (tripLen(m) || '여행') : '💕 데이트'}${m.place ? ` · ${icon('pin', 12)} ${esc(m.place)}` : ''}</div>
            ${m.note ? `<div class="note">${esc(m.note)}</div>` : ''}
          </div>
        </div>
      </button>`;
    }
  }
  return `
  <header class="topbar">
    <div><h1>우리의 추억</h1><div class="sub">다해랑 함께한 순간들 📖</div></div>
    <button class="icon-btn" data-act="mem-view" aria-label="보기 전환">${icon(S.memView === 'album' ? 'timeline' : 'grid', 20)}</button>
  </header>
  <section class="card mem-stats">
    <div><b>${mems.length - trips}</b><small>데이트</small></div>
    <div><b>${trips}</b><small>여행</small></div>
    <div><b>${photos.length}</b><small>사진</small></div>
  </section>
  <div class="timeline">${body}</div>`;
}

function viewMemoryDetail(id) {
  const m = S.memories.find((x) => x.id === id && !x.deleted);
  if (!m) return `<header class="topbar"><button class="icon-btn" data-act="back">${icon('left')}</button></header><div class="empty"><span class="big">🥲</span>추억을 찾을 수 없어요</div>`;
  const ph = m.photoIds || [];
  const range = m.type === 'trip' && m.endDate && m.endDate > m.date;
  return `
  <header class="topbar">
    <button class="icon-btn" data-act="back" aria-label="뒤로">${icon('left')}</button>
    <div class="top-actions">
      <button class="icon-btn" data-act="edit-memory" data-id="${m.id}" aria-label="수정">${icon('edit', 19)}</button>
      <button class="icon-btn danger" data-act="del-memory" data-id="${m.id}" aria-label="삭제">${icon('trash', 19)}</button>
    </div>
  </header>
  ${ph.length ? `
  <div class="detail-photos">
    <div class="swiper" id="dswiper">${ph.map((p, i) => `<button class="slide" data-act="viewer" data-id="${m.id}" data-i="${i}">${photoImg(p, true)}</button>`).join('')}</div>
    ${ph.length > 1 ? `<span class="swiper-count" id="dcount">1 / ${ph.length}</span>` : ''}
  </div>` : ''}
  <div class="detail-body">
    <div class="detail-tags">
      <span class="chip">${m.type === 'trip' ? '✈️ 여행' : '💕 데이트'}</span>
      <span class="chip anniv">우리 ${relDay(m.date)}일째</span>
      ${range ? `<span class="chip plan">${tripLen(m)}</span>` : ''}
    </div>
    <h2>${esc(m.title)} ${m.mood ? `<span class="mood-big">${esc(m.mood)}</span>` : ''}</h2>
    <div class="detail-meta">
      <div>${icon('calendar', 17)} ${fmtFull(m.date)}${range ? ' ~ ' + fmtMD(m.endDate) : ''}</div>
      ${m.place ? `<div>${icon('pin', 17)} ${esc(m.place)}</div>` : ''}
    </div>
    ${m.note ? `<div class="detail-note">${esc(m.note)}</div>` : ''}
  </div>`;
}

/* ═════════════ 설정 ═════════════ */
function viewSettings() {
  const p = S.profile;
  const person = (key, who, label) => `
    <div class="profile-row">
      <label class="avatar sm">${who.photoId ? photoImg(who.photoId) : esc(who.emoji || '🙂')}<span class="cam">${icon('camera', 12)}</span><input type="file" accept="image/*" hidden data-change="avatar" data-who="${key}"></label>
      <div class="fields">
        <input value="${esc(who.name)}" placeholder="${label} 이름" maxlength="12" data-change="name" data-who="${key}">
        <input type="date" value="${esc(who.birthday || '')}" data-change="birthday" data-who="${key}" aria-label="${label} 생일">
      </div>
    </div>`;
  const customs = (p.custom || []).slice().sort((a, b) => a.date.localeCompare(b.date));
  return `
  <header class="topbar"><button class="icon-btn" data-act="back" aria-label="뒤로">${icon('left')}</button><h1 style="font-size:20px">설정</h1><span style="width:42px"></span></header>

  <div class="set-title">우리 둘 (사진 · 이름 · 생일)</div>
  <div class="set-group">${person('me', p.me, '나')}${person('her', p.her, '여자친구')}</div>

  <div class="set-title">우리의 시작</div>
  <div class="set-group">
    <div class="set-row"><div class="l">💘 사귄 날</div><input type="date" value="${p.startDate}" max="${todayKey()}" data-change="start"></div>
    <button class="set-row" data-act="toggle-count"><div class="l">사귄 날을 1일로 계산</div><span class="switch ${p.countFromOne === false ? '' : 'on'}"></span></button>
  </div>

  <div class="set-title">우리만의 기념일</div>
  <div class="set-group">
    ${customs.map((c) => `<button class="set-row" data-act="edit-anniv" data-id="${c.id}"><div class="l">${esc(c.emoji || '🎀')} ${esc(c.title)}</div><div class="r">${fmtDot(c.date)}${c.repeat ? ' · 매년' : ''} ${icon('right', 16)}</div></button>`).join('')}
    <button class="set-row" data-act="edit-anniv"><div class="l" style="color:var(--accent)">${icon('plus', 18)} 기념일 추가</div></button>
  </div>

  <div class="set-title">테마 색상</div>
  <div class="set-group"><div class="set-row"><div class="l">🎨 포인트 컬러</div><div class="theme-dots">${THEMES.map((t) => `<button style="background:${t.color}" class="${(p.theme || 'pink') === t.id ? 'on' : ''}" data-act="theme" data-theme="${t.id}" aria-label="${t.id}"></button>`).join('')}</div></div></div>

  <div class="set-title">데이터 (지금은 이 폰에만 저장돼요)</div>
  <div class="set-group">
    <button class="set-row" data-act="export"><div class="l">${icon('download', 18)} 백업 파일 만들기</div><div class="r">${icon('right', 16)}</div></button>
    <label class="set-row" style="cursor:pointer"><div class="l">${icon('upload', 18)} 백업 불러오기</div><div class="r">${icon('right', 16)}</div><input type="file" accept="application/json,.json" hidden data-change="import"></label>
    <div class="set-row"><div class="l">💾 사용 중인 공간</div><div class="r" id="storage-usage">계산 중…</div></div>
  </div>

  <div class="about"><img src="icons/icon-192.png" alt="">다해랑 v1.0<br>${esc(p.me.name)} ♥ ${esc(p.her.name)}의 기록장</div>`;
}

const afterRender = {
  calendar(v) {
    const cal = $('#cal', v);
    let sx = 0, sy = 0;
    cal.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
    cal.addEventListener('touchend', (e) => {
      const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) moveMonth(dx < 0 ? 1 : -1);
    });
  },
  memory(v) {
    const sw = $('#dswiper', v), cnt = $('#dcount', v);
    if (sw && cnt) sw.addEventListener('scroll', () => { cnt.textContent = `${Math.round(sw.scrollLeft / sw.clientWidth) + 1} / ${sw.children.length}`; }, { passive: true });
  },
  async settings(v) {
    try {
      const e = await navigator.storage?.estimate?.();
      const el = $('#storage-usage', v);
      if (el) el.textContent = e ? `${(e.usage / 1048576).toFixed(1)} MB` : '-';
    } catch {}
  },
};

/* ═════════════ 시트 / 토스트 / 다이얼로그 ═════════════ */
// 시트/뷰어는 history에 한 칸씩 쌓아서 안드로이드 뒤로가기로 닫히게 합니다.
const sheets = [];
const popWaiters = [];
window.addEventListener('popstate', () => {
  if (popWaiters.length) { popWaiters.shift()(); return; }
  const top = sheets.pop();
  if (top) top._close();
});
function closeLayer(s) {
  return new Promise((res) => {
    const i = sheets.indexOf(s);
    if (i < 0) return res();
    sheets.splice(i, 1);
    s._close();
    let done = false;
    const fin = () => { if (!done) { done = true; res(); } };
    popWaiters.push(fin);
    history.back();
    setTimeout(() => { const j = popWaiters.indexOf(fin); if (j >= 0) popWaiters.splice(j, 1); fin(); }, 500);
  });
}
function openSheet(title, html, onMount) {
  const wrap = document.createElement('div');
  wrap.className = 'sheet-wrap';
  wrap.innerHTML = `<div class="sheet-dim"></div><div class="sheet" role="dialog"><div class="sheet-handle"></div>${title ? `<div class="sheet-title">${title}</div>` : ''}<div class="sheet-body">${html}</div></div>`;
  $('#sheet-root').appendChild(wrap);
  const s = { el: wrap, body: $('.sheet-body', wrap) };
  s._close = () => {
    wrap.classList.add('closing'); $('.sheet', wrap).classList.add('closing');
    setTimeout(() => wrap.remove(), 220);
  };
  s.close = () => closeLayer(s);
  $('.sheet-dim', wrap).addEventListener('click', () => s.close());
  // 손잡이 드래그로 닫기
  const sheet = $('.sheet', wrap);
  let startY = null;
  sheet.addEventListener('touchstart', (e) => { if (sheet.scrollTop <= 0 && e.target.closest('.sheet-handle, .sheet-title')) startY = e.touches[0].clientY; }, { passive: true });
  sheet.addEventListener('touchmove', (e) => { if (startY == null) return; const dy = Math.max(0, e.touches[0].clientY - startY); sheet.style.transform = `translateY(${dy}px)`; }, { passive: true });
  sheet.addEventListener('touchend', (e) => { if (startY == null) return; const dy = e.changedTouches[0].clientY - startY; startY = null; sheet.style.transform = ''; if (dy > 90) s.close(); });
  sheets.push(s);
  history.pushState({ sheet: true }, '');
  hydratePhotos(wrap);
  onMount?.(s);
  return s;
}
function toast(msg, action) {
  const root = $('#toast-root');
  root.innerHTML = '';
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span>${msg}</span>${action ? `<button>${action.label}</button>` : ''}`;
  root.appendChild(el);
  if (action) $('button', el).addEventListener('click', () => { el.remove(); action.run(); });
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 250); }, action ? 4500 : 2200);
}
function confirmDialog({ emoji = '🥺', title, text = '', ok = '확인', cancel = '취소', danger = false }) {
  return new Promise((res) => {
    const w = document.createElement('div');
    w.className = 'dialog-wrap';
    w.innerHTML = `<div class="sheet-dim"></div><div class="dialog"><div class="em">${emoji}</div><h4>${title}</h4><p>${text}</p><div class="btns"><button class="btn light" data-r="0">${cancel}</button><button class="btn ${danger ? 'danger' : ''}" data-r="1">${ok}</button></div></div>`;
    document.body.appendChild(w);
    w.addEventListener('click', (e) => {
      const b = e.target.closest('[data-r]');
      if (b || e.target.classList.contains('sheet-dim')) { w.remove(); res(b?.dataset.r === '1'); }
    });
  });
}

/* ═════════════ 효과 ═════════════ */
function floatHearts(x, y) {
  const emo = ['💗', '💕', '💖', '❤️', '🩷'];
  for (let i = 0; i < 7; i++) {
    const h = document.createElement('div');
    h.className = 'fx-heart';
    h.textContent = emo[i % emo.length];
    h.style.left = x - 10 + (Math.random() * 40 - 20) + 'px';
    h.style.top = y - 10 + 'px';
    h.style.fontSize = 16 + Math.random() * 16 + 'px';
    h.style.setProperty('--dx', Math.random() * 120 - 60 + 'px');
    h.style.setProperty('--rot', Math.random() * 60 - 30 + 'deg');
    h.style.animationDelay = i * 60 + 'ms';
    document.body.appendChild(h);
    setTimeout(() => h.remove(), 1800);
  }
}
function burst(x, y) {
  const emo = ['💗', '✨', '💕', '⭐', '🎉'];
  for (let i = 0; i < 14; i++) {
    const b = document.createElement('div');
    b.className = 'fx-burst';
    b.textContent = emo[i % emo.length];
    const a = (Math.PI * 2 * i) / 14, r = 50 + Math.random() * 40;
    b.style.left = x + 'px'; b.style.top = y + 'px';
    b.style.setProperty('--dx', Math.cos(a) * r + 'px');
    b.style.setProperty('--dy', Math.sin(a) * r + 'px');
    document.body.appendChild(b);
    setTimeout(() => b.remove(), 1000);
  }
}

/* ═════════════ 폼: 추억 ═════════════ */
function memoryForm(existing, prefill = {}) {
  const m = existing ? { ...existing } : { type: 'date', date: todayKey(), title: '', place: '', mood: '', note: '', photoIds: [], ...prefill };
  const photos = (m.photoIds || []).map((id) => ({ id, existing: true }));
  const removed = [];
  const html = `
  <form data-sheet-form>
    <div class="field"><div class="chips-select" data-group="type">
      <button type="button" data-v="date" class="${m.type !== 'trip' ? 'on' : ''}">💕 데이트</button>
      <button type="button" data-v="trip" class="${m.type === 'trip' ? 'on' : ''}">✈️ 여행</button>
    </div></div>
    <div class="field"><label>어떤 하루였어?</label><input class="input" name="title" value="${esc(m.title)}" placeholder="예) 한강에서 피크닉" maxlength="40" required></div>
    <div class="row2 field">
      <div><label>${m.type === 'trip' ? '떠난 날' : '날짜'}</label><input class="input" type="date" name="date" value="${m.date}" required></div>
      <div class="end-wrap" style="${m.type === 'trip' ? '' : 'display:none'}"><label>돌아온 날</label><input class="input" type="date" name="endDate" value="${m.endDate || ''}"></div>
    </div>
    <div class="field"><label>어디서?</label><input class="input" name="place" value="${esc(m.place)}" placeholder="장소 (선택)" maxlength="40"></div>
    <div class="field"><label>그날의 기분</label><div class="mood-select">${MOODS.map((e) => `<button type="button" data-mood="${e}" class="${m.mood === e ? 'on' : ''}">${e}</button>`).join('')}</div></div>
    <div class="field"><label>사진 (최대 ${MAX_PHOTOS}장 · 첫 장이 대표사진)</label><div class="photo-grid" id="pgrid"></div><input type="file" accept="image/*" multiple hidden id="pfile"></div>
    <div class="field"><label>메모</label><textarea class="textarea" name="note" placeholder="그날 있었던 일, 하고 싶은 말…" maxlength="2000">${esc(m.note || '')}</textarea></div>
    <div class="sheet-foot">
      ${existing ? `<button type="button" class="btn danger" data-del aria-label="삭제">${icon('trash', 20)}</button>` : ''}
      <button class="btn block" type="submit">${existing ? '수정 완료' : '추억 저장하기 💗'}</button>
    </div>
  </form>`;
  openSheet(existing ? '추억 수정' : '추억 기록하기 📸', html, (s) => {
    const f = $('form', s.body);
    let type = m.type || 'date', mood = m.mood || '';
    const grid = $('#pgrid', s.body), fileIn = $('#pfile', s.body);
    const drawGrid = () => {
      grid.innerHTML = photos.map((p, i) => `<div class="ph">${p.existing ? photoImg(p.id) : `<img src="${p.url}">`}<button type="button" class="x" data-rm="${i}">${icon('close', 12)}</button>${i === 0 ? '<span class="cover-tag">대표</span>' : ''}</div>`).join('') +
        (photos.length < MAX_PHOTOS ? `<button type="button" class="add" data-addph>${icon('camera', 22)}<span>${photos.length}/${MAX_PHOTOS}</span></button>` : '');
      hydratePhotos(grid);
    };
    drawGrid();
    s.body.addEventListener('click', async (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.closest('[data-group=type]')) {
        type = t.dataset.v;
        $$('[data-group=type] button', s.body).forEach((b) => b.classList.toggle('on', b === t));
        $('.end-wrap', s.body).style.display = type === 'trip' ? '' : 'none';
        $('.row2 label', s.body).textContent = type === 'trip' ? '떠난 날' : '날짜';
      } else if (t.dataset.mood) {
        mood = mood === t.dataset.mood ? '' : t.dataset.mood;
        $$('.mood-select button', s.body).forEach((b) => b.classList.toggle('on', b.dataset.mood === mood));
        haptic();
      } else if (t.hasAttribute('data-addph')) fileIn.click();
      else if (t.dataset.rm != null) {
        const [p] = photos.splice(Number(t.dataset.rm), 1);
        if (p.existing) removed.push(p.id); else URL.revokeObjectURL(p.url);
        drawGrid();
      } else if (t.hasAttribute('data-del')) {
        if (await confirmDialog({ title: '이 추억을 지울까요?', text: '사진도 함께 삭제되고 되돌릴 수 없어요.', ok: '삭제', danger: true })) {
          await removeRec('memories', existing);
          await s.close();
          toast('추억을 삭제했어요');
          go('memories');
        }
      }
    });
    fileIn.addEventListener('change', async () => {
      const files = [...fileIn.files].slice(0, MAX_PHOTOS - photos.length);
      fileIn.value = '';
      if (!files.length) return;
      const addBtn = $('[data-addph]', grid); addBtn?.classList.add('busy');
      for (const file of files) {
        try { const rec = await processPhoto(file); photos.push({ id: rec.id, rec, url: URL.createObjectURL(rec.thumb) }); }
        catch { toast('사진을 불러오지 못했어요 🥲'); }
      }
      drawGrid();
    });
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(f);
      const btn = $('[type=submit]', f); btn.disabled = true; btn.textContent = '저장 중…';
      try {
        for (const p of photos) if (!p.existing) await db.put('photos', p.rec);
        for (const id of removed) await deletePhoto(id);
        photos.forEach((p) => p.url && URL.revokeObjectURL(p.url));
        const rec = existing ? { ...existing } : { id: uid() };
        rec.type = type;
        rec.title = fd.get('title').trim();
        rec.date = fd.get('date');
        rec.endDate = type === 'trip' && fd.get('endDate') >= rec.date ? fd.get('endDate') : '';
        rec.place = fd.get('place').trim();
        rec.mood = mood;
        rec.note = fd.get('note').trim();
        rec.photoIds = photos.map((p) => p.id);
        if (m.fromWishId) rec.fromWishId = m.fromWishId;
        await saveRec('memories', rec);
        if (m.fromWishId) { const w = S.wishes.find((x) => x.id === m.fromWishId); if (w) { w.memoryId = rec.id; await saveRec('wishes', w); } }
        await s.close();
        toast(existing ? '수정했어요 ✨' : '소중한 추억이 저장됐어요 💗');
        if (!existing) floatHearts(innerWidth / 2, innerHeight * 0.6);
        const target = '#/memory/' + rec.id;
        if (location.hash !== target && !existing) location.hash = target; else rerender();
      } catch (err) {
        console.error(err);
        btn.disabled = false; btn.textContent = '다시 시도';
        toast('저장에 실패했어요 🥲');
      }
    });
  });
}

/* ═════════════ 폼: 위시 / 일정 ═════════════ */
function wishForm(existing, prefill = {}) {
  const w = existing ? { ...existing } : { title: '', category: S.wishCat !== 'all' ? S.wishCat : 'date', targetDate: '', note: '', ...prefill };
  const html = `
  <form data-sheet-form>
    <div class="field"><label>뭐 하고 싶어?</label><input class="input" name="title" value="${esc(w.title)}" placeholder="예) 같이 노을 보면서 산책하기" maxlength="80" required></div>
    <div class="field"><label>종류</label><div class="chips-select" data-group="cat">${CATS.map((c) => `<button type="button" data-v="${c.id}" class="${w.category === c.id ? 'on' : ''}">${c.emoji} ${c.label}</button>`).join('')}</div></div>
    <div class="field"><label>언제 할까? (정하면 캘린더에 표시돼요)</label><input class="input" type="date" name="targetDate" value="${w.targetDate || ''}"></div>
    <div class="field"><label>메모</label><textarea class="textarea" name="note" placeholder="장소, 링크, 준비물 등" maxlength="1000">${esc(w.note || '')}</textarea></div>
    ${existing ? `<div class="field"><button type="button" class="btn ${w.done ? 'ghost' : ''} block" data-done style="height:46px">${w.done ? '↺ 다시 하고 싶은 걸로' : '✓ 해냈어요!'}</button></div>` : ''}
    <div class="sheet-foot">
      ${existing ? `<button type="button" class="btn danger" data-del aria-label="삭제">${icon('trash', 20)}</button>` : ''}
      <button class="btn block" type="submit">${existing ? '저장' : '위시에 담기 ✍️'}</button>
    </div>
  </form>`;
  openSheet(existing ? '위시 수정' : prefill.targetDate ? '데이트 일정 추가 📅' : '하고 싶은 것 추가 ✍️', html, (s) => {
    const f = $('form', s.body);
    let cat = w.category;
    s.body.addEventListener('click', async (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.closest('[data-group=cat]')) { cat = t.dataset.v; $$('[data-group=cat] button', s.body).forEach((b) => b.classList.toggle('on', b === t)); }
      else if (t.hasAttribute('data-del')) {
        if (await confirmDialog({ title: '이 위시를 지울까요?', ok: '삭제', danger: true })) { await removeRec('wishes', existing); await s.close(); toast('삭제했어요'); rerender(); }
      } else if (t.hasAttribute('data-done')) { await s.close(); toggleWish(existing.id, t); }
    });
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(f);
      const rec = existing ? { ...existing } : { id: uid(), done: false };
      rec.title = fd.get('title').trim();
      rec.category = cat;
      rec.targetDate = fd.get('targetDate') || '';
      rec.note = fd.get('note').trim();
      await saveRec('wishes', rec);
      await s.close();
      toast(existing ? '저장했어요 ✨' : rec.targetDate ? `${fmtMD(rec.targetDate)}에 데이트 약속! 💕` : '위시에 담았어요 ✍️');
      rerender();
    });
  });
}

async function toggleWish(id, el) {
  const w = S.wishes.find((x) => x.id === id);
  if (!w) return;
  w.done = !w.done;
  w.doneAt = w.done ? todayKey() : '';
  await saveRec('wishes', w);
  haptic(w.done ? 25 : 10);
  if (w.done) {
    if (el?.isConnected) { const r = el.getBoundingClientRect(); burst(r.left + r.width / 2, r.top + r.height / 2); }
    else burst(innerWidth / 2, innerHeight / 2);
    if (S.suggestId === id) S.suggestId = null;
    const already = w.memoryId && S.memories.find((m) => m.id === w.memoryId && !m.deleted);
    toast('해냈어요! 🎉', already ? null : { label: '추억으로 남기기', run: () => memoryForm(null, { title: w.title, date: todayKey(), type: w.category === 'trip' ? 'trip' : 'date', fromWishId: w.id }) });
  }
  setTimeout(rerender, w.done ? 350 : 0);
}

/* ═════════════ 기념일 시트 ═════════════ */
function annivSheet() {
  const t = todayKey();
  const all = anniversaries();
  const up = all.filter((a) => a.date >= t);
  const past = all.filter((a) => a.date < t && a.kind !== 'birthday').reverse().slice(0, 30);
  const row = (a, dim) => `<div class="row-item" style="${dim ? 'opacity:.55' : ''}"><div class="em anniv">${a.emoji}</div><div class="tx"><b>${esc(a.title)}</b><small>${fmtFull(a.date)}</small></div><span class="chip ${dim ? 'gray' : ''}">${dLabel(a.date)}</span></div>`;
  openSheet('우리의 기념일 🎀', `
    ${up.slice(0, 40).map((a) => row(a)).join('')}
    ${past.length ? `<div class="month-label">지나온 기념일</div>${past.map((a) => row(a, true)).join('')}` : ''}
    <button class="btn ghost block" style="margin-top:10px" data-anniv-add>${icon('plus', 18)} 우리만의 기념일 추가</button>`, (s) => {
    $('[data-anniv-add]', s.body).addEventListener('click', async () => { await s.close(); annivForm(); });
  });
}
function annivForm(existing) {
  const c = existing ? { ...existing } : { title: '', date: todayKey(), repeat: true, emoji: '🎀' };
  const EMO = ['🎀', '💍', '🌹', '🎁', '🥂', '🏠', '🐶', '✈️'];
  openSheet(existing ? '기념일 수정' : '기념일 추가 🎀', `
  <form>
    <div class="field"><label>이름</label><input class="input" name="title" value="${esc(c.title)}" placeholder="예) 첫 키스한 날" maxlength="30" required></div>
    <div class="field"><label>날짜</label><input class="input" type="date" name="date" value="${c.date}" required></div>
    <div class="field"><label>아이콘</label><div class="mood-select">${EMO.map((e) => `<button type="button" data-e="${e}" class="${c.emoji === e ? 'on' : ''}">${e}</button>`).join('')}</div></div>
    <button type="button" class="set-row" data-rep style="padding:6px 4px 16px"><div class="l">매년 반복</div><span class="switch ${c.repeat ? 'on' : ''}"></span></button>
    <div class="sheet-foot">${existing ? `<button type="button" class="btn danger" data-del>${icon('trash', 20)}</button>` : ''}<button class="btn block" type="submit">저장</button></div>
  </form>`, (s) => {
    let emoji = c.emoji, repeat = c.repeat;
    s.body.addEventListener('click', async (e) => {
      const t = e.target.closest('button'); if (!t) return;
      if (t.dataset.e) { emoji = t.dataset.e; $$('[data-e]', s.body).forEach((b) => b.classList.toggle('on', b === t)); }
      else if (t.hasAttribute('data-rep')) { repeat = !repeat; $('.switch', t).classList.toggle('on', repeat); }
      else if (t.hasAttribute('data-del')) { S.profile.custom = S.profile.custom.filter((x) => x.id !== c.id); await saveProfile(); await s.close(); rerender(); }
    });
    $('form', s.body).addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const rec = { id: c.id || uid(), title: fd.get('title').trim(), date: fd.get('date'), emoji, repeat };
      S.profile.custom = (S.profile.custom || []).filter((x) => x.id !== rec.id).concat(rec);
      await saveProfile(); await s.close(); toast('기념일을 저장했어요 🎀'); rerender();
    });
  });
}

/* ═════════════ + 버튼 ═════════════ */
function plusSheet() {
  openSheet('무엇을 남길까요?', `
  <div class="action-list">
    <button class="action-item" data-a="memory"><div class="em">📸</div><div><b>추억 기록하기</b><small>오늘 혹은 지난 데이트·여행</small></div></button>
    <button class="action-item" data-a="plan"><div class="em">📅</div><div><b>데이트 일정 잡기</b><small>날짜를 정해서 캘린더에 쏙</small></div></button>
    <button class="action-item" data-a="wish"><div class="em">✍️</div><div><b>하고 싶은 것 적기</b><small>사소한 것도, 버킷리스트도</small></div></button>
  </div>`, (s) => {
    s.body.addEventListener('click', async (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return;
      await s.close();
      if (a === 'memory') memoryForm(null, { date: calSelPast() });
      if (a === 'plan') wishForm(null, { targetDate: calSelFuture(), category: 'date' });
      if (a === 'wish') wishForm(null);
    });
  });
}
const calSelPast = () => (parseRoute().name === 'calendar' && S.cal?.sel <= todayKey() ? S.cal.sel : todayKey());
const calSelFuture = () => (parseRoute().name === 'calendar' && S.cal?.sel >= todayKey() ? S.cal.sel : toKey(addDays(new Date(), 1)));

/* ═════════════ 사진 뷰어 ═════════════ */
function openViewer(mid, idx) {
  const m = S.memories.find((x) => x.id === mid); if (!m) return;
  const v = document.createElement('div');
  v.className = 'viewer';
  v.innerHTML = `<button class="close">${icon('close', 22)}</button><div class="swiper">${m.photoIds.map((p) => `<div class="slide">${photoImg(p, true)}</div>`).join('')}</div>`;
  document.body.appendChild(v);
  hydratePhotos(v);
  const sw = $('.swiper', v);
  requestAnimationFrame(() => { sw.scrollLeft = sw.clientWidth * idx; });
  const layer = { _close: () => v.remove() };
  sheets.push(layer);
  history.pushState({ viewer: true }, '');
  $('.close', v).addEventListener('click', () => closeLayer(layer));
}

/* ═════════════ 백업 ═════════════ */
const blobToDataURL = (b) => new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); });
const dataURLToBlob = async (u) => (await fetch(u)).blob();
async function exportData() {
  toast('백업 파일을 만드는 중… ⏳');
  const photos = await db.all('photos');
  const out = { app: 'dahaerang', version: 1, exportedAt: new Date().toISOString(), profile: S.profile, memories: S.memories, wishes: S.wishes, photos: [] };
  for (const p of photos) out.photos.push({ id: p.id, createdAt: p.createdAt, blob: await blobToDataURL(p.blob), thumb: p.thumb ? await blobToDataURL(p.thumb) : null });
  const name = `다해랑-백업-${todayKey()}.json`;
  const file = new File([JSON.stringify(out)], name, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: '다해랑 백업' }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  toast('백업 파일을 저장했어요 💾');
}
async function importData(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { return toast('백업 파일을 읽지 못했어요'); }
  if (data.app !== 'dahaerang') return toast('다해랑 백업 파일이 아니에요');
  if (!(await confirmDialog({ emoji: '📦', title: '백업을 불러올까요?', text: '같은 기록은 더 최근에 수정된 쪽으로 합쳐져요.', ok: '불러오기' }))) return;
  toast('불러오는 중… ⏳');
  const merge = async (store, list) => {
    for (const r of list || []) {
      const cur = S[store].find((x) => x.id === r.id);
      if (!cur || (r.updatedAt || 0) > (cur.updatedAt || 0)) {
        await db.put(store, r);
        if (cur) Object.assign(cur, r); else S[store].push(r);
      }
    }
  };
  await merge('memories', data.memories);
  await merge('wishes', data.wishes);
  for (const p of data.photos || []) {
    if (await db.get('photos', p.id)) continue;
    await db.put('photos', { id: p.id, createdAt: p.createdAt, blob: await dataURLToBlob(p.blob), thumb: p.thumb ? await dataURLToBlob(p.thumb) : null });
  }
  if (data.profile && (data.profile.updatedAt || 0) > (S.profile.updatedAt || 0)) { S.profile = { ...data.profile, id: 'profile' }; await db.put('meta', S.profile); applyTheme(); }
  toast('불러오기 완료! 💗');
  rerender();
}

/* ═════════════ 테마 ═════════════ */
function applyTheme() {
  const t = S.profile.theme || 'pink';
  document.documentElement.dataset.theme = t;
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  $('meta[name=theme-color]')?.setAttribute('content', bg || '#fff7f5');
}

/* ═════════════ 이벤트 위임 ═════════════ */
const actions = {
  go: (el) => go(el.dataset.to),
  back: () => (history.length > 1 ? history.back() : go('home')),
  plus: () => plusSheet(),
  hearts: (el, e) => { floatHearts(e.clientX, e.clientY); haptic(); },
  'anniv-all': () => annivSheet(),
  'new-memory': (el) => memoryForm(null, { date: el.dataset.date || todayKey() }),
  'new-plan': (el) => wishForm(null, { targetDate: el.dataset.date || toKey(addDays(new Date(), 1)), category: 'date' }),
  'new-wish': () => wishForm(null),
  'edit-wish': (el) => { const w = S.wishes.find((x) => x.id === el.dataset.id); if (w) wishForm(w); },
  'plan-wish': (el) => { const w = S.wishes.find((x) => x.id === el.dataset.id); if (w) wishForm(w); },
  'toggle-wish': (el) => toggleWish(el.dataset.id, el),
  shuffle: () => { const todo = live('wishes').filter((w) => !w.done && w.id !== S.suggestId); if (todo.length) { S.suggestId = todo[Math.floor(Math.random() * todo.length)].id; rerender(); } else toast('다른 위시가 없어요 🙈'); },
  'edit-memory': (el) => { const m = S.memories.find((x) => x.id === el.dataset.id); if (m) memoryForm(m); },
  'del-memory': async (el) => {
    const m = S.memories.find((x) => x.id === el.dataset.id);
    if (m && (await confirmDialog({ title: '이 추억을 지울까요?', text: '사진도 함께 삭제되고 되돌릴 수 없어요.', ok: '삭제', danger: true }))) { await removeRec('memories', m); toast('추억을 삭제했어요'); go('memories'); }
  },
  viewer: (el) => openViewer(el.dataset.id, Number(el.dataset.i)),
  'mem-view': () => { S.memView = S.memView === 'album' ? 'timeline' : 'album'; rerender(); },
  'wish-cat': (el) => { S.wishCat = el.dataset.cat; rerender(); },
  'wish-tab': (el) => { S.wishTab = el.dataset.tab; rerender(); },
  pick: (el) => { S.cal.sel = el.dataset.date; const d = parseKey(el.dataset.date); if (d.getMonth() !== S.cal.m) { S.cal.y = d.getFullYear(); S.cal.m = d.getMonth(); } haptic(5); rerender(); },
  'cal-prev': () => moveMonth(-1),
  'cal-next': () => moveMonth(1),
  'cal-today': () => { const d = new Date(); S.cal = { y: d.getFullYear(), m: d.getMonth(), sel: todayKey() }; rerender(); },
  'toggle-count': async () => { S.profile.countFromOne = S.profile.countFromOne === false; await saveProfile(); rerender(); toast(S.profile.countFromOne ? '사귄 날 = 1일' : '사귄 날 = 0일'); },
  theme: async (el) => { S.profile.theme = el.dataset.theme; await saveProfile(); applyTheme(); rerender(); },
  'edit-anniv': (el) => annivForm((S.profile.custom || []).find((c) => c.id === el.dataset.id)),
  export: () => exportData(),
};
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.closest('.sheet')) return;
  const fn = actions[el.dataset.act];
  if (fn) { e.preventDefault(); fn(el, e); }
});
document.addEventListener('submit', async (e) => {
  const f = e.target;
  if (f.dataset.form === 'quick-wish') {
    e.preventDefault();
    const title = f.elements.title.value.trim();
    if (!title) return wishForm(null);
    await saveRec('wishes', { id: uid(), title, category: S.wishCat !== 'all' ? S.wishCat : 'small', done: false, targetDate: '', note: '' });
    S.wishTab = 'todo';
    haptic();
    toast('위시에 담았어요 ✍️');
    rerender();
    setTimeout(() => $('.quick-add input')?.focus(), 50);
  } else if (f.dataset.form === 'onboard') {
    e.preventDefault();
    const fd = new FormData(f);
    S.profile.me.name = fd.get('me').trim();
    S.profile.her.name = fd.get('her').trim();
    S.profile.startDate = fd.get('start');
    await saveProfile();
    location.hash = '#/home';
    render();
    setTimeout(() => floatHearts(innerWidth / 2, innerHeight / 2), 300);
  }
});
document.addEventListener('change', async (e) => {
  const el = e.target, k = el.dataset.change;
  if (!k) return;
  const who = el.dataset.who ? S.profile[el.dataset.who] : null;
  if (k === 'name') { who.name = el.value.trim() || who.name; await saveProfile(); }
  else if (k === 'birthday') { who.birthday = el.value; await saveProfile(); toast('생일을 저장했어요 🎈'); }
  else if (k === 'start') { if (el.value) { S.profile.startDate = el.value; await saveProfile(); toast('사귄 날을 바꿨어요 💘'); } }
  else if (k === 'avatar') {
    const file = el.files[0]; if (!file) return;
    try {
      const img = await loadImg(file);
      const s = Math.min(img.naturalWidth, img.naturalHeight);
      const c = document.createElement('canvas'); c.width = c.height = 360;
      c.getContext('2d').drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, 360, 360);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.88));
      const rec = { id: uid(), blob, thumb: blob, createdAt: Date.now() };
      await db.put('photos', rec);
      if (who.photoId) await deletePhoto(who.photoId);
      who.photoId = rec.id;
      await saveProfile();
      rerender();
    } catch { toast('사진을 불러오지 못했어요 🥲'); }
  } else if (k === 'import') { const f = el.files[0]; el.value = ''; if (f) await importData(f); }
});
window.addEventListener('hashchange', () => render());

/* ═════════════ 시작 ═════════════ */
async function init() {
  const [profile, memories, wishes] = await Promise.all([db.get('meta', 'profile'), db.all('memories'), db.all('wishes')]);
  S.profile = profile || { id: 'profile', me: { name: '', emoji: '🐻', birthday: '' }, her: { name: '다해', emoji: '🐰', birthday: '' }, startDate: '', countFromOne: true, custom: [], theme: 'pink' };
  S.memories = memories || [];
  S.wishes = wishes || [];
  applyTheme();
  render();
  try { navigator.storage?.persist?.(); } catch {}
  // 날짜가 바뀌면 D-day 갱신
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !sheets.length) rerender(); });
}
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
init();
