/* Elite Pool Service PR — PWA (sin dependencias). Estado local en IndexedDB, funciona offline. */
'use strict';

const API_URL = null; // pon aquí la URL de tu backend para sincronizar de verdad (ver README)
const COL = { water: '#0284c7', ok: '#10b981', warn: '#f59e0b', bad: '#ef4444', pending: '#94a3b8' };
const TABS = [['routes', '📍', 'Rutas'], ['clients', '👥', 'Clientes'], ['chem', '🧪', 'Químicos'], ['orders', '📋', 'Órdenes'], ['shop', '🛒', 'Compras'], ['invoices', '🧾', 'Facturas'], ['msg', '⚙️', 'Mensajes']];

const S = { db: null, queue: [], lastSync: null };
const UI = {
  tab: 'routes', view: null, q: '', clientFilter: 'ACTIVE', orderFilter: 'ALL', shop: { status: 'ALL', tech: 'ALL', client: 'ALL' },
  invFilter: 'ALL', chem: { clientId: '', wbId: '', gal: '', n: 0 }, drafts: {}, form: null, dispatch: null, simOffline: false,
  installEvt: null, syncing: false, msg: { tpl: 'feriado', area: 'ALL', subject: null, body: null, sent: {} },
};
const T = (k) => S.db[k];
const find = (t, id) => S.db[t].find((r) => r.id === id);
const $ = (s) => document.querySelector(s);
const online = () => navigator.onLine && !UI.simOffline;

