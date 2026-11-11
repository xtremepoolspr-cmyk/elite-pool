/* Datos de ejemplo de Puerto Rico (ficticios: teléfonos 555, correos example.com). */
'use strict';

const ME = 'tech_1';
const TECHNICIANS = ['Técnico 1', 'Técnico 2'];
const DEFAULT_CHECKLIST = [
  'Cepillar paredes y escalones', 'Aspirar el fondo', 'Vaciar canastas de skimmer y bomba', 'Revisar presión del filtro',
  'Probar y balancear el agua', 'Verificar nivel de agua', 'Revisar equipos (bomba, clorador)',
];
const WORK_ORDER_TEMPLATES = {
  'Mantenimiento Recurrente': DEFAULT_CHECKLIST,
  'Reparación de Equipos': ['Diagnosticar falla', 'Cerrar válvulas / apagar breaker', 'Reemplazar pieza', 'Probar funcionamiento', 'Limpiar área de trabajo'],
  'Lavado con Ácido': ['Bajar nivel de agua', 'Apagar equipos y proteger drenajes', 'Aplicar ácido y cepillar', 'Enjuagar y neutralizar', 'Llenar y balancear el agua'],
  'Prueba de Presión / Fugas': ['Aislar líneas', 'Presurizar y monitorear', 'Localizar fuga', 'Documentar hallazgos', 'Presentar recomendación'],
  'Limpieza Profunda de Filtro': ['Apagar bomba y despresurizar', 'Desmontar filtro', 'Lavar cartuchos / arena / DE', 'Revisar empaques y o-rings', 'Armar y purgar aire'],
};
const mkChecklist = (prefix, labels = DEFAULT_CHECKLIST) => labels.map((label, i) => ({ id: `${prefix}_c${i}`, label, done: false }));

const SAMPLE_DAYS = { c1: [1, 4], c2: [2, 5], c3: [1, 3, 5], c4: [3], c5: [2, 4], c6: [] };
const TABLES = ['clients', 'properties', 'waterBodies', 'equipment', 'routes', 'stops', 'readings', 'dosages', 'workOrders', 'shoppingItems', 'invoices', 'payments', 'quotes', 'expenses', 'photos', 'dispatchLog'];

/** Base de datos vacía: la app arranca sin clientes de ejemplo. */
function emptyDb() { const db = {}; TABLES.forEach((t) => { db[t] = []; }); return db; }

