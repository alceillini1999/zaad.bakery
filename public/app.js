/* Zaad Bakery Pro Frontend */
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const api = (p, opts={}) => fetch(p, Object.assign({headers:{'Content-Type':'application/json'}}, opts)).then(r => r.json());
const today = () => new Date().toISOString().slice(0,10);
const toast = new bootstrap.Toast($('#appToast'), { delay: 1600 });
const showToast = (msg, ok=true) => {
  const t=$('#appToast'); t.classList.toggle('text-bg-success', ok); t.classList.toggle('text-bg-danger', !ok);
  t.querySelector('.toast-body').innerHTML=msg; toast.show();
};
const ioClient = io(); ioClient.on('new-record', ({type})=>{
  const active = document.querySelector('.tab-pane.active')?.id || '';
  if (active==='tabSales'   && (type==='sales')) loadSales();
  if (active==='tabExpenses'&& (type==='expenses')) loadExpenses();
  if (active==='tabCredit'  && (type==='credits' || type==='credit_payments')) loadCredit();
  if (active==='tabStaff' && (type==='employees' || type==='attendance' || type==='emp_purchases' || type==='emp_advances')) loadEmployees();
  if (active==='tabOrders'  && (type==='orders' || type==='orders_status' || type==='orders_payments' || type==='sales')) loadOrders();
  if (active==='tabCash'    && (type==='cash')) loadCash();
});
$('#themeSwitch')?.addEventListener('change',e=>document.documentElement.classList.toggle('dark', e.target.checked));
$('#btnShare')?.addEventListener('click', async ()=>{ try{ await navigator.clipboard.writeText(location.href); showToast('<i class="bi bi-clipboard-check"></i> Link copied'); }catch{ showToast('Copy failed',false);} });

function badgeFor(method){
  if (!method) return '';
  const m=(method+'').toLowerCase();
  if (m.includes('till')) return `<span class="badge badge-method badge-Till">Till No</span>`;
  if (m.includes('withdraw')) return `<span class="badge badge-method badge-Withdrawal">Withdrawal</span>`;
  if (m.includes('send')) return `<span class="badge badge-method badge-Send">Send</span>`;
  return `<span class="badge badge-method badge-Cash">Cash</span>`;
}


