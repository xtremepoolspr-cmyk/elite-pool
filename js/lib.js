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
function paymentInstructions(m) {
  if (m === 'ATH_MOVIL') return `Pague por ATH Móvil Business al ${ATH_BUSINESS_PHONE} (Elite Pool Service PR).`;
  if (m === 'CARD' || m === 'STRIPE') return 'Le enviaremos un enlace seguro de pago con tarjeta.';
  return 'Coordine su transferencia con nosotros; le daremos los datos bancarios.';
}
/** Cuota mensual + piezas INSTALADAS + órdenes COMPLETADAS. */
function buildInvoice(client, db, period, today) {
  const lines = [];
  if (client.monthly_fee > 0) lines.push({ description: 'Cuota mensual de mantenimiento de piscina', amount: client.monthly_fee, kind: 'FEE' });
  const items = db.shoppingItems.filter((i) => i.client_id === client.id && i.status === 'INSTALLED');
  items.forEach((i) => lines.push({ description: i.item_name, amount: i.price, kind: 'PART', ref_id: i.id }));
  const orders = db.workOrders.filter((w) => w.client_id === client.id && w.status === 'DONE');
  orders.forEach((w) => lines.push({ description: `${w.type}${w.description ? ' — ' + w.description : ''}`, amount: w.price, kind: 'WORK_ORDER', ref_id: w.id }));
  const invoice = {
    id: uid('inv'), client_id: client.id, period, lines,
    total_amount: Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100,
    payment_method: 'ATH_MOVIL', status: 'DRAFT', due_date: addDays(today, 15), created_at: new Date().toISOString(),
  };
  return { invoice, itemIds: items.map((i) => i.id), orderIds: orders.map((o) => o.id) };
}

/* ---------- PDF (generador mínimo, sin librerías) ---------- */
const WIN = { '–': 0x96, '—': 0x97, '•': 0x95, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '€': 0x80 };
function winAnsi(s) {
  s = String(s).replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}‍]/gu, '');
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

/**
 * lines: [{t, size?, b?, c?:[r,g,b], indent?}] | {space:n} | {img:{data(dataURL jpeg),w,h}, maxW?}
 * Devuelve Uint8Array con el PDF.
 */
