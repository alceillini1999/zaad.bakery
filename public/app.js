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
  const res=await api('/api/sales/add',{method:'POST',body:JSON.stringify(body)});
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
  const formData = new FormData(form); // يرسل ملف receipt إن وجد
  const res = await fetch('/api/expenses/add',{method:'POST', body: formData}).then(r=>r.json());
  if(res.ok){ form.reset(); showToast('Expense saved'); loadExpenses(); } else showToast(res.error||'Failed',false);
});

/* ---------- CREDIT + PAYMENTS ---------- */
async function loadCredit(){
  const [credits, payments] = await Promise.all([
    api('/api/credits/list'),
    api('/api/credits/payments/list')
  ]);
  const rows=credits.rows||[], pays=payments.rows||[];
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
      new bootstrap.Modal($('#payModal')).show();
    });
  });
}
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
  if(res.ok){ e.target.reset(); bootstrap.Modal.getInstance($('#payModal'))?.hide(); showToast('Payment recorded'); loadCredit(); loadSales(); } else showToast(res.error||'Failed',false);
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
  const res=await api('/api/orders/add',{method:'POST',body:JSON.stringify(body)});
  if(res.ok){ e.target.reset(); showToast('Order saved'); loadOrders(); } else showToast(res.error||'Failed',false);
});

// order pay submit
$('#formOrderPay')?.addEventListener('submit', async e=>{
  e.preventDefault();
  const id=$('#opId').value, remain=parseFloat($('#opRemaining').value||'0'), amount=parseFloat($('#opAmount').value||'0');
  if(amount>remain){ return showToast('Amount exceeds remaining', false); }
  const method=$('#opMethod').value;
  const res=await api('/api/orders/pay',{method:'POST', body:JSON.stringify({id, amount, method})});
  if(res.ok){ bootstrap.Modal.getInstance($('#orderPayModal'))?.hide(); showToast('Order payment saved'); loadOrders(); loadSales(); } else showToast(res.error||'Failed',false);
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

  // Sales by method
  const sCash = s.rows.reduce((a,r)=>a+(/cash/i.test(r.method)?+r.amount:0),0);
  const sTill = s.rows.reduce((a,r)=>a+(/till/i.test(r.method)?+r.amount:0),0);
  const sWith = s.rows.reduce((a,r)=>a+(/withdraw/i.test(r.method)?+r.amount:0),0);
  const sSend = s.rows.reduce((a,r)=>a+(/send/i.test(r.method)?+r.amount:0),0);

  // Expenses breakdown
  const expTot  = e.rows.reduce((a,r)=>a+(+r.amount||0),0);
  const expCash = e.rows.reduce((a,r)=>a+(/cash/i.test(r.method)?+r.amount:0),0);
  const expTill = e.rows.reduce((a,r)=>a+(/till/i.test(r.method)?+r.amount:0),0);
  const expWith = e.rows.reduce((a,r)=>a+(/withdraw/i.test(r.method)?+r.amount:0),0);
  const expSend = e.rows.reduce((a,r)=>a+(/send/i.test(r.method)?+r.amount:0),0);

  // Credit outstanding
  const crGross = c.rows.reduce((a,r)=>a+((+r.amount||0)-(+r.paid||0)),0);
  const crPays  = p.rows.reduce((a,r)=>a+(+r.paid||0),0);
  const crOutstanding = crGross - crPays;

  // Cash counts
  const morning = k.rows.filter(x=>x.session==='morning').reduce((a,r)=>a+(+r.total||0),0);
  const evening = k.rows.filter(x=>x.session==='evening').reduce((a,r)=>a+(+r.total||0),0);

  // Outs
  const withdrawOut = k.rows.filter(x=>x.session==='withdraw_out' || x.session==='eod').reduce((a,r)=>a+(+r.total||0),0);
  const tillOut     = k.rows.filter(x=>x.session==='till_out').reduce((a,r)=>a+(+r.total||0),0);
  const sendOut     = k.rows.filter(x=>x.session==='send_out').reduce((a,r)=>a+(+r.total||0),0);

  // Section 4: Cash available (correct formula)
  const cashAvailable = morning + sCash - expCash;

  // Next day morning (for single-day reports)
  const from=$('#repFrom').value||today(), to=$('#repTo').value||from;
  let nextMorning = 0;
  if (from===to){
    const d = new Date(from+'T00:00:00');
    d.setDate(d.getDate()+1);
    const next = d.toISOString().slice(0,10);
    const kn = await api('/api/cash/list?from='+next+'&to='+next);
    nextMorning = kn.rows.filter(x=>x.session==='morning').reduce((a,r)=>a+(+r.total||0),0);
  }

  // Manual cash_out for selected day (session='cash_out')
  let manualCashOut = 0;
  if (from===to){
    const kc = await api('/api/cash/list?from='+from+'&to='+from);
    manualCashOut = kc.rows.filter(x=>x.session==='cash_out').reduce((a,r)=>a+(+r.total||0),0);
  }

  const computedCashOut = Math.max(0, cashAvailable - nextMorning);
  const cashOut = manualCashOut || computedCashOut;

  // Remaining by channel (carry to next day)
  const cashRemaining = cashAvailable - (manualCashOut||0);
  const tillRemaining = sTill - tillOut - expTill;
  const withRemaining = sWith - withdrawOut - expWith;
  const sendRemaining = sSend - sendOut - expSend;

  // Build 6 sections
  const sections = [
    { title: '1) Expenses', items: [['Expenses', expTot]] },
    { title: '2) Sales by Method', items: [['Sales (Cash)', sCash], ['Sales (Till No)', sTill], ['Sales (Send Money)', sSend], ['Sales (Withdrawal)', sWith]] },
    { title: '3) Cash Counts', items: [['Cash Morning', morning], ['Cash Evening', evening]] },
    { title: '4) Cash available in cashier', items: [['Cash available (computed)', cashAvailable]] },
    { title: '5) Outs', items: [['Cash Out (from available vs. next morning)', cashOut], ['Till No Out', tillOut], ['Withdrawal Out', withdrawOut], ['Send Money Out', sendOut]] },
    { title: '6) Remaining (carry to next day)', items: [['Cash remaining', cashRemaining], ['Till No remaining', tillRemaining], ['Withdrawal remaining', withRemaining], ['Send Money remaining', sendRemaining]] },
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

/* ---------- Boot ---------- */
document.addEventListener('DOMContentLoaded', ()=>{
  // default dates
  ['salesFrom','salesTo','repFrom','repTo'].forEach(id=>{ if($('#'+id)) $('#'+id).value=today(); });
  loadDenoms();

  // load lists initially
  loadSales(); loadExpenses(); loadCredit(); loadOrders(); loadCash(); runReport();
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
    const existing = kc.rows.filter(x=>x.session==='till_out').reduce((a,r)=>a+(+r.total||0),0);
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
  showToast('Cash Out saved'); $('#cashOutInput').value=''; 
});
$('#btnTillOutSave')?.addEventListener('click', async ()=>{
  const val = +($('#tillOutInput').value||0); if (!(val>=0)) return showToast('أدخل رقم صالح', false);
  await api('/api/cash/add',{ method:'POST', body: JSON.stringify({ date: today(), session:'till_out', total: val, note:'cash tab manual' }) });
  showToast('Till No Out saved'); $('#tillOutInput').value='';
});
$('#btnSendOutSave')?.addEventListener('click', async ()=>{
  const val = +($('#sendOutInput').value||0); if (!(val>=0)) return showToast('أدخل رقم صالح', false);
  await api('/api/cash/add',{ method:'POST', body: JSON.stringify({ date: today(), session:'send_out', total: val, note:'cash tab manual' }) });
  showToast('Send Money Out saved'); $('#sendOutInput').value='';
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