/* ---------- DUPLICATE GUARD (Modal Confirm) ---------- */
const DupGuard = (function(){
  const TTL_MS = 5*60*1000; // consider duplicates within 5 minutes
  function normText(v){ return String(v||'').trim().toLowerCase(); }
  function normNum(v){ const n = parseFloat(v||0); return isFinite(n) ? n.toFixed(2) : '0.00'; }
  function todayISO(){ return new Date().toISOString().slice(0,10); }
  function pick(obj, keys){ const o={}; keys.forEach(k=>o[k]=obj?.[k]); return o; }

  function sig(type, data){
    switch(type){
      case 'sale': {
        const d = pick(data, ['date','amount','method','note','customer']);
        return ['sale', normText(d.date||todayISO()), normNum(d.amount), normText(d.method||'cash'), normText(d.note||''), normText(d.customer||'')].join('|');
      }
      case 'expense': {
        const d = pick(data, ['date','item','amount','method','note','category']);
        return ['expense', normText(d.date||todayISO()), normText(d.item||''), normNum(d.amount), normText(d.method||'cash'), normText(d.note||''), normText(d.category||'')].join('|');
      }
      case 'order': {
        const d = pick(data, ['date','phone','item','amount','note','customer']);
        return ['order', normText(d.date||todayISO()), normText(d.phone||d.customer||''), normText(d.item||''), normNum(d.amount), normText(d.note||'')].join('|');
      }
      case 'orderPay': {
        const d = pick(data, ['id','amount','method']);
        return ['orderPay', normText(d.id||''), normNum(d.amount), normText(d.method||'cash')].join('|');
      }
      case 'credit': {
        const d = pick(data, ['date','customer','item','amount','note']);
        return ['credit', normText(d.date||todayISO()), normText(d.customer||''), normText(d.item||''), normNum(d.amount), normText(d.note||'')].join('|');
      }
      case 'creditPay': {
        const d = pick(data, ['customer','paid','amount','method','date']);
        const amt = d.paid ?? d.amount;
        return ['creditPay', normText(d.customer||''), normNum(amt), normText(d.method||'cash'), normText(d.date||todayISO())].join('|');
      }
      default: return JSON.stringify(data);
    }
  }

  function storageKey(type){ return `dup:last:${type}`; }
  function remember(type, data){
    try {
      const entry = { sig: sig(type, data), ts: Date.now() };
      localStorage.setItem(storageKey(type), JSON.stringify(entry));
    } catch {}
  }
  function isDuplicate(type, data){
    try {
      const raw = localStorage.getItem(storageKey(type));
      if(!raw) return false;
      const last = JSON.parse(raw);
      return last.sig === sig(type, data) && (Date.now() - (last.ts||0) < TTL_MS);
    } catch { return false; }
  }

  function ensureModal(){
    let el = document.getElementById('dupConfirmModal');
    if (el) return el;
    const html = document.createElement('div');
    html.innerHTML = `
<div class="modal fade" id="dupConfirmModal" tabindex="-1">
  <div class="modal-dialog modal-dialog-centered">
    <div class="modal-content">
      <div class="modal-header">
        <h6 class="modal-title">تأكيد التكرار</h6>
        <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
      </div>
      <div class="modal-body">
        <div class="alert alert-warning small">
          هذا القيّد يبدو مكرراً بنفس البيانات. هل تريد تسجيله مرة أخرى؟
        </div>
        <pre id="dupPreview" class="bg-light p-2 rounded small mb-0"></pre>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">لا</button>
        <button type="button" class="btn btn-primary" id="dupYesBtn">نعم، سجّل</button>
      </div>
    </div>
  </div>
</div>`;
    document.body.appendChild(html.firstElementChild);
    return document.getElementById('dupConfirmModal');
  }

  function toPreview(type, data){
    const entries = Object.entries(data).filter(([k,v])=> typeof v==='string' || typeof v==='number');
    const lines = entries.map(([k,v])=>`${k}: ${v}`);
    return (type.toUpperCase()) + '\\n' + lines.join('\\n');
  }

  async function confirm(type, data){
    if (!isDuplicate(type, data)) return true;
    const m = ensureModal();
    m.querySelector('#dupPreview').textContent = toPreview(type, data);
    const modal = new bootstrap.Modal(m);
    return await new Promise(resolve=>{
      const yes = m.querySelector('#dupYesBtn');
      const cleanup = ()=>{
        yes.removeEventListener('click', onYes);
        m.removeEventListener('hidden.bs.modal', onNo);
      };
      const onYes = ()=>{ cleanup(); modal.hide(); resolve(true); };
      const onNo  = ()=>{ cleanup(); resolve(false); };
      yes.addEventListener('click', onYes);
      m.addEventListener('hidden.bs.modal', onNo, { once:true });
      modal.show();
    });
  }

  async function checkAndConfirm(type, data){
    remember(type, data);
    return await confirm(type, data);
  }

  return { remember, confirm, checkAndConfirm, sig };
})();
/* ---------- SALES (بدون Product/Qty/Unit) ---------- */
async function loadSales(){
  const p=new URLSearchParams();
  if($('#salesFrom').value) p.set('from',$('#salesFrom').value);
  if($('#salesTo').value)   p.set('to',$('#salesTo').value);
  if($('#salesMethod').value) p.set('method',$('#salesMethod').value);
  const {rows=[]}=await api('/api/sales/list?'+p.toString());
  const tb=$('#tblSalesBody');
  if(!rows.length){ tb.innerHTML=`<tr><td colspan="4" class="text-secondary p-4">No data.</td></tr>`; return;}
  tb.innerHTML = rows.map(r=>`<tr>
      <td>${(r.dateISO||'').slice(0,10)}</td>
      <td class="text-end fw-semibold">${Number(r.amount||0).toFixed(2)}</td>
      <td>${badgeFor(r.method)}</td>
      <td>${r.note||''}</td>
    </tr>`).join('');
}
$('#btnSalesFilter')?.addEventListener('click', loadSales);
$('#btnSalesExport')?.addEventListener('click', (e)=>{
  e.target.href=`/api/sales/export?from=${$('#salesFrom').value||''}&to=${$('#salesTo').value||''}&method=${$('#salesMethod').value||''}`;
});
$('#formSale')?.addEventListener('submit', async e=>{
  e.preventDefault();
  const fd=new FormData(e.target); const body=Object.fromEntries(fd.entries());
  body.amount = Number(body.amount||0);
  if(!(body.amount>0)) return showToast('Enter amount', false);
  if(!(await DupGuard.checkAndConfirm('sale', body))) return; const res=await api('/api/sales/add',{method:'POST',body:JSON.stringify(body)});
  if(res.ok){ e.target.reset(); showToast('Sale saved'); loadSales(); } else showToast(res.error||'Failed',false);
});

