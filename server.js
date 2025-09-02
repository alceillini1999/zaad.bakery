// server.js — Zaad Bakery (Pro, Render-ready)
// Features:
// - Sales/Expenses/Credit/Orders/Cash local-jsonl storage
// - Expenses: receipt image upload (public/uploads/receipts)
// - Credit payments & listing
// - Orders status + order payments (with Sales auto-entry "from order")
// - CSV export + Daily PDF report
// - Invoice PDF generation + WhatsApp link
// - Optional Basic Auth via PUBLIC_AUTH_USER/PUBLIC_AUTH_PASS
// - Realtime via Socket.IO
// - ✅ Google Sheets sync (Service Account) — per-type tabs with headers, auto-created
// - ✅ Two-way sync (Sheets <-> Local) + polling + endpoints
// - ✅ Local timezone dates + Arabic/locale number normalization

const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const cors = require('cors');
const multer = require('multer');
require('dotenv').config();

// ---- Optional require googleapis (won't crash if missing) ----
let google = null;
try { google = require('googleapis').google; }
catch (e) { console.warn('[Sheets] googleapis not installed — sync disabled'); }

const app = express();
const server = http.createServer(app);
const io = require('socket.io')(server, { cors: { origin: '*' } });
app.set('trust proxy', true); // لتحسين توليد الروابط خلف البروكسي/كلودفلير

// ---------- Config ----------
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

const DATA_DIR     = path.join(__dirname, 'data');
const UPLOAD_DIR   = path.join(__dirname, 'public', 'uploads', 'receipts');
const INVOICE_DIR  = path.join(__dirname, 'public', 'invoices');

const FILES = {
  sales:            path.join(DATA_DIR, 'sales.jsonl'),
  expenses:         path.join(DATA_DIR, 'expenses.jsonl'),
  credits:          path.join(DATA_DIR, 'credits.jsonl'),
  credit_payments:  path.join(DATA_DIR, 'credit_payments.jsonl'),
  orders:           path.join(DATA_DIR, 'orders.jsonl'),
  orders_status:    path.join(DATA_DIR, 'orders_status.jsonl'),
  orders_payments:  path.join(DATA_DIR, 'orders_payments.jsonl'),
  cash:             path.join(DATA_DIR, 'cash.jsonl'),
  employees:        path.join(DATA_DIR, 'employees.jsonl'),
  attendance:       path.join(DATA_DIR, 'attendance.jsonl'),
  emp_purchases:    path.join(DATA_DIR, 'emp_purchases.jsonl'),
  emp_advances:     path.join(DATA_DIR, 'emp_advances.jsonl'),
};

const ALL_TYPES = ['sales','expenses','credits','cash','orders','orders_status','orders_payments','credit_payments'];

// ---------- Helpers ----------
function ensureDirs() {
  fs.mkdirSync(DATA_DIR,    { recursive: true });
  fs.mkdirSync(UPLOAD_DIR,  { recursive: true });
  fs.mkdirSync(INVOICE_DIR, { recursive: true });
  for (const p of Object.values(FILES)) {
    if (!fs.existsSync(p)) fs.writeFileSync(p, '');
  }
}

// Local timezone (set LOCAL_TZ env e.g. Africa/Cairo, Asia/Riyadh)
const LOCAL_TZ = process.env.LOCAL_TZ || process.env.TZ || 'UTC';
function todayISO(d = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: LOCAL_TZ,
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(d); // YYYY-MM-DD
  } catch {
    const off = d.getTimezoneOffset();
    const local = new Date(d.getTime() - off*60000);
    return local.toISOString().slice(0,10);
  }
}

// دعم صيغ متعددة + أرقام جوجل/إكسل التسلسلية (مثل 45890)
function parseToISO(input) {
  if (input == null || input === '') return todayISO();
  // رقم تسلسلي (أيام منذ 1899-12-30)
  if (typeof input === 'number' || (/^\d+(\.\d+)?$/.test(String(input).trim()))) {
    const serial = typeof input === 'number' ? input : parseFloat(String(input));
    const base = Date.UTC(1899, 11, 30);
    const ms = Math.round(serial * 86400000);
    const d = new Date(base + ms);
    return isNaN(d) ? todayISO() : d.toISOString().slice(0,10);
  }
  if (typeof input === 'string') {
    const s = input.trim();
    if (s.includes('/')) {
      // نفترض dd/mm/yyyy (إعدادات UK)
      const [dd,mm,yyyy]=s.split('/');
      if (yyyy && mm && dd) return `${yyyy}-${mm.padStart(2,'0')}-${dd.padStart(2,'0')}`;
    }
    // ISO أو أي نص يحتوي التاريخ أول 10 أحرف
    return s.slice(0,10);
  }
  return todayISO(input);
}

function newId(){ return (Date.now().toString(36) + Math.random().toString(36).slice(2,6)).toUpperCase(); }

// Normalize numbers: Arabic digits, thousands separators, Arabic decimal point
function normNum(v){
  if (v == null) return 0;
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  let s = String(v).trim();
  const map = {'٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9'};
  s = s.replace(/[٠-٩]/g, d => map[d]); // Arabic -> Latin
  s = s.replace(/[٬,]/g, '');           // thousands
  s = s.replace(/[٫]/g, '.');           // decimal
  s = s.replace(/[^0-9.\-]/g, '');      // currency etc.
  const n = parseFloat(s);
  return isFinite(n) ? n : 0;
}

