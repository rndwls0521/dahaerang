// 다해랑 동기화 (Supabase)
// - 각 폰은 지금처럼 IndexedDB에 먼저 저장하고, 바뀐 기록을 서버에 올려요(outbox).
// - 서버에서 상대가 바꾼 기록을 받아오고(pull), 실시간 알림(realtime)으로도 바로 받아요.
// - 같은 기록을 둘 다 고쳤다면 updatedAt(수정 시각)이 더 최신인 쪽이 이겨요.
import { db } from './db.js';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

const SDK = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/+esm';
const BUCKET = 'photos';
const KIND = { memories: 'memory', wishes: 'wish', meta: 'profile' };

let client = null;
let state = null; // { id:'sync', coupleId, code, cursor, outbox: {key: true}, lastSync }
let hooks = {};
let flushTimer = null;
let flushing = null;
let channel = null;
let status = 'off'; // off | idle | syncing | offline | error | lost

export const isConfigured = () => !!(SUPABASE_URL && SUPABASE_KEY);
export const isLinked = () => !!state?.coupleId;
export const getInfo = () => ({ status, code: state?.code || '', lastSync: state?.lastSync || 0, configured: isConfigured(), linked: isLinked() });

function setStatus(s) { status = s; hooks.onStatus?.(s); }
async function saveState() { if (state) await db.put('meta', state); }

async function getClient() {
  if (client) return client;
  const { createClient } = await import(SDK);
  client = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'dahaerang-auth' },
  });
  return client;
}
async function ensureSession() {
  const c = await getClient();
  const { data } = await c.auth.getSession();
  if (data.session) return data.session;
  const r = await c.auth.signInAnonymously();
  if (r.error) throw r.error;
  return r.data.session;
}

/* ───── 시작 ───── */
export async function init(h) {
  hooks = h;
  state = (await db.get('meta', 'sync')) || null;
  if (!isConfigured() || !isLinked()) { setStatus('off'); return; }
  try {
    const c = await getClient();
    const { data } = await c.auth.getSession();
    if (!data.session) { setStatus('lost'); return; } // 로그인 정보가 지워짐 → 코드로 다시 연결
    await syncNow();
    subscribe();
  } catch (e) { console.warn('sync init', e); setStatus(navigator.onLine ? 'error' : 'offline'); }
  window.addEventListener('online', () => syncNow());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) syncNow(); });
  setInterval(() => { if (!document.hidden) syncNow(); }, 60000);
}

/* ───── 연결 ───── */
export async function createCouple() {
  await ensureSession();
  const { data, error } = await client.rpc('create_couple');
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  state = { id: 'sync', coupleId: row.couple_id, code: row.code, cursor: 0, outbox: {}, lastSync: 0 };
  await queueAllLocal();
  await saveState();
  await syncNow();
  subscribe();
  return row.code;
}
export async function joinCouple(code, { preferRemoteProfile = true } = {}) {
  await ensureSession();
  const { data, error } = await client.rpc('join_couple', { p_code: code });
  if (error) throw new Error(/invalid code/.test(error.message) ? '코드가 맞지 않아요' : error.message);
  const row = Array.isArray(data) ? data[0] : data;
  state = { id: 'sync', coupleId: row.couple_id, code: row.code, cursor: 0, outbox: {}, lastSync: 0 };
  await saveState();
  // 먼저 상대 기록을 전부 받고(프로필은 상대 것 우선), 그다음 내 기록을 합쳐서 올려요.
  await pull({ forceProfile: preferRemoteProfile });
  await queueAllLocal({ skipProfile: preferRemoteProfile });
  await saveState();
  await syncNow();
  subscribe();
  return row.code;
}
export async function unlink() {
  try { channel && (await client.removeChannel(channel)); } catch {}
  channel = null;
  try { await client?.auth.signOut(); } catch {}
  await db.del('meta', 'sync');
  state = null;
  setStatus('off');
}

/* ───── 올리기 ───── */
export function markDirty(store, id) {
  if (!isLinked() || !KIND[store]) return;
  state.outbox[`${store}:${id}`] = true;
  saveState();
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => flush(), 700);
}
async function queueAllLocal({ skipProfile = false } = {}) {
  for (const store of ['memories', 'wishes']) for (const r of await db.all(store)) state.outbox[`${store}:${r.id}`] = true;
  if (!skipProfile) state.outbox['meta:profile'] = true;
}