/* ---------- EXPENSES (مع صورة) ---------- */
async function loadExpenses(){
  const {rows=[]}=await api('/api/expenses/list');
  const tb=$('#tblExpensesBody');
  if(!rows.length){ tb.innerHTML=`<tr><td colspan="6" class="text-secondary p-4">No data.</td></tr>`; return;}
  tb.innerHTML = rows.map(r=>`<tr>
    <td>${(r.dateISO||'').slice(0,10)}</td>
    <td>${r.item||''}</td>
    <td class="text-end">${Number(r.amount||0).toFixed(2)}</td>
    <td>${badgeFor(r.method)}</td>
    <td>${r.receiptPath?`<a href="${r.receiptPath}" target="_blank" class="btn btn-sm btn-outline-secondary">View</a>`:''}</td>
    <td>${r.note||''}</td>
  </tr>`).join('');
}
$('#formExpense')?.addEventListener('submit', async e=>{
  e.preventDefault();
  const form = e.target;
  const formData = new FormData(form); 
  const _data = { date: formData.get('date') || today(), item: formData.get('item') || '', amount: formData.get('amount') || formData.get('value') || '', method: formData.get('method') || 'Cash', note: formData.get('note') || '' };
  if(!(await DupGuard.checkAndConfirm('expense', _data))) return;
// يرسل ملف receipt إن وجد
  const res = await fetch('/api/expenses/add',{method:'POST', body: formData}).then(r=>r.json());
  if(res.ok){ form.reset(); showToast('Expense saved'); loadExpenses(); } else showToast(res.error||'Failed',false);
});

/* ---------- CREDIT + PAYMENTS ---------- */
async function loadCredit(){
  const [credits, payments] = await Promise.all([
    api('/api/credits/list'),
    api('/api/credits/payments/list')
  ]);
  // Safely extract rows from API responses (they return { rows: [...] })
  const rows = (credits && Array.isArray(credits.rows)) ? credits.rows : [];
  const pays = (payments && Array.isArray(payments.rows)) ? payments.rows : [];
  const tb=$('#tblCreditBody');
  if(!rows.length){ tb.innerHTML=`<tr><td colspan="7" class="text-secondary p-4">No data.</td></tr>`; return; }

  // جمع المدفوعات لكل عميل
  const paysBy = {};
  pays.forEach(p=>{ const k=(p.customer||'').trim(); paysBy[k]=(paysBy[k]||0)+(+p.paid||0); });

  tb.innerHTML = rows.map(r=>{
    const name = r.customer||'';
    const paidNow = (+r.paid||0) + (paysBy[name]||0);
    const remaining = Math.max(0,(+r.amount||0)-paidNow);
    return `<tr>
      <td>${(r.dateISO||'').slice(0,10)}</td>
      <td>${name}</td>
      <td>${r.item||''}</td>
      <td class="text-end">${Number(r.amount||0).toFixed(2)}</td>
      <td class="text-end">${Number(paidNow).toFixed(2)}</td>
      <td class="text-end fw-semibold">${Number(remaining).toFixed(2)}</td>
      <td><button class="btn btn-sm btn-outline-primary btnCrPay" data-name="${encodeURIComponent(name)}">Pay</button></td>
    </tr>`;
  }).join('');

  // زر دفع من الجدول
  $$('.btnCrPay').forEach(b=>{
    b.addEventListener('click', ()=>{
      const name=decodeURIComponent(b.dataset.name||'');
      const f=$('#formPay'); f.customer.value=name;
      // Ensure payment method field exists in the Credit Pay modal
      let _m = f.querySelector('[name="method"]');
      if(!_m){
        const block = document.createElement('div');
        block.innerHTML = `<div>
          <label class="form-label">Payment Method</label>
          <select class="form-select" name="method" required>
            <option>Cash</option>
            <option>Till No</option>
            <option>Withdrawal</option>
            <option>Send Money</option>
          </select>
        </div>`;
        const submitBtn = f.querySelector('button[type="submit"]');
        (submitBtn?.parentElement || f).insertBefore(block.firstElementChild, submitBtn || null);
        _m = f.querySelector('[name="method"]');
      }
      _m.value = 'Cash';

      new bootstrap.Modal($('#payModal')).show();
    });
  });
}
$('#formCredit')?.addEventListener('submit', async e=>{
  e.preventDefault();
  const body=Object.fromEntries(new FormData(e.target).entries());
  
  if(!(await DupGuard.checkAndConfirm('credit', body))) return;
const res=await api('/api/credits/add',{method:'POST',body:JSON.stringify(body)});
  if(res.ok){ e.target.reset(); showToast('Credit saved'); loadCredit(); } else showToast(res.error||'Failed',false);
});
$('#formPay')?.addEventListener('submit', async e=>{
  e.preventDefault();
  const body=Object.fromEntries(new FormData(e.target).entries());
  
  { const _amt = body.paid ?? body.amount ?? body.value; const _forSig = {customer: body.customer, paid: _amt, method: body.method, date: body.date||today()};
    if(!(await DupGuard.checkAndConfirm('creditPay', _forSig))) return;
  }
const res=await api('/api/credits/pay',{method:'POST',body:JSON.stringify(body)});
  if(res.ok){ e.target.reset(); bootstrap.Modal.getInstance($('#payModal'))?.hide(); showToast('Payment recorded'); loadCredit(); loadSales();
    document.querySelector('[data-bs-target="#tabSales"]')?.click(); } else showToast(res.error||'Failed',false);
});