async function readAll(type) {
  const file = FILES[type]; if (!file) throw new Error('Unknown type');
  if (!fs.existsSync(file)) return [];
  const raw = await fsp.readFile(file, 'utf8'); if (!raw.trim()) return [];
  return raw.split('\n').filter(Boolean).map(l=>{try{return JSON.parse(l);}catch{return null;}}).filter(Boolean);
}
function filterByQuery(rows, q) {
  const from = q.from ? parseToISO(q.from) : null;
  const to   = q.to   ? parseToISO(q.to)   : null;
  const method   = q.method || q.payment || null;
  const customer = q.customer || q.name || null;
  const employee = q.employee || null;

  const session  = q.session || null;
  return rows.filter(r=>{
    const d = r.dateISO || r.date || todayISO();
    if (from && d < from) return false;
    if (to && d > to) return false;
    if (method && (r.method !== method && r.payment !== method)) return false;
    if (customer && (r.customer || r.client || '').toLowerCase() !== (customer||'').toLowerCase()) return false;
    if (employee && (String(r.employee||'').toLowerCase() !== String(employee).toLowerCase())) return false;
    if (session && r.session !== session) return false;
    return true;
  });
}
function toCSV(rows) {
  if (!rows.length) return 'empty\n';
  const headers = Array.from(rows.reduce((set,o)=>{Object.keys(o).forEach(k=>set.add(k));return set;}, new Set()));
  const esc = s => s==null? '' : /[",\n]/.test(String(s)) ? `"${String(s).replace(/"/g,'""')}"` : String(s);
  return [headers.join(','), ...rows.map(r=>headers.map(h=>esc(r[h])).join(','))].join('\n');
}
const sumBy=(arr,fn)=>arr.reduce((a,x)=>a+(+fn(x)||0),0);

// ---------- Google Sheets Sync ----------
// دعم متغيرات بديلة (GS_* كاختصار)
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || process.env.GS_SHEET_ID || '';
const SHEET_PREFIX   = process.env.SHEET_PREFIX || ''; // optional, e.g. 'Zaad_'
const GOOGLE_SA_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GS_CREDENTIALS_JSON || '';

const _sheetsState = {
  client: null,
  enabled: !!(google && SPREADSHEET_ID && GOOGLE_SA_JSON),
  knownTabs: new Set()
};

async function getSheetsClient() {
  if (!_sheetsState.enabled) return null;
  if (_sheetsState.client) return _sheetsState.client;
  const credentials = JSON.parse(GOOGLE_SA_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const authClient = await auth.getClient();
  _sheetsState.client = google.sheets({ version: 'v4', auth: authClient });
  // prime known tabs
  try {
    const meta = await _sheetsState.client.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    (meta.data.sheets || []).forEach(s => _sheetsState.knownTabs.add(s.properties.title));
  } catch (e) {
    console.warn('[Sheets] read meta failed:', e.message);
  }
  return _sheetsState.client;
}

function sheetSpec(type, r) {
  const tab = (name) => SHEET_PREFIX ? `${SHEET_PREFIX}${name}` : name;
  switch (type) {
    case 'sales': return {
      name: tab('Sales'),
      headers: ['ID','DateISO','CreatedAt','UpdatedAt','Product','Quantity','UnitPrice','Amount','Method','Note','Source'],
      row: [r.id, r.dateISO, r.createdAt, r.updatedAt || r.createdAt, r.product||'', normNum(r.quantity), normNum(r.unitPrice), normNum(r.amount), r.method||'', r.note||'', r.source||'']
    };
    case 'expenses': return {
      name: tab('Expenses'),
      headers: ['ID','DateISO','CreatedAt','UpdatedAt','Item','Amount','Method','Note','ReceiptPath'],
      row: [r.id, r.dateISO, r.createdAt, r.updatedAt || r.createdAt, r.item||'', normNum(r.amount), r.method||'', r.note||'', r.receiptPath||'']
    };
    case 'credits': return {
      name: tab('Credits'),
      headers: ['ID','DateISO','CreatedAt','UpdatedAt','Customer','Item','Amount','Paid','Remaining','Note','PaymentDateISO'],
      row: [r.id, r.dateISO, r.createdAt, r.updatedAt || r.createdAt, r.customer||'', r.item||'', normNum(r.amount), normNum(r.paid), normNum(r.remaining), r.note||'', r.paymentDateISO||'']
    };
    case 'credit_payments': return {
      name: tab('CreditPayments'),
      // Added Method column per user request
      headers: ['ID','DateISO','CreatedAt','UpdatedAt','Customer','Paid','Method','Note'],
      row: [r.id, r.dateISO, r.createdAt, r.updatedAt || r.createdAt, r.customer||'', normNum(r.paid), r.method||'', r.note||'']
    };
    case 'orders': return {
      name: tab('Orders'),
      headers: ['ID','DateISO','CreatedAt','UpdatedAt','Phone','Item','Amount','Paid','Remaining','Status','Note'],
      row: [r.id, r.dateISO, r.createdAt, r.updatedAt || r.createdAt, r.phone||'', r.item||'', normNum(r.amount), normNum(r.paid), normNum(r.remaining), r.status||'', r.note||'']
    };
    case 'orders_status': return {
      name: tab('OrdersStatus'),
      headers: ['OrderId','Status','DateISO','CreatedAt','UpdatedAt'],
      row: [r.id, r.status||'', r.dateISO, r.createdAt, r.updatedAt || r.createdAt]
    };
    case 'orders_payments': return {
      name: tab('OrdersPayments'),
      headers: ['ID','DateISO','CreatedAt','UpdatedAt','OrderId','Amount','Method'],
      row: [r.id, r.dateISO, r.createdAt, r.updatedAt || r.createdAt, r.orderId||'', normNum(r.amount), r.method||'']
    };
    case 'cash': return {
      name: tab('Cash'),
      headers: ['ID','DateISO','CreatedAt','UpdatedAt','Session','Total','Note','BreakdownJSON'],
      row: [r.id, r.dateISO, r.createdAt, r.updatedAt || r.createdAt, r.session||'', normNum(r.total), r.note||'', JSON.stringify(r.breakdown||{})]
    };

case 'employees': return {
  name: tab('Employees'),
  headers: ['ID','DateISO','CreatedAt','UpdatedAt','Name','Phone','Note'],
  row: [r.id, r.dateISO, r.createdAt, r.updatedAt || r.createdAt, r.name||'', r.phone||'', r.note||'']
};
case 'attendance': return {
  name: tab('Attendance'),
  headers: ['ID','DateISO','CreatedAt','UpdatedAt','Employee','Action','Time','Note'],
  row: [r.id, r.dateISO, r.createdAt, r.updatedAt || r.createdAt, r.employee||'', r.action||'', r.time||'', r.note||'']
};
case 'emp_purchases': return {
  name: tab('EmpPurchases'),
  headers: ['ID','DateISO','CreatedAt','UpdatedAt','Employee','Item','Amount','Paid','Note'],
  row: [r.id, r.dateISO, r.createdAt, r.updatedAt || r.createdAt, r.employee||'', r.item||'', normNum(r.amount), normNum(r.paid), r.note||'']
};
case 'emp_advances': return {
  name: tab('EmpAdvances'),
  headers: ['ID','DateISO','CreatedAt','UpdatedAt','Employee','Amount','Paid','Note'],
  row: [r.id, r.dateISO, r.createdAt, r.updatedAt || r.createdAt, r.employee||'', normNum(r.amount), normNum(r.paid), r.note||'']
};
default: return null;

  }
}

async function ensureTabAndHeader(sheets, sheetName, headers) {
  if (_sheetsState.knownTabs.has(sheetName)) return;
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const exists = (meta.data.sheets || []).some(s => s.properties.title === sheetName);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: sheetName } } }] }
    });
  }
  const hdr = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!1:1`
  });
  const hasHeader = hdr.data.values && hdr.data.values[0] && hdr.data.values[0].length >= headers.length;
  if (!hasHeader) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [headers] }
    });
  }
  _sheetsState.knownTabs.add(sheetName);
}

