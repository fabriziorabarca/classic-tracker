// Envoltorio mínimo de IndexedDB. Fuente primaria de datos (offline primero).

const DB_NAME = 'classic-tracker';
const DB_VERSION = 1;
let dbPromise;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('meta', { keyPath: 'key' });
      db.createObjectStore('exercises', { keyPath: 'id' });
      const ses = db.createObjectStore('sessions', { keyPath: 'id' });
      ses.createIndex('date', 'date');
      const sets = db.createObjectStore('sets', { keyPath: 'id' });
      sets.createIndex('session_id', 'session_id');
      sets.createIndex('exercise_id', 'exercise_id');
      db.createObjectStore('body', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name, mode = 'readonly') {
  const db = await openDB();
  return db.transaction(name, mode).objectStore(name);
}

export async function get(name, key) { return reqP((await store(name)).get(key)); }
export async function all(name) { return reqP((await store(name)).getAll()); }
export async function byIndex(name, index, value) {
  return reqP((await store(name)).index(index).getAll(value));
}

export async function put(name, value) {
  const now = new Date().toISOString();
  const v = name === 'meta' || name === 'exercises' ? value : { ...value, updated_at: now, sync_status: 'pending' };
  await reqP((await store(name, 'readwrite')).put(v));
  return v;
}

export async function getMeta(key, fallback = null) {
  const r = await get('meta', key);
  return r ? r.value : fallback;
}
export async function setMeta(key, value) { return put('meta', { key, value }); }

export async function exportAll() {
  const names = ['meta', 'exercises', 'sessions', 'sets', 'body'];
  const out = { app: 'classic-tracker', format: 1, exported_at: new Date().toISOString() };
  for (const n of names) out[n] = await all(n);
  return out;
}

export async function importAll(data) {
  if (data?.app !== 'classic-tracker') throw new Error('El archivo no es un respaldo de esta app.');
  const db = await openDB();
  const names = ['meta', 'exercises', 'sessions', 'sets', 'body'];
  const tx = db.transaction(names, 'readwrite');
  for (const n of names) {
    const s = tx.objectStore(n);
    s.clear();
    for (const row of data[n] ?? []) s.put(row);
  }
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
