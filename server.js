// server.js — Zaad Bakery (Pro) + Order Payments + Expense Receipt + Invoice PDFs
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
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(PUBLIC_DIR, 'uploads');
const INVOICES_DIR = path.join(PUBLIC_DIR, 'invoices');

const FILES = {
  sales: path.join(DATA_DIR, 'sales.jsonl'),
  expenses: path.join(DATA_DIR, 'expenses.jsonl'),
  credits: path.join(DATA_DIR, 'credits.jsonl'),
  credit_payments: path.join(DATA_DIR, 'credit_payments.jsonl'),
  orders: path.join(DATA_DIR, 'orders.jsonl'),
  orders_status: path.join(DATA_DIR, 'orders_status.jsonl'),
  orders_payments: path.join(DATA_DIR, 'orders_payments.jsonl'),
  cash: path.join(DATA_DIR, 'cash.jsonl'),
  invoices: path.join(DATA_DIR, 'invoices.jsonl'),
};

// ---------- Helpers ----------
function ensureDataDir() {
  [DATA_DIR, PUBLIC_DIR, UPLOAD_DIR, INVOICES_DIR].forEach(d=>{
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });
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
  await fsp.appendFile(file, JSON.stringify(obj) + '\n', 'utf8');
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
app.use(express.static(PUBLIC_DIR, {
  etag:false,lastModified:false,
  setHeaders:(res,fp)=>{ if (fp.endsWith('index.html')) res.setHeader('Cache-Control','no-store'); }
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
  quantity: Number(b.quantity||1),
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

// ---------- Orders list (merge status & payments) ----------
app.get('/api/orders/list', async (req,res)=>{
  try{
    const base = filterByQuery(await readAll('orders'), req.query||{});
    const statusEv = await readAll('orders_status');
    const payEv    = await readAll('orders_payments');

    const latestStatus = new Map();
    for (const ev of statusEv) latestStatus.set(ev.id, ev.status);

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

// ---------- Generic lists / CSV ----------
app.get('/api/:type/list', async (req,res)=>{
  try{
    const type=req.params.type;
    if (type==='orders') return;
    const rows = filterByQuery(await readAll(type), req.query||{});
    res.json({ ok:true, type, count: rows.length, rows });
  }catch(err){ res.status(500).json({ ok:false, error: err.message }); }
});
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

// ---------- Reports PDF ----------
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

// ---------- Invoices (Create PDF + WhatsApp link) ----------
app.post('/api/invoices/create', async (req,res)=>{
  try{
    const PDFDocument = require('pdfkit');

    const id = (req.body.id && String(req.body.id).startsWith('INV-')) ? req.body.id : ('INV-' + newId());
    const clientPhone = (req.body.clientPhone||'').trim();
    const clientName  = (req.body.clientName||'').trim();
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (items.length === 0) return res.status(400).json({ ok:false, error:'Items required' });

    const dateISO = todayISO();
    const total = items.reduce((s,x)=> s + (Number(x.price||0)*Number(x.qty||0)), 0);

    // Save record
    const rec = { id, dateISO, clientPhone, clientName, items, total, createdAt: new Date().toISOString() };
    await appendRecord('invoices', rec);

    // Prepare PDF
    const filePath = path.join(INVOICES_DIR, `${id}.pdf`);
    const publicUrl = `/invoices/${id}.pdf`;
    const absBase = (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.get('host');
    const absUrl  = absBase + publicUrl;

    const brand = '#7a4b2b', brand2='#c89a58';
    const doc = new PDFDocument({ margin: 40 });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    // Header
    doc.rect(40, 40, doc.page.width-80, 70).fill(brand);
    try { doc.image(path.join(PUBLIC_DIR,'img','zaad-logo.jpeg'), 50, 50, {width:48}); } catch {}
    doc.fillColor('white').fontSize(20).text('Zaad Bakery', 110, 55);
    doc.fontSize(12).text(`Invoice ${id}`, 110, 80);
    doc.text(`Date: ${dateISO}`, doc.page.width-200, 55, {width:160, align:'right'});
    if (clientPhone) doc.text(`Client: ${clientName||''} ${clientPhone}`, doc.page.width-200, 75, {width:160, align:'right'});

    doc.moveDown(2);
    doc.fillColor('black');

    // Table headers
    const startY = 130;
    doc.fontSize(12).fillColor(brand)
      .text('Product', 50, startY)
      .text('Unit',    300, startY, {width:80, align:'right'})
      .text('Qty',     390, startY, {width:60, align:'right'})
      .text('Total',   460, startY, {width:100, align:'right'});
    doc.moveTo(40, startY+18).lineTo(doc.page.width-40, startY+18).strokeColor(brand2).stroke();

    // Rows
    let y = startY+28; doc.fillColor('black');
    items.forEach(it=>{
      const lineTotal = Number(it.price||0)*Number(it.qty||0);
      doc.text(String(it.name||''), 50, y, {width:230});
      doc.text((+it.price||0).toFixed(2), 300, y, {width:80, align:'right'});
      doc.text((+it.qty||0),              390, y, {width:60, align:'right'});
      doc.text(lineTotal.toFixed(2),      460, y, {width:100, align:'right'});
      y += 22;
    });
    doc.moveTo(40, y+4).lineTo(doc.page.width-40, y+4).strokeColor('#ddd').stroke();

    // Total box
    y += 14;
    doc.roundedRect(doc.page.width-220, y, 180, 70, 8).strokeColor(brand2).stroke();
    doc.fontSize(12).fillColor('#666').text('Total', doc.page.width-210, y+10);
    doc.fontSize(18).fillColor(brand).text(total.toFixed(2), doc.page.width-210, y+30);

    // Thank you
    doc.fillColor('#666').fontSize(11).text('Thank you for choosing Zaad Bakery! We appreciate your business.', 50, y+90, {width:doc.page.width-100, align:'center'});

    doc.end();

    await new Promise((resolve,reject)=>{
      stream.on('finish', resolve); stream.on('error', reject);
    });

    // WhatsApp link
    const digits = (clientPhone || '').replace(/[^\d]/g,''); // intl format without +
    const message = `Hello${clientName? ' '+clientName: ''}! Here is your invoice ${id} (${dateISO}) from Zaad Bakery. Thank you for your business. ${absUrl}`;
    const waLink = digits ? `https://wa.me/${digits}?text=${encodeURIComponent(message)}` : `https://wa.me/?text=${encodeURIComponent(message)}`;

    res.json({ ok:true, id, url: publicUrl, absoluteUrl: absUrl, waLink });
  }catch(err){
    console.error(err);
    res.status(500).json({ ok:false, error: err.message });
  }
});

// ---------- Boot ----------
ensureDataDir();
server.listen(PORT, HOST, ()=> console.log(`Server running on http://localhost:${PORT}`));