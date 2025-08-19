// server.js — Zaad Bakery (Render-ready, fixed handlers)
const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const cors = require('cors');
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
  orders: path.join(DATA_DIR, 'orders.jsonl'),
  cash: path.join(DATA_DIR, 'cash.jsonl'),
};

// ---------- Helpers ----------
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const p of Object.values(FILES)) {
    if (!fs.existsSync(p)) fs.writeFileSync(p, '');
  }
}

function todayISO(d = new Date()) {
  return new Date(d).toISOString().slice(0, 10); // YYYY-MM-DD
}

function parseToISO(input) {
  if (!input) return todayISO();
  if (typeof input === 'string') {
    if (input.includes('/')) {
      const [dd, mm, yyyy] = input.split('/');
      return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
    }
    return input.slice(0, 10);
  }
  return todayISO(input);
}

async function appendRecord(type, obj) {
  const file = FILES[type];
  if (!file) throw new Error('Unknown type');
  const line = JSON.stringify(obj) + '\n';
  await fsp.appendFile(file, line, 'utf8');
}

async function readAll(type) {
  const file = FILES[type];
  if (!file) throw new Error('Unknown type');
  if (!fs.existsSync(file)) return [];
  const raw = await fsp.readFile(file, 'utf8');
  if (!raw.trim()) return [];
  return raw
    .split('\n')
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function filterByQuery(rows, q) {
  const from = q.from ? parseToISO(q.from) : null;
  const to = q.to ? parseToISO(q.to) : null;
  const method = q.method || q.payment || null;
  const customer = q.customer || q.name || null;

  return rows.filter(r => {
    const d = r.dateISO || r.date || todayISO();
    if (from && d < from) return false;
    if (to && d > to) return false;
    if (method && (r.method !== method && r.payment !== method)) return false;
    if (customer && (r.customer || r.client || '').toLowerCase() !== customer.toLowerCase()) return false;
    return true;
  });
}

function toCSV(rows) {
  if (!rows.length) return 'empty\n';
  const headers = Array.from(
    rows.reduce((set, obj) => { Object.keys(obj).forEach(k => set.add(k)); return set; }, new Set())
  );
  const escape = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [
    headers.join(','),
    ...rows.map(r => headers.map(h => escape(r[h])).join(','))
  ];
  return lines.join('\n');
}

// ---------- Middleware ----------
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Basic Auth اختياري من env
function basicAuth(req, res, next) {
  const u = process.env.PUBLIC_AUTH_USER;
  const p = process.env.PUBLIC_AUTH_PASS;
  if (!u || !p) return next();
  const hdr = req.headers.authorization || '';
  const [type, val] = hdr.split(' ');
  if (type === 'Basic' && val) {
    const [user, pass] = Buffer.from(val, 'base64').toString().split(':');
    if (user === u && pass === p) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Zaad Bakery"');
  return res.status(401).send('Authentication required');
}
app.use(basicAuth);

// Static
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Socket.IO ----------
io.on('connection', () => console.log('Realtime client connected'));

// ---------- Generic add handler ----------
const handleAdd = (type, mapper) => async (req, res) => {
  try {
    const body = req.body || {};
    const now = new Date();
    const base = {
      dateISO: parseToISO(body.date),
      createdAt: now.toISOString(),
    };
    const record = Object.assign(base, mapper(body));
    await appendRecord(type, record);
    io.emit('new-record', { type, record });
    res.json({ ok: true, type, record });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
};

// ===== Sales =====
const addSale = handleAdd('sales', (b) => ({
  amount: Number(b.amount || b.total || (Number(b.quantity || 1) * Number(b.unitPrice || 0)) || 0),
  method: b.method || b.payment || 'Cash',
  note: b.note || '',
}));
app.post('/api/sales/add', addSale);
// توافق مع المسار القديم
app.post('/save-sale', addSale);

// ===== Expenses =====
const addExpense = handleAdd('expenses', (b) => ({
  item: b.item || b.name || '',
  amount: Number(b.amount || 0),
  method: b.method || b.payment || 'Cash',
  note: b.note || '',
}));
app.post('/api/expenses/add', addExpense);
app.post('/save-expense', addExpense);

// ===== Credits =====
const addCredit = handleAdd('credits', (b) => {
  const paid = Number(b.paid || 0);
  const amount = Number(b.amount || 0);
  return {
    customer: b.customer || b.name || '',
    item: b.item || '',
    amount,
    paid,
    remaining: Math.max(0, amount - paid),
    note: b.note || '',
    paymentDateISO: b.paymentDate ? parseToISO(b.paymentDate) : '',
  };
});
app.post('/api/credits/add', addCredit);
app.post('/save-credit', addCredit);

// ===== Orders =====
const addOrder = handleAdd('orders', (b) => {
  const paid = Number(b.paid || 0);
  const amount = Number(b.amount || 0);
  return {
    phone: b.phone || b.clientPhone || '',
    item: b.item || b.product || '',
    amount,
    paid,
    remaining: Math.max(0, amount - paid),
    note: b.note || '',
  };
});
app.post('/api/orders/add', addOrder);
app.post('/save-order', addOrder);

// ===== Cash (morning/evening) =====
const addCash = handleAdd('cash', (b) => ({
  session: b.session || b.time || 'morning',
  breakdown: b.breakdown || {},
  total: Number(b.total || 0),
  note: b.note || '',
}));
app.post('/api/cash/add', addCash);
app.post('/save-cash', addCash);

// ---------- List / Export ----------
app.get('/api/:type/list', async (req, res) => {
  try {
    const type = req.params.type;
    const rows = await readAll(type);
    res.json({ ok: true, type, count: rows.length, rows: filterByQuery(rows, req.query || {}) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/load', async (req, res) => {
  try {
    const type = (req.query.type || '').toLowerCase();
    const rows = await readAll(type);
    res.json({ ok: true, type, count: rows.length, rows: filterByQuery(rows, req.query || {}) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/:type/export', async (req, res) => {
  try {
    const type = req.params.type;
    const rows = filterByQuery(await readAll(type), req.query || {});
    const csv = toCSV(rows);
    res.setHeader('Content-Disposition', `attachment; filename="${type}.csv"`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/export-csv', async (req, res) => {
  try {
    const type = (req.query.type || '').toLowerCase();
    const rows = filterByQuery(await readAll(type), req.query || {});
    const csv = toCSV(rows);
    res.setHeader('Content-Disposition', `attachment; filename="${type}.csv"`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- Boot ----------
ensureDataDir();
server.listen(PORT, HOST, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});