function buildPdf(title, lines) {
  const W = 595, H = 842, M = 48;
  const pages = [];
  let ops = [], y = 0;
  const images = [];
  const pageImgs = [];
  let curImgs = new Set();
  const newPage = (first) => {
    if (ops.length || pages.length) { pages.push({ ops: ops.join('\n'), imgs: [...curImgs] }); }
    ops = []; curImgs = new Set(); y = H - M;
    if (first) {
      ops.push(`0.008 0.518 0.78 rg 0 ${H - 64} ${W} 64 re f`);
      ops.push(`BT /F2 20 Tf 1 1 1 rg 1 0 0 1 ${M} ${H - 40} Tm (${pdfEsc(winAnsi('Elite Pool Service PR'))}) Tj ET`);
      ops.push(`BT /F1 10 Tf 0.88 0.95 1 rg 1 0 0 1 ${M} ${H - 56} Tm (${pdfEsc(winAnsi(title))}) Tj ET`);
      y = H - 64 - 26;
    }
  };
  newPage(true);
  for (const ln of lines) {
    if (ln.space) { y -= ln.space; continue; }
    if (ln.img) {
      const maxW = ln.maxW || 260;
      const w = Math.min(maxW, ln.img.w), h = (ln.img.h / ln.img.w) * w;
      if (y - h < M) newPage(false);
      let idx = images.findIndex((i) => i.data === ln.img.data);
      if (idx < 0) { images.push(ln.img); idx = images.length - 1; }
      curImgs.add(idx);
      ops.push(`q ${w.toFixed(1)} 0 0 ${h.toFixed(1)} ${M} ${(y - h).toFixed(1)} cm /Im${idx + 1} Do Q`);
      y -= h + 6;
      continue;
    }
    const size = ln.size || 11, font = ln.b ? 'F2' : 'F1', c = ln.c || [0.06, 0.09, 0.16], indent = ln.indent || 0;
    const maxChars = Math.floor((W - 2 * M - indent) / (size * (ln.b ? 0.56 : 0.52)));
    const words = winAnsi(ln.t).split(' ');
    let cur = '';
    const flush = (txt) => {
      if (y - size < M) newPage(false);
      ops.push(`BT /${font} ${size} Tf ${c.join(' ')} rg 1 0 0 1 ${M + indent} ${y.toFixed(1)} Tm (${pdfEsc(txt)}) Tj ET`);
      y -= size * 1.4;
    };
    for (const w of words) {
      if ((cur + ' ' + w).trim().length > maxChars && cur) { flush(cur); cur = w; } else cur = (cur + ' ' + w).trim();
    }
    flush(cur);
  }
  pages.push({ ops: ops.join('\n'), imgs: [...curImgs] });

  // ids: 1 catálogo, 2 páginas, 3 F1, 4 F2, 5.. imágenes, luego (página, contenido) por página
  const imgBase = 5, pageBase = imgBase + images.length;
  const chunks = [], offsets = [];
  let len = 0;
  const add = (x) => { const u = typeof x === 'string' ? toBytes(x) : x; chunks.push(u); len += u.length; };
  const obj = (id, body) => { offsets[id] = len; add(`${id} 0 obj\n`); add(body); add('\nendobj\n'); };
  add('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  const kids = pages.map((_, i) => `${pageBase + i * 2} 0 R`).join(' ');
  obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
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
    const xo = p.imgs.length ? ` /XObject << ${p.imgs.map((k) => `/Im${k + 1} ${imgBase + k} 0 R`).join(' ')} >>` : '';
    obj(pid, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >>${xo} >> /Contents ${cid} 0 R >>`);
    const stream = toBytes(p.ops);
    offsets[cid] = len;
    add(`${cid} 0 obj\n<< /Length ${stream.length} >>\nstream\n`); add(stream); add('\nendstream\nendobj\n');
  });
  const total = pageBase + pages.length * 2;
  const xref = len;
  add(`xref\n0 ${total}\n0000000000 65535 f \n`);
  for (let id = 1; id < total; id++) add(String(offsets[id]).padStart(10, '0') + ' 00000 n \n');
  add(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
  const out = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/* ---------- documentos (texto + líneas de PDF) ---------- */
const FOOT = 'Gracias por confiar en Elite Pool Service PR 🏊';
const EMOJI = { ok: '✅', warn: '⚠️', bad: '🔴' };
const LC = { ok: [0.06, 0.72, 0.51], warn: [0.96, 0.62, 0.04], bad: [0.94, 0.27, 0.27] };
const GREY = [0.39, 0.45, 0.55];

function buildStopDoc(db, stopId) {
  const stop = db.stops.find((s) => s.id === stopId);
  if (!stop) return null;
  const prop = db.properties.find((p) => p.id === stop.property_id);
  const client = prop && db.clients.find((c) => c.id === prop.client_id);
  if (!prop || !client) return null;
  const route = db.routes.find((r) => r.id === stop.route_id);
  const date = fmtDate((route && route.date) || stop.check_in_time || new Date().toISOString());
  const wbs = db.waterBodies.filter((w) => stop.active_water_body_ids.includes(w.id));
  const done = stop.checklist.filter((c) => c.done);
  const photos = db.photos.filter((p) => p.owner_type === 'STOP' && p.owner_id === stop.id);
  let text = `🏊 *Elite Pool Service PR* — Informe de servicio\nCliente: ${client.name}\nDirección: ${prop.address}\nFecha: ${date}\nHorario: ${fmtTime(stop.check_in_time)} – ${fmtTime(stop.check_out_time)}\n`;
  const L = [{ t: client.name, b: true, size: 15 }, { t: `${prop.address}, ${prop.municipality}`, c: GREY, size: 10 }, { t: `${date} · ${fmtTime(stop.check_in_time)} – ${fmtTime(stop.check_out_time)}`, c: GREY, size: 10 }];
  wbs.forEach((wb) => {
    const r = db.readings.find((x) => x.stop_id === stop.id && x.water_body_id === wb.id);
    const doses = db.dosages.filter((d) => d.stop_id === stop.id && d.water_body_id === wb.id);
    text += `\n*${wb.name}* (${wb.gallons.toLocaleString('es-PR')} gal)\n`;
    L.push({ space: 8 }, { t: `${wb.name} (${wb.gallons.toLocaleString('es-PR')} gal)`, b: true, size: 13 });
    PARAMS.forEach((p) => {
      const v = r ? r[p.key] : null;
      if (v == null) return;
      const lvl = classify(p.key, v);
      text += `${EMOJI[lvl]} ${p.label}: ${v}${p.unit ? ' ' + p.unit : ''}\n`;
      L.push({ t: `${p.label}: ${v} ${p.unit}   (ideal ${p.ok[0]}–${p.ok[1]})`, c: LC[lvl], indent: 8 });
    });
    if (doses.length) {
      const d = doses.map((x) => `${x.chemical_name} ${x.amount} ${x.unit}`).join(', ');
      text += `Productos aplicados: ${d}\n`;
      L.push({ t: `Productos aplicados: ${d}`, indent: 8, size: 10 });
    }
  });
  if (done.length) {
    text += `\nTrabajo realizado:\n${done.map((c) => '✔ ' + c.label).join('\n')}\n`;
    L.push({ space: 8 }, { t: 'Trabajo realizado', b: true, size: 13 });
    done.forEach((c) => L.push({ t: '- ' + c.label, indent: 8 }));
  }
  if (photos.length) {
    text += `\n📷 ${photos.length} foto(s) de evidencia incluidas en el PDF.\n`;
    L.push({ space: 8 }, { t: 'Evidencia fotográfica', b: true, size: 13 });
    photos.forEach((p) => L.push({ img: { data: p.uri, w: p.w, h: p.h }, maxW: 250 }));
  }
  text += `\n${FOOT}`;
  L.push({ space: 10 }, { t: FOOT, c: GREY, size: 10 });
  return { title: `Informe de servicio — ${client.name} (${date})`, text, lines: L, fileName: `informe-${client.name.replace(/\W+/g, '-')}.pdf` };
}

function buildInvoiceDoc(client, inv) {
  let text = `🧾 *Elite Pool Service PR* — Factura ${inv.period}\nCliente: ${client.name}\nVence: ${fmtDate(inv.due_date)}\n\n`;
  text += inv.lines.map((l) => `• ${l.description}: ${money(l.amount)}`).join('\n');
  text += `\n\n*Total: ${money(inv.total_amount)}*\n${paymentInstructions(inv.payment_method)}\n\n${FOOT}`;
  const L = [
    { t: `Factura ${inv.period}`, b: true, size: 15 }, { t: client.name, size: 12 },
    { t: `Vence: ${fmtDate(inv.due_date)} · ${PAYMENT_LABEL[inv.payment_method]}`, c: GREY, size: 10 }, { space: 10 },
    ...inv.lines.map((l) => ({ t: `${l.description} ........ ${money(l.amount)}` })),
    { space: 8 }, { t: `TOTAL ${money(inv.total_amount)}`, b: true, size: 16, c: [0.008, 0.518, 0.78] },
    { space: 6 }, { t: paymentInstructions(inv.payment_method) }, { space: 10 }, { t: FOOT, c: GREY, size: 10 },
  ];
  return { title: `Factura ${inv.period} — Elite Pool Service PR`, text, lines: L, fileName: `factura-${inv.period}-${client.name.replace(/\W+/g, '-')}.pdf` };
}

function buildBroadcastDoc(client, body, subject) {
  const text = body.replace(/\{nombre\}/g, client.name.split(' ')[0]);
  return { title: subject, text, lines: text.split('\n').map((t) => ({ t })), fileName: 'aviso.pdf' };
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
  const file = new File([buildPdf(doc.title, doc.lines)], doc.fileName, { type: 'application/pdf' });
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

if (typeof module !== 'undefined') module.exports = { buildPdf, suggestDoses, classify, buildInvoice, optimizeOrder, planDispatch, waLink };