/* ---------- ORDERS + STATUS + PAY + INVOICE ---------- */
const ORDER_FLOW=['Pending','In-Progress','Done','Delivered'];
async function loadOrders(){
  const {rows=[]}=await api('/api/orders/list');
  const statusFilter = $('#orStatusFilter').value;
  let list = rows;
  if (statusFilter) list = list.filter(r=> (r.status||'Pending')===statusFilter);
  const tb=$('#tblOrdersBody');
  if(!list.length){ tb.innerHTML=`<tr><td colspan="8" class="text-secondary p-4">No data.</td></tr>`; return;}

  tb.innerHTML = list.map(r=>{
    const next = ORDER_FLOW[(ORDER_FLOW.indexOf(r.status||'Pending')+1)%ORDER_FLOW.length];
    const q = new URLSearchParams({ phone: r.phone||'', item: r.item||'', price: r.amount||0 });
    return `<tr data-id="${r.id}" data-remaining="${Number(r.remaining||0).toFixed(2)}" data-phone="${r.phone||''}" data-item="${r.item||''}">
      <td>${(r.dateISO||'').slice(0,10)}</td>
      <td>${r.phone||''}</td>
      <td>${r.item||''}</td>
      <td class="text-end">${Number(r.amount||0).toFixed(2)}</td>
      <td class="text-end">${Number(r.paid||0).toFixed(2)}</td>
      <td class="text-end fw-semibold">${Number(r.remaining||0).toFixed(2)}</td>
      <td><span class="badge text-bg-${r.status==='Delivered'?'success':r.status==='Done'?'primary':r.status==='In-Progress'?'warning text-dark':'secondary'}">${r.status||'Pending'}</span></td>
      <td class="d-flex gap-1 flex-wrap">
        <button class="btn btn-sm btn-outline-secondary btnNext">Next → ${next}</button>
        <button class="btn btn-sm btn-outline-primary btnPay">Pay</button>
        <a class="btn btn-sm btn-outline-dark" href="/invoice.html?${q.toString()}" target="_blank"><i class="bi bi-whatsapp"></i> Invoice</a>
      </td>
    </tr>`;
  }).join('');

  // Next status
  $$('#tblOrdersBody .btnNext').forEach(btn=>{
    btn.addEventListener('click', async (ev)=>{
      const tr=ev.target.closest('tr'); const id=tr?.dataset.id; if(!id) return;
      const curr=tr.querySelector('td:nth-child(7) .badge')?.innerText||'Pending';
      const next=ORDER_FLOW[(ORDER_FLOW.indexOf(curr)+1)%ORDER_FLOW.length];
      const res=await api('/api/orders/status',{method:'POST', body:JSON.stringify({id, status: next})});
      if(res.ok){ showToast('Status updated'); loadOrders(); } else showToast(res.error||'Failed',false);
    });
  });

  // Pay button -> modal
  $$('#tblOrdersBody .btnPay').forEach(btn=>{
    btn.addEventListener('click', (ev)=>{
      const tr=ev.target.closest('tr');
      $('#opId').value = tr.dataset.id;
      $('#opPhone').value = tr.dataset.phone || '';
      $('#opItem').value = tr.dataset.item || '';
      $('#opRemaining').value = tr.dataset.remaining || '0.00';
      $('#opAmount').value = tr.dataset.remaining || '0.00';
      $('#opMethod').value = 'Cash';
      new bootstrap.Modal($('#orderPayModal')).show();
    });
  });
}
$('#orStatusFilter')?.addEventListener('change', loadOrders);

// submit order
$('#formOrder')?.addEventListener('submit', async e=>{
  e.preventDefault();
  const body=Object.fromEntries(new FormData(e.target).entries());
  
  if(!(await DupGuard.checkAndConfirm('order', body))) return;
const res=await api('/api/orders/add',{method:'POST',body:JSON.stringify(body)});
  if(res.ok){ e.target.reset(); showToast('Order saved'); loadOrders(); } else showToast(res.error||'Failed',false);
});

// order pay submit
$('#formOrderPay')?.addEventListener('submit', async e=>{
  e.preventDefault();
  const id=$('#opId').value, remain=parseFloat($('#opRemaining').value||'0'), amount=parseFloat($('#opAmount').value||'0');
  
  { const _forSig = { id, amount, method: $('#opMethod').value };
    if(!(await DupGuard.checkAndConfirm('orderPay', _forSig))) return;
  }
if(amount>remain){ return showToast('Amount exceeds remaining', false); }
  const method=$('#opMethod').value;
  const res=await api('/api/orders/pay',{method:'POST', body:JSON.stringify({id, amount, method})});
  if(res.ok){ bootstrap.Modal.getInstance($('#orderPayModal'))?.hide(); showToast('Order payment saved'); loadOrders(); loadSales();
  document.querySelector('[data-bs-target="#tabSales"]')?.click(); } else showToast(res.error||'Failed',false);
});

