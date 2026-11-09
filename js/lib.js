/* Lógica pura de Elite Pool Service PR (sin DOM, salvo las funciones de envío y fotos). */
'use strict';

/* ---------- utilidades ---------- */
const pad2 = (n) => String(n).padStart(2, '0');
const uid = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const money = (n) => `$${(+n || 0).toFixed(2)}`;
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString('es-PR', { hour: '2-digit', minute: '2-digit' }) : '—');
const fmtDate = (iso) => new Date(iso.length === 10 ? iso + 'T12:00:00' : iso).toLocaleDateString('es-PR', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtDateTime = (iso) => `${fmtDate(iso)} ${fmtTime(iso)}`;
const digits = (s) => String(s || '').replace(/\D/g, '');
const toNum = (s) => { const n = parseFloat(String(s).replace(',', '.')); return isNaN(n) ? null : n; };
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* ---------- dosificación ---------- */
const PARAMS = [
  { key: 'free_chlorine', label: 'Cloro libre', unit: 'ppm', ok: [2, 5], warn: [1, 8] },
  { key: 'ph', label: 'pH', unit: '', ok: [7.2, 7.6], warn: [7.0, 7.8] },
  { key: 'alkalinity', label: 'Alcalinidad total', unit: 'ppm', ok: [80, 120], warn: [60, 150] },
  { key: 'cyanuric_acid', label: 'Ác. cianúrico', unit: 'ppm', ok: [30, 60], warn: [20, 80] },
  { key: 'salt', label: 'Sal', unit: 'ppm', ok: [2700, 3400], warn: [2400, 4000] },
  { key: 'calcium_hardness', label: 'Dureza de calcio', unit: 'ppm', ok: [200, 400], warn: [150, 500] },
];
const LEVEL_LABEL = { ok: 'En rango', warn: 'Precaución', bad: 'Crítico' };

function classify(key, v) {
  if (v === null || v === undefined || v === '' || isNaN(v)) return null;
  const d = PARAMS.find((p) => p.key === key);
  if (v >= d.ok[0] && v <= d.ok[1]) return 'ok';
  if (v >= d.warn[0] && v <= d.warn[1]) return 'warn';
  return 'bad';
}

const r1 = (n) => Math.round(n * 10) / 10;
function normalizeDose(amount, unit) {
  if (unit === 'oz' && amount >= 16) return { amount: r1(amount / 16), unit: 'lb' };
  if (unit === 'fl oz' && amount >= 128) return { amount: r1(amount / 128), unit: 'gal' };
  return { amount: r1(amount), unit };
}

/* ---------- catálogo de productos químicos ---------- */
/** per = cantidad para subir 1 ppm (o la unidad indicada) por cada 10,000 galones. Valores de guía de campo. */
const SANITIZERS = {
  LIQ125: { name: 'Cloro líquido 12.5%', unit: 'fl oz', per: 10.4 },
  LIQ10: { name: 'Cloro líquido 10%', unit: 'fl oz', per: 13 },
  BLEACH: { name: 'Cloro doméstico 6% (Clorox)', unit: 'fl oz', per: 21.7 },
  CALHYPO: { name: 'Hipoclorito de calcio 65% (granulado)', unit: 'oz', per: 2.1 },
  TRICHLOR: { name: 'Tricloro 90% (tabletas / polvo)', unit: 'oz', per: 1.5, cya: true },
  DICHLOR: { name: 'Dicloro 56% (granulado)', unit: 'oz', per: 2.4, cya: true },
  BROMINE: { name: 'Bromo (BCDMH, granulado / tabletas)', unit: 'oz', per: 2.2, br: true },
  SWG: { name: 'Generador de cloro salino (sal)', swg: true },
};
const PH_DOWN = {
  MURIATIC: { name: 'Ácido muriático 31.45%', unit: 'fl oz', phPer: 6, alkPer: 2.6 },
  DRYACID: { name: 'Ácido seco (bisulfato de sodio)', unit: 'oz', phPer: 8, alkPer: 2.4 },
};
const CALCIUM_UP = {
  CACL77: { name: 'Cloruro de calcio 77% (escamas)', per: 19 },
  CACL94: { name: 'Cloruro de calcio 94–97% (granulado)', per: 15.6 },
};
const CHEM_CATS = [
  { k: 'sanitizer', l: 'Desinfectante que uso normalmente', list: SANITIZERS },
  { k: 'ph_down', l: 'Para BAJAR el pH y la alcalinidad', list: PH_DOWN },
  { k: 'calcium', l: 'Para SUBIR la dureza de calcio', list: CALCIUM_UP },
];
const DEFAULT_CHEM = { sanitizer: 'LIQ125', ph_down: 'MURIATIC', calcium: 'CACL77' };
const DEFAULT_TARGETS = { free_chlorine: 3, ph: 7.4, alkalinity: 90, cyanuric_acid: 40, calcium_hardness: 300, salt: 3200 };
const chemPrefs = (...layers) => { const o = { ...DEFAULT_CHEM }; layers.forEach((l) => l && Object.keys(l).forEach((k) => { if (l[k] && (CHEM_CATS.find((c) => c.k === k) || {}).list && CHEM_CATS.find((c) => c.k === k).list[l[k]]) o[k] = l[k]; })); return o; };

/**
 * Dosis ESTIMADAS (guía de campo; verifica la etiqueta, aplica en dosis divididas si el ajuste es grande y vuelve a medir).
 * opts.prefs = productos; opts.targets = valores meta; opts.exact = true (calculadora) corrige cualquier diferencia con la meta,
 * si no (lecturas en parada) solo corrige cuando el valor está fuera de rango y lleva el valor a la meta.
 */
function suggestDoses(v, gallons, opts = {}) {
  const f = gallons / 10000, exact = !!opts.exact;
  const pf = chemPrefs(opts.prefs), T = { ...DEFAULT_TARGETS, ...(opts.targets || {}) };
  const san = SANITIZERS[pf.sanitizer], acid = PH_DOWN[pf.ph_down], cal = CALCIUM_UP[pf.calcium];
  const out = [];
  const push = (chemical_name, amount, unit, reason, alt = false) => {
    const n = normalizeDose(amount, unit);
    if (n.amount > 0) out.push({ chemical_name, amount: n.amount, unit: n.unit, reason, alt });
  };
  const note = (chemical_name, reason) => out.push({ chemical_name, amount: null, unit: '', reason, alt: false });
  const num = (x) => (x === null || x === undefined || x === '' ? null : +x);
  const x = { fc: num(v.free_chlorine), ph: num(v.ph), alk: num(v.alkalinity), cya: num(v.cyanuric_acid), ca: num(v.calcium_hardness), salt: num(v.salt) };
  const P = (k) => PARAMS.find((p) => p.key === k);
  const low = (val, k, tol) => val !== null && (exact ? val <= T[k] - tol : val < P(k).ok[0]);
  const high = (val, k, tol, auto) => val !== null && (exact ? val >= T[k] + tol : val > auto);
  const fcT = san && san.br ? Math.max(T.free_chlorine, 4) : T.free_chlorine, who = san && san.br ? 'Bromo' : 'Cloro';
  // desinfectante
  if (x.fc !== null && (exact ? x.fc <= fcT - 0.3 : x.fc < (san && san.br ? 3 : P('free_chlorine').ok[0]))) {
    const need = fcT - x.fc;
    if (san && san.swg) {
      push('Cloro líquido 12.5% (apoyo al generador)', need * SANITIZERS.LIQ125.per * f, 'fl oz', `${who} ${x.fc} ppm bajo`);
      note('Generador de sal', 'Sube la salida (%) del generador, alarga las horas de filtración y revisa sal y celda.');
    } else {
      push(san.name, need * san.per * f, san.unit, `${who} ${x.fc} ppm bajo${san.cya ? ' · ojo: este producto sube el ácido cianúrico' : ''}${san.br ? ' · las tabletas se disuelven lento (alimentador/flotador)' : ''}`);
      if (pf.sanitizer === 'LIQ125') push('Tricloro shock (alternativa)', need * 1.5 * f, 'oz', 'Alternativa al cloro líquido', true);
    }
  }
  if (high(x.fc, 'free_chlorine', 0.5, P('free_chlorine').warn[1])) note(`${who} alto`, 'No agregues más; baja solo con el sol y el uso. Si urge: neutralizador (tiosulfato de sodio) o diluir con agua fresca.');
  // pH y alcalinidad (el ácido sirve para los dos)
  const phHigh = high(x.ph, 'ph', 0.05, P('ph').ok[1]), alkHigh = high(x.alk, 'alkalinity', 4, P('alkalinity').ok[1]);
  const dPh = phHigh ? x.ph - T.ph : 0, dAlk = alkHigh ? x.alk - T.alkalinity : 0;
  if (phHigh || alkHigh) {
    const aPh = (dPh / 0.1) * acid.phPer * f, aAlk = dAlk * acid.alkPer * f;
    const reasons = [phHigh ? `pH ${x.ph} alto` : '', alkHigh ? `alcalinidad ${x.alk} ppm alta` : ''].filter(Boolean).join(' y ');
    const big = (phHigh && dPh > 0.4) || (alkHigh && dAlk > 30);
    push(acid.name, Math.max(aPh, aAlk), acid.unit, `${reasons}${big ? ' · aplicar en 2 o 3 dosis' : ''}`);
    if (alkHigh && !phHigh) note('Aireación', 'El ácido también baja el pH: airea el agua (chorros, cascada) para subir el pH sin subir la alcalinidad.');
  }
  if (low(x.ph, 'ph', 0.05)) { const d = T.ph - x.ph; push('Carbonato de sodio (Soda Ash)', (d / 0.1) * 3 * f, 'oz', `pH ${x.ph} bajo${d > 0.4 ? ' · aplicar en 2 dosis' : ''}`); }
  if (low(x.alk, 'alkalinity', 4) && x.alk < T.alkalinity) push('Bicarbonato de sodio', ((T.alkalinity - x.alk) / 10) * 1.5 * f * 16, 'oz', `Alcalinidad ${x.alk} ppm baja`);
  // estabilizador
  if (low(x.cya, 'cyanuric_acid', 4) && x.cya < T.cyanuric_acid) push('Estabilizador (ác. cianúrico)', ((T.cyanuric_acid - x.cya) / 10) * 13 * f, 'oz', `CYA ${x.cya} ppm bajo`);
  const dil = (val, tgt, label) => push('Diluir: vaciar parte y rellenar con agua fresca', Math.max(0, (1 - tgt / val) * 100), '% del agua', `${label} ${val} ppm alto (meta ${tgt}). No hay químico que lo baje.`);
  if (high(x.cya, 'cyanuric_acid', 4, P('cyanuric_acid').warn[1])) dil(x.cya, T.cyanuric_acid, 'CYA');
  // calcio y sal
  if (low(x.ca, 'calcium_hardness', 9) && x.ca < T.calcium_hardness) push(cal.name, ((T.calcium_hardness - x.ca) / 10) * cal.per * f, 'oz', `Dureza de calcio ${x.ca} ppm baja`);
  if (high(x.ca, 'calcium_hardness', 9, P('calcium_hardness').warn[1])) dil(x.ca, T.calcium_hardness, 'Calcio');
  if (low(x.salt, 'salt', 49) && x.salt < T.salt) push('Sal para piscina', ((T.salt - x.salt) / 100) * 8.34 * f, 'lb', `Sal ${x.salt} ppm baja (cuando lleve sal, espera y vuelve a medir)`);
  if (high(x.salt, 'salt', 49, P('salt').warn[1])) dil(x.salt, T.salt, 'Sal');
  return out;
}

/* ---------- rutas ---------- */
const DEPOT = { lat: 18.2341, lng: -66.0485 };
function haversineKm(a, b) {
  const R = 6371, dLat = ((b.lat - a.lat) * Math.PI) / 180, dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function optimizeOrder(stops, props, start = DEPOT) {
  const items = stops.map((s) => ({ s, p: props.find((p) => p.id === s.property_id) }));
  const withP = items.filter((x) => x.p), noP = items.filter((x) => !x.p);
  const pts = [start, ...withP.map((x) => x.p)];
  const d = (i, j) => haversineKm(pts[i], pts[j]);
  // 1) vecino más cercano desde el punto de inicio (índice 0)
  const left = withP.map((_, i) => i + 1), tour = [0];
  while (left.length) {
    let bi = 0, bd = Infinity; const cur = tour[tour.length - 1];
    left.forEach((n, i) => { const dd = d(cur, n); if (dd < bd) { bd = dd; bi = i; } });
    tour.push(left.splice(bi, 1)[0]);
  }
  // 1b) con pocas paradas (≤ 12) se calcula el orden EXACTO más corto (programación dinámica Held-Karp, ruta abierta)
  const n = withP.length;
  if (n >= 3 && n <= 12) {
    const FULL = 1 << n, INF = 1e18, dp = new Float64Array(FULL * n).fill(INF), par = new Int8Array(FULL * n).fill(-1);
    for (let i = 0; i < n; i++) dp[(1 << i) * n + i] = d(0, i + 1);
    for (let m = 1; m < FULL; m++) for (let last = 0; last < n; last++) {
      const cur = dp[m * n + last]; if (cur >= INF || !(m & (1 << last))) continue;
      for (let nx = 0; nx < n; nx++) { if (m & (1 << nx)) continue; const nm = m | (1 << nx), v = cur + d(last + 1, nx + 1); if (v < dp[nm * n + nx]) { dp[nm * n + nx] = v; par[nm * n + nx] = last; } }
    }
    let bl = 0, bv = INF; for (let i = 0; i < n; i++) if (dp[(FULL - 1) * n + i] < bv) { bv = dp[(FULL - 1) * n + i]; bl = i; }
    const seq = []; let m = FULL - 1, c = bl; while (c !== -1) { seq.push(c); const p = par[m * n + c]; m &= ~(1 << c); c = p; }
    return [...seq.reverse().map((i) => withP[i].s.id), ...noP.map((x) => x.s.id)];
  }
  // 2) mejora 2-opt (ruta abierta: el inicio queda fijo, el final es libre) para ahorrar km
  let improved = true, guard = 0;
  while (improved && guard++ < 50) {
    improved = false;
    for (let i = 1; i < tour.length - 1; i++) {
      for (let j = i + 1; j < tour.length; j++) {
        const a = tour[i - 1], b = tour[i], c = tour[j], e = j + 1 < tour.length ? tour[j + 1] : null;
        const delta = d(a, c) + (e != null ? d(b, e) : 0) - d(a, b) - (e != null ? d(c, e) : 0);
        if (delta < -1e-9) { tour.splice(i, j - i + 1, ...tour.slice(i, j + 1).reverse()); improved = true; }
      }
    }
  }
  return [...tour.slice(1).map((n) => withP[n - 1].s.id), ...noP.map((x) => x.s.id)];
}
/** Longitud total (km) de una ruta abierta desde `start`. */
function routeKm(orderProps, start = DEPOT) { let cur = start, t = 0; orderProps.forEach((p) => { t += haversineKm(cur, p); cur = p; }); return t; }
const navUrl = (p) => `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}&travelmode=driving`;
function routeUrl(props) {
  if (!props.length) return null;
  const dest = props[props.length - 1];
  const via = props.slice(0, -1).slice(0, 9).map((p) => `${p.lat},${p.lng}`).join('|');
  return `https://www.google.com/maps/dir/?api=1&destination=${dest.lat},${dest.lng}&travelmode=driving${via ? '&waypoints=' + encodeURIComponent(via) : ''}`;
}

/* ---------- facturación ---------- */
const ATH_BUSINESS_PHONE = '939-405-7458';
const STATUS_LABEL = { PENDING: 'Pendiente', SENT: 'Enviada', PAID: 'Pagada', OVERDUE: 'Vencida', CARRIED: 'Pasada a factura nueva' };
const PAY_METHODS = { ATH_MOVIL: 'ATH Móvil Business', ATH_PERSONAL: 'ATH Móvil personal', EFECTIVO: 'Efectivo', CHEQUE: 'Cheque', TARJETA: 'Tarjeta', TRANSFER: 'Transferencia' };
const PAYMENT_LABEL = { ATH_MOVIL: 'ATH Móvil Business', ATH_PERSONAL: 'ATH Móvil (personal)', CARD: 'Tarjeta de crédito', STRIPE: 'Stripe (enlace de pago)', TRANSFER: 'Transferencia' };
function effectiveStatus(inv, today) {
  if (inv.status === 'PAID') return 'PAID';
  if (inv.carried_to) return 'CARRIED';
  if (inv.status === 'SENT') return inv.due_date < today ? 'OVERDUE' : 'SENT';
  return 'PENDING';
}
/** Enlace de cobro ATH Móvil Business configurado por el dueño (se le agrega https:// si falta). */
function athUrl(cfg) {
  const l = ((cfg && cfg.pay && cfg.pay.athLink) || '').trim();
  return !l ? '' : /^https?:\/\//i.test(l) ? l : 'https://' + l;
}
function paymentInstructions(m, cfg) {
  if (m === 'ATH_MOVIL') {
    const link = athUrl(cfg), ph = cfg && cfg.pay ? (cfg.pay.athPhone || '').trim() : ATH_BUSINESS_PHONE, nm = (cfg && cfg.biz && cfg.biz.name) || 'Elite Pool Service PR';
    if (link) return `Pague por ATH Móvil Business con este enlace: ${link}${ph ? ` (o al ${ph})` : ''}`;
    return ph ? `Pague por ATH Móvil Business al ${ph} (${nm}).` : 'Coordine su pago por ATH Móvil Business con nosotros.';
  }
  if (m === 'ATH_PERSONAL') { const ph = cfg && cfg.pay ? (cfg.pay.athPersonalPhone || '').trim() : ''; return ph ? `Envíe su pago por ATH Móvil (personal) al ${ph}.` : 'Coordine su pago por ATH Móvil con nosotros.'; }
  if (m === 'CARD' || m === 'STRIPE') return 'Le enviaremos un enlace seguro de pago con tarjeta.';
  return 'Coordine su transferencia con nosotros; le daremos los datos bancarios.';
}
/** Cuota mensual + piezas INSTALADAS + órdenes COMPLETADAS. */
/** Texto del cobro del cliente: «$125.00 / mes» o «$35.00 por servicio». */
const feeLabel = (c) => `${money(c.monthly_fee)} ${c.fee_type === 'PER_SERVICE' ? 'por servicio' : '/ mes'}`;
/** Precio de una propiedad: el suyo si lo tiene; si no, el del cliente. */
const propFee = (p, c) => (p && p.fee != null && p.fee !== '' && +p.fee >= 0 ? +p.fee : +c.monthly_fee || 0);
const propFeeLabel = (p, c) => `${money(propFee(p, c))} ${c.fee_type === 'PER_SERVICE' ? 'por servicio' : '/ mes'}${p && p.fee != null && p.fee !== '' ? ' (precio propio)' : ' (precio del cliente)'}`;
/* ---------- condiciones de pago ---------- */
const TERMS = [['DUE_RECEIPT', 'Vence a la entrega'], ['NET7', 'Neto 7 días'], ['NET10', 'Neto 10 días'], ['NET15', 'Neto 15 días'], ['NET30', 'Neto 30 días'], ['NET45', 'Neto 45 días'], ['NET60', 'Neto 60 días'], ['EOM', 'Fin de mes']];
const termsLabel = (c) => (TERMS.find((t) => t[0] === c) || [])[1] || '';
function dueFor(code, issue) {
  if (code === 'DUE_RECEIPT') return issue;
  if (code === 'EOM') { const [y, m] = issue.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); }
  const n = +((/NET(\d+)/.exec(code) || [])[1]) || 15;
  return addDays(issue, n);
}
/* ---------- pagos, abonos, saldo a favor y saldo anterior ---------- */
const invPaid = (inv, db) => r2((db.payments || []).filter((p) => p.invoice_id === inv.id).reduce((s, p) => s + p.amount, 0));
/** Lo que falta por cobrar de una factura (0 si está pagada o si su saldo pasó a una factura nueva). */
const invBalance = (inv, db) => (inv.status === 'PAID' || inv.carried_to ? 0 : Math.max(0, r2(inv.total_amount - invPaid(inv, db))));
/** Saldo a favor del cliente: pagos adelantados menos lo ya aplicado en facturas. */
const clientCredit = (db, cid) => Math.max(0, r2((db.payments || []).filter((p) => p.client_id === cid && !p.invoice_id).reduce((s, p) => s + p.amount, 0) - db.invoices.filter((i) => i.client_id === cid).reduce((s, i) => s + (+i.credit_applied || 0), 0)));
const clientOwed = (db, cid) => r2(db.invoices.filter((i) => i.client_id === cid).reduce((s, i) => s + invBalance(i, db), 0));
function buildInvoice(client, db, period, today) {
  const lines = []; let stopIds = [];
  if (client.fee_type === 'PER_SERVICE') {
    // cobro por visita: cuenta las paradas completadas que aún no se han facturado (hasta el fin del periodo)
    const dateOf = (s) => (db.routes.find((r) => r.id === s.route_id) || {}).date || '';
    const visits = db.stops.filter((s) => s.status === 'DONE' && !s.invoice_id && db.properties.some((p) => p.id === s.property_id && p.client_id === client.id) && dateOf(s) && dateOf(s) <= `${period}-31`).sort((a, b) => dateOf(a).localeCompare(dateOf(b)));
    const myProps = db.properties.filter((p) => p.client_id === client.id), multi = myProps.length > 1;
    myProps.forEach((p) => {
      const vs = visits.filter((s) => s.property_id === p.id), fee = propFee(p, client);
      if (!vs.length || !(fee > 0)) return;
      stopIds.push(...vs.map((s) => s.id));
      const days = vs.map((s) => fmtDate(dateOf(s)).replace(/ \d{4}$/, '')).join(', ');
      lines.push({ description: `Mantenimiento de piscina${multi ? ' — ' + p.address : ''} — ${vs.length} visita${vs.length > 1 ? 's' : ''} × ${money(fee)} (${days})`, amount: Math.round(vs.length * fee * 100) / 100, kind: 'VISIT' });
    });
  } else {
    const myProps = db.properties.filter((p) => p.client_id === client.id);
    if (myProps.some((p) => p.fee != null && p.fee !== '')) {
      myProps.forEach((p) => { const fee = propFee(p, client); if (fee > 0) lines.push({ description: `Cuota mensual de mantenimiento — ${p.address}`, amount: fee, kind: 'FEE' }); });
    } else if (client.monthly_fee > 0) lines.push({ description: 'Cuota mensual de mantenimiento de piscina', amount: client.monthly_fee, kind: 'FEE' });
  }
  const items = db.shoppingItems.filter((i) => i.client_id === client.id && i.status === 'INSTALLED');
  items.forEach((i) => lines.push({ description: i.item_name, amount: i.price, kind: 'PART', ref_id: i.id }));
  const orders = db.workOrders.filter((w) => w.client_id === client.id && w.status === 'DONE');
  orders.forEach((w) => lines.push({ description: `${w.type}${w.description ? ' — ' + w.description : ''}`, amount: w.price, kind: 'WORK_ORDER', ref_id: w.id }));
  const newCount = lines.length;
  // saldo anterior: facturas anteriores con balance pendiente se suman a esta
  const carryIds = [];
  db.invoices.filter((i) => i.client_id === client.id && invBalance(i, db) > 0.005).sort((a, b) => (a.created_at || '').localeCompare(b.created_at || '')).forEach((i) => {
    carryIds.push(i.id);
    const paid = invPaid(i, db);
    lines.push({ description: `Saldo anterior — Factura ${invNumber(i, db)} (${i.period})${paid > 0 ? ` · total ${money(i.total_amount)}, abonado ${money(paid)}` : ''}`, amount: invBalance(i, db), kind: 'PREV', ref_id: i.id });
  });
  // saldo a favor (pago adelantado)
  const gross = r2(lines.reduce((s, l) => s + l.amount, 0)), credit = Math.min(clientCredit(db, client.id), gross);
  if (newCount && credit > 0.005) lines.push({ description: 'Pago adelantado aplicado', amount: -credit, kind: 'CREDIT' });
  const invoice = {
    credit_applied: newCount && credit > 0.005 ? credit : 0,
    id: uid('inv'), number: `EPS-${period.replace('-', '')}-${String(db.invoices.filter((i) => i.period === period).length + 1).padStart(3, '0')}`, client_id: client.id, period, lines,
    total_amount: Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100,
    payment_method: 'ATH_MOVIL', status: 'DRAFT', due_date: addDays(today, 15), issue_date: today, terms: 'NET15', created_at: new Date().toISOString(),
  };
  invoice.newCount = newCount;
  if (invoice.total_amount <= 0.005 && newCount) invoice.status = 'PAID';
  return { carryIds: newCount ? carryIds : [], invoice, itemIds: items.map((i) => i.id), orderIds: orders.map((o) => o.id), stopIds };
}

/* ---------- ajustes: negocio, logo y opciones del PDF ---------- */
const DEFAULT_SETTINGS = {
  biz: { name: 'Elite Pool Service PR', tagline: '', address: '', phone: '', email: '', regId: '', tech: '', team: 'Técnico 1, Técnico 2' },
  logo: null,
  pay: { athLink: '', athPhone: ATH_BUSINESS_PHONE, athPersonalPhone: '' },
  invoice: {
    logo: true, showName: true, bizInfo: true, number: true, dates: true, clientInfo: true, itemType: true, subtotals: true,
    payBox: true, instructions: true, terms: true, stamp: true, footer: true,
    template: 'classic', accent: '#0284c7', layout: 'twocol', termsCode: 'NET15',
    termsText: 'Gracias por su preferencia.',
    footerText: 'Gracias por confiar en Elite Pool Service PR',
  },
  quote: { validDays: 15, accept: true, terms: 'Cotización sujeta a cambios si las condiciones de la piscina o los equipos son diferentes a lo inspeccionado.', footerText: 'Gracias por su interés en Elite Pool Service PR' },
  catalog: [],
  chem: { ...DEFAULT_CHEM },
  targets: { ...DEFAULT_TARGETS },
  receipt: { ask: true, msg: 'Gracias por su pago.' },
  auto: { invoices: true, last: '' },
  report: {
    logo: false, showName: true, bizInfo: true, clientBlock: true, times: true, tech: true, readings: true, ideal: true, previous: true,
    summary: true, doses: true, equipment: false, checklist: true, notes: true, parts: true, photos: true, footer: true,
    footerText: 'Gracias por confiar en Elite Pool Service PR',
  },
};
function mergeSettings(saved) {
  const out = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  if (saved && typeof saved === 'object') {
    if (saved && Array.isArray(saved.catalog)) out.catalog = saved.catalog.filter((x) => x && x.name).map((x) => ({ name: String(x.name), price: +x.price || 0 }));
    for (const k of ['biz', 'pay', 'invoice', 'quote', 'report', 'receipt', 'auto']) if (saved[k] && typeof saved[k] === 'object') Object.assign(out[k], saved[k]);
    // migración: antes el código de condiciones se guardaba en invoice.terms (compartido con el interruptor de términos)
    if (saved.invoice && typeof saved.invoice.terms === 'string') { out.invoice.termsCode = TERMS.some((t) => t[0] === saved.invoice.terms) ? saved.invoice.terms : 'NET15'; out.invoice.terms = true; }
    if (out.invoice.termsText === 'Pago dentro de 15 días a partir de la fecha de emisión. Gracias por su preferencia.') out.invoice.termsText = 'Gracias por su preferencia.';
    if (saved.logo && saved.logo.data) out.logo = saved.logo;
    if (saved.chem && typeof saved.chem === 'object') out.chem = chemPrefs(saved.chem);
    if (saved.targets && typeof saved.targets === 'object') Object.keys(DEFAULT_TARGETS).forEach((k) => { const n = parseFloat(saved.targets[k]); if (!isNaN(n)) out.targets[k] = n; });
  }
  return out;
}
/** Reduce el logo y lo pasa a JPEG con fondo blanco (formato que el PDF puede incrustar directamente). */
async function processLogo(file) {
  const bmp = await createImageBitmap(file);
  const sc = Math.min(1, 700 / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * sc)), h = Math.max(1, Math.round(bmp.height * sc));
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); ctx.drawImage(bmp, 0, 0, w, h);
  return { data: cv.toDataURL('image/jpeg', 0.92), w, h };
}

