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

/**
 * Dosis ESTIMADAS por cada 10,000 galones (guía de campo; verifica la etiqueta del producto,
 * aplica en dosis divididas si el ajuste es grande y vuelve a medir):
 *  ácido muriático 31.45%: ~6 fl oz baja el pH 0.1 (objetivo 7.4) · soda ash: ~3 oz sube el pH 0.1
 *  cloro líquido 12.5%: ~10.4 fl oz sube 1 ppm; tricloro 90%: ~1.5 oz por ppm (objetivo 3 ppm)
 *  bicarbonato: ~1.5 lb sube la alcalinidad 10 ppm (objetivo 90) · estabilizador: ~13 oz sube CYA 10 ppm (objetivo 40)
 */
function suggestDoses(v, gallons) {
  const f = gallons / 10000;
  const out = [];
  const push = (chemical_name, amount, unit, reason, alt = false) => {
    const n = normalizeDose(amount, unit);
    if (n.amount > 0) out.push({ chemical_name, amount: n.amount, unit: n.unit, reason, alt });
  };
  const num = (x) => (x === null || x === undefined || x === '' ? null : +x);
  const ph = num(v.ph), fc = num(v.free_chlorine), alk = num(v.alkalinity), cya = num(v.cyanuric_acid);
  if (ph !== null && ph > 7.6) { const d = ph - 7.4; push('Ácido muriático', (d / 0.1) * 6 * f, 'fl oz', `pH ${ph} alto${d > 0.4 ? ' · aplicar en 2 dosis' : ''}`); }
  if (ph !== null && ph < 7.2) { const d = 7.4 - ph; push('Carbonato de sodio (Soda Ash)', (d / 0.1) * 3 * f, 'oz', `pH ${ph} bajo${d > 0.4 ? ' · aplicar en 2 dosis' : ''}`); }
  if (fc !== null && fc < 2) {
    const need = 3 - fc;
    push('Cloro líquido 12.5%', need * 10.4 * f, 'fl oz', `Cloro ${fc} ppm bajo`);
    push('Tricloro shock (alternativa)', need * 1.5 * f, 'oz', 'Alternativa al cloro líquido', true);
  }
  if (alk !== null && alk < 80) push('Bicarbonato de sodio', ((90 - alk) / 10) * 1.5 * f * 16, 'oz', `Alcalinidad ${alk} ppm baja`);
  if (cya !== null && cya < 30) push('Estabilizador (ác. cianúrico)', ((40 - cya) / 10) * 13 * f, 'oz', `CYA ${cya} ppm bajo`);
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
  const pool = stops.map((s) => ({ s, p: props.find((p) => p.id === s.property_id) }));
  const order = [];
  let cur = start;
  while (pool.length) {
    let best = 0, bestD = Infinity;
    pool.forEach((x, i) => { const d = x.p ? haversineKm(cur, x.p) : Infinity; if (d < bestD) { bestD = d; best = i; } });
    const [picked] = pool.splice(best, 1);
    order.push(picked.s.id);
    if (picked.p) cur = picked.p;
  }
  return order;
}
const navUrl = (p) => `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}&travelmode=driving`;
function routeUrl(props) {
  if (!props.length) return null;
  const dest = props[props.length - 1];
  const via = props.slice(0, -1).slice(0, 9).map((p) => `${p.lat},${p.lng}`).join('|');
  return `https://www.google.com/maps/dir/?api=1&destination=${dest.lat},${dest.lng}&travelmode=driving${via ? '&waypoints=' + encodeURIComponent(via) : ''}`;
}

