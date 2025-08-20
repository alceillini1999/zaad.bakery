/* Zaad Bakery Pro Frontend (orders payment enabled) */
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const api = (p, opts={}) => fetch(p, Object.assign({headers:{'Content-Type':'application/json'}}, opts)).then(r => r.json());
const today = () => new Date().toISOString().slice(0,10);

const toast = new bootstrap.Toast($('#appToast'), { delay: 1600 });
const showToast = (msg, ok=true) => {
  const t=$('#appToast'); t.classList.toggle('text-bg-success', ok); t.classList.toggle('text-bg-danger', !ok);
  t.querySelector('.toast-body').innerHTML=msg; toast.show();
};

const ioClient = io();
ioClient.on('new-record', ({type})=>{
  const active = document.querySelector('.tab-pane.active')?.id || '';
  if (active==='tabSales'   && type==='sales') loadSales();
  if (active==='tabExpenses'&& type==='expenses') loadExpenses();
  if (active==='tabCredit'  && (type==='credits' || type==='credit_payments')) loadCredit();
  if (active==='tabOrders'  && (type==='orders'  || type==='orders_status' || type==='orders_payments')) loadOrders();
  if (active==='tabCash'    && type==='cash') loadCash();
});

$('#themeSwitch')?.addEventListener('change',e=>document.documentElement.classList.toggle('dark', e.target.checked));
$('#btnShare')?.addEventListener('click', async ()=>{ try{ await navigator.clipboard.writeText(location.href); showToast('<i class="bi bi-clipboard-check"></i> Link copied'); }catch{ showToast('Copy failed',false);} });

/* Helpers */
function badgeFor(method){
  if (!method) return '';
  const m=(method+'').toLowerCase();
  if (m.includes('till')) return `<span class="badge badge-method badge-Till">Till No</span>`;
  if (m.includes('withdraw')) return `<span class="badge badge-method badge-Withdrawal">Withdrawal</span>`;
  if (m.includes('send')) return `<span class="badge badge-method badge-Send">Send</span>`;
  return `<span class="badge badge-method badge-Cash">Cash</span>`;
}
function tableFilter(input, tbody){
  input?.addEventListener('input', ()=>{
    const q=input.value.toLowerCase().trim();
    $$(tbody+' tr').forEach(tr=>{ tr.style.display = tr.innerText.toLowerCase().includes(q)? '' : 'none'; });
  });
}
function enableSort(sel){
  const table=$(sel); if(!table || !table.tHead) return;
  const ths=[...table.tHead.rows[0].cells];
  ths.forEach((th,i)=>{
    const type=th.dataset.sort||'text';
    th.addEventListener('click', ()=>{
      const dir = th.classList.contains('sorted-asc')? 'desc':'asc';
      ths.forEach(h=>h.classList.remove('sorted-asc','sorted-desc'));
      th.classList.add(dir==='asc'?'sorted-asc':'sorted-desc');
      const rows = [...table.tBodies[0].rows];
      const val = r => r.cells[i].innerText.trim();
      rows.sort((a,b)=>{
        const va=val(a), vb=val(b);
        if(type==='num') return (+va||0)-(+vb||0);
        if(type==='date') return va.localeCompare(vb);
        return va.localeCompare(vb);
      });
      if(dir==='desc') rows.reverse();
      rows.forEach(r=>table.tBodies[0].appendChild(r));
    });
  });
}