async function uploadPhoto(pid) {
  const rec = await db.get('photos', pid);
  if (!rec || rec.synced) return;
  const base = `${state.coupleId}/${pid}`;
  const put = async (path, blob) => {
    if (!blob) return;
    const { error } = await client.storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg', upsert: false });
    if (error && !/exists|Duplicate|409/i.test(error.message + (error.statusCode || ''))) throw error;
  };
  await put(`${base}.jpg`, rec.blob);
  await put(`${base}_t.jpg`, rec.thumb);
  rec.synced = true;
  await db.put('photos', rec);
}

export async function flush() {
  if (!isLinked() || !navigator.onLine) return;
  if (flushing) return flushing;
  flushing = (async () => {
    const keys = Object.keys(state.outbox);
    if (!keys.length) return;
    await ensureSession();
    const items = [], sent = {};
    for (const key of keys) {
      const [store, id] = key.split(/:(.*)/s);
      const rec = await db.get(store, id);
      if (!rec) { delete state.outbox[key]; continue; }
      const photoIds = store === 'meta' ? [rec.me?.photoId, rec.her?.photoId] : rec.photoIds || [];
      for (const pid of photoIds) if (pid) await uploadPhoto(pid);
      const data = { ...rec };
      if (store === 'meta') { delete data.lastBackup; data.id = 'profile'; }
      items.push({ id: store === 'meta' ? 'profile' : id, kind: KIND[store], data, updated_at: rec.updatedAt || 0, deleted: !!rec.deleted });
      sent[key] = rec.updatedAt || 0;
    }
    for (let i = 0; i < items.length; i += 50) {
      const { error } = await client.rpc('push_records', { p_couple: state.coupleId, p_items: items.slice(i, i + 50) });
      if (error) throw error;
    }
    // 보내는 사이에 또 바뀐 건 남겨두기
    for (const key of Object.keys(sent)) {
      const [store, id] = key.split(/:(.*)/s);
      const now = await db.get(store, id);
      if (!now || (now.updatedAt || 0) === sent[key]) delete state.outbox[key];
    }
    await saveState();
  })().finally(() => { flushing = null; });
  return flushing;
}

/* ───── 받기 ───── */
async function pull({ forceProfile = false } = {}) {
  let changed = false;
  for (;;) {
    const { data, error } = await client.from('records').select('id,kind,data,updated_at,deleted,seq')
      .eq('couple_id', state.coupleId).gt('seq', Math.max(0, (state.cursor || 0) - 20)).order('seq').limit(500);
    if (error) throw error;
    if (!data.length) break;
    if (await hooks.applyRemote(data, { forceProfile })) changed = true;
    const max = data[data.length - 1].seq;
    if (max <= (state.cursor || 0)) break;
    state.cursor = max;
    if (data.length < 500) break;
  }
  return changed;
}

export async function syncNow() {
  if (!isLinked()) return;
  if (!navigator.onLine) { setStatus('offline'); return; }
  try {
    setStatus('syncing');
    await ensureSession();
    await flush();
    await pull();
    state.lastSync = Date.now();
    await saveState();
    setStatus('idle');
  } catch (e) {
    console.warn('sync', e);
    setStatus(navigator.onLine ? 'error' : 'offline');
  }
}

function subscribe() {
  if (!client || channel || !isLinked()) return;
  channel = client.channel(`records-${state.coupleId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'records', filter: `couple_id=eq.${state.coupleId}` }, (p) => {
      if (p.new && p.new.id) hooks.applyRemote([p.new], {});
    })
    .subscribe();
}

/* ───── 사진 ───── */
export async function downloadPhoto(pid, full) {
  if (!isLinked() || !navigator.onLine) return null;
  try {
    await ensureSession();
    const { data, error } = await client.storage.from(BUCKET).download(`${state.coupleId}/${pid}${full ? '' : '_t'}.jpg`);
    if (error) return null;
    return data;
  } catch { return null; }
}
export async function deleteRemotePhoto(pid) {
  if (!isLinked() || !navigator.onLine) return;
  try {
    await ensureSession();
    await client.storage.from(BUCKET).remove([`${state.coupleId}/${pid}.jpg`, `${state.coupleId}/${pid}_t.jpg`]);
  } catch {}
}