/* ---------- facturación ---------- */
const ATH_BUSINESS_PHONE = '939-405-7458';
const STATUS_LABEL = { PENDING: 'Pendiente', SENT: 'Enviada', PAID: 'Pagada', OVERDUE: 'Vencida' };
const PAYMENT_LABEL = { ATH_MOVIL: 'ATH Móvil Business', CARD: 'Tarjeta de crédito', STRIPE: 'Stripe (enlace de pago)', TRANSFER: 'Transferencia' };
function effectiveStatus(inv, today) {
  if (inv.status === 'PAID') return 'PAID';
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
  if (m === 'CARD' || m === 'STRIPE') return 'Le enviaremos un enlace seguro de pago con tarjeta.';
  return 'Coordine su transferencia con nosotros; le daremos los datos bancarios.';
}
/** Cuota mensual + piezas INSTALADAS + órdenes COMPLETADAS. */
/** Texto del cobro del cliente: «$125.00 / mes» o «$35.00 por servicio». */
const feeLabel = (c) => `${money(c.monthly_fee)} ${c.fee_type === 'PER_SERVICE' ? 'por servicio' : '/ mes'}`;
function buildInvoice(client, db, period, today) {
  const lines = []; let stopIds = [];
  if (client.fee_type === 'PER_SERVICE') {
    // cobro por visita: cuenta las paradas completadas que aún no se han facturado (hasta el fin del periodo)
    const dateOf = (s) => (db.routes.find((r) => r.id === s.route_id) || {}).date || '';
    const visits = db.stops.filter((s) => s.status === 'DONE' && !s.invoice_id && db.properties.some((p) => p.id === s.property_id && p.client_id === client.id) && dateOf(s) && dateOf(s) <= `${period}-31`).sort((a, b) => dateOf(a).localeCompare(dateOf(b)));
    if (visits.length && client.monthly_fee > 0) {
      stopIds = visits.map((s) => s.id);
      const days = visits.map((s) => fmtDate(dateOf(s)).replace(/ \d{4}$/, '')).join(', ');
      lines.push({ description: `Mantenimiento de piscina — ${visits.length} visita${visits.length > 1 ? 's' : ''} × ${money(client.monthly_fee)} (${days})`, amount: Math.round(visits.length * client.monthly_fee * 100) / 100, kind: 'VISIT' });
    }
  } else if (client.monthly_fee > 0) lines.push({ description: 'Cuota mensual de mantenimiento de piscina', amount: client.monthly_fee, kind: 'FEE' });
  const items = db.shoppingItems.filter((i) => i.client_id === client.id && i.status === 'INSTALLED');
  items.forEach((i) => lines.push({ description: i.item_name, amount: i.price, kind: 'PART', ref_id: i.id }));
  const orders = db.workOrders.filter((w) => w.client_id === client.id && w.status === 'DONE');
  orders.forEach((w) => lines.push({ description: `${w.type}${w.description ? ' — ' + w.description : ''}`, amount: w.price, kind: 'WORK_ORDER', ref_id: w.id }));
  const invoice = {
    id: uid('inv'), number: `EPS-${period.replace('-', '')}-${String(db.invoices.filter((i) => i.period === period).length + 1).padStart(3, '0')}`, client_id: client.id, period, lines,
    total_amount: Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100,
    payment_method: 'ATH_MOVIL', status: 'DRAFT', due_date: addDays(today, 15), created_at: new Date().toISOString(),
  };
  return { invoice, itemIds: items.map((i) => i.id), orderIds: orders.map((o) => o.id), stopIds };
}