/** Foto de referencia de una propiedad (sin sello): máx. 1000px, JPEG. */
async function processRef(file) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) { bmp = await createImageBitmap(file); }
  const sc = Math.min(1, 1000 / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * sc)), h = Math.max(1, Math.round(bmp.height * sc));
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  cv.getContext('2d').drawImage(bmp, 0, 0, w, h);
  return { uri: cv.toDataURL('image/jpeg', 0.75), w, h, at: Date.now() };
}

/* ---------- PDF (generador propio, sin librerías) ---------- */
const WIN = { '–': 0x96, '—': 0x97, '•': 0x95, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '€': 0x80, '●': 0x95, '✔': 0x95, '✓': 0x95 };
function winAnsi(s) {
  s = String(s ?? '').replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}‍]/gu, '');
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    out += c < 256 ? ch : WIN[ch] ? String.fromCharCode(WIN[ch]) : '?';
  }
  return out;
}
/* ---------- Código QR (byte, corrección M, versiones 1–20), sin librerías ---------- */
const QR_BLK = [null, [10, [1, 16]], [16, [1, 28]], [26, [1, 44]], [18, [2, 32]], [24, [2, 43]], [16, [4, 27]], [18, [4, 31]], [22, [2, 38], [2, 39]], [22, [3, 36], [2, 37]], [26, [4, 43], [1, 44]], [30, [1, 50], [4, 51]], [22, [6, 36], [2, 37]], [22, [8, 37], [1, 38]], [24, [4, 40], [5, 41]], [24, [5, 41], [5, 42]], [28, [7, 45], [3, 46]], [28, [10, 46], [1, 47]], [26, [9, 43], [4, 44]], [26, [3, 44], [11, 45]], [26, [3, 41], [13, 42]]];
const QR_ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90]];
const QR_EXP = new Array(512), QR_LOG = new Array(256);
(() => { let x = 1; for (let i = 0; i < 255; i++) { QR_EXP[i] = x; QR_LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; } for (let i = 255; i < 512; i++) QR_EXP[i] = QR_EXP[i - 255]; })();
const qrMul = (a, b) => (a && b ? QR_EXP[QR_LOG[a] + QR_LOG[b]] : 0);
function qrRs(data, n) {
  let g = [1];
  for (let i = 0; i < n; i++) { const ng = new Array(g.length + 1).fill(0); g.forEach((c, j) => { ng[j] ^= c; ng[j + 1] ^= qrMul(c, QR_EXP[i]); }); g = ng; }
  const r = new Array(n).fill(0);
  data.forEach((d) => { const f = d ^ r.shift(); r.push(0); if (f) for (let i = 0; i < n; i++) r[i] ^= qrMul(g[i + 1], f); });
  return r;
}
/** Devuelve una matriz de booleanos (true = módulo oscuro) con el texto en un QR, o null si no cabe. */
function qrMatrix(text) {
  const bytes = [...unescape(encodeURIComponent(text))].map((c) => c.charCodeAt(0));
  let ver = 0, nData = 0;
  for (let v = 1; v <= 20; v++) {
    const [ec, ...gs] = QR_BLK[v], blocks = gs.reduce((s, g) => s + g[0], 0), total = QR_TOT[v], dcw = total - blocks * ec;
    if (4 + (v < 10 ? 8 : 16) + bytes.length * 8 <= dcw * 8) { ver = v; nData = dcw; break; }
  }
  if (!ver) return null;
  const bits = []; const put = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(4, 4); put(bytes.length, ver < 10 ? 8 : 16); bytes.forEach((b) => put(b, 8));
  for (let i = 0; i < 4 && bits.length < nData * 8; i++) bits.push(0);
  while (bits.length % 8) bits.push(0);
  const cw = []; for (let i = 0; i < bits.length; i += 8) cw.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let p = 0; cw.length < nData; p++) cw.push(p % 2 ? 0x11 : 0xec);
  const [ecn, ...gs] = QR_BLK[ver], blks = []; let pos = 0;
  gs.forEach(([cnt, len]) => { for (let i = 0; i < cnt; i++) { blks.push(cw.slice(pos, pos + len)); pos += len; } });
  const ecs = blks.map((b) => qrRs(b, ecn)), out = [];
  const maxLen = Math.max(...blks.map((b) => b.length));
  for (let i = 0; i < maxLen; i++) blks.forEach((b) => { if (i < b.length) out.push(b[i]); });
  for (let i = 0; i < ecn; i++) ecs.forEach((e) => out.push(e[i]));
  const n = 17 + 4 * ver, m = Array.from({ length: n }, () => new Array(n).fill(false)), fn = Array.from({ length: n }, () => new Array(n).fill(false));
  const setFn = (x, y, d) => { if (x >= 0 && y >= 0 && x < n && y < n) { m[y][x] = !!d; fn[y][x] = true; } };
  for (let i = 0; i < n; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }
  const finder = (cx, cy) => { for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const d = Math.max(Math.abs(dx), Math.abs(dy)); setFn(cx + dx, cy + dy, d !== 2 && d !== 4); } };
  finder(3, 3); finder(n - 4, 3); finder(3, n - 4);
  const ap = QR_ALIGN[ver];
  ap.forEach((a, i) => ap.forEach((b, j) => { if ((i === 0 && j === 0) || (i === 0 && j === ap.length - 1) || (i === ap.length - 1 && j === 0)) return; for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setFn(a + dx, b + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1); }));
  const fmt = (mask) => {
    const data = (0 << 3) | mask; let rem = data << 10;
    for (let i = 14; i >= 10; i--) if ((rem >>> i) & 1) rem ^= 0x537 << (i - 10);
    const b = ((data << 10) | rem) ^ 0x5412, bit = (i) => (b >>> i) & 1;
    for (let i = 0; i <= 5; i++) setFn(8, i, bit(i));
    setFn(8, 7, bit(6)); setFn(8, 8, bit(7)); setFn(7, 8, bit(8));
    for (let i = 9; i < 15; i++) setFn(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) setFn(n - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) setFn(8, n - 15 + i, bit(i));
    setFn(8, n - 8, true);
  };
  fmt(0);
  if (ver >= 7) {
    let rem = ver; for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const b = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) { const bit = (b >>> i) & 1, a = n - 11 + (i % 3), c = Math.floor(i / 3); setFn(a, c, bit); setFn(c, a, bit); }
  }
  let k = 0;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < n; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j, up = ((right + 1) & 2) === 0, y = up ? n - 1 - vert : vert;
      if (!fn[y][x] && k < out.length * 8) { m[y][x] = ((out[k >> 3] >>> (7 - (k & 7))) & 1) === 1; k++; }
    }
  }
  const MASKS = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0, (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0, (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0];
  const applyMask = (mask) => { for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (!fn[y][x] && MASKS[mask](x, y)) m[y][x] = !m[y][x]; };
  const penalty = () => {
    let p = 0;
    const runs = (get) => { for (let a = 0; a < n; a++) { let run = 1; for (let b = 1; b < n; b++) { if (get(a, b) === get(a, b - 1)) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1; } } };
    runs((a, b) => m[a][b]); runs((a, b) => m[b][a]);
    for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) if (m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) p += 3;
    const pat = [1, 0, 1, 1, 1, 0, 1], chk = (get) => { for (let a = 0; a < n; a++) for (let b = 0; b + 6 < n; b++) { if (pat.every((v, i) => (get(a, b + i) ? 1 : 0) === v)) { const L = [b - 4, b - 3, b - 2, b - 1], R = [b + 7, b + 8, b + 9, b + 10]; const z = (arr) => arr.every((c) => c < 0 || c >= n || !get(a, c)); if (z(L) || z(R)) p += 40; } } };
    chk((a, b) => m[a][b]); chk((a, b) => m[b][a]);
    const dark = m.reduce((s, r) => s + r.filter(Boolean).length, 0); p += Math.floor(Math.abs((dark * 20) - (n * n * 10)) / (n * n)) * 10;
    return p;
  };
  let best = 0, bestP = Infinity;
  for (let mask = 0; mask < 8; mask++) { applyMask(mask); fmt(mask); const p = penalty(); if (p < bestP) { bestP = p; best = mask; } applyMask(mask); }
  applyMask(best); fmt(best);
  return m;
}
const QR_TOT = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346, 404, 466, 532, 581, 655, 733, 815, 901, 991, 1085];