async function appendToGoogleSheet(type, record) {
  try {
    const sheets = await getSheetsClient();
    if (!sheets) return;
    const spec = sheetSpec(type, record);
    if (!spec) return;
    await ensureTabAndHeader(sheets, spec.name, spec.headers);
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${spec.name}!A:Z`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [spec.row] }
    });
  } catch (e) {
    console.warn(`[Sheets] append failed for type=${type}:`, e.message);
  }
}

// single place to write local + async sheets
async function appendRecord(type, obj) {
  const file = FILES[type]; if (!file) throw new Error('Unknown type');
  if (!obj.updatedAt) obj.updatedAt = obj.createdAt || new Date().toISOString();
  const line = JSON.stringify(obj) + '\n'; await fsp.appendFile(file, line, 'utf8');
  appendToGoogleSheet(type, obj).catch(()=>{});
}

/* ===== Two-way Sync (Google Sheet <-> Local JSONL) ===== */
const SHEETS_POLL_MS = Number(process.env.SHEETS_POLL_MS || 0); // مثال: 5000 = كل 5 ثواني
const SHEETS_ALLOW_DELETE = String(process.env.SHEETS_ALLOW_DELETE || 'false').toLowerCase() === 'true';
const SHEETS_POLL_DELETE = String(process.env.SHEETS_POLL_DELETE || 'false').toLowerCase() === 'true'; // ← جديد

// (B) قراءة تبويب الشيت كأوبچكتات مبنية على صف العناوين — بصيغة FORMATTED_VALUE لتفادي 45890
async function readSheetObjects(sheetName) {
  const sheets = await getSheetsClient();
  if (!sheets) throw new Error('Sheets disabled');
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A:Z`,
    valueRenderOption: 'FORMATTED_VALUE',   // ← نص منسّق (تواريخ كنص)
    dateTimeRenderOption: 'FORMATTED_STRING',
  });
  const values = resp.data.values || [];
  if (!values.length) return { headers: [], rows: [] };
  const headers = values[0];
  const rows = values.slice(1).map(r => {
    const o = {};
    headers.forEach((h,i) => o[h] = r[i] ?? '');
    return o;
  });
  return { headers, rows };
}

