// server.js
// Zaad Bakery – Sales & Cash Manager
// JSON storage + Realtime (socket.io) + Reports + Reconciliation + Mobile Money Ledger
// Exports (CSV/XLSX/PDF) + Basic Auth + optional Google Sheets sync

require('dotenv').config();

const express     = require('express');
const cors        = require('cors');
const path        = require('path');
const fs          = require('fs');
const os          = require('os');
const http        = require('http');
const { Server }  = require('socket.io');
const chokidar    = require('chokidar');
const ExcelJS     = require('exceljs');
const PDFDocument = require('pdfkit');
const { google }  = require('googleapis');

// ===== App / Server =====
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ===== Health (no auth) =====
app.get('/healthz', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ===== Basic Auth for everything else =====
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

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// ===== Static =====
app.use(express.static(path.join(__dirname, 'public')));

// ===== Data dir =====
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const P = (...a) => path.join(DATA_DIR, ...a);
[
  '', 'sales', 'expenses', 'cash', 'credit',
  'orders', 'products', 'customers', 'cashcount',
  'withdraw', 'ledger', 'exports'
].forEach(d => fs.mkdirSync(P(d), { recursive: true }));

// ===== Helpers =====
const today = () => new Date().toISOString().slice(0,10);
const toDay = (d) => (d || today());
const readJSON = (file, fallback = []) => { try { return JSON.parse(fs.readFileSync(file, 'utf8') || '[]'); } catch { return fallback; } };
const writeJSON = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8'); };
const sum = (arr, key) => arr.reduce((a, b) => a + (+b[key] || 0), 0);
const getLocalIP = () => { const nets = os.networkInterfaces(); for (const n of Object.keys(nets)){ for (const net of nets[n]){ if (net.family==='IPv4' && !net.internal) return net.address; } } return null; };
const listDates = (fromISO, toISO) => { const out=[]; const from=new Date(fromISO); const to=new Date(toISO); const s=from<=to?from:to; const e=from<=to?to:from; let d=new Date(s); while(d<=e){ out.push(d.toISOString().slice(0,10)); d=new Date(d.getTime()+86400000);} return out; };
const uid = (pfx='id') => `${pfx}_${Math.random().toString(36).slice(2,9)}_${Date.now().toString(36)}`;
const payMethods = ['Cash','Withdraw Cash','Buy Goods','Send Money','Till No'];

// ===== Google Sheets (optional) =====
const SHEETS_ENABLED = String(process.env.SHEETS_ENABLED || '').toLowerCase() === 'true';
const SHEET_ID = process.env.SHEETS_SPREADSHEET_ID || '';
const KEY_FILE = process.env.GOOGLE_APPLICATION_CREDENTIALS || '/etc/secrets/google.json';

async function getSheetsClient(scopeWrite=false){
  if (!SHEETS_ENABLED || !SHEET_ID) return null;
  const scopes = scopeWrite ? ['https://www.googleapis.com/auth/spreadsheets'] : ['https://www.googleapis.com/auth/spreadsheets.readonly'];
  const auth = new google.auth.GoogleAuth({ keyFile: KEY_FILE, scopes });
  const client = await auth.getClient();
  return google.sheets({ version: 'v4', auth: client });
}
const tabA1 = (tab) => `'${String(tab).replace(/'/g, "''")}'`;

async function ensureSheet(tab){
  try {
    const sheets = await getSheetsClient(true); if (!sheets) return;
    const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
    const exists = (meta.data.sheets||[]).some(s => s.properties?.title === tab);
    if (!exists) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: { requests: [{ addSheet: { properties: { title: tab } } }] }
      });
      console.log('Sheets: created tab', tab);
    }
  } catch(e){ console.error('ensureSheet', e.message); }
}
async function ensureHeader(tab, header){
  try {
    const sheets = await getSheetsClient(true); if (!sheets) return;
    await ensureSheet(tab);
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${tabA1(tab)}!A1:Z1` });
    const values = r.data.values || [];
    if (!values.length || !values[0] || values[0].join('').trim() === '') {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${tabA1(tab)}!A1:${String.fromCharCode(64 + header.length)}1`,
        valueInputOption: 'RAW',
        requestBody: { values: [header] },
      });
      console.log(`Sheets: header written for ${tab}`);
    }
  } catch(e){ console.error('ensureHeader', e.message); }
}
async function appendRow(tab, header, rowValues){
  try {
    if (!SHEETS_ENABLED || !SHEET_ID) return;
    const sheets = await getSheetsClient(true); if (!sheets) return;
    await ensureHeader(tab, header);
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${tabA1(tab)}!A:Z`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [rowValues] },
    });
  } catch(e){ console.error(`Sheets append error (${tab}):`, e.message); }
}

// ===== Seed customers (credit) =====
const CUST_FILE = P('customers','_customers.json');
if (!fs.existsSync(CUST_FILE)) {
  writeJSON(CUST_FILE, [
    { CustomerID:'cust_bakkal',  Name:'bakkal',  Phone:'', Notes:'', IsCreditCustomer:true },
    { CustomerID:'cust_azza',    Name:'Azza',    Phone:'', Notes:'', IsCreditCustomer:true },
    { CustomerID:'cust_habib',   Name:'habib',   Phone:'', Notes:'', IsCreditCustomer:true },
    { CustomerID:'cust_snack',   Name:'snack attack', Phone:'', Notes:'', IsCreditCustomer:true },
    { CustomerID:'cust_crave',   Name:'crave',   Phone:'', Notes:'', IsCreditCustomer:true },
    { CustomerID:'cust_popa',    Name:'popa tea',Phone:'', Notes:'', IsCreditCustomer:true },
    { CustomerID:'cust_chopit',  Name:'Chopit',  Phone:'', Notes:'', IsCreditCustomer:true },
    { CustomerID:'cust_freez',   Name:'Freez',   Phone:'', Notes:'', IsCreditCustomer:true },
    { CustomerID:'cust_malaki',  Name:'malaki',  Phone:'', Notes:'', IsCreditCustomer:true }
  ]);
}

// ======= PRODUCTS =======
app.get('/api/products', (req,res)=> res.json(readJSON(P('products','list.json'), [])));
app.post('/api/products', (req,res)=>{
  const list = readJSON(P('products','list.json'), []);
  const { ProductID, Name, Category, UnitPrice, IsActive=true } = req.body || {};
  if (!Name || UnitPrice==null) return res.status(400).send('Name & UnitPrice required');
  let id = ProductID || uid('prd');
  const idx = list.findIndex(x=>x.ProductID===id);
  const row = { ProductID:id, Name, Category: Category||'Other', UnitPrice:+UnitPrice, IsActive: !!IsActive };
  if (idx>=0) list[idx]=row; else list.push(row);
  writeJSON(P('products','list.json'), list);
  appendRow('Products',['ts','ProductID','Name','Category','UnitPrice','IsActive'], [new Date().toISOString(), id, Name, row.Category, row.UnitPrice, row.IsActive?'TRUE':'FALSE']);
  res.json({ ok:true, product:row });
});

// ======= CUSTOMERS =======
app.get('/api/customers', (req,res)=> res.json(readJSON(CUST_FILE, [])));
app.post('/api/customers', (req,res)=>{
  const list = readJSON(CUST_FILE, []);
  const { CustomerID, Name, Phone, Notes, IsCreditCustomer=true } = req.body || {};
  if (!Name) return res.status(400).send('Name required');
  const id = CustomerID || uid('cus');
  const idx = list.findIndex(x=>x.CustomerID===id);
  const row = { CustomerID:id, Name, Phone:Phone||'', Notes:Notes||'', IsCreditCustomer: !!IsCreditCustomer };
  if (idx>=0) list[idx]=row; else list.push(row);
  writeJSON(CUST_FILE, list);
  appendRow('Customers',['ts','CustomerID','Name','Phone','Notes','IsCreditCustomer'], [new Date().toISOString(), id, row.Name, row.Phone, row.Notes, row.IsCreditCustomer?'TRUE':'FALSE']);
  res.json({ ok:true, customer:row });
});

// ======= SALES =======
app.post('/api/sales', (req, res) => {
  const { amount, method, note, date, Product, Quantity=1, UnitPrice, TillNumber, CreatedBy } = req.body || {};
  if (amount == null && (Quantity==null || UnitPrice==null)) return res.status(400).send('amount or (Quantity & UnitPrice) required');

  const d  = toDay(date);
  const fp = P('sales', `${d}.json`);
  const arr = readJSON(fp);

  const nowIso = new Date().toISOString();
  const gross = (Quantity!=null && UnitPrice!=null) ? (+Quantity)*(+UnitPrice) : (+amount);
  const row = {
    SaleID: uid('sale'),
    amount:+gross,
    method: payMethods.includes(method) ? method : 'Cash',
    note, date: nowIso,
    Product: Product || null,
    Quantity: +Quantity || 1,
    UnitPrice: UnitPrice!=null ? +UnitPrice : (gross / (+Quantity||1)),
    TillNumber: TillNumber || '',
    CreatedBy: CreatedBy || ''
  };

  // de-dupe 1.5s
  const last = arr[arr.length - 1];
  const tooClose = last && Math.abs(new Date(nowIso) - new Date(last.date)) < 1500;
  const samePayload = last && last.amount===row.amount && last.method===row.method && (last.note||'')===(row.note||'');
  if (!(tooClose && samePayload)) {
    arr.push(row);
    writeJSON(fp, arr);
    appendRow('Sales',['ts','amount','method','note','business_date','product','qty','unit_price','till','created_by'],
      [nowIso, row.amount, row.method, row.note||'', d, row.Product||'', row.Quantity, row.UnitPrice, row.TillNumber, row.CreatedBy]);
    io.emit('data:changed', { bucket:'sales', file:`sales/${d}.json`, at:Date.now() });
  }
  res.json({ ok: true });
});
app.get('/api/sales', (req, res) => { const d = toDay(req.query.date); res.json(readJSON(P('sales', `${d}.json`))); });

app.get('/api/sales/search', (req, res) => {
  const { from, to, method, min, max, q } = req.query;
  const F = from || to || today(); const T = to || from || today();
  const files = listDates(F, T).map(d => P('sales', `${d}.json`));
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

// ======= EXPENSES =======
app.post('/api/expenses', (req, res) => {
  const { amount, category, method, note, item, date } = req.body || {};
  if (amount == null) return res.status(400).send('amount required');
  const d = toDay(date);
  const fp = P('expenses', `${d}.json`);
  const arr = readJSON(fp);
  const nowIso = new Date().toISOString();
  const r = { ExpenseID: uid('exp'), amount:+amount, category:category||'', method: payMethods.includes(method)?method:'Cash', note, item:item||'', date: nowIso };
  arr.push(r);
  writeJSON(fp, arr);
  appendRow('Expenses',['ts','amount','category','method','note','business_date','item'], [nowIso, r.amount, r.category, r.method, r.note||'', d, r.item||'']);
  io.emit('data:changed', { bucket:'expenses', file:`expenses/${d}.json`, at:Date.now() });
  res.json({ ok: true });
});
app.get('/api/expenses', (req, res) => { const d = toDay(req.query.date); res.json(readJSON(P('expenses', `${d}.json`))); });

// ======= CASH COUNT (morning/evening) =======
app.post('/api/cashcount', (req, res) => {
  const { CountDate, Session, denominations, Note } = req.body || {};
  const d = toDay(CountDate);
  const fp = P('cashcount', `${d}.json`);
  const arr = readJSON(fp);
  const den = denominations || {}; // e.g. {"1000":1,"500":2,...}
  let total = 0; Object.keys(den).forEach(k => total += (+k) * (+den[k] || 0));
  const nowIso = new Date().toISOString();
  const r = { CashCountID: uid('cc'), CountDate:d, Session: (Session||'Morning'), denominations: den, CashTotal: total, Note: Note||'', date: nowIso };
  arr.push(r); writeJSON(fp, arr);
  appendRow('CashCount',['ts','date','session','cash_total','denominations_json','note'], [nowIso, d, r.Session, r.CashTotal, JSON.stringify(den), r.Note||'']);
  io.emit('data:changed', { bucket:'cashcount', file:`cashcount/${d}.json`, at:Date.now() });
  res.json({ ok: true, total });
});
app.get('/api/cashcount', (req,res)=>{ const d=toDay(req.query.date); res.json(readJSON(P('cashcount',`${d}.json`))); });

// ======= WITHDRAW (mobile->cash) =======
app.post('/api/withdraw', (req,res)=>{
  const { date, amount, note } = req.body || {};
  if (amount==null) return res.status(400).send('amount required');
  const d = toDay(date);
  const fp = P('withdraw', `${d}.json`);
  const arr = readJSON(fp);
  const nowIso = new Date().toISOString();
  const r = { id: uid('wd'), date: nowIso, business_date:d, amount:+amount, note: note||'' };
  arr.push(r); writeJSON(fp, arr);
  appendRow('Withdraw',['ts','business_date','amount','note'], [nowIso, d, r.amount, r.note||'']);
  io.emit('data:changed', { bucket:'withdraw', file:`withdraw/${d}.json`, at:Date.now() });
  res.json({ ok:true });
});
app.get('/api/withdraw', (req,res)=>{ const d=toDay(req.query.date); res.json(readJSON(P('withdraw',`${d}.json`))); });

// ======= ORDERS =======
app.post('/api/orders', (req,res)=>{
  const { DateTime, Customer, CustomerPhone, Items, TotalPrice, IsPaid=false, PaidMethod, Note } = req.body || {};
  const d = toDay(DateTime);
  const fp = P('orders', `${d}.json`);
  const arr = readJSON(fp);
  const nowIso = new Date().toISOString();
  const r = { OrderID: uid('ord'), DateTime: nowIso, Customer: Customer||'', CustomerPhone: CustomerPhone||'', Items: Items||'', TotalPrice:+(TotalPrice||0), IsPaid: !!IsPaid, PaidMethod: IsPaid? (payMethods.includes(PaidMethod)?PaidMethod:'Cash') : '', Note: Note||'' };
  arr.push(r); writeJSON(fp, arr);
  appendRow('Orders',['ts','order_id','date','customer','phone','items','total','is_paid','method','note'], [nowIso, r.OrderID, d, r.Customer, r.CustomerPhone, r.Items, r.TotalPrice, r.IsPaid?'TRUE':'FALSE', r.PaidMethod||'', r.Note||'']);
  io.emit('data:changed', { bucket:'orders', file:`orders/${d}.json`, at:Date.now() });
  res.json({ ok:true, order:r });
});
app.get('/api/orders', (req,res)=>{ const d=toDay(req.query.date); res.json(readJSON(P('orders',`${d}.json`))); });
app.post('/api/orders/pay', (req,res)=>{
  const { OrderID, date, method } = req.body || {};
  if (!OrderID) return res.status(400).send('OrderID required');
  const d = toDay(date);
  const fp = P('orders', `${d}.json`);
  const arr = readJSON(fp);
  const i = arr.findIndex(o=>o.OrderID===OrderID);
  if (i<0) return res.status(404).send('Order not found on that day');
  arr[i].IsPaid = true; arr[i].PaidMethod = payMethods.includes(method)?method:'Cash';
  writeJSON(fp, arr);
  appendRow('Orders',['ts','order_id','date','paid_update','method'], [new Date().toISOString(), OrderID, d, 'TRUE', arr[i].PaidMethod]);
  io.emit('data:changed', { bucket:'orders', file:`orders/${d}.json`, at:Date.now() });
  res.json({ ok:true });
});

// ======= CREDIT (purchase/payment + aging) =======
const creditFile = (customer) => P('credit', `${customer}.json`);

app.get('/api/credit/customers', (req, res) => res.json(readJSON(CUST_FILE, [])));
app.post('/api/credit/purchase', (req, res) => {
  const { customer, amount, note, date, Product, Quantity=1, Price } = req.body || {};
  if (!customer || amount == null) return res.status(400).send('customer & amount required');
  const arr = readJSON(creditFile(customer));
  const nowIso = date || new Date().toISOString();
  const r = { type:'purchase', amount:+amount, note, date: nowIso, Product:Product||'', Quantity:+Quantity||1, Price: Price!=null? +Price : +amount };
  arr.push(r); writeJSON(creditFile(customer), arr);
  appendRow('Credit',['ts','customer','type','amount','method','note','business_date'], [nowIso, customer, 'purchase', r.amount, '', r.note||'', nowIso.slice(0,10)]);
  res.json({ ok: true });
});
app.post('/api/credit/payment', (req, res) => {
  const { customer, amount, method, note, date } = req.body || {};
  if (!customer || amount == null) return res.status(400).send('customer & amount required');
  const arr = readJSON(creditFile(customer));
  const nowIso = date || new Date().toISOString();
  const r = { type:'payment', amount:+amount, method: payMethods.includes(method)?method:'Cash', note, date: nowIso };
  arr.push(r); writeJSON(creditFile(customer), arr);
  appendRow('Credit',['ts','customer','type','amount','method','note','business_date'], [nowIso, customer, 'payment', r.amount, r.method||'', r.note||'', nowIso.slice(0,10)]);
  res.json({ ok: true });
});
app.get('/api/credit', (req, res) => {
  const { customer } = req.query;
  if (!customer) return res.status(400).send('customer required');
  res.json(readJSON(creditFile(customer)));
});
app.get('/api/credit/summary', (req, res) => {
  const dir = P('credit');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  const out = files.map(f => {
    const customer = f.replace(/\.json$/,'');
    const rows = readJSON(path.join(dir, f));
    const purchase = rows.filter(r => r.type === 'purchase').reduce((a,b)=>a+(+b.amount||0),0);
    const payment  = rows.filter(r => r.type === 'payment' ).reduce((a,b)=>a+(+b.amount||0),0);
    return { customer, purchase, payment, balance: purchase - payment };
  }).sort((a,b)=> b.balance - a.balance);
  res.json(out);
});

// ======= Reports =======
app.get('/api/reports/daily', (req, res) => {
  const d = toDay(req.query.date);
  const sales = readJSON(P('sales', `${d}.json`));
  const expenses = readJSON(P('expenses', `${d}.json`));
  const cashcount = readJSON(P('cashcount', `${d}.json`));
  const salesTotal = sum(sales, 'amount');
  const expensesTotal = sum(expenses, 'amount');
  const profit = salesTotal - expensesTotal;
  const cm = (cashcount.find(x=>String(x.Session).toLowerCase()==='morning')||{}).CashTotal || 0;
  const ce = (cashcount.find(x=>String(x.Session).toLowerCase()==='evening')||{}).CashTotal || 0;
  const cashDiff = ce - cm;
  res.json({ date:d, salesTotal, expensesTotal, profit, cashMorning:cm, cashEvening:ce, cashDiff });
});
app.get('/api/reports/last7', (req, res) => {
  const results = [];
  for (let i=6; i>=0; i--){
    const day = new Date(Date.now() - i*86400000).toISOString().slice(0,10);
    const sales = readJSON(P('sales', `${day}.json`));
    results.push({ date: day, total: sum(sales, 'amount') });
  }
  res.json(results);
});

// Reconciliation (Cash + Mobile per channel)
app.get('/api/reports/reconcile', (req,res)=>{
  const d = toDay(req.query.date);
  const sales = readJSON(P('sales', `${d}.json`));
  const expenses = readJSON(P('expenses', `${d}.json`));
  const cashcount = readJSON(P('cashcount', `${d}.json`));
  const withdraw = readJSON(P('withdraw', `${d}.json`));

  // Cash parts
  const opening = (cashcount.find(x=>String(x.Session).toLowerCase()==='morning')||{}).CashTotal || 0;
  const closing = (cashcount.find(x=>String(x.Session).toLowerCase()==='evening')||{}).CashTotal || 0;
  const cashSales = sales.filter(s=>s.method==='Cash').reduce((a,b)=>a+(+b.amount||0),0);
  const cashCreditCollections = readJSON(P('credit'),[]); // computed from customer files
  let creditCash=0;
  const dir = P('credit');
  fs.readdirSync(dir).filter(f=>f.endsWith('.json')).forEach(f=>{
    const rows = readJSON(path.join(dir,f));
    creditCash += rows.filter(r=>r.type==='payment' && r.method==='Cash' && (r.date||'').slice(0,10)===d)
                      .reduce((a,b)=>a+(+b.amount||0),0);
  });

  const cashExp = expenses.filter(e=>e.method==='Cash').reduce((a,b)=>a+(+b.amount||0),0);
  const wdToCash = withdraw.reduce((a,b)=>a+(+b.amount||0),0);
  const depositsOut = 0; const others = 0; // extend via POST if needed

  const expected = opening + cashSales + creditCash + wdToCash - cashExp - depositsOut + others;
  const variance = closing - expected;
  const status = variance===0 ? 'Balanced' : (variance>0 ? 'Over' : 'Short');

  // Mobile per channel
  const channels = ['Withdraw Cash','Buy Goods','Send Money'];
  const perChannel = channels.map(ch=>{
    const inflowSales = sales.filter(s=>s.method===ch).reduce((a,b)=>a+(+b.amount||0),0);
    const expOnCh = expenses.filter(e=>e.method===ch).reduce((a,b)=>a+(+b.amount||0),0);
    // Opening/Closing/OutflowWithdrawn are user inputs (optional) stored in ledger/<date>.json
    const ledger = readJSON(P('ledger', `${d}.json`), []);
    const row = ledger.find(x=>x.Channel===ch) || { OpeningBalance:0, OutflowWithdrawn:0, ClosingBalanceActual:null };
    const expectedClosing = row.OpeningBalance + inflowSales - row.OutflowWithdrawn - expOnCh;
    const closingActual = row.ClosingBalanceActual;
    const mv = (closingActual==null) ? null : (closingActual - expectedClosing);
    return {
      channel: ch,
      opening: row.OpeningBalance||0,
      inflowSales, expOnCh,
      outflowWithdrawn: row.OutflowWithdrawn||0,
      expectedClosing, closingActual,
      variance: mv
    };
  });

  res.json({
    date:d,
    cash: { opening, cashSales, creditCash, cashExp, wdToCash, expected, closing, variance, status },
    mobile: perChannel
  });
});

// Save/update Mobile Money Ledger inputs
app.post('/api/mobile/ledger', (req,res)=>{
  const { date, Channel, OpeningBalance=0, OutflowWithdrawn=0, ClosingBalanceActual=null, Note='' } = req.body || {};
  if (!Channel) return res.status(400).send('Channel required');
  const d = toDay(date);
  const fp = P('ledger', `${d}.json`);
  const arr = readJSON(fp, []);
  const idx = arr.findIndex(x=>x.Channel===Channel);
  const row = { LedgerID: uid('led'), Channel, Date:d, OpeningBalance:+OpeningBalance, OutflowWithdrawn:+OutflowWithdrawn, ClosingBalanceActual: (ClosingBalanceActual==null? null : +ClosingBalanceActual), Note: Note||'' };
  if (idx>=0){ arr[idx] = { ...arr[idx], ...row }; } else { arr.push(row); }
  writeJSON(fp, arr);
  appendRow('MobileLedger',['ts','date','channel','opening','outflow_withdrawn','closing_actual','note'],
    [new Date().toISOString(), d, Channel, row.OpeningBalance, row.OutflowWithdrawn, row.ClosingBalanceActual==null?'':row.ClosingBalanceActual, row.Note||'']);
  io.emit('data:changed', { bucket:'ledger', file:`ledger/${d}.json`, at:Date.now() });
  res.json({ ok:true, row });
});

// Aging report (0–7 / 8–14 / 15–30 / 30+)
app.get('/api/reports/aging-credit', (req,res)=>{
  const buckets = { '0-7':0, '8-14':0, '15-30':0, '30+':0 };
  const todayD = new Date(toDay(req.query.date));
  const dir = P('credit');
  const list = [];
  fs.readdirSync(dir).filter(f=>f.endsWith('.json')).forEach(f=>{
    const customer = f.replace(/\.json$/,'');
    const rows = readJSON(path.join(dir,f));
    const purchase = rows.filter(r=>r.type==='purchase').reduce((a,b)=>a+(+b.amount||0),0);
    const payment  = rows.filter(r=>r.type==='payment').reduce((a,b)=>a+(+b.amount||0),0);
    const bal = purchase - payment;
    if (bal>0){
      // age = days since last purchase with positive outstanding
      const lastP = rows.filter(r=>r.type==='purchase').map(r=>new Date(r.date)).sort((a,b)=>b-a)[0] || todayD;
      const days = Math.floor((todayD - lastP)/(86400000));
      let key = days<=7 ? '0-7' : (days<=14 ? '8-14' : (days<=30 ? '15-30' : '30+'));
      buckets[key] += bal;
      list.push({ customer, balance: bal, days });
    }
  });
  res.json({ date: toDay(req.query.date), buckets, list: list.sort((a,b)=>b.balance-a.balance) });
});

// ======= Export CSV/XLSX/PDF =======
function sendCSV(res, filename, header, rows) {
  const csv = [header.join(','), ...rows.map(r => header.map(h => (r[h] ?? '')).join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
}

// day CSV
app.get('/api/export/csv/sales', (req, res) => {
  const d = toDay(req.query.date);
  const rows = readJSON(P('sales', `${d}.json`)).map(r => ({ date:r.date, amount:r.amount, method:r.method, note:r.note||'' }));
  sendCSV(res, `sales-${d}.csv`, ['date','amount','method','note'], rows);
});
app.get('/api/export/csv/expenses', (req, res) => {
  const d = toDay(req.query.date);
  const rows = readJSON(P('expenses', `${d}.json`)).map(r => ({ date:r.date, amount:r.amount, category:r.category||'', method:r.method||'', note:r.note||'' }));
  sendCSV(res, `expenses-${d}.csv`, ['date','amount','category','method','note'], rows);
});
app.get('/api/export/csv/cash', (req, res) => {
  const d = toDay(req.query.date);
  const rows = readJSON(P('cashcount', `${d}.json`)).map(r => ({ date:r.date, session:r.Session, total:r.CashTotal, note:r.Note||'', denominations: JSON.stringify(r.denominations||{}) }));
  sendCSV(res, `cash-${d}.csv`, ['date','session','total','note','denominations'], rows);
});

// range CSV (filtered sales)
app.get('/api/export/csv/sales-filter', (req, res) => {
  const { from, to, method, min, max, q } = req.query;
  const F = from || to || today(); const T = to || from || today();
  const files = listDates(F, T).map(d => P('sales', `${d}.json`));
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

// XLSX & PDF (daily)
async function fetchDaily(d){
  const sales = readJSON(P('sales', `${d}.json`));
  const expenses = readJSON(P('expenses', `${d}.json`));
  const cashcount = readJSON(P('cashcount', `${d}.json`));
  const salesTotal = sum(sales, 'amount');
  const expensesTotal = sum(expenses, 'amount');
  const profit = salesTotal - expensesTotal;
  const cm = (cashcount.find(x=>String(x.Session).toLowerCase()==='morning')||{}).CashTotal || 0;
  const ce = (cashcount.find(x=>String(x.Session).toLowerCase()==='evening')||{}).CashTotal || 0;
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
  const filePath = P('exports', `daily-${d}.xlsx`);
  await wb.xlsx.writeFile(filePath);
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition',`attachment; filename="daily-${d}.xlsx"`);
  fs.createReadStream(filePath).pipe(res);
});
app.get('/api/export/pdf/daily', async (req, res) => {
  const d = toDay(req.query.date);
  const r = await fetchDaily(d);
  const filePath = P('exports', `daily-${d}.pdf`);
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

// ===== Meta (LAN) =====
app.get('/api/meta/lan', (req, res) => {
  const envPort = process.env.PORT || '3000';
  const portNum = parseInt(envPort, 10);
  const ip = getLocalIP() || 'localhost';
  res.json({ ip, port: portNum, url:`http://${ip}:${portNum}` });
});

// ===== Realtime (file watcher) =====
const watcher = chokidar.watch([P('sales'), P('expenses'), P('cashcount'), P('credit'), P('orders'), P('withdraw'), P('ledger')], { ignoreInitial:true, depth:3 });
watcher.on('all', (_, filePath) => {
  try {
    const rel = path.relative(DATA_DIR, filePath).replace(/\\/g,'/');
    const bucket = rel.split('/')[0];
    io.emit('data:changed', { bucket, file: rel, at: Date.now() });
  } catch(e){ console.error('watcher error', e); }
});
io.on('connection', () => console.log('Realtime client connected'));

// Hardening
process.on('unhandledRejection', err => console.error('UNHANDLED REJECTION:', err));
process.on('uncaughtException', err => console.error('UNCAUGHT EXCEPTION:', err));

// ===== Start =====
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
server.listen(PORT, HOST, () => {
  const ip = getLocalIP();
  console.log(`Server running on http://localhost:${PORT}`);
  if (ip) console.log(`LAN:   http://${ip}:${PORT}`);
});