/* ---------- CASH COUNT ---------- */
const DEFAULT_DENOMS=[1000,500,200,100,50,40,20,10,5,1];
function loadDenoms(){
  const wrap = $('#denoms'); wrap.innerHTML='';
  DEFAULT_DENOMS.forEach(v=>{
    const id='d_'+v;
    wrap.insertAdjacentHTML('beforeend',`
      <div class="col-6 col-md-4">
        <label class="form-label small mb-1">${v}</label>
        <div class="input-group"><span class="input-group-text">Qty</span><input type="number" min="0" step="1" value="0" class="form-control" id="${id}"></div>
      </div>
    `);
    $('#'+id).addEventListener('input', updateCashTotal);
  });
  updateCashTotal();
}
function updateCashTotal(){
  let total=0; $$('input[id^="d_"]').forEach(i=>{
    const denom=parseInt(i.id.split('_')[1],10), qty=parseInt(i.value||'0',10);
    total += denom*qty;
  });
  $('#cashTotal').textContent=total.toFixed(2);
}
async function loadCash(){
  const {rows=[]}=await api('/api/cash/list');
  const tb=$('#tblCashBody');
  if(!rows.length){ tb.innerHTML=`<tr><td colspan="4" class="text-secondary p-4">No data.</td></tr>`; return;}
  tb.innerHTML = rows.map(r=>`<tr>
    <td>${(r.dateISO||'').slice(0,10)}</td>
    <td class="text-capitalize">${r.session||''}</td>
    <td class="text-end fw-semibold">${Number(r.total||0).toFixed(2)}</td>
    <td>${r.note||''}</td>
  </tr>`).join('');
}
$('#formCash')?.addEventListener('submit', async e=>{
  e.preventDefault();
  const fd=new FormData(e.target);
  const body={ breakdown:{} };
  body.session = fd.get('session')||'morning';
  body.note = $('#cashNote').value||'';
  $$('input[id^="d_"]').forEach(i=>{
    const denom=parseInt(i.id.split('_')[1],10), qty=parseInt(i.value||'0',10); body.breakdown[denom]=qty;
  });
  body.total=parseFloat($('#cashTotal').textContent||'0');
  const res=await api('/api/cash/add',{method:'POST',body:JSON.stringify(body)});
  if(res.ok){ showToast('Cash saved'); loadCash(); } else showToast(res.error||'Failed',false);
});

/* ---------- REPORTS + CHART ---------- */
let salesByMethodChart;
function drawSalesByMethod({cash, till, withdrawal, send}) {
  const ctx = document.getElementById('salesByMethodChart'); if(!ctx) return;
  const data=[cash,till,withdrawal,send].map(x=>+x||0);
  if(salesByMethodChart) salesByMethodChart.destroy();
  salesByMethodChart = new Chart(ctx, {
    type:'bar',
    data:{ labels:['Cash','Till No','Withdrawal','Send Money'], datasets:[{ label:'Sales (KES)', data }] },
    options:{ responsive:true, plugins:{legend:{display:false}}, scales:{y:{beginAtZero:true}} }
  });
}

