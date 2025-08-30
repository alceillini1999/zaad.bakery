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
  const q=new URLSearchParams();
  if($('#crFrom')?.value) q.set('from',$('#crFrom').value);
  if($('#crTo')?.value) q.set('to',$('#crTo').value);
  if($('#crCustomer')?.value) q.set('customer',$('#crCustomer').value);
  const [credits, payments] = await Promise.all([
    api('/api/credits/list?'+q.toString()),
    api('/api/credits/payments/list?'+q.toString())
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
  const res=await api('/api/credits/add',{method:'POST',body:JSON.stringify(body)});
  if(res.ok){ e.target.reset(); showToast('Credit saved'); loadCredit(); } else showToast(res.error||'Failed',false);
});
$('#formPay')?.addEventListener('submit', async e=>{
  e.preventDefault();
  const body=Object.fromEntries(new FormData(e.target).entries());
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
function drawSalesByMethod(){
  try{
    const c=document.getElementById('salesByMethodChart');
    if(c){ c.classList.add('d-none'); c.closest('.card')?.classList.add('d-none'); }
    if(typeof salesByMethodChart!=='undefined' && salesByMethodChart){ salesByMethodChart.destroy(); salesByMethodChart=null; }
  }catch{}
  return;
}
// listeners
document.addEventListener('DOMContentLoaded', ()=>{
  $$('input[name="session"]').forEach(r=> r.addEventListener('change', toggleCashMode));
  $('#manualOut')?.addEventListener('input', updateCashTotalManual);
  toggleCashMode();
});


$('#btnExpFilter')?.addEventListener('click', loadExpenses);

$('#btnCrFilter')?.addEventListener('click', loadCredit);

$('#btnOrFilter')?.addEventListener('click', loadOrders);

const _dedupeReportBtn=()=>{ const btns=$$('#btnRunReport'); if(btns.length>1) btns.slice(1).forEach(b=>b.remove()); };
document.addEventListener('DOMContentLoaded', _dedupeReportBtn);