/* ---------- ajustes: negocio, logo y opciones del PDF ---------- */
const DEFAULT_SETTINGS = {
  biz: { name: 'Elite Pool Service PR', tagline: '', address: '', phone: '', email: '', regId: '', tech: '', team: 'Técnico 1, Técnico 2' },
  logo: null,
  pay: { athLink: '', athPhone: ATH_BUSINESS_PHONE },
  invoice: {
    logo: true, bizInfo: true, number: true, dates: true, clientInfo: true, itemType: true, subtotals: true,
    payBox: true, instructions: true, terms: true, stamp: true, footer: true,
    termsText: 'Pago dentro de 15 días a partir de la fecha de emisión. Gracias por su preferencia.',
    footerText: 'Gracias por confiar en Elite Pool Service PR',
  },
  report: {
    logo: false, bizInfo: true, clientBlock: true, times: true, tech: true, readings: true, ideal: true, previous: true,
    summary: true, doses: true, equipment: false, checklist: true, notes: true, parts: true, photos: true, footer: true,
    footerText: 'Gracias por confiar en Elite Pool Service PR',
  },
};
function mergeSettings(saved) {
  const out = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  if (saved && typeof saved === 'object') {
    for (const k of ['biz', 'pay', 'invoice', 'report']) if (saved[k] && typeof saved[k] === 'object') Object.assign(out[k], saved[k]);
    if (saved.logo && saved.logo.data) out.logo = saved.logo;
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
  const newPage = () => { if (ops) pages.push({ ops, used, annots }); ops = []; used = new Set(); annots = []; y = H - M; };
  const need = (h) => { if (y - h < BOTTOM) newPage(); };

  newPage();
  // ----- encabezado (primera página) -----
  const hd = opts.header || { name: 'Elite Pool Service PR', lines: [], label: '', meta: [] };
  let leftBottom = y, x0 = M;
  if (hd.logo) {
    const sc = Math.min(150 / hd.logo.w, 62 / hd.logo.h), lw = hd.logo.w * sc, lh = hd.logo.h * sc;
    drawImg(hd.logo, M, y, lw, lh); x0 = M + lw + 12; leftBottom = y - lh;
  }
  let ly = y - 13;
  const labW = hd.label ? tw(hd.label, 20, true) + 18 : 0, leftMax = Math.max(120, CW - labW - (x0 - M));
  const nameLines = wrapLines(hd.name || '', 15, true, leftMax);
  nameLines.forEach((ln) => { text(ln, x0, ly, 15, true, INK); ly -= 17; });
  (hd.lines || []).forEach((l) => wrapLines(l, 8.5, false, leftMax).forEach((ln) => { text(ln, x0, ly, 8.5, false, GREY); ly -= 11; }));
  leftBottom = Math.min(leftBottom, ly + 6);
  let ry = y - 20;
  if (hd.label) { const lw = tw(hd.label, 20, true); text(hd.label, W - M - lw, ry, 20, true, ACC); ry -= 20; }
  (hd.meta || []).forEach(([k, v]) => { const s = `${k}  ${v}`; text(s, W - M - tw(s, 9, false), ry, 9, false, INK); ry -= 12; });
  y = Math.min(leftBottom, ry) - 8;
  rect(M, y, CW, 3, ACC); y -= 18;

  // ----- contenido -----
  for (const it of lines) {
    if (it.space) { y -= it.space; continue; }
    if (it.rule) { need(8); hline(y - 2); y -= 8; continue; }
    if (it.bar) { need(it.keep || 70); rect(M, y - 18, CW, 18, it.c || ACC); text(it.bar, M + 8, y - 13, 10.5, true, [1, 1, 1]); y -= 24; continue; }
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
function pdfHeader(cfg, key, label, meta) {
  const o = cfg[key];
  return { logo: o.logo && cfg.logo ? cfg.logo : null, name: cfg.biz.name || 'Elite Pool Service PR', lines: o.bizInfo ? bizLines(cfg.biz) : [], label, meta };
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

function buildInvoiceDoc(client, inv, cfgIn, db) {
  const cfg = cfgIn || mergeSettings(null), o = cfg.invoice;
  const today = todayISO(), st = effectiveStatus(inv, today), num = invNumber(inv, db);
  const prop = db ? db.properties.find((p) => p.client_id === client.id) : null;
  let text = `🧾 *${cfg.biz.name}* — Factura ${o.number ? 'N° ' + num : inv.period}\nCliente: ${client.name}\nVence: ${fmtDate(inv.due_date)}\n\n`;
  text += inv.lines.map((l) => `• ${l.description}: ${money(l.amount)}`).join('\n');
  text += `\n\n*Total: ${money(inv.total_amount)}*\n${paymentInstructions(inv.payment_method, cfg)}\n\n${o.footerText || ''}`;

  const L = [];
  if (o.clientInfo) {
    L.push({ t: 'FACTURAR A', size: 8.5, b: true, c: GREY }, { t: client.name, size: 12, b: true });
    [client.phone && `Tel. ${client.phone}`, client.email, prop && `${prop.address}, ${prop.municipality}`].filter(Boolean).forEach((x) => L.push({ t: x, size: 9.5, c: GREY }));
    L.push({ space: 10 });
  }
  const KIND = { FEE: 'Servicio mensual', VISIT: 'Servicio por visita', PART: 'Pieza', WORK_ORDER: 'Orden de trabajo' };
  const cols = o.itemType ? [0.07, 0.5, 0.25, 0.18] : [0.07, 0.75, 0, 0.18];
  const head = [{ t: '#', w: cols[0] }, { t: 'Descripción', w: cols[1] }];
  if (o.itemType) head.push({ t: 'Tipo', w: cols[2] });
  head.push({ t: 'Monto', w: cols[3], align: 'right' });
  L.push({ size: 9, pad: 5, bg: ACC, b: true, c: [1, 1, 1], row: head });
  inv.lines.forEach((l, i) => {
    const r = [{ t: String(i + 1), w: cols[0], c: GREY }, { t: l.description, w: cols[1] }];
    if (o.itemType) r.push({ t: KIND[l.kind] || l.kind, w: cols[2], c: GREY });
    r.push({ t: money(l.amount), w: cols[3], align: 'right', b: true });
    L.push({ size: 10, pad: 6, line: true, bg: i % 2 ? [0.975, 0.98, 0.99] : null, row: r });
  });
  L.push({ space: 8 });
  const kinds = [...new Set(inv.lines.map((l) => l.kind))];
  if (o.subtotals && kinds.length > 1) {
    kinds.forEach((k) => {
      const sub = inv.lines.filter((l) => l.kind === k).reduce((s, l) => s + l.amount, 0);
      L.push({ size: 10, pad: 2, row: [{ t: '', w: 0.55 }, { t: { FEE: 'Servicios', VISIT: 'Servicios', PART: 'Piezas', WORK_ORDER: 'Órdenes de trabajo' }[k], w: 0.27, align: 'right', c: GREY }, { t: money(sub), w: 0.18, align: 'right' }] });
    });
    L.push({ space: 4 });
  }
  L.push({ size: 13, pad: 7, bg: ACC, b: true, c: [1, 1, 1], row: [{ t: inv.status === 'PAID' ? 'TOTAL PAGADO' : 'TOTAL A PAGAR', w: 0.7 }, { t: money(inv.total_amount), w: 0.3, align: 'right' }] }, { space: 12 });
  if (o.payBox) {
    const rows = [{ t: 'MÉTODO DE PAGO', size: 8.5, b: true, c: GREY }, { t: PAYMENT_LABEL[inv.payment_method] || inv.payment_method, size: 11, b: true }];
    if (inv.status === 'PAID') rows.push({ t: 'Pago recibido. ¡Gracias!', size: 10, c: LC.ok, b: true });
    else {
      if (inv.payment_method === 'ATH_MOVIL') {
        const link = athUrl(cfg), ph = (cfg.pay.athPhone || '').trim();
        if (link) rows.push({ t: 'Pagar con ATH Móvil Business (toque el enlace):', size: 10, b: true }, { t: link, size: 10.5, b: true, c: ACC, link });
        if (ph) rows.push({ t: `ATH Móvil Business: ${ph}`, size: link ? 10 : 15, b: true, c: link ? INK : ACC });
      }
      if (o.instructions && !(inv.payment_method === 'ATH_MOVIL')) rows.push({ t: paymentInstructions(inv.payment_method, cfg), size: 9.5, c: GREY });
    }
    L.push({ panel: { rows } });
  } else if (o.instructions && inv.status !== 'PAID') L.push({ t: paymentInstructions(inv.payment_method, cfg), size: 10 });
  if (o.terms && o.termsText && o.termsText.trim()) L.push({ space: 4 }, { t: 'TÉRMINOS', size: 8.5, b: true, c: GREY }, { t: o.termsText.trim(), size: 9, c: GREY });

  const meta = [];
  if (o.number) meta.push(['N°', num]);
  if (o.dates) meta.push(['Emisión', fmtDate(inv.created_at)], ['Vence', fmtDate(inv.due_date)]);
  meta.push(['Estado', STATUS_LABEL[st]], ['Periodo', inv.period]);
  const stamp = o.stamp && (st === 'PAID' ? { text: 'PAGADA', color: LC.ok } : st === 'OVERDUE' ? { text: 'VENCIDA', color: LC.bad } : null);
  return {
    title: `Factura ${inv.period} — ${cfg.biz.name}`, text, lines: L,
    fileName: `factura-${inv.period}-${client.name.replace(/\W+/g, '-')}.pdf`,
    opts: { header: pdfHeader(cfg, 'invoice', 'FACTURA', meta), footer: o.footer ? o.footerText : '', stamp },
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
  const props = [['Cliente', 'Dirección', 'Municipio', 'Días de servicio', 'Fechas específicas (Airbnb)', 'Código de portón', 'Notas de acceso', 'Latitud', 'Longitud', 'Cuerpos de agua']];
  db.properties.forEach((p) => props.push([cname(p.client_id), p.address, p.municipality, (p.service_days || []).map((d) => DN[d]).join(', '), (p.dates || []).map((x) => x.d + (x.t ? ' ' + x.t : '')).join('; '), p.gate_code || '', p.access_notes || '', p.lat ?? '', p.lng ?? '', db.waterBodies.filter((w) => w.property_id === p.id).map((w) => `${w.name} (${w.gallons} gal)`).join('; ')]));
  const facturas = [['Número', 'Cliente', 'Período', 'Vence', 'Total', 'Estado', 'Método de pago']];
  db.invoices.forEach((i) => facturas.push([invNumber(i, db), cname(i.client_id), i.period, i.due_date, +i.total_amount || 0, STATUS_LABEL[effectiveStatus(i, todayISO())] || i.status, PAYMENT_LABEL[i.payment_method] || i.payment_method]));
  const lecturas = [['Fecha', 'Cliente', 'Cuerpo de agua', 'Cloro libre', 'pH', 'Alcalinidad', 'Ác. cianúrico', 'Sal', 'Dureza de calcio']];
  db.readings.forEach((r) => {
    const w = db.waterBodies.find((x) => x.id === r.water_body_id) || {}, p = db.properties.find((x) => x.id === w.property_id) || {};
    lecturas.push([(r.created_at || '').slice(0, 10), cname(p.client_id), w.name || '', r.free_chlorine ?? '', r.ph ?? '', r.alkalinity ?? '', r.cyanuric_acid ?? '', r.salt ?? '', r.calcium_hardness ?? '']);
  });
  return [{ name: 'Clientes', rows: clientes }, { name: 'Propiedades', rows: props }, { name: 'Facturas', rows: facturas }, { name: 'Lecturas químicas', rows: lecturas }];
}

/* ---------- ubicación y fotos con sello ---------- */
function getCoords(timeout = 8000) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: false, timeout, maximumAge: 60000 },
    );
  });
}

/** Ubicación precisa (GPS de alta precisión) con la exactitud en metros. */
function getFix(timeout = 20000) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve({ err: 'unsupported' });
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
      (e) => resolve({ err: e && e.code === 1 ? 'denied' : 'unavailable' }),
      { enableHighAccuracy: true, timeout, maximumAge: 0 },
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

if (typeof module !== 'undefined') module.exports = { feeLabel, athUrl, paymentInstructions, buildXlsx, backupSheets, buildPdf, suggestDoses, classify, buildInvoice, optimizeOrder, planDispatch, waLink, mergeSettings, buildStopDoc, buildInvoiceDoc, invNumber, tw, HW };
