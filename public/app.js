/* Zaad Bakery Frontend (Bootstrap UI) */
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
const api = (p, opts={}) => fetch(p, Object.assign({headers:{'Content-Type':'application/json'}}, opts)).then(r => r.json());
const today = () => new Date().toISOString().slice(0,10);

const toast = new bootstrap.Toast($('#appToast'), { delay: 1600 });
const showToast = (msg, ok=true) => {
  const t = $('#appToast');
  t.classList.toggle('text-bg-success', ok);
  t.classList.toggle('text-bg-danger', !ok);
  t.querySelector('.toast-body').innerHTML = msg;
  toast.show();
};

const ioClient = io();
ioClient.on('connect', ()=>console.log('socket connected'));
ioClient.on('new-record', ({type})=>{
  // refresh the active tab list only
  const active = $('.tab-pane.active')?.id || '';
  if (active === 'tabSales' && type==='sales') loadSales();
  if (active === 'tabExpenses' && type==='expenses') loadExpenses();
  if (active === 'tabCredit' && type==='credits') loadCredit();
  if (active === 'tabOrders' && type==='orders') loadOrders();
  if (active === 'tabCash' && type==='cash') loadCash();
});

// Theme switch
$('#themeSwitch')?.addEventListener('change', (e)=>{
  document.documentElement.classList.toggle('dark', e.target.checked);
});

$('#btnShare')?.addEventListener('click', async ()=>{
  try {
    await navigator.clipboard.writeText(location.href);
    showToast('<i class="bi bi-clipboard-check"></i> Link copied');
  } catch {
    showToast('Copy failed', false);
  }
});

/* -------- SALES -------- */
function badgeFor(method){
  if (!method) return '';
  const m = (method+'').toLowerCase();
  if (m.includes('till')) return `<span class="badge badge-method badge-Till">Till No</span>`;
  if (m.includes('withdraw')) return `<span class="badge badge-method badge-Withdrawal">Withdrawal</span>`;
  if (m.includes('send')) return `<span class="badge badge-method badge-Send">Send</span>`;
  return `<span class="badge badge-method badge-Cash">Cash</span>`;
}

async function loadSales(){
  const params = new URLSearchParams();
  if ($('#salesFrom').value) params.set('from',$('#salesFrom').value);
  if ($('#salesTo').value) params.set('to',$('#salesTo').value);
  if ($('#salesMethod').value) params.set('method',$('#salesMethod').value);
  const {rows=[]} = await api(`/api/sales/list?${params.toString()}`);
  const tb = $('#tblSalesBody');
  if (!rows.length){ tb.innerHTML = `<tr><td colspan="7" class="text-secondary p-4">No data.</td></tr>`; return; }
  tb.innerHTML = rows.map(r=>{
    const qty = r.quantity || '';
    const unit = r.unitPrice ? Number(r.unitPrice).toFixed(2) : '';
    return `<tr>
      <td>${(r.dateISO||'').slice(0,10)}</td>
      <td>${r.product||''}</td>
      <td class="text-end">${qty}</td>
      <td class="text-end">${unit}</td>
      <td class="text-end fw-semibold">${Number(r.amount||0).toFixed(2)}</td>
      <td>${badgeFor(r.method)}</td>
      <td>${r.note||''}</td>
    </tr>`;
  }).join('');
}

$('#formSale')?.addEventListener('input', (e)=>{
  if (['quantity','unitPrice','amount'].includes(e.target.name)){
    const q = parseFloat($('#formSale [name="quantity"]').value||'0');
    const u = parseFloat($('#formSale [name="unitPrice"]').value||'0');
    const a = $('#formSale [name="amount"]').value;
    if (!a) $('#formSale [name="amount"]').value = (q*u||0).toFixed(2);
  }
});

$('#formSale')?.addEventListener('submit', async (e)=>{
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = Object.fromEntries(fd.entries());
  // keep qty/unit in record too (optional)
  body.quantity = Number(body.quantity||1);
  body.unitPrice = Number(body.unitPrice||0);
  if (!body.amount || Number(body.amount)===0) body.amount = (body.quantity*body.unitPrice).toFixed(2);
  const res = await api('/api/sales/add', {method:'POST', body:JSON.stringify(body)});
  if (res.ok){ e.target.reset(); showToast('Sale saved'); loadSales(); } else showToast(res.error||'Failed', false);
});