function seedDb(today) {
  const clients = [
    { id: 'c1', service_days: [1, 4], name: 'Familia Rivera Colón', phone: '787-555-0101', email: 'rivera@example.com', dispatch_channel_pref: 'WHATSAPP', dispatch_format_pref: 'BOTH', status: 'ACTIVE', notes: 'Prefieren recibir informe después de cada visita.', monthly_fee: 125, tags: ['Caguas', 'Residencial'] },
    { id: 'c2', service_days: [2, 5], name: 'Dra. Marisol Vázquez', phone: '787-555-0102', email: 'mvazquez@example.com', dispatch_channel_pref: 'EMAIL', dispatch_format_pref: 'PDF', status: 'ACTIVE', notes: 'Pagos por ATH Móvil los primeros 5 días del mes.', monthly_fee: 150, tags: ['Guaynabo', 'Residencial'] },
    { id: 'c3', service_days: [1, 3, 5], name: 'Condominio Vista Dorada', phone: '787-555-0103', email: 'admin@vistadorada.example.com', dispatch_channel_pref: 'BOTH', dispatch_format_pref: 'BOTH', status: 'ACTIVE', notes: 'Coordinar con administración; registrar en bitácora.', monthly_fee: 480, tags: ['Dorado', 'Comercial'] },
    { id: 'c4', service_days: [3], name: 'Carlos Ortiz Pagán', phone: '787-555-0104', email: 'cortiz@example.com', dispatch_channel_pref: 'WHATSAPP', dispatch_format_pref: 'TEXT', status: 'ACTIVE', notes: '', monthly_fee: 110, tags: ['Montehiedra', 'Residencial'] },
    { id: 'c5', service_days: [2, 4], name: 'Residencia Santiago-Meléndez', phone: '939-555-0105', email: 'santiago.melendez@example.com', dispatch_channel_pref: 'BOTH', dispatch_format_pref: 'BOTH', status: 'ACTIVE', notes: 'Piscina, jacuzzi y espejo de agua.', monthly_fee: 175, tags: ['San Juan', 'Residencial'] },
    { id: 'c6', service_days: [], name: 'Ana Lugo Torres', phone: '787-555-0106', email: 'alugo@example.com', dispatch_channel_pref: 'EMAIL', dispatch_format_pref: 'TEXT', status: 'ARCHIVED', notes: 'Pausó el servicio (se mudó).', monthly_fee: 100, tags: ['Caguas'] },
  ];
  const properties = [
    { id: 'p1', client_id: 'c1', address: 'Urb. Villa Blanca, Calle Esmeralda 24', municipality: 'Caguas', gate_code: '#4821', access_notes: 'Perro pequeño en el patio. Cuarto de bombas junto a la marquesina.', lat: 18.2383, lng: -66.0352 },
    { id: 'p2', client_id: 'c2', address: 'Urb. Torrimar, Calle 8 #15', municipality: 'Guaynabo', gate_code: '', access_notes: 'Portón lateral sin llave. Bomba detrás del cobertizo.', lat: 18.3579, lng: -66.111 },
    { id: 'p3', client_id: 'c3', address: 'Dorado Reef, Carr. 693 Km 8.2', municipality: 'Dorado', gate_code: '1960', access_notes: 'Registrarse en la caseta. Cuarto de equipos en el sótano.', lat: 18.4588, lng: -66.2677 },
    { id: 'p4', client_id: 'c4', address: 'Montehiedra, Calle Almendro 112', municipality: 'Montehiedra', gate_code: '', access_notes: 'Tocar timbre. Sin mascotas.', lat: 18.3445, lng: -66.0696 },
    { id: 'p5', client_id: 'c5', address: 'Ocean Park, Calle Santa Ana 9', municipality: 'San Juan', gate_code: '3377', access_notes: 'Gato en el patio — cerrar portón. Cuarto de bombas en la terraza.', lat: 18.4552, lng: -66.064 },
    { id: 'p6', client_id: 'c6', address: 'Urb. Turabo Gardens, Calle 3 #5', municipality: 'Caguas', gate_code: '', access_notes: '', lat: 18.229, lng: -66.039 },
  ];
  const waterBodies = [
    { id: 'w1', property_id: 'p1', name: 'Piscina Principal', type: 'Pool', gallons: 18000 },
    { id: 'w2', property_id: 'p1', name: 'Jacuzzi / Spa', type: 'Jacuzzi', gallons: 800 },
    { id: 'w3', property_id: 'p2', name: 'Piscina Principal', type: 'Pool', gallons: 22000 },
    { id: 'w4', property_id: 'p3', name: 'Piscina Comercial', type: 'Commercial', gallons: 45000 },
    { id: 'w5', property_id: 'p3', name: 'Spa Comercial', type: 'Commercial', gallons: 1500 },
    { id: 'w6', property_id: 'p4', name: 'Piscina Principal', type: 'Pool', gallons: 14000 },
    { id: 'w7', property_id: 'p5', name: 'Piscina Principal', type: 'Pool', gallons: 16000 },
    { id: 'w8', property_id: 'p5', name: 'Jacuzzi / Spa', type: 'Jacuzzi', gallons: 700 },
    { id: 'w9', property_id: 'p5', name: 'Espejo de Agua', type: 'Pool', gallons: 1200 },
    { id: 'w10', property_id: 'p6', name: 'Piscina Principal', type: 'Pool', gallons: 12000 },
  ];
  const equipment = [
    { id: 'e1', water_body_id: 'w1', category: 'Bomba', brand: 'Pentair', model: 'IntelliFlo VSF', serial_number: 'PN-100234', status: 'OK' },
    { id: 'e2', water_body_id: 'w1', category: 'Filtro', brand: 'Pentair', model: 'Clean & Clear Plus 420', serial_number: 'PN-558120', status: 'OK' },
    { id: 'e3', water_body_id: 'w1', category: 'Clorador salino', brand: 'Hayward', model: 'AquaRite 940', serial_number: 'HW-77421', status: 'Atención' },
    { id: 'e4', water_body_id: 'w3', category: 'Bomba', brand: 'Hayward', model: 'MaxFlo VS', serial_number: 'HW-30112', status: 'OK' },
    { id: 'e5', water_body_id: 'w3', category: 'Calentador', brand: 'Raypak', model: 'Digital 336A', serial_number: 'RP-90021', status: 'Averiado' },
    { id: 'e6', water_body_id: 'w4', category: 'Automatización', brand: 'Jandy', model: 'iAquaLink', serial_number: 'JD-44120', status: 'OK' },
    { id: 'e7', water_body_id: 'w7', category: 'Bomba', brand: 'Pentair', model: 'SuperFlo VS', serial_number: 'PN-221907', status: 'OK' },
  ];

  const routes = [{ id: 'r_today', date: today, technician_id: ME, status: 'PLANNED' }];
  const stops = [], readings = [], dosages = [];
  ['p3', 'p1', 'p4', 'p2', 'p5'].forEach((pid, i) => {
    stops.push({
      id: `s_today_${pid}`, route_id: 'r_today', property_id: pid, order_index: i, check_in_time: null, check_out_time: null,
      check_in_lat: null, check_in_lng: null, status: 'PENDING', checklist: mkChecklist(`s_today_${pid}`),
      active_water_body_ids: waterBodies.filter((w) => w.property_id === pid).map((w) => w.id).slice(0, 1),
    });
  });

  // Historial de 3 semanas [pH, cloro, alcalinidad, CYA, sal]
  const hist = {
    w1: [[7.4, 3.0, 95, 45, 3100], [7.7, 1.5, 85, 44, 3050], [7.1, 2.4, 78, 42, 3000]],
    w3: [[7.5, 2.8, 100, 40, 3200], [7.3, 2.2, 92, 40, 3180], [7.8, 1.2, 88, 38, 3150]],
    w4: [[7.4, 3.5, 105, 50, 0], [7.5, 2.9, 100, 50, 0], [7.2, 3.2, 96, 49, 0]],
    w6: [[7.6, 2.5, 90, 35, 2900], [7.4, 2.1, 84, 34, 2880], [7.0, 1.8, 76, 33, 2850]],
    w7: [[7.4, 3.2, 98, 42, 3000], [7.5, 2.7, 94, 41, 3010], [7.3, 3.0, 90, 41, 2990]],
  };
  [7, 14, 21].forEach((daysAgo, wi) => {
    const date = addDays(today, -daysAgo), rid = `r_h${daysAgo}`;
    routes.push({ id: rid, date, technician_id: ME, status: 'DONE' });
    Object.entries(hist).forEach(([wid, rows]) => {
      const w = waterBodies.find((x) => x.id === wid);
      const sid = `s_${rid}_${w.property_id}`;
      if (!stops.find((s) => s.id === sid)) {
        stops.push({
          id: sid, route_id: rid, property_id: w.property_id, order_index: stops.length, check_in_time: `${date}T13:00:00.000Z`,
          check_out_time: `${date}T13:40:00.000Z`, check_in_lat: null, check_in_lng: null, status: 'DONE',
          checklist: DEFAULT_CHECKLIST.map((label, i) => ({ id: `${sid}_c${i}`, label, done: true })), active_water_body_ids: [wid],
        });
      }
      const [ph, fc, alk, cya, salt] = rows[wi];
      readings.push({ id: `rd_${sid}_${wid}`, stop_id: sid, water_body_id: wid, ph, free_chlorine: fc, alkalinity: alk, cyanuric_acid: cya, salt: salt || null, calcium_hardness: 280, created_at: `${date}T13:20:00.000Z` });
      if (ph > 7.6) dosages.push({ id: `ds_${sid}_${wid}`, stop_id: sid, water_body_id: wid, chemical_name: 'Ácido muriático', amount: 20, unit: 'fl oz' });
    });
  });

  const now = new Date().toISOString();
  const doneList = (id, t) => mkChecklist(id, WORK_ORDER_TEMPLATES[t]).map((c) => ({ ...c, done: true }));
  const workOrders = [
    { id: 'wo1', client_id: 'c3', property_id: 'p3', type: 'Limpieza Profunda de Filtro', status: 'DONE', description: 'Filtro de arena principal', price: 85, checklist: doneList('wo1', 'Limpieza Profunda de Filtro'), client_note: 'Se reemplazó o-ring de la tapa.', created_at: now },
    { id: 'wo2', client_id: 'c4', property_id: 'p4', type: 'Lavado con Ácido', status: 'OPEN', description: 'Superficie con manchas y sarro', price: 650, checklist: mkChecklist('wo2', WORK_ORDER_TEMPLATES['Lavado con Ácido']), client_note: '', created_at: now },
    { id: 'wo3', client_id: 'c2', property_id: 'p2', type: 'Reparación de Equipos', status: 'IN_PROGRESS', description: 'Calentador no enciende', price: 220, checklist: mkChecklist('wo3', WORK_ORDER_TEMPLATES['Reparación de Equipos']), client_note: '', created_at: now },
  ];
  const shoppingItems = [
    { id: 'sh1', stop_id: null, client_id: 'c1', item_name: 'O-ring tapa de bomba', cost: 6, price: 14, status: 'REQUIRED', assigned_to: 'Técnico 1', created_at: now },
    { id: 'sh2', stop_id: null, client_id: 'c2', item_name: 'Cartucho de filtro 150 sq ft', cost: 95, price: 160, status: 'PURCHASED', assigned_to: 'Técnico 1', created_at: now },
    { id: 'sh3', stop_id: null, client_id: 'c5', item_name: 'Motor de bomba 1.5 HP', cost: 310, price: 420, status: 'INSTALLED', assigned_to: 'Técnico 2', created_at: now },
    { id: 'sh4', stop_id: null, client_id: 'c3', item_name: 'Celda de clorador salino', cost: 520, price: 740, status: 'INVOICED', assigned_to: 'Técnico 2', created_at: now },
  ];
  const lastMonth = addDays(today, -30).slice(0, 7);
  const fee = (a) => [{ description: 'Cuota mensual de mantenimiento de piscina', amount: a, kind: 'FEE' }];
  const invoices = [
    { id: 'inv_s1', client_id: 'c1', period: lastMonth, lines: fee(125), total_amount: 125, payment_method: 'ATH_MOVIL', status: 'PAID', due_date: addDays(today, -15), created_at: now },
    { id: 'inv_s2', client_id: 'c2', period: lastMonth, lines: fee(150), total_amount: 150, payment_method: 'ATH_MOVIL', status: 'SENT', due_date: addDays(today, -3), created_at: now },
  ];
  return { clients, properties, waterBodies, equipment, routes, stops, readings, dosages, workOrders, shoppingItems, invoices, photos: [], dispatchLog: [] };
}