// (C) تحويل صف من الشيت إلى سجل داخلي — الآن يقبل بدون ID ويولّد واحدًا + يدعم OrderId
function sheetRowToRecord(type, o) {
  const idRaw0 = (o.ID ?? o.id ?? o.OrderId ?? '').toString().trim();
  const id = idRaw0 || newId();
  const get = (k, alt) => (o[k] ?? o[alt] ?? '');
  const num = v => normNum(v);
  const rec = {
    id,
    dateISO: parseToISO(get('DateISO','dateISO') || todayISO()),
    createdAt: get('CreatedAt','createdAt') || new Date().toISOString(),
    updatedAt: get('UpdatedAt','updatedAt') || get('CreatedAt','createdAt') || new Date().toISOString(),
  };
  switch (type) {
    case 'sales':    return Object.assign(rec, { product:get('Product','product'), quantity:num(get('Quantity','quantity')), unitPrice:num(get('UnitPrice','unitPrice')), amount:num(get('Amount','amount')), method:get('Method','method')||'Cash', note:get('Note','note'), source:get('Source','source') });
    case 'expenses': return Object.assign(rec, { item:get('Item','item'), amount:num(get('Amount','amount')), method:get('Method','method')||'Cash', note:get('Note','note'), receiptPath:get('ReceiptPath','receiptPath') });
    case 'credits':  return Object.assign(rec, { customer:get('Customer','customer'), item:get('Item','item'), amount:num(get('Amount','amount')), paid:num(get('Paid','paid')), remaining:num(get('Remaining','remaining')), note:get('Note','note'), paymentDateISO:get('PaymentDateISO','paymentDateISO') });
    case 'orders':   return Object.assign(rec, { phone:get('Phone','phone'), item:get('Item','item'), amount:num(get('Amount','amount')), paid:num(get('Paid','paid')), remaining:num(get('Remaining','remaining')), status:get('Status','status')||'Pending', note:get('Note','note') });
    case 'orders_status': return Object.assign(rec, { status:get('Status','status')||'Pending' });
    case 'orders_payments': return Object.assign(rec, { orderId:get('OrderId','orderId'), amount:num(get('Amount','amount')), method:get('Method','method')||'Cash' });
    case 'cash':     return Object.assign(rec, { session:get('Session','session')||'morning', total:num(get('Total','total')), note:get('Note','note'), breakdown:(()=>{try{return JSON.parse(get('BreakdownJSON','breakdown')||'{}')}catch{return {}}})() });
    default:         return rec;
  }
}

// (D) إعادة بناء ملف JSONL بالكامل
async function rewriteLocalFile(type, records) {
  const file = FILES[type]; if (!file) throw new Error('Unknown type');
  const lines = records.map(r => JSON.stringify(r)).join('\n') + (records.length? '\n' : '');
  await fsp.writeFile(file, lines, 'utf8');
}

// (E) مزامنة نوع واحد: mode = 'both' | 'pull' | 'push'
async function syncType(type, mode='both', { allowDelete=false } = {}) {
  const emptySpec = sheetSpec(type, {}); if (!emptySpec) return { type, skipped:true };

  const sheetsApi = await getSheetsClient(); if (!sheetsApi) throw new Error('Sheets disabled');
  await ensureTabAndHeader(sheetsApi, emptySpec.name, emptySpec.headers);

  // اقرأ من الشيت، وحوّل لسجلات (الآن نقبل بدون ID)
  const { rows: sheetRows } = await readSheetObjects(emptySpec.name);
  const sheetRecs = sheetRows.map(r => sheetRowToRecord(type, r)).filter(Boolean);
  const sheetMap = new Map(sheetRecs.map(r => [r.id, r]));

  // محلي
  const localArr = await readAll(type);
  const localMap = new Map(localArr.map(r => [r.id, r]));

  const ids = new Set([...sheetMap.keys(), ...localMap.keys()].filter(Boolean));

  const finalLocal = [];
  const changes = { type, pushed:0, pulled:0, updatedSheet:0, updatedLocal:0, deletedLocal:0, deletedSheet:0 };

  for (const id of ids) {
    const sRec = sheetMap.get(id);
    const lRec = localMap.get(id);

    if (sRec && lRec) {
      const su = new Date(sRec.updatedAt || sRec.createdAt || 0).getTime();
      const lu = new Date(lRec.updatedAt || lRec.createdAt || 0).getTime();
      if (su > lu && mode !== 'push') {
        finalLocal.push(sRec);
        changes.updatedLocal++;
      } else {
        finalLocal.push(lRec);
        if (lu > su && mode !== 'pull') changes.updatedSheet++;
      }
    } else if (sRec && !lRec) {
      if (mode !== 'push') { finalLocal.push(sRec); changes.pulled++; }
      else if (allowDelete) { changes.deletedSheet++; }
    } else if (!sRec && lRec) {
      // CHANGED: honor allowDelete also in pull mode
      if (allowDelete && mode !== 'push') {
        // sheet حذفته → نحذفه محليًا (لا نضيفه لـ finalLocal)
        changes.deletedLocal++;
      } else if (mode === 'pull') {
        // سلوك قديم لـ pull-only (بدون allowDelete): احتفظ بالمحلي
        finalLocal.push(lRec);
      } else {
        // سلوك both/push عندما لا نسمح بالحذف: ندفشه للشيت
        finalLocal.push(lRec);
        if (mode !== 'pull') changes.pushed++;
      }
    }
  }

  // اكتب محلي (إلا في push-only)
  if (mode !== 'push') await rewriteLocalFile(type, finalLocal);

  // اكتب الشيت (إلا في pull-only) — إعادة كتابة كاملة للهيدر + الصفوف
  if (mode !== 'pull') {
    const sHeaders = sheetSpec(type, {}).headers;
    const rows = finalLocal.map(rec => sheetSpec(type, rec).row);
    await sheetsApi.spreadsheets.values.clear({
      spreadsheetId: SPREADSHEET_ID, range: `${emptySpec.name}!A:Z`
    });
    await sheetsApi.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${emptySpec.name}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [sHeaders, ...rows] }
    });
  }

  return changes;
}

async function syncMany(types, mode='both', opts={}) {
  const out = [];
  for (const t of types) {
    try { out.push(await syncType(t, mode, opts)); }
    catch (e) { out.push({ type:t, error:e.message }); }
  }
  return out;
}

