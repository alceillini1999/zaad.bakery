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
};

// ---------- Helpers ----------
function ensureDirs() {
  fs.mkdirSync(DATA_DIR,    { recursive: true });
  fs.mkdirSync(UPLOAD_DIR,  { recursive: true });
  fs.mkdirSync(INVOICE_DIR, { recursive: true });
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
    if (customer && (r.customer || r.client || '').toLowerCase() !== (customer||'').toLowerCase()) return false;
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
  // الواجهة الآن لا ترسل منتج/كمية/سعر وحدة — لا مشكلة لو كانت فارغة
  product: b.product||'',
  quantity: Number(b.quantity||0),
  unitPrice: Number(b.unitPrice||0),
  amount: Number(b.amount || b.total || 0),
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
      item: b.item||b.name||'',
      amount: Number(b.amount||0),
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
const addCredit = handleAdd('credits', b=>{
  const paid=Number(b.paid||0), amount=Number(b.amount||0);
  return { customer:b.customer||b.name||'', item:b.item||'', amount, paid, remaining:Math.max(0, amount-paid), note:b.note||'', paymentDateISO: b.paymentDate?parseToISO(b.paymentDate):'' };
});
app.post('/api/credits/add', addCredit);
app.post('/save-credit', addCredit);

// credit payment (reduces outstanding)
const addCreditPayment = handleAdd('credit_payments', b=>({
  customer: b.customer||'',
  paid: Number(b.paid||b.amount||0),
  note: b.note||'',
}));
app.post('/api/credits/pay', addCreditPayment);
app.get('/api/credits/payments/list', async (req,res)=>{
  try{
    const rows = filterByQuery(await readAll('credit_payments'), req.query||{});
    res.json({ ok:true, type:'credit_payments', count: rows.length, rows });
  }catch(err){ res.status(500).json({ ok:false, error: err.message }); }
});

// ===== Orders, Status & Payments =====
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

// update order status (append event)
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

// pay part of an order (creates orders_payments + a sales entry "from order")
app.post('/api/orders/pay', async (req,res)=>{
  try{
    const { id, amount, method } = req.body||{};
    const amt = Number(amount||0);
    if(!id || !(amt>0)) return res.status(400).json({ ok:false, error:'id & positive amount required' });

    // find base order and current paid
    const orders = await readAll('orders');
    const base = orders.find(o=>o.id===id);
    if(!base) return res.status(404).json({ ok:false, error:'order not found' });

    const payEvents = await readAll('orders_payments');
    const alreadyPaid = payEvents.filter(p=>p.orderId===id).reduce((a,p)=>a+(+p.amount||0), (+base.paid||0));
    const remaining = Math.max(0, (+base.amount||0) - alreadyPaid);
    if(amt > remaining) return res.status(400).json({ ok:false, error:'amount exceeds remaining' });

    // append orders_payments
    const payRec = {
      id: newId(),
      orderId: id,
      amount: amt,
      method: method || 'Cash',
      dateISO: todayISO(),
      createdAt: new Date().toISOString()
    };
    await appendRecord('orders_payments', payRec);
    io.emit('new-record', { type:'orders_payments', record: payRec });

    // create sales entry
    const saleRec = {
      id: newId(),
      dateISO: todayISO(),
      createdAt: new Date().toISOString(),
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

// orders list: join with latest status + payments to compute paid/remaining
app.get('/api/orders/list', async (req,res)=>{
  try{
    const base = filterByQuery(await readAll('orders'), req.query||{});
    const statusEv = await readAll('orders_status');
    const payments = await readAll('orders_payments');

    const latestStatus = new Map();
    for (const ev of statusEv) latestStatus.set(ev.id, ev.status);

    const paidMap = new Map();
    for (const p of payments) paidMap.set(p.orderId, (paidMap.get(p.orderId)||0) + (+p.amount||0));

    const rows = base.map(r=>{
      const paidExtra = paidMap.get(r.id)||0;
      const paid = (+r.paid||0) + paidExtra;
      const remaining = Math.max(0, (+r.amount||0) - paid);
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
      session: b.session || 'morning', // 'morning' | 'evening' | 'eod'
      breakdown: b.breakdown || {},
      total: Number(b.total||0),
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
      ['Expected (evening)', expected], ['Difference', diff]
    ];
    lines.forEach(([t,v])=> doc.text(`${t}: ${(+v).toFixed(2)}`));
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

    // generate
    const doc = new PDFDocument({ margin: 36 });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    // Header
    doc.fontSize(18).text('Zaad Bakery — Invoice', {align:'center'}).moveDown(0.5);
    doc.fontSize(11).text(`Invoice ID: ${invId}`);
    doc.text(`Date: ${todayISO()}`);
    if(clientName)  doc.text(`Client: ${clientName}`);
    if(clientPhone) doc.text(`Phone: ${clientPhone}`);
    doc.moveDown();

    // Table
    doc.fontSize(12);
    doc.text('Items:', {underline:true});
    doc.moveDown(0.3);
    let sub=0;
    items.forEach((it,idx)=>{
      const name = (it.name||'').toString();
      const price= +it.price||0;
      const qty  = +it.qty||0;
      const line = price*qty;
      sub += line;
      doc.text(`${idx+1}. ${name} — ${price.toFixed(2)} x ${qty} = ${line.toFixed(2)}`);
    });
    doc.moveDown();
    doc.fontSize(14).text(`Total: ${sub.toFixed(2)}`, {align:'right'}).moveDown();

    // Footer / Thanks
    doc.fontSize(11).text('Thank you for your purchase! We appreciate your business.', {align:'center'});
    doc.end();

    await new Promise((ok,fail)=>{ stream.on('finish',ok); stream.on('error',fail); });

    // Build absolute URL + WhatsApp link
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

// ---------- Boot ----------
ensureDirs();
server.listen(PORT, HOST, ()=> {
  console.log(`Server running on http://localhost:${PORT}`);
});