async function runReport(){
  const q=new URLSearchParams();
  if($('#repFrom').value) q.set('from',$('#repFrom').value);
  if($('#repTo').value)   q.set('to',$('#repTo').value);

  const [s,e,c,o,k,p] = await Promise.all([
    api('/api/sales/list?'+q.toString()),
    api('/api/expenses/list?'+q.toString()),
    api('/api/credits/list?'+q.toString()),
    api('/api/orders/list?'+q.toString()),
    api('/api/cash/list?'+q.toString()),
    api('/api/credits/payments/list?'+q.toString()),
  ]);



  // Tolerant rows to avoid crashing when any endpoint returns an error
  // Each API result has a `.rows` array; fallback to an empty array if missing
  const sRows = (s && Array.isArray(s.rows)) ? s.rows : [];
  const eRows = (e && Array.isArray(e.rows)) ? e.rows : [];
  const cRows = (c && Array.isArray(c.rows)) ? c.rows : [];
  const oRows = (o && Array.isArray(o.rows)) ? o.rows : [];
  const kRows = (k && Array.isArray(k.rows)) ? k.rows : [];
  const pRows = (p && Array.isArray(p.rows)) ? p.rows : [];
  // Sales by method
  const sCash = sRows.reduce((a,r)=>a+(/cash/i.test(r.method)?+r.amount:0),0);
  const sTill = sRows.reduce((a,r)=>a+(/till/i.test(r.method)?+r.amount:0),0);
  const sWith = sRows.reduce((a,r)=>a+(/withdraw/i.test(r.method)?+r.amount:0),0);
  const sSend = sRows.reduce((a,r)=>a+(/send/i.test(r.method)?+r.amount:0),0);
const totalSales = sCash + sTill + sWith + sSend;

  // Expenses breakdown
  const expTot  = eRows.reduce((a,r)=>a+(+r.amount||0),0);
  const expCash = eRows.reduce((a,r)=>a+(/cash/i.test(r.method)?+r.amount:0),0);
  const expTill = eRows.reduce((a,r)=>a+(/till/i.test(r.method)?+r.amount:0),0);
  const expWith = eRows.reduce((a,r)=>a+(/withdraw/i.test(r.method)?+r.amount:0),0);
  const expSend = eRows.reduce((a,r)=>a+(/send/i.test(r.method)?+r.amount:0),0);

  // Credit outstanding
  const crGross = cRows.reduce((a,r)=>a+((+r.amount||0)-(+r.paid||0)),0);
  const crPays  = pRows.reduce((a,r)=>a+(+r.paid||0),0);
  const crOutstanding = crGross - crPays;

  // Cash counts
  const morning = kRows.filter(x=>x.session==='morning').reduce((a,r)=>a+(+r.total||0),0);
  const evening = kRows.filter(x=>x.session==='evening').reduce((a,r)=>a+(+r.total||0),0);

  // Outs
  const withdrawOut = kRows.filter(x=>x.session==='withdraw_out' || x.session==='eod').reduce((a,r)=>a+(+r.total||0),0);
  const tillOut     = kRows.filter(x=>x.session==='till_out').reduce((a,r)=>a+(+r.total||0),0);
  const sendOut     = kRows.filter(x=>x.session==='send_out').reduce((a,r)=>a+(+r.total||0),0);

  // Section 4: Cash available (correct formula)
  const cashAvailable = morning + sCash + withdrawOut - expTot; // per request: cash morning + cash sales + withdrawal-out - cash expenses

  // Next day morning (for single-day reports)
  // Normalize date inputs: convert DD/MM/YYYY to YYYY-MM-DD if needed
  function normalizeDate(val){
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(val)){
      const [dd, mm, yy] = val.split('/');
      return `${yy}-${mm}-${dd}`;
    }
    return val;
  }
  let rawFrom = $('#repFrom').value || today();
  let rawTo   = $('#repTo').value || rawFrom;
  const from = normalizeDate(rawFrom);
  const to   = normalizeDate(rawTo);
  // Compute next day's morning based on the day after the 'to' date (or 'from' if 'to' is empty).
  let nextMorning = 0;
  {
    const baseDate = to || from;
    const d = new Date(baseDate + 'T00:00:00');
    d.setDate(d.getDate() + 1);
    // Format date in YYYY-MM-DD for local timezone (avoid UTC offset)
    const next = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
    const kn = await api('/api/cash/list?from='+next+'&to='+next);
    const knRows = (kn && Array.isArray(kn.rows)) ? kn.rows : [];
    nextMorning = knRows.filter(x=>x.session==='morning').reduce((a,r)=>a+(+r.total||0),0);
  }

  // Manual cash_out for selected day (session='cash_out')
  let manualCashOut = 0;
  if (from===to){
    const kc = await api('/api/cash/list?from='+from+'&to='+from);
    const kcRows = (kc && Array.isArray(kc.rows)) ? kc.rows : [];
    manualCashOut = kcRows.filter(x=>x.session==='cash_out').reduce((a,r)=>a+(+r.total||0),0);
  }

  // Compute Cash Out based purely on cash difference (cash evening minus next morning)
  const computedCashOut = Math.max(0, evening - nextMorning);
  const cashOut = computedCashOut;

  // Remaining (carry to next day): difference between cash available and cash counted in the evening
  const remainingCarry = cashAvailable - evening;

  // Build 6 sections
  const sections = [
    { title: '1) Expenses', items: [['Expenses', expTot]] },
    { title: '2) Sales by Method', items: [['Sales (Cash)', sCash], ['Sales (Till No)', sTill], ['Sales (Send Money)', sSend], ['Sales (Withdrawal)', sWith]] },
    { title: '3) Cash Counts', items: [['Cash Morning', morning], ['Cash Evening', evening]] },
    { title: '4) Cash available in cashier', items: [['Cash available (computed)', cashAvailable]] },
    { title: '5) Outs', items: [['Cash Out (available - evening)', cashOut], ['Till No Out', tillOut], ['Withdrawal Out', withdrawOut], ['Send Money Out', sendOut]] },
    { title: '6) Remaining (carry to next day)', items: [['Cash available in cashier - Cash evening', remainingCarry]] },
    { title: '7) Total Sales', items: [['Total Sales', totalSales]] }
  ];

  $('#repCards').innerHTML = sections.map(sec => `
    <div class="col-12"><h5 class="mt-3 mb-2">${sec.title}</h5></div>
    ${sec.items.map(([t,v])=>`
      <div class="col-6 col-md-4 col-xl-3">
        <div class="card mini-stat"><div class="card-body">
          <div class="text-muted">${t}</div>
          <div class="fs-4 fw-semibold mt-1">${(+v).toFixed(2)}</div>
        </div></div>
      </div>
    `).join('')}
  `).join('');

  drawSalesByMethod({cash:sCash,till:sTill,withdrawal:sWith,send:sSend});
  $('#btnPDF').href = `/api/report/daily-pdf?from=${from}&to=${to}`;

  // Prefill & Save manual Cash Out UI
  }

