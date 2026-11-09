/* Elite Pool Service PR — PWA (sin dependencias). Estado local en IndexedDB, funciona offline. */
'use strict';

const APP_VERSION = 'v38 · Propuestas comerciales';
const API_URL = null; // pon aquí la URL de tu backend para sincronizar de verdad (ver README)
const COL = { water: '#0284c7', ok: '#10b981', warn: '#f59e0b', bad: '#ef4444', pending: '#94a3b8' };
const TABS = [['routes', '📍', 'Rutas'], ['clients', '👥', 'Clientes'], ['chem', '🧪', 'Químicos'], ['orders', '📋', 'Órdenes'], ['shop', '🛒', 'Compras'], ['invoices', '🧾', 'Facturas'], ['msg', '⚙️', 'Mensajes']];

const S = { lock: null, db: null, queue: [], lastSync: null, settings: mergeSettings(null), demoPurged: false, lastBackup: null };
const UI = {
  tab: 'routes', view: null, q: '', clientFilter: 'ACTIVE', orderFilter: 'ALL', shop: { status: 'ALL', tech: 'ALL', client: 'ALL' },
  invFilter: 'ALL', chem: { clientId: '', wbId: '', gal: '', n: 0 }, drafts: {}, form: null, dispatch: null, simOffline: false,
  installEvt: null, syncing: false, msg: { tpl: 'feriado', area: 'ALL', subject: null, body: null, sent: {} },
};
const T = (k) => S.db[k];
/** Nombres del equipo (editables en Ajustes → Equipo de trabajo), separados por coma. */
const techList = () => (S.settings.biz.team || '').split(',').map((x) => x.trim()).filter(Boolean);
const find = (t, id) => S.db[t].find((r) => r.id === id);
const $ = (s) => document.querySelector(s);
const online = () => navigator.onLine && !UI.simOffline;

/* ---------- almacenamiento (IndexedDB) ---------- */
const idb = () => new Promise((res, rej) => { const r = indexedDB.open('epspr', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const idbGet = async (k) => { const d = await idb(); return new Promise((res) => { const q = d.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); }); };
const idbSet = async (k, v) => { const d = await idb(); return new Promise((res) => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => res(); t.onerror = () => res(); }); };
let persistTimer = null;
const persist = () => { clearTimeout(persistTimer); persistTimer = setTimeout(() => idbSet('state', { db: S.db, queue: S.queue, lastSync: S.lastSync, settings: S.settings, demoPurged: S.demoPurged, lastBackup: S.lastBackup, lock: S.lock }).catch(() => {}), 300); };

/* ---------- mutaciones + cola de sincronización ---------- */
let renderQueued = false;
const scheduleRender = () => { if (renderQueued) return; renderQueued = true; requestAnimationFrame(() => { renderQueued = false; render(); }); };
function changed() { persist(); scheduleRender(); maybeSync(); }
const enqueue = (op) => S.queue.push({ id: uid('op'), ts: new Date().toISOString(), ...op });
function upsert(table, row) {
  const list = S.db[table], i = list.findIndex((r) => r.id === row.id);
  const prev = i >= 0 ? list[i] : null;
  if (i >= 0) list[i] = row; else list.push(row);
  if (table === 'properties' && prev && JSON.stringify([prev.service_days, prev.dates]) !== JSON.stringify([row.service_days, row.dates])) setTimeout(() => syncRoutes(row), 0);
  enqueue({ table, op: 'upsert', rowId: row.id, payload: table === 'photos' ? { ...row, uri: '[local]' } : (table === 'properties' && row.photo ? { ...row, photo: { ...row.photo, uri: '[local]' } } : row) });
  changed();
}
function remove(table, id) { S.db[table] = S.db[table].filter((r) => r.id !== id); enqueue({ table, op: 'delete', rowId: id }); changed(); }
function removeClient(id) {
  const db = S.db, props = db.properties.filter((p) => p.client_id === id).map((p) => p.id);
  const wbs = db.waterBodies.filter((w) => props.includes(w.property_id)).map((w) => w.id);
  const stops = db.stops.filter((s) => props.includes(s.property_id)).map((s) => s.id);
  const wos = db.workOrders.filter((w) => w.client_id === id).map((w) => w.id);
  db.clients = db.clients.filter((c) => c.id !== id);
  db.properties = db.properties.filter((p) => !props.includes(p.id));
  db.waterBodies = db.waterBodies.filter((w) => !wbs.includes(w.id));
  db.equipment = db.equipment.filter((e) => !wbs.includes(e.water_body_id));
  db.stops = db.stops.filter((s) => !stops.includes(s.id));
  db.readings = db.readings.filter((r) => !wbs.includes(r.water_body_id));
  db.dosages = db.dosages.filter((d) => !stops.includes(d.stop_id));
  db.workOrders = db.workOrders.filter((w) => w.client_id !== id);
  db.shoppingItems = db.shoppingItems.filter((i) => i.client_id !== id);
  db.invoices = db.invoices.filter((i) => i.client_id !== id);
  db.payments = (db.payments || []).filter((p) => p.client_id !== id);
  db.quotes = db.quotes.filter((q) => q.client_id !== id);
  db.dispatchLog = db.dispatchLog.filter((l) => l.client_id !== id);
  db.photos = db.photos.filter((p) => !stops.includes(p.owner_id) && !wos.includes(p.owner_id));
  enqueue({ table: 'clients', op: 'delete', rowId: id, cascade: true });
  changed();
}

/** Quita los clientes de ejemplo que traían las versiones anteriores (ids c1–c6 con correo example.com) y todo lo suyo. */
function purgeDemo() {
  const ids = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].filter((id) => { const c = find('clients', id); return c && /example\.com$/i.test(c.email || ''); });
  if (!ids.length) return;
  const props = S.db.properties.filter((p) => ids.includes(p.client_id)).map((p) => p.id);
  const routeIds = [...new Set(S.db.stops.filter((s) => props.includes(s.property_id)).map((s) => s.route_id))];
  ids.forEach(removeClient);
  S.db.routes = S.db.routes.filter((r) => !routeIds.includes(r.id) || S.db.stops.some((s) => s.route_id === r.id));
  S.queue = [];
}

