// server.js
// Zaad Bakery — JSON storage + Realtime + Filters + CSV/XLSX/PDF + Credit + Basic Auth + Google Sheets + Cloud/LAN ready

require('dotenv').config();

const express     = require('express');
const path        = require('path');
const fs          = require('fs');
const os          = require('os');
const http        = require('http');
const { Server }  = require('socket.io');
const chokidar    = require('chokidar');
const ExcelJS     = require('exceljs');
const PDFDocument = require('pdfkit');
const { google }  = require('googleapis');

// =============== App / Server ===============
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// =============== Healthz (no auth) ===============
app.get('/healthz', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// =============== Basic Auth (protects everything except /healthz) ===============
if (process.env.PUBLIC_AUTH_USER && process.env.PUBLIC_AUTH_PASS) {
  app.use((req, res, next) => {
    if (req.path === '/healthz') return next();
    const auth = req.headers.authorization || '';
    const [type, b64] = auth.split(' ');
    if (type === 'Basic' && b64) {
      const [u, p] = Buffer.from(b64, 'base64').toString().split(':');
      if (u === process.env.PUBLIC_AUTH_USER && p === process.env.PUBLIC_AUTH_PASS) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Zaad Bakery"');
    return res.status(401).send('Authentication required');
  });
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =============== Static ===============
app.use(express.static(path.join(__dirname, 'public')));
app.use('/img', express.static(path.join(__dirname, 'public', 'img')));

// =============== Data dir (for quick local JSON) ===============
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const pjoin = (...a) => path.join(DATA_DIR, ...a);
['', 'sales', 'expenses', 'cash', 'credit', 'exports'].forEach(d => fs.mkdirSync(pjoin(d), { recursive: true }));

// =============== Helpers ===============
const today = () => new Date().toISOString().slice(0,10);
const toDay = (d) => (d || today());
const readJSON = (file, fallback = []) => { try { return JSON.parse(fs.readFileSync(file, 'utf8') || '[]'); } catch { return fallback; } };
const writeJSON = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8'); };
const sum = (arr, key) => arr.reduce((a, b) => a + (+b[key] || 0), 0);
const getLocalIP = () => {
  const nets = os.networkInterfaces();
  for (const n of Object.keys(nets)){ for (const net of nets[n]){ if (net.family==='IPv4' && !net.internal) return net.address; } }
  return null;
};
function listDates(fromISO, toISO){
  const out = [];
  const from = new Date(fromISO);
  const to   = new Date(toISO);
  const start = from <= to ? from : to;
  const end   = from <= to ? to   : from;
  let d = new Date(start);
  while (d <= end){
    out.push(d.toISOString().slice(0,10));
    d = new Date(d.getTime() + 24*60*60*1000);
  }
  return out;
}

// =============== Google Sheets (write + read) ===============
let gSheetsEnabled = String(process.env.SHEETS_ENABLED || '').toLowerCase() === 'true';
let spreadsheetId  = process.env.SHEETS_SPREADSHEET_ID || '';
let sheetsClient   = null;

async function initSheets(){
  if (!gSheetsEnabled) return console.log('Sheets: disabled');
  if (!spreadsheetId) { gSheetsEnabled = false; return console.warn('Sheets: missing SHEETS_SPREADSHEET_ID'); }
  try {
    const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS || '/etc/secrets/google.json';
    const auth = new google.auth.GoogleAuth({
      keyFile,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const client = await auth.getClient();
    sheetsClient = google.sheets({ version: 'v4', auth: client });
    console.log('Sheets: initialized');
  } catch (e) {
    gSheetsEnabled = false;
    console.error('Sheets init error:', e.message);
  }
}
initSheets().catch(()=>{});

async function ensureHeader(sheet, header){
  if (!gSheetsEnabled || !sheetsClient) return;
  try {
    const r = await sheetsClient.spreadsheets.values.get({ spreadsheetId, range: `${sheet}!A1:Z1` });
    const values = r.data.values || [];
    if (!values.length || !values[0] || values[0].join('').trim() === '') {
      await sheetsClient.spreadsheets.values.update({
        spreadsheetId,
        range: `${sheet}!A1:${String.fromCharCode(64 + header.length)}1`,
        valueInputOption: 'RAW',
        requestBody: { values: [header] },
      });
      console.log(`Sheets: header written for ${sheet}`);
    }
  } catch (_) { /* ignore */ }
}

async function appendRow(sheet, header, rowValues){
  if (!gSheetsEnabled || !sheetsClient) return;
  try {
    await ensureHeader(sheet, header);
    await sheetsClient.spreadsheets.values.append({
      spreadsheetId,
      range: `${sheet}!A:Z`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [rowValues] },
    });
  } catch (e) {
    console.error(`Sheets append error (${sheet}):`, e.message);
  }
}

// Test read endpoint
app.get('/api/sheet', async (req, res) => {
  try {
    if (!gSheetsEnabled) return res.status(500).json({ ok:false, error:'Sheets disabled' });
    const tab = req.query.tab || 'Sales';
    const range = `${tab}!A1:G50`;
    const resp = await sheetsClient.spreadsheets.values.get({ spreadsheetId, range });
    const values = resp.data.values || [];
    res.json({ ok:true, rows: values.length, data: values });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

// =============== Seed credit customers ===============
const CUST_FILE = pjoin('credit', '_customers.json');
if (!fs.existsSync(CUST_FILE)) {
  writeJSON(CUST_FILE, ["Bakkal","Habib","Snack attack","Azza","Freez","Malaki"]);
}

// =============== SALES ===============
app.post('/api/sales', (req, res) => {
  const { amount, method, note, date } = req.body || {};
  if (amount == null) return res.status(400).send('amount required');

  const d  = toDay(date);
  const fp = pjoin('sales', `${d}.json`);
  const arr = readJSON(fp);

  const nowIso = new Date().toISOString();
  const row = { amount:+amount, method: method || 'Cash', note, date: nowIso };

  // de-dupe (1.5s)
  const last = arr[arr.length - 1];
  const tooClose    = last && Math.abs(new Date(nowIso) - new Date(last.date)) < 1500;
  const samePayload = last && last.amount === row.amount && last.method === row.method && (last.note || '') === (row.note || '');
  if (!(tooClose && samePayload)) {
    arr.push(row);
    writeJSON(fp, arr);
    appendRow('Sales', ['ts','amount','method','note','business_date'], [nowIso, row.amount, row.method, row.note || '', d]);
  }
  res.json({ ok: true });
});
app.get('/api/sales', (req, res) => {
  const d = toDay(req.query.date);
  res.json(readJSON(pjoin('sales', `${d}.json`)));
});

app.get('/api/sales/search', (req, res) => {
  const { from, to, method, min, max, q } = req.query;
  const F = from || to || today();
  const T = to   || from || today();

  const files = listDates(F, T).map(d => pjoin('sales', `${d}.json`));
  let rows = []; files.forEach(fp => rows = rows.concat(readJSON(fp)));

  const qlc  = (q || '').toString().trim().toLowerCase();
  const minV = (min !== undefined && min !== '') ? +min : -Infinity;
  const maxV = (max !== undefined && max !== '') ? +max : +Infinity;

  rows = rows.filter(r => {
    const okMethod = !method || method === 'All' || r.method === method;
    const okAmt    = (+r.amount >= minV) && (+r.amount <= maxV);
    const okQ      = !qlc || ((r.note || '').toString().toLowerCase().includes(qlc));
    return okMethod && okAmt && okQ;
  });

  const total = rows.reduce((a,b)=>a+(+b.amount||0),0);
  res.json({ rows, total, count: rows.length, from:F, to:T });
});

// =============== EXPENSES ===============
app.post('/api/expenses', (req, res) => {
  const { amount, category, method, note, date } = req.body || {};
  if (amount == null) return res.status(400).send('amount required');
  const d = toDay(date);
  const fp = pjoin('expenses', `${d}.json`);
  const arr = readJSON(fp);
  const nowIso = new Date().toISOString();
  const r = { amount:+amount, category, method: method || 'Cash', note, date: nowIso };
  arr.push(r);
  writeJSON(fp, arr);
  appendRow('Expenses', ['ts','amount','category','method','note','business_date'], [nowIso, r.amount, r.category || '', r.method || '', r.note || '', d]);
  res.json({ ok: true });
});
app.get('/api/expenses', (req, res) => {
  const d = toDay(req.query.date);
  res.json(readJSON(pjoin('expenses', `${d}.json`)));
});

// =============== CASH ===============
app.post('/api/cash', (req, res) => {
  const { shift, denominations, note, date } = req.body || {};
  const d = toDay(date);
  const fp = pjoin('cash', `${d}.json`);
  const arr = readJSON(fp);
  const den = denominations || {};
  let total = 0; Object.keys(den).forEach(k => total += (+k) * (+den[k] || 0));
  const nowIso = new Date().toISOString();
  const r = { shift: shift || 'morning', denominations: den, total, note, date: nowIso };
  arr.push(r);
  writeJSON(fp, arr);
  appendRow('Cash', ['ts','shift','total','note','denominations_json','business_date'], [nowIso, r.shift, r.total, r.note || '', JSON.stringify(r.denominations||{}), d]);
  res.json({ ok: true, total });
});
app.get('/api/cash', (req, res) => {
  const d = toDay(req.query.date);
  res.json(readJSON(pjoin('cash', `${d}.json`)));
});

// =============== CREDIT ===============
const creditFile = (customer) => pjoin('credit', `${customer}.json`);

app.get('/api/credit/customers', (req, res) => res.json(readJSON(CUST_FILE, [])));
app.post('/api/credit/customers', (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).send('name required');
  const list = readJSON(CUST_FILE, []);
  if (!list.includes(name)) { list.push(name); writeJSON(CUST_FILE, list); }
  res.json({ ok:true, customers:list });
});

app.post('/api/credit/purchase', (req, res) => {
  const { customer, amount, note, date } = req.body || {};
  if (!customer || amount == null) return res.status(400).send('customer & amount required');
  const arr = readJSON(creditFile(customer));
  const nowIso = date || new Date().toISOString();
  const r = { type:'purchase', amount:+amount, note, date: nowIso };
  arr.push(r); writeJSON(creditFile(customer), arr);
  appendRow('Credit', ['ts','customer','type','amount','method','note','business_date'], [nowIso, customer, 'purchase', r.amount, '', r.note || '', nowIso.slice(0,10)]);
  res.json({ ok: true });
});
app.post('/api/credit/payment', (req, res) => {
  const { customer, amount, method, note, date } = req.body || {};
  if (!customer || amount == null) return res.status(400).send('customer & amount required');
  const arr = readJSON(creditFile(customer));
  const nowIso = date || new Date().toISOString();
  const r = { type:'payment', amount:+amount, method: method || 'Cash', note, date: nowIso };
  arr.push(r); writeJSON(creditFile(customer), arr);
  appendRow('Credit', ['ts','customer','type','amount','method','note','business_date'], [nowIso, customer, 'payment', r.amount, r.method || '', r.note || '', nowIso.slice(0,10)]);
  res.json({ ok: true });
});
app.get('/api/credit', (req, res) => {
  const { customer } = req.query;
  if (!customer) return res.status(400).send('customer required');
  res.json(readJSON(creditFile(customer)));
});
app.get('/api/credit/summary', (req, res) => {
  const dir = pjoin('credit');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== '_customers.json');
  const out = files.map(f => {
    const customer = f.replace(/\.json$/,'');
    const rows = readJSON(path.join(dir, f));
    const purchase = rows.filter(r => r.type === 'purchase').reduce((a,b)=>a+(+b.amount||0),0);
    const payment  = rows.filter(r => r.type === 'payment' ).reduce((a,b)=>a+(+b.amount||0),0);
    return { customer, purchase, payment, balance: purchase - payment };
  }).sort((a,b)=> b.balance - a.balance);
  res.json(out);
});

// =============== Reports ===============
app.get('/api/reports/daily', (req, res) => {
  const d = toDay(req.query.date);
  const sales = readJSON(pjoin('sales', `${d}.json`));
  const expenses = readJSON(pjoin('expenses', `${d}.json`));
  const cash = readJSON(pjoin('cash', `${d}.json`));
  const salesTotal = sum(sales, 'amount');
  const expensesTotal = sum(expenses, 'amount');
  const profit = salesTotal - expensesTotal;
  const cm = (cash.find(x=>x.shift==='morning')||{}).total || 0;
  const ce = (cash.find(x=>x.shift==='evening')||{}).total || 0;
  const cashDiff = ce - cm;
  res.json({ date:d, salesTotal, expensesTotal, profit, cashMorning:cm, cashEvening:ce, cashDiff });
});
app.get('/api/reports/last7', (req, res) => {
  const results = [];
  for (let i=6; i>=0; i--){
    const day = new Date(Date.now() - i*24*60*60*1000).toISOString().slice(0,10);
    const sales = readJSON(pjoin('sales', `${day}.json`));
    results.push({ date: day, total: sum(sales, 'amount') });
  }
  res.json(results);
});

// =============== Export CSV/XLSX/PDF ===============
function sendCSV(res, filename, header, rows) {
  const csv = [header.join(','), ...rows.map(r => header.map(h => (r[h] ?? '')).join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
}
app.get('/api/export/csv/sales', (req, res) => {
  const d = toDay(req.query.date);
  const rows = readJSON(pjoin('sales', `${d}.json`)).map(r => ({ date:r.date, amount:r.amount, method:r.method, note:r.note||'' }));
  sendCSV(res, `sales-${d}.csv`, ['date','amount','method','note'], rows);
});
app.get('/api/export/csv/expenses', (req, res) => {
  const d = toDay(req.query.date);
  const rows = readJSON(pjoin('expenses', `${d}.json`)).map(r => ({ date:r.date, amount:r.amount, category:r.category||'', method:r.method||'', note:r.note||'' }));
  sendCSV(res, `expenses-${d}.csv`, ['date','amount','category','method','note'], rows);
});
app.get('/api/export/csv/cash', (req, res) => {
  const d = toDay(req.query.date);
  const rows = readJSON(pjoin('cash', `${d}.json`)).map(r => ({ date:r.date, shift:r.shift, total:r.total, note:r.note||'', denominations: JSON.stringify(r.denominations||{}) }));
  sendCSV(res, `cash-${d}.csv`, ['date','shift','total','note','denominations'], rows);
});
app.get('/api/export/csv/sales-filter', (req, res) => {
  const { from, to, method, min, max, q } = req.query;
  const F = from || to || today(); const T = to || from || today();
  const files = listDates(F, T).map(d => pjoin('sales', `${d}.json`));
  let rows = []; files.forEach(fp => rows = rows.concat(readJSON(fp)));
  const qlc = (q || '').toString().trim().toLowerCase();
  const minV = (min !== undefined && min !== '') ? +min : -Infinity;
  const maxV = (max !== undefined && max !== '') ? +max : +Infinity;
  rows = rows.filter(r => {
    const okMethod = !method || method === 'All' || r.method === method;
    const okAmt = (+r.amount >= minV) && (+r.amount <= maxV);
    const okQ   = !qlc || ((r.note || '').toString().toLowerCase().includes(qlc));
    return okMethod && okAmt && okQ;
  });
  const shaped = rows.map(r => ({ date:r.date, amount:r.amount, method:r.method, note:r.note||'' }));
  sendCSV(res, `sales-${F}_to_${T}.csv`, ['date','amount','method','note'], shaped);
});
async function fetchDaily(d){
  const sales = readJSON(pjoin('sales', `${d}.json`));
  const expenses = readJSON(pjoin('expenses', `${d}.json`));
  const cash = readJSON(pjoin('cash', `${d}.json`));
  const salesTotal = sum(sales, 'amount');
  const expensesTotal = sum(expenses, 'amount');
  const profit = salesTotal - expensesTotal;
  const cm = (cash.find(x=>x.shift==='morning')||{}).total || 0;
  const ce = (cash.find(x=>x.shift==='evening')||{}).total || 0;
  const cashDiff = ce - cm;
  return { salesTotal, expensesTotal, profit, cashMorning: cm, cashEvening: ce, cashDiff };
}
app.get('/api/export/xlsx/daily', async (req, res) => {
  const d = toDay(req.query.date);
  const r = await fetchDaily(d);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Daily');
  ws.addRow(['Date', d]);
  ws.addRow(['Sales Total', r.salesTotal]);
  ws.addRow(['Expenses Total', r.expensesTotal]);
  ws.addRow(['Profit', r.profit]);
  ws.addRow(['Cash Morning', r.cashMorning]);
  ws.addRow(['Cash Evening', r.cashEvening]);
  ws.addRow(['Cash Diff', r.cashDiff]);
  ws.columns = [{ width: 22 }, { width: 20 }];
  const filePath = pjoin('exports', `daily-${d}.xlsx`);
  await wb.xlsx.writeFile(filePath);
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition',`attachment; filename="daily-${d}.xlsx"`);
  fs.createReadStream(filePath).pipe(res);
});
app.get('/api/export/pdf/daily', async (req, res) => {
  const d = toDay(req.query.date);
  const r = await fetchDaily(d);
  const filePath = pjoin('exports', `daily-${d}.pdf`);
  const doc = new PDFDocument({ margin: 40 });
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);
  doc.fontSize(20).text(process.env.REPORT_TITLE || 'Zaad Bakery — Daily Report', { align: 'center' });
  doc.moveDown();
  const row = (k,v)=>doc.fontSize(12).text(`${k}: ${v}`);
  row('Date', d);
  row('Sales Total', r.salesTotal.toFixed(2));
  row('Expenses Total', r.expensesTotal.toFixed(2));
  row('Profit', r.profit.toFixed(2));
  row('Cash Morning', r.cashMorning.toFixed(2));
  row('Cash Evening', r.cashEvening.toFixed(2));
  row('Cash Diff', r.cashDiff.toFixed(2));
  doc.end();
  stream.on('finish', () => {
    res.setHeader('Content-Type','application/pdf');
    res.setHeader('Content-Disposition',`attachment; filename="daily-${d}.pdf"`);
    fs.createReadStream(filePath).pipe(res);
  });
});

// =============== Meta (LAN) ===============
app.get('/api/meta/lan', (req, res) => {
  const envPort = process.env.PORT || '3000';
  const portNum = parseInt(envPort, 10);
  const ip = getLocalIP() || 'localhost';
  res.json({ ip, port: portNum, url:`http://${ip}:${portNum}` });
});

// =============== Realtime (file watcher) ===============
const watcher = chokidar.watch([pjoin('sales'), pjoin('expenses'), pjoin('cash'), pjoin('credit')], { ignoreInitial:true, depth:3 });
watcher.on('all', (_, filePath) => {
  try {
    const rel = path.relative(DATA_DIR, filePath).replace(/\\/g,'/');
    const bucket = rel.split('/')[0];
    io.emit('data:changed', { bucket, file: rel, at: Date.now() });
  } catch(e){ console.error('watcher error', e); }
});
io.on('connection', () => console.log('Realtime client connected'));

// =============== Start ===============
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
server.listen(PORT, HOST, () => {
  const ip = getLocalIP();
  console.log(`Server running on http://localhost:${PORT}`);
  if (ip) console.log(`LAN:   http://${ip}:${PORT}`);
});