$('#btnRunReport')?.addEventListener('click', runReport);


/* ---------- EMPLOYEES + ATTENDANCE ---------- */
async function loadEmployees(){
  const res = await api('/api/employees/list');
  const rows = (res && Array.isArray(res.rows)) ? res.rows : [];
  const tb = $('#tblEmployeesBody');
  if (tb){
    if (!rows.length) tb.innerHTML = `<tr><td colspan="3" class="text-secondary p-4">No data.</td></tr>`;
    else tb.innerHTML = rows.map(r=>`<tr><td>${r.name||''}</td><td>${r.phone||''}</td><td>${r.note||''}</td></tr>`).join('');
  }
  // fill selects
  const opts = rows.map(r=>`<option value="${(r.name||'').replace(/"/g,'&quot;')}">${r.name||''}</option>`).join('');
  ['attEmployee','purEmployee','advEmployee'].forEach(id=>{ const el=$('#'+id); if(el) el.innerHTML=opts; });
  // load attendance/purchases/advances tables
  const todayQ = new URLSearchParams({ from: today(), to: today() }).toString();
  const [att, pur, adv] = await Promise.all([
    api('/api/attendance/list?'+todayQ),
    api('/api/emp_purchases/list?'+todayQ),
    api('/api/emp_advances/list?'+todayQ),
  ]);
  const attRows = (att && Array.isArray(att.rows)) ? att.rows : [];
  const purRows = (pur && Array.isArray(pur.rows)) ? pur.rows : [];
  const advRows = (adv && Array.isArray(adv.rows)) ? adv.rows : [];
  const attTb = $('#tblAttendanceBody'); if(attTb){
    if (!attRows.length) attTb.innerHTML = `<tr><td colspan="4" class="text-secondary p-4">No data.</td></tr>`;
    else attTb.innerHTML = attRows.map(r=>`<tr><td>${(r.dateISO||'').slice(0,10)} ${(r.time||'').slice(11,16)}</td><td>${r.employee||''}</td><td>${r.action||''}</td><td>${r.note||''}</td></tr>`).join('');
  }
  const mixTb = $('#tblEmpTransBody'); if(mixTb){
    const mix = purRows.map(r=>({type:'Purchase', ...r})).concat(advRows.map(r=>({type:'Advance', ...r})));
    if (!mix.length) mixTb.innerHTML = `<tr><td colspan="5" class="text-secondary p-4">No data.</td></tr>`;
    else mixTb.innerHTML = mix.sort((a,b)=> (a.dateISO||'').localeCompare(b.dateISO||'')).map(r=>`<tr><td>${(r.dateISO||'').slice(0,10)}</td><td>${r.type}</td><td>${r.employee||''}</td><td class="text-end">${Number(r.amount||0).toFixed(2)}</td><td>${r.note||''}</td></tr>`).join('');
  }
}

// Form handlers
$('#formEmployee')?.addEventListener('submit', async (e)=>{
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target).entries());
  const res = await api('/api/employees/add',{ method:'POST', body: JSON.stringify(body) });
  if(res.ok){ showToast('Employee saved'); e.target.reset(); loadEmployees(); } else showToast(res.error||'Failed', false);
});

$('#formAttendance')?.addEventListener('submit', async (e)=>{
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target).entries());
  // add current time if not provided
  if(!body.time) body.time = new Date().toISOString();
  const res = await api('/api/attendance/add',{ method:'POST', body: JSON.stringify(body) });
  if(res.ok){ showToast('Attendance recorded'); e.target.reset(); loadEmployees(); } else showToast(res.error||'Failed', false);
});

$('#formEmpPurchase')?.addEventListener('submit', async (e)=>{
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target).entries());
  const res = await api('/api/emp_purchases/add',{ method:'POST', body: JSON.stringify(body) });
  if(res.ok){ showToast('Purchase saved'); e.target.reset(); loadEmployees(); } else showToast(res.error||'Failed', false);
});
$('#formEmpAdvance')?.addEventListener('submit', async (e)=>{
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target).entries());
  const res = await api('/api/emp_advances/add',{ method:'POST', body: JSON.stringify(body) });
  if(res.ok){ showToast('Advance saved'); e.target.reset(); loadEmployees(); } else showToast(res.error||'Failed', false);
});