let syncTimer = null;
function maybeSync() { if (online() && S.queue.length && !UI.syncing && !syncTimer) syncTimer = setTimeout(() => { syncTimer = null; syncNow(); }, 1200); }
async function syncNow() {
  if (UI.syncing || !online()) return;
  UI.syncing = true; scheduleRender();
  try {
    const ops = S.queue.slice();
    if (API_URL) {
      const res = await fetch(`${API_URL}/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ops }) });
      if (!res.ok) throw new Error(res.status);
      const { acked } = await res.json();
      S.queue = S.queue.filter((o) => !acked.includes(o.id));
    } else {
      await new Promise((r) => setTimeout(r, 600)); // nube simulada
      const sent = new Set(ops.map((o) => o.id));
      S.queue = S.queue.filter((o) => !sent.has(o.id));
    }
    S.lastSync = new Date().toISOString();
  } catch (e) { /* se reintenta al volver la señal */ }
  UI.syncing = false; persist(); scheduleRender();
}

/* ---------- helpers de HTML ---------- */
const dat = (o) => Object.entries(o).map(([k, v]) => ` data-${k}="${esc(v)}"`).join('');
const chip = (label, on, act, data = {}, color) => `<button class="chip${on ? ' on' : ''}" data-act="${act}"${dat(data)}${color ? ` style="--c:${color}"` : ''}>${esc(label)}</button>`;
const btn = (label, act, data = {}, cls = '') => `<button class="btn ${cls}" data-act="${act}"${dat(data)}>${label}</button>`;
const badge = (l, c) => `<span class="badge" style="--c:${c}">${esc(l)}</span>`;
const seg = (value, opts, act, data = {}) => `<div class="seg">${opts.map(([v, l]) => `<button class="${v === value ? 'on' : ''}" data-act="${act}" data-v="${esc(v)}"${dat(data)}>${esc(l)}</button>`).join('')}</div>`;
const empty = (t) => `<div class="empty">${esc(t)}</div>`;
const muted = (t, cls = '') => `<div class="muted ${cls}">${t}</div>`;
const fld = (label, inner) => `<div class="fld"><label>${esc(label)}</label>${inner}</div>`;
const input = (id, val = '', extra = '') => `<input id="${id}" value="${esc(val)}" ${extra}>`;
const clientName = (id) => (find('clients', id) || {}).name || '—';
const activeClients = () => T('clients').filter((c) => c.status === 'ACTIVE');
const optList = (items, sel) => items.map(([v, l]) => `<option value="${esc(v)}"${v === sel ? ' selected' : ''}>${esc(l)}</option>`).join('');
const CHANNELS = [['WHATSAPP', 'WhatsApp'], ['EMAIL', 'Email'], ['BOTH', 'Ambos']];
const FORMATS = [['PDF', 'Solo PDF'], ['TEXT', 'Solo texto'], ['BOTH', 'PDF + Texto']];
const prefText = (c) => `${{ BOTH: 'WhatsApp + Email', WHATSAPP: 'WhatsApp', EMAIL: 'Email' }[c.dispatch_channel_pref]} · ${{ BOTH: 'PDF + Texto', PDF: 'Solo PDF', TEXT: 'Solo texto' }[c.dispatch_format_pref]}`;

function toast(msg) {
  const el = document.createElement('div'); el.className = 'toast'; el.textContent = msg; document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

/* =====================================================================
   1. RUTAS
   ===================================================================== */
const ST_COLOR = { PENDING: COL.pending, IN_PROGRESS: COL.warn, DONE: COL.ok };
const ST_LABEL = { PENDING: 'Pendiente', IN_PROGRESS: 'En progreso', DONE: 'Completada' };
const DAYS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const DAYS_S = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const routeDate = () => UI.routeDate || todayISO();
const dow = (iso) => new Date(iso + 'T12:00:00').getDay();
const curRoute = () => T('routes').find((r) => r.date === routeDate() && r.technician_id === ME);
const activeProps = () => { const ids = new Set(activeClients().map((c) => c.id)); return T('properties').filter((p) => ids.has(p.client_id)); };
/** Los días de servicio son POR PROPIEDAD. */
/** Pausa: {from, until, reason}. `until` = fecha en que se REANUDA el servicio (null = hasta nuevo aviso). */
const pauseHit = (pz, iso) => !!(pz && (!pz.from || iso >= pz.from) && (!pz.until || iso < pz.until));
const isPaused = (p, iso) => pauseHit(p.pause, iso) || pauseHit((find('clients', p.client_id) || {}).pause, iso);
const pauseLabel = (pz) => `⏸ En pausa${pz.from && pz.from > todayISO() ? ' desde el ' + fmtDate(pz.from) : ''} · ${pz.until ? 'reanuda el ' + fmtDate(pz.until) : 'hasta nuevo aviso'}${pz.reason ? ' · ' + pz.reason : ''}`;
const pauseActive = (pz) => !!(pz && (!pz.until || pz.until > todayISO()));
const scheduledProps = (iso) => activeProps().filter((p) => isSched(p, iso) && !isPaused(p, iso) && !(p.skip_dates || []).includes(iso));
const daysText = (o) => (o && o.service_days && o.service_days.length ? [...o.service_days].sort().map((d) => DAYS_S[d]).join(', ') : 'sin días asignados');
const clientDaysText = (c) => { const u = new Set(); T('properties').filter((p) => p.client_id === c.id).forEach((p) => (p.service_days || []).forEach((d) => u.add(d))); return u.size ? [...u].sort().map((d) => DAYS_S[d]).join(', ') : 'sin días asignados'; };
/** Datos viejos: los días que estaban en el cliente pasan a cada una de sus propiedades (una sola vez). */
function migrateDb(db) {
  TABLES.forEach((t) => { if (!Array.isArray(db[t])) db[t] = []; });
  db.properties.forEach((p) => {
    if (!Array.isArray(p.dates)) p.dates = [];
    if (!Array.isArray(p.service_days)) { const c = db.clients.find((x) => x.id === p.client_id); p.service_days = c && Array.isArray(c.service_days) ? [...c.service_days] : []; }
  });
  return db;
}

const isSched = (p, iso) => (p.service_days || []).includes(dow(iso)) || (p.dates || []).some((x) => x.d === iso);
/** Si cambias los días de una propiedad, quita sus paradas PENDIENTES (hoy o futuras) de las rutas de días que ya no le tocan.
 *  No toca paradas hechas, en progreso, ni las que moviste/añadiste a mano (manual). */
function syncRoutes(p) {
  const today = todayISO(); let n = 0;
  T('routes').filter((r) => r.technician_id === ME && r.date >= today).forEach((r) => {
    T('stops').filter((s) => s.route_id === r.id && s.property_id === p.id && s.status === 'PENDING' && !s.manual && (!isSched(p, r.date) || isPaused(p, r.date))).forEach((s) => { remove('stops', s.id); n++; });
    if (!T('stops').some((s) => s.route_id === r.id)) remove('routes', r.id);
  });
  if (n) toast(`Se quitó de ${n} ruta(s) el día que ya no le toca o está en pausa`);
}
/** Recuerda que quitaste/moviste esta parada ese día, para que la ruta automática no la vuelva a poner. */
function skipStop(s) {
  const r = find('routes', s.route_id), p = find('properties', s.property_id);
  if (!r || !p || s.manual || !isSched(p, r.date) || (p.skip_dates || []).includes(r.date)) return;
  const keep = (p.skip_dates || []).filter((d) => d >= addDays(todayISO(), -30));
  upsert('properties', { ...p, skip_dates: [...keep, r.date] });
}
/** Rutas automáticas: crea/completa la ruta de cada día de hoy en adelante según los días de servicio de las propiedades. */
function autoRoutes(dates) {
  const today = todayISO(), max = addDays(today, 60);
  dates.filter((d) => d >= today && d <= max).forEach((date) => {
    const sched = scheduledProps(date); if (!sched.length) return;
    let r = T('routes').find((x) => x.date === date && x.technician_id === ME);
    if (!r) { r = { id: uid('r'), date, technician_id: ME, status: 'PLANNED' }; upsert('routes', r); }
    const have = new Set(T('stops').filter((s) => s.route_id === r.id).map((s) => s.property_id));
    const add = sched.filter((p) => !have.has(p.id));
    if (add.length) addStopsFor(r.id, add, T('stops').filter((s) => s.route_id === r.id).length);
  });
}
/** Mueve paradas PENDIENTES a la ruta de otra fecha (la crea si no existe). */
function moveStops(ids, to) {
  let route = T('routes').find((r) => r.date === to && r.technician_id === ME);
  if (!route) { route = { id: uid('r'), date: to, technician_id: ME, status: 'PLANNED' }; upsert('routes', route); }
  let moved = 0, dup = 0, next = routeStops(route).length;
  ids.map((id) => find('stops', id)).filter((s) => s && s.status === 'PENDING').forEach((s) => {
    const from = s.route_id;
    if (from === route.id) return;
    skipStop(s);
    if (T('stops').some((x) => x.route_id === route.id && x.property_id === s.property_id)) { remove('stops', s.id); dup++; }
    else { upsert('stops', { ...s, route_id: route.id, order_index: next++, manual: true }); moved++; }
    if (!T('stops').some((x) => x.route_id === from)) remove('routes', from);
  });
  return { moved, dup };
}
const stepDays = (iso) => `${DAYS_S[dow(iso)]} ${+iso.slice(8)}`;
function moveSheet(ids) {
  const today = todayISO(), list = ids.map((id) => find('stops', id)).filter((s) => s && s.status === 'PENDING');
  if (!list.length) return toast('No hay paradas pendientes para mover');
  const opts = [1, 2, 3].map((k) => addDays(today, k)), who = list.length === 1 ? (() => { const p = find('properties', list[0].property_id); return p ? p.address : 'parada'; })() : `${list.length} paradas pendientes`;
  let nextSvc = '';
  if (list.length === 1) { const p = find('properties', list[0].property_id); for (let k = 1; k <= 14 && p; k++) { const d = addDays(today, k); if (isSched(p, d)) { nextSvc = d; break; } } }
  const idsAttr = list.map((s) => s.id).join(',');
  openSheet('Pasar a otro día', `${muted('Mover: ' + esc(who))}<div class="btns mt-s" style="flex-direction:column;align-items:stretch">${opts.map((d, i) => btn(`${['Mañana', 'Pasado mañana', 'En 3 días'][i]} · ${stepDays(d)}`, 'doMove', { ids: idsAttr, to: d }, 'ghost')).join('')}${nextSvc ? btn(`Su próximo día de servicio · ${stepDays(nextSvc)}`, 'doMove', { ids: idsAttr, to: nextSvc }, 'ghost') : ''}</div><div class="fld mt"><label>O escoge una fecha</label><input type="date" id="mv_date" min="${today}"></div>${btn('Mover a esa fecha', 'doMoveDate', { ids: idsAttr })}${muted('Solo se cambia ese día. Los días de servicio de la propiedad no se modifican.', 'mt-s')}`);
}
function carryHtml() {
  const today = todayISO(), old = T('routes').filter((r) => r.technician_id === ME && r.date < today && r.date >= addDays(today, -14)).map((r) => r.id);
  const miss = T('stops').filter((s) => old.includes(s.route_id) && s.status === 'PENDING');
  if (!miss.length) return '';
  const ids = miss.map((s) => s.id).join(',');
  return `<div class="card" style="border-left:6px solid ${COL.warn || '#f59e0b'}"><b>⚠️ ${miss.length} parada(s) sin hacer de días anteriores</b>${muted(esc(miss.map((s) => { const p = find('properties', s.property_id); return p ? p.address : ''; }).filter(Boolean).slice(0, 6).join(' · ')) + (miss.length > 6 ? ' …' : ''))}<div class="btns mt-s">${btn('Pasarlas a hoy', 'doMove', { ids, to: today })}${btn('Otro día', 'moveSheet', { ids }, 'ghost')}${btn('Descartar', 'dropStops', { ids }, 'sm ghost')}</div></div>`;
}
function addStopsFor(rid, propList, offset) {
  const have = new Set(T('stops').filter((s) => s.route_id === rid).map((s) => s.property_id));
  const props = propList.filter((p) => !have.has(p.id));
  const draft = props.map((p) => ({ id: uid('s'), route_id: rid, property_id: p.id, order_index: 0, check_in_time: null, check_out_time: null, check_in_lat: null, check_in_lng: null, status: 'PENDING', manual: !isSched(p, (find('routes', rid) || {}).date || ''), checklist: [], active_water_body_ids: T('waterBodies').filter((w) => w.property_id === p.id).slice(0, 1).map((w) => w.id) }));
  const order = optimizeOrder(draft, T('properties'));
  draft.forEach((s) => upsert('stops', { ...s, order_index: offset + order.indexOf(s.id), checklist: mkChecklist(s.id) }));
  return draft.length;
}
function weekStrip() {
  const d = routeDate(), start = addDays(d, -dow(d));
  const chips = Array.from({ length: 7 }, (_, i) => {
    const iso = addDays(start, i), has = T('routes').some((r) => r.date === iso && r.technician_id === ME);
    return chip(`${DAYS_S[i]} ${+iso.slice(8)}${has ? ' •' : ''}`, iso === d, 'setRouteDate', { v: iso });
  }).join('');
  return `<div class="chips">${chips}</div><div class="btns" style="margin:0 0 12px">${btn('‹ Semana', 'setRouteDate', { v: addDays(d, -7) }, 'sm ghost')}${btn('Hoy', 'setRouteDate', { v: todayISO() }, 'sm ghost')}${btn('Semana ›', 'setRouteDate', { v: addDays(d, 7) }, 'sm ghost')}</div>`;
}
const routeStops = (r) => (r ? T('stops').filter((s) => s.route_id === r.id).sort((a, b) => a.order_index - b.order_index) : []);

const mapPoints = (stops) => stops.map((s) => ({ s, p: find('properties', s.property_id) })).filter((x) => x.p);
const mapHtml = (stops) => (mapPoints(stops).length
  ? '<div class="map" id="map"><div class="layers"><div class="tiles"></div><div class="mk"></div></div><div class="cap">Sin internet: se muestran solo las paradas</div><div class="zc"><button type="button" data-zoom="1" aria-label="Acercar">+</button><button type="button" data-zoom="-1" aria-label="Alejar">−</button></div><div class="attr">© OpenStreetMap</div></div>'
  : '');

/* ---- mapa con mosaicos OpenStreetMap (sin librerías) ---- */
const TILE = 256;
const mercX = (lng, z) => ((lng + 180) / 360) * TILE * 2 ** z;
const mercY = (lat, z) => { const s = Math.sin((lat * Math.PI) / 180); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE * 2 ** z; };
const unX = (x, z) => (x / (TILE * 2 ** z)) * 360 - 180;
const unY = (y, z) => { const n = Math.PI - (2 * Math.PI * y) / (TILE * 2 ** z); return (180 / Math.PI) * Math.atan(Math.sinh(n)); };
function fitView(pts, w, h) {
  const lats = pts.map((x) => x.p.lat), lngs = pts.map((x) => x.p.lng);
  const [la0, la1, ln0, ln1] = [Math.min(...lats), Math.max(...lats), Math.min(...lngs), Math.max(...lngs)];
  let z = 17;
  for (; z > 3; z--) if (mercX(ln1, z) - mercX(ln0, z) <= w - 80 && mercY(la0, z) - mercY(la1, z) <= h - 80) break;
  return { z, lat: unY((mercY(la0, z) + mercY(la1, z)) / 2, z), lng: unX((mercX(ln0, z) + mercX(ln1, z)) / 2, z) };
}
function initMap() {
  if (UI.mapCleanup) { UI.mapCleanup(); UI.mapCleanup = null; }
  const el = document.getElementById('map');
  if (!el) return;
  const pts = mapPoints(routeStops(curRoute()));
  const w = el.clientWidth, h = el.clientHeight;
  if (!pts.length || !w) return;
  const key = pts.map((x) => x.p.id).join();
  if (!UI.map || UI.map.key !== key) UI.map = { key, ...fitView(pts, w, h) };
  const m = UI.map, layers = el.querySelector('.layers'), tiles = el.querySelector('.tiles'), mk = el.querySelector('.mk');
  const draw = () => {
    const cx = mercX(m.lng, m.z), cy = mercY(m.lat, m.z), left = cx - w / 2, top = cy - h / 2, n = 2 ** m.z;
    let t = '';
    for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + h) / TILE); ty++) {
      if (ty < 0 || ty >= n) continue;
      for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + w) / TILE); tx++) {
        t += `<img class="tile" alt="" draggable="false" src="https://tile.openstreetmap.org/${m.z}/${((tx % n) + n) % n}/${ty}.png" style="left:${Math.round(tx * TILE - left)}px;top:${Math.round(ty * TILE - top)}px" onerror="this.parentNode.parentNode.parentNode.classList.add('notiles');this.remove()" onload="this.parentNode.parentNode.parentNode.classList.remove('notiles')">`;
      }
    }
    tiles.innerHTML = t;
    mk.innerHTML = pts.map(({ s, p }) => `<div class="dot" data-act="openStop" data-id="${s.id}" style="left:${(mercX(p.lng, m.z) - left).toFixed(1)}px;top:${(mercY(p.lat, m.z) - top).toFixed(1)}px;background:${ST_COLOR[s.status]}">${s.order_index + 1}</div>`).join('');
  };
  draw();
  let drag = false, moved = false, sx = 0, sy = 0;
  const move = (e) => {
    if (!drag) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (Math.abs(dx) + Math.abs(dy) > 6) moved = true;
    if (moved) layers.style.transform = `translate(${dx}px,${dy}px)`;
  };
  const up = (e) => {
    if (!drag) return;
    drag = false;
    if (!moved) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    m.lng = unX(mercX(m.lng, m.z) - dx, m.z);
    m.lat = unY(mercY(m.lat, m.z) - dy, m.z);
    layers.style.transform = '';
    draw();
    setTimeout(() => { moved = false; }, 0);
  };
  el.addEventListener('pointerdown', (e) => { if (e.target.closest('button')) return; drag = true; moved = false; sx = e.clientX; sy = e.clientY; });
  el.addEventListener('click', (e) => { if (moved) { e.stopPropagation(); e.preventDefault(); } }, true);
  el.querySelectorAll('[data-zoom]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); m.z = Math.max(3, Math.min(18, m.z + +b.dataset.zoom)); draw(); }));
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  UI.mapCleanup = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
}

function pausedNote(date) {
  const ps = activeProps().filter((p) => (p.service_days || []).includes(dow(date)) || (p.dates || []).some((x) => x.d === date)).filter((p) => isPaused(p, date));
  return ps.length ? muted('⏸ En pausa ese día: ' + esc(ps.map((p) => clientName(p.client_id) + ' — ' + p.address).join(' · ')), 'mt-s') : '';
}
function routesTab() {
  const wk = addDays(routeDate(), -dow(routeDate()));
  autoRoutes(Array.from({ length: 7 }, (_, i) => addDays(wk, i)).concat([routeDate()]));
  const date = routeDate(), isToday = date === todayISO(), dn = DAYS[dow(date)];
  const route = curRoute(), stops = routeStops(route), done = stops.filter((s) => s.status === 'DONE').length;
  const title = isToday ? 'Ruta de hoy' : `Ruta del ${dn}`;
  const sub = `${dn} ${fmtDate(date)}${route ? ` · ${done} de ${stops.length} completadas` : ''}`;
  const right = UI.installEvt ? btn('📲 Instalar', 'install', {}, 'sm') : '';
  if (!route) {
    const sched = scheduledProps(date);
    return { title, sub, right, body: backupBanner() + (isToday ? carryHtml() : '') + weekStrip() + `<div class="card">${sched.length
      ? `<b>${sched.length} propiedad(es) programadas el ${dn}</b>${muted(esc(sched.map((p) => clientName(p.client_id) + ' — ' + p.address).join(' · ')))}<div class="mt"></div>${btn('Crear ruta del ' + dn, 'createRoute', { all: '0' })}`
      : empty(`No hay servicios programados el ${dn}. Las rutas se arman solas según los días de servicio de cada propiedad (pestaña Clientes).`)}${pausedNote(date)}<div class="mt-s"></div>${btn('Crear ruta con todas las propiedades activas', 'createRoute', { all: '1' }, 'ghost')}</div>` };
  }
  const pending = stops.filter((s) => s.status !== 'DONE').map((s) => find('properties', s.property_id)).filter(Boolean);
  const url = routeUrl(pending);
  const inRoute = new Set(stops.map((s) => s.property_id));
  const missing = scheduledProps(date).filter((p) => !inRoute.has(p.id));
  let h = backupBanner() + (isToday ? carryHtml() : '') + weekStrip() + `<div class="progress"><i style="width:${stops.length ? (done / stops.length) * 100 : 0}%"></i></div>${mapHtml(stops)}`;
  h += `<div class="btns" style="margin:0 0 12px">${btn('↕ Optimizar ruta', 'optimize', {}, 'sm ghost')}${url ? `<a class="btn sm ghost" href="${esc(url)}" target="_blank" rel="noopener">🗺 Abrir en Mapas</a>` : ''}${stops.some((s) => s.status === 'PENDING') ? btn('↪ Pasar pendientes a otro día', 'moveSheet', { ids: stops.filter((s) => s.status === 'PENDING').map((s) => s.id).join(',') }, 'sm ghost') : ''}</div>`;
  h += pausedNote(date) ? `<div class="mb">${pausedNote(date)}</div>` : '';
  if (missing.length) h += `<div class="mb">${btn(`+ Añadir ${missing.length} propiedad(es) programadas que faltan`, 'addMissing', {}, 'ghost')}</div>`;
  h += '<div class="cols">' + stops.map((s) => {
    const p = find('properties', s.property_id), c = p && find('clients', p.client_id);
    if (!p || !c) return '';
    const actions = s.status === 'PENDING' ? `<div class="btns">${btn('▶ Iniciar parada', 'startStop', { id: s.id })}${btn('↪ Otro día', 'moveSheet', { ids: s.id }, 'ghost')}</div>`
      : s.status === 'IN_PROGRESS' ? `<div class="btns">${btn('Abrir', 'openStop', { id: s.id }, 'ghost')}${btn('✓ Completar', 'completeStop', { id: s.id, send: '0' }, 'ok')}</div>`
      : btn('📤 Enviar informe', 'sendStop', { id: s.id }, 'sm ghost');
    return `<div class="card bar tap" style="border-left-color:${ST_COLOR[s.status]}" data-act="openStop" data-id="${s.id}">
      <div class="row"><div class="dot" style="position:static;margin:0;background:${ST_COLOR[s.status]}">${s.order_index + 1}</div>
      <div class="grow"><b>${esc(c.name)}</b>${muted(esc(p.address + ', ' + p.municipality))}${muted('Días: ' + esc(propDaysText(p)))}${(dateEntry(p, routeDate()) || {}).t ? `<div class="stamp" style="font-weight:700;color:${COL.water}">🕒 Servicio a las ${fmtHM(dateEntry(p, routeDate()).t)}</div>` : ''}</div>${badge(ST_LABEL[s.status], ST_COLOR[s.status])}</div>
      ${s.check_in_time ? muted(`Entrada ${fmtTime(s.check_in_time)}${s.check_out_time ? ' · Salida ' + fmtTime(s.check_out_time) : ''}`, 'mt-s') : ''}
      <div class="mt">${actions}</div></div>`;
  }).join('') + '</div>';
  return { title, sub, right, body: h };
}

/* --- lecturas (compartido con pestaña Químicos) --- */
const draftOf = (key, r) => (UI.drafts[key] ||= Object.fromEntries(PARAMS.map((p) => [p.key, r && r[p.key] != null ? String(r[p.key]) : ''])));
const numOf = (s) => (s === '' || s == null ? null : toNum(s));
const numTargets = () => Object.fromEntries(Object.keys(DEFAULT_TARGETS).map((k) => [k, toNum(S.settings.targets[k])]).filter(([, v]) => v != null));
function chemOpts(wbId) {
  const w = wbId && find('waterBodies', wbId), p = w && find('properties', w.property_id);
  return { prefs: chemPrefs(S.settings.chem, p && p.chem), targets: numTargets() };
}
function doseHtml(doses, applyBtn) {
  return doses.map((d, i) => `<div class="it"><div class="grow"><b>${esc(d.chemical_name)}</b>${d.amount == null ? '' : `<div class="amt">${d.amount} ${d.unit}</div>`}${muted(esc(d.reason))}</div>${d.amount == null ? '' : applyBtn(d, i)}</div>`).join('');
}
function sugHtml(key, gal, vals, ctx, wbId) {
  const nums = Object.fromEntries(PARAMS.map((p) => [p.key, numOf(vals[p.key])]));
  const doses = suggestDoses(nums, gal, chemOpts(wbId || (ctx && ctx.wb)));
  if (!doses.length) return '';
  const applied = ctx ? T('dosages').filter((d) => d.stop_id === ctx.stop && d.water_body_id === ctx.wb).map((d) => d.chemical_name) : [];
  return `<div class="card dose"><b>Dosis sugerida (${gal.toLocaleString('es-PR')} gal)</b>${doseHtml(doses, (d, i) => (ctx ? btn(applied.includes(d.chemical_name) ? '✓ Aplicado' : 'Aplicar', 'applyDose', { key, i, stop: ctx.stop, wb: ctx.wb }, 'sm ' + (applied.includes(d.chemical_name) ? 'ok' : 'ghost')) : ''))}
    ${muted('Estimado de campo: verifica la etiqueta del producto, aplica en dosis divididas si el ajuste es grande y vuelve a medir.', 'mt-s')}</div>`;
}
function readingForm(key, gal, vals, ctx, saveAct, saveData, saveLabel, wbId) {
  const fields = PARAMS.map((p) => {
    const lv = classify(p.key, numOf(vals[p.key]));
    return `<div class="fld"><label>${esc(p.label)}${p.unit ? ` (${p.unit})` : ''}</label><input id="rf_${key}_${p.key}" data-rf="${key}" data-p="${p.key}" inputmode="decimal" value="${esc(vals[p.key])}" placeholder="${p.ok[0]}–${p.ok[1]}" class="${lv ? 'lv-' + lv : ''}"><div class="lvl ${lv || ''}" id="lv_${key}_${p.key}">${lv ? '● ' + LEVEL_LABEL[lv] : ''}</div></div>`;
  }).join('');
  return `<div class="g2">${fields}</div><div id="sg_${key}" data-gal="${gal}" data-wbp="${wbId || (ctx && ctx.wb) || ''}"${ctx ? ` data-stop="${ctx.stop}" data-wb="${ctx.wb}"` : ''}>${sugHtml(key, gal, vals, ctx, wbId)}</div>${btn(saveLabel, saveAct, saveData)}`;
}

function stopView(id) {
  const stop = find('stops', id), prop = stop && find('properties', stop.property_id), client = prop && find('clients', prop.client_id);
  if (!stop || !prop || !client) return { title: '—', body: empty('Parada no encontrada.') };
  const wbs = T('waterBodies').filter((w) => w.property_id === prop.id), locked = stop.status === 'DONE';
  let h = `<div class="card"><div class="row between"><b>${esc(client.name)}</b>${badge(ST_LABEL[stop.status], ST_COLOR[stop.status])}</div>
    <div class="mt-s"><a href="${esc(navUrl(prop))}" target="_blank" rel="noopener">📍 ${esc(prop.address)}, ${esc(prop.municipality)}</a></div>
    ${client.phone ? `<div class="mt-s"><a href="tel:${digits(client.phone)}">📞 ${esc(client.phone)}</a></div>` : ''}
    ${muted(`Check-in: ${fmtTime(stop.check_in_time)} · Check-out: ${fmtTime(stop.check_out_time)}`, 'mt-s')}</div>
    ${stop.status === 'PENDING' ? `<div class="card"><div class="btns">${btn('↪ Pasar a otro día', 'moveSheet', { ids: stop.id }, 'ghost')}${btn('Quitar de esta ruta', 'dropStops', { ids: stop.id, back: '1' }, 'sm ghost')}</div></div>` : ''}
    ${prop.photo && prop.photo.uri ? `<div class="card"><b>Foto de referencia</b><img class="refimg mt-s" src="${prop.photo.uri}" alt="Foto de la propiedad" data-act="viewRef" data-id="${prop.id}"></div>` : `<div class="card"><b>Foto de referencia</b>${muted('Aún no hay foto del frente.')}<div class="btns"><label class="btn sm">📷 Tomar foto del frente<input type="file" accept="image/*" capture="environment" hidden data-ref="${prop.id}"></label></div></div>`}
    <div class="card note"><b>Notas de acceso</b><div>🔑 Portón: ${esc(prop.gate_code || 'sin código')}</div><div>${esc(prop.access_notes || 'Sin notas.')}</div>${client.notes ? muted('Cliente: ' + esc(client.notes), 'mt-s') : ''}</div>`;
  h += '<h2>Cuerpos de agua en esta parada</h2><div class="chips">' + wbs.map((w) => chip(`${w.name} · ${w.gallons.toLocaleString('es-PR')} gal`, stop.active_water_body_ids.includes(w.id), locked ? 'noop' : 'toggleWb', { stop: stop.id, wb: w.id })).join('') + '</div>';
  wbs.filter((w) => stop.active_water_body_ids.includes(w.id)).forEach((w) => {
    const r = T('readings').find((x) => x.stop_id === stop.id && x.water_body_id === w.id);
    const key = `${stop.id}_${w.id}`;
    h += `<h2>🧪 ${esc(w.name)}</h2>` + readingForm(key, w.gallons, draftOf(key, r), { stop: stop.id, wb: w.id }, 'saveStopReading', { stop: stop.id, wb: w.id, key }, 'Guardar lecturas');
  });
  h += '<h2>Lista de verificación</h2><div class="card">' + stop.checklist.map((c) => `<div class="chk"><span class="t ${c.done ? 'done' : ''}">${esc(c.label)}</span><label class="sw"><input type="checkbox" data-chk="stop" data-owner="${stop.id}" data-id="${c.id}"${c.done ? ' checked' : ''}><i></i></label></div>`).join('') + '</div>';
  h += '<h2>Fotos Antes / Después</h2>' + photoStrip('STOP', stop.id);
  h += `<h2>Observaciones para el cliente</h2><div class="card"><textarea id="note_${stop.id}" data-note="${stop.id}" style="width:100%;min-height:84px;padding:10px 14px;border:1.5px solid var(--border);border-radius:12px" placeholder="Ej. Se limpió la canasta de la bomba. Se recomienda…">${esc(stop.client_note || '')}</textarea>${muted('Aparece en el informe PDF y en el texto enviado.', 'mt-s')}</div>`;
  const parts = T('shoppingItems').filter((i) => i.stop_id === stop.id);
  h += `<h2>Piezas requeridas</h2><div class="card">${parts.map((p) => `<div>• ${esc(p.item_name)} ${muted('(' + SHOP_LABEL[p.status] + ')')}</div>`).join('')}
    <div class="fld mt-s">${input('part_name', '', 'placeholder="Ej. O-ring de la tapa de la bomba"')}</div>${btn('+ Requerir pieza', 'addPart', { stop: stop.id }, 'sm ghost')}</div>`;
  const footer = stop.status === 'PENDING' ? btn('▶ Iniciar parada (Check-In GPS)', 'startStop', { id: stop.id })
    : stop.status === 'IN_PROGRESS' ? btn('✓ Completar y enviar (1 toque)', 'completeStop', { id: stop.id, send: '1' }, 'ok') + btn('Completar sin enviar', 'completeStop', { id: stop.id, send: '0' }, 'ghost')
    : btn('📤 Enviar informe al cliente', 'sendStop', { id: stop.id });
  return { title: client.name, body: h, footer };
}

function photoStrip(ownerType, ownerId) {
  const photos = T('photos').filter((p) => p.owner_type === ownerType && p.owner_id === ownerId);
  const lbl = (kind, text) => `<label class="btn sm ghost">${text}<input type="file" accept="image/*" capture="environment" hidden data-photo="${kind}" data-owner="${ownerType}" data-id="${ownerId}"></label>`;
  return `<div class="btns" style="margin:0 0 8px">${lbl('BEFORE', '📷 Antes')}${lbl('AFTER', '📷 Después')}</div>
    ${photos.length ? '' : muted('Sin fotos todavía. El sello de fecha, hora y GPS se imprime dentro de la foto.')}
    <div class="photos">${photos.map((p) => `<div><img src="${p.uri}" alt="${p.kind}"><button class="btn sm ghost mt-s" data-act="delPhoto" data-id="${p.id}">Eliminar</button></div>`).join('')}</div>`;
}

/* =====================================================================
   2. CLIENTES
   ===================================================================== */
function clientsTab() {
  const q = UI.q.toLowerCase();
  const list = T('clients').filter((c) => (UI.clientFilter === 'ALL' || c.status === UI.clientFilter) && c.name.toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name));
  let h = `<div class="fld">${input('cl_q', UI.q, 'placeholder="Buscar cliente…" autocomplete="off"')}</div><div class="chips">
    ${chip('Activos', UI.clientFilter === 'ACTIVE', 'setClientFilter', { v: 'ACTIVE' })}${chip('Archivados', UI.clientFilter === 'ARCHIVED', 'setClientFilter', { v: 'ARCHIVED' })}${chip('Todos', UI.clientFilter === 'ALL', 'setClientFilter', { v: 'ALL' })}</div>`;
  h += list.length ? '<div class="cols">' + list.map((c) => {
    const props = T('properties').filter((p) => p.client_id === c.id);
    const wbc = T('waterBodies').filter((w) => props.some((p) => p.id === w.property_id)).length;
    return `<div class="card tap" data-act="openClient" data-id="${c.id}"><div class="row between"><b>${esc(c.name)}</b>${badge(c.status === 'ACTIVE' ? 'Activo' : 'Archivado', c.status === 'ACTIVE' ? COL.ok : COL.pending)}</div>
      ${muted(esc(props.map((p) => p.municipality).filter(Boolean).join(', ') || 'Sin propiedad') + ` · ${wbc} cuerpo(s) de agua · ${feeLabel(c)}`, 'mt-s')}${muted('Envío: ' + esc(prefText(c)))}${muted('Días de servicio: ' + esc(clientDaysText(c)))}</div>`;
  }).join('') + '</div>' : empty(T('clients').length ? 'No hay clientes en esta vista.' : 'Aún no tienes clientes. Toca «+ Nuevo» para agregar el primero (puedes usar el GPS estando frente a la casa).');
  return { title: 'Clientes', sub: `${activeClients().length} activos`, right: btn('+ Nuevo', 'newClient', {}, 'sm'), body: h };
}

function refBlock(p) {
  const inp = (cap, label, cls) => `<label class="btn sm ${cls}">${label}<input type="file" accept="image/*" ${cap ? 'capture="environment"' : ''} hidden data-ref="${p.id}"></label>`;
  if (p.photo && p.photo.uri) return `<div class="mt-s"><img class="refimg" src="${p.photo.uri}" alt="Foto de la propiedad" data-act="viewRef" data-id="${p.id}"></div><div class="btns">${inp(true, '📷 Nueva foto', 'ghost')}${inp(false, '🖼 Galería', 'ghost')}${btn('Quitar foto', 'delRef', { id: p.id }, 'sm danger')}</div>`;
  return `<div class="mt-s">${muted('Sin foto de referencia del frente.')}</div><div class="btns">${inp(true, '📷 Foto del frente', '')}${inp(false, '🖼 Galería', 'ghost')}</div>`;
}
function clientView(id) {
  const c = find('clients', id);
  if (!c) return { title: '—', body: empty('Cliente no encontrado.') };
  let h = `<div class="card"><div>📞 ${esc(c.phone || '—')}</div><div>✉️ ${esc(c.email || '—')}</div><div>💵 ${feeLabel(c)}</div>${pauseActive(c.pause) ? `<div class="mt-s"><b style="color:${COL.warn}">${esc(pauseLabel(c.pause))}</b></div>` : ''}<div class="mt-s">${btn(pauseActive(c.pause) ? '⏸ Editar pausa del cliente' : '⏸ Pausar servicio', 'pauseSheet', { t: 'c', id: c.id }, 'sm ghost')}</div><div class="mt-s">${seg(c.fee_type || 'MONTHLY', [['MONTHLY', 'Cobro mensual'], ['PER_SERVICE', 'Por servicio']], 'setPref', { id: c.id, f: 'fee_type' })}</div>${c.notes ? muted(esc(c.notes), 'mt-s') : ''}${c.tags.length ? muted('Etiquetas: ' + esc(c.tags.join(', ')), 'mt-s') : ''}</div>
    ${payCard(c)}
    <h2>Informe al cliente</h2><div class="card"><div class="chk"><span class="t">Mostrar hora de llegada y salida en el informe</span><label class="sw"><input type="checkbox" data-cflag="hide_times" data-id="${c.id}"${c.hide_times ? '' : ' checked'}><i></i></label></div>${muted('Las horas siempre quedan guardadas en tu registro; esto solo decide si salen en el PDF y el texto que le envías a este cliente.')}</div>
    <h2>Preferencias de envío guardadas</h2><div class="card">${muted('Canal predeterminado')}${seg(c.dispatch_channel_pref, CHANNELS, 'setPref', { id: c.id, f: 'dispatch_channel_pref' })}
    <div class="mt">${muted('Formato predeterminado')}</div>${seg(c.dispatch_format_pref, FORMATS, 'setPref', { id: c.id, f: 'dispatch_format_pref' })}
    ${muted('Se guarda al instante. Los informes y facturas se envían con estas opciones en 1 solo toque.', 'mt')}</div>
    <div class="row between"><h2>Propiedades</h2>${btn('+ Propiedad', 'newProp', { c: c.id }, 'sm ghost')}</div>`;
  T('properties').filter((p) => p.client_id === c.id).forEach((p) => {
    h += `<div class="card"><b>${esc(p.address)}</b>${muted(esc(p.municipality) + ' · Portón: ' + esc(p.gate_code || 'sin código'))}${muted('💵 ' + propFeeLabel(p, c))}${muted('🧪 ' + SANITIZERS[chemPrefs(S.settings.chem, p.chem).sanitizer].name)}${p.access_notes ? muted(esc(p.access_notes)) : ''}
      <div class="mt-s"><b style="font-size:13px">Días de servicio de esta propiedad</b><div class="chips mt-s">${DAYS.map((n, i) => chip(DAYS_S[i], (p.service_days || []).includes(i), 'togglePropDay', { id: p.id, d: i })).join('')}</div></div>
      <div class="mt-s">${btn('📅 Airbnb / fechas específicas' + ((p.dates || []).length ? ` (${(p.dates || []).length})` : ''), 'openCal', { id: p.id }, 'sm ghost')}${(p.dates || []).filter((x) => x.d >= todayISO()).length ? muted('Próximas: ' + esc((p.dates || []).filter((x) => x.d >= todayISO()).slice(0, 4).map((x) => fmtDate(x.d).replace(/ \d{4}$/, '') + (x.t ? ' ' + fmtHM(x.t) : '')).join(' · ')) + ((p.dates || []).filter((x) => x.d >= todayISO()).length > 4 ? ' …' : ''), 'mt-s') : ''}</div>
      ${pauseActive(p.pause) ? `<div class="mt-s"><b style="color:${COL.warn}">${esc(pauseLabel(p.pause))}</b></div>` : ''}
      <div class="mt-s">${btn(pauseActive(p.pause) ? '⏸ Editar pausa' : '⏸ Pausar', 'pauseSheet', { t: 'p', id: p.id }, 'sm ghost')}</div>
      ${refBlock(p)}
      <div class="btns">${btn('🧪 Productos', 'propChem', { id: p.id }, 'sm ghost')}${btn('Editar', 'editProp', { id: p.id, c: c.id }, 'sm ghost')}${btn('🗑', 'delProp', { id: p.id }, 'sm ghost')}${btn('+ Cuerpo de agua', 'newWb', { p: p.id }, 'sm')}</div>`;
    T('waterBodies').filter((w) => w.property_id === p.id).forEach((w) => {
      h += `<div class="mt" style="padding-left:12px;border-left:3px solid ${COL.water}"><b>💧 ${esc(w.name)}</b> ${muted('· ' + w.gallons.toLocaleString('es-PR') + ' gal')}
        ${T('equipment').filter((e) => e.water_body_id === w.id).map((e) => `<div data-act="editEquip" data-id="${e.id}" style="padding:4px 0">⚙️ ${esc(e.category)}: ${esc(e.brand)} ${esc(e.model)} <b style="color:${e.status === 'OK' ? COL.ok : e.status === 'Atención' ? COL.warn : COL.bad}">[${esc(e.status)}]</b> <a data-act="delEquip" data-id="${e.id}" style="color:${COL.bad};margin-left:6px">eliminar</a></div>`).join('')}
        <div class="btns">${btn('Editar', 'editWb', { id: w.id, p: p.id }, 'sm ghost')}${btn('🗑', 'delWb', { id: w.id }, 'sm ghost')}${btn('+ Equipo', 'newEquip', { w: w.id }, 'sm ghost')}</div></div>`;
    });
    h += '</div>';
  });
  h += `<h2>Acciones</h2>${btn('✏️ Editar cliente', 'editClient', { id: c.id }, 'ghost')}<div class="mt-s"></div>
    ${btn(c.status === 'ACTIVE' ? '📦 Archivar / desactivar (conserva historial)' : '♻️ Reactivar cliente', 'toggleArchive', { id: c.id }, 'dark')}<div class="mt-s"></div>${btn('🗑 Eliminar cliente', 'delClient', { id: c.id }, 'danger')}`;
  return { title: c.name, body: h };
}

/* formularios genéricos (hoja inferior) */
const CLIENT_F = [
  { k: 'name', l: 'Nombre', req: 1 }, { k: 'phone', l: 'Teléfono (WhatsApp)', t: 'tel', ph: '787-555-0100' }, { k: 'email', l: 'Email', t: 'email' },
  { k: 'fee_type', l: 'Tipo de cobro', t: 'choice', o: [['MONTHLY', 'Mensual'], ['PER_SERVICE', 'Por servicio']] }, { k: 'monthly_fee', l: 'Monto ($): por mes o por cada visita', t: 'number' }, { k: 'tags', l: 'Etiquetas (separadas por coma)', ph: 'Caguas, Residencial' },
  { k: 'channel', l: 'Canal de envío predeterminado', t: 'choice', o: CHANNELS }, { k: 'format', l: 'Formato de envío predeterminado', t: 'choice', o: FORMATS }, { k: 'notes', l: 'Notas', t: 'area' },
];
const PROP_F = [
  { k: 'address', l: 'Dirección', req: 1 }, { k: 'municipality', l: 'Municipio / zona', ph: 'Caguas, San Juan, Guaynabo, Dorado, Montehiedra…' }, { k: 'gate_code', l: 'Código de portón' }, { k: 'service_days', l: 'Días de servicio de esta propiedad (puedes marcar varios)', t: 'days' }, { k: 'fee', l: 'Precio de ESTA propiedad ($) — déjalo vacío para usar el precio del cliente', t: 'number', ph: 'Ej. 85' }, 
  { k: 'access_notes', l: 'Notas de acceso (mascotas, cuarto de bombas)', t: 'area' }, { k: 'gps', t: 'gps' }, { k: 'lat', l: 'Latitud', t: 'number', ph: '18.2341' }, { k: 'lng', l: 'Longitud', t: 'number', ph: '-66.0485' },
];
const NEWCLIENT_PROP_F = [{ k: 'address', l: 'Dirección de la propiedad (opcional)' }, { k: 'municipality', l: 'Municipio / zona', ph: 'Caguas, San Juan, Guaynabo, Dorado…' }, { k: 'gate_code', l: 'Código de portón' }, { k: 'service_days', l: 'Días de servicio de esta propiedad', t: 'days' }, { k: 'fee', l: 'Precio de ESTA propiedad ($) — déjalo vacío para usar el precio del cliente', t: 'number', ph: 'Ej. 85' }, { k: 'gps', t: 'gps' }, { k: 'lat', l: 'Latitud', t: 'number' }, { k: 'lng', l: 'Longitud', t: 'number' }];
const WB_F = [{ k: 'name', l: 'Nombre', req: 1, ph: 'Piscina Principal, Jacuzzi, Espejo de Agua' }, { k: 'type', l: 'Tipo', t: 'choice', o: [['Pool', 'Piscina'], ['Jacuzzi', 'Jacuzzi'], ['Commercial', 'Comercial']] }, { k: 'gallons', l: 'Volumen (galones)', t: 'number', req: 1 }];
const EQ_F = [{ k: 'category', l: 'Categoría', req: 1, ph: 'Bomba, Filtro, Calentador, Clorador salino, Automatización' }, { k: 'brand', l: 'Marca' }, { k: 'model', l: 'Modelo' }, { k: 'serial_number', l: 'Serial' }, { k: 'status', l: 'Estado', t: 'choice', o: [['OK', 'OK'], ['Atención', 'Atención'], ['Averiado', 'Averiado']] }];

function formFieldHtml(f, val) {
  if (f.t === 'gps') return `<div class="fld"><button type="button" class="btn dark" data-act="useGps">📍 Usar mi ubicación actual</button><div class="muted mt-s" id="gps_msg">Párate frente a la casa y toca el botón: guarda las coordenadas exactas${online() ? ' y propone la dirección' : ''}.</div></div>`;
  if (f.t === 'hdr') return '<h2>📍 Propiedad y ubicación</h2>';
  if (f.t === 'days') {
    const sel = String(val || '').split(',').filter((x) => x !== '');
    return `<div class="fld"><label>${esc(f.l)}</label><input type="hidden" name="${f.k}" value="${esc(sel.join(','))}"><div class="chips">${DAYS.map((n, i) => `<button type="button" class="chip${sel.includes(String(i)) ? ' on' : ''}" data-act="toggleDay" data-v="${i}">${DAYS_S[i]}</button>`).join('')}</div></div>`;
  }
  if (f.t === 'choice') return `<div class="fld"><label>${esc(f.l)}</label><input type="hidden" name="${f.k}" value="${esc(val || '')}"><div class="seg">${f.o.map(([v, l]) => `<button type="button" class="${v === val ? 'on' : ''}" data-act="pick" data-v="${esc(v)}">${esc(l)}</button>`).join('')}</div></div>`;
  const common = `name="${f.k}" value="${esc(val ?? '')}" placeholder="${esc(f.ph || '')}"`;
  const inner = f.t === 'area' ? `<textarea name="${f.k}">${esc(val ?? '')}</textarea>` : `<input ${common} ${f.t === 'number' ? 'inputmode="decimal"' : f.t === 'tel' ? 'type="tel"' : f.t === 'email' ? 'type="email"' : ''}>`;
  return `<div class="fld"><label>${esc(f.l)}${f.req ? ' *' : ''}</label>${inner}</div>`;
}
function openForm(kind, id, parent) {
  const defs = { client: [CLIENT_F, 'cliente'], prop: [PROP_F, 'propiedad'], wb: [WB_F, 'cuerpo de agua'], equip: [EQ_F, 'equipo'] }[kind];
  let v = {};
  if (kind === 'client') { const c = id && find('clients', id); v = c ? { name: c.name, phone: c.phone, email: c.email, fee_type: c.fee_type || 'MONTHLY', monthly_fee: c.monthly_fee, tags: c.tags.join(', '), channel: c.dispatch_channel_pref, format: c.dispatch_format_pref, notes: c.notes } : { channel: 'WHATSAPP', format: 'TEXT', fee_type: 'MONTHLY', monthly_fee: 0 }; }
  if (kind === 'prop') { const p = id && find('properties', id); v = p ? { ...p } : {}; }
  if (kind === 'wb') { const w = id && find('waterBodies', id); v = w ? { ...w } : { type: 'Pool' }; }
  if (kind === 'equip') { const e = id && find('equipment', id); v = e ? { ...e } : { status: 'OK' }; }
  const fields = kind === 'client' && !id ? [...defs[0], { k: '_h', t: 'hdr' }, ...NEWCLIENT_PROP_F] : defs[0];
  UI.form = { kind, id, parent, fields };
  openSheet(`${id ? 'Editar' : 'Nuevo'} ${defs[1]}`, `<form id="frm" onsubmit="return false">${fields.map((f) => formFieldHtml(f, v[f.k])).join('')}${btn('Guardar', 'submitForm')}</form>`);
}
const daysOf = (str) => String(str || '').split(',').filter((x) => x !== '').map(Number).sort();
function submitForm() {
  const F = UI.form, g = (k) => { const el = document.querySelector(`#frm [name="${k}"]`); return el ? el.value.trim() : ''; };
  if (!F) return;
  const miss = F.fields.find((f) => f.req && !g(f.k));
  if (miss) { toast(`Falta: ${miss.l}`); return; }
  if (F.kind === 'client') {
    const old = F.id && find('clients', F.id);
    const cid = old ? old.id : uid('c');
    upsert('clients', { id: cid, name: g('name'), phone: g('phone'), email: g('email'), dispatch_channel_pref: g('channel') || 'WHATSAPP', dispatch_format_pref: g('format') || 'TEXT', status: old ? old.status : 'ACTIVE', notes: g('notes'), fee_type: g('fee_type') === 'PER_SERVICE' ? 'PER_SERVICE' : 'MONTHLY', monthly_fee: toNum(g('monthly_fee')) || 0, tags: g('tags').split(',').map((t) => t.trim()).filter(Boolean) });
    if (!old && (g('address') || g('lat'))) {
      upsert('properties', { id: uid('p'), client_id: cid, fee: toNum(g('fee')) ?? null, address: g('address') || 'Sin dirección', municipality: g('municipality'), gate_code: g('gate_code'), access_notes: '', service_days: daysOf(g('service_days')), lat: toNum(g('lat')) ?? DEPOT.lat, lng: toNum(g('lng')) ?? DEPOT.lng });
    }
  } else if (F.kind === 'prop') {
    const old = F.id && find('properties', F.id);
    upsert('properties', { ...(old || {}), id: old ? old.id : uid('p'), client_id: old ? old.client_id : F.parent, fee: toNum(g('fee')) ?? null, address: g('address'), municipality: g('municipality'), gate_code: g('gate_code'), access_notes: g('access_notes'), service_days: daysOf(g('service_days')), lat: toNum(g('lat')) ?? DEPOT.lat, lng: toNum(g('lng')) ?? DEPOT.lng });
  } else if (F.kind === 'wb') {
    const old = F.id && find('waterBodies', F.id);
    upsert('waterBodies', { id: old ? old.id : uid('w'), property_id: old ? old.property_id : F.parent, name: g('name'), type: g('type') || 'Pool', gallons: Math.round(toNum(g('gallons')) || 0) });
  } else {
    const old = F.id && find('equipment', F.id);
    upsert('equipment', { id: old ? old.id : uid('e'), water_body_id: old ? old.water_body_id : F.parent, category: g('category'), brand: g('brand'), model: g('model'), serial_number: g('serial_number'), status: g('status') || 'OK' });
  }
  closeSheet();
}

/* =====================================================================
   3. QUÍMICOS
   ===================================================================== */
function chemTab() {
  const clients = activeClients();
  if (!UI.chem.clientId || !find('clients', UI.chem.clientId)) UI.chem.clientId = (clients[0] || {}).id || '';
  const wbs = T('waterBodies').filter((w) => T('properties').some((p) => p.id === w.property_id && p.client_id === UI.chem.clientId));
  const wb = wbs.find((w) => w.id === UI.chem.wbId) || wbs[0];
  let h = btn('🧮 Calculadora de dosis (con valores meta)', 'openCalc', {}, 'ghost') + '<div class="mt-s"></div>' + muted('Cliente', 'mb') + '<div class="chips">' + clients.map((c) => chip(c.name, c.id === UI.chem.clientId, 'chemClient', { id: c.id })).join('') + '</div>';
  if (!wb) return { title: 'Químicos', sub: 'Lecturas, dosis sugerida e historial', body: h + empty('Este cliente no tiene cuerpos de agua registrados.') };
  const gal = toNum(UI.chem.gal) || wb.gallons;
  h += muted('Cuerpo de agua', 'mb') + '<div class="chips">' + wbs.map((w) => chip(`${w.name} · ${w.gallons.toLocaleString('es-PR')} gal`, w.id === wb.id, 'chemWb', { id: w.id })).join('') + '</div>';
  h += fld('Volumen para el cálculo (galones)', input('chem_gal', UI.chem.gal, `inputmode="decimal" placeholder="${wb.gallons}"`));
  const key = `chem_${wb.id}_${UI.chem.n}`;
  h += readingForm(key, gal, draftOf(key, null), null, 'saveChemReading', { key, wb: wb.id }, 'Guardar lectura en el historial', wb.id);
  const hist = T('readings').filter((r) => r.water_body_id === wb.id).sort((a, b) => b.created_at.localeCompare(a.created_at));
  h += '<h2>Historial químico</h2>' + (hist.length ? hist.map((r) => `<div class="card"><b>${fmtDateTime(r.created_at)}</b>${muted(r.stop_id ? 'Tomada en una parada' : 'Lectura manual')}
    <div class="row wrap mt-s" style="gap:14px">${PARAMS.map((p) => (r[p.key] == null ? '' : `<div><div class="muted" style="font-size:11px">${esc(p.label)}</div><b style="color:${COL[classify(p.key, r[p.key])]}">${r[p.key]}</b></div>`)).join('')}</div></div>`).join('') : empty('Sin lecturas todavía.'));
  return { title: 'Químicos', sub: 'Lecturas, dosis sugerida e historial', body: h };
}

/* =====================================================================
   4. ÓRDENES
   ===================================================================== */
const WO_LABEL = { OPEN: 'Abierta', IN_PROGRESS: 'En curso', DONE: 'Completada', INVOICED: 'Facturada' };
const WO_COLOR = { OPEN: COL.pending, IN_PROGRESS: COL.warn, DONE: COL.ok, INVOICED: COL.water };

function ordersTab() {
  const list = T('workOrders').filter((w) => UI.orderFilter === 'ALL' || w.status === UI.orderFilter).sort((a, b) => b.created_at.localeCompare(a.created_at));
  let h = '<div class="chips">' + chip('Todas', UI.orderFilter === 'ALL', 'setOrderFilter', { v: 'ALL' }) + Object.keys(WO_LABEL).map((s) => chip(WO_LABEL[s], UI.orderFilter === s, 'setOrderFilter', { v: s }, WO_COLOR[s])).join('') + '</div>';
  h += list.length ? '<div class="cols">' + list.map((w) => `<div class="card bar tap" style="border-left-color:${WO_COLOR[w.status]}" data-act="openOrder" data-id="${w.id}"><div class="row between"><b>${esc(w.type)}</b>${badge(WO_LABEL[w.status], WO_COLOR[w.status])}</div>
    ${muted(esc(clientName(w.client_id) + (w.description ? ' · ' + w.description : '')), 'mt-s')}${muted(`Tareas ${w.checklist.filter((i) => i.done).length}/${w.checklist.length} · ${money(w.price)}`)}</div>`).join('') + '</div>' : empty('No hay órdenes en esta vista.');
  return { title: 'Órdenes', sub: 'Órdenes de trabajo y listas de tareas', right: btn('+ Nueva', 'newOrder', {}, 'sm'), body: h };
}
function orderView(id) {
  const w = find('workOrders', id);
  if (!w) return { title: '—', body: empty('Orden no encontrada.') };
  const h = `<div class="card"><b>${esc(clientName(w.client_id))}</b>${muted(esc((find('properties', w.property_id) || {}).address || ''))}${w.description ? `<div class="mt-s">${esc(w.description)}</div>` : ''}<div class="mt-s">${badge(WO_LABEL[w.status], WO_COLOR[w.status])}</div></div>
    <h2>Tareas</h2><div class="card">${w.checklist.map((c) => `<div class="chk"><span class="t ${c.done ? 'done' : ''}">${esc(c.label)}</span><label class="sw"><input type="checkbox" data-chk="order" data-owner="${w.id}" data-id="${c.id}"${c.done ? ' checked' : ''}><i></i></label></div>`).join('')}</div>
    <h2>Evidencia fotográfica</h2>${photoStrip('WORK_ORDER', w.id)}
    <h2>Precio y nota para el cliente</h2>${fld('Precio ($)', input('wo_price', w.price, 'inputmode="decimal"'))}${fld('Comentario para el cliente', `<textarea id="wo_note" placeholder="Qué se hizo, recomendaciones…">${esc(w.client_note)}</textarea>`)}${btn('Guardar precio y nota', 'saveOrderNote', { id: w.id }, 'ghost')}`;
  const footer = w.status === 'OPEN' ? btn('▶ Iniciar orden', 'setOrderStatus', { id: w.id, v: 'IN_PROGRESS' }) : w.status === 'IN_PROGRESS' ? btn('✓ Completar orden', 'setOrderStatus', { id: w.id, v: 'DONE' }, 'ok') : w.status === 'DONE' ? muted('Completada: se cobrará en la próxima factura del cliente.') : '';
  return { title: w.type, body: h, footer };
}
function newOrderSheet() {
  const cl = activeClients();
  const props = T('properties').filter((p) => p.client_id === (cl[0] || {}).id);
  openSheet('Nueva orden de trabajo', `${fld('Cliente', `<select id="o_client">${optList(cl.map((c) => [c.id, c.name]))}</select>`)}
    ${fld('Propiedad', `<select id="o_prop">${optList(props.map((p) => [p.id, p.address]))}</select>`)}
    ${fld('Tipo de orden', `<select id="o_type">${optList(Object.keys(WORK_ORDER_TEMPLATES).map((t) => [t, t]), 'Reparación de Equipos')}</select>`)}
    ${fld('Descripción', '<textarea id="o_desc"></textarea>')}${fld('Precio ($)', input('o_price', '', 'inputmode="decimal"'))}${btn('Crear orden', 'createOrder')}`);
}

/* =====================================================================
   5. COMPRAS
   ===================================================================== */
const SHOP_FLOW = ['REQUIRED', 'PURCHASED', 'INSTALLED', 'INVOICED'];
const SHOP_LABEL = { REQUIRED: 'Requerido', PURCHASED: 'Comprado', INSTALLED: 'Instalado', INVOICED: 'Facturado' };
const SHOP_COLOR = { REQUIRED: COL.bad, PURCHASED: COL.warn, INSTALLED: COL.water, INVOICED: COL.ok };

function shopTab() {
  const f = UI.shop;
  const items = T('shoppingItems').filter((i) => (f.status === 'ALL' || i.status === f.status) && (f.tech === 'ALL' || i.assigned_to === f.tech) && (f.client === 'ALL' || i.client_id === f.client)).sort((a, b) => SHOP_FLOW.indexOf(a.status) - SHOP_FLOW.indexOf(b.status));
  let h = '<div class="chips">' + chip('Todos', f.status === 'ALL', 'shopF', { k: 'status', v: 'ALL' }) + SHOP_FLOW.map((s) => chip(SHOP_LABEL[s], f.status === s, 'shopF', { k: 'status', v: s }, SHOP_COLOR[s])).join('') + '</div>';
  h += muted('Técnico', 'mb') + '<div class="chips">' + chip('Todos', f.tech === 'ALL', 'shopF', { k: 'tech', v: 'ALL' }) + [...new Set([...techList(), ...T('shoppingItems').map((i) => i.assigned_to).filter(Boolean)])].map((t) => chip(t, f.tech === t, 'shopF', { k: 'tech', v: t })).join('') + '</div>';
  h += `<div class="mb">${btn('✏️ Editar nombres del equipo', 'openPdfSettings', {}, 'sm ghost')}</div>`;
  h += muted('Cliente', 'mb') + '<div class="chips">' + chip('Todos', f.client === 'ALL', 'shopF', { k: 'client', v: 'ALL' }) + activeClients().map((c) => chip(c.name, f.client === c.id, 'shopF', { k: 'client', v: c.id })).join('') + '</div>';
  h += items.length ? '<div class="cols">' + items.map((i) => `<div class="card bar tap" style="border-left-color:${SHOP_COLOR[i.status]}" data-act="editItem" data-id="${i.id}"><div class="row between"><b>${esc(i.item_name)}</b>${badge(SHOP_LABEL[i.status], SHOP_COLOR[i.status])}</div>
    ${muted(esc(clientName(i.client_id) + ' · ' + i.assigned_to), 'mt-s')}${muted(`Costo ${money(i.cost)} · Precio ${money(i.price)} · Margen ${money(i.price - i.cost)}`)}
    ${i.status === 'REQUIRED' || i.status === 'PURCHASED' ? `<div class="mt">${btn(i.status === 'REQUIRED' ? '🛍 Marcar comprado' : '🔧 Marcar instalado', 'advanceItem', { id: i.id })}</div>` : ''}
    ${i.status === 'INSTALLED' ? muted('Se cobrará en la próxima factura del cliente.', 'mt-s') : ''}</div>`).join('') + '</div>' : empty('No hay piezas con estos filtros.');
  return { title: 'Compras', sub: 'Requerido → Comprado → Instalado → Facturado', right: btn('+ Pieza', 'newItem', {}, 'sm'), body: h };
}
function itemSheet(id) {
  const i = id && find('shoppingItems', id);
  UI.editItem = id || null;
  openSheet(id ? 'Editar pieza' : 'Nueva pieza', `${fld('Pieza / repuesto *', input('i_name', i ? i.item_name : ''))}
    ${fld('Cliente', `<select id="i_client">${optList(activeClients().map((c) => [c.id, c.name]), i && i.client_id)}</select>`)}
    <div class="g2">${fld('Costo ($)', input('i_cost', i ? i.cost : '', 'inputmode="decimal"'))}${fld('Precio al cliente ($)', input('i_price', i ? i.price : '', 'inputmode="decimal"'))}</div>
    ${fld('Técnico asignado', `<select id="i_tech">${optList([...new Set([...techList(), ...(i && i.assigned_to ? [i.assigned_to] : [])])].map((t) => [t, t]), i && i.assigned_to)}</select>`)}${btn('Guardar', 'saveItem')}
    ${id ? `<div class="mt-s"></div>${btn('Eliminar pieza', 'delItem', { id }, 'danger')}` : ''}`);
}

/* =====================================================================
   6. FACTURACIÓN
   ===================================================================== */
const INV_COLOR = { PENDING: COL.pending, SENT: COL.water, PAID: COL.ok, OVERDUE: COL.bad, CARRIED: '#a78bfa' };
const invView = (i) => effectiveStatus(i, todayISO());


/* ---------- pagos / saldo a favor ---------- */
const payMethodSel = (id) => `<select id="${id}">${Object.entries(PAY_METHODS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>`;
function payRows(inv) {
  const paid = invPaid(inv, S.db); if (!(paid > 0) && !inv.carried_to) return '';
  if (inv.carried_to) { const n = find('invoices', inv.carried_to); return `<div class="muted mt-s">↪ El saldo pasó a la factura ${esc(n ? invNumber(n, S.db) : '')}</div>`; }
  if (inv.status === 'PAID') return '';
  return `<div class="row between" style="padding-top:6px"><span class="muted">Abonos recibidos</span><b style="color:${COL.ok}">-${money(paid)}</b></div><div class="row between"><b>Balance pendiente</b><span class="amount" style="color:${COL.bad}">${money(invBalance(inv, S.db))}</span></div>`;
}
function payList(list) {
  return list.slice().sort((a, b) => (b.date + b.created_at).localeCompare(a.date + a.created_at)).map((p) => `<div class="row between" style="padding:5px 0"><span>${fmtDate(p.date)} · ${esc(PAY_METHODS[p.method] || p.method)}${p.note ? ' · ' + esc(p.note) : ''}</span><span><b>${money(p.amount)}</b> <button class="x" data-act="sendReceipt" data-id="${p.id}" aria-label="Enviar recibo" title="Enviar recibo">🧾</button> <button class="x" data-act="delPayment" data-id="${p.id}" aria-label="Quitar pago">✕</button></span></div>`).join('');
}
function payHistory(inv) {
  const l = T('payments').filter((p) => p.invoice_id === inv.id); if (!l.length) return '';
  return `<h2>Pagos de esta factura</h2><div class="card">${payList(l)}</div>`;
}
function payCard(c) {
  const credit = clientCredit(S.db, c.id), owed = clientOwed(S.db, c.id), l = T('payments').filter((p) => p.client_id === c.id);
  return `<div class="row between"><h2>Pagos y saldo</h2>${btn('+ Pago adelantado', 'payAdvance', { id: c.id }, 'sm ghost')}</div>
    <div class="card"><div class="row"><div class="grow">${muted('Saldo a favor')}<div class="big" style="color:${COL.ok}">${money(credit)}</div></div><div class="grow">${muted('Por cobrar')}<div class="big" style="color:${owed > 0 ? COL.bad : COL.ok}">${money(owed)}</div></div></div>
    ${credit > 0 ? muted('El saldo a favor se descuenta solo en la próxima factura.', 'mt-s') : ''}${l.length ? `<div class="mt-s">${payList(l.slice(0, 6))}</div>${l.length > 6 ? muted('… y ' + (l.length - 6) + ' pagos más (Excel → hoja Pagos)') : ''}` : muted('Sin pagos registrados.', 'mt-s')}</div>`;
}
/** Registra un pago. Si es de factura y se pasa del balance, el sobrante queda como saldo a favor. */
function addPayment({ client_id, amount, date, method, note, invoice_id }) {
  amount = Math.round(+amount * 100) / 100; if (!(amount > 0)) return false;
  const mk = (amt, inv) => { const id = uid('pay'); upsert('payments', { id, client_id, amount: amt, date: date || todayISO(), method: method || 'ATH_MOVIL', note: note || '', invoice_id: inv || null, created_at: new Date().toISOString() }); return id; };
  if (invoice_id) {
    const inv = find('invoices', invoice_id), bal = invBalance(inv, S.db), now = Math.min(amount, bal), extra = Math.round((amount - now) * 100) / 100;
    let pid = null;
    if (now > 0) pid = mk(now, invoice_id);
    if (extra > 0) { const x = mk(extra, null); pid = pid || x; }
    const cur = find('invoices', invoice_id);
    if (invBalance({ ...cur, status: 'X' }, S.db) <= 0.005) upsert('invoices', { ...cur, status: 'PAID' });
    return { extra, id: pid };
  }
  return { extra: 0, id: mk(amount, null) };
}
/** Abre el envío del recibo (misma pulsación del usuario). Un toque en «Enviar» y listo. */
function offerReceipt(payId) {
  if (!payId || !S.settings.receipt || !S.settings.receipt.ask) return;
  const p = find('payments', payId), c = p && find('clients', p.client_id);
  if (c) openDispatch(c.id, 'RECEIPT', buildReceiptDoc(c, p, S.settings, S.db));
}
function paySheet(title, hint, defAmt, act, data) {
  openSheet(title, `${hint ? muted(hint) : ''}<div class="fld mt-s"><label>Monto ($)</label><input id="pay_amt" inputmode="decimal" value="${defAmt ? defAmt : ''}" placeholder="0.00"></div><div class="fld"><label>Fecha</label><input type="date" id="pay_date" value="${todayISO()}"></div><div class="fld"><label>Método</label>${payMethodSel('pay_method')}</div><div class="fld"><label>Nota (opcional)</label><input id="pay_note" placeholder="Ej. 3 meses por adelantado"></div>${btn('Guardar pago', act, data)}`);
}
/* ---- Quién me debe ---- */
function debtors() {
  const today = todayISO(), by = {};
  T('invoices').filter((i) => effectiveStatus(i, today) === 'OVERDUE').forEach((i) => { const b = invBalance(i, S.db); if (b > 0) (by[i.client_id] ||= []).push({ i, b }); });
  return Object.entries(by).map(([cid, arr]) => ({ c: find('clients', cid), arr, total: r2(arr.reduce((s, x) => s + x.b, 0)), days: Math.max(...arr.map((x) => Math.round((new Date(today + 'T12:00:00') - new Date(x.i.due_date + 'T12:00:00')) / 864e5))) })).filter((d) => d.c).sort((x, y) => y.days - x.days);
}
function reminderDoc(d) {
  const first = d.c.name.split(' ')[0], biz = S.settings.biz.name || 'Elite Pool Service';
  const facts = d.arr.map((x) => `• Factura ${invNumber(x.i, S.db)} (venció el ${fmtDate(x.i.due_date)}): ${money(x.b)}`).join('\n');
  const pm = (d.arr[0].i.payment_method) || 'ATH_MOVIL';
  const body = `Hola ${first}, le escribimos de ${biz} para recordarle amablemente que tiene un balance vencido de ${money(d.total)}:\n${facts}\n\n${paymentInstructions(pm, S.settings)}\n\nSi ya realizó el pago, ignore este mensaje y gracias. Quedamos atentos.`;
  return buildBroadcastDoc(d.c, body, 'Recordatorio de pago', S.settings);
}
function debtorsHtml() {
  const list = debtors(); if (!list.length) return '';
  const tot = r2(list.reduce((s, d) => s + d.total, 0));
  return `<h2>💸 Quién me debe (${list.length})</h2><div class="card" style="border-left:6px solid ${COL.bad}">${muted('Vencido en total: ' + money(tot))}` + list.map((d) => `<div class="row between" style="padding:8px 0;border-top:1px solid var(--border);margin-top:8px"><div class="grow"><b>${esc(d.c.name)}</b>${muted(`${money(d.total)} · ${d.days} día(s) de atraso${d.c.last_reminder ? ' · recordado ' + fmtDate(d.c.last_reminder) : ''}`)}</div>${btn('📲 Recordar', 'remind', { id: d.c.id }, 'sm')}</div>`).join('') + `${muted('Se abre WhatsApp (o tu canal preferido) con el mensaje listo; solo toca enviar.', 'mt-s')}</div>`;
}
const backupBanner = () => (backupStale() && !UI.bkSnooze && T('clients').length ? `<div class="card" style="border-left:6px solid ${COL.warn}"><b>💾 ${S.lastBackup ? 'Hace ' + Math.max(1, Math.round((Date.now() - new Date(S.lastBackup).getTime()) / 864e5)) + ' día(s) sin respaldo' : 'Aún no has hecho un respaldo'}</b>${muted('Tus datos viven solo en este teléfono. Envíatelo por correo, WhatsApp o Drive: toma 10 segundos.')}<div class="btns mt-s">${btn('📤 Respaldar ahora', 'shareBackup', {}, 'sm')}${btn('Más tarde', 'snoozeBackup', {}, 'sm ghost')}</div></div>` : '');
/** Crea (como borrador) las facturas de cuota mensual del mes la primera vez que abres la app ese mes. */
function autoInvoices() {
  const a = S.settings.auto, today = todayISO(), period = today.slice(0, 7);
  if (!a || !a.invoices || a.last === period || !activeClients().length) return;
  a.last = period;
  const targets = activeClients().filter((c) => (c.fee_type || 'MONTHLY') === 'MONTHLY' && !pauseHit(c.pause, today) && !T('invoices').some((i) => i.client_id === c.id && i.period === period));
  const n = targets.filter(createInvoiceFor).length;
  persist();
  if (n) toast(`Se crearon ${n} factura(s) de ${period} como borrador. Revísalas en Facturas.`);
}
function invoicesTab() {
  if (UI.invMode === 'quotes') return quotesTab();
  const period = todayISO().slice(0, 7);
  const list = T('invoices').filter((i) => UI.invFilter === 'ALL' || invView(i) === UI.invFilter).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const owed = T('invoices').reduce((s, i) => s + invBalance(i, S.db), 0), paid = T('invoices').reduce((s, i) => s + (i.status === 'PAID' ? i.total_amount : invPaid(i, S.db)), 0);
  let h = `<div class="row mb"><div class="card grow" style="margin:0">${muted('Por cobrar')}<div class="big" style="color:${COL.bad}">${money(owed)}</div></div><div class="card grow" style="margin:0">${muted('Cobrado')}<div class="big" style="color:${COL.ok}">${money(paid)}</div></div></div>
    ${btn('⚡ Procesar facturación del mes (1 toque)', 'bulkInvoices', {}, 'dark')}<div class="mt"></div>${debtorsHtml()}
    <div class="chips">${chip('Todas', UI.invFilter === 'ALL', 'setInvFilter', { v: 'ALL' })}${Object.keys(STATUS_LABEL).map((s) => chip(STATUS_LABEL[s], UI.invFilter === s, 'setInvFilter', { v: s }, INV_COLOR[s])).join('')}</div>`;
  h += list.length ? '<div class="cols">' + list.map((i) => `<div class="card bar tap" style="border-left-color:${INV_COLOR[invView(i)]}" data-act="openInvoice" data-id="${i.id}"><div class="row between"><b>${esc(clientName(i.client_id))}</b>${badge(STATUS_LABEL[invView(i)], INV_COLOR[invView(i)])}</div>${muted(`${i.period} · vence ${fmtDate(i.due_date)}`, 'mt-s')}<div class="amount">${money(i.total_amount)}</div>${invPaid(i, S.db) > 0 && i.status !== 'PAID' && !i.carried_to ? muted('Abonado ' + money(invPaid(i, S.db)) + ' · balance ' + money(invBalance(i, S.db))) : ''}</div>`).join('') + '</div>' : empty('No hay facturas en esta vista.');
  return { title: 'Facturación', sub: `Periodo ${period}`, right: btn('+ Factura', 'newInvoice', {}, 'sm'), body: invModeSeg() + '<div class="mt"></div>' + h + `<div class="mt"></div>${btn('🎨 Cambiar plantilla de factura y cotización', 'openTemplates', {}, 'sm ghost')}` };
}
function invoiceView(id) {
  const inv = find('invoices', id), c = inv && find('clients', inv.client_id);
  if (!inv || !c) return { title: '—', body: empty('Factura no encontrada.') };
  const h = `<div class="card"><b>${esc(c.name)}</b>${muted('Vence ' + fmtDate(inv.due_date) + (termsLabel(inv.terms) ? ' · ' + termsLabel(inv.terms) : ''))}${inv.status !== 'PAID' && !inv.carried_to ? `<div class="fld mt-s"><label>Condiciones de pago</label><select data-invterms="${inv.id}"><option value="">${inv.terms ? '' : 'Escoge…'}</option>${optList(TERMS, inv.terms)}</select></div>` : ''}<div class="mt-s">${badge(STATUS_LABEL[invView(inv)], INV_COLOR[invView(inv)])}</div></div>
    <h2>Desglose</h2><div class="card">${inv.lines.map((l) => `<div class="row between" style="padding:6px 0"><span>${l.kind === 'FEE' || l.kind === 'VISIT' ? '🗓' : l.kind === 'PART' ? '🔧' : l.kind === 'PREV' ? '↩️' : l.kind === 'CREDIT' ? '💚' : '📋'} ${esc(l.description)}</span><b>${money(l.amount)}</b></div>`).join('')}
    <div class="row between" style="border-top:1px solid var(--border);margin-top:6px;padding-top:8px"><b style="font-size:18px">Total</b><span class="amount">${money(inv.total_amount)}</span></div>${payRows(inv)}</div>
    ${payHistory(inv)}
    <h2>Método de pago</h2>${seg(inv.payment_method, [['ATH_MOVIL', 'ATH Business'], ['ATH_PERSONAL', 'ATH Personal'], ['CARD', 'Tarjeta'], ['STRIPE', 'Stripe'], ['TRANSFER', 'Transf.']], 'setPayment', { id: inv.id })}
    <div class="card mt" style="background:#f0f9ff;border-color:${COL.water}">${inv.payment_method === 'ATH_MOVIL' ? `${muted('ATH Móvil Business')}${athUrl(S.settings) ? `<div class="mt-s"><a href="${esc(athUrl(S.settings))}" target="_blank" rel="noopener" style="word-break:break-all">${esc(athUrl(S.settings))}</a></div>` : ''}${S.settings.pay.athPhone ? `<div class="big" style="color:${COL.water}">${esc(S.settings.pay.athPhone)}</div>` : ''}${!athUrl(S.settings) && !S.settings.pay.athPhone ? muted('Aún no hay enlace ni número. Configúralo abajo.') : ''}` : ''}${inv.payment_method === 'ATH_PERSONAL' ? `${muted('ATH Móvil personal')}${S.settings.pay.athPersonalPhone ? `<div class="big" style="color:${COL.water}">${esc(S.settings.pay.athPersonalPhone)}</div>` : muted('Aún no hay número personal. Configúralo en Ajustes.')}` : ''}<div class="mt-s">${esc(paymentInstructions(inv.payment_method, S.settings))}</div></div>
    <div class="mt"></div>${btn('🎨 Personalizar factura y logo', 'openPdfSettings', {}, 'ghost')}
    ${inv.status === 'DRAFT' ? btn('Eliminar borrador', 'delDraft', { id: inv.id }, 'sm danger') : ''}`;
  const footer = btn('📤 Enviar factura (preferencia del cliente)', 'sendInvoice', { id: inv.id }) + (inv.status !== 'PAID' && !inv.carried_to ? btn('💵 Registrar pago / abono', 'payInvoice', { id: inv.id }, 'ok') + btn('✓ Marcar como pagada (todo)', 'markPaid', { id: inv.id }, 'ghost') : '');
  return { title: `Factura ${invNumber(inv, S.db)}`, body: h, footer };
}
function createInvoiceFor(c) {
  const period = todayISO().slice(0, 7);
  if (T('invoices').some((i) => i.client_id === c.id && i.period === period)) return false;
  const { invoice, itemIds, orderIds, stopIds, carryIds } = buildInvoice(c, S.db, period, todayISO());
  if (!invoice.newCount) return false;
  delete invoice.newCount;
  invoice.terms = c.terms || S.settings.invoice.termsCode || 'NET15';
  invoice.due_date = dueFor(invoice.terms, invoice.issue_date);
  upsert('invoices', invoice);
  carryIds.forEach((id) => upsert('invoices', { ...find('invoices', id), carried_to: invoice.id }));
  itemIds.forEach((id) => upsert('shoppingItems', { ...find('shoppingItems', id), status: 'INVOICED' }));
  orderIds.forEach((id) => upsert('workOrders', { ...find('workOrders', id), status: 'INVOICED' }));
  stopIds.forEach((id) => upsert('stops', { ...find('stops', id), invoice_id: invoice.id }));
  return true;
}

/* =====================================================================
   7. MENSAJERÍA
   ===================================================================== */
const SIGN = '\n\n— Elite Pool Service PR';
const TEMPLATES = [
  { id: 'feriado', label: 'Cambio de ruta (feriado)', subject: 'Aviso de cambio de ruta por día feriado', body: `Hola {nombre}, por el día feriado de esta semana su servicio de piscina se moverá al siguiente día laborable. Gracias por su comprensión.${SIGN}` },
  { id: 'huracan', label: 'Alerta tormenta / huracán', subject: 'Alerta de tormenta: preparación de su piscina', body: `Hola {nombre}, se anticipa mal tiempo en Puerto Rico. Para proteger su piscina: no la vacíe, retire muebles y objetos sueltos del área y, si hay riesgo de inundación, apague los equipos desde el panel eléctrico. Coordinaremos el tratamiento del agua antes y después del evento cuando sea seguro hacerlo.${SIGN}` },
  { id: 'filtros', label: 'Mantenimiento de filtros', subject: 'Recordatorio de mantenimiento de filtros', body: `Hola {nombre}, le recordamos que es momento de la limpieza profunda del filtro de su piscina para mantener el agua cristalina y proteger su equipo. Responda este mensaje para coordinar la fecha.${SIGN}` },
  { id: 'custom', label: 'Mensaje libre', subject: 'Aviso de Elite Pool Service PR', body: 'Hola {nombre}, ' },
];
const AREAS = ['Caguas', 'San Juan', 'Guaynabo', 'Dorado', 'Montehiedra', 'Comercial', 'Residencial', ...DAYS];

function msgRecipients() {
  const a = UI.msg.area.toLowerCase(), di = DAYS.indexOf(UI.msg.area);
  return activeClients().filter((c) => UI.msg.area === 'ALL' || T('properties').some((p) => p.client_id === c.id && p.municipality.toLowerCase() === a) || c.tags.some((t) => t.toLowerCase() === a) || (di >= 0 && T('properties').some((p) => p.client_id === c.id && (p.service_days || []).includes(di))));
}
const backupBlob = () => new Blob([JSON.stringify({ app: 'elite-pool-pwa', format: 1, exported_at: new Date().toISOString(), db: S.db, settings: S.settings })], { type: 'application/json' });
const backupStale = () => !S.lastBackup || Date.now() - new Date(S.lastBackup).getTime() > 7 * 864e5;
function markBackup(msg) { S.lastBackup = new Date().toISOString(); persist(); render(); toast(msg); }
async function restoreBackup(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch (e) { return alert('Ese archivo no es un respaldo válido.'); }
  if (!data || data.app !== 'elite-pool-pwa' || !data.db || !Array.isArray(data.db.clients)) return alert('Ese archivo no es un respaldo de Elite Pool Service PR.');
  const n = data.db.clients.length;
  if (!confirm(`Se reemplazarán TODOS los datos actuales por el respaldo (${n} cliente(s), guardado el ${fmtDateTime(data.exported_at)}). ¿Continuar?`)) return;
  S.db = migrateDb(data.db); S.settings = mergeSettings(data.settings); S.queue = []; S.demoPurged = true; UI.drafts = {}; UI.view = null;
  persist(); render(); toast(`Respaldo restaurado: ${n} cliente(s)`);
}
function msgTab() {
  const M = UI.msg, tpl = TEMPLATES.find((t) => t.id === M.tpl);
  if (M.subject === null) { M.subject = tpl.subject; M.body = tpl.body; }
  const act = activeClients(), combo = (ch, f) => act.filter((c) => c.dispatch_channel_pref === ch && c.dispatch_format_pref === f).length;
  const rec = msgRecipients();
  let h = `<h2>Documentos PDF</h2><div class="card">Logo, datos del negocio, <b>plantilla de factura y cotización</b> y qué secciones salen en cada PDF.${S.settings.logo ? muted('Logo cargado ✓', 'mt-s') : ''}<div class="mt-s"></div>${btn('🎨 Personalizar PDF y logo', 'openPdfSettings', {}, 'ghost')}</div>
    <h2>Motor de envío híbrido</h2><div class="card">Cada informe y factura sale por el canal (WhatsApp / Email / Ambos) y en el formato (PDF / Texto / Ambos) guardados en la ficha del cliente.
    ${muted('Clientes activos por preferencia', 'mt-s')}${['WHATSAPP', 'EMAIL', 'BOTH'].map((ch) => `<div>${{ WHATSAPP: 'WhatsApp', EMAIL: 'Email', BOTH: 'Ambos' }[ch]}: PDF ${combo(ch, 'PDF')} · Texto ${combo(ch, 'TEXT')} · Ambos ${combo(ch, 'BOTH')}</div>`).join('')}</div>
    <h2>Aviso masivo</h2>${muted('Plantilla', 'mb')}<div class="chips">${TEMPLATES.map((t) => chip(t.label, M.tpl === t.id, 'setTpl', { id: t.id })).join('')}</div>
    ${muted('Audiencia (zona, etiqueta o día de servicio)', 'mb')}<div class="chips">${chip('Todos', M.area === 'ALL', 'setArea', { v: 'ALL' })}${AREAS.map((a) => chip(a, M.area === a, 'setArea', { v: a })).join('')}</div>
    ${fld('Asunto (email)', input('m_subject', M.subject))}${fld('Mensaje ({nombre} se reemplaza por el nombre)', `<textarea id="m_body" style="min-height:140px">${esc(M.body)}</textarea>`)}
    <b>Destinatarios (${rec.length})</b><div class="mt-s"></div>`;
  h += rec.length ? rec.map((c) => `<div class="card"><div class="row"><div class="grow"><b>${M.sent[c.id] ? '✅ ' : ''}${esc(c.name)}</b>${muted(esc(prefText(c).split(' · ')[0]))}</div>${btn(M.sent[c.id] ? 'Reenviar' : 'Enviar', 'sendBroadcast', { id: c.id }, 'sm' + (M.sent[c.id] ? ' ghost' : ''))}</div></div>`).join('') : empty('Ningún cliente activo coincide con esta audiencia.');
  h += muted('El teléfono abre WhatsApp / Correo con el mensaje listo para cada cliente; hay que tocar «enviar» en cada uno.');
  const log = [...T('dispatchLog')].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 8);
  h += '<h2>Últimos envíos</h2>' + (log.length ? log.map((l) => `<div class="card"><b>${esc(l.who || clientName(l.client_id))}</b>${muted(`${{ REPORT: 'Informe', INVOICE: 'Factura', BROADCAST: 'Aviso', QUOTE: 'Cotización' }[l.kind]} · ${l.channel} · ${l.format} · ${fmtDateTime(l.at)}`)}</div>`).join('') : empty('Aún no hay envíos registrados.'));
  h += `<h2>💾 Respaldo de datos</h2><div class="card">Tus datos viven solo en este teléfono. Guarda un respaldo seguido (y súbelo a Drive o envíatelo por WhatsApp/correo).
    <div class="mt-s" style="font-weight:700;color:${backupStale() ? COL.warn : COL.ok}">${S.lastBackup ? 'Último respaldo: ' + fmtDateTime(S.lastBackup) : 'Aún no has hecho ningún respaldo'}</div>
    <div class="mt-s"></div>${btn('💾 Guardar respaldo en el teléfono', 'backupJson')}<div class="mt-s"></div>${btn('📤 Enviar / guardar en Drive o WhatsApp', 'shareBackup', {}, 'ghost')}<div class="mt-s"></div>${btn('📊 Exportar a Excel (.xlsx)', 'exportXlsx', {}, 'ghost')}
    ${muted('El archivo .json es el respaldo completo (clientes, historial, fotos, logo) y se puede restaurar. El Excel es para consultar o imprimir: clientes, facturas y lecturas.', 'mt-s')}
    <div class="mt"></div><label class="btn ghost">♻️ Restaurar desde un respaldo (.json)<input type="file" accept=".json,application/json" hidden data-restore="1"></label></div>
    <h2>🔒 Clave de acceso</h2><div class="card">${S.lock ? `<b style="color:${COL.ok}">● Clave activa</b>${muted('Bloquear la app después de salir por:', 'mt-s')}<div class="chips mt-s">${AUTO_OPTS.map(([v, l]) => chip(l, (S.lock.auto ?? 5) === v, 'setAutoLock', { v })).join('')}</div>${btn('🔒 Bloquear ahora', 'lockNow', {}, 'dark')}<div class="btns"><button class="btn sm ghost" data-act="openPinSetup">Cambiar clave</button><button class="btn sm ghost" data-act="openPinRemove">Quitar clave</button></div>` : `Pide una clave de 4 a 6 números cada vez que se abre la app, para que nadie más haga cambios.<div class="mt-s"></div>${btn('Crear clave', 'openPinSetup', {}, 'dark')}`}
    ${muted('Es una protección sencilla contra curiosos: no cifra los datos. Mantén también el bloqueo de pantalla del teléfono.', 'mt-s')}</div>
    <h2>Sistema y sincronización</h2><div class="card"><b style="color:${online() ? COL.ok : COL.warn}">${online() ? '● En línea' : '● Modo offline'}</b>${muted(`${S.queue.length} cambio(s) pendientes · Última sincronización: ${S.lastSync ? fmtDateTime(S.lastSync) : 'nunca'}`)}
    <div class="row between mt"><span>Simular modo sin conexión (prueba)</span><label class="sw"><input type="checkbox" data-sim="1"${UI.simOffline ? ' checked' : ''}><i></i></label></div>
    <div class="mt"></div>${btn(UI.syncing ? 'Sincronizando…' : 'Sincronizar ahora', 'syncNow', {}, 'ghost')}${muted('Versión de la app: '+APP_VERSION,'mt-s')}${UI.installEvt ? '<div class="mt-s"></div>' + btn('📲 Instalar app en este teléfono', 'install', {}, 'dark') : ''}</div>`;
  return { title: 'Mensajería', sub: 'Envío híbrido, avisos masivos y sincronización', body: h };
}

/* =====================================================================
   Envío en 1 toque (hoja de despacho)
   ===================================================================== */
function openDispatch(clientId, kind, doc, opts = {}) {
  const c = opts.pseudo || find('clients', clientId);
  if (!c || !doc) return;
  UI.dispatch = { pseudo: opts.pseudo || null, clientId, kind, doc, forceFormat: opts.forceFormat || null, channel: c.dispatch_channel_pref, format: opts.forceFormat || c.dispatch_format_pref, done: [], edit: false, after: opts.after || null };
  renderDispatch();
  execDispatch(0); // misma pulsación del usuario: necesario para abrir WhatsApp / compartir
}
const dispActions = () => planDispatch(UI.dispatch.channel, UI.dispatch.forceFormat || UI.dispatch.format);
async function execDispatch(i) {
  const D = UI.dispatch, a = D && dispActions()[i];
  if (!a) return;
  try {
    const r = await runAction(a, D.pseudo || find('clients', D.clientId), D.doc);
    if (UI.dispatch !== D) return;
    if (r !== 'cancelled' && !D.done.includes(a.id)) {
      const first = D.done.length === 0;
      D.done.push(a.id);
      upsert('dispatchLog', { id: uid('dl'), client_id: D.clientId || null, who: D.pseudo ? D.pseudo.name : undefined, kind: D.kind, channel: a.channel, format: a.format, at: new Date().toISOString(), summary: D.doc.title });
      if (first && D.after) D.after();
    }
    if (r === 'downloaded') toast('PDF descargado: adjúntalo desde tus descargas');
    renderDispatch();
  } catch (e) { alert('No se pudo enviar: ' + e.message); }
}
function renderDispatch() {
  const D = UI.dispatch;
  if (!D) return;
  const c = D.pseudo || find('clients', D.clientId), acts = dispActions(), rem = acts.findIndex((a) => !D.done.includes(a.id));
  const html = `<div class="card">${muted('Preferencia guardada del cliente')}<b>${esc(prefText({ ...c, dispatch_format_pref: D.forceFormat || c.dispatch_format_pref }))}</b></div>
    ${acts.map((a, i) => `<div class="row mb"><span class="grow"><b>${D.done.includes(a.id) ? '✅ ' : i + 1 + '. '}${esc(a.label)}</b></span>${btn(D.done.includes(a.id) ? 'Reenviar' : 'Enviar', 'dispSend', { i }, 'sm' + (D.done.includes(a.id) ? ' ghost' : ''))}</div>`).join('')}
    ${rem >= 0 && D.done.length ? btn('Siguiente: ' + esc(acts[rem].label), 'dispSend', { i: rem }) : ''}${rem < 0 && acts.length ? btn('Listo', 'closeSheet', {}, 'ok') : ''}
    <div class="mt"></div>${D.edit ? `${muted('Canal (solo este envío)')}${seg(D.channel, CHANNELS, 'dispChannel')}${D.forceFormat ? '' : `<div class="mt"></div>${muted('Formato (solo este envío)')}${seg(D.format, FORMATS, 'dispFormat')}`}` : btn('Cambiar solo por esta vez', 'dispEdit', {}, 'sm ghost')}`;
  openSheet(`Enviar a ${c.name}`, html, true);
}

/* =====================================================================
   Shell, vistas y render
   ===================================================================== */
const TAB_FN = { routes: routesTab, clients: clientsTab, chem: chemTab, orders: ordersTab, shop: shopTab, invoices: invoicesTab, msg: msgTab };

/* =====================================================================
   Personalizar PDF (logo, datos del negocio y secciones)
   ===================================================================== */
const INV_OPTS = [['logo', 'Logo'], ['showName', 'Nombre del negocio junto al logo (apágalo si tu logo ya trae el nombre)'], ['bizInfo', 'Datos del negocio (dirección, teléfono, correo)'], ['number', 'Número de factura'], ['dates', 'Fechas de emisión y vencimiento'], ['clientInfo', 'Datos del cliente'], ['itemType', 'Columna «Tipo» (servicio / pieza / orden)'], ['subtotals', 'Subtotales por categoría'], ['payBox', 'Recuadro del método de pago'], ['instructions', 'Instrucciones de pago'], ['terms', 'Términos y condiciones'], ['stamp', 'Sello PAGADA / VENCIDA'], ['footer', 'Pie de página']];
const REP_OPTS = [['logo', 'Logo'], ['showName', 'Nombre del negocio junto al logo (apágalo si tu logo ya trae el nombre)'], ['bizInfo', 'Datos del negocio'], ['clientBlock', 'Datos del cliente y visita'], ['times', 'Hora de entrada y salida'], ['tech', 'Nombre del técnico'], ['readings', 'Tabla de lecturas químicas'], ['ideal', 'Rango ideal'], ['previous', 'Lectura de la visita anterior'], ['summary', 'Resumen de alertas'], ['doses', 'Productos químicos aplicados'], ['equipment', 'Equipos de la piscina'], ['checklist', 'Trabajo realizado'], ['notes', 'Observaciones'], ['parts', 'Piezas requeridas'], ['photos', 'Fotos antes / después'], ['footer', 'Pie de página']];
const getPath = (o, path) => path.split('.').reduce((a, k) => (a ? a[k] : undefined), o);
const setPath = (o, path, v) => { const ks = path.split('.'), last = ks.pop(); let t = o; ks.forEach((k) => { t = t[k]; }); t[last] = v; };
function pdfView() {
  const st = S.settings, tgl = (grp, list) => list.map(([k, l]) => `<div class="chk"><span class="t">${esc(l)}</span><label class="sw"><input type="checkbox" data-set="${grp}.${k}"${st[grp][k] ? ' checked' : ''}><i></i></label></div>`).join('');
  const tx = (path, label, ph = '') => fld(label, `<input data-setv="${path}" value="${esc(getPath(st, path) || '')}" placeholder="${esc(ph)}">`);
  const body = `<h2>Logo</h2><div class="card">${st.logo ? `<div style="background:#fff;border:1px solid var(--border);border-radius:12px;padding:10px;text-align:center"><img src="${st.logo.data}" alt="Logo" style="max-width:100%;max-height:110px"></div><div class="btns"><label class="btn sm ghost">Cambiar logo<input type="file" accept="image/*" hidden data-logo="1"></label>${btn('Quitar', 'delLogo', {}, 'sm danger')}</div>` : `${muted('Sube tu logo (PNG o JPG). Se reduce y se guarda en el teléfono.')}<div class="mt-s"></div><label class="btn">📷 Subir logo<input type="file" accept="image/*" hidden data-logo="1"></label>`}
    ${muted('El logo sale en la factura. En el informe de servicio se activa con su propio interruptor.', 'mt-s')}</div>
    <h2>💳 Cobro con ATH Móvil Business</h2><div class="card">${fld('Enlace de pago ATH Móvil Business', `<input data-setv="pay.athLink" type="url" inputmode="url" autocapitalize="off" value="${esc(st.pay.athLink)}" placeholder="https://…">`)}${tx('pay.athPhone', 'Número ATH Móvil Business (opcional)', '939-405-7458')}${tx('pay.athPersonalPhone', 'Número ATH Móvil personal (opcional)', '787-000-0000')}${muted('El número personal se usa cuando eliges «ATH Personal» como método en una factura, para saber a cuál cuenta enviaron el dinero. Pega aquí tu enlace de ATH Móvil Business. Sale en la factura (PDF clicable y texto de WhatsApp) y en la pantalla de la factura. Si lo dejas vacío, solo se muestra el número.')}${st.pay.athLink ? `<div class="mt-s"><a href="${esc(athUrl(st))}" target="_blank" rel="noopener">Probar enlace ↗</a></div>` : ''}</div>
    <h2>👷 Equipo de trabajo</h2><div class="card">${tx('biz.team', 'Nombres separados por coma', 'Carlos, Luis')}${muted('Se usan en Compras para asignar quién compra o instala cada pieza. Si trabajas solo, déjalo con un nombre.')}</div>
    <h2>Datos del negocio</h2><div class="card">${tx('biz.name', 'Nombre')}${tx('biz.tagline', 'Lema (opcional)', 'Mantenimiento de piscinas')}${tx('biz.address', 'Dirección', 'Caguas, Puerto Rico')}${tx('biz.phone', 'Teléfono')}${tx('biz.email', 'Correo')}${tx('biz.regId', 'Registro / Núm. comerciante (opcional)')}${tx('biz.tech', 'Técnico por defecto (informe)')}</div>
    <h2>🧪 Productos químicos que uso</h2><div class="card">${chemSelects(chemPrefs(st.chem), 'data-setv-chem')}${muted('Son los productos predeterminados para calcular dosis. Cada propiedad puede tener los suyos (botón 🧪 en la propiedad).', 'mt-s')}</div>
    <h2>🎯 Valores meta predeterminados</h2><div class="card"><div class="g2">${PARAMS.map((p) => fld(p.label, `<input data-setv="targets.${p.key}" inputmode="decimal" value="${esc(st.targets[p.key])}">`)).join('')}</div></div>
    <h2 id="tpl_sec">🎨 Plantilla de factura y cotización</h2><div class="card"><div class="tplgrid">${DOC_TEMPLATES.map(([k, n, d]) => `<button class="tplc${st.invoice.template === k ? ' on' : ''}" data-act="setTemplate" data-v="${k}" style="--c:${esc(st.invoice.accent || '#0284c7')}">${tplMini(k)}<b>${n}</b><span>${d}</span></button>`).join('')}</div>
    ${muted('Color de acento', 'mt')}<div class="chips mt-s">${ACCENTS.map((c) => `<button class="swatch${(st.invoice.accent || '#0284c7') === c ? ' on' : ''}" data-act="setAccent" data-v="${c}" style="background:${c}" aria-label="${c}"></button>`).join('')}</div>${muted('Usa «👁 Factura» abajo para ver cómo queda.', 'mt-s')}</div>
    <h2>📐 Distribución de la factura</h2><div class="card"><div class="tplgrid">${INV_LAYOUTS.map(([k, n, d]) => `<button class="tplc${(INV_LAYOUTS.some((x) => x[0] === st.invoice.layout) ? st.invoice.layout : 'twocol') === k ? ' on' : ''}" data-act="setLayout" data-v="${k}" style="--c:${esc(st.invoice.accent || '#0284c7')}">${layMini(k)}<b>${n}</b><span>${d}</span></button>`).join('')}</div>
    <div class="fld mt"><label>Condiciones de pago por defecto (se pueden cambiar en cada factura)</label><select data-setv="invoice.termsCode">${optList(TERMS, st.invoice.termsCode || 'NET15')}</select></div>${muted('«Vence a la entrega» = vence el mismo día que se emite. «Fin de mes» = último día del mes de emisión. Se muestra en la factura y en el mensaje.', 'mt-s')}</div>
    <h2>🧾 Recibo de pago</h2><div class="card">${tgl('receipt', [['ask', 'Ofrecer enviar un recibo al marcar pagada / registrar un pago']])}${fld('Mensaje al final del recibo', `<input data-setv="receipt.msg" value="${esc(st.receipt.msg)}">`)}${muted('Al registrar un pago se abre el envío con el recibo listo (PDF o texto, según la preferencia del cliente). Solo tocas Enviar. Si lo apagas, puedes enviarlo con el botón 🧾 de cada pago.', 'mt-s')}</div>
    <h2>📝 Cotizaciones</h2><div class="card">${fld('Días de vigencia por defecto', `<input data-setv="quote.validDays" inputmode="numeric" value="${esc(st.quote.validDays)}">`)}${fld('Condiciones (salen al final del PDF)', `<textarea data-setv="quote.terms" style="min-height:70px">${esc(st.quote.terms)}</textarea>`)}${fld('Por qué elegirnos (una razón por línea; revísalas: que sean ciertas para tu negocio)', `<textarea data-setv="quote.why" style="min-height:110px">${esc(st.quote.why)}</textarea>`)}${fld('Texto del pie', `<input data-setv="quote.footerText" value="${esc(st.quote.footerText)}">`)}<div class="chk"><span class="t">Línea de firma «Aceptada por»</span><label class="sw"><input type="checkbox" data-set="quote.accept"${st.quote.accept ? ' checked' : ''}><i></i></label></div></div>
    <h2>🧾 Factura — qué incluir</h2><div class="card">${tgl('auto', [['invoices', 'Crear solas las facturas de cuota mensual al empezar cada mes (quedan como borrador para que las revises y envíes)']])}${tgl('invoice', INV_OPTS)}
    ${fld('Términos', `<textarea data-setv="invoice.termsText" style="min-height:70px">${esc(st.invoice.termsText)}</textarea>`)}${fld('Texto del pie', `<input data-setv="invoice.footerText" value="${esc(st.invoice.footerText)}">`)}</div>
    <h2>📄 Informe de servicio — qué incluir</h2><div class="card">${tgl('report', REP_OPTS)}
    ${fld('Texto del pie', `<input data-setv="report.footerText" value="${esc(st.report.footerText)}">`)}</div>
    ${btn('Restaurar opciones originales', 'resetPdf', {}, 'sm ghost')}`;
  const footer = `<div class="btns" style="margin-top:0">${btn('👁 Factura', 'previewPdf', { kind: 'invoice' })}${btn('👁 Informe', 'previewPdf', { kind: 'report' }, 'ghost')}</div>`;
  return { title: 'Ajustes, equipo y PDF', body, footer };
}

/* =====================================================================
   Cotizaciones
   ===================================================================== */
const Q_COLOR = { DRAFT: COL.pending, SENT: COL.water, APPROVED: COL.ok, REJECTED: COL.bad, EXPIRED: COL.warn };
const invModeSeg = () => seg(UI.invMode || 'invoices', [['invoices', '🧾 Facturas'], ['quotes', '📝 Cotizaciones']], 'setInvMode');
function quotesTab() {
  const f = UI.qFilter || 'ALL', all = T('quotes');
  const list = all.filter((q) => f === 'ALL' || quoteStatus(q) === f).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const sum = (arr) => arr.reduce((s, q) => s + quoteTotals(q).total, 0);
  const pend = all.filter((q) => ['DRAFT', 'SENT'].includes(quoteStatus(q))), won = all.filter((q) => q.status === 'APPROVED');
  let h = invModeSeg() + `<div class="row mb mt"><div class="card grow" style="margin:0">${muted('Pendientes (' + pend.length + ')')}<div class="big" style="color:${COL.water}">${money(sum(pend))}</div></div><div class="card grow" style="margin:0">${muted('Aprobadas (' + won.length + ')')}<div class="big" style="color:${COL.ok}">${money(sum(won))}</div></div></div>
    ${btn('📋 Catálogo de servicios y precios', 'openCatalog', {}, 'ghost')}<div class="mt"></div>
    <div class="chips">${chip('Todas', f === 'ALL', 'setQFilter', { v: 'ALL' })}${Object.keys(QUOTE_LABEL).map((s) => chip(QUOTE_LABEL[s], f === s, 'setQFilter', { v: s }, Q_COLOR[s])).join('')}</div>`;
  h += list.length ? '<div class="cols">' + list.map((q) => { const st = quoteStatus(q), w = quoteWho(q, S.db); return `<div class="card bar tap" style="border-left-color:${Q_COLOR[st]}" data-act="openQuote" data-id="${q.id}"><div class="row between"><b>${esc(w.name)}${q.client_id ? '' : ' <span class="muted">(prospecto)</span>'}</b>${badge(QUOTE_LABEL[st], Q_COLOR[st])}</div>${muted(esc(q.number) + ' · vigencia ' + fmtDate(q.valid_until))}<div class="amount mt-s">${money(quoteTotals(q).total)}</div></div>`; }).join('') + '</div>'
    : empty(all.length ? 'No hay cotizaciones con este estado.' : 'Aún no hay cotizaciones. Toca «+ Cotización» para crear la primera.');
  h += `<div class="mt"></div>${btn('🎨 Cambiar plantilla de factura y cotización', 'openTemplates', {}, 'sm ghost')}`;
  return { title: 'Cotizaciones', sub: `${all.length} en total`, right: btn('+ Cotización', 'newQuote', {}, 'sm'), body: h };
}
function quoteView(id) {
  const q = find('quotes', id);
  if (!q) return { title: '—', body: empty('Cotización no encontrada.') };
  const w = quoteWho(q, S.db), t = quoteTotals(q), st = quoteStatus(q), o = q.order_id && find('workOrders', q.order_id);
  let h = `<div class="card"><div class="row between"><b>${esc(w.name)}</b>${badge(QUOTE_LABEL[st], Q_COLOR[st])}</div>${q.client_id ? '' : muted('Prospecto (todavía no es cliente)', 'mt-s')}
    ${w.phone ? `<div class="mt-s">📞 ${esc(w.phone)}</div>` : ''}${w.email ? `<div>✉️ ${esc(w.email)}</div>` : ''}${w.address ? `<div>📍 ${esc(w.address)}</div>` : ''}
    ${muted('Vigencia hasta ' + fmtDate(q.valid_until), 'mt-s')}</div>
    <h2>Detalle</h2><div class="card">${q.lines.map((l) => `<div class="row between" style="padding:6px 0"><span>${esc(l.description)}${+l.qty !== 1 ? muted(l.qty + ' × ' + money(l.price)) : ''}</span><b>${money((+l.qty || 0) * (+l.price || 0))}</b></div>`).join('')}
    ${t.disc > 0 ? `<div class="row between" style="padding:6px 0;color:var(--muted)"><span>Descuento</span><span>-${money(t.disc)}</span></div>` : ''}
    <div class="row between" style="border-top:1px solid var(--border);margin-top:6px;padding-top:8px"><b style="font-size:18px">Total</b><span class="amount">${money(t.total)}</span></div></div>
    ${q.notes ? `<div class="card note"><b>Notas</b><div>${esc(q.notes)}</div></div>` : ''}
    <h2>Estado</h2>${seg(q.status, [['DRAFT', 'Borrador'], ['SENT', 'Enviada'], ['APPROVED', 'Aprobada'], ['REJECTED', 'Rechazada']], 'setQuoteStatus', { id: q.id })}${st === 'EXPIRED' ? muted('La vigencia ya pasó. Edita la fecha para reactivarla.', 'mt-s') : ''}`;
  if (q.status === 'APPROVED') h += `<div class="card mt" style="border-color:${COL.ok}"><b>✅ Aprobada</b>${o ? muted('Orden de trabajo creada (pestaña Órdenes).') : muted('Conviértela en trabajo para llevar el seguimiento y cobrarlo en la factura.')}<div class="mt-s"></div>${q.client_id ? (o ? '' : btn('🛠 Crear orden de trabajo', 'quoteToOrder', { id: q.id })) : btn('👤 Guardar prospecto como cliente', 'quoteToClient', { id: q.id })}</div>`;
  h += `<div class="mt"></div><div class="btns">${btn('✏️ Editar', 'editQuote', { id: q.id }, 'sm ghost')}${btn('⧉ Duplicar', 'dupQuote', { id: q.id }, 'sm ghost')}${btn('👁 PDF', 'previewQuote', { id: q.id }, 'sm ghost')}</div><div class="mt-s"></div>${btn('Eliminar cotización', 'delQuote', { id: q.id }, 'sm danger')}`;
  return { title: `Cotización ${q.number}`, body: h, footer: btn('📤 Enviar cotización', 'sendQuote', { id: q.id }) };
}
const qdNew = () => ({ id: null, mode: activeClients().length ? 'client' : 'prospect', client_id: '', prospect: { name: '', phone: '', email: '', address: '' }, lines: [{ description: '', qty: '1', price: '' }], discount: '', notes: '', valid_until: addDays(todayISO(), +S.settings.quote.validDays || 15), tpl: 'blank', title: '', intro: '', scope: '', freq: '', chem: '', why: true });
function openQuoteForm(id) {
  const q = id && find('quotes', id);
  UI.qd = q ? { id: q.id, mode: q.client_id ? 'client' : 'prospect', client_id: q.client_id || '', prospect: { name: '', phone: '', email: '', address: '', ...(q.prospect || {}) }, lines: q.lines.map((l) => ({ description: l.description, qty: String(l.qty), price: String(l.price) })), discount: q.discount ? String(q.discount) : '', notes: q.notes || '', valid_until: q.valid_until, tpl: 'edit', title: q.title || '', intro: q.intro || '', scope: q.scope || '', freq: q.freq || '', chem: q.chem || '', why: q.why !== false } : qdNew();
  openSheet(q ? 'Editar cotización' : 'Nueva cotización', '<div id="qbox"></div>');
  renderQ();
}
const qdTotal = () => { const Q = UI.qd; return quoteTotals({ lines: Q.lines.map((l) => ({ qty: toNum(l.qty) || 0, price: toNum(l.price) || 0 })), discount: toNum(Q.discount) || 0 }).total; };
function renderQ() {
  const b = document.getElementById('qbox'), Q = UI.qd; if (!b || !Q) return;
  const act = activeClients(); if (Q.mode === 'client' && !Q.client_id && act.length) Q.client_id = act[0].id;
  const pf = (k, l, ex = '') => `<div class="fld"><label>${l}</label><input data-qp="${k}" value="${esc(Q.prospect[k])}" ${ex}></div>`;
  b.innerHTML = `${seg(Q.mode, [['client', 'Cliente existente'], ['prospect', 'Prospecto nuevo']], 'qMode')}<div class="mt"></div>
    ${Q.mode === 'client' ? fld('Cliente', `<select id="q_client">${optList(act.map((c) => [c.id, c.name]), Q.client_id)}</select>`) : `${pf('name', 'Nombre *')}${pf('phone', 'Teléfono (WhatsApp)', 'type="tel"')}${pf('email', 'Email', 'type="email"')}${pf('address', 'Dirección del servicio')}`}
    <h2>Tipo de propuesta</h2>
    ${Q.tpl === 'edit' ? '' : `${muted('Elige una plantilla y se llena sola: tú solo pones el cliente y los precios.')}<div class="chips mt-s">${Object.entries(QUOTE_TPLS).map(([k, t]) => chip(t.name, Q.tpl === k, 'qTpl', { k })).join('')}</div>`}
    ${fld('Título de la propuesta', `<input data-qf="title" value="${esc(Q.title)}" placeholder="Ej. Propuesta de mantenimiento de piscina comercial">`)}
    ${fld('Introducción (usa {cliente} para el nombre)', `<textarea data-qf="intro" style="min-height:80px">${esc(Q.intro)}</textarea>`)}
    ${fld('Qué incluye (una cosa por línea)', `<textarea data-qf="scope" style="min-height:130px">${esc(Q.scope)}</textarea>`)}
    ${fld('Frecuencia', `<input data-qf="freq" value="${esc(Q.freq)}" placeholder="Ej. 2 visitas por semana">`)}
    <div class="fld"><label>Productos químicos</label><div class="chips">${[['', 'No mencionar'], ['incl', 'Incluidos en el precio'], ['extra', 'Se facturan aparte']].map(([v, l]) => chip(l, Q.chem === v, 'qChem', { v })).join('')}</div></div>
    <div class="chk"><span class="t">Incluir «Por qué elegirnos» (se edita en Ajustes)</span><label class="sw"><input type="checkbox" data-qwhy="1"${Q.why ? ' checked' : ''}><i></i></label></div>
    <h2>Servicios y precios</h2>
    ${S.settings.catalog.length ? `${muted('Toca para añadir del catálogo')}<div class="chips mt-s">${S.settings.catalog.map((x, i) => chip(`${x.name} · ${money(x.price)}`, false, 'qAddCat', { i })).join('')}</div>` : ''}
    ${Q.lines.map((l, i) => `<div class="card" style="padding:10px"><div class="fld" style="margin-bottom:8px"><label>Descripción</label><input data-ql="${i}:description" value="${esc(l.description)}" placeholder="Ej. Cambio de arena del filtro"></div>
      <div class="g2"><div class="fld" style="margin:0"><label>Cantidad</label><input data-ql="${i}:qty" inputmode="decimal" value="${esc(l.qty)}"></div><div class="fld" style="margin:0"><label>Precio ($)</label><input data-ql="${i}:price" inputmode="decimal" value="${esc(l.price)}"></div></div>
      ${Q.lines.length > 1 ? `<button class="btn sm ghost mt-s" data-act="qDel" data-i="${i}">Quitar línea</button>` : ''}</div>`).join('')}
    ${btn('+ Línea en blanco', 'qAddLine', {}, 'sm ghost')}
    <h2>Detalles</h2>${fld('Descuento ($, opcional)', `<input id="q_disc" inputmode="decimal" value="${esc(Q.discount)}">`)}${fld('Válida hasta', `<input id="q_valid" type="date" value="${esc(Q.valid_until)}">`)}${fld('Notas para el cliente (opcional)', `<textarea id="q_notes">${esc(Q.notes)}</textarea>`)}
    <div class="card"><div class="row between"><b>Total</b><span class="amount" id="q_tot">${money(qdTotal())}</span></div></div>${btn('Guardar cotización', 'saveQuote')}`;
}
function openCatalog() { UI.cat = true; openSheet('📋 Catálogo de servicios', '<div id="catbox"></div>'); renderCat(); }
function renderCat() {
  const b = document.getElementById('catbox'); if (!b) return;
  b.innerHTML = `${muted('Tus servicios y precios de siempre. Al cotizar los añades con un toque (luego puedes cambiar el precio en esa cotización).')}<div class="mt"></div>
    ${S.settings.catalog.map((x, i) => `<div class="card" style="padding:10px"><div class="fld" style="margin-bottom:8px"><label>Servicio</label><input data-cat="${i}:name" value="${esc(x.name)}" placeholder="Ej. Limpieza profunda de piscina"></div><div class="g2"><div class="fld" style="margin:0"><label>Precio ($)</label><input data-cat="${i}:price" inputmode="decimal" value="${x.price || ''}"></div><div style="display:flex;align-items:flex-end"><button class="btn sm ghost" data-act="catDel" data-i="${i}" style="width:100%">Quitar</button></div></div></div>`).join('') || empty('El catálogo está vacío.')}
    ${btn('+ Añadir servicio', 'catAdd', {}, 'ghost')}<div class="mt-s"></div>${btn('Listo', 'closeSheet')}`;
}
const layMini = (k) => {
  const g = '<i style="display:block;height:4px;border-radius:2px;background:#e2e8f0;margin:3px 0"></i>', ac = 'var(--c)', bar = `<i style="display:block;height:6px;background:${ac};margin:4px 0"></i>`;
  const two = '<div style="display:flex;gap:4px"><i style="flex:1;height:14px;background:#eef2f7;border-radius:2px"></i><i style="flex:1;height:14px;background:#eef2f7;border-radius:2px"></i></div>';
  if (k === 'summary') return `<div class="tm"><i style="display:block;height:9px;background:${ac};margin-bottom:4px"></i>${two}${bar}${g}${g}</div>`;
  if (k === 'plain') return `<div class="tm"><div style="display:flex;gap:4px"><i style="flex:1;height:12px;border:1px solid #cbd5e1;border-radius:2px"></i><i style="flex:1;height:12px;border:1px solid #cbd5e1;border-radius:2px"></i></div><i style="display:block;height:1px;background:#334155;margin:6px 0"></i>${g}${g}<i style="display:block;height:1px;width:45%;margin-left:55%;background:#334155;margin-top:5px"></i></div>`;
  if (k === 'side') return `<div class="tm">${two}${bar}${g}${g}<div style="display:flex;gap:6px;margin-top:4px"><i style="flex:1;height:12px;background:#eef2f7;border:1px solid #cbd5e1"></i><i style="flex:1;height:12px;background:${ac}"></i></div></div>`;
  return `<div class="tm">${two}${bar}${g}${g}<i style="display:block;height:7px;width:50%;margin-left:50%;background:${ac};margin-top:4px"></i></div>`;
};
const tplMini = (k) => {
  const g = '<i style="display:block;height:4px;border-radius:2px;background:#e2e8f0;margin:3px 0"></i>', ac = 'var(--c)';
  if (k === 'side') return `<div class="tm" style="border-left:7px solid ${ac};padding-left:4px"><i style="display:block;height:5px;width:45%;background:#334155;border-radius:2px"></i><i style="display:block;height:1px;background:${ac};margin:5px 0"></i>${g}<i style="display:block;height:7px;background:${ac};margin:4px 0"></i>${g}</div>`;
  if (k === 'frame') return `<div class="tm"><div style="background:#eef6fb;border:1px solid #bcd9ea;border-bottom:3px solid ${ac};height:20px;margin-bottom:6px"></div>${g}<i style="display:block;height:7px;background:${ac};margin:4px 0"></i>${g}</div>`;
  if (k === 'bold') return `<div class="tm"><div style="display:flex;justify-content:space-between;align-items:center"><i style="display:block;height:10px;width:52%;background:${ac};border-radius:2px"></i><i style="display:block;height:8px;width:20%;background:#cbd5e1;border-radius:3px"></i></div><i style="display:block;height:3px;background:${ac};margin:5px 0"></i>${g}<i style="display:block;height:7px;background:${ac};margin:4px 0"></i>${g}</div>`;
  return `<div class="tm"><i style="display:block;height:5px;width:45%;background:#334155;border-radius:2px"></i><i style="display:block;height:3px;background:${ac};margin:5px 0"></i>${g}<i style="display:block;height:7px;background:${ac};margin:4px 0"></i>${g}</div>`;
};

/* --- calculadora de dosis --- */
const calcState = () => (UI.calc ||= { propId: '', gal: '', vals: {}, targets: {}, prefs: null });
function calcPrefs() { const c = calcState(), p = c.propId && find('properties', c.propId); return c.prefs || chemPrefs(S.settings.chem, p && p.chem); }
function calcOutHtml() {
  const c = calcState(), gal = toNum(c.gal);
  if (!gal) return muted('Escribe los galones de la piscina para calcular.', 'mt');
  const nums = Object.fromEntries(PARAMS.map((p) => [p.key, numOf(c.vals[p.key])]));
  if (PARAMS.every((p) => nums[p.key] == null)) return muted('Escribe al menos una lectura del agua.', 'mt');
  const tg = { ...numTargets(), ...Object.fromEntries(Object.entries(c.targets).map(([k, v]) => [k, toNum(v)]).filter(([, v]) => v != null)) };
  const doses = suggestDoses(nums, gal, { prefs: calcPrefs(), targets: tg, exact: true });
  if (!doses.length) return `<div class="card dose mt"><b>✅ Todo está en la meta</b>${muted('No hace falta agregar nada con estos valores.')}</div>`;
  return `<div class="card dose mt"><b>Qué echarle (${gal.toLocaleString('es-PR')} gal)</b>${doseHtml(doses, () => '')}${muted('Estimado de campo: verifica la etiqueta del producto, aplica en dosis divididas si el ajuste es grande, deja circular y vuelve a medir. Con el agua en movimiento, no mezcles productos entre sí.', 'mt-s')}</div>`;
}
function chemSelects(prefsObj, attr, pre) {
  return CHEM_CATS.map((c) => fld(c.l, `<select ${attr}="${c.k}">${pre ? `<option value="">${esc(pre(c))}</option>` : ''}${optList(Object.entries(c.list).map(([k, v]) => [k, v.name]), prefsObj[c.k])}</select>`)).join('');
}
function calcView() {
  const c = calcState(), props = T('properties').filter((p) => { const cl = find('clients', p.client_id); return cl && cl.status === 'ACTIVE'; });
  const propSel = `<select data-calcprop="1"><option value="">— Sin propiedad (valores generales) —</option>${optList(props.map((p) => [p.id, `${(find('clients', p.client_id) || {}).name} — ${p.address}`]), c.propId)}</select>`;
  const tg = numTargets();
  const body = `${muted('Escribe cómo está el agua, a dónde quieres llevarla y qué productos usas. Te digo cuánto echarle.')}
    <div class="card">${fld('Propiedad (opcional: usa sus productos y su volumen)', propSel)}${fld('Galones de la piscina', `<input data-calc="gal" inputmode="decimal" value="${esc(c.gal)}" placeholder="Ej. 15000">`)}</div>
    <h2>Lecturas actuales</h2><div class="card"><div class="g2">${PARAMS.map((p) => fld(`${p.label}${p.unit ? ' (' + p.unit + ')' : ''}`, `<input data-calc="v.${p.key}" inputmode="decimal" value="${esc(c.vals[p.key] ?? '')}" placeholder="${p.ok[0]}–${p.ok[1]}">`)).join('')}</div></div>
    <h2>A dónde quiero llevarlos (meta)</h2><div class="card"><div class="g2">${PARAMS.map((p) => fld(p.label, `<input data-calc="t.${p.key}" inputmode="decimal" value="${esc(c.targets[p.key] ?? '')}" placeholder="${tg[p.key] ?? DEFAULT_TARGETS[p.key]}">`)).join('')}</div>${muted('Si lo dejas vacío usa la meta de Ajustes (por defecto: pH 7.4, cloro 3, alcalinidad 90, CYA 40, calcio 300, sal 3200).', 'mt-s')}</div>
    <h2>Productos que uso</h2><div class="card">${chemSelects(calcPrefs(), 'data-calcp')}${muted('Se llenan con tus productos predeterminados (Ajustes) o los de la propiedad. Aquí puedes cambiarlos solo para este cálculo.', 'mt-s')}</div>
    <div id="calc_out">${calcOutHtml()}</div>
    <div class="mt"></div>${btn('Limpiar', 'calcReset', {}, 'ghost')}`;
  return { title: '🧮 Calculadora de dosis', body };
}
const VIEW_FN = { calc: calcView, stop: stopView, client: clientView, order: orderView, invoice: invoiceView, pdf: pdfView, quote: quoteView };

const bannerHtml = () => (!online() ? `<div class="banner off">Modo Offline Activo - Datos guardados localmente${S.queue.length ? ` (${S.queue.length} por sincronizar)` : ''}</div>` : S.queue.length ? `<div class="banner">${UI.syncing ? 'Sincronizando' : 'En cola de sincronización:'} ${S.queue.length} cambio(s)…</div>` : '');
const page = (b) => `<div class="page" id="page">${b}</div>`;

function shellHtml() {
  const t = TAB_FN[UI.tab]();
  return `<div class="shell"><div class="side"><div class="brand">Elite Pool Service PR</div><small>Skimmer Mobile Edition</small>${TABS.map(([k, i, l]) => `<button class="${UI.tab === k ? 'on' : ''}" data-act="tab" data-v="${k}"><span style="font-size:20px">${i}</span>${l}</button>`).join('')}</div>
    <div class="main">${bannerHtml()}<div class="top"><div class="grow"><h1>${esc(t.title)}</h1>${t.sub ? `<div class="muted">${esc(t.sub)}</div>` : ''}</div>${t.right || ''}</div>${page(t.body)}
    <nav class="nav">${TABS.map(([k, i, l]) => `<button class="${UI.tab === k ? 'on' : ''}" data-act="tab" data-v="${k}"><span class="ic">${i}</span>${l}</button>`).join('')}</nav></div></div>`;
}
function viewHtml() {
  const v = VIEW_FN[UI.view.type](UI.view.id);
  return `<div class="view">${bannerHtml()}<div class="hd"><button class="back" data-act="back">‹ Volver</button><div class="ttl">${esc(v.title)}</div></div>${page(v.body)}${v.footer ? `<div class="ft">${v.footer}</div>` : ''}</div>`;
}
let lastKey = '';
function render() {
  const app = $('#app');
  if (!app || !S.db) return;
  if (UI.locked) { lockRender(); return; }
  const key = UI.view ? UI.view.type + UI.view.id : UI.tab;
  const old = document.getElementById('page'), st = old && lastKey === key ? old.scrollTop : 0;
  const ae = document.activeElement, fid = ae && ae.id && app.contains(ae) ? ae.id : null, sel = fid && ae.selectionStart;
  app.innerHTML = UI.view ? viewHtml() : shellHtml();
  const np = document.getElementById('page');
  if (np) np.scrollTop = st;
  lastKey = key;
  initMap();
  if (fid) { const el = document.getElementById(fid); if (el) { el.focus(); try { el.setSelectionRange(sel, sel); } catch (e) { /* tipo sin selección */ } } }
}
function openSheet(title, html, noReset) {
  $('#layer').innerHTML = `<div class="back-drop" data-act="closeSheet"></div><div class="sheet"><div class="sh"><b>${esc(title)}</b><button class="x" data-act="closeSheet">✕</button></div>${html}</div>`;
  if (!noReset) UI.dispatch = null;
}
function closeSheet() { $('#layer').innerHTML = ''; UI.dispatch = null; UI.form = null; UI.cal = null; UI.qd = null; if (UI.cat) { UI.cat = false; S.settings.catalog = S.settings.catalog.filter((x) => (x.name || '').trim()); persist(); } }
const sheetOpen = () => !!($('#layer') && $('#layer').firstChild);
function go(type, id) { UI.view = { type, id }; render(); }

/* =====================================================================
   Acciones (clics)
   ===================================================================== */

/* =====================================================================
   Clave de acceso (pantalla de bloqueo)
   Protege contra curiosos o cambios accidentales; los datos no se cifran.
   ===================================================================== */
const toHex = (u) => [...u].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));
async function hashPin(pin, saltHex) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  return toHex(new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromHex(saltHex), iterations: 120000 }, key, 256)));
}
const AUTO_OPTS = [[1, '1 min'], [5, '5 min'], [15, '15 min'], [-1, 'Solo al abrir']];
function lockNow() { if (!S.lock) return; UI.locked = true; UI.pin = ''; UI.pinErr = ''; UI.view = null; closeSheet(); render(); }
function lockHtml() {
  const L = S.lock, wait = Math.max(0, Math.ceil(((L.until || 0) - Date.now()) / 1000));
  const dots = Array.from({ length: L.len }, (_, i) => `<i class="${i < UI.pin.length ? 'on' : ''}"></i>`).join('');
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'].map((k) => (k === '' ? '<span></span>' : `<button data-act="pinKey" data-k="${k}"${wait ? ' disabled' : ''}>${k}</button>`)).join('');
  return `<div class="lockscr"><div class="lk-ic">🔒</div><h1>Elite Pool Service PR</h1><div class="muted">${wait ? 'Demasiados intentos' : 'Escribe tu clave'}</div>
    <div class="dots">${dots}</div><div class="lk-err">${wait ? `Espera ${wait} s para volver a intentar.` : esc(UI.pinErr || '')}</div><div class="keypad">${keys}</div>
    <details class="lk-help"><summary>Olvidé mi clave</summary>La clave no se puede recuperar. Si tienes un respaldo (.json), borra los datos del sitio en Chrome (Configuración → Configuración de sitios → Todos los sitios → este sitio → Borrar y restablecer), abre la app y usa «Restaurar desde un respaldo».</details></div>`;
}
function lockRender() {
  const app = $('#app'); if (!app) return;
  app.innerHTML = lockHtml();
  clearInterval(UI.lockTimer); UI.lockTimer = null;
  if (S.lock && S.lock.until > Date.now()) UI.lockTimer = setInterval(() => { if (!UI.locked || S.lock.until <= Date.now()) { clearInterval(UI.lockTimer); UI.lockTimer = null; } if (UI.locked) lockRender(); }, 1000);
}
async function tryPin() {
  const L = S.lock; if (!L || UI.checking) return;
  UI.checking = true;
  const okp = (await hashPin(UI.pin, L.salt)) === L.hash;
  UI.checking = false;
  if (okp) { L.fails = 0; L.until = 0; UI.locked = false; UI.pin = ''; UI.pinErr = ''; clearInterval(UI.lockTimer); UI.lockTimer = null; persist(); render(); return; }
  L.fails = (L.fails || 0) + 1; UI.pin = '';
  if (L.fails % 5 === 0) { L.until = Date.now() + Math.min(900, 30 * 2 ** (L.fails / 5 - 1)) * 1000; UI.pinErr = ''; }
  else UI.pinErr = `Clave incorrecta (${5 - (L.fails % 5)} intento(s) antes de esperar)`;
  persist(); lockRender();
}
function pinSheet(mode) { // 'set' | 'change' | 'remove'
  const cur = mode !== 'set' ? fld('Clave actual', '<input id="lk_cur" type="password" inputmode="numeric" maxlength="6" autocomplete="off">') : '';
  const nw = mode !== 'remove' ? fld('Clave nueva (4 a 6 números)', '<input id="lk_a" type="password" inputmode="numeric" maxlength="6" autocomplete="off">') + fld('Repite la clave', '<input id="lk_b" type="password" inputmode="numeric" maxlength="6" autocomplete="off">') : '';
  openSheet(mode === 'set' ? 'Crear clave' : mode === 'change' ? 'Cambiar clave' : 'Quitar clave', `${cur}${nw}${mode === 'set' ? muted('Si la olvidas no hay forma de recuperarla; mantén tu respaldo al día.') : ''}<div class="mt"></div>${btn(mode === 'remove' ? 'Quitar clave' : 'Guardar clave', 'savePin', { mode }, mode === 'remove' ? 'danger' : '')}`);
}
function setupAutoLock() {
  document.addEventListener('visibilitychange', () => {
    if (!S.lock) return;
    if (document.hidden) { UI.hiddenAt = Date.now(); return; }
    const mins = S.lock.auto ?? 5;
    if (!UI.locked && mins >= 0 && UI.hiddenAt && Date.now() - UI.hiddenAt >= mins * 60000) lockNow();
  });
}