/* ---------- almacenamiento (IndexedDB) ---------- */
const idb = () => new Promise((res, rej) => { const r = indexedDB.open('epspr', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const idbGet = async (k) => { const d = await idb(); return new Promise((res) => { const q = d.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); }); };
const idbSet = async (k, v) => { const d = await idb(); return new Promise((res) => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => res(); t.onerror = () => res(); }); };
let persistTimer = null;
const persist = () => { clearTimeout(persistTimer); persistTimer = setTimeout(() => idbSet('state', { db: S.db, queue: S.queue, lastSync: S.lastSync }).catch(() => {}), 300); };

/* ---------- mutaciones + cola de sincronización ---------- */
let renderQueued = false;
const scheduleRender = () => { if (renderQueued) return; renderQueued = true; requestAnimationFrame(() => { renderQueued = false; render(); }); };
function changed() { persist(); scheduleRender(); maybeSync(); }
const enqueue = (op) => S.queue.push({ id: uid('op'), ts: new Date().toISOString(), ...op });
function upsert(table, row) {
  const list = S.db[table], i = list.findIndex((r) => r.id === row.id);
  if (i >= 0) list[i] = row; else list.push(row);
  enqueue({ table, op: 'upsert', rowId: row.id, payload: table === 'photos' ? { ...row, uri: '[local]' } : row });
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
  db.dispatchLog = db.dispatchLog.filter((l) => l.client_id !== id);
  db.photos = db.photos.filter((p) => !stops.includes(p.owner_id) && !wos.includes(p.owner_id));
  enqueue({ table: 'clients', op: 'delete', rowId: id, cascade: true });
  changed();
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
const todayRoute = () => T('routes').find((r) => r.date === todayISO() && r.technician_id === ME);
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
  const pts = mapPoints(routeStops(todayRoute()));
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

function routesTab() {
  const route = todayRoute(), stops = routeStops(route), done = stops.filter((s) => s.status === 'DONE').length;
  const sub = route ? `${done} de ${stops.length} paradas completadas` : new Date().toLocaleDateString('es-PR', { weekday: 'long', day: 'numeric', month: 'long' });
  const right = UI.installEvt ? btn('📲 Instalar', 'install', {}, 'sm') : '';
  if (!route) return { title: 'Ruta de hoy', sub, right, body: `<div class="card">${empty('No hay ruta creada para hoy.')}${btn('Crear ruta de hoy con clientes activos', 'createRoute')}</div>` };
  const pending = stops.filter((s) => s.status !== 'DONE').map((s) => find('properties', s.property_id)).filter(Boolean);
  const url = routeUrl(pending);
  let h = `<div class="progress"><i style="width:${stops.length ? (done / stops.length) * 100 : 0}%"></i></div>${mapHtml(stops)}`;
  h += `<div class="btns" style="margin:0 0 12px">${btn('↕ Optimizar ruta', 'optimize', {}, 'sm ghost')}${url ? `<a class="btn sm ghost" href="${esc(url)}" target="_blank" rel="noopener">🗺 Abrir en Mapas</a>` : ''}</div>`;
  h += '<div class="cols">' + stops.map((s) => {
    const p = find('properties', s.property_id), c = p && find('clients', p.client_id);
    if (!p || !c) return '';
    const actions = s.status === 'PENDING' ? btn('▶ Iniciar parada', 'startStop', { id: s.id })
      : s.status === 'IN_PROGRESS' ? `<div class="btns">${btn('Abrir', 'openStop', { id: s.id }, 'ghost')}${btn('✓ Completar', 'completeStop', { id: s.id, send: '0' }, 'ok')}</div>`
      : btn('📤 Enviar informe', 'sendStop', { id: s.id }, 'sm ghost');
    return `<div class="card bar tap" style="border-left-color:${ST_COLOR[s.status]}" data-act="openStop" data-id="${s.id}">
      <div class="row"><div class="dot" style="position:static;margin:0;background:${ST_COLOR[s.status]}">${s.order_index + 1}</div>
      <div class="grow"><b>${esc(c.name)}</b>${muted(esc(p.address + ', ' + p.municipality))}</div>${badge(ST_LABEL[s.status], ST_COLOR[s.status])}</div>
      ${s.check_in_time ? muted(`Entrada ${fmtTime(s.check_in_time)}${s.check_out_time ? ' · Salida ' + fmtTime(s.check_out_time) : ''}`, 'mt-s') : ''}
      <div class="mt">${actions}</div></div>`;
  }).join('') + '</div>';
  return { title: 'Ruta de hoy', sub, right, body: h };
}

/* --- lecturas (compartido con pestaña Químicos) --- */
const draftOf = (key, r) => (UI.drafts[key] ||= Object.fromEntries(PARAMS.map((p) => [p.key, r && r[p.key] != null ? String(r[p.key]) : ''])));
const numOf = (s) => (s === '' || s == null ? null : toNum(s));
function sugHtml(key, gal, vals, ctx) {
  const nums = Object.fromEntries(PARAMS.map((p) => [p.key, numOf(vals[p.key])]));
  const doses = suggestDoses(nums, gal);
  if (!doses.length) return '';
  const applied = ctx ? T('dosages').filter((d) => d.stop_id === ctx.stop && d.water_body_id === ctx.wb).map((d) => d.chemical_name) : [];
  return `<div class="card dose"><b>Dosis sugerida (${gal.toLocaleString('es-PR')} gal)</b>${doses.map((d, i) => `<div class="it"><div class="grow"><b>${esc(d.chemical_name)}</b><div class="amt">${d.amount} ${d.unit}</div>${muted(esc(d.reason))}</div>
    ${ctx ? btn(applied.includes(d.chemical_name) ? '✓ Aplicado' : 'Aplicar', 'applyDose', { key, i, stop: ctx.stop, wb: ctx.wb }, 'sm ' + (applied.includes(d.chemical_name) ? 'ok' : 'ghost')) : ''}</div>`).join('')}
    ${muted('Estimado de campo: verifica la etiqueta del producto, aplica en dosis divididas si el ajuste es grande y vuelve a medir.', 'mt-s')}</div>`;
}
function readingForm(key, gal, vals, ctx, saveAct, saveData, saveLabel) {
  const fields = PARAMS.map((p) => {
    const lv = classify(p.key, numOf(vals[p.key]));
    return `<div class="fld"><label>${esc(p.label)}${p.unit ? ` (${p.unit})` : ''}</label><input id="rf_${key}_${p.key}" data-rf="${key}" data-p="${p.key}" inputmode="decimal" value="${esc(vals[p.key])}" placeholder="${p.ok[0]}–${p.ok[1]}" class="${lv ? 'lv-' + lv : ''}"><div class="lvl ${lv || ''}" id="lv_${key}_${p.key}">${lv ? '● ' + LEVEL_LABEL[lv] : ''}</div></div>`;
  }).join('');
  return `<div class="g2">${fields}</div><div id="sg_${key}" data-gal="${gal}"${ctx ? ` data-stop="${ctx.stop}" data-wb="${ctx.wb}"` : ''}>${sugHtml(key, gal, vals, ctx)}</div>${btn(saveLabel, saveAct, saveData)}`;
}

function stopView(id) {
  const stop = find('stops', id), prop = stop && find('properties', stop.property_id), client = prop && find('clients', prop.client_id);
  if (!stop || !prop || !client) return { title: '—', body: empty('Parada no encontrada.') };
  const wbs = T('waterBodies').filter((w) => w.property_id === prop.id), locked = stop.status === 'DONE';
  let h = `<div class="card"><div class="row between"><b>${esc(client.name)}</b>${badge(ST_LABEL[stop.status], ST_COLOR[stop.status])}</div>
    <div class="mt-s"><a href="${esc(navUrl(prop))}" target="_blank" rel="noopener">📍 ${esc(prop.address)}, ${esc(prop.municipality)}</a></div>
    ${client.phone ? `<div class="mt-s"><a href="tel:${digits(client.phone)}">📞 ${esc(client.phone)}</a></div>` : ''}
    ${muted(`Check-in: ${fmtTime(stop.check_in_time)} · Check-out: ${fmtTime(stop.check_out_time)}`, 'mt-s')}</div>
    <div class="card note"><b>Notas de acceso</b><div>🔑 Portón: ${esc(prop.gate_code || 'sin código')}</div><div>${esc(prop.access_notes || 'Sin notas.')}</div>${client.notes ? muted('Cliente: ' + esc(client.notes), 'mt-s') : ''}</div>`;
  h += '<h2>Cuerpos de agua en esta parada</h2><div class="chips">' + wbs.map((w) => chip(`${w.name} · ${w.gallons.toLocaleString('es-PR')} gal`, stop.active_water_body_ids.includes(w.id), locked ? 'noop' : 'toggleWb', { stop: stop.id, wb: w.id })).join('') + '</div>';
  wbs.filter((w) => stop.active_water_body_ids.includes(w.id)).forEach((w) => {
    const r = T('readings').find((x) => x.stop_id === stop.id && x.water_body_id === w.id);
    const key = `${stop.id}_${w.id}`;
    h += `<h2>🧪 ${esc(w.name)}</h2>` + readingForm(key, w.gallons, draftOf(key, r), { stop: stop.id, wb: w.id }, 'saveStopReading', { stop: stop.id, wb: w.id, key }, 'Guardar lecturas');
  });
  h += '<h2>Lista de verificación</h2><div class="card">' + stop.checklist.map((c) => `<div class="chk"><span class="t ${c.done ? 'done' : ''}">${esc(c.label)}</span><label class="sw"><input type="checkbox" data-chk="stop" data-owner="${stop.id}" data-id="${c.id}"${c.done ? ' checked' : ''}><i></i></label></div>`).join('') + '</div>';
  h += '<h2>Fotos Antes / Después</h2>' + photoStrip('STOP', stop.id);
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
      ${muted(esc(props.map((p) => p.municipality).filter(Boolean).join(', ') || 'Sin propiedad') + ` · ${wbc} cuerpo(s) de agua · ${money(c.monthly_fee)}/mes`, 'mt-s')}${muted('Envío: ' + esc(prefText(c)))}</div>`;
  }).join('') + '</div>' : empty('No hay clientes en esta vista.');
  return { title: 'Clientes', sub: `${activeClients().length} activos`, right: btn('+ Nuevo', 'newClient', {}, 'sm'), body: h };
}

function clientView(id) {
  const c = find('clients', id);
  if (!c) return { title: '—', body: empty('Cliente no encontrado.') };
  let h = `<div class="card"><div>📞 ${esc(c.phone || '—')}</div><div>✉️ ${esc(c.email || '—')}</div><div>💵 ${money(c.monthly_fee)} / mes</div>${c.notes ? muted(esc(c.notes), 'mt-s') : ''}${c.tags.length ? muted('Etiquetas: ' + esc(c.tags.join(', ')), 'mt-s') : ''}</div>
    <h2>Preferencias de envío guardadas</h2><div class="card">${muted('Canal predeterminado')}${seg(c.dispatch_channel_pref, CHANNELS, 'setPref', { id: c.id, f: 'dispatch_channel_pref' })}
    <div class="mt">${muted('Formato predeterminado')}</div>${seg(c.dispatch_format_pref, FORMATS, 'setPref', { id: c.id, f: 'dispatch_format_pref' })}
    ${muted('Se guarda al instante. Los informes y facturas se envían con estas opciones en 1 solo toque.', 'mt')}</div>
    <div class="row between"><h2>Propiedades</h2>${btn('+ Propiedad', 'newProp', { c: c.id }, 'sm ghost')}</div>`;
  T('properties').filter((p) => p.client_id === c.id).forEach((p) => {
    h += `<div class="card"><b>${esc(p.address)}</b>${muted(esc(p.municipality) + ' · Portón: ' + esc(p.gate_code || 'sin código'))}${p.access_notes ? muted(esc(p.access_notes)) : ''}
      <div class="btns">${btn('Editar', 'editProp', { id: p.id, c: c.id }, 'sm ghost')}${btn('🗑', 'delProp', { id: p.id }, 'sm ghost')}${btn('+ Cuerpo de agua', 'newWb', { p: p.id }, 'sm')}</div>`;
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
  { k: 'monthly_fee', l: 'Cuota mensual ($)', t: 'number' }, { k: 'tags', l: 'Etiquetas (separadas por coma)', ph: 'Caguas, Residencial' },
  { k: 'channel', l: 'Canal de envío predeterminado', t: 'choice', o: CHANNELS }, { k: 'format', l: 'Formato de envío predeterminado', t: 'choice', o: FORMATS }, { k: 'notes', l: 'Notas', t: 'area' },
];
const PROP_F = [
  { k: 'address', l: 'Dirección', req: 1 }, { k: 'municipality', l: 'Municipio / zona', ph: 'Caguas, San Juan, Guaynabo, Dorado, Montehiedra…' }, { k: 'gate_code', l: 'Código de portón' },
  { k: 'access_notes', l: 'Notas de acceso (mascotas, cuarto de bombas)', t: 'area' }, { k: 'lat', l: 'Latitud (opcional)', t: 'number', ph: '18.2341' }, { k: 'lng', l: 'Longitud (opcional)', t: 'number', ph: '-66.0485' },
];
const WB_F = [{ k: 'name', l: 'Nombre', req: 1, ph: 'Piscina Principal, Jacuzzi, Espejo de Agua' }, { k: 'type', l: 'Tipo', t: 'choice', o: [['Pool', 'Piscina'], ['Jacuzzi', 'Jacuzzi'], ['Commercial', 'Comercial']] }, { k: 'gallons', l: 'Volumen (galones)', t: 'number', req: 1 }];
const EQ_F = [{ k: 'category', l: 'Categoría', req: 1, ph: 'Bomba, Filtro, Calentador, Clorador salino, Automatización' }, { k: 'brand', l: 'Marca' }, { k: 'model', l: 'Modelo' }, { k: 'serial_number', l: 'Serial' }, { k: 'status', l: 'Estado', t: 'choice', o: [['OK', 'OK'], ['Atención', 'Atención'], ['Averiado', 'Averiado']] }];

function formFieldHtml(f, val) {
  if (f.t === 'choice') return `<div class="fld"><label>${esc(f.l)}</label><input type="hidden" name="${f.k}" value="${esc(val || '')}"><div class="seg">${f.o.map(([v, l]) => `<button type="button" class="${v === val ? 'on' : ''}" data-act="pick" data-v="${esc(v)}">${esc(l)}</button>`).join('')}</div></div>`;
  const common = `name="${f.k}" value="${esc(val ?? '')}" placeholder="${esc(f.ph || '')}"`;
  const inner = f.t === 'area' ? `<textarea name="${f.k}">${esc(val ?? '')}</textarea>` : `<input ${common} ${f.t === 'number' ? 'inputmode="decimal"' : f.t === 'tel' ? 'type="tel"' : f.t === 'email' ? 'type="email"' : ''}>`;
  return `<div class="fld"><label>${esc(f.l)}${f.req ? ' *' : ''}</label>${inner}</div>`;
}
function openForm(kind, id, parent) {
  const defs = { client: [CLIENT_F, 'cliente'], prop: [PROP_F, 'propiedad'], wb: [WB_F, 'cuerpo de agua'], equip: [EQ_F, 'equipo'] }[kind];
  let v = {};
  if (kind === 'client') { const c = id && find('clients', id); v = c ? { name: c.name, phone: c.phone, email: c.email, monthly_fee: c.monthly_fee, tags: c.tags.join(', '), channel: c.dispatch_channel_pref, format: c.dispatch_format_pref, notes: c.notes } : { channel: 'WHATSAPP', format: 'TEXT', monthly_fee: 0 }; }
  if (kind === 'prop') { const p = id && find('properties', id); v = p ? { ...p } : {}; }
  if (kind === 'wb') { const w = id && find('waterBodies', id); v = w ? { ...w } : { type: 'Pool' }; }
  if (kind === 'equip') { const e = id && find('equipment', id); v = e ? { ...e } : { status: 'OK' }; }
  UI.form = { kind, id, parent, fields: defs[0] };
  openSheet(`${id ? 'Editar' : 'Nuevo'} ${defs[1]}`, `<form id="frm" onsubmit="return false">${defs[0].map((f) => formFieldHtml(f, v[f.k])).join('')}${btn('Guardar', 'submitForm')}</form>`);
}
function submitForm() {
  const F = UI.form, g = (k) => { const el = document.querySelector(`#frm [name="${k}"]`); return el ? el.value.trim() : ''; };
  if (!F) return;
  const miss = F.fields.find((f) => f.req && !g(f.k));
  if (miss) { toast(`Falta: ${miss.l}`); return; }
  if (F.kind === 'client') {
    const old = F.id && find('clients', F.id);
    upsert('clients', { id: old ? old.id : uid('c'), name: g('name'), phone: g('phone'), email: g('email'), dispatch_channel_pref: g('channel') || 'WHATSAPP', dispatch_format_pref: g('format') || 'TEXT', status: old ? old.status : 'ACTIVE', notes: g('notes'), monthly_fee: toNum(g('monthly_fee')) || 0, tags: g('tags').split(',').map((t) => t.trim()).filter(Boolean) });
  } else if (F.kind === 'prop') {
    const old = F.id && find('properties', F.id);
    upsert('properties', { id: old ? old.id : uid('p'), client_id: old ? old.client_id : F.parent, address: g('address'), municipality: g('municipality'), gate_code: g('gate_code'), access_notes: g('access_notes'), lat: toNum(g('lat')) ?? DEPOT.lat, lng: toNum(g('lng')) ?? DEPOT.lng });
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
  let h = muted('Cliente', 'mb') + '<div class="chips">' + clients.map((c) => chip(c.name, c.id === UI.chem.clientId, 'chemClient', { id: c.id })).join('') + '</div>';
  if (!wb) return { title: 'Químicos', sub: 'Lecturas, dosis sugerida e historial', body: h + empty('Este cliente no tiene cuerpos de agua registrados.') };
  const gal = toNum(UI.chem.gal) || wb.gallons;
  h += muted('Cuerpo de agua', 'mb') + '<div class="chips">' + wbs.map((w) => chip(`${w.name} · ${w.gallons.toLocaleString('es-PR')} gal`, w.id === wb.id, 'chemWb', { id: w.id })).join('') + '</div>';
  h += fld('Volumen para el cálculo (galones)', input('chem_gal', UI.chem.gal, `inputmode="decimal" placeholder="${wb.gallons}"`));
  const key = `chem_${wb.id}_${UI.chem.n}`;
  h += readingForm(key, gal, draftOf(key, null), null, 'saveChemReading', { key, wb: wb.id }, 'Guardar lectura en el historial');
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
  h += muted('Técnico', 'mb') + '<div class="chips">' + chip('Todos', f.tech === 'ALL', 'shopF', { k: 'tech', v: 'ALL' }) + TECHNICIANS.map((t) => chip(t, f.tech === t, 'shopF', { k: 'tech', v: t })).join('') + '</div>';
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
    ${fld('Técnico asignado', `<select id="i_tech">${optList(TECHNICIANS.map((t) => [t, t]), i && i.assigned_to)}</select>`)}${btn('Guardar', 'saveItem')}
    ${id ? `<div class="mt-s"></div>${btn('Eliminar pieza', 'delItem', { id }, 'danger')}` : ''}`);
}

/* =====================================================================
   6. FACTURACIÓN
   ===================================================================== */
const INV_COLOR = { PENDING: COL.pending, SENT: COL.water, PAID: COL.ok, OVERDUE: COL.bad };
const invView = (i) => effectiveStatus(i, todayISO());

function invoicesTab() {
  const period = todayISO().slice(0, 7);
  const list = T('invoices').filter((i) => UI.invFilter === 'ALL' || invView(i) === UI.invFilter).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const owed = T('invoices').filter((i) => i.status !== 'PAID').reduce((s, i) => s + i.total_amount, 0), paid = T('invoices').filter((i) => i.status === 'PAID').reduce((s, i) => s + i.total_amount, 0);
  let h = `<div class="row mb"><div class="card grow" style="margin:0">${muted('Por cobrar')}<div class="big" style="color:${COL.bad}">${money(owed)}</div></div><div class="card grow" style="margin:0">${muted('Cobrado')}<div class="big" style="color:${COL.ok}">${money(paid)}</div></div></div>
    ${btn('⚡ Procesar facturación del mes (1 toque)', 'bulkInvoices', {}, 'dark')}<div class="mt"></div>
    <div class="chips">${chip('Todas', UI.invFilter === 'ALL', 'setInvFilter', { v: 'ALL' })}${Object.keys(STATUS_LABEL).map((s) => chip(STATUS_LABEL[s], UI.invFilter === s, 'setInvFilter', { v: s }, INV_COLOR[s])).join('')}</div>`;
  h += list.length ? '<div class="cols">' + list.map((i) => `<div class="card bar tap" style="border-left-color:${INV_COLOR[invView(i)]}" data-act="openInvoice" data-id="${i.id}"><div class="row between"><b>${esc(clientName(i.client_id))}</b>${badge(STATUS_LABEL[invView(i)], INV_COLOR[invView(i)])}</div>${muted(`${i.period} · vence ${fmtDate(i.due_date)}`, 'mt-s')}<div class="amount">${money(i.total_amount)}</div></div>`).join('') + '</div>' : empty('No hay facturas en esta vista.');
  return { title: 'Facturación', sub: `Periodo ${period}`, right: btn('+ Factura', 'newInvoice', {}, 'sm'), body: h };
}
function invoiceView(id) {
  const inv = find('invoices', id), c = inv && find('clients', inv.client_id);
  if (!inv || !c) return { title: '—', body: empty('Factura no encontrada.') };
  const h = `<div class="card"><b>${esc(c.name)}</b>${muted('Vence ' + fmtDate(inv.due_date))}<div class="mt-s">${badge(STATUS_LABEL[invView(inv)], INV_COLOR[invView(inv)])}</div></div>
    <h2>Desglose</h2><div class="card">${inv.lines.map((l) => `<div class="row between" style="padding:6px 0"><span>${l.kind === 'FEE' ? '🗓' : l.kind === 'PART' ? '🔧' : '📋'} ${esc(l.description)}</span><b>${money(l.amount)}</b></div>`).join('')}
    <div class="row between" style="border-top:1px solid var(--border);margin-top:6px;padding-top:8px"><b style="font-size:18px">Total</b><span class="amount">${money(inv.total_amount)}</span></div></div>
    <h2>Método de pago</h2>${seg(inv.payment_method, [['ATH_MOVIL', 'ATH Móvil'], ['CARD', 'Tarjeta'], ['STRIPE', 'Stripe'], ['TRANSFER', 'Transf.']], 'setPayment', { id: inv.id })}
    <div class="card mt" style="background:#f0f9ff;border-color:${COL.water}">${inv.payment_method === 'ATH_MOVIL' ? `${muted('ATH Móvil Business')}<div class="big" style="color:${COL.water}">${ATH_BUSINESS_PHONE}</div>` : ''}<div class="mt-s">${esc(paymentInstructions(inv.payment_method))}</div></div>
    ${inv.status === 'DRAFT' ? btn('Eliminar borrador', 'delDraft', { id: inv.id }, 'sm danger') : ''}`;
  const footer = btn('📤 Enviar factura (preferencia del cliente)', 'sendInvoice', { id: inv.id }) + (inv.status !== 'PAID' ? btn('✓ Marcar como pagada', 'markPaid', { id: inv.id }, 'ok') : '');
  return { title: `Factura ${inv.period}`, body: h, footer };
}
function createInvoiceFor(c) {
  const period = todayISO().slice(0, 7);
  if (T('invoices').some((i) => i.client_id === c.id && i.period === period)) return false;
  const { invoice, itemIds, orderIds } = buildInvoice(c, S.db, period, todayISO());
  if (!invoice.lines.length) return false;
  upsert('invoices', invoice);
  itemIds.forEach((id) => upsert('shoppingItems', { ...find('shoppingItems', id), status: 'INVOICED' }));
  orderIds.forEach((id) => upsert('workOrders', { ...find('workOrders', id), status: 'INVOICED' }));
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
const AREAS = ['Caguas', 'San Juan', 'Guaynabo', 'Dorado', 'Montehiedra', 'Comercial', 'Residencial'];

function msgRecipients() {
  const a = UI.msg.area.toLowerCase();
  return activeClients().filter((c) => UI.msg.area === 'ALL' || T('properties').some((p) => p.client_id === c.id && p.municipality.toLowerCase() === a) || c.tags.some((t) => t.toLowerCase() === a));
}
function msgTab() {
  const M = UI.msg, tpl = TEMPLATES.find((t) => t.id === M.tpl);
  if (M.subject === null) { M.subject = tpl.subject; M.body = tpl.body; }
  const act = activeClients(), combo = (ch, f) => act.filter((c) => c.dispatch_channel_pref === ch && c.dispatch_format_pref === f).length;
  const rec = msgRecipients();
  let h = `<h2>Motor de envío híbrido</h2><div class="card">Cada informe y factura sale por el canal (WhatsApp / Email / Ambos) y en el formato (PDF / Texto / Ambos) guardados en la ficha del cliente.
    ${muted('Clientes activos por preferencia', 'mt-s')}${['WHATSAPP', 'EMAIL', 'BOTH'].map((ch) => `<div>${{ WHATSAPP: 'WhatsApp', EMAIL: 'Email', BOTH: 'Ambos' }[ch]}: PDF ${combo(ch, 'PDF')} · Texto ${combo(ch, 'TEXT')} · Ambos ${combo(ch, 'BOTH')}</div>`).join('')}</div>
    <h2>Aviso masivo</h2>${muted('Plantilla', 'mb')}<div class="chips">${TEMPLATES.map((t) => chip(t.label, M.tpl === t.id, 'setTpl', { id: t.id })).join('')}</div>
    ${muted('Audiencia (zona o etiqueta)', 'mb')}<div class="chips">${chip('Todos', M.area === 'ALL', 'setArea', { v: 'ALL' })}${AREAS.map((a) => chip(a, M.area === a, 'setArea', { v: a })).join('')}</div>
    ${fld('Asunto (email)', input('m_subject', M.subject))}${fld('Mensaje ({nombre} se reemplaza por el nombre)', `<textarea id="m_body" style="min-height:140px">${esc(M.body)}</textarea>`)}
    <b>Destinatarios (${rec.length})</b><div class="mt-s"></div>`;
  h += rec.length ? rec.map((c) => `<div class="card"><div class="row"><div class="grow"><b>${M.sent[c.id] ? '✅ ' : ''}${esc(c.name)}</b>${muted(esc(prefText(c).split(' · ')[0]))}</div>${btn(M.sent[c.id] ? 'Reenviar' : 'Enviar', 'sendBroadcast', { id: c.id }, 'sm' + (M.sent[c.id] ? ' ghost' : ''))}</div></div>`).join('') : empty('Ningún cliente activo coincide con esta audiencia.');
  h += muted('El teléfono abre WhatsApp / Correo con el mensaje listo para cada cliente; hay que tocar «enviar» en cada uno.');
  const log = [...T('dispatchLog')].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 8);
  h += '<h2>Últimos envíos</h2>' + (log.length ? log.map((l) => `<div class="card"><b>${esc(clientName(l.client_id))}</b>${muted(`${{ REPORT: 'Informe', INVOICE: 'Factura', BROADCAST: 'Aviso' }[l.kind]} · ${l.channel} · ${l.format} · ${fmtDateTime(l.at)}`)}</div>`).join('') : empty('Aún no hay envíos registrados.'));
  h += `<h2>Sistema y sincronización</h2><div class="card"><b style="color:${online() ? COL.ok : COL.warn}">${online() ? '● En línea' : '● Modo offline'}</b>${muted(`${S.queue.length} cambio(s) pendientes · Última sincronización: ${S.lastSync ? fmtDateTime(S.lastSync) : 'nunca'}`)}
    <div class="row between mt"><span>Simular modo sin conexión (prueba)</span><label class="sw"><input type="checkbox" data-sim="1"${UI.simOffline ? ' checked' : ''}><i></i></label></div>
    <div class="mt"></div>${btn(UI.syncing ? 'Sincronizando…' : 'Sincronizar ahora', 'syncNow', {}, 'ghost')}${UI.installEvt ? '<div class="mt-s"></div>' + btn('📲 Instalar app en este teléfono', 'install', {}, 'dark') : ''}
    <div class="mt-s"></div>${btn('Restablecer datos de ejemplo', 'resetDemo', {}, 'sm danger')}</div>`;
  return { title: 'Mensajería', sub: 'Envío híbrido, avisos masivos y sincronización', body: h };
}

/* =====================================================================
   Envío en 1 toque (hoja de despacho)
   ===================================================================== */
function openDispatch(clientId, kind, doc, opts = {}) {
  const c = find('clients', clientId);
  if (!c || !doc) return;
  UI.dispatch = { clientId, kind, doc, forceFormat: opts.forceFormat || null, channel: c.dispatch_channel_pref, format: opts.forceFormat || c.dispatch_format_pref, done: [], edit: false, after: opts.after || null };
  renderDispatch();
  execDispatch(0); // misma pulsación del usuario: necesario para abrir WhatsApp / compartir
}
const dispActions = () => planDispatch(UI.dispatch.channel, UI.dispatch.forceFormat || UI.dispatch.format);
async function execDispatch(i) {
  const D = UI.dispatch, a = D && dispActions()[i];
  if (!a) return;
  try {
    const r = await runAction(a, find('clients', D.clientId), D.doc);
    if (UI.dispatch !== D) return;
    if (r !== 'cancelled' && !D.done.includes(a.id)) {
      const first = D.done.length === 0;
      D.done.push(a.id);
      upsert('dispatchLog', { id: uid('dl'), client_id: D.clientId, kind: D.kind, channel: a.channel, format: a.format, at: new Date().toISOString(), summary: D.doc.title });
      if (first && D.after) D.after();
    }
    if (r === 'downloaded') toast('PDF descargado: adjúntalo desde tus descargas');
    renderDispatch();
  } catch (e) { alert('No se pudo enviar: ' + e.message); }
}
function renderDispatch() {
  const D = UI.dispatch;
  if (!D) return;
  const c = find('clients', D.clientId), acts = dispActions(), rem = acts.findIndex((a) => !D.done.includes(a.id));
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
const VIEW_FN = { stop: stopView, client: clientView, order: orderView, invoice: invoiceView };

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
function closeSheet() { $('#layer').innerHTML = ''; UI.dispatch = null; UI.form = null; }
const sheetOpen = () => !!($('#layer') && $('#layer').firstChild);
function go(type, id) { UI.view = { type, id }; render(); }

/* =====================================================================
   Acciones (clics)
   ===================================================================== */
const A = {
  noop() {},
  tab: (d) => { UI.tab = d.v; UI.view = null; render(); },
  back: () => { UI.view = null; render(); },
  closeSheet,
  install: async () => { const e = UI.installEvt; if (!e) return; e.prompt(); await e.userChoice; UI.installEvt = null; render(); },
  syncNow,
  resetDemo: () => { if (confirm('Se reemplazarán TODOS los datos locales por los datos de ejemplo.')) { S.db = seedDb(todayISO()); S.queue = []; UI.drafts = {}; changed(); } },
  pick: (d, el) => { const seg = el.parentElement; seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === el)); seg.previousElementSibling.value = d.v; },
  submitForm,

  /* rutas */
  createRoute: () => {
    const rid = uid('r');
    upsert('routes', { id: rid, date: todayISO(), technician_id: ME, status: 'PLANNED' });
    const draft = T('properties').filter((p) => (find('clients', p.client_id) || {}).status === 'ACTIVE').map((p, i) => ({ id: uid('s'), route_id: rid, property_id: p.id, order_index: i, check_in_time: null, check_out_time: null, check_in_lat: null, check_in_lng: null, status: 'PENDING', checklist: [], active_water_body_ids: T('waterBodies').filter((w) => w.property_id === p.id).slice(0, 1).map((w) => w.id) }));
    const order = optimizeOrder(draft, T('properties'));
    draft.forEach((s) => upsert('stops', { ...s, order_index: order.indexOf(s.id), checklist: mkChecklist(s.id) }));
  },
  optimize: () => {
    const stops = routeStops(todayRoute()), fixed = stops.filter((s) => s.status !== 'PENDING'), pend = stops.filter((s) => s.status === 'PENDING');
    [...fixed.map((s) => s.id), ...optimizeOrder(pend, T('properties'))].forEach((id, i) => { const s = find('stops', id); if (s.order_index !== i) upsert('stops', { ...s, order_index: i }); });
    toast('Ruta optimizada por cercanía');
  },
  openStop: (d) => go('stop', d.id),
  startStop: async (d) => {
    toast('Registrando ubicación…');
    const c = await getCoords(), s = find('stops', d.id), r = todayRoute();
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
      const r = todayRoute();
      if (r && routeStops(r).every((x) => x.status === 'DONE')) upsert('routes', { ...r, status: 'DONE' });
    }
    UI.view = null; render();
    if (send) A.sendStop({ id: s.id });
  },
  sendStop: (d) => {
    const s = find('stops', d.id), p = find('properties', s.property_id);
    openDispatch(p.client_id, 'REPORT', buildStopDoc(S.db, s.id));
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
    const dose = suggestDoses(Object.fromEntries(PARAMS.map((p) => [p.key, numOf(v[p.key])])), wb.gallons)[+d.i];
    if (!dose) return;
    const dup = T('dosages').find((x) => x.stop_id === d.stop && x.water_body_id === d.wb && x.chemical_name === dose.chemical_name);
    if (dup) remove('dosages', dup.id);
    else upsert('dosages', { id: uid('ds'), stop_id: d.stop, water_body_id: d.wb, chemical_name: dose.chemical_name, amount: dose.amount, unit: dose.unit });
  },
  addPart: (d) => {
    const el = $('#part_name'), name = el && el.value.trim(), s = find('stops', d.stop);
    if (!name) return;
    upsert('shoppingItems', { id: uid('sh'), stop_id: s.id, client_id: find('properties', s.property_id).client_id, item_name: name, cost: 0, price: 0, status: 'REQUIRED', assigned_to: TECHNICIANS[0], created_at: new Date().toISOString() });
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
    if (confirm(`Se crearán ${targets.length} factura(s) de ${period} (cuota + piezas instaladas + órdenes completadas).`)) targets.forEach(createInvoiceFor);
  },
  newInvoice: () => openSheet('Factura individual', `${muted('Elige el cliente (periodo ' + todayISO().slice(0, 7) + ')')}<div class="chips mt-s">${activeClients().map((c) => chip(c.name, false, 'invFor', { id: c.id })).join('')}</div>`),
  invFor: (d) => { closeSheet(); if (!createInvoiceFor(find('clients', d.id))) alert('Ese cliente ya tiene factura de este periodo o no tiene nada que facturar.'); },
  setPayment: (d) => upsert('invoices', { ...find('invoices', d.id), payment_method: d.v }),
  markPaid: (d) => upsert('invoices', { ...find('invoices', d.id), status: 'PAID' }),
  sendInvoice: (d) => {
    const inv = find('invoices', d.id), c = find('clients', inv.client_id);
    openDispatch(c.id, 'INVOICE', buildInvoiceDoc(c, inv), { after: () => { const cur = find('invoices', inv.id); if (cur && cur.status === 'DRAFT') upsert('invoices', { ...cur, status: 'SENT' }); } });
  },
  delDraft: (d) => {
    const inv = find('invoices', d.id);
    if (!confirm('Las piezas y órdenes incluidas volverán a quedar pendientes de facturar.')) return;
    inv.lines.forEach((l) => {
      if (l.kind === 'PART' && find('shoppingItems', l.ref_id)) upsert('shoppingItems', { ...find('shoppingItems', l.ref_id), status: 'INSTALLED' });
      if (l.kind === 'WORK_ORDER' && find('workOrders', l.ref_id)) upsert('workOrders', { ...find('workOrders', l.ref_id), status: 'DONE' });
    });
    remove('invoices', inv.id); UI.view = null; render();
  },

  /* mensajería */
  setTpl: (d) => { const t = TEMPLATES.find((x) => x.id === d.id); UI.msg.tpl = d.id; UI.msg.subject = t.subject; UI.msg.body = t.body; render(); },
  setArea: (d) => { UI.msg.area = d.v; render(); },
  sendBroadcast: (d) => {
    const c = find('clients', d.id);
    if (!UI.msg.body.trim()) return toast('Escribe el mensaje');
    openDispatch(c.id, 'BROADCAST', buildBroadcastDoc(c, UI.msg.body, UI.msg.subject), { forceFormat: 'TEXT', after: () => { UI.msg.sent[c.id] = true; scheduleRender(); } });
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
    if (sg) sg.innerHTML = sugHtml(key, +sg.dataset.gal, v, sg.dataset.stop ? { stop: sg.dataset.stop, wb: sg.dataset.wb } : null);
  } else if (t.id === 'cl_q') { UI.q = t.value; scheduleRender(); }
  else if (t.id === 'chem_gal') { UI.chem.gal = t.value; const sg = document.querySelector('[id^="sg_chem_"]'); if (sg) { const wb = find('waterBodies', UI.chem.wbId) || T('waterBodies').find((w) => T('properties').some((p) => p.id === w.property_id && p.client_id === UI.chem.clientId)); const gal = toNum(t.value) || (wb && wb.gallons) || 0; sg.dataset.gal = gal; sg.innerHTML = sugHtml(sg.id.slice(3), gal, draftOf(sg.id.slice(3), null), null); } }
  else if (t.id === 'm_subject') UI.msg.subject = t.value;
  else if (t.id === 'm_body') UI.msg.body = t.value;
}
async function onChange(e) {
  const t = e.target;
  if (t.dataset.chk) { // checklist de parada u orden
    const tbl = t.dataset.chk === 'stop' ? 'stops' : 'workOrders', row = find(tbl, t.dataset.owner);
    upsert(tbl, { ...row, checklist: row.checklist.map((c) => (c.id === t.dataset.id ? { ...c, done: t.checked } : c)) });
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
  setupBack();
  try {
    const saved = await idbGet('state');
    if (saved && saved.db) { S.db = saved.db; S.queue = saved.queue || []; S.lastSync = saved.lastSync || null; TABLES.forEach((t) => { if (!S.db[t]) S.db[t] = []; }); }
  } catch (e) { /* IndexedDB no disponible: se usan datos de ejemplo en memoria */ }
  if (!S.db) S.db = seedDb(todayISO());
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  render(); maybeSync();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
if (typeof window !== 'undefined' && !window.__TEST__) boot();