// (F) Endpoints للمزامنة اليدوية — افتراضيًا كل الأنواع
app.post('/api/sheets/sync', async (req,res)=>{
  try{
    const { types=ALL_TYPES, mode='both', allowDelete=SHEETS_ALLOW_DELETE } = req.body||{};
    const result = await syncMany(types, mode, { allowDelete });
    res.json({ ok:true, mode, result });
  }catch(err){ console.error(err); res.status(500).json({ ok:false, error: err.message }); }
});

app.post('/api/sheets/pull', async (req,res)=>{
  try{
    const { types=ALL_TYPES, allowDelete=SHEETS_ALLOW_DELETE } = req.body||{};
    const result = await syncMany(types, 'pull', { allowDelete });
    res.json({ ok:true, result });
  }catch(err){ console.error(err); res.status(500).json({ ok:false, error: err.message }); }
});

app.post('/api/sheets/push', async (req,res)=>{
  try{
    const { types=ALL_TYPES, allowDelete=SHEETS_ALLOW_DELETE } = req.body||{};
    const result = await syncMany(types, 'push', { allowDelete });
    res.json({ ok:true, result });
  }catch(err){ console.error(err); res.status(500).json({ ok:false, error: err.message }); }
});

// (G) Polling اختياري حسب SHEETS_POLL_MS — يستخدم متغير SHEETS_POLL_DELETE للحذف التلقائي
if (SHEETS_POLL_MS > 0) {
  setInterval(() => {
    syncMany(ALL_TYPES, 'pull', { allowDelete: SHEETS_POLL_DELETE })
      .catch(e => console.warn('[Sheets] polling sync error:', e.message));
  }, SHEETS_POLL_MS);
}

// ---------- Middleware ----------
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Basic Auth (optional via env)
function basicAuth(req,res,next){
  const u=process.env.PUBLIC_AUTH_USER, p=process.env.PUBLIC_AUTH_PASS;
  if(!u||!p) return next();
  const hdr=req.headers.authorization||''; const [type,val]=hdr.split(' ');
  if(type==='Basic'&&val){ const [user,pass]=Buffer.from(val,'base64').toString().split(':'); if(user===u&&pass===p) return next(); }
  res.set('WWW-Authenticate','Basic realm="Zaad Bakery"'); return res.status(401).send('Authentication required');
}
app.use(basicAuth);

// Keep-alive ping
app.get('/api/ping', (req,res)=>{
  res.json({ ok:true, ts:new Date().toISOString(), uptime: process.uptime() });
});

// Static (no-cache index for fresh UI)
app.use(express.static(path.join(__dirname, 'public'),{
  etag:false,lastModified:false,setHeaders:(res,fp)=>{ if (fp.endsWith('index.html')) res.setHeader('Cache-Control','no-store'); }
}));

// ---------- Socket.IO ----------
io.on('connection',()=>console.log('Realtime client connected'));

// ---------- Generic add handler ----------
const handleAdd = (type, mapper) => async (req,res)=>{
  try{
    const b=req.body||{}; const now=new Date();
    const record = Object.assign({
      id: b.id || newId(),
      dateISO: parseToISO(b.date),
      createdAt: now.toISOString(),
    }, mapper(b));
    if (!record.updatedAt) record.updatedAt = record.createdAt;
    await appendRecord(type, record);
    io.emit('new-record', { type, record });
    res.json({ ok:true, type, record });
  }catch(err){ console.error(err); res.status(500).json({ ok:false, error:err.message }); }
};

// ===== Sales =====
const addSale = handleAdd('sales', b=>({
  product: b.product||'',
  quantity: normNum(b.quantity||0),
  unitPrice: normNum(b.unitPrice||0),
  amount: normNum(b.amount || b.total || 0),
  method: b.method || b.payment || 'Cash',
  note: b.note || '',
  source: b.source || '', // e.g., "from order XYZ"
}));
app.post('/api/sales/add', addSale);
app.post('/save-sale', addSale); // توافق قديم

// ===== Expenses (with receipt upload) =====
const storage = multer.diskStorage({
  destination: (_, __, cb)=> cb(null, UPLOAD_DIR),
  filename:    (_, file, cb)=> {
    const ext = path.extname(file.originalname||'').toLowerCase() || '.jpg';
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2,8)}${ext}`);
  }
});
const upload = multer({ storage });

app.post('/api/expenses/add', upload.single('receipt'), async (req,res)=>{
  try{
    const b = req.body || {};
    const now = new Date();
    const rec = {
      id: newId(),
      dateISO: parseToISO(b.date),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      item: b.item||b.name||'',
      amount: normNum(b.amount||0),
      method: b.method||b.payment||'Cash',
      note: b.note||'',
      receiptPath: req.file ? `/uploads/receipts/${req.file.filename}` : ''
    };
    await appendRecord('expenses', rec);
    io.emit('new-record', { type:'expenses', record: rec });
    res.json({ ok:true, type:'expenses', record: rec });
  }catch(err){ console.error(err); res.status(500).json({ ok:false, error: err.message }); }
});

// ===== Credits & Payments =====
// ===== Employees (directory) — NEW =====
app.post('/api/employees/add', handleAdd('employees', b=>({
  name: b.name||'',
  phone: b.phone||'',
  note: b.note||'',
})));

// ===== Attendance — NEW =====
app.post('/api/attendance/add', handleAdd('attendance', b=>{
  const a = (b.action||'').toString().toLowerCase().replace('-', '_');
  const action = (a.includes('out') ? 'check_out' : 'check_in');
  return { employee:b.employee||'', action, time:b.time||'', note:b.note||'' };
}));

// ===== Employee Purchases — NEW =====
app.post('/api/emp_purchases/add', handleAdd('emp_purchases', b=>({
  employee:b.employee||'',
  item:b.item||'',
  amount:normNum(b.amount||0),
  paid:normNum(b.paid||0),
  note:b.note||'',
})));

// ===== Employee Advances — NEW =====
app.post('/api/emp_advances/add', handleAdd('emp_advances', b=>({
  employee:b.employee||'',
  amount:normNum(b.amount||0),
  paid:normNum(b.paid||0),
  note:b.note||'',
})));

const addCredit = handleAdd('credits', b=>{
  const paid=normNum(b.paid||0), amount=normNum(b.amount||0);
  return { customer:b.customer||b.name||'', item:b.item||'', amount, paid, remaining:Math.max(0, amount-paid), note:b.note||'', paymentDateISO: b.paymentDate?parseToISO(b.paymentDate):'' };
});
app.post('/api/credits/add', addCredit);
app.post('/save-credit', addCredit);

const addCreditPayment = handleAdd('credit_payments', b=>({
  customer: b.customer||'',
  paid: normNum(b.paid||b.amount||0),
  note: b.note||'',
}));
app.post('/api/credits/pay', async (req,res)=>{
  try{
    const b = req.body || {};
    const customer = b.customer || '';
    const amt = normNum(b.paid || b.amount || 0);
    if(!customer || !(amt>0)) return res.status(400).json({ ok:false, error:'customer & positive paid required' });

    const now = new Date().toISOString();
    const payRec = {
      id: newId(),
      customer,
      paid: amt,
      // include the payment method as requested (default Cash)
      method: b.method || 'Cash',
      note: b.note || '',
      dateISO: todayISO(),
      createdAt: now,
      updatedAt: now
    };
    await appendRecord('credit_payments', payRec);
    io.emit('new-record', { type:'credit_payments', record: payRec });

    const method = b.method || 'Cash';
    const saleRec = {
      id: newId(),
      dateISO: todayISO(),
      createdAt: now,
      updatedAt: now,
      amount: amt,
      method,
      note: `credit payment - ${customer}`,
      source: `credit:${(customer||'').toLowerCase()}`
    };
    await appendRecord('sales', saleRec);
    io.emit('new-record', { type:'sales', record: saleRec });

    res.json({ ok:true, payment: payRec, sale: saleRec });
  }catch(err){ console.error(err); res.status(500).json({ ok:false, error: err.message }); }
});
app.get('/api/credits/payments/list', async (req,res)=>{
  try{
    const rows = filterByQuery(await readAll('credit_payments'), req.query||{});
    res.json({ ok:true, type:'credit_payments', count: rows.length, rows });
  }catch(err){ res.status(500).json({ ok:false, error: err.message }); }
});

// ===== Orders, Status & Payments =====
const addOrder = handleAdd('orders', b=>{
  const paid=normNum(b.paid||0), amount=normNum(b.amount||0);
  return {
    phone: b.phone||b.clientPhone||'',
    item: b.item||b.product||'',
    amount, paid, remaining:Math.max(0, amount-paid),
    status: (b.status||'Pending'),
    note:b.note||'',
  };
});
app.post('/api/orders/add', addOrder);
app.post('/save-order', addOrder);

app.post('/api/orders/status', async (req,res)=>{
  try{
    const { id, status } = req.body||{};
    if(!id || !status) return res.status(400).json({ ok:false, error:'id & status required' });
    const rec = { id, status, dateISO: todayISO(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await appendRecord('orders_status', rec);
    io.emit('new-record', { type:'orders_status', record: rec });
    res.json({ ok:true, record: rec });
  }catch(err){ res.status(500).json({ ok:false, error: err.message }); }
});

app.post('/api/orders/pay', async (req,res)=>{
  try{
    const { id, amount, method } = req.body||{};
    const amt = normNum(amount||0);
    if(!id || !(amt>0)) return res.status(400).json({ ok:false, error:'id & positive amount required' });

    const orders = await readAll('orders');
    const base = orders.find(o=>o.id===id);
    if(!base) return res.status(404).json({ ok:false, error:'order not found' });

    const payEvents = await readAll('orders_payments');
    const alreadyPaid = payEvents.filter(p=>p.orderId===id).reduce((a,p)=>a+normNum(p.amount||0), normNum(base.paid||0));
    const remaining = Math.max(0, normNum(base.amount||0) - alreadyPaid);
    if(amt > remaining) return res.status(400).json({ ok:false, error:'amount exceeds remaining' });

    const now = new Date().toISOString();
    const payRec = {
      id: newId(),
      orderId: id,
      amount: amt,
      method: method || 'Cash',
      dateISO: todayISO(),
      createdAt: now,
      updatedAt: now
    };
    await appendRecord('orders_payments', payRec);
    io.emit('new-record', { type:'orders_payments', record: payRec });

    const saleRec = {
      id: newId(),
      dateISO: todayISO(),
      createdAt: now,
      updatedAt: now,
      amount: amt,
      method: method || 'Cash',
      note: `from order ${id}`,
      source: `order:${id}`
    };
    await appendRecord('sales', saleRec);
    io.emit('new-record', { type:'sales', record: saleRec });

    res.json({ ok:true, payment: payRec, sale: saleRec, remaining: remaining - amt });
  }catch(err){ console.error(err); res.status(500).json({ ok:false, error: err.message }); }
});

// orders list
app.get('/api/orders/list', async (req,res)=>{
  try{
    const base = filterByQuery(await readAll('orders'), req.query||{});
    const statusEv = await readAll('orders_status');
    const payments = await readAll('orders_payments');

    const latestStatus = new Map();
    for (const ev of statusEv) latestStatus.set(ev.id, ev.status);

    const paidMap = new Map();
    for (const p of payments) paidMap.set(p.orderId, (paidMap.get(p.orderId)||0) + normNum(p.amount||0));

    const rows = base.map(r=>{
      const paidExtra = paidMap.get(r.id)||0;
      const paid = normNum(r.paid||0) + paidExtra;
      const remaining = Math.max(0, normNum(r.amount||0) - paid);
      return Object.assign({}, r, {
        status: latestStatus.get(r.id)||r.status||'Pending',
        paid,
        remaining
      });
    });

    res.json({ ok:true, type:'orders', count: rows.length, rows });
  }catch(err){ res.status(500).json({ ok:false, error: err.message }); }
});

// ===== Cash =====
app.post('/api/cash/add', async (req,res)=>{
  try{
    const b=req.body||{}; const now=new Date();
    const record = {
      id: newId(),
      dateISO: parseToISO(b.date),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      session: b.session || 'morning',
      breakdown: b.breakdown || {},
      total: normNum(b.total||0),
      note: b.note || ''
    };
    await appendRecord('cash', record);
    io.emit('new-record', { type:'cash', record });
    res.json({ ok:true, record });
  }catch(err){ console.error(err); res.status(500).json({ ok:false, error: err.message }); }
});

// ===== Generic list =====
app.get('/api/:type/list', async (req,res)=>{
  try{
    const type=req.params.type;
    if (type==='orders') return; // handled above
    const rows = filterByQuery(await readAll(type), req.query||{});
    res.json({ ok:true, type, count: rows.length, rows });
  }catch(err){ res.status(500).json({ ok:false, error: err.message }); }
});

// ===== CSV Export =====
app.get('/api/:type/export', async (req,res)=>{
  try{
    const type=req.params.type;
    const rows = filterByQuery(await readAll(type), req.query||{});
    const csv = toCSV(rows);
    res.setHeader('Content-Disposition', `attachment; filename="${type}.csv"`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.send(csv);
  }catch(err){ res.status(500).json({ ok:false, error: err.message }); }
});

// ===== Daily PDF Report =====
app.get('/api/report/daily-pdf', async (req,res)=>{
  try{
    const PDFDocument = require('pdfkit');
    const from = req.query.from || todayISO(), to = req.query.to || from;
    const [sales, expenses, credits, orders, cash, payments] = await Promise.all([
      filterByQuery(await readAll('sales'),   {from,to}),
      filterByQuery(await readAll('expenses'),{from,to}),
      filterByQuery(await readAll('credits'), {from,to}),
      filterByQuery(await readAll('orders'),  {from,to}),
      filterByQuery(await readAll('cash'),    {from,to}),
      filterByQuery(await readAll('credit_payments'),{from,to}),
    ]);

    const sCash = sumBy(sales, r=>/cash/i.test(r.method)?normNum(r.amount):0);
    const sTill = sumBy(sales, r=>/till/i.test(r.method)?normNum(r.amount):0);
    const sWith = sumBy(sales, r=>/withdraw/i.test(r.method)?normNum(r.amount):0);
    const sSend = sumBy(sales, r=>/send/i.test(r.method)?normNum(r.amount):0);
const totalSales = sCash + sTill + sWith + sSend;
    const expTot = sumBy(expenses, r=>normNum(r.amount));
const expCash = sumBy(expenses, r=>/cash/i.test(r.method)?normNum(r.amount):0);
const expTill = sumBy(expenses, r=>/till/i.test(r.method)?normNum(r.amount):0);
const expWith = sumBy(expenses, r=>/withdraw/i.test(r.method)?normNum(r.amount):0);
const expSend = sumBy(expenses, r=>/send/i.test(r.method)?normNum(r.amount):0);
    const crGross = sumBy(credits, r=>normNum(r.amount) - normNum(r.paid||0));
    const crPays  = sumBy(payments, r=>normNum(r.paid));
    const crOutstanding = crGross - crPays;
    const morning = sumBy(cash.filter(x=>x.session==='morning'), r=>normNum(r.total));
    const evening = sumBy(cash.filter(x=>x.session==='evening'), r=>normNum(r.total));
const tillOut     = sumBy(cash.filter(x=>x.session==='till_out'), r=>normNum(r.total));
const withdrawOut = sumBy(cash.filter(x=>x.session==='withdraw_out'), r=>normNum(r.total));
const sendOut     = sumBy(cash.filter(x=>x.session==='send_out'), r=>normNum(r.total));
// Cash available is: cash morning + cash sales + withdrawal-out - total expenses
const cashAvailable = morning + sCash + withdrawOut - expTot;
        // Manual cash_out for selected day
    let manualCashOut = 0;
    if (from===to) {
      const kc = await filterByQuery(await readAll('cash'), {from, to});
      manualCashOut = sumBy(kc.filter(x=>x.session==='cash_out'), r=>normNum(r.total));
    }
const eod     = sumBy(cash.filter(x=>x.session==='withdraw_out' || x.session==='eod'),     r=>normNum(r.total));
    const expected = morning + sCash - expTot;
    const diff = expected - evening;
// Compute next morning cash (for next day) to determine cash out
let nextMorning = 0;
try {
  if (from === to) {
    const d = new Date(from);
    d.setDate(d.getDate() + 1);
    const next = d.toISOString().slice(0,10);
    // Read all cash records and sum the next day morning entries
    const allCash = await readAll('cash');
    nextMorning = sumBy(allCash.filter(x => (x.session === 'morning') && ((x.dateISO || x.date) === next)), r => normNum(r.total));
  }
} catch (e) { nextMorning = 0; }
const computedCashOut = nextMorning - cashAvailable;

    res.setHeader('Content-Type','application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="zaad-report-${from}_${to}.pdf"`);
    const doc = new PDFDocument({ margin: 40 });
    doc.pipe(res);
    doc.fontSize(18).text('Zaad Bakery — Daily Report', {align:'center'}).moveDown(0.5);
    doc.fontSize(11).text(`Range: ${from} to ${to}`).moveDown();

    const lines = [
  ['1) Expenses', null],
  ['Expenses', expTot],
  ['2) Sales by Method', null],
  ['Sales (Cash)', sCash], ['Sales (Till No)', sTill], ['Sales (Send Money)', sSend], ['Sales (Withdrawal)', sWith],
  ['3) Cash Counts', null],
  ['Cash Morning', morning], ['Cash Evening', evening],
  ['4) Cash available in cashier', null],
  ['Cash available (computed)', cashAvailable],
  ['5) Outs', null],
  // Cash Out is defined as next morning cash minus current day's available cash
  ['Cash Out (next morning - available)', manualCashOut || computedCashOut], ['Till No Out', tillOut], ['Withdrawal Out', withdrawOut], ['Send Money Out', sendOut],
  ['6) Remaining (carry to next day)', null],
  ['Cash remaining (evening)', evening], ['Till No remaining', sTill - tillOut - expTill], ['Withdrawal remaining', sWith - withdrawOut - expWith], ['Send Money remaining', sSend - sendOut - expSend],
  ['7) Total Sales', null],
  ['Total Sales', totalSales]
];
    lines.forEach(([t,v])=> {
  if (v===null) { doc.moveDown(0.2).fontSize(13).text(t); doc.moveDown(0.1).fontSize(11); }
  else { doc.text(`${t}: ${(+v).toFixed(2)}`); }
});
    doc.moveDown().text('Generated by Zaad Bakery System', {align:'right', oblique:true});
    doc.end();
  }catch(err){ console.error(err); res.status(500).json({ ok:false, error: err.message }); }
});