/* ================= SALES ================= */
function bindSaleCalc(){
  $('#formSale')?.addEventListener('input', (e)=>{
    if (['unitPrice','amount'].includes(e.target.name)){
      const u=parseFloat($('#formSale [name="unitPrice"]').value||'0');
      const a=$('#formSale [name="amount"]').value;
      if(!a) $('#formSale [name="amount"]').value=(u||0).toFixed(2);
    }
  });
}
async function loadSales(){
  const p=new URLSearchParams();
  if($('#salesFrom').value) p.set('from',$('#salesFrom').value);
  if($('#salesTo').value)   p.set('to',$('#salesTo').value);
  if($('#salesMethod').value) p.set('method',$('#salesMethod').value);
  const {rows=[]}=await api('/api/sales/list?'+p.toString());
  const tb=$('#tblSalesBody');
  if(!rows.length){ tb.innerHTML=`<tr><td colspan="5" class="text-secondary p-4">No data.</td></tr>`; return;}
  tb.innerHTML = rows.map(r=>`
    <tr>
      <td>${(r.dateISO||'').slice(0,10)}</td>
      <td class="text-end">${r.unitPrice?Number(r.unitPrice).toFixed(2):''}</td>
      <td class="text-end fw-semibold">${Number(r.amount||0).toFixed(2)}</td>
      <td>${badgeFor(r.method)}</td>
      <td>${r.note||''}</td>
    </tr>
  `).join('');
}
$('#btnSalesFilter')?.addEventListener('click', loadSales);
tableFilter($('#salesSearch'), '#tblSalesBody');
$('#btnSalesExport')?.addEventListener('click', (e)=>{
  e.target.href=`/api/sales/export?from=${$('#salesFrom').value||''}&to=${$('#salesTo').value||''}&method=${$('#salesMethod').value||''}`;
});
$('#formSale')?.addEventListener('submit', async e=>{
  e.preventDefault();
  const fd=new FormData(e.target); const body=Object.fromEntries(fd.entries());
  body.unitPrice=Number(body.unitPrice||0);
  if(!body.amount || Number(body.amount)===0) body.amount=(body.unitPrice).toFixed(2);
  const res=await api('/api/sales/add',{method:'POST',body:JSON.stringify(body)});
  if(res.ok){ e.target.reset(); showToast('Sale saved'); loadSales(); } else showToast(res.error||'Failed',false);
});

/* ================= EXPENSES ================= */
async function loadExpenses(){
  const {rows=[]}=await api('/api/expenses/list');
  const tb=$('#tblExpensesBody');
  if(!rows.length){ tb.innerHTML=`<tr><td colspan="6" class="text-secondary p-4">No data.</td></tr>`; return;}
  tb.innerHTML = rows.map(r=>`
    <tr>
      <td>${(r.dateISO||'').slice(0,10)}</td>
      <td>${r.item||''}</td>
      <td class="text-end">${Number(r.amount||0).toFixed(2)}</td>
      <td>${badgeFor(r.method)}</td>
      <td>${r.note||''}</td>
      <td>${r.receiptPath? `<a href="${r.receiptPath}" target="_blank"><img src="${r.receiptPath}" alt="receipt" style="height:36px;border-radius:6px"/></a>` : ''}</td>
    </tr>
  `).join('');
}
tableFilter($('#expSearch'), '#tblExpensesBody');
$('#formExpense')?.addEventListener('submit', async e=>{
  e.preventDefault();
  const fd=new FormData(e.target); // contains file if chosen
  const res = await fetch('/api/expenses/add', { method:'POST', body: fd }).then(r=>r.json());
  if(res.ok){ e.target.reset(); showToast('Expense saved'); loadExpenses(); } else showToast(res.error||'Failed',false);
});