$('#btnSalesFilter')?.addEventListener('click', loadSales);
$('#btnSalesExport')?.addEventListener('click', (e)=>{
  e.target.href = `/api/sales/export?from=${$('#salesFrom').value||''}&to=${$('#salesTo').value||''}&method=${$('#salesMethod').value||''}`;
});

/* -------- EXPENSES -------- */
async function loadExpenses(){
  const {rows=[]} = await api('/api/expenses/list');
  const tb = $('#tblExpensesBody');
  if (!rows.length){ tb.innerHTML = `<tr><td colspan="5" class="text-secondary p-4">No data.</td></tr>`; return; }
  tb.innerHTML = rows.map(r=>`<tr>
    <td>${(r.dateISO||'').slice(0,10)}</td>
    <td>${r.item||''}</td>
    <td class="text-end">${Number(r.amount||0).toFixed(2)}</td>
    <td>${badgeFor(r.method)}</td>
    <td>${r.note||''}</td>
  </tr>`).join('');
}
$('#formExpense')?.addEventListener('submit', async (e)=>{
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target).entries());
  const res = await api('/api/expenses/add', {method:'POST', body:JSON.stringify(body)});
  if (res.ok){ e.target.reset(); showToast('Expense saved'); loadExpenses(); } else showToast(res.error||'Failed', false);
});

/* -------- CREDIT -------- */
async function loadCredit(){
  const {rows=[]} = await api('/api/credits/list');
  const tb = $('#tblCreditBody');
  if (!rows.length){ tb.innerHTML = `<tr><td colspan="7" class="text-secondary p-4">No data.</td></tr>`; return; }
  tb.innerHTML = rows.map(r=>`<tr>
    <td>${(r.dateISO||'').slice(0,10)}</td>
    <td>${r.customer||''}</td>
    <td>${r.item||''}</td>
    <td class="text-end">${Number(r.amount||0).toFixed(2)}</td>
    <td class="text-end">${Number(r.paid||0).toFixed(2)}</td>
    <td class="text-end fw-semibold">${Number(r.remaining||0).toFixed(2)}</td>
    <td>${r.note||''}</td>
  </tr>`).join('');
}
$('#formCredit')?.addEventListener('submit', async (e)=>{
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target).entries());
  const res = await api('/api/credits/add', {method:'POST', body:JSON.stringify(body)});
  if (res.ok){ e.target.reset(); showToast('Credit saved'); loadCredit(); } else showToast(res.error||'Failed', false);
});

/* -------- ORDERS -------- */
async function loadOrders(){
  const {rows=[]} = await api('/api/orders/list');
  const tb = $('#tblOrdersBody');
  if (!rows.length){ tb.innerHTML = `<tr><td colspan="7" class="text-secondary p-4">No data.</td></tr>`; return; }
  tb.innerHTML = rows.map(r=>`<tr>
    <td>${(r.dateISO||'').slice(0,10)}</td>
    <td>${r.phone||''}</td>
    <td>${r.item||''}</td>
    <td class="text-end">${Number(r.amount||0).toFixed(2)}</td>
    <td class="text-end">${Number(r.paid||0).toFixed(2)}</td>
    <td class="text-end fw-semibold">${Number(r.remaining||0).toFixed(2)}</td>
    <td>${r.note||''}</td>
  </tr>`).join('');
}
$('#formOrder')?.addEventListener('submit', async (e)=>{
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target).entries());
  const res = await api('/api/orders/add', {method:'POST', body:JSON.stringify(body)});
  if (res.ok){ e.target.reset(); showToast('Order saved'); loadOrders(); } else showToast(res.error||'Failed', false);
});

/* -------- CASH COUNT -------- */
const DENOMS = [1000,500,200,100,50,40,20,10,5,1];
function buildDenoms(){
  const wrap = $('#denoms'); wrap.innerHTML = '';
  DENOMS.forEach(v=>{
    const id = `d_${v}`;
    wrap.insertAdjacentHTML('beforeend', `
      <div class="col-6">
        <label class="form-label small mb-1">${v}</label>
        <div class="input-group">
          <span class="input-group-text">Qty</span>
          <input type="number" min="0" step="1" value="0" class="form-control" id="${id}">
        </div>
      </div>
    `);
    $('#'+id).addEventListener('input', updateCashTotal);
  });
}
function updateCashTotal(){
  let total = 0;
  DENOMS.forEach(v => total += v * parseInt($('#d_'+v).value||'0',10));
  $('#cashTotal').textContent = total.toFixed(2);
}
async function loadCash(){
  const {rows=[]} = await api('/api/cash/list');
  const tb = $('#tblCashBody');
  if (!rows.length){ tb.innerHTML = `<tr><td colspan="4" class="text-secondary p-4">No data.</td></tr>`; return; }
  tb.innerHTML = rows.map(r=>`<tr>
    <td>${(r.dateISO||'').slice(0,10)}</td>
    <td class="text-capitalize">${r.session||''}</td>
    <td class="text-end fw-semibold">${Number(r.total||0).toFixed(2)}</td>
    <td>${r.note||''}</td>
  </tr>`).join('');
}
$('#formCash')?.addEventListener('submit', async (e)=>{
  e.preventDefault();
  const body = { breakdown:{} };
  const fd = new FormData(e.target);
  body.session = fd.get('session') || 'morning';
  DENOMS.forEach(v => body.breakdown[v] = parseInt($('#d_'+v).value||'0',10));
  body.total = parseFloat($('#cashTotal').textContent || '0');
  const res = await api('/api/cash/add', {method:'POST', body:JSON.stringify(body)});
  if (res.ok){ showToast('Cash saved'); loadCash(); } else showToast(res.error||'Failed', false);
});

/* -------- REPORTS (quick) -------- */
async function runReport(){
  const q = new URLSearchParams();
  if ($('#repFrom').value) q.set('from',$('#repFrom').value);
  if ($('#repTo').value) q.set('to',$('#repTo').value);

  const [sales, exp, cred, orders, cash] = await Promise.all([
    api('/api/sales/list?'+q.toString()),
    api('/api/expenses/list?'+q.toString()),
    api('/api/credits/list?'+q.toString()),
    api('/api/orders/list?'+q.toString()),
    api('/api/cash/list?'+q.toString()),
  ]);

  const sCash = sumBy(sales.rows, r=>r.method==='Cash'?+r.amount:0);
  const sTill = sumBy(sales.rows, r=>/till/i.test(r.method)?+r.amount:0);
  const sWith = sumBy(sales.rows, r=>/withdraw/i.test(r.method)?+r.amount:0);
  const sSend = sumBy(sales.rows, r=>/send/i.test(r.method)?+r.amount:0);
  const expTotal = sumBy(exp.rows, r=>+r.amount);
  const creditTotal = sumBy(cred.rows, r=>+r.amount);
  const orderTotal = sumBy(orders.rows, r=>+r.amount);
  const cashMorning = sumBy(cash.rows.filter(r=>r.session==='morning'), r=>+r.total);
  const cashEvening = sumBy(cash.rows.filter(r=>r.session==='evening'), r=>+r.total);
  const diff = (cashMorning + sCash - expTotal - cashEvening);

  const cards = [
    ['Sales (Cash)', sCash], ['Sales (Till No)', sTill],
    ['Sales (Withdrawal)', sWith], ['Sales (Send Money)', sSend],
    ['Expenses', expTotal], ['Credit Total', creditTotal],
    ['Orders Total', orderTotal], ['Cash Morning', cashMorning],
    ['Cash Evening', cashEvening], ['Difference', diff]
  ];

  $('#repCards').innerHTML = cards.map(([t,v])=>`
    <div class="col-6 col-md-4 col-xl-3">
      <div class="card mini-stat">
        <div class="card-body">
          <div class="text-secondary small">${t}</div>
          <div class="fs-4 fw-semibold mt-1">${(+v).toFixed(2)}</div>
        </div>
      </div>
    </div>
  `).join('');
}
const sumBy = (arr, fn) => arr.reduce((s,x)=>s+(+fn(x)||0),0);
$('#btnRunReport')?.addEventListener('click', runReport);

/* -------- boot -------- */
function boot(){
  $('#salesFrom').value = $('#salesTo').value = today();
  $('#repFrom').value = $('#repTo').value = today();
  buildDenoms(); updateCashTotal();

  loadSales(); loadExpenses(); loadCredit(); loadOrders(); loadCash(); runReport();
}
document.addEventListener('DOMContentLoaded', boot);