/* =====================================================================
   Fechas específicas (Airbnb / renta a corto plazo): calendario del mes
   p.dates = [{ d: 'AAAA-MM-DD', t: 'HH:MM' | '' }]   (se suman a los días fijos de la semana)
   ===================================================================== */
const MONTHS = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const fmtHM = (t) => { if (!t) return ''; const [h, m] = t.split(':').map(Number); return `${h % 12 || 12}:${pad2(m)} ${h < 12 ? 'a. m.' : 'p. m.'}`; };
const dateEntry = (p, iso) => (p.dates || []).find((x) => x.d === iso);
const propDaysText = (p) => { const w = (p.service_days || []).length ? daysText(p) : '', n = (p.dates || []).filter((x) => x.d >= todayISO()).length; return [w, n ? `${n} fecha(s) específicas` : ''].filter(Boolean).join(' · ') || 'sin días asignados'; };
function calHtml() {
  const C = UI.cal, p = C && find('properties', C.pid); if (!p) return '';
  const iso = (d) => `${C.y}-${pad2(C.m + 1)}-${pad2(d)}`, dim = new Date(C.y, C.m + 1, 0).getDate(), lead = new Date(C.y, C.m, 1).getDay(), today = todayISO();
  let cells = ''.padStart(0); for (let i = 0; i < lead; i++) cells += '<span></span>';
  for (let d = 1; d <= dim; d++) { const on = !!dateEntry(p, iso(d)); cells += `<button class="cd${on ? ' on' : ''}${iso(d) === today ? ' td' : ''}" data-act="calDay" data-d="${iso(d)}">${d}</button>`; }
  const mine = (p.dates || []).filter((x) => x.d.startsWith(`${C.y}-${pad2(C.m + 1)}`)).sort((a, b) => a.d.localeCompare(b.d));
  return `${muted(esc(p.address))}
    <div class="row between mt"><button class="btn sm ghost" data-act="calNav" data-v="-1">‹</button><b>${MONTHS[C.m]} ${C.y}</b><button class="btn sm ghost" data-act="calNav" data-v="1">›</button></div>
    <div class="calw">${DAYS_S.map((x) => `<i>${x}</i>`).join('')}</div><div class="calg">${cells}</div>
    ${muted('Toca los días en que se le da servicio. Toca otra vez para quitarlo.', 'mt-s')}
    <div class="fld mt"><label>Hora para las fechas nuevas (opcional)</label><input type="time" id="cal_def" value="${esc(p.def_time || '')}"></div>
    <b>Fechas de ${MONTHS[C.m].toLowerCase()} (${mine.length})</b>
    ${mine.length ? mine.map((x) => `<div class="row mt-s"><span class="grow">${DAYS_S[new Date(x.d + 'T12:00:00').getDay()]} ${+x.d.slice(8)}</span><input type="time" data-caltime="${x.d}" value="${esc(x.t || '')}" style="min-height:44px;padding:6px 10px;border:1.5px solid var(--border);border-radius:10px"><button class="x" data-act="calDay" data-d="${x.d}" style="font-size:18px;color:var(--bad);padding:6px 10px">✕</button></div>`).join('') : muted('Aún no hay fechas este mes.', 'mt-s')}
    ${mine.length ? `<div class="mt"></div>${btn('Quitar todas las de este mes', 'calClear', {}, 'sm ghost')}` : ''}`;
}
function openCal(pid) {
  const d = new Date(); UI.cal = { pid, y: d.getFullYear(), m: d.getMonth() };
  const p = find('properties', pid);
  openSheet('📅 Airbnb / fechas específicas', '<div id="calbox"></div>');
  const b = document.getElementById('calbox'); if (b) b.innerHTML = calHtml();
}
function renderCal() { const b = document.getElementById('calbox'); if (b) b.innerHTML = calHtml(); }
function saveDates(p, dates) { upsert('properties', { ...p, dates: dates.sort((a, b) => a.d.localeCompare(b.d)) }); renderCal(); }