/* ================= CREDIT + PAYMENTS ================= */
async function loadCredit(){
  const [credits, payments] = await Promise.all([
    api('/api/credits/list'),
    api('/api/credits/payments/list')
  ]);
  const rows=credits.rows||[], pays=payments.rows||[];
  const tb=$('#tblCreditBody');
  if(!rows.length){ tb.innerHTML=`<tr><td colspan="7" class="text-secondary p-4">No data.</td></tr>`; }
  else {
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

  // Outstanding & Top 5
  const byCust = {};
  rows.forEach(r=>{
    const name=(r.customer||'').trim(); if(!name) return;
    if(!byCust[name]) byCust[name]={credit:0, pay:0};
    byCust[name].credit += (+r.amount||0) - (+r.paid||0);
  });
  pays.forEach(p=>{
    const name=(p.customer||'').trim(); if(!name) return;
    if(!byCust[name]) byCust[name]={credit:0, pay:0};
    byCust[name].pay += (+p.paid||0);
  });
  const arr = Object.entries(byCust).map(([name,v])=>({ name, outstanding: (v.credit - v.pay) }));
  arr.sort((a,b)=>b.outstanding-a.outstanding);
  const outstanding = arr.reduce((s,x)=>s+(x.outstanding>0?x.outstanding:0),0);
  $('#crOutstanding').textContent = outstanding.toFixed(2);
  $('#crTop5').innerHTML = arr.slice(0,5).map(x=>`<li>${x.name} — <strong>${x.outstanding.toFixed(2)}</strong></li>`).join('');
}
tableFilter($('#crSearch'), '#tblCreditBody');
$('#formCredit')?.addEventListener('submit', async e=>{
  e.preventDefault();
  const body=Object.fromEntries(new FormData(e.target).entries());
  const res=await api('/api/credits/add',{method:'POST',body:JSON.stringify(body)});
  if(res.ok){ e.target.reset(); showToast('Credit saved'); loadCredit(); } else showToast(res.error||'Failed',false);
});
$('#formPay')?.addEventListener('submit', async e=>{
  e.preventDefault();
  const body=Object.fromEntries(new FormData(e.target).entries());
  const res=await api('/api/credits/pay',{method:'POST',body:JSON.stringify(body)});
  if(res.ok){ e.target.reset(); bootstrap.Modal.getInstance($('#payModal'))?.hide(); showToast('Payment recorded'); loadCredit(); } else showToast(res.error||'Failed',false);
});

/* ================= ORDERS + STATUS + PAYMENTS ================= */
const ORDER_FLOW=['Pending','In-Progress','Done','Delivered'];
async function loadOrders(){
  const {rows=[]}=await api('/api/orders/list');
  const statusFilter = $('#orStatusFilter')?.value || '';
  const list = statusFilter ? rows.filter(r=> (r.status||'Pending')===statusFilter) : rows;
  const tb=$('#tblOrdersBody');
  if(!list.length){ tb.innerHTML=`<tr><td colspan="8" class="text-secondary p-4">No data.</td></tr>`; return;}
  tb.innerHTML = list.map(r=>{
    const next = ORDER_FLOW[(ORDER_FLOW.indexOf(r.status||'Pending')+1)%ORDER_FLOW.length];
    const canPay = (+r.remaining||0) > 0;
    return `<tr data-id="${r.id}" data-phone="${r.phone||''}" data-item="${r.item||''}" data-remaining="${Number(r.remaining||0).toFixed(2)}">
      <td>${(r.dateISO||'').slice(0,10)}</td>
      <td class="order-phone ${canPay?'text-primary':''}" style="cursor:${canPay?'pointer':'default'}">${r.phone||''}</td>
      <td>${r.item||''}</td>
      <td class="text-end">${Number(r.amount||0).toFixed(2)}</td>
      <td class="text-end">${Number(r.paid||0).toFixed(2)}</td>
      <td class="text-end fw-semibold">${Number(r.remaining||0).toFixed(2)}</td>
      <td><span class="badge text-bg-${r.status==='Delivered'?'success':r.status==='Done'?'primary':r.status==='In-Progress'?'warning text-dark':'secondary'}">${r.status||'Pending'}</span></td>
      <td class="d-flex gap-2">
        ${canPay?'<button class="btn btn-sm btn-primary btnOrderPay"><i class="bi bi-cash-coin"></i> Pay</button>':''}
        <button class="btn btn-sm btn-outline-secondary btnNext">Next → ${next}</button>
      </td>
    </tr>`;
  }).join('');

  // status next
  $$('#tblOrdersBody .btnNext').forEach(btn=>{
    btn.addEventListener('click', async (ev)=>{
      const tr=ev.target.closest('tr'); const id=tr?.dataset.id; if(!id) return;
      const curr=tr.querySelector('td:nth-child(7) .badge')?.innerText||'Pending';
      const next=ORDER_FLOW[(ORDER_FLOW.indexOf(curr)+1)%ORDER_FLOW.length];
      const res=await api('/api/orders/status',{method:'POST', body:JSON.stringify({id, status: next})});
      if(res.ok){ showToast('Status updated'); loadOrders(); } else showToast(res.error||'Failed',false);
    });
  });

  // open pay modal (click on phone OR Pay button)
  function openPayModal(tr){
    const id=tr.dataset.id, phone=tr.dataset.phone, item=tr.dataset.item, rem=parseFloat(tr.dataset.remaining||'0');
    if(rem<=0) return;
    const m=new bootstrap.Modal('#orderPayModal');
    $('#formOrderPay [name="id"]').value=id;
    $('#formOrderPay [name="phone"]').value=phone||'';
    $('#formOrderPay [name="item"]').value=item||'';
    $('#formOrderPay [name="remaining"]').value=rem.toFixed(2);
    const amt=$('#formOrderPay [name="amount"]'); amt.value=''; amt.max=rem.toFixed(2);
    m.show();
  }
  $$('#tblOrdersBody .btnOrderPay').forEach(b=>b.addEventListener('click',e=>openPayModal(e.target.closest('tr'))));
  $$('#tblOrdersBody .order-phone').forEach(td=>td.addEventListener('click',e=>openPayModal(e.target.closest('tr'))));
}
$('#orStatusFilter')?.addEventListener('change', loadOrders);

// submit order
$('#formOrder')?.addEventListener('submit', async e=>{
  e.preventDefault();
  const body=Object.fromEntries(new FormData(e.target).entries());
  const res=await api('/api/orders/add',{method:'POST',body:JSON.stringify(body)});
  if(res.ok){ e.target.reset(); showToast('Order saved'); loadOrders(); } else showToast(res.error||'Failed',false);
});

// submit order payment
$('#formOrderPay')?.addEventListener('submit', async e=>{
  e.preventDefault();
  const fd=new FormData(e.target);
  const id=fd.get('id');
  const remaining=parseFloat(fd.get('remaining')||'0');
  const amount=parseFloat(fd.get('amount')||'0');
  const method=fd.get('method')||'Cash';
  const note=fd.get('note')||'';
  if(amount<=0) return showToast('Amount must be > 0', false);
  if(amount>remaining) return showToast('Amount exceeds remaining', false);

  const res=await api('/api/orders/pay',{method:'POST', body:JSON.stringify({id, amount, method, note})});
  if(res.ok){
    bootstrap.Modal.getInstance($('#orderPayModal'))?.hide();
    showToast('Payment recorded from order');
    loadOrders();
    // لو تبويب المبيعات مفتوح، حدّثه
    if(document.querySelector('#tabSales.active')) loadSales();
  }else{
    showToast(res.error||'Failed', false);
  }
});

/* ================= CASH ================= */
const DEFAULT_DENOMS=[1000,500,200,100,50,40,20,10,5,1];
function loadDenoms(){
  const saved = localStorage.getItem('ZAAD_DENOMS');
  let denoms = saved ? JSON.parse(saved) : DEFAULT_DENOMS;
  const wrap = $('#denoms'); wrap.innerHTML='';
  denoms.forEach(v=>{
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
  let total=0;
  $$('input[id^="d_"]').forEach(i=>{
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
tableFilter($('#cashSearch'), '#tblCashBody');
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

/* ================= REPORTS ================= */
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
  const q=new URLSearchParams(); if($('#repFrom').value) q.set('from',$('#repFrom').value); if($('#repTo').value) q.set('to',$('#repTo').value);
  const [s,e,c,o,k,p] = await Promise.all([
    api('/api/sales/list?'+q.toString()),
    api('/api/expenses/list?'+q.toString()),
    api('/api/credits/list?'+q.toString()),
    api('/api/orders/list?'+q.toString()),
    api('/api/cash/list?'+q.toString()),
    api('/api/credits/payments/list?'+q.toString()),
  ]);
  const sCash = s.rows.reduce((a,r)=>a+(/cash/i.test(r.method)?+r.amount:0),0);
  const sTill = s.rows.reduce((a,r)=>a+(/till/i.test(r.method)?+r.amount:0),0);
  const sWith = s.rows.reduce((a,r)=>a+(/withdraw/i.test(r.method)?+r.amount:0),0);
  const sSend = s.rows.reduce((a,r)=>a+(/send/i.test(r.method)?+r.amount:0),0);
  const expTot = e.rows.reduce((a,r)=>a+(+r.amount||0),0);
  const crGross = c.rows.reduce((a,r)=>a+((+r.amount||0)-(+r.paid||0)),0);
  const crPays  = p.rows.reduce((a,r)=>a+(+r.paid||0),0);
  const crOutstanding = crGross - crPays;
  const morning = k.rows.filter(x=>x.session==='morning').reduce((a,r)=>a+(+r.total||0),0);
  const evening = k.rows.filter(x=>x.session==='evening').reduce((a,r)=>a+(+r.total||0),0);
  const eod     = k.rows.filter(x=>x.session==='eod').reduce((a,r)=>a+(+r.total||0),0);
  const expected = morning + sCash - expTot;
  const diff = expected - evening;
  const carry = Math.max(0, evening - eod);

  const cards = [
    ['Sales (Cash)', sCash], ['Sales (Till No)', sTill], ['Sales (Withdrawal)', sWith], ['Sales (Send Money)', sSend],
    ['Expenses', expTot], ['Credit Outstanding', crOutstanding],
    ['Orders Total', o.rows.reduce((a,r)=>a+(+r.amount||0),0)],
    ['Cash Morning', morning], ['Cash Evening', evening], ['EOD Withdrawals', eod],
    ['Expected (Evening)', expected], ['Difference', diff], ['Carry-over Next Day', carry]
  ];
  $('#repCards').innerHTML = cards.map(([t,v])=>`
    <div class="col-6 col-md-4 col-xl-3">
      <div class="card mini-stat"><div class="card-body"><div class="text-secondary small">${t}</div><div class="fs-4 fw-semibold mt-1">${(+v).toFixed(2)}</div></div></div>
    </div>
  `).join('');
  drawSalesByMethod({cash:sCash,till:sTill,withdrawal:sWith,send:sSend});

  const from=$('#repFrom').value||today(), to=$('#repTo').value||from;
  $('#btnPDF').href = `/api/report/daily-pdf?from=${from}&to=${to}`;
}

/* Shortcuts */
document.addEventListener('keydown', (e)=>{
  if(!e.altKey) return; const k=e.key.toLowerCase();
  if(k==='s'){ e.preventDefault(); $('#formSale button[type="submit"]')?.click(); }
  if(k==='e'){ e.preventDefault(); $('#formExpense button[type="submit"]')?.click(); }
  if(k==='c'){ e.preventDefault(); $('#formCash button[type="submit"]')?.click(); }
  if(k==='r'){ e.preventDefault(); $('#btnRunReport')?.click(); }
});

/* Boot */
function boot(){
  ['salesFrom','salesTo','repFrom','repTo'].forEach(id=>{ if($('#'+id)) $('#'+id).value=today(); });
  bindSaleCalc(); loadDenoms();
  loadSales(); loadExpenses(); loadCredit(); loadOrders(); loadCash(); runReport();
  enableSort('#tblSales'); enableSort('#tblExp'); enableSort('#tblCr'); enableSort('#tblOr'); enableSort('#tblCash');
}
document.addEventListener('DOMContentLoaded', boot);