// ===== Invoice PDF =====
app.post('/api/invoices/create', async (req,res)=>{
  try{
    const PDFDocument = require('pdfkit');
    const { id, clientPhone='', clientName='', items=[] } = req.body || {};
    if(!items || !Array.isArray(items) || !items.length) {
      return res.status(400).json({ ok:false, error:'items required' });
    }
    const invId = id || ('INV-' + newId());
    const filePath = path.join(INVOICE_DIR, `${invId}.pdf`);
    const publicUrl = `/invoices/${invId}.pdf`;

    const doc = new PDFDocument({ margin: 36 });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    doc.fontSize(18).text('Zaad Bakery — Invoice', {align:'center'}).moveDown(0.5);
    doc.fontSize(11).text(`Invoice ID: ${invId}`);
    doc.text(`Date: ${todayISO()}`);
    if(clientName)  doc.text(`Client: ${clientName}`);
    if(clientPhone) doc.text(`Phone: ${clientPhone}`);
    doc.moveDown();

    doc.fontSize(12);
    doc.text('Items:', {underline:true});
    doc.moveDown(0.3);
    let sub=0;
    items.forEach((it,idx)=>{
      const name = (it.name||'').toString();
      const price= normNum(it.price);
      const qty  = normNum(it.qty);
      const line = price*qty;
      sub += line;
      doc.text(`${idx+1}. ${name} — ${price.toFixed(2)} x ${qty} = ${line.toFixed(2)}`);
    });
    doc.moveDown();
    doc.fontSize(14).text(`Total: ${sub.toFixed(2)}`, {align:'right'}).moveDown();

    doc.fontSize(11).text('Thank you for your purchase! We appreciate your business.', {align:'center'});
    doc.end();

    await new Promise((ok,fail)=>{ stream.on('finish',ok); stream.on('error',fail); });

    const scheme = (req.headers['x-forwarded-proto'] || req.protocol || 'http');
    const host   = req.get('host');
    const absUrl = `${scheme}://${host}${publicUrl}`;
    let wa = 'https://wa.me/';
    if(clientPhone){ const p = clientPhone.replace(/[^\d+]/g,''); wa += p.startsWith('+')? p.slice(1) : p; }
    const waLink = `${wa}?text=${encodeURIComponent(`Your invoice ${invId}: ${absUrl}`)}`;

    io.emit('new-record', { type:'invoice', record:{ id:invId, url:publicUrl }});
    res.json({ ok:true, id: invId, url: publicUrl, absoluteUrl: absUrl, waLink });
  }catch(err){ console.error(err); res.status(500).json({ ok:false, error: err.message }); }
});

// ===== Sheets Health =====
app.get('/api/sheets/health', async (req, res) => {
  try {
    const sheets = await getSheetsClient();
    if (!sheets) return res.status(200).json({ ok:false, reason: 'disabled or not configured' });
    const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    res.json({ ok:true, title: meta.data.properties.title, sheets: (meta.data.sheets||[]).map(s=>s.properties.title) });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

// ---------- Boot ----------
ensureDirs();
server.listen(PORT, HOST, ()=> {
  console.log(`Server running on http://localhost:${PORT}`);
  if (!_sheetsState.enabled) {
    console.log('[Sheets] Sync disabled. Set GOOGLE_SERVICE_ACCOUNT_JSON (or GS_CREDENTIALS_JSON) & SPREADSHEET_ID (or GS_SHEET_ID) to enable.');
  } else {
    console.log('[Sheets] Sync is enabled.');
  }
});
