// IndexedDB for routes and rides, localStorage for settings.
const DB = 'veloch', ROUTES = 'routes', RIDES = 'rides', PHOTOS = 'photos';
let dbp = null;
function open() {
  return dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open(DB, 3);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains(ROUTES)) d.createObjectStore(ROUTES, { keyPath: 'id' });
      if (!d.objectStoreNames.contains(RIDES)) d.createObjectStore(RIDES, { keyPath: 'id' });
      if (!d.objectStoreNames.contains(PHOTOS)) d.createObjectStore(PHOTOS, { keyPath: 'id' }).createIndex('rideId', 'rideId');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function tx(store, mode, fn) {
  const d = await open();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => res(req?.result);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}
const api = store => ({
  all: () => tx(store, 'readonly', s => s.getAll()),
  get: id => tx(store, 'readonly', s => s.get(id)),
  put: r => tx(store, 'readwrite', s => s.put(r)),
  del: id => tx(store, 'readwrite', s => s.delete(id)),
});
export const routesDB = api(ROUTES);
export const ridesDB = api(RIDES);
export const photosDB = { ...api(PHOTOS), byRide: rideId => tx(PHOTOS, 'readonly', s => s.index('rideId').getAll(rideId)) };
export const settings = {
  get(k, d) { try { const v = localStorage.getItem('veloch:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('veloch:' + k, JSON.stringify(v)); } catch { } },
  del(k) { try { localStorage.removeItem('veloch:' + k); } catch { } },
};