const pdfEsc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
const toBytes = (str) => { const u = new Uint8Array(str.length); for (let i = 0; i < str.length; i++) u[i] = str.charCodeAt(i) & 255; return u; };
const b64ToBytes = (b64) => { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };

// Anchos de Helvetica (caracteres 32..126, en milésimas de em) para ajustar texto y alinear a la derecha.
const HW = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015,
  667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611,
  278, 278, 278, 469, 556, 333,
  556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500,
  334, 260, 334, 584];
function tw(str, size, bold) {
  let w = 0;
  for (const ch of String(str)) {
    const c = ch.charCodeAt(0);
    if (c < 32) continue;
    if (c <= 126) w += HW[c - 32];
    else { const b = ch.normalize('NFD').charCodeAt(0); w += b >= 32 && b <= 126 ? HW[b - 32] : 556; }
  }
  return (w / 1000) * size * (bold ? 1.07 : 1);
}
function wrapLines(str, size, bold, maxW) {
  const out = [];
  for (const para of winAnsi(str).split('\n')) {
    let cur = '';
    for (let w of para.split(' ')) {
      while (tw(w, size, bold) > maxW && w.length > 1) { // palabra más ancha que la línea: se parte
        let k = w.length - 1;
        while (k > 1 && tw(w.slice(0, k), size, bold) > maxW) k--;
        if (cur) { out.push(cur); cur = ''; }
        out.push(w.slice(0, k)); w = w.slice(k);
      }
      const trial = cur ? cur + ' ' + w : w;
      if (!cur || tw(trial, size, bold) <= maxW) cur = trial; else { out.push(cur); cur = w; }
    }
    out.push(cur);
  }
  return out;
}

const ACC = [0.008, 0.518, 0.78], INK = [0.06, 0.09, 0.16], GREY = [0.39, 0.45, 0.55], LINE = [0.89, 0.91, 0.94];
const LC = { ok: [0.04, 0.6, 0.42], warn: [0.85, 0.5, 0.02], bad: [0.86, 0.15, 0.15] };

/**
 * lines: [{t,size,b,c,indent,align}] | {space} | {rule} | {bar,c} | {row:[{t,w,align,b,c}],size,pad,bg,line,b,c}
 *        | {panel:{rows:[{t,size,b,c,align}],bg,border}} | {img:{data,w,h},maxW} | {imgRow:[{img,cap}]}
 * opts: {header:{logo,name,lines[],label,meta[[k,v]]}, footer, stamp:{text,color}}
 */
