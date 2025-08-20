// server.js — Zaad Bakery (Render-ready, Pro + Order Payments + Expense Receipt)
const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const cors = require('cors');
const multer = require('multer');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = require('socket.io')(server, { cors: { origin: '*' } });

// ---------- Config ----------
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const DATA_DIR = path.join(__dirname, 'data');
const FILES = {
  sales: path.join(DATA_DIR, 'sales.jsonl'),
  expenses: path.join(DATA_DIR, 'expenses.jsonl'),
  credits: path.join(DATA_DIR, 'credits.jsonl'),
  credit_payments: path.join(DATA_DIR, 'credit_payments.jsonl'),
  orders: path.join(DATA_DIR, 'orders.jsonl'),
  orders_status: path.join(DATA_DIR, 'orders_status.jsonl'),
  orders_payments: path.join(DATA_DIR, 'orders_payments.jsonl'),
  cash: path.join(DATA_DIR, 'cash.jsonl'),
};

// uploads dir (for expense receipts)
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');

// ---------- Helpers ----------
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  for (const p of Object.values(FILES)) {
    if (!fs.existsSync(p)) fs.writeFileSync(p, '');
  }
}
function todayISO(d = new Date()) { return new Date(d).toISOString().slice(0,10); }
function parseToISO(input) {
  if (!input) return todayISO();
  if (typeof input === 'string') {
    if (input.includes('/')) { const [dd,mm,yyyy]=input.split('/'); return `${yyyy}-${mm.padStart(2,'0')}-${dd.padStart(2,'0')}`; }
    return input.slice(0,10);
  }
  return todayISO(input);
}
function newId(){ return (Date.now().toString(36) + Math.random().toString(36).slice(2,6)).toUpperCase(); }