const A = {
  noop() {},
  setInvMode: (d) => { UI.invMode = d.v; render(); },
  remind: (d) => {
    const dt = debtors().find((x) => x.c.id === d.id); if (!dt) return toast('Ya no tiene balance vencido');
    openDispatch(dt.c.id, 'BROADCAST', reminderDoc(dt), { forceFormat: 'TEXT', after: () => upsert('clients', { ...find('clients', dt.c.id), last_reminder: todayISO() }) });
  },
  snoozeBackup: () => { UI.bkSnooze = true; render(); },
  setQFilter: (d) => { UI.qFilter = d.v; render(); },
  setLayout: (d) => { S.settings.invoice.layout = d.v; persist(); render(); },
  setTemplate: (d) => { S.settings.invoice.template = d.v; persist(); render(); },
  setAccent: (d) => { S.settings.invoice.accent = d.v; persist(); render(); },
  qTpl: (d) => {
    const Q = UI.qd, t = QUOTE_TPLS[d.k]; Q.tpl = d.k;
    Q.title = t.title; Q.intro = t.intro; Q.scope = t.scope; Q.freq = t.freq;
    if (d.k !== 'blank' || !Q.lines.some((l) => l.description.trim() || l.price)) Q.lines = (t.lines.length ? t.lines : [{ description: '', qty: '1', price: '' }]).map((l) => ({ ...l }));
    renderQ();
  },
  qChem: (d) => { UI.qd.chem = d.v; renderQ(); },
  newQuote: () => openQuoteForm(), editQuote: (d) => openQuoteForm(d.id), openQuote: (d) => go('quote', d.id),
  qMode: (d) => { UI.qd.mode = d.v; renderQ(); },
  qAddLine: () => { UI.qd.lines.push({ description: '', qty: '1', price: '' }); renderQ(); },
  qAddCat: (d) => { const x = S.settings.catalog[+d.i], L = UI.qd.lines; if (L.length === 1 && !L[0].description && !L[0].price) L.length = 0; L.push({ description: x.name, qty: '1', price: String(x.price || '') }); renderQ(); },
  qDel: (d) => { UI.qd.lines.splice(+d.i, 1); renderQ(); },
  saveQuote: () => {
    const Q = UI.qd, lines = Q.lines.map((l) => ({ description: (l.description || '').trim(), qty: toNum(l.qty) || 0, price: toNum(l.price) || 0 })).filter((l) => l.description);
    if (Q.mode === 'prospect' && !Q.prospect.name.trim()) return toast('Falta el nombre del prospecto');
    if (Q.mode === 'client' && !Q.client_id) return toast('Elige un cliente');
    if (!lines.length) return toast('Agrega al menos un servicio con descripción');
    const old = Q.id && find('quotes', Q.id), pr = Q.prospect;
    const q = { id: old ? old.id : uid('q'), number: old ? old.number : nextQuoteNumber(S.db), client_id: Q.mode === 'client' ? Q.client_id : null, prospect: Q.mode === 'prospect' ? { name: pr.name.trim(), phone: pr.phone.trim(), email: pr.email.trim(), address: pr.address.trim() } : null, lines, discount: toNum(Q.discount) || 0, notes: Q.notes.trim(), valid_until: Q.valid_until || addDays(todayISO(), 15), status: old ? old.status : 'DRAFT', created_at: old ? old.created_at : new Date().toISOString(), order_id: old ? old.order_id : null, title: Q.title.trim(), intro: Q.intro.trim(), scope: Q.scope.trim(), freq: Q.freq.trim(), chem: Q.chem, why: Q.why };
    upsert('quotes', q); closeSheet(); go('quote', q.id);
  },
  setQuoteStatus: (d) => upsert('quotes', { ...find('quotes', d.id), status: d.v }),
  sendQuote: (d) => {
    const q = find('quotes', d.id), w = quoteWho(q, S.db);
    openDispatch(q.client_id || null, 'QUOTE', buildQuoteDoc(q, S.settings, S.db), { pseudo: w.client ? null : { name: w.name, phone: w.phone, email: w.email, dispatch_channel_pref: 'WHATSAPP', dispatch_format_pref: 'BOTH' }, after: () => { const cur = find('quotes', q.id); if (cur && cur.status === 'DRAFT') upsert('quotes', { ...cur, status: 'SENT' }); } });
  },
  previewQuote: (d) => { const doc = buildQuoteDoc(find('quotes', d.id), S.settings, S.db); downloadBlob(new Blob([buildPdf(doc.title, doc.lines, doc.opts)], { type: 'application/pdf' }), doc.fileName); toast('PDF generado (revisa Descargas)'); },
  dupQuote: (d) => { const q = find('quotes', d.id), n = { ...JSON.parse(JSON.stringify(q)), id: uid('q'), number: nextQuoteNumber(S.db), status: 'DRAFT', created_at: new Date().toISOString(), valid_until: addDays(todayISO(), +S.settings.quote.validDays || 15), order_id: null }; upsert('quotes', n); go('quote', n.id); toast('Cotización duplicada'); },
  delQuote: (d) => { if (!confirm('¿Eliminar esta cotización?')) return; remove('quotes', d.id); UI.view = null; render(); },
  quoteToClient: (d) => {
    const q = find('quotes', d.id), pr = q.prospect || {}, cid = uid('c');
    upsert('clients', { id: cid, name: pr.name, phone: pr.phone || '', email: pr.email || '', dispatch_channel_pref: 'WHATSAPP', dispatch_format_pref: 'BOTH', status: 'ACTIVE', notes: 'Creado desde la cotización ' + q.number, fee_type: 'MONTHLY', monthly_fee: 0, tags: [], service_days: [] });
    if (pr.address) upsert('properties', { id: uid('p'), client_id: cid, address: pr.address, municipality: '', gate_code: '', access_notes: '', service_days: [], dates: [], lat: DEPOT.lat, lng: DEPOT.lng });
    upsert('quotes', { ...q, client_id: cid }); toast('Guardado como cliente');
  },
  quoteToOrder: (d) => {
    const q = find('quotes', d.id), props = T('properties').filter((p) => p.client_id === q.client_id);
    if (!props.length) return alert('Este cliente no tiene propiedades. Agrega una primero en su ficha.');
    if (props.length === 1) return A.quoteOrderAt({ id: q.id, p: props[0].id });
    openSheet('¿En qué propiedad?', `<div class="chips">${props.map((p) => chip(p.address, false, 'quoteOrderAt', { id: q.id, p: p.id })).join('')}</div>`);
  },
  quoteOrderAt: (d) => {
    const q = find('quotes', d.id), id = uid('wo'), t = quoteTotals(q);
    closeSheet();
    upsert('workOrders', { id, client_id: q.client_id, property_id: d.p, type: 'Reparación de Equipos', status: 'OPEN', description: `Cotización ${q.number}: ` + q.lines.map((l) => l.description).join('; '), price: t.total, checklist: mkChecklist(id, q.lines.map((l) => l.description)), client_note: '', created_at: new Date().toISOString() });
    upsert('quotes', { ...find('quotes', q.id), order_id: id }); toast('Orden de trabajo creada (pestaña Órdenes)');
  },
  openCatalog,
  catAdd: () => { S.settings.catalog.push({ name: '', price: 0 }); renderCat(); },
  catDel: (d) => { S.settings.catalog.splice(+d.i, 1); persist(); renderCat(); },
  openCal: (d) => openCal(d.id),
  calNav: (d) => { const C = UI.cal; C.m += +d.v; if (C.m < 0) { C.m = 11; C.y--; } if (C.m > 11) { C.m = 0; C.y++; } renderCal(); },
  calDay: (d) => { const p = find('properties', UI.cal.pid), has = dateEntry(p, d.d); saveDates(p, has ? p.dates.filter((x) => x.d !== d.d) : [...(p.dates || []), { d: d.d, t: p.def_time || '' }]); },
  calClear: () => { const p = find('properties', UI.cal.pid), pre = `${UI.cal.y}-${pad2(UI.cal.m + 1)}`; saveDates(p, (p.dates || []).filter((x) => !x.d.startsWith(pre))); },
  lockNow,
  pinKey: (d) => { if (UI.checking || !S.lock) return; if (d.k === '⌫') UI.pin = UI.pin.slice(0, -1); else if (UI.pin.length < S.lock.len) UI.pin += d.k; UI.pinErr = ''; lockRender(); if (UI.pin.length === S.lock.len) tryPin(); },
  openPinSetup: () => pinSheet(S.lock ? 'change' : 'set'), openPinRemove: () => pinSheet('remove'),
  setAutoLock: (d) => { S.lock.auto = +d.v; persist(); render(); },
  savePin: async (d) => {
    const v = (id) => ((document.getElementById(id) || {}).value || '').trim();
    if (d.mode !== 'set' && (await hashPin(v('lk_cur'), S.lock.salt)) !== S.lock.hash) return toast('La clave actual no es correcta');
    if (d.mode === 'remove') { S.lock = null; persist(); closeSheet(); render(); return toast('Clave eliminada'); }
    const a = v('lk_a');
    if (!/^\d{4,6}$/.test(a)) return toast('La clave debe tener de 4 a 6 números');
    if (a !== v('lk_b')) return toast('Las dos claves no coinciden');
    const salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
    S.lock = { salt, hash: await hashPin(a, salt), len: a.length, auto: S.lock ? S.lock.auto : 5, fails: 0, until: 0 };
    persist(); closeSheet(); render(); toast('Clave guardada');
  },
  useGps: async () => {
    const msg = document.getElementById('gps_msg'), set = (t) => { if (msg) msg.textContent = t; };
    const la = document.querySelector('#frm [name="lat"]'), ln = document.querySelector('#frm [name="lng"]');
    if (!la || !ln) return;
    set('Buscando señal GPS… espera unos segundos.');
    const f = await getFix(30000, { goal: 8, onProgress: (b) => set(`Afinando señal GPS… precisión actual ±${Math.round(b.acc)} m (espera hasta que baje de 10 m)`) });
    if (f.err) return set(f.err === 'denied' ? 'Chrome no tiene permiso de ubicación. Toca el candado junto a la dirección → Permisos → Ubicación → Permitir.' : 'No se pudo obtener la ubicación. Revisa que el GPS del teléfono esté encendido y sal a cielo abierto.');
    la.value = f.lat.toFixed(6); ln.value = f.lng.toFixed(6);
    const acc = Math.round(f.acc), weak = acc > 20 ? ' Precisión baja: aléjate de techos o árboles y vuelve a tocar el botón.' : '';
    set(`✓ Ubicación guardada (precisión ±${acc} m).${weak}`);
    if (!online()) return;
    const ad = document.querySelector('#frm [name="address"]'), mu = document.querySelector('#frm [name="municipality"]');
    const g = await reverseGeocode(f.lat, f.lng);
    if (g) {
      let filled = false;
      if (ad && !ad.value.trim() && g.address) { ad.value = g.address; filled = true; }
      if (mu && !mu.value.trim() && g.municipality) { mu.value = g.municipality; filled = true; }
      if (filled) set(`✓ Ubicación guardada (±${acc} m). Dirección sugerida: revísala y corrígela si hace falta.${weak}`);
    }
  },
  openCalc: () => { UI.calc = null; go('calc', 'x'); },
  calcReset: () => { UI.calc = null; render(); },
  propChem: (d) => {
    const p = find('properties', d.id); if (!p) return;
    const def = chemPrefs(S.settings.chem), cur = p.chem || {};
    openSheet('🧪 Productos de ' + p.address, `${muted('Elige qué productos usas en ESTA propiedad. Con «predeterminado» usa lo que pusiste en Ajustes.')}<div class="mt-s"></div>${CHEM_CATS.map((c) => fld(c.l, `<select data-pchem="${p.id}:${c.k}"><option value="">${esc('Predeterminado: ' + c.list[def[c.k]].name)}</option>${optList(Object.entries(c.list).map(([k, v]) => [k, v.name]), cur[c.k])}</select>`)).join('')}<div class="mt"></div>${btn('Listo', 'closeSheet')}`);
  },
  openPdfSettings: () => go('pdf', 'x'),
  openTemplates: () => { go('pdf', 'x'); setTimeout(() => { const e = document.getElementById('tpl_sec'); if (e) e.scrollIntoView(); }, 60); },
  viewRef: (d) => { const p = find('properties', d.id); if (p && p.photo) openSheet(esc(p.address), `<img class="refbig" src="${p.photo.uri}" alt="">`); },
  delRef: (d) => { const p = find('properties', d.id); if (p && confirm('¿Quitar la foto de esta propiedad?')) { const q = { ...p }; delete q.photo; upsert('properties', q); } },
  delLogo: () => { S.settings.logo = null; persist(); render(); },
  resetPdf: () => { if (confirm('Se restauran las opciones de PDF (el logo y los datos del negocio se conservan).')) { const d = mergeSettings(null); S.settings.invoice = d.invoice; S.settings.report = d.report; persist(); render(); } },
  previewPdf: async (d) => {
    let doc = null;
    if (d.kind === 'invoice') {
      const inv = [...T('invoices')].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))[0], c = inv && find('clients', inv.client_id);
      if (c) doc = buildInvoiceDoc(c, inv, S.settings, S.db);
    } else {
      const st = [...T('stops')].filter((x) => x.status !== 'PENDING').pop() || T('stops')[0];
      if (st) doc = buildStopDoc(S.db, st.id, S.settings);
    }
    if (!doc) return toast(d.kind === 'invoice' ? 'Crea una factura primero para ver la vista previa.' : 'Crea una ruta con paradas para ver la vista previa.');
    const blob = new Blob([buildPdf(doc.title, doc.lines, doc.opts)], { type: 'application/pdf' });
    downloadBlob(blob, 'vista-previa-' + doc.fileName);
    toast('Vista previa generada (revisa Descargas)');
  },
  tab: (d) => { UI.tab = d.v; UI.view = null; render(); },
  back: () => { UI.view = null; render(); },
  closeSheet,
  install: async () => { const e = UI.installEvt; if (!e) return; e.prompt(); await e.userChoice; UI.installEvt = null; render(); },
  syncNow,
  backupJson: () => { downloadBlob(backupBlob(), `respaldo-elite-pool-${todayISO()}.json`); markBackup('Respaldo guardado en Descargas'); },
  shareBackup: async () => {
    const file = new File([backupBlob()], `respaldo-elite-pool-${todayISO()}.json`, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'Respaldo Elite Pool Service PR' }); markBackup('Respaldo enviado'); return; } catch (e) { if (e && e.name === 'AbortError') return; }
    }
    downloadBlob(file, file.name); markBackup('Respaldo guardado en Descargas');
  },
  exportXlsx: () => { downloadBlob(buildXlsx(backupSheets(S.db)), `clientes-elite-pool-${todayISO()}.xlsx`); toast('Excel guardado en Descargas'); },
  pick: (d, el) => { const seg = el.parentElement; seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === el)); seg.previousElementSibling.value = d.v; },
  submitForm,

  /* rutas */
  createRoute: (d) => {
    const date = routeDate(), rid = uid('r');
    upsert('routes', { id: rid, date, technician_id: ME, status: 'PLANNED' });
    const n = addStopsFor(rid, d.all === '1' ? activeProps() : scheduledProps(date), 0);
    toast(n ? `Ruta creada con ${n} parada(s)` : 'Ruta creada sin paradas');
  },
  moveSheet: (d) => moveSheet(d.ids.split(',')),
  pauseSheet: (d) => {
    const o = d.t === 'c' ? find('clients', d.id) : find('properties', d.id), pz = o.pause || {}, today = todayISO();
    const who = d.t === 'c' ? 'Todas las propiedades de ' + o.name : o.address;
    openSheet('⏸ Pausar servicio', `${muted(esc(who))}<div class="fld mt"><label>Desde (primer día sin servicio)</label><input type="date" id="pz_from" value="${esc(pz.from || today)}"></div>
      <div class="fld"><label>Reanudar el (fecha exacta en que vuelve el servicio)</label><input type="date" id="pz_until" value="${esc(pz.until || '')}"></div>
      <div class="fld"><label>Motivo (opcional)</label><input id="pz_reason" value="${esc(pz.reason || '')}" placeholder="Ej.: de viaje, piscina cerrada"></div>
      ${muted('Deja «Reanudar el» vacío para pausar hasta nuevo aviso. Ese día el servicio vuelve solo a las rutas.')}
      <div class="btns mt">${btn('Guardar pausa', 'savePause', { t: d.t, id: d.id })}${o.pause ? btn('Terminar pausa', 'endPause', { t: d.t, id: d.id }, 'ghost') : ''}</div>`);
  },
  savePause: (d) => {
    const from = ($('#pz_from') || {}).value || todayISO(), until = ($('#pz_until') || {}).value || null, reason = (($('#pz_reason') || {}).value || '').trim();
    if (until && until <= from) return toast('La fecha de reanudar debe ser después de «Desde»');
    const o = d.t === 'c' ? find('clients', d.id) : find('properties', d.id);
    upsert(d.t === 'c' ? 'clients' : 'properties', { ...o, pause: { from, until, reason } });
    closeSheet(); toast('Pausa guardada'); setTimeout(() => (d.t === 'c' ? T('properties').filter((p) => p.client_id === d.id) : [find('properties', d.id)]).forEach(syncRoutes), 0);
  },
  endPause: (d) => {
    const o = d.t === 'c' ? find('clients', d.id) : find('properties', d.id), { pause, ...rest } = o;
    upsert(d.t === 'c' ? 'clients' : 'properties', rest); closeSheet(); toast('Pausa terminada: vuelve a las rutas');
  },
  doMove: (d) => { const r = moveStops(d.ids.split(','), d.to); closeSheet(); if (UI.view && UI.view.type === 'stop') UI.view = null; toast(`${r.moved + r.dup} parada(s) pasadas al ${stepDays(d.to)}`); render(); },
  doMoveDate: (d) => { const v = ($('#mv_date') || {}).value; if (!v) return toast('Escoge una fecha'); A.doMove({ ids: d.ids, to: v }); },
  dropStops: (d) => {
    const ids = d.ids.split(','); if (!confirm(`¿Quitar ${ids.length} parada(s) de la ruta? (La propiedad no se borra)`)) return;
    ids.forEach((id) => { const s = find('stops', id); if (s && s.status === 'PENDING') { skipStop(s); remove('stops', id); if (!T('stops').some((x) => x.route_id === s.route_id)) remove('routes', s.route_id); } });
    if (d.back) UI.view = null; toast('Parada(s) quitadas de la ruta'); render();
  },
  addMissing: () => {
    const r = curRoute(), n = addStopsFor(r.id, scheduledProps(routeDate()), routeStops(r).length);
    toast(`${n} parada(s) añadidas`);
  },
  setRouteDate: (d) => { UI.routeDate = d.v === todayISO() ? null : d.v; UI.map = null; render(); },
  toggleDay: (d, el) => {
    el.classList.toggle('on');
    const wrap = el.parentElement, hid = wrap.previousElementSibling;
    hid.value = [...wrap.querySelectorAll('.chip.on')].map((b) => b.dataset.v).join(',');
  },
  togglePropDay: (d) => {
    const p = find('properties', d.id), n = +d.d, cur = p.service_days || [];
    upsert('properties', { ...p, service_days: cur.includes(n) ? cur.filter((x) => x !== n) : [...cur, n].sort() });
  },
  optimize: async () => {
    const stops = routeStops(curRoute()), fixed = stops.filter((s) => s.status !== 'PENDING'), pend = stops.filter((s) => s.status === 'PENDING');
    if (!pend.length) return toast('No hay paradas pendientes');
    toast('Buscando tu ubicación…');
    const f = await getFix(12000, { goal: 20 });
    let start = null, src = '';
    if (!f.err) { start = { lat: f.lat, lng: f.lng }; UI.lastPos = start; src = 'desde tu ubicación actual'; }
    else if (UI.lastPos) { start = UI.lastPos; src = 'desde tu última ubicación conocida'; }
    else { const lastDone = fixed.map((s) => find('properties', s.property_id)).filter(Boolean).pop(); start = lastDone || DEPOT; src = lastDone ? 'desde la última parada hecha (sin GPS)' : 'sin GPS: desde el punto base'; }
    const props = T('properties'), before = pend.map((s) => find('properties', s.property_id)).filter(Boolean);
    const order = optimizeOrder(pend, props, start);
    const km0 = routeKm(before, start), km1 = routeKm(order.map((id) => find('properties', find('stops', id).property_id)).filter(Boolean), start);
    [...fixed.map((s) => s.id), ...order].forEach((id, i) => { const s = find('stops', id); if (s.order_index !== i) upsert('stops', { ...s, order_index: i }); });
    toast(`Ruta optimizada ${src} · ≈${km1.toFixed(1)} km en línea recta${km0 - km1 > 0.2 ? ` (ahorras ≈${(km0 - km1).toFixed(1)} km)` : ''}`);
  },
  openStop: (d) => go('stop', d.id),
  startStop: async (d) => {
    toast('Registrando ubicación…');
    const c = await getCoords(), s = find('stops', d.id), r = curRoute();
    upsert('stops', { ...s, status: 'IN_PROGRESS', check_in_time: new Date().toISOString(), check_in_lat: c ? c.lat : null, check_in_lng: c ? c.lng : null });
    if (r && r.status === 'PLANNED') upsert('routes', { ...r, status: 'IN_PROGRESS' });
    if (!c) toast('Check-in sin GPS (permiso denegado o sin señal)');
  },
  completeStop: (d) => {
    const s = find('stops', d.id), send = d.send === '1';
    const hasR = s.active_water_body_ids.some((w) => T('readings').some((r) => r.stop_id === s.id && r.water_body_id === w));
    if (!hasR && !confirm('No guardaste lecturas químicas en esta parada. ¿Completar de todos modos?')) return;
    if (s.status !== 'DONE') {
      upsert('stops', { ...s, status: 'DONE', check_out_time: new Date().toISOString() });
      const r = curRoute();
      if (r && routeStops(r).every((x) => x.status === 'DONE')) upsert('routes', { ...r, status: 'DONE' });
    }
    UI.view = null; render();
    if (send) A.sendStop({ id: s.id });
  },
  sendStop: (d) => {
    const s = find('stops', d.id), p = find('properties', s.property_id);
    openDispatch(p.client_id, 'REPORT', buildStopDoc(S.db, s.id, S.settings));
  },
  toggleWb: (d) => {
    const s = find('stops', d.stop), ids = s.active_water_body_ids.includes(d.wb) ? s.active_water_body_ids.filter((x) => x !== d.wb) : [...s.active_water_body_ids, d.wb];
    upsert('stops', { ...s, active_water_body_ids: ids });
  },
  saveStopReading: (d) => {
    const v = UI.drafts[d.key] || {}, ex = T('readings').find((r) => r.stop_id === d.stop && r.water_body_id === d.wb);
    upsert('readings', { id: ex ? ex.id : `rd_${d.stop}_${d.wb}`, stop_id: d.stop, water_body_id: d.wb, ...Object.fromEntries(PARAMS.map((p) => [p.key, numOf(v[p.key])])), created_at: new Date().toISOString() });
    toast('Lecturas guardadas');
  },
  saveChemReading: (d) => {
    const v = UI.drafts[d.key] || {};
    upsert('readings', { id: uid('rd'), stop_id: null, water_body_id: d.wb, ...Object.fromEntries(PARAMS.map((p) => [p.key, numOf(v[p.key])])), created_at: new Date().toISOString() });
    delete UI.drafts[d.key]; UI.chem.n++; UI.chem.gal = '';
    toast('Lectura guardada en el historial');
  },
  applyDose: (d) => {
    const wb = find('waterBodies', d.wb), v = UI.drafts[d.key] || {};
    const dose = suggestDoses(Object.fromEntries(PARAMS.map((p) => [p.key, numOf(v[p.key])])), wb.gallons, chemOpts(d.wb))[+d.i];
    if (!dose || dose.amount == null) return;
    const dup = T('dosages').find((x) => x.stop_id === d.stop && x.water_body_id === d.wb && x.chemical_name === dose.chemical_name);
    if (dup) remove('dosages', dup.id);
    else upsert('dosages', { id: uid('ds'), stop_id: d.stop, water_body_id: d.wb, chemical_name: dose.chemical_name, amount: dose.amount, unit: dose.unit });
  },
  addPart: (d) => {
    const el = $('#part_name'), name = el && el.value.trim(), s = find('stops', d.stop);
    if (!name) return;
    upsert('shoppingItems', { id: uid('sh'), stop_id: s.id, client_id: find('properties', s.property_id).client_id, item_name: name, cost: 0, price: 0, status: 'REQUIRED', assigned_to: techList()[0] || '', created_at: new Date().toISOString() });
  },
  delPhoto: (d) => { if (confirm('¿Quitar esta foto?')) remove('photos', d.id); },

  /* clientes */
  setClientFilter: (d) => { UI.clientFilter = d.v; render(); },
  newClient: () => openForm('client'), openClient: (d) => go('client', d.id), editClient: (d) => openForm('client', d.id),
  setPref: (d) => upsert('clients', { ...find('clients', d.id), [d.f]: d.v }),
  toggleArchive: (d) => { const c = find('clients', d.id); upsert('clients', { ...c, status: c.status === 'ACTIVE' ? 'ARCHIVED' : 'ACTIVE' }); },
  delClient: (d) => { if (confirm('¿Estás seguro de eliminar este cliente y todo su historial de piscinas asociado?')) { removeClient(d.id); UI.view = null; render(); } },
  newProp: (d) => openForm('prop', null, d.c), editProp: (d) => openForm('prop', d.id, d.c),
  newWb: (d) => openForm('wb', null, d.p), editWb: (d) => openForm('wb', d.id, d.p),
  newEquip: (d) => openForm('equip', null, d.w), editEquip: (d) => openForm('equip', d.id),
  delProp: (d) => {
    if (T('stops').some((s) => s.property_id === d.id)) return alert('Esta propiedad tiene historial de paradas. Archiva al cliente para conservar el historial.');
    if (!confirm('¿Eliminar esta propiedad con sus cuerpos de agua y equipos?')) return;
    T('waterBodies').filter((w) => w.property_id === d.id).forEach((w) => { T('equipment').filter((e) => e.water_body_id === w.id).forEach((e) => remove('equipment', e.id)); remove('waterBodies', w.id); });
    remove('properties', d.id);
  },
  delWb: (d) => {
    if (T('readings').some((r) => r.water_body_id === d.id)) return alert('Este cuerpo de agua tiene lecturas históricas. Archiva al cliente para conservarlas.');
    if (!confirm('¿Eliminar este cuerpo de agua y sus equipos?')) return;
    T('equipment').filter((e) => e.water_body_id === d.id).forEach((e) => remove('equipment', e.id));
    remove('waterBodies', d.id);
  },
  delEquip: (d, el, ev) => { ev.stopPropagation(); if (confirm('¿Eliminar este equipo?')) remove('equipment', d.id); },

  /* químicos */
  chemClient: (d) => { UI.chem = { clientId: d.id, wbId: '', gal: '', n: UI.chem.n + 1 }; render(); },
  chemWb: (d) => { UI.chem.wbId = d.id; UI.chem.gal = ''; UI.chem.n++; render(); },

  /* órdenes */
  setOrderFilter: (d) => { UI.orderFilter = d.v; render(); },
  openOrder: (d) => go('order', d.id), newOrder: newOrderSheet,
  createOrder: () => {
    const g = (id) => $('#' + id).value, cid = g('o_client'), pid = g('o_prop'), type = g('o_type');
    if (!cid || !pid) return toast('Elige cliente y propiedad');
    const id = uid('wo');
    upsert('workOrders', { id, client_id: cid, property_id: pid, type, status: 'OPEN', description: g('o_desc').trim(), price: toNum(g('o_price')) || 0, checklist: mkChecklist(id, WORK_ORDER_TEMPLATES[type]), client_note: '', created_at: new Date().toISOString() });
    closeSheet();
  },
  setOrderStatus: (d) => upsert('workOrders', { ...find('workOrders', d.id), status: d.v }),
  saveOrderNote: (d) => { upsert('workOrders', { ...find('workOrders', d.id), price: toNum($('#wo_price').value) || 0, client_note: $('#wo_note').value }); toast('Guardado'); },

  /* compras */
  shopF: (d) => { UI.shop[d.k] = d.v; render(); },
  newItem: () => itemSheet(), editItem: (d) => itemSheet(d.id),
  saveItem: () => {
    const name = $('#i_name').value.trim();
    if (!name) return toast('Falta el nombre de la pieza');
    const old = UI.editItem && find('shoppingItems', UI.editItem);
    upsert('shoppingItems', { id: old ? old.id : uid('sh'), stop_id: old ? old.stop_id : null, client_id: $('#i_client').value, item_name: name, cost: toNum($('#i_cost').value) || 0, price: toNum($('#i_price').value) || 0, status: old ? old.status : 'REQUIRED', assigned_to: $('#i_tech').value, created_at: old ? old.created_at : new Date().toISOString() });
    closeSheet();
  },
  delItem: (d) => { if (confirm('¿Eliminar esta pieza?')) { remove('shoppingItems', d.id); closeSheet(); } },
  advanceItem: (d) => {
    const i = find('shoppingItems', d.id), next = i.status === 'REQUIRED' ? 'PURCHASED' : 'INSTALLED';
    if (next === 'INSTALLED' && i.price <= 0) { toast('Ponle precio a la pieza antes de instalarla'); return itemSheet(i.id); }
    upsert('shoppingItems', { ...i, status: next });
  },

  /* facturas */
  setInvFilter: (d) => { UI.invFilter = d.v; render(); },
  openInvoice: (d) => go('invoice', d.id),
  bulkInvoices: () => {
    const period = todayISO().slice(0, 7), targets = activeClients().filter((c) => !T('invoices').some((i) => i.client_id === c.id && i.period === period));
    if (!targets.length) return alert(`Todos los clientes activos ya tienen factura de ${period}.`);
    if (confirm(`Se crearán ${targets.length} factura(s) de ${period} (cuota o visitas realizadas + piezas instaladas + órdenes completadas).`)) targets.forEach(createInvoiceFor);
  },
  newInvoice: () => openSheet('Factura individual', `${muted('Elige el cliente (periodo ' + todayISO().slice(0, 7) + ')')}<div class="chips mt-s">${activeClients().map((c) => chip(c.name, false, 'invFor', { id: c.id })).join('')}</div>`),
  invFor: (d) => { closeSheet(); if (!createInvoiceFor(find('clients', d.id))) alert('Ese cliente ya tiene factura de este periodo o no tiene nada que facturar.'); },
  setPayment: (d) => upsert('invoices', { ...find('invoices', d.id), payment_method: d.v }),
  sendReceipt: (d) => { const p = find('payments', d.id), c = p && find('clients', p.client_id); if (c) openDispatch(c.id, 'RECEIPT', buildReceiptDoc(c, p, S.settings, S.db)); },
  markPaid: (d) => {
    const inv = find('invoices', d.id), bal = invBalance(inv, S.db);
    if (bal > 0) { const r = addPayment({ client_id: inv.client_id, amount: bal, method: PAY_METHODS[inv.payment_method] ? inv.payment_method : 'ATH_MOVIL', invoice_id: inv.id }); render(); offerReceipt(r && r.id); }
    else upsert('invoices', { ...inv, status: 'PAID' });
  },
  payInvoice: (d) => { const inv = find('invoices', d.id); paySheet('Registrar pago / abono', `Factura ${invNumber(inv, S.db)} · balance ${money(invBalance(inv, S.db))}. Si pagan menos, queda el balance; si pagan más, el sobrante queda como saldo a favor.`, invBalance(inv, S.db), 'savePay', { id: inv.id }); const m = $('#pay_method'); if (m && PAY_METHODS[inv.payment_method]) m.value = inv.payment_method; },
  payAdvance: (d) => paySheet('Pago adelantado', `Cliente: ${find('clients', d.id).name}. Se descontará solo en sus próximas facturas.`, '', 'savePay', { c: d.id }),
  savePay: (d) => {
    const g = (i) => ($('#' + i) || {}).value || '', amount = parseFloat(g('pay_amt').replace(',', '.'));
    if (!(amount > 0)) return toast('Escribe el monto');
    const inv = d.id ? find('invoices', d.id) : null, cid = inv ? inv.client_id : d.c;
    const r = addPayment({ client_id: cid, amount, date: g('pay_date'), method: g('pay_method'), note: g('pay_note'), invoice_id: inv ? inv.id : null });
    closeSheet(); toast(r && r.extra > 0 ? `Pago guardado · ${money(r.extra)} quedó como saldo a favor` : 'Pago guardado'); render();
    offerReceipt(r && r.id);
  },
  delPayment: (d) => {
    const p = find('payments', d.id); if (!p || !confirm('¿Quitar este pago?')) return;
    remove('payments', p.id);
    const inv = p.invoice_id && find('invoices', p.invoice_id);
    if (inv && inv.status === 'PAID' && invBalance({ ...inv, status: 'X' }, S.db) > 0.005) upsert('invoices', { ...inv, status: 'SENT' });
  },
  sendInvoice: (d) => {
    const inv = find('invoices', d.id), c = find('clients', inv.client_id);
    openDispatch(c.id, 'INVOICE', buildInvoiceDoc(c, inv, S.settings, S.db), { after: () => { const cur = find('invoices', inv.id); if (cur && cur.status === 'DRAFT') upsert('invoices', { ...cur, status: 'SENT' }); } });
  },
  delDraft: (d) => {
    const inv = find('invoices', d.id);
    if (!confirm('Las visitas, piezas y órdenes incluidas volverán a quedar pendientes de facturar.')) return;
    inv.lines.forEach((l) => {
      if (l.kind === 'PART' && find('shoppingItems', l.ref_id)) upsert('shoppingItems', { ...find('shoppingItems', l.ref_id), status: 'INSTALLED' });
      if (l.kind === 'WORK_ORDER' && find('workOrders', l.ref_id)) upsert('workOrders', { ...find('workOrders', l.ref_id), status: 'DONE' });
    });
    inv.lines.filter((l) => l.kind === 'PREV' && find('invoices', l.ref_id)).forEach((l) => upsert('invoices', { ...find('invoices', l.ref_id), carried_to: null }));
    T('stops').filter((s) => s.invoice_id === inv.id).forEach((s) => upsert('stops', { ...s, invoice_id: null }));
    remove('invoices', inv.id); UI.view = null; render();
  },

  /* mensajería */
  setTpl: (d) => { const t = TEMPLATES.find((x) => x.id === d.id); UI.msg.tpl = d.id; UI.msg.subject = t.subject; UI.msg.body = t.body; render(); },
  setArea: (d) => { UI.msg.area = d.v; render(); },
  sendBroadcast: (d) => {
    const c = find('clients', d.id);
    if (!UI.msg.body.trim()) return toast('Escribe el mensaje');
    openDispatch(c.id, 'BROADCAST', buildBroadcastDoc(c, UI.msg.body, UI.msg.subject, S.settings), { forceFormat: 'TEXT', after: () => { UI.msg.sent[c.id] = true; scheduleRender(); } });
  },

  /* despacho */
  dispSend: (d) => execDispatch(+d.i),
  dispEdit: () => { UI.dispatch.edit = true; renderDispatch(); },
  dispChannel: (d) => { UI.dispatch.channel = d.v; UI.dispatch.done = []; renderDispatch(); },
  dispFormat: (d) => { UI.dispatch.format = d.v; UI.dispatch.done = []; renderDispatch(); },
};

/* ---------- eventos ---------- */
function onClick(e) {
  const el = e.target.closest('[data-act]');
  if (!el || !A[el.dataset.act]) return;
  if (el.tagName === 'A') e.preventDefault();
  A[el.dataset.act](el.dataset, el, e);
}
function onInput(e) {
  const t = e.target;
  if (t.dataset.rf) { // lectura química: actualiza color y dosis sin redibujar
    const key = t.dataset.rf, v = draftOf(key, null);
    v[t.dataset.p] = t.value;
    const lv = classify(t.dataset.p, numOf(t.value));
    t.className = lv ? 'lv-' + lv : '';
    const lb = document.getElementById(`lv_${key}_${t.dataset.p}`);
    if (lb) { lb.className = 'lvl ' + (lv || ''); lb.textContent = lv ? '● ' + LEVEL_LABEL[lv] : ''; }
    const sg = document.getElementById('sg_' + key);
    if (sg) sg.innerHTML = sugHtml(key, +sg.dataset.gal, v, sg.dataset.stop ? { stop: sg.dataset.stop, wb: sg.dataset.wb } : null, sg.dataset.wbp);
  } else if (t.dataset.calc) {
    const c = calcState(), [a, k] = t.dataset.calc.split('.');
    if (a === 'gal') c.gal = t.value; else if (a === 'v') c.vals[k] = t.value; else c.targets[k] = t.value;
    const o = document.getElementById('calc_out'); if (o) o.innerHTML = calcOutHtml();
  } else if (t.dataset.calcp) {
    const c = calcState(); c.prefs = { ...calcPrefs(), [t.dataset.calcp]: t.value };
    const o = document.getElementById('calc_out'); if (o) o.innerHTML = calcOutHtml();
  } else if (t.dataset.ql) { const [i, k] = t.dataset.ql.split(':'); UI.qd.lines[+i][k] = t.value; const e = document.getElementById('q_tot'); if (e) e.textContent = money(qdTotal()); }
  else if (t.dataset.qp) UI.qd.prospect[t.dataset.qp] = t.value;
  else if (t.dataset.qf) UI.qd[t.dataset.qf] = t.value;
  else if (t.id === 'q_disc') { UI.qd.discount = t.value; const e = document.getElementById('q_tot'); if (e) e.textContent = money(qdTotal()); }
  else if (t.id === 'q_valid') UI.qd.valid_until = t.value;
  else if (t.id === 'q_notes') UI.qd.notes = t.value;
  else if (t.dataset.cat) { const [i, k] = t.dataset.cat.split(':'); const it = S.settings.catalog[+i]; if (it) { it[k] = k === 'price' ? toNum(t.value) || 0 : t.value; persist(); } }
  else if (t.id === 'cl_q') { UI.q = t.value; scheduleRender(); }
  else if (t.id === 'chem_gal') { UI.chem.gal = t.value; const sg = document.querySelector('[id^="sg_chem_"]'); if (sg) { const wb = find('waterBodies', UI.chem.wbId) || T('waterBodies').find((w) => T('properties').some((p) => p.id === w.property_id && p.client_id === UI.chem.clientId)); const gal = toNum(t.value) || (wb && wb.gallons) || 0; sg.dataset.gal = gal; sg.innerHTML = sugHtml(sg.id.slice(3), gal, draftOf(sg.id.slice(3), null), null, sg.dataset.wbp); } }
  else if (t.dataset.invterms) { const inv = find('invoices', t.dataset.invterms); if (inv && t.value) { upsert('invoices', { ...inv, terms: t.value, due_date: dueFor(t.value, inv.issue_date || (inv.created_at || '').slice(0, 10) || todayISO()) }); toast('Condiciones: ' + termsLabel(t.value)); } }
  else if (t.dataset.setvChem) { S.settings.chem[t.dataset.setvChem] = t.value; persist(); }
  else if (t.dataset.setv) { setPath(S.settings, t.dataset.setv, t.value); persist(); }
  else if (t.dataset.note) { const row = find('stops', t.dataset.note); if (row) { row.client_note = t.value; persist(); } }
  else if (t.id === 'm_subject') UI.msg.subject = t.value;
  else if (t.id === 'm_body') UI.msg.body = t.value;
}
async function onChange(e) {
  const t = e.target;
  if (t.dataset.qwhy) { UI.qd.why = t.checked; return; }
  if (t.dataset.chk) { // checklist de parada u orden
    const tbl = t.dataset.chk === 'stop' ? 'stops' : 'workOrders', row = find(tbl, t.dataset.owner);
    upsert(tbl, { ...row, checklist: row.checklist.map((c) => (c.id === t.dataset.id ? { ...c, done: t.checked } : c)) });
  } else if (t.dataset.restore && t.files && t.files[0]) { const f = t.files[0]; t.value = ''; restoreBackup(f);
  } else if (t.dataset.caltime) { const p = UI.cal && find('properties', UI.cal.pid); if (p) saveDates(p, p.dates.map((x) => (x.d === t.dataset.caltime ? { ...x, t: t.value } : x)));
  } else if (t.id === 'cal_def') { const p = UI.cal && find('properties', UI.cal.pid); if (p) upsert('properties', { ...p, def_time: t.value });
  } else if (t.dataset.cflag) { const c = find('clients', t.dataset.id); if (c) upsert('clients', { ...c, [t.dataset.cflag]: !t.checked });
  } else if (t.dataset.set) { setPath(S.settings, t.dataset.set, t.checked); persist(); }
  else if (t.dataset.note) { const row = find('stops', t.dataset.note); if (row) upsert('stops', { ...row, client_note: t.value }); }
  else if (t.dataset.calcprop) {
    const c = calcState(); c.propId = t.value; c.prefs = null;
    const w = T('waterBodies').filter((x) => x.property_id === t.value);
    if (w.length) c.gal = String(w.reduce((a, x) => a + (+x.gallons || 0), 0));
    render();
  } else if (t.dataset.pchem) {
    const [pid, k] = t.dataset.pchem.split(':'), p = find('properties', pid);
    if (p) { const chem = { ...(p.chem || {}) }; if (t.value) chem[k] = t.value; else delete chem[k]; upsert('properties', { ...p, chem }); toast('Guardado'); }
  }
  else if (t.dataset.ref && t.files && t.files[0]) {
    const f = t.files[0]; t.value = '';
    try { const p = find('properties', t.dataset.ref); if (p) { upsert('properties', { ...p, photo: await processRef(f) }); toast('Foto guardada'); } } catch (err) { alert('No se pudo leer la imagen: ' + err.message); }
  }
  else if (t.dataset.logo && t.files && t.files[0]) {
    const f = t.files[0]; t.value = '';
    try { S.settings.logo = await processLogo(f); persist(); render(); toast('Logo guardado'); } catch (err) { alert('No se pudo leer la imagen: ' + err.message); }
  } else if (t.dataset.sim) { UI.simOffline = t.checked; render(); maybeSync(); }
  else if (t.dataset.photo && t.files && t.files[0]) {
    const file = t.files[0], kind = t.dataset.photo, owner = t.dataset.owner, oid = t.dataset.id;
    t.value = '';
    toast('Procesando foto…');
    try {
      let c = await getCoords(4000);
      if (!c && owner === 'STOP') { const s = find('stops', oid); if (s && s.check_in_lat != null) c = { lat: s.check_in_lat, lng: s.check_in_lng }; }
      const img = await processPhoto(file, kind, c);
      upsert('photos', { id: uid('ph'), owner_type: owner, owner_id: oid, kind, uri: img.uri, w: img.w, h: img.h, taken_at: new Date().toISOString(), lat: c ? c.lat : null, lng: c ? c.lng : null });
    } catch (err) { alert('No se pudo procesar la foto: ' + err.message); }
  } else if (t.id === 'q_client') { UI.qd.client_id = t.value;
  } else if (t.id === 'o_client') {
    const props = T('properties').filter((p) => p.client_id === t.value);
    $('#o_prop').innerHTML = optList(props.map((p) => [p.id, p.address]));
  }
}

/* botón «atrás» de Android: cierra hoja / detalle en vez de salir de la app */
function setupBack() {
  history.replaceState({ root: 1 }, '');
  history.pushState({ app: 1 }, '');
  window.addEventListener('popstate', () => {
    if (sheetOpen()) closeSheet();
    else if (UI.view) { UI.view = null; render(); }
    else if (UI.tab !== 'routes') { UI.tab = 'routes'; render(); }
    history.pushState({ app: 1 }, '');
  });
}

async function boot() {
  document.addEventListener('click', onClick);
  document.addEventListener('input', onInput);
  document.addEventListener('change', onChange);
  window.addEventListener('online', () => { render(); maybeSync(); });
  window.addEventListener('offline', render);
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); UI.installEvt = e; render(); });
  window.addEventListener('appinstalled', () => { UI.installEvt = null; render(); });
  setupBack(); setupAutoLock();
  try {
    const saved = await idbGet('state');
    if (saved && saved.db) { S.db = saved.db; S.queue = saved.queue || []; S.lastSync = saved.lastSync || null; S.settings = mergeSettings(saved.settings); S.demoPurged = !!saved.demoPurged; S.lastBackup = saved.lastBackup || null; S.lock = saved.lock || null; if (S.lock) { UI.locked = true; UI.pin = ''; } migrateDb(S.db); }
  } catch (e) { /* IndexedDB no disponible: se usan datos de ejemplo en memoria */ }
  if (!S.db) { S.db = emptyDb(); S.demoPurged = true; }
  if (!S.demoPurged) { purgeDemo(); S.demoPurged = true; persist(); }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.db) { autoInvoices(); scheduleRender(); } });
  autoInvoices(); render(); maybeSync();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
if (typeof window !== 'undefined' && !window.__TEST__) boot();