function buildPdf(title, lines, opts = {}) {
  const W = 595, H = 842, M = 44, CW = W - 2 * M, BOTTOM = 58;
  const images = [], pages = [];
  let ops, y, used, annots;
  const col = (c) => c.map((n) => (+n).toFixed(3)).join(' ');
  const text = (s, x, yy, size, b, c) => ops.push(`BT /${b ? 'F2' : 'F1'} ${size} Tf ${col(c)} rg 1 0 0 1 ${x.toFixed(1)} ${yy.toFixed(1)} Tm (${pdfEsc(winAnsi(s))}) Tj ET`);
  const rect = (x, yy, w, h, fill, stroke) => {
    if (fill) ops.push(`${col(fill)} rg ${x.toFixed(1)} ${yy.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)} re f`);
    if (stroke) ops.push(`${col(stroke)} RG 0.8 w ${x.toFixed(1)} ${yy.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)} re S`);
  };
  const hline = (yy, c = LINE, x0 = M, x1 = W - M) => ops.push(`${col(c)} RG 0.6 w ${x0} ${yy.toFixed(1)} m ${x1} ${yy.toFixed(1)} l S`);
  const imgIdx = (im) => { let i = images.findIndex((x) => x.data === im.data); if (i < 0) { images.push(im); i = images.length - 1; } used.add(i); return i; };
  const drawImg = (im, x, yTop, w, h) => ops.push(`q ${w.toFixed(1)} 0 0 ${h.toFixed(1)} ${x.toFixed(1)} ${(yTop - h).toFixed(1)} cm /Im${imgIdx(im) + 1} Do Q`);
  const newPage = () => { if (ops) pages.push({ ops, used, annots }); ops = []; used = new Set(); annots = []; y = H - M; if (((opts.theme || {}).t) === 'side') rect(0, 0, 16, H, (opts.theme || {}).acc || ACC); };
  const need = (h) => { if (y - h < BOTTOM) newPage(); };

  newPage();
  // ----- encabezado (primera página; varía según la plantilla) -----
  const hd = opts.header || { name: 'Elite Pool Service PR', lines: [], label: '', meta: [] };
  const th = opts.theme || { t: 'classic', acc: ACC }, AC = th.acc || ACC, WHITE = [1, 1, 1];
  const lsz = 20;
  const bigLogo = !hd.name && hd.logo; // el logo ya trae el nombre: se muestra más grande
  const logoDims = (mw, mh) => { if (bigLogo) { mw *= 1.5; mh *= 1.4; } const sc = Math.min(mw / hd.logo.w, mh / hd.logo.h); return { lw: hd.logo.w * sc, lh: hd.logo.h * sc }; };
  if (opts.hdrStyle === 'split') {
    // estilo recibo: logo grande a la izquierda con los datos de la compañía DEBAJO; a la derecha título, datos del documento y «Facturar a»
    const rw = CW * 0.46, rx = W - M - rw, leftMax = rx - M - 14;
    let ly = y;
    if (hd.logo) { const d = logoDims(190, 84); drawImg(hd.logo, M, ly, d.lw, d.lh); ly -= d.lh + 8; }
    if (hd.name) wrapLines(hd.name, 12, true, leftMax).forEach((ln) => { text(ln, M, ly - 10, 12, true, INK); ly -= 15; });
    (hd.lines || []).forEach((t) => wrapLines(t, 9, false, leftMax).forEach((ln) => { text(ln, M, ly - 8, 9, false, GREY); ly -= 12; }));
    let ry = y;
    if (hd.label) { text(hd.label, W - M - tw(hd.label, 20, true), ry - 18, 20, true, AC); ry -= 32; }
    (hd.meta || []).forEach(([k, v]) => { const vs = String(v); text(k, rx, ry - 9, 9.5, true, INK); text(vs, W - M - tw(vs, 9.5, false), ry - 9, 9.5, false, INK); ry -= 14; });
    if ((hd.billTo || []).length) {
      ry -= 8; text('Facturar a', rx, ry - 9, 9.5, true, INK);
      hd.billTo.forEach((s, i) => wrapLines(s, 9.5, i === 0, rw - 80).forEach((ln) => { text(ln, W - M - tw(ln, 9.5, i === 0), ry - 9, 9.5, i === 0, INK); ry -= 13; }));
    }
    y = Math.min(ly, ry) - 6; rect(M, y, CW, 2, AC); y -= 16;
  } else if (th.t === 'bold') {
    // título enorme a la izquierda, logo a la derecha; debajo, datos de la compañía (izq.) y del documento (der.)
    const d = hd.logo ? logoDims(130, 58) : null, LS = 30;
    if (hd.label) text(hd.label, M, y - 26, LS, true, AC);
    if (d) drawImg(hd.logo, W - M - d.lw, y, d.lw, d.lh);
    y -= Math.max(hd.label ? 34 : 0, d ? d.lh : 0) + 6; rect(M, y, CW, 2.5, AC); y -= 14;
    const rightW = Math.max(60, ...(hd.meta || []).map(([k, v]) => tw(`${k}  ${v}`, 9, false))) + 10, leftMax = CW - rightW - 16;
    let ly = y;
    if (hd.name) wrapLines(hd.name, 13, true, leftMax).forEach((ln) => { text(ln, M, ly - 10, 13, true, INK); ly -= 16; });
    (hd.lines || []).forEach((t) => wrapLines(t, 8.5, false, leftMax).forEach((ln) => { text(ln, M, ly - 8, 8.5, false, GREY); ly -= 11; }));
    let ry = y;
    (hd.meta || []).forEach(([k, v]) => { const s2 = `${k}  ${v}`; text(s2, W - M - tw(s2, 9, false), ry - 9, 9, false, INK); ry -= 12; });
    y = Math.min(ly, ry) - 6; hline(y, LINE); y -= 14;
  } else {
    // Logo a la izquierda; datos de la compañía pegados a su derecha, alineados con la BASE del logo; título y datos del documento arriba a la derecha.
    const metaTxt = (hd.meta || []).map(([k, v]) => `${k}  ${v}`);
    const rightW = Math.max(hd.label ? tw(hd.label, 20, true) : 0, ...metaTxt.map((s) => tw(s, 9, false))) + 22;
    const rightH = (hd.label ? 26 : 8) + metaTxt.length * 12;
    const frameIdx = ops.length, topY = y;
    let d = null, nameL = [], infoL = [], th_ = 0, textX = M, avail = CW;
    for (const sc of hd.logo ? [1, 0.9, 0.8, 0.7] : [1]) {
      d = hd.logo ? logoDims(150 * sc, 62 * sc) : null;
      textX = M + (d ? d.lw + 12 : 0);
      const wrapAt = (w) => { nameL = hd.name ? wrapLines(hd.name, 15, true, w) : []; infoL = []; (hd.lines || []).forEach((t) => wrapLines(t, 8.5, false, w).forEach((ln) => infoL.push(ln))); th_ = nameL.length * 17 + infoL.length * 11 + (nameL.length ? 0 : 2); };
      avail = CW - (textX - M); wrapAt(avail);
      const logoH = d ? d.lh : 0, textTop = d ? Math.min(th_, logoH) : th_; // alto del texto que queda dentro del logo (alineado abajo)
      const overlapsRight = (d ? logoH : 0) - th_ < rightH; // el texto sube hasta la zona donde están los datos de la derecha
      if (overlapsRight) { avail = CW - (textX - M) - rightW - 8; wrapAt(Math.max(60, avail)); }
      if (!d || avail >= 110) break;
    }
    const logoH = d ? d.lh : 0, blockH = Math.max(logoH, th_);
    if (d) drawImg(hd.logo, M, y, d.lw, d.lh);
    let ly = y - blockH + th_ - 13 + (nameL.length ? 0 : 4);
    nameL.forEach((ln) => { text(ln, textX, ly, 15, true, INK); ly -= 17; });
    infoL.forEach((ln) => { text(ln, textX, ly, 8.5, false, GREY); ly -= 11; });
    let ry = y - 20;
    if (hd.label) { text(hd.label, W - M - tw(hd.label, 20, true), ry, 20, true, AC); ry -= 20; }
    metaTxt.forEach((s) => { text(s, W - M - tw(s, 9, false), ry, 9, false, INK); ry -= 12; });
    y = Math.min(y - blockH, ry) - 8;
    if (th.t === 'frame') {
      const x0 = M - 10, w0 = CW + 20, yb = y - 6, top = topY + 10;
      ops.splice(frameIdx, 0, `${col(mixW(AC, 0.93))} rg ${x0.toFixed(1)} ${yb.toFixed(1)} ${w0.toFixed(1)} ${(top - yb).toFixed(1)} re f`, `${col(mixW(AC, 0.7))} RG 0.8 w ${x0.toFixed(1)} ${yb.toFixed(1)} ${w0.toFixed(1)} ${(top - yb).toFixed(1)} re S`, `${col(AC)} rg ${x0.toFixed(1)} ${yb.toFixed(1)} ${w0.toFixed(1)} 3 re f`);
      y = yb - 14;
    } else { rect(M, y, CW, th.t === 'side' ? 1.2 : 3, AC); y -= 18; }
  }

  // ----- contenido -----
  for (const it of lines) {
    if (it.space) { y -= it.space; continue; }
    if (it.rule) { need(8); hline(y - 2); y -= 8; continue; }
    if (it.bar) { need(it.keep || 70); rect(M, y - 18, CW, 18, it.c || AC); text(it.bar, M + 8, y - 13, 10.5, true, [1, 1, 1]); y -= 24; continue; }
    if (it.row) {
      const size = it.size || 10, pad = it.pad ?? 4, lh = size * 1.3;
      const xs = []; let x = M; it.row.forEach((c) => { xs.push(x); x += c.w * CW; });
      const wr = it.row.map((c) => wrapLines(c.t ?? '', size, c.b || it.b, c.w * CW - 2 * pad));
      const h = Math.max(...wr.map((w) => w.length)) * lh + 2 * pad - (lh - size) * 0.3;
      need(h);
      if (it.bg) rect(M, y - h, CW, h, it.bg);
      it.row.forEach((c, i) => wr[i].forEach((ln, j) => {
        const bold = c.b || it.b, bw = tw(ln, size, bold);
        const px = c.align === 'right' ? xs[i] + c.w * CW - pad - bw : c.align === 'center' ? xs[i] + (c.w * CW - bw) / 2 : xs[i] + pad;
        text(ln, px, y - pad - size * 0.9 - j * lh, size, bold, c.c || it.c || INK);
      }));
      if (it.line) hline(y - h);
      y -= h; continue;
    }
    if (it.panel) {
      const p = it.panel, pad = 10, inner = CW - 2 * pad;
      const blocks = p.rows.map((r) => { const size = r.size || 10; return { r, size, ls: wrapLines(r.t, size, r.b, inner) }; });
      const h = blocks.reduce((s, b) => s + b.ls.length * b.size * 1.35, 0) + 2 * pad - 2;
      need(h);
      rect(M, y - h, CW, h, p.bg || [0.95, 0.98, 1], p.border || [0.73, 0.9, 0.99]);
      let yy = y - pad;
      blocks.forEach((b) => b.ls.forEach((ln) => {
        const bw = tw(ln, b.size, b.r.b), px = b.r.align === 'right' ? W - M - pad - bw : M + pad;
        text(ln, px, yy - b.size * 0.9, b.size, b.r.b, b.r.c || INK);
        if (b.r.link) { annots.push(`<< /Type /Annot /Subtype /Link /Rect [${px.toFixed(1)} ${(yy - b.size * 1.2).toFixed(1)} ${(px + bw).toFixed(1)} ${(yy + 1).toFixed(1)}] /Border [0 0 0] /A << /S /URI /URI (${pdfEsc(b.r.link)}) >> >>`); hline(yy - b.size * 1.1, b.r.c || INK, px, px + bw); }
        yy -= b.size * 1.35;
      }));
      y -= h + 6; continue;
    }
    if (it.split) {
      const lw = CW * 0.46, rw = CW * 0.5, rx = M + CW - rw, pad = 8, sp = it.split, LF = sp.left || {}, TT = sp.right || [];
      const rowsL = (LF.rows || []).map((r) => { const size = r.size || 10; return { r, size, ls: wrapLines(r.t, size, r.b, lw - 2 * pad) }; });
      const hL = (LF.title ? 26 : 0) + rowsL.reduce((s, b) => s + b.ls.length * b.size * 1.4, 0) + 4;
      const hR = TT.reduce((s, r) => s + (r.size || 10) * 1.3 + 2 * (r.pad ?? 4), 0);
      const h = Math.max(hL, hR); need(h);
      let yy = y;
      if (LF.title) { rect(M, yy - 22, lw, 22, AC); text(LF.title, M + pad, yy - 15, 10.5, true, [1, 1, 1]); yy -= 26; }
      rowsL.forEach((b) => b.ls.forEach((ln) => {
        text(ln, M + pad, yy - b.size * 0.95, b.size, b.r.b, b.r.c || INK);
        if (b.r.link) { const bw = tw(ln, b.size, b.r.b), px = M + pad; annots.push(`<< /Type /Annot /Subtype /Link /Rect [${px.toFixed(1)} ${(yy - b.size * 1.2).toFixed(1)} ${(px + bw).toFixed(1)} ${(yy + 1).toFixed(1)}] /Border [0 0 0] /A << /S /URI /URI (${pdfEsc(b.r.link)}) >> >>`); hline(yy - b.size * 1.1, b.r.c || INK, px, px + bw); }
        yy -= b.size * 1.4;
      }));
      let ty = y;
      TT.forEach((r) => {
        const size = r.size || 10, p = r.pad ?? 4, rh = size * 1.3 + 2 * p;
        if (r.bg) rect(rx, ty - rh, rw, rh, r.bg);
        text(r.l, rx + 8, ty - p - size * 0.9, size, r.b, r.c || (r.bg ? [1, 1, 1] : GREY));
        text(r.v, rx + rw - 8 - tw(r.v, size, r.b), ty - p - size * 0.9, size, r.b, r.c || (r.bg ? [1, 1, 1] : INK));
        if (r.line) hline(ty - rh, LINE, rx, rx + rw);
        ty -= rh;
      });
      y -= h + 8; continue;
    }
    if (it.cols2) {
      const gap = 10, pw = (CW - gap) / 2, pad = 9;
      const mk = (side) => side.map((r) => { const size = r.size || 9.5; return { r, size, ls: wrapLines(r.t, size, r.b, pw - 2 * pad) }; });
      const bl = [mk(it.cols2[0]), mk(it.cols2[1])];
      const h = Math.max(...bl.map((b) => b.reduce((s, x) => s + x.ls.length * x.size * 1.35, 0))) + 2 * pad - 2;
      need(h);
      bl.forEach((b, i) => {
        const x0 = M + i * (pw + gap); rect(x0, y - h, pw, h, it.bg || [0.97, 0.98, 0.99], it.border || [0.88, 0.9, 0.93]);
        let yy = y - pad;
        b.forEach((x) => x.ls.forEach((ln) => {
          text(ln, x0 + pad, yy - x.size * 0.9, x.size, x.r.b, x.r.c || INK);
          if (x.r.link) { const bw = tw(ln, x.size, x.r.b), px = x0 + pad; annots.push(`<< /Type /Annot /Subtype /Link /Rect [${px.toFixed(1)} ${(yy - x.size * 1.2).toFixed(1)} ${(px + bw).toFixed(1)} ${(yy + 1).toFixed(1)}] /Border [0 0 0] /A << /S /URI /URI (${pdfEsc(x.r.link)}) >> >>`); hline(yy - x.size * 1.1, x.r.c || INK, px, px + bw); }
          yy -= x.size * 1.35;
        }));
      });
      y -= h + 8; continue;
    }
    if (it.totals) {
      const bw = (it.w || 0.5) * CW, x0 = M + CW - bw;
      it.totals.forEach((r) => {
        const size = r.size || 10, pad = r.pad ?? 4, h = size * 1.3 + 2 * pad;
        need(h);
        if (r.bg) rect(x0, y - h, bw, h, r.bg);
        text(r.l, x0 + 8, y - pad - size * 0.9, size, r.b, r.c || (r.bg ? [1, 1, 1] : GREY));
        const vs = r.v, vw = tw(vs, size, r.b); text(vs, x0 + bw - 8 - vw, y - pad - size * 0.9, size, r.b, r.c || (r.bg ? [1, 1, 1] : INK));
        if (r.line) hline(y - h, LINE, x0, x0 + bw);
        y -= h;
      });
      y -= 8; continue;
    }
    if (it.qr) {
      const mx = qrMatrix(it.qr.url);
      if (mx) {
        const pad = 10, quiet = 2, cells = mx.length + 2 * quiet, side = 96, mod = side / cells, boxH = side + 2 * pad;
        need(boxH);
        rect(M, y - boxH, CW, boxH, it.qr.bg || [0.97, 0.98, 0.99], it.qr.border || [0.88, 0.9, 0.93]);
        const qx = M + pad, qy = y - pad;
        rect(qx, qy - side, side, side, [1, 1, 1]);
        mx.forEach((row, r) => row.forEach((on, c) => { if (on) ops.push(`0 0 0 rg ${(qx + (c + quiet) * mod).toFixed(2)} ${(qy - (r + quiet + 1) * mod).toFixed(2)} ${(mod + 0.15).toFixed(2)} ${(mod + 0.15).toFixed(2)} re f`); }));
        annots.push(`<< /Type /Annot /Subtype /Link /Rect [${qx.toFixed(1)} ${(qy - side).toFixed(1)} ${(qx + side).toFixed(1)} ${qy.toFixed(1)}] /Border [0 0 0] /A << /S /URI /URI (${pdfEsc(it.qr.url)}) >> >>`);
        const tx = qx + side + 14, tW = W - M - pad - tx; let ty = qy - 4;
        const blocks = [{ t: 'PAGUE CON EL CÓDIGO QR', size: 10.5, b: true }, { t: 'Escanéelo con la cámara de su teléfono, o desde una computadora abra el enlace:', size: 9, c: GREY }];
        blocks.forEach((b2) => wrapLines(b2.t, b2.size, b2.b, tW).forEach((ln) => { text(ln, tx, ty - b2.size * 0.9, b2.size, b2.b, b2.c || INK); ty -= b2.size * 1.35; }));
        ty -= 3;
        wrapLines(it.qr.url, 7.5, false, tW).forEach((ln) => { const bw = tw(ln, 7.5, false); text(ln, tx, ty - 7.5 * 0.9, 7.5, false, it.qr.c || INK); annots.push(`<< /Type /Annot /Subtype /Link /Rect [${tx.toFixed(1)} ${(ty - 9).toFixed(1)} ${(tx + bw).toFixed(1)} ${(ty + 1).toFixed(1)}] /Border [0 0 0] /A << /S /URI /URI (${pdfEsc(it.qr.url)}) >> >>`); ty -= 7.5 * 1.3; });
        y -= boxH + 6;
      }
      continue;
    }
    if (it.imgRow) {
      const n = it.imgRow.length, gap = 12, w = (CW - gap * (n - 1)) / n, maxH = 200;
      const dims = it.imgRow.map((o) => { let ww = w, hh = (o.img.h / o.img.w) * ww; if (hh > maxH) { hh = maxH; ww = (o.img.w / o.img.h) * hh; } return { ww, hh }; });
      const rowH = Math.max(...dims.map((d) => d.hh)) + 16;
      need(rowH);
      it.imgRow.forEach((o, i) => {
        const x = M + i * (w + gap);
        drawImg(o.img, x, y, dims[i].ww, dims[i].hh);
        if (o.cap) text(o.cap, x, y - dims[i].hh - 10, 8, false, GREY);
      });
      y -= rowH + 4; continue;
    }
    if (it.img) {
      const maxW = it.maxW || 260, w = Math.min(maxW, it.img.w), h = (it.img.h / it.img.w) * w;
      need(h + 6); drawImg(it.img, M, y, w, h); y -= h + 8; continue;
    }
    // texto con ajuste de línea
    const size = it.size || 10.5, indent = it.indent || 0, lh = size * 1.38;
    wrapLines(it.t, size, it.b, CW - indent).forEach((ln) => {
      need(lh);
      const bw = tw(ln, size, it.b), px = it.align === 'right' ? W - M - bw : it.align === 'center' ? M + (CW - bw) / 2 : M + indent;
      text(ln, px, y - size, size, it.b, it.c || INK); y -= lh;
    });
  }
  pages.push({ ops, used, annots });

  // ----- sello, pie y número de página -----
  const total = pages.length;
  pages.forEach((p, i) => {
    ops = p.ops;
    if (i === 0 && opts.stamp) {
      const c = opts.stamp.color || LC.ok, s = opts.stamp.text, size = 62, ang = 0.35, cs = Math.cos(ang), sn = Math.sin(ang);
      const bw = tw(s, size, true), cx = W / 2, cy = H / 2 + 40;
      ops.push(`q /GS1 gs ${col(c)} rg BT /F2 ${size} Tf ${cs.toFixed(4)} ${sn.toFixed(4)} ${(-sn).toFixed(4)} ${cs.toFixed(4)} ${(cx - (bw / 2) * cs).toFixed(1)} ${(cy - (bw / 2) * sn).toFixed(1)} Tm (${pdfEsc(winAnsi(s))}) Tj ET Q`);
    }
    hline(40, LINE);
    if (opts.footer) text(opts.footer, M, 28, 8, false, GREY);
    const pg = `Página ${i + 1} de ${total}`;
    text(pg, W - M - tw(pg, 8, false), 28, 8, false, GREY);
  });

  // ----- ensamblado -----
  const imgBase = 5, pageBase = imgBase + images.length;
  const chunks = [], offsets = [];
  let len = 0;
  const add = (x) => { const u = typeof x === 'string' ? toBytes(x) : x; chunks.push(u); len += u.length; };
  const obj = (id, body) => { offsets[id] = len; add(`${id} 0 obj\n`); add(body); add('\nendobj\n'); };
  add('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${pages.map((_, i) => `${pageBase + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  obj(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  images.forEach((im, i) => {
    const data = b64ToBytes(im.data.split(',')[1]);
    offsets[imgBase + i] = len;
    add(`${imgBase + i} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${data.length} >>\nstream\n`);
    add(data); add('\nendstream\nendobj\n');
  });
  pages.forEach((p, i) => {
    const pid = pageBase + i * 2, cid = pid + 1;
    const xo = p.used.size ? ` /XObject << ${[...p.used].map((k) => `/Im${k + 1} ${imgBase + k} 0 R`).join(' ')} >>` : '';
    obj(pid, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> /ExtGState << /GS1 << /ca 0.16 /CA 0.16 >> >>${xo} >> /Contents ${cid} 0 R${p.annots.length ? ` /Annots [${p.annots.join(' ')}]` : ''} >>`);
    const stream = toBytes(p.ops.join('\n'));
    offsets[cid] = len;
    add(`${cid} 0 obj\n<< /Length ${stream.length} >>\nstream\n`); add(stream); add('\nendstream\nendobj\n');
  });
  const totalObjs = pageBase + pages.length * 2, xref = len;
  add(`xref\n0 ${totalObjs}\n0000000000 65535 f \n`);
  for (let id = 1; id < totalObjs; id++) add(String(offsets[id]).padStart(10, '0') + ' 00000 n \n');
  add(`trailer\n<< /Size ${totalObjs} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
  const out = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/* ---------- documentos (texto para WhatsApp/email + estructura del PDF) ---------- */
const EMOJI = { ok: '✅', warn: '⚠️', bad: '🔴' };
const WB_TYPE = { Pool: 'Piscina', Jacuzzi: 'Jacuzzi / Spa', Commercial: 'Comercial' };
const LV_TXT = { ok: '• En rango', warn: '• Precaución', bad: '• Crítico' };

function bizLines(b) {
  return [b.tagline, b.address, b.phone && `Tel. ${b.phone}`, b.email, b.regId && `Reg.: ${b.regId}`].filter(Boolean);
}
/* ---------- plantillas de factura / cotización ---------- */
const DOC_TEMPLATES = [
  ['classic', 'Clásica', 'Línea de color arriba y barras de color. La de siempre.'],
  ['side', 'Franja lateral', 'Franja de color en el borde izquierdo de cada página y línea fina arriba.'],
  ['frame', 'Recuadro', 'Encabezado dentro de un recuadro de color suave.'],
  ['bold', 'Título grande', 'FACTURA en grande a la izquierda, logo a la derecha y datos en dos columnas.'],
];
const ACCENTS = ['#0284c7', '#0d9488', '#16a34a', '#7c3aed', '#be123c', '#ea580c', '#0f172a'];
const hexRgb = (h) => { const m = /^#?([0-9a-f]{6})$/i.exec(String(h || '').trim()); return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255) : null; };
const mixW = (c, k) => c.map((v) => v + (1 - v) * k);
function docTheme(cfg) {
  const o = cfg.invoice, t = DOC_TEMPLATES.some((x) => x[0] === o.template) ? o.template : 'classic';
  const acc = hexRgb(o.accent) || ACC;
  return { t, acc, flat: false, soft: mixW(acc, 0.93), edge: mixW(acc, 0.7) };
}
function pdfHeader(cfg, key, label, meta) {
  const o = cfg[key];
  const logo = o.logo && cfg.logo ? cfg.logo : null;
  return { logo, name: logo && o.showName === false ? '' : cfg.biz.name || 'Elite Pool Service PR', lines: o.bizInfo ? bizLines(cfg.biz) : [], label, meta };
}
function invNumber(inv, db) {
  if (inv.number) return inv.number;
  const same = (db ? db.invoices : []).filter((i) => i.period === inv.period).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const rank = Math.max(1, same.findIndex((i) => i.id === inv.id) + 1);
  return `EPS-${inv.period.replace('-', '')}-${String(rank).padStart(3, '0')}`;
}
const kv = (k, v) => ({ size: 10, pad: 2, row: [{ t: k, w: 0.2, b: true, c: GREY }, { t: v, w: 0.8 }] });
const sideBySide = (items) => { // lista de [texto] en filas de 2 columnas
  const rows = [];
  for (let i = 0; i < items.length; i += 2) rows.push({ size: 10, pad: 2, row: [{ t: '• ' + items[i], w: 0.5 }, { t: items[i + 1] ? '• ' + items[i + 1] : '', w: 0.5 }] });
  return rows;
};

function buildStopDoc(db, stopId, cfgIn) {
  const cfg = cfgIn || mergeSettings(null), o = cfg.report;
  const stop = db.stops.find((s) => s.id === stopId);
  if (!stop) return null;
  const prop = db.properties.find((p) => p.id === stop.property_id);
  const client = prop && db.clients.find((c) => c.id === prop.client_id);
  if (!prop || !client) return null;
  const route = db.routes.find((r) => r.id === stop.route_id);
  const dateISO = (route && route.date) || stop.check_in_time || new Date().toISOString();
  const date = fmtDate(dateISO);
  const wbs = db.waterBodies.filter((w) => stop.active_water_body_ids.includes(w.id));
  const done = stop.checklist.filter((c) => c.done);
  const photos = db.photos.filter((p) => p.owner_type === 'STOP' && p.owner_id === stop.id);
  const parts = db.shoppingItems.filter((i) => i.stop_id === stop.id);
  const PST = { REQUIRED: 'Requerida', PURCHASED: 'Comprada', INSTALLED: 'Instalada', INVOICED: 'Instalada' };
  const tech = o.tech && cfg.biz.tech ? cfg.biz.tech : '';

  // ---- texto (WhatsApp / correo) ----
  let text = `🏊 *${cfg.biz.name}* — Informe de servicio\nCliente: ${client.name}\nDirección: ${prop.address}\nFecha: ${date}\n`;
  if (o.times && !client.hide_times) text += `Horario: ${fmtTime(stop.check_in_time)} – ${fmtTime(stop.check_out_time)}\n`;
  if (tech) text += `Técnico: ${tech}\n`;
  // ---- PDF ----
  const L = [];
  if (o.clientBlock) {
    L.push({ t: 'DATOS DEL SERVICIO', size: 8.5, b: true, c: GREY }, kv('Cliente', client.name), kv('Dirección', `${prop.address}, ${prop.municipality}`));
    if (client.phone) L.push(kv('Teléfono', client.phone));
    L.push(kv('Fecha', date));
    if (o.times && !client.hide_times) L.push(kv('Horario', `Entrada ${fmtTime(stop.check_in_time)} · Salida ${fmtTime(stop.check_out_time)}`));
    if (tech) L.push(kv('Técnico', tech));
    L.push({ space: 6 });
  }
  wbs.forEach((wb) => {
    const r = db.readings.find((x) => x.stop_id === stop.id && x.water_body_id === wb.id);
    const prev = r ? db.readings.filter((x) => x.water_body_id === wb.id && x.id !== r.id && x.created_at < r.created_at).sort((a, b) => b.created_at.localeCompare(a.created_at))[0] : null;
    const doses = db.dosages.filter((d) => d.stop_id === stop.id && d.water_body_id === wb.id);
    text += `\n*${wb.name}* (${wb.gallons.toLocaleString('es-PR')} gal)\n`;
    L.push({ bar: `${wb.name}  ·  ${wb.gallons.toLocaleString('es-PR')} gal  ·  ${WB_TYPE[wb.type] || wb.type}` });
    const att = [];
    if (r) PARAMS.forEach((p) => {
      const v = r[p.key];
      if (v == null) return;
      const lvl = classify(p.key, v);
      text += `${EMOJI[lvl]} ${p.label}: ${v}${p.unit ? ' ' + p.unit : ''}\n`;
      if (lvl !== 'ok') att.push(`${p.label} ${v}${p.unit ? ' ' + p.unit : ''} (${v < p.ok[0] ? 'bajo' : 'alto'}; ideal ${p.ok[0]}–${p.ok[1]})`);
    });
    if (o.readings && r) {
      const cols = [{ k: 'p', t: 'Parámetro', w: 0.3 }, { k: 'v', t: 'Lectura', w: 0.17, align: 'right' }];
      if (o.ideal) cols.push({ k: 'i', t: 'Rango ideal', w: 0.2, align: 'right' });
      if (o.previous) cols.push({ k: 'a', t: 'Visita anterior', w: 0.18, align: 'right' });
      cols.push({ k: 's', t: 'Estado', w: 0.17 });
      const sum = cols.reduce((s, c) => s + c.w, 0);
      cols.forEach((c) => { c.w /= sum; });
      L.push({ size: 9, pad: 4, bg: [0.94, 0.96, 0.98], b: true, c: GREY, row: cols.map((c) => ({ t: c.t, w: c.w, align: c.align })) });
      PARAMS.forEach((p) => {
        const v = r[p.key];
        if (v == null) return;
        const lvl = classify(p.key, v), pv = prev ? prev[p.key] : null;
        const cell = { p: p.label, v: `${v}${p.unit ? ' ' + p.unit : ''}`, i: `${p.ok[0]} – ${p.ok[1]}`, a: pv != null ? `${pv}` : '—', s: LV_TXT[lvl] };
        L.push({ size: 10, pad: 4, line: true, row: cols.map((c) => ({ t: cell[c.k], w: c.w, align: c.align, b: c.k === 'v' || c.k === 's', c: c.k === 'v' || c.k === 's' ? LC[lvl] : c.k === 'p' ? INK : GREY })) });
      });
      if (o.summary) L.push({ space: 4 }, att.length
        ? { t: 'Atención: ' + att.join('; ') + '.', size: 9.5, c: LC.warn, b: true }
        : { t: 'Todos los parámetros medidos están dentro del rango ideal.', size: 9.5, c: LC.ok, b: true });
    }
    if (doses.length) {
      text += `Productos aplicados: ${doses.map((d) => `${d.chemical_name} ${d.amount} ${d.unit}`).join(', ')}\n`;
      if (o.doses) {
        L.push({ space: 6 }, { size: 9, pad: 4, bg: [0.94, 0.96, 0.98], b: true, c: GREY, row: [{ t: 'Producto aplicado', w: 0.7 }, { t: 'Cantidad', w: 0.3, align: 'right' }] });
        doses.forEach((d) => L.push({ size: 10, pad: 4, line: true, row: [{ t: d.chemical_name, w: 0.7 }, { t: `${d.amount} ${d.unit}`, w: 0.3, align: 'right', b: true }] }));
      }
    }
    if (o.equipment) {
      const eq = db.equipment.filter((e) => e.water_body_id === wb.id);
      if (eq.length) {
        L.push({ space: 6 }, { size: 9, pad: 4, bg: [0.94, 0.96, 0.98], b: true, c: GREY, row: [{ t: 'Equipo', w: 0.3 }, { t: 'Marca / modelo', w: 0.45 }, { t: 'Estado', w: 0.25 }] });
        eq.forEach((e) => L.push({ size: 10, pad: 4, line: true, row: [{ t: e.category, w: 0.3 }, { t: `${e.brand} ${e.model}`.trim(), w: 0.45 }, { t: '• ' + e.status, w: 0.25, b: true, c: e.status === 'OK' ? LC.ok : e.status === 'Averiado' ? LC.bad : LC.warn }] }));
      }
    }
    L.push({ space: 8 });
  });
  if (done.length) {
    text += `\nTrabajo realizado:\n${done.map((c) => '✔ ' + c.label).join('\n')}\n`;
    if (o.checklist) L.push({ bar: 'Trabajo realizado' }, ...sideBySide(done.map((c) => c.label)), { space: 8 });
  }
  if (o.parts && parts.length) L.push({ bar: 'Piezas de esta visita' }, ...parts.map((p) => ({ size: 10, pad: 3, line: true, row: [{ t: p.item_name, w: 0.75 }, { t: PST[p.status], w: 0.25, align: 'right', b: true }] })), { space: 8 });
  if (stop.client_note && stop.client_note.trim()) {
    text += `\nObservaciones: ${stop.client_note.trim()}\n`;
    if (o.notes) L.push({ bar: 'Observaciones' }, { t: stop.client_note.trim(), size: 10 }, { space: 8 });
  }
  if (photos.length) {
    text += `\n📷 ${photos.length} foto(s) de evidencia.\n`;
    if (o.photos) {
      L.push({ bar: 'Evidencia fotográfica', keep: 190 });
      for (let i = 0; i < photos.length; i += 2) {
        L.push({ imgRow: photos.slice(i, i + 2).map((p) => ({ img: { data: p.uri, w: p.w, h: p.h }, cap: `${p.kind === 'BEFORE' ? 'ANTES' : 'DESPUÉS'} · ${fmtDateTime(p.taken_at)}${p.lat != null ? ` · ${(+p.lat).toFixed(4)}, ${(+p.lng).toFixed(4)}` : ''}` })) });
      }
    }
  }
  text += `\n${cfg.report.footerText || ''}`;
  const meta = [['Fecha', date]];
  return {
    title: `Informe de servicio — ${client.name} (${date})`, text, lines: L,
    fileName: `informe-${client.name.replace(/\W+/g, '-')}.pdf`,
    opts: { header: pdfHeader(cfg, 'report', 'INFORME DE SERVICIO', meta), footer: o.footer ? o.footerText : '' },
  };
}

const INV_LAYOUTS = [
  ['twocol', 'Dos columnas', 'Cliente y detalles lado a lado, totales a la derecha, pago y condiciones juntos.'],
  ['summary', 'Total arriba', 'Una barra con el total y la fecha de vencimiento justo debajo del encabezado.'],
  ['plain', 'Limpia', 'Sin cajas de color: líneas finas y totales sencillos. Ahorra tinta.'],
  ['side', 'Pago y totales', 'Datos de pago a la izquierda y totales a la derecha, al final.'],
];
function buildInvoiceDoc(client, inv, cfgIn, db) {
  const cfg = cfgIn || mergeSettings(null), o = cfg.invoice, th = docTheme(cfg);
  const today = todayISO(), st = effectiveStatus(inv, today), num = invNumber(inv, db);
  const prop = db ? db.properties.find((p) => p.client_id === client.id) : null;
  let text = `🧾 *${cfg.biz.name}* — Factura ${o.number ? 'N° ' + num : inv.period}\nCliente: ${client.name}\nVence: ${fmtDate(inv.due_date)}${termsLabel(inv.terms) ? ' (' + termsLabel(inv.terms) + ')' : ''}\n\n`;
  text += inv.lines.map((l) => `• ${l.description}: ${money(l.amount)}`).join('\n');
  text += `\n\n*Total: ${money(inv.total_amount)}*${db && invPaid(inv, db) > 0 && inv.status !== 'PAID' ? `\nAbonos: -${money(invPaid(inv, db))}\n*Balance pendiente: ${money(invBalance(inv, db))}*` : ''}\n${paymentInstructions(inv.payment_method, cfg)}\n\n${o.footerText || ''}`;

  const lay = INV_LAYOUTS.some((x) => x[0] === o.layout) ? o.layout : 'twocol', two = true, cmp = false, rec = false, side = lay === 'side', plain = lay === 'plain', sum = lay === 'summary', flat = plain;
  const L = [];
  const cinfo = [client.phone && `Tel. ${client.phone}`, client.email, prop && `${prop.address}, ${prop.municipality}`].filter(Boolean);
  const tl = termsLabel(inv.terms), issueTxt = fmtDate(inv.issue_date || inv.created_at);
  const detRows = [{ t: 'DETALLES DE LA FACTURA', size: 8.5, b: true, c: GREY }];
  if (o.number) detRows.push({ t: `N° ${num}`, size: 12, b: true });
  if (o.dates) detRows.push({ t: `Emisión: ${issueTxt}`, size: 9.5 }, { t: `Vence: ${fmtDate(inv.due_date)}`, size: 9.5, b: true });
  if (o.dates && tl) detRows.push({ t: `Condiciones: ${tl}`, size: 9.5 });
  detRows.push({ t: `Periodo: ${inv.period}`, size: 9.5, c: GREY }, { t: `Estado: ${STATUS_LABEL[st]}`, size: 9.5, c: GREY });
  const cliRows = [{ t: 'FACTURAR A', size: 8.5, b: true, c: GREY }, { t: client.name, size: 12, b: true }, ...cinfo.map((x) => ({ t: x, size: 9.5, c: GREY }))];
  if (sum) L.push({ size: 14, pad: 9, bg: th.acc, c: [1, 1, 1], b: true, row: [{ t: `${inv.status === 'PAID' ? 'TOTAL PAGADO' : 'TOTAL A PAGAR'}   ·   Vence ${fmtDate(inv.due_date)}`, w: 0.68 }, { t: money(inv.total_amount), w: 0.32, align: 'right' }] }, { space: 10 });
  if (two) L.push({ cols2: [o.clientInfo ? cliRows : [{ t: ' ', size: 9.5 }], detRows], bg: plain ? [1, 1, 1] : th.soft, border: th.edge });
  else if (rec) { /* «Facturar a» va en el encabezado */ }
  else if (o.clientInfo && cmp) L.push({ t: `Cliente: ${client.name}${cinfo.length ? '  ·  ' + cinfo.join('  ·  ') : ''}`, size: 9.5, b: false }, { space: 6 });
  else if (o.clientInfo) { cliRows.forEach((r) => L.push(r)); L.push({ space: 10 }); }
  const KIND = { FEE: 'Servicio mensual', VISIT: 'Servicio por visita', PART: 'Pieza', WORK_ORDER: 'Orden de trabajo', PREV: 'Saldo anterior', CREDIT: 'Crédito' };
  const cols = o.itemType ? [0.07, 0.5, 0.25, 0.18] : [0.07, 0.75, 0, 0.18];
  const head = [{ t: '#', w: cols[0] }, { t: 'Descripción', w: cols[1] }];
  if (o.itemType) head.push({ t: 'Tipo', w: cols[2] });
  head.push({ t: 'Monto', w: cols[3], align: 'right' });
  const fs = cmp ? 9 : 10, fp = cmp ? 3 : 6;
  L.push(flat ? { size: 9, pad: cmp ? 3 : 5, b: true, c: INK, line: true, row: head } : { size: 9, pad: cmp ? 3 : 5, bg: th.acc, b: true, c: [1, 1, 1], row: head });
  inv.lines.forEach((l, i) => {
    const r = [{ t: String(i + 1), w: cols[0], c: GREY }, { t: l.description, w: cols[1] }];
    if (o.itemType) r.push({ t: KIND[l.kind] || l.kind, w: cols[2], c: GREY });
    r.push({ t: money(l.amount), w: cols[3], align: 'right', b: true });
    L.push({ size: fs, pad: fp, line: true, bg: i % 2 && !cmp ? [0.975, 0.98, 0.99] : null, row: r });
  });
  L.push({ space: 8 });
  const kinds = [...new Set(inv.lines.map((l) => l.kind))];
  const KSUB = { FEE: 'Servicios', VISIT: 'Servicios', PART: 'Piezas', WORK_ORDER: 'Órdenes de trabajo', PREV: 'Saldo anterior', CREDIT: 'Crédito' };
  const paidSoFar = db ? invPaid(inv, db) : 0, balNow = db ? invBalance(inv, db) : inv.total_amount, showBal = paidSoFar > 0 && inv.status !== 'PAID';
  let recT = null;
  if (side) {
    recT = [];
    if (o.subtotals && kinds.length > 1) kinds.forEach((k) => recT.push({ l: KSUB[k], v: money(inv.lines.filter((x) => x.kind === k).reduce((s, x) => s + x.amount, 0)), size: 9.5, pad: 3 }));
    recT.push({ l: 'Total', v: money(inv.total_amount), size: 11, pad: 5, b: true, c: INK, line: true });
    const pd = inv.status === 'PAID' ? inv.total_amount : paidSoFar;
    if (pd > 0) recT.push({ l: inv.status === 'PAID' ? 'Pagada' : 'Abonado', v: '-' + money(pd), size: 10, pad: 4 });
    recT.push({ l: 'SALDO PENDIENTE', v: money(balNow), size: 12, pad: 7, b: true, ...(flat ? { c: INK, line: true } : { bg: th.acc }) });
  } else if (two || cmp) {
    const T = [];
    if (o.subtotals && kinds.length > 1) kinds.forEach((k) => T.push({ l: KSUB[k], v: money(inv.lines.filter((x) => x.kind === k).reduce((s, x) => s + x.amount, 0)), size: 9.5, pad: 2 }));
    T.push((flat || sum) ? { l: inv.status === 'PAID' ? 'TOTAL PAGADO' : 'TOTAL A PAGAR', v: money(inv.total_amount), size: 13, pad: 6, b: true, c: INK, line: true } : { l: inv.status === 'PAID' ? 'TOTAL PAGADO' : 'TOTAL A PAGAR', v: money(inv.total_amount), size: 13, pad: 6, b: true, bg: th.acc });
    if (showBal) T.push({ l: 'Abonos recibidos', v: '-' + money(paidSoFar), size: 10, pad: 3 }, { l: 'BALANCE PENDIENTE', v: money(balNow), size: 12, pad: 4, b: true, c: INK });
    L.push({ totals: T, w: 0.5 }, { space: 6 });
  } else {
    if (o.subtotals && kinds.length > 1) {
      kinds.forEach((k) => {
        const sub = inv.lines.filter((l) => l.kind === k).reduce((s, l) => s + l.amount, 0);
        L.push({ size: 10, pad: 2, row: [{ t: '', w: 0.55 }, { t: KSUB[k], w: 0.27, align: 'right', c: GREY }, { t: money(sub), w: 0.18, align: 'right', b: true }] });
      });
      L.push({ space: 4 });
    }
    L.push({ size: 13, pad: 7, ...((flat || sum) ? { c: INK, line: true } : { bg: th.acc, c: [1, 1, 1] }), b: true, row: [{ t: inv.status === 'PAID' ? 'TOTAL PAGADO' : 'TOTAL A PAGAR', w: 0.7 }, { t: money(inv.total_amount), w: 0.3, align: 'right' }] }, { space: 12 });
    if (showBal) L.push({ size: 10.5, pad: 3, row: [{ t: 'Abonos recibidos', w: 0.7, align: 'right', c: GREY }, { t: '-' + money(paidSoFar), w: 0.3, align: 'right' }] }, { size: 12, pad: 5, b: true, row: [{ t: 'BALANCE PENDIENTE', w: 0.7, align: 'right' }, { t: money(balNow), w: 0.3, align: 'right' }] }, { space: 8 });
  }
  if (side) {
    const rr = [];
    if (o.payBox) {
      rr.push({ t: PAYMENT_LABEL[inv.payment_method] || inv.payment_method, size: 11, b: true });
      if (inv.status === 'PAID') rr.push({ t: 'Pago recibido. ¡Gracias!', size: 10, c: LC.ok, b: true });
      else {
        if (inv.payment_method === 'ATH_MOVIL') {
          const link = athUrl(cfg), ph = (cfg.pay.athPhone || '').trim();
          if (link) rr.push({ t: 'Pagar con ATH Móvil Business:', size: 10, b: true }, { t: 'TOQUE AQUÍ PARA PAGAR AHORA', size: 11, b: true, c: th.acc, link });
          if (ph) rr.push({ t: `ATH Móvil Business: ${ph}`, size: link ? 10 : 12, b: true, c: link ? INK : th.acc });
        }
        if (inv.payment_method === 'ATH_PERSONAL' && (cfg.pay.athPersonalPhone || '').trim()) rr.push({ t: `ATH Móvil personal: ${cfg.pay.athPersonalPhone.trim()}`, size: 12, b: true, c: th.acc });
        if (o.instructions && inv.payment_method !== 'ATH_MOVIL') rr.push({ t: paymentInstructions(inv.payment_method, cfg), size: 9.5, c: GREY });
      }
    }
    if (tl) rr.push({ t: `Condiciones: ${tl}`, size: 9.5, c: GREY });
    if (o.terms && o.termsText && o.termsText.trim()) rr.push({ t: o.termsText.trim(), size: 9, c: GREY });
    L.push({ split: { left: { title: o.payBox ? 'INFORMACIÓN DE PAGO' : '', rows: rr }, right: recT } });
  } else {
  const termsBlock = o.terms && o.termsText && o.termsText.trim() ? o.termsText.trim() : '';
  if (o.payBox) {
    const rows = [{ t: 'MÉTODO DE PAGO', size: 8.5, b: true, c: GREY }, { t: PAYMENT_LABEL[inv.payment_method] || inv.payment_method, size: 11, b: true }];
    if (inv.status === 'PAID') rows.push({ t: 'Pago recibido. ¡Gracias!', size: 10, c: LC.ok, b: true });
    else {
      if (inv.payment_method === 'ATH_MOVIL') {
        const link = athUrl(cfg), ph = (cfg.pay.athPhone || '').trim();
        if (link) rows.push({ t: 'Pagar con ATH Móvil Business:', size: 10, b: true }, { t: 'TOQUE AQUÍ PARA PAGAR AHORA', size: 11, b: true, c: th.acc, link });
        if (ph) rows.push({ t: `ATH Móvil Business: ${ph}`, size: link ? 10 : 15, b: true, c: link ? INK : th.acc });
      }
      if (inv.payment_method === 'ATH_PERSONAL' && (cfg.pay.athPersonalPhone || '').trim()) rows.push({ t: `ATH Móvil personal: ${cfg.pay.athPersonalPhone.trim()}`, size: 15, b: true, c: th.acc });
      if (o.instructions && !(inv.payment_method === 'ATH_MOVIL')) rows.push({ t: paymentInstructions(inv.payment_method, cfg), size: 9.5, c: GREY });
    }
    const right = [{ t: 'CONDICIONES', size: 8.5, b: true, c: GREY }];
    if (tl) right.push({ t: tl, size: 11, b: true }, { t: `Vence: ${fmtDate(inv.due_date)}`, size: 9.5, c: GREY });
    if (termsBlock) right.push({ t: termsBlock, size: 9, c: GREY });
    if (two && right.length > 1) L.push({ cols2: [rows, right], bg: plain ? [1, 1, 1] : th.soft, border: th.edge });
    else {
      L.push({ panel: { rows, bg: plain ? [1, 1, 1] : th.soft, border: th.edge } });
      if (termsBlock) L.push({ space: 4 }, { t: 'TÉRMINOS', size: 8.5, b: true, c: GREY }, { t: termsBlock, size: 9, c: GREY });
    }
  } else {
    if (o.instructions && inv.status !== 'PAID') L.push({ t: paymentInstructions(inv.payment_method, cfg), size: 10 });
    if (termsBlock) L.push({ space: 4 }, { t: 'TÉRMINOS', size: 8.5, b: true, c: GREY }, { t: termsBlock, size: 9, c: GREY });
  }
  }
  if (o.payBox && inv.payment_method === 'ATH_MOVIL' && inv.status !== 'PAID' && athUrl(cfg)) L.push({ qr: { url: athUrl(cfg), bg: plain ? [1, 1, 1] : th.soft, border: th.edge } });

  const meta = [];
  if (rec) {
    if (o.number) meta.push(['Factura No.', num]);
    if (o.dates) { meta.push(['Fecha', issueTxt], ['Vence', fmtDate(inv.due_date)]); if (tl) meta.push(['Condiciones', tl]); }
    meta.push(['Estado', STATUS_LABEL[st]], ['Periodo', inv.period]);
  } else if (!two) {
    if (o.number) meta.push(['N°', num]);
    if (o.dates) { meta.push(['Emisión', issueTxt], ['Vence', fmtDate(inv.due_date)]); if (tl) meta.push(['Condiciones', tl]); }
    meta.push(['Estado', STATUS_LABEL[st]], ['Periodo', inv.period]);
  }
  const stamp = o.stamp && (st === 'PAID' ? { text: 'PAGADA', color: LC.ok } : st === 'OVERDUE' ? { text: 'VENCIDA', color: LC.bad } : null);
  return {
    title: `Factura ${inv.period} — ${cfg.biz.name}`, text, lines: L,
    fileName: `factura-${inv.period}-${client.name.replace(/\W+/g, '-')}.pdf`,
    opts: { header: (() => { const h = pdfHeader(cfg, 'invoice', 'FACTURA', meta); if (rec && o.clientInfo) h.billTo = [client.name, ...cinfo]; return h; })(), hdrStyle: rec ? 'split' : undefined, footer: o.footer ? o.footerText : '', stamp, theme: th },
  };
}



/* ---------- recibo de pago ---------- */
function receiptInfo(pay, db) {
  const inv = pay.invoice_id ? db.invoices.find((i) => i.id === pay.invoice_id) : null;
  if (!inv) return { inv: null, before: 0, after: 0, k: 1 };
  const sorted = db.payments.filter((p) => p.invoice_id === inv.id).sort((a, b) => (a.date + a.created_at).localeCompare(b.date + b.created_at));
  const idx = Math.max(0, sorted.findIndex((p) => p.id === pay.id));
  const before = r2(sorted.slice(0, idx).reduce((s, p) => s + p.amount, 0)), after = Math.max(0, r2(inv.total_amount - before - pay.amount));
  return { inv, before, after, k: idx + 1 };
}
function buildReceiptDoc(client, pay, cfgIn, db) {
  const cfg = cfgIn || mergeSettings(null), o = cfg.invoice, th = docTheme(cfg), R = receiptInfo(pay, db), inv = R.inv;
  const num = inv ? invNumber(inv, db) : '', recNo = inv ? `REC-${num.replace(/^EPS-/, '')}-${R.k}` : `REC-${pay.date.replace(/-/g, '')}-${pay.id.slice(-4).toUpperCase()}`;
  const method = PAY_METHODS[pay.method] || pay.method, full = inv && R.after <= 0.005, credit = clientCredit(db, client.id);
  const kind = !inv ? 'PAGO ADELANTADO RECIBIDO' : full ? 'PAGO RECIBIDO — FACTURA PAGADA' : 'ABONO RECIBIDO';
  const prop = db.properties.find((p) => p.client_id === client.id);
  const cinfo = [client.phone && `Tel. ${client.phone}`, client.email, prop && `${prop.address}, ${prop.municipality}`].filter(Boolean);
  const L = [];
  const det = [{ t: 'DETALLES DEL PAGO', size: 8.5, b: true, c: GREY }, { t: `Recibo N° ${recNo}`, size: 12, b: true }, { t: `Fecha: ${fmtDate(pay.date)}`, size: 9.5 }, { t: `Método: ${method}`, size: 9.5 }];
  if (inv) det.push({ t: `Factura: ${num} (${inv.period})`, size: 9.5 });
  if (pay.note) det.push({ t: `Nota: ${pay.note}`, size: 9, c: GREY });
  L.push({ cols2: [[{ t: 'RECIBIDO DE', size: 8.5, b: true, c: GREY }, { t: client.name, size: 12, b: true }, ...cinfo.map((x) => ({ t: x, size: 9.5, c: GREY }))], det], bg: th.soft, border: th.edge });
  L.push({ panel: { rows: [{ t: kind, size: 9, b: true, c: GREY }, { t: money(pay.amount), size: 26, b: true, c: th.acc }], bg: th.soft, border: th.edge } }, { space: 8 });
  if (inv) {
    L.push({ t: 'DETALLE DE LA FACTURA', size: 8.5, b: true, c: GREY }, { space: 2 });
    inv.lines.forEach((l, i) => L.push({ size: 9.5, pad: 3, line: true, row: [{ t: String(i + 1), w: 0.07, c: GREY }, { t: l.description, w: 0.75 }, { t: money(l.amount), w: 0.18, align: 'right', b: true }] }));
    L.push({ space: 6 });
    const T = [{ l: 'Total de la factura', v: money(inv.total_amount), size: 10, pad: 3 }];
    if (R.before > 0) T.push({ l: 'Pagos anteriores', v: '-' + money(R.before), size: 10, pad: 3 });
    T.push({ l: 'Este pago', v: '-' + money(pay.amount), size: 10, pad: 3, b: true, c: LC.ok });
    T.push(full ? { l: 'FACTURA PAGADA', v: money(0), size: 12, pad: 6, b: true, ...(th.flat ? { c: INK, line: true } : { bg: LC.ok }) } : { l: 'BALANCE PENDIENTE', v: money(R.after), size: 12, pad: 6, b: true, ...(th.flat ? { c: INK, line: true } : { bg: th.acc }) });
    L.push({ totals: T, w: 0.5 }, { space: 6 });
  }
  if (credit > 0.005) L.push({ t: `Saldo a favor disponible: ${money(credit)} (se descontará en su próxima factura).`, size: 10, b: true, c: th.acc }, { space: 4 });
  if (cfg.receipt && cfg.receipt.msg && cfg.receipt.msg.trim()) L.push({ space: 4 }, { t: cfg.receipt.msg.trim(), size: 10, c: GREY });
  const text = `✅ *${cfg.biz.name}* — Recibo de pago\nHola ${client.name}, recibimos su ${inv && !full ? 'abono' : 'pago'} de *${money(pay.amount)}* (${method}) el ${fmtDate(pay.date)}.\n` + (inv ? `Factura ${num}: ${full ? 'pagada en su totalidad ✔️' : 'balance pendiente ' + money(R.after)}.\n` : (credit > 0.005 ? `Saldo a favor: ${money(credit)}.\n` : '')) + `Recibo N° ${recNo}\n${(cfg.receipt && cfg.receipt.msg) || 'Gracias por su pago.'}`;
  const meta = [['Recibo N°', recNo], ['Fecha', fmtDate(pay.date)]];
  return {
    title: `Recibo ${recNo} — ${cfg.biz.name}`, text, lines: L,
    fileName: `recibo-${recNo}-${client.name.replace(/\W+/g, '-')}.pdf`,
    opts: { header: pdfHeader(cfg, 'invoice', 'RECIBO DE PAGO', meta), footer: o.footer ? o.footerText : '', stamp: full ? { text: 'PAGADA', color: LC.ok } : null, theme: th },
  };
}

/* ---------- cotizaciones ---------- */
const QUOTE_LABEL = { DRAFT: 'Borrador', SENT: 'Enviada', APPROVED: 'Aprobada', REJECTED: 'Rechazada', EXPIRED: 'Vencida' };
const r2 = (n) => Math.round((+n || 0) * 100) / 100;
function quoteTotals(q) {
  const sub = r2((q.lines || []).reduce((s, l) => s + (+l.qty || 0) * (+l.price || 0), 0)), disc = Math.min(r2(q.discount), sub);
  return { sub, disc, total: r2(sub - disc) };
}
const quoteStatus = (q, today = todayISO()) => ((q.status === 'DRAFT' || q.status === 'SENT') && q.valid_until && q.valid_until < today ? 'EXPIRED' : q.status);
function nextQuoteNumber(db) {
  const p = todayISO().slice(0, 7).replace('-', ''), n = db.quotes.filter((q) => (q.number || '').startsWith(`COT-${p}`)).length + 1;
  return `COT-${p}-${String(n).padStart(3, '0')}`;
}
function quoteWho(q, db) {
  const c = q.client_id && db.clients.find((x) => x.id === q.client_id);
  if (c) { const p = db.properties.find((x) => x.client_id === c.id); return { name: c.name, phone: c.phone, email: c.email, address: p ? `${p.address}${p.municipality ? ', ' + p.municipality : ''}` : '', client: c }; }
  const pr = q.prospect || {};
  return { name: pr.name || 'Cliente', phone: pr.phone || '', email: pr.email || '', address: pr.address || '', client: null };
}
function buildQuoteDoc(q, cfgIn, db) {
  const cfg = cfgIn || mergeSettings(null), th = docTheme(cfg), qs = cfg.quote, w = quoteWho(q, db), t = quoteTotals(q), st = quoteStatus(q);
  let text = `📝 *${cfg.biz.name}* — Cotización N° ${q.number}\nPara: ${w.name}\nFecha: ${fmtDate(q.created_at)}\nVálida hasta: ${fmtDate(q.valid_until)}\n\n`;
  text += q.lines.map((l) => `• ${l.description}${+l.qty !== 1 ? ` (${l.qty} × ${money(l.price)})` : ''}: ${money((+l.qty || 0) * (+l.price || 0))}`).join('\n');
  if (t.disc > 0) text += `\n\nSubtotal: ${money(t.sub)}\nDescuento: -${money(t.disc)}`;
  text += `\n\n*Total: ${money(t.total)}*`;
  if (q.notes && q.notes.trim()) text += `\n\n${q.notes.trim()}`;
  text += `\n\nPara aprobarla, responde a este mensaje.${qs.footerText ? '\n' + qs.footerText : ''}`;
  const L = [{ t: 'PREPARADA PARA', size: 8.5, b: true, c: GREY }, { t: w.name, size: 12, b: true }];
  [w.phone && `Tel. ${w.phone}`, w.email, w.address].filter(Boolean).forEach((x) => L.push({ t: x, size: 9.5, c: GREY }));
  L.push({ space: 10 });
  const cols = [0.06, 0.46, 0.1, 0.18, 0.2];
  L.push(th.flat ? { size: 9, pad: 5, b: true, c: INK, line: true, row: [{ t: '#', w: cols[0] }, { t: 'Descripción', w: cols[1] }, { t: 'Cant.', w: cols[2], align: 'right' }, { t: 'Precio', w: cols[3], align: 'right' }, { t: 'Importe', w: cols[4], align: 'right' }] }
    : { size: 9, pad: 5, bg: th.acc, b: true, c: [1, 1, 1], row: [{ t: '#', w: cols[0] }, { t: 'Descripción', w: cols[1] }, { t: 'Cant.', w: cols[2], align: 'right' }, { t: 'Precio', w: cols[3], align: 'right' }, { t: 'Importe', w: cols[4], align: 'right' }] });
  q.lines.forEach((l, i) => L.push({ size: 10, pad: 6, line: true, bg: i % 2 ? [0.975, 0.98, 0.99] : null, row: [{ t: String(i + 1), w: cols[0], c: GREY }, { t: l.description, w: cols[1] }, { t: String(+l.qty || 0), w: cols[2], align: 'right' }, { t: money(l.price), w: cols[3], align: 'right' }, { t: money((+l.qty || 0) * (+l.price || 0)), w: cols[4], align: 'right', b: true }] }));
  L.push({ space: 8 });
  if (t.disc > 0) L.push({ size: 10, pad: 2, row: [{ t: '', w: 0.6 }, { t: 'Subtotal', w: 0.2, align: 'right', c: GREY }, { t: money(t.sub), w: 0.2, align: 'right' }] }, { size: 10, pad: 2, row: [{ t: '', w: 0.6 }, { t: 'Descuento', w: 0.2, align: 'right', c: GREY }, { t: '-' + money(t.disc), w: 0.2, align: 'right' }] }, { space: 4 });
  L.push({ size: 13, pad: 7, ...(th.flat ? { c: INK, line: true } : { bg: th.acc, c: [1, 1, 1] }), b: true, row: [{ t: 'TOTAL', w: 0.7 }, { t: money(t.total), w: 0.3, align: 'right' }] }, { space: 12 });
  L.push({ panel: { rows: [{ t: 'VIGENCIA', size: 8.5, b: true, c: GREY }, { t: `Válida hasta el ${fmtDate(q.valid_until)}`, size: 12, b: true, c: th.acc }], bg: th.soft, border: th.edge } });
  if (q.notes && q.notes.trim()) L.push({ space: 4 }, { t: 'NOTAS', size: 8.5, b: true, c: GREY }, { t: q.notes.trim(), size: 10 });
  if (qs.terms && qs.terms.trim()) L.push({ space: 6 }, { t: 'CONDICIONES', size: 8.5, b: true, c: GREY }, { t: qs.terms.trim(), size: 9, c: GREY });
  if (qs.accept) L.push({ space: 26 }, { t: 'Aceptada por: ______________________________     Fecha: ________________', size: 10 });
  const meta = [['N°', q.number], ['Fecha', fmtDate(q.created_at)], ['Vigencia', fmtDate(q.valid_until)], ['Estado', QUOTE_LABEL[st]]];
  return {
    title: `Cotización ${q.number} — ${cfg.biz.name}`, text, lines: L,
    fileName: `cotizacion-${q.number}-${w.name.replace(/\W+/g, '-')}.pdf`,
    opts: { header: pdfHeader(cfg, 'invoice', 'COTIZACIÓN', meta), footer: qs.footerText || '', theme: th },
  };
}

function buildBroadcastDoc(client, body, subject, cfgIn) {
  const cfg = cfgIn || mergeSettings(null);
  const text = body.replace(/\{nombre\}/g, client.name.split(' ')[0]);
  return {
    title: subject, text, lines: text.split('\n').map((t) => ({ t })), fileName: 'aviso.pdf',
    opts: { header: { name: cfg.biz.name, lines: bizLines(cfg.biz), label: 'AVISO', meta: [['Fecha', fmtDate(todayISO())]] }, footer: cfg.invoice.footerText || '' },
  };
}

/* ---------- envío híbrido ---------- */
function planDispatch(channel, format) {
  const out = [];
  if (channel === 'WHATSAPP' || channel === 'BOTH') {
    if (format === 'TEXT' || format === 'BOTH') out.push({ id: 'wa-text', channel: 'WHATSAPP', format: 'TEXT', label: 'WhatsApp · Texto' });
    if (format === 'PDF' || format === 'BOTH') out.push({ id: 'wa-pdf', channel: 'WHATSAPP', format: 'PDF', label: 'WhatsApp · PDF' });
  }
  if (channel === 'EMAIL' || channel === 'BOTH') {
    const f = format === 'TEXT' ? 'Texto' : format === 'PDF' ? 'PDF adjunto' : 'Texto + PDF adjunto';
    out.push({ id: 'em', channel: 'EMAIL', format, label: `Email · ${f}` });
  }
  return out;
}
/** WhatsApp pide formato internacional: en Puerto Rico (787/939) se antepone el 1. */
const waNumber = (phone) => { const d = digits(phone); return d.length === 10 ? '1' + d : d; };
const waLink = (phone, text) => `https://wa.me/${waNumber(phone)}?text=${encodeURIComponent(text)}`;

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** Comparte el PDF con la hoja de compartir de Android (WhatsApp, Gmail…); si no existe, lo descarga. */
async function sharePdf(doc, shortText) {
  const file = new File([buildPdf(doc.title, doc.lines, doc.opts)], doc.fileName, { type: 'application/pdf' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: doc.title, text: shortText || '' });
      return 'shared';
    } catch (e) {
      if (e && e.name === 'AbortError') return 'cancelled';
    }
  }
  downloadBlob(file, doc.fileName);
  return 'downloaded';
}

/** Ejecuta UNA acción de envío. Debe llamarse dentro de un toque del usuario. */
async function runAction(a, client, doc) {
  if (a.channel === 'WHATSAPP') {
    if (!digits(client.phone)) throw new Error('El cliente no tiene teléfono guardado.');
    if (a.format === 'TEXT') { window.open(waLink(client.phone, doc.text), '_blank'); return 'opened'; }
    return sharePdf(doc, `Para ${client.name}`);
  }
  if (!client.email) throw new Error('El cliente no tiene email guardado.');
  const wantsPdf = a.format === 'PDF' || a.format === 'BOTH';
  const body = a.format === 'PDF' ? `Estimado/a ${client.name}: adjuntamos su documento de Elite Pool Service PR.` : doc.text.replace(/\*/g, '');
  if (wantsPdf) {
    const r = await sharePdf(doc, body); // elige Gmail u otra app de correo en la hoja de compartir
    if (r === 'downloaded') location.href = `mailto:${client.email}?subject=${encodeURIComponent(doc.title)}&body=${encodeURIComponent(body + '\n\n(Adjunta el PDF descargado)')}`;
    return r;
  }
  location.href = `mailto:${client.email}?subject=${encodeURIComponent(doc.title)}&body=${encodeURIComponent(body)}`;
  return 'opened';
}


/* ---------- exportar a Excel (.xlsx) sin librerías: ZIP sin compresión + XML ---------- */
const CRC_T = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (u) => { let c = 0xffffffff; for (let i = 0; i < u.length; i++) c = CRC_T[(c ^ u[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function zipStore(files) {
  const enc = new TextEncoder(), parts = [], central = []; let off = 0;
  const d = new Date(), dt = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(), tm = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  files.forEach(([name, text]) => {
    const nb = enc.encode(name), data = enc.encode(text), crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30)); [[0, 0x04034b50, 4], [4, 20, 2], [6, 0x0800, 2], [8, 0, 2], [10, tm, 2], [12, dt, 2], [14, crc, 4], [18, data.length, 4], [22, data.length, 4], [26, nb.length, 2], [28, 0, 2]].forEach(([o, v, n]) => (n === 4 ? lh.setUint32(o, v, true) : lh.setUint16(o, v, true)));
    parts.push(new Uint8Array(lh.buffer), nb, data);
    const ch = new DataView(new ArrayBuffer(46)); [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [8, 0x0800, 2], [10, 0, 2], [12, tm, 2], [14, dt, 2], [16, crc, 4], [20, data.length, 4], [24, data.length, 4], [28, nb.length, 2], [30, 0, 2], [32, 0, 2], [34, 0, 2], [36, 0, 2], [38, 0, 4], [42, off, 4]].forEach(([o, v, n]) => (n === 4 ? ch.setUint32(o, v, true) : ch.setUint16(o, v, true)));
    central.push(new Uint8Array(ch.buffer), nb);
    off += 30 + nb.length + data.length;
  });
  const csize = central.reduce((s, u) => s + u.length, 0), end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, csize, true); end.setUint32(16, off, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
const xmlEsc = (s) => String(s ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const colName = (i) => { let s = ''; for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };
/** sheets: [{ name, rows: [[encabezados], [fila], ...] }] → Blob .xlsx */
function buildXlsx(sheets) {
  const sheetXml = (rows) => {
    const widths = []; rows.forEach((r) => r.forEach((v, i) => { widths[i] = Math.min(60, Math.max(widths[i] || 8, String(v ?? '').length + 2)); }));
    const body = rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => {
      const ref = colName(ci) + (ri + 1), st = ri === 0 ? ' s="1"' : '';
      if (v === null || v === undefined || v === '') return '';
      return typeof v === 'number' && isFinite(v) ? `<c r="${ref}"${st}><v>${v}</v></c>` : `<c r="${ref}"${st} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
    }).join('')}</row>`).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols><sheetData>${body}</sheetData></worksheet>`;
  };
  const safe = (n, i) => xmlEsc(String(n).replace(/[\\/?*\[\]:]/g, ' ').slice(0, 31) || 'Hoja' + (i + 1));
  const files = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${safe(s.name, i)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF0284C7"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'],
    ...sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s.rows)]),
  ];
  return zipStore(files);
}
/** Hojas de Excel con los datos de negocio (clientes, facturas, lecturas). */
function backupSheets(db) {
  const DN = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
  const CH = { WHATSAPP: 'WhatsApp', EMAIL: 'Email', BOTH: 'Ambos' }, FM = { PDF: 'PDF', TEXT: 'Texto', BOTH: 'PDF + Texto' };
  const cname = (id) => (db.clients.find((c) => c.id === id) || {}).name || '';
  const clientes = [['Nombre', 'Estado', 'Teléfono', 'Email', 'Tipo de cobro', 'Monto ($)', 'Canal de envío', 'Formato de envío', 'Dirección', 'Municipio', 'Código de portón', 'Notas de acceso', 'Latitud', 'Longitud', 'Piscinas / cuerpos de agua', 'Etiquetas', 'Notas']];
  db.clients.forEach((c) => {
    const props = db.properties.filter((p) => p.client_id === c.id), p = props[0] || {};
    const wbs = db.waterBodies.filter((w) => props.some((x) => x.id === w.property_id)).map((w) => `${w.name} (${w.gallons} gal)`).join('; ');
    clientes.push([c.name, c.status === 'ACTIVE' ? 'Activo' : 'Archivado', c.phone, c.email, c.fee_type === 'PER_SERVICE' ? 'Por servicio' : 'Mensual', +c.monthly_fee || 0, CH[c.dispatch_channel_pref] || '', FM[c.dispatch_format_pref] || '', props.map((x) => x.address).join(' | '), p.municipality || '', p.gate_code || '', p.access_notes || '', p.lat ?? '', p.lng ?? '', wbs, (c.tags || []).join(', '), c.notes || '']);
  });
  const props = [['Cliente', 'Dirección', 'Municipio', 'Días de servicio', 'Fechas específicas (Airbnb)', 'Código de portón', 'Notas de acceso', 'Latitud', 'Longitud', 'Cuerpos de agua', 'Precio propio ($)']];
  db.properties.forEach((p) => props.push([cname(p.client_id), p.address, p.municipality, (p.service_days || []).map((d) => DN[d]).join(', '), (p.dates || []).map((x) => x.d + (x.t ? ' ' + x.t : '')).join('; '), p.gate_code || '', p.access_notes || '', p.lat ?? '', p.lng ?? '', db.waterBodies.filter((w) => w.property_id === p.id).map((w) => `${w.name} (${w.gallons} gal)`).join('; '), p.fee != null && p.fee !== '' ? +p.fee : '']));
  const facturas = [['Número', 'Cliente', 'Período', 'Vence', 'Total', 'Estado', 'Método de pago']];
  db.invoices.forEach((i) => facturas.push([invNumber(i, db), cname(i.client_id), i.period, i.due_date, +i.total_amount || 0, STATUS_LABEL[effectiveStatus(i, todayISO())] || i.status, PAYMENT_LABEL[i.payment_method] || i.payment_method]));
  const pagos = [['Fecha', 'Cliente', 'Monto', 'Método', 'Tipo', 'Factura', 'Nota']];
  (db.payments || []).forEach((p) => pagos.push([p.date, cname(p.client_id), +p.amount || 0, PAY_METHODS[p.method] || p.method, p.invoice_id ? 'Pago de factura' : 'Pago adelantado', (() => { const i = db.invoices.find((x) => x.id === p.invoice_id); return i ? invNumber(i, db) : ''; })(), p.note || '']));
  const lecturas = [['Fecha', 'Cliente', 'Cuerpo de agua', 'Cloro libre', 'pH', 'Alcalinidad', 'Ác. cianúrico', 'Sal', 'Dureza de calcio']];
  db.readings.forEach((r) => {
    const w = db.waterBodies.find((x) => x.id === r.water_body_id) || {}, p = db.properties.find((x) => x.id === w.property_id) || {};
    lecturas.push([(r.created_at || '').slice(0, 10), cname(p.client_id), w.name || '', r.free_chlorine ?? '', r.ph ?? '', r.alkalinity ?? '', r.cyanuric_acid ?? '', r.salt ?? '', r.calcium_hardness ?? '']);
  });
  const cot = [['Número', 'Cliente / prospecto', 'Teléfono', 'Fecha', 'Vigencia', 'Total', 'Estado']];
  db.quotes.forEach((q) => { const w = quoteWho(q, db); cot.push([q.number, w.name + (q.client_id ? '' : ' (prospecto)'), w.phone, (q.created_at || '').slice(0, 10), q.valid_until, quoteTotals(q).total, QUOTE_LABEL[quoteStatus(q)]]); });
  return [{ name: 'Clientes', rows: clientes }, { name: 'Propiedades', rows: props }, { name: 'Cotizaciones', rows: cot }, { name: 'Facturas', rows: facturas }, { name: 'Pagos', rows: pagos }, { name: 'Lecturas químicas', rows: lecturas }];
}

/* ---------- ubicación y fotos con sello ---------- */
function getCoords(timeout = 8000) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout, maximumAge: 15000 },
    );
  });
}

/** Ubicación precisa (GPS de alta precisión) con la exactitud en metros. */
function getFix(timeout = 20000, opts = {}) {
  // Escucha el GPS varios segundos y se queda con la lectura más precisa (la primera suele ser mala).
  const goal = opts.goal || 8, onProgress = opts.onProgress;
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve({ err: 'unsupported' });
    let best = null, done = false, id = null, timer = null, settle = null;
    const finish = (r) => { if (done) return; done = true; if (id != null) navigator.geolocation.clearWatch(id); clearTimeout(timer); clearTimeout(settle); resolve(r); };
    const ok = () => finish({ lat: best.lat, lng: best.lng, acc: best.acc });
    timer = setTimeout(() => (best ? ok() : finish({ err: 'unavailable' })), timeout);
    id = navigator.geolocation.watchPosition(
      (p) => {
        const c = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy };
        if (!best || c.acc < best.acc) best = c;
        if (onProgress) onProgress(best);
        if (best.acc <= goal) return ok();
        clearTimeout(settle); settle = setTimeout(() => { if (best && best.acc <= 25) ok(); }, 6000);
      },
      (e) => { if (e && e.code === 1) finish({ err: 'denied' }); else if (!best) { /* sigue intentando hasta el tiempo límite */ } },
      { enableHighAccuracy: true, timeout: timeout, maximumAge: 0 },
    );
  });
}
/** Dirección aproximada a partir de coordenadas (OpenStreetMap Nominatim; requiere internet). */
async function reverseGeocode(lat, lng) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&accept-language=es&lat=${lat}&lon=${lng}`);
    if (!r.ok) return null;
    const a = (await r.json()).address || {};
    const street = [a.house_number, a.road].filter(Boolean).join(' ') || a.neighbourhood || a.suburb || '';
    return { address: [street, a.neighbourhood && a.road ? a.neighbourhood : ''].filter(Boolean).join(', '), municipality: a.city || a.town || a.village || a.municipality || a.county || '' };
  } catch (e) { return null; }
}

/** Reduce la foto y QUEMA el sello (ANTES/DESPUÉS · fecha · hora · GPS) dentro de la imagen. */
async function processPhoto(file, kind, coords) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, 1000 / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.drawImage(bmp, 0, 0, w, h);
  const now = new Date();
  const line1 = kind === 'BEFORE' ? 'ANTES' : 'DESPUÉS';
  const line2 = `${now.toLocaleDateString('es-PR')} ${now.toLocaleTimeString('es-PR', { hour: '2-digit', minute: '2-digit' })}` + (coords ? ` · ${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}` : ' · GPS no disponible');
  const fs = Math.max(14, Math.round(w / 38));
  ctx.fillStyle = 'rgba(15,23,42,0.75)';
  ctx.fillRect(0, h - fs * 3.2, w, fs * 3.2);
  ctx.fillStyle = '#fff';
  ctx.font = `bold ${fs}px sans-serif`; ctx.fillText(line1, fs * 0.6, h - fs * 1.8);
  ctx.font = `${fs * 0.85}px sans-serif`; ctx.fillText(line2, fs * 0.6, h - fs * 0.55);
  return { uri: cv.toDataURL('image/jpeg', 0.72), w, h };
}

if (typeof module !== 'undefined') module.exports = { qrMatrix, buildReceiptDoc, TERMS, termsLabel, dueFor, PAY_METHODS, invPaid, invBalance, clientCredit, clientOwed, routeKm, SANITIZERS, PH_DOWN, CALCIUM_UP, CHEM_CATS, DEFAULT_CHEM, DEFAULT_TARGETS, chemPrefs, suggestDoses, propFee, propFeeLabel, buildQuoteDoc, quoteTotals, quoteStatus, nextQuoteNumber, feeLabel, athUrl, paymentInstructions, buildXlsx, backupSheets, buildPdf, suggestDoses, classify, buildInvoice, optimizeOrder, planDispatch, waLink, mergeSettings, buildStopDoc, buildInvoiceDoc, invNumber, tw, HW };