async function appendRecord(type, obj) {
  const file = FILES[type]; if (!file) throw new Error('Unknown type');
  const line = JSON.stringify(obj) + '\n'; await fsp.appendFile(file, line, 'utf8');
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
  const session  = q.session || null;
  return rows.filter(r=>{
    const d = r.dateISO || r.date || todayISO();
    if (from && d < from) return false;
    if (to && d > to) return false;
    if (method && (r.method !== method && r.payment !== method)) return false;
    if (customer && (r.customer || r.client || '').toLowerCase() !== customer.toLowerCase()) return false;
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

// ---------- Middleware ----------
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// file uploads (for expenses)
const upload = multer({ dest: UPLOAD_DIR });

// Basic Auth (optional via env)
function basicAuth(req,res,next){
  const u=process.env.PUBLIC_AUTH_USER, p=process.env.PUBLIC_AUTH_PASS;
  if(!u||!p) return next();
  const hdr=req.headers.authorization||''; const [type,val]=hdr.split(' ');
  if(type==='Basic'&&val){ const [user,pass]=Buffer.from(val,'base64').toString().split(':'); if(user===u&&pass===p) return next(); }
  res.set('WWW-Authenticate','Basic realm="Zaad Bakery"'); return res.status(401).send('Authentication required');
}
app.use(basicAuth);

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
    await appendRecord(type, record);
    io.emit('new-record', { type, record });
    res.json({ ok:true, type, record });
  }catch(err){ console.error(err); res.status(500).json({ ok:false, error:err.message }); }
};

// ===== Sales =====
const addSale = handleAdd('sales', b=>({
  product: b.product||'',
  quantity: Number(b.quantity||1),   // لن تُستخدم حالياً في الواجهة
  unitPrice: Number(b.unitPrice||0),
  amount: Number(b.amount || b.total || (Number(b.quantity||1)*Number(b.unitPrice||0)) || 0),
  method: b.method || b.payment || 'Cash',
  note: b.note||'',
  tillNumber: b.tillNumber || ''
}));
app.post('/api/sales/add', addSale);
app.post('/save-sale', addSale);

// ===== Expenses (with optional receipt image) =====
app.post('/api/expenses/add', upload.single('receipt'), async (req,res)=>{
  try{
    const b=req.body||{}; const now=new Date();
    const record = {
      id: newId(),
      dateISO: parseToISO(b.date),
      createdAt: now.toISOString(),
      item: b.item||b.name||'',
      amount: Number(b.amount||0),
      method: b.method||b.payment||'Cash',
      note: b.note||'',
      receiptPath: req.file ? '/uploads/'+req.file.filename : ''
    };
    await appendRecord('expenses', record);
    io.emit('new-record', { type:'expenses', record });
    res.json({ ok:true, record });
  }catch(err){ console.error(err); res.status(500).json({ ok:false, error:err.message }); }
});
app.post('/save-expense', handleAdd('expenses', b=>({
  item: b.item||b.name||'',
  amount: Number(b.amount||0),
  method: b.method||b.payment||'Cash',
  note: b.note||'',
})));

// ===== Credits & Payments =====
const addCredit = handleAdd('credits', b=>{
  const paid=Number(b.paid||0), amount=Number(b.amount||0);
  return { customer:b.customer||b.name||'', item:b.item||'', amount, paid, remaining:Math.max(0, amount-paid), note:b.note||'', paymentDateISO: b.paymentDate?parseToISO(b.paymentDate):'' };
});
app.post('/api/credits/add', addCredit);
app.post('/save-credit', addCredit);
const addCreditPayment = handleAdd('credit_payments', b=>({
  customer: b.customer||'',
  paid: Number(b.paid||b.amount||0),
  note: b.note||'',
}));
app.post('/api/credits/pay', addCreditPayment);

// ===== Orders & Status =====
const addOrder = handleAdd('orders', b=>{
  const paid=Number(b.paid||0), amount=Number(b.amount||0);
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

// update order status
app.post('/api/orders/status', async (req,res)=>{
  try{
    const { id, status } = req.body||{};
    if(!id || !status) return res.status(400).json({ ok:false, error:'id & status required' });
    const rec = { id, status, dateISO: todayISO(), createdAt: new Date().toISOString() };
    await appendRecord('orders_status', rec);
    io.emit('new-record', { type:'orders_status', record: rec });
    res.json({ ok:true, record: rec });
  }catch(err){ res.status(500).json({ ok:false, error: err.message }); }
});

// record order payment (adds to sales with note "from order")
app.post('/api/orders/pay', async (req,res)=>{
  try{
    const { id, amount, method='Cash', note='' } = req.body||{};
    const pay = Number(amount||0);
    if(!id || !(pay>0)) return res.status(400).json({ ok:false, error:'id and positive amount required' });

    const orders = await readAll('orders');
    const order  = orders.find(o=>o.id===id);
    if(!order) return res.status(404).json({ ok:false, error:'Order not found' });

    const prevPays = (await readAll('orders_payments')).filter(p=>p.id===id);
    const already = (order.paid||0) + prevPays.reduce((s,p)=>s+(+p.paid||+p.amount||0),0);
    const remaining = Math.max(0, (+order.amount||0) - already);
    if(remaining<=0) return res.status(400).json({ ok:false, error:'No remaining due' });
    if(pay>remaining) return res.status(400).json({ ok:false, error:'Amount exceeds remaining' });

    const nowISO = new Date().toISOString();
    const dateISO = todayISO();

    const payRec = { id, paid: pay, method, note, dateISO, createdAt: nowISO };
    await appendRecord('orders_payments', payRec);
    io.emit('new-record', { type:'orders_payments', record: payRec });

    // also add to sales
    const saleRec = {
      id: newId(), dateISO, createdAt: nowISO,
      product: order.item || 'Order',
      amount: pay, method,
      note: `from order ${order.phone||''} ${order.item||''}`.trim()
    };
    await appendRecord('sales', saleRec);
    io.emit('new-record', { type:'sales', record: saleRec });

    res.json({ ok:true, record: payRec, newSale: saleRec });
  }catch(err){ console.error(err); res.status(500).json({ ok:false, error: err.message }); }
});

// ---------- List / Export (orders merged with status & payments) ----------
app.get('/api/orders/list', async (req,res)=>{
  try{
    const base = filterByQuery(await readAll('orders'), req.query||{});
    const statusEv = await readAll('orders_status');
    const payEv    = await readAll('orders_payments');

    // latest status per id
    const latestStatus = new Map();
    for (const ev of statusEv) latestStatus.set(ev.id, ev.status);

    // sum payments per id
    const sumPays = new Map();
    for (const ev of payEv) sumPays.set(ev.id, (sumPays.get(ev.id)||0) + (+ev.paid||+ev.amount||0));

    const rows = base.map(r=>{
      const paidAll = (+r.paid||0) + (sumPays.get(r.id)||0);
      const remaining = Math.max(0, (+r.amount||0) - paidAll);
      return Object.assign({}, r, {
        status: latestStatus.get(r.id)||r.status||'Pending',
        paid: paidAll,
        remaining
      });
    });
    res.json({ ok:true, type:'orders', count: rows.length, rows });
  }catch(err){ res.status(500).json({ ok:false, error: err.message }); }
});

// generic lists
app.get('/api/:type/list', async (req,res)=>{
  try{
    const type=req.params.type;
    if (type==='orders') return; // handled above
    const rows = filterByQuery(await readAll(type), req.query||{});
    res.json({ ok:true, type, count: rows.length, rows });
  }catch(err){ res.status(500).json({ ok:false, error: err.message }); }
});

// CSV export
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

// PDF daily report
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

    const sCash = sumBy(sales, r=>/cash/i.test(r.method)?+r.amount:0);
    const sTill = sumBy(sales, r=>/till/i.test(r.method)?+r.amount:0);
    const sWith = sumBy(sales, r=>/withdraw/i.test(r.method)?+r.amount:0);
    const sSend = sumBy(sales, r=>/send/i.test(r.method)?+r.amount:0);
    const expTot = sumBy(expenses, r=>+r.amount);
    const crGross = sumBy(credits, r=>+r.amount - (+r.paid||0));
    const crPays  = sumBy(payments, r=>+r.paid);
    const crOutstanding = crGross - crPays;
    const morning = sumBy(cash.filter(x=>x.session==='morning'), r=>+r.total);
    const evening = sumBy(cash.filter(x=>x.session==='evening'), r=>+r.total);
    const eod     = sumBy(cash.filter(x=>x.session==='eod'),     r=>+r.total);
    const expected = morning + sCash - expTot;
    const diff = expected - evening;
    const carry = Math.max(0, evening - eod);

    res.setHeader('Content-Type','application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="zaad-report-${from}_${to}.pdf"`);
    const doc = new PDFDocument({ margin: 40 });
    doc.pipe(res);
    doc.fontSize(18).text('Zaad Bakery — Daily Report', {align:'center'}).moveDown(0.5);
    doc.fontSize(11).text(`Range: ${from} to ${to}`).moveDown();

    const lines = [
      ['Sales (Cash)', sCash], ['Sales (Till No)', sTill], ['Sales (Withdrawal)', sWith], ['Sales (Send Money)', sSend],
      ['Expenses', expTot], ['Credit Outstanding', crOutstanding], ['Orders Total', sumBy(orders, r=>+r.amount)],
      ['Cash Morning', morning], ['Cash Evening', evening], ['EOD Withdrawals', eod],
      ['Expected (evening)', expected], ['Difference', diff], ['Carry-over Next Day', carry]
    ];
    lines.forEach(([t,v])=> doc.text(`${t}: ${(+v).toFixed(2)}`));
    doc.moveDown().text('Generated by Zaad Bakery System', {align:'right', oblique:true});
    doc.end();
  }catch(err){ console.error(err); res.status(500).json({ ok:false, error: err.message }); }
});

// ---------- Boot ----------
ensureDataDir();
server.listen(PORT, HOST, ()=> console.log(`Server running on http://localhost:${PORT}`));