// UI sanity check: ensure every nav target has a matching section
document.addEventListener('DOMContentLoaded', ()=>{
  $$('#mainNav [data-bs-target]').forEach(btn=>{
    const tgt = btn.getAttribute('data-bs-target');
    if (tgt && !document.querySelector(tgt)){
      console.warn('Missing section for', tgt);
      showToast('⚠️ Missing section for '+tgt, false);
    }
  });
});

/* ---------- Boot ---------- */
document.addEventListener('DOMContentLoaded', ()=>{
  // default dates
  ['salesFrom','salesTo','repFrom','repTo'].forEach(id=>{ if($('#'+id)) $('#'+id).value=today(); });
  loadDenoms();

  // load lists initially
  loadSales(); loadExpenses(); loadCredit(); loadOrders(); loadCash(); loadEmployees?.(); runReport?.();
});
$('#btnRunReport')?.addEventListener('click', runReport);


// Till No Out manual box handlers (Reports)
(function(){
  const input = $('#repTillOutInput'), btn = $('#btnSaveTillOut');
  if (!input || !btn) return;
  const from=$('#repFrom').value||today(), to=$('#repTo').value||from;
  // Only enabled for single day
  if (from!==to){ input.value=''; input.disabled=true; btn.disabled=true; input.placeholder='اختر يوم واحد'; return; }
  // Load existing till_out
  api('/api/cash/list?from='+from+'&to='+from).then(kc=>{
    const rows = (kc && Array.isArray(kc.rows)) ? kc.rows : [];
    const existing = rows.filter(x=>x.session==='till_out').reduce((a,r)=>a+(+r.total||0),0);
    if (existing>0) input.value = existing.toFixed(2);
  });
  btn.onclick = async ()=>{
    const val = +($('#repTillOutInput').value||0);
    if (!(val>=0)) return showToast('أدخل رقم صالح', false);
    await api('/api/cash/add',{ method:'POST', body: JSON.stringify({ date: from, session:'till_out', total: val, note:'report till out' }) });
    showToast('Till Out saved'); runReport();
  };
})();



// Quick Outs (Manual) on Cash tab
$('#btnCashOutSave')?.addEventListener('click', async ()=>{
  const val = +($('#cashOutInput').value||0); if (!(val>=0)) return showToast('أدخل رقم صالح', false);
  await api('/api/cash/add',{ method:'POST', body: JSON.stringify({ date: today(), session:'cash_out', total: val, note:'cash tab manual' }) });
  showToast('Cash Out saved'); $('#cashOutInput').value=''; runReport?.(); loadCash?.(); 
});
$('#btnTillOutSave')?.addEventListener('click', async ()=>{
  const val = +($('#tillOutInput').value||0); if (!(val>=0)) return showToast('أدخل رقم صالح', false);
  await api('/api/cash/add',{ method:'POST', body: JSON.stringify({ date: today(), session:'till_out', total: val, note:'cash tab manual' }) });
  showToast('Till No Out saved'); $('#tillOutInput').value=''; runReport?.(); loadCash?.();
});
$('#btnSendOutSave')?.addEventListener('click', async ()=>{
  const val = +($('#sendOutInput').value||0); if (!(val>=0)) return showToast('أدخل رقم صالح', false);
  await api('/api/cash/add',{ method:'POST', body: JSON.stringify({ date: today(), session:'send_out', total: val, note:'cash tab manual' }) });
  showToast('Send Money Out saved'); $('#sendOutInput').value=''; runReport?.(); loadCash?.();
});

// --- Manual Amount mode for Till/Send on Cash tab ---
function updateCashTotalManual(){
  const v = parseFloat($('#manualOut')?.value || '0') || 0;
  $('#cashTotal').textContent = v.toFixed(2);
}
function toggleCashMode(){
  const s = document.querySelector('input[name="session"]:checked')?.value || 'morning';
  const denoms = $('#denoms'), man = $('#manualOutWrap');
  if (!denoms || !man) return;
  if (s==='till_out' || s==='send_out'){
    denoms.classList.add('d-none'); man.classList.remove('d-none');
    updateCashTotalManual();
  } else {
    man.classList.add('d-none'); denoms.classList.remove('d-none');
    updateCashTotal();
  }
}
// listeners
document.addEventListener('DOMContentLoaded', ()=>{
  $$('input[name="session"]').forEach(r=> r.addEventListener('change', toggleCashMode));
  $('#manualOut')?.addEventListener('input', updateCashTotalManual);
  toggleCashMode();
});

