/* Zaad Bakery Pro Frontend (updated) */
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
  if (active==='tabOrders'  && (type==='orders'  || type==='orders_status'))   loadOrders();
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
function enableSort(tableSel){
  const table=$(tableSel); if(!table || !table.tHead) return;
  const ths=Array.from(table.tHead.rows[0].cells||[]);
  ths.forEach((th,i)=>{
    const type=th.dataset.sort||'text';
    th.addEventListener('click', ()=>{
      const dir = th.classList.contains('sorted-asc')? 'desc':'asc';
      ths.forEach(h=>h.classList.remove('sorted-asc','sorted-desc'));
      th.classList.add(dir==='asc'?'sorted-asc':'sorted-desc');
      const rows = Array.from(table.tBodies[0].rows);
      const getVal = (r)=> r.cells[i].innerText.trim();
      rows.sort((a,b)=>{
        const va=getVal(a), vb=getVal(b);
        if(type==='num') return (parseFloat(va)||0) - (parseFloat(vb)||0);
        if(type==='date') return va.localeCompare(vb);
        return va.localeCompare(vb);
      });
      if(dir==='desc') rows.reverse();
      rows.forEach(r=>table.tBodies[0].appendChild(r));
    });
  });
}

/* SALES */
function bindSaleCalc(){
  $('#formSale')?.addEventListener('input', (e)=>{
    if (['quantity','unitPrice','amount'].includes(e.target.name)){
      const q=parseFloat($('#formSale [name="quantity"]').value||'0');
      const u=parseFloat($('#formSale [name="unitPrice"]').value||'0');
      const a=$('#formSale [name="amount"]').value;
      if(!a) $('#formSale [name="amount"]').value=(q*u||0).toFixed(2);
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
  if(!rows.length){ tb.innerHTML=`<tr><td colspan="6" class="text-secondary p-4">No data.</td></tr>`; return;}
  tb.innerHTML = rows.map(r=>`
    <tr>
      <td>${(r.dateISO||'').slice(0,10)}</td>
      <td class="text-end">${r.quantity||''}</td>
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
  body.quantity=Number(body.quantity||1); body.unitPrice=Number(body.unitPrice||0);
  if(!body.amount || Number(body.amount)===0) body.amount=(body.quantity*body.unitPrice).toFixed(2);
  const res=await api('/api/sales/add',{method:'POST',body:JSON.stringify(body)});
  if(res.ok){ e.target.reset(); showToast('Sale saved'); loadSales(); } else showToast(res.error||'Failed',false);
});

/* EXPENSES (with receipt upload) */
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

/* CREDIT + PAYMENTS (كما في نسختك) */
// ... لو عندك الكتلة القديمة اتركها كما هي.

/* ORDERS + STATUS */
const ORDER_FLOW=['Pending','In-Progress','Done','Delivered'];
async function loadOrders(){
  const {rows=[]}=await api('/api/orders/list');
  const statusFilter = $('#orStatusFilter')?.value || '';
  const list = statusFilter ? rows.filter(r=> (r.status||'Pending')===statusFilter) : rows;
  const tb=$('#tblOrdersBody');
  if(!list.length){ tb.innerHTML=`<tr><td colspan="8" class="text-secondary p-4">No data.</td></tr>`; return;}
  tb.innerHTML = list.map(r=>{
    const next = ORDER_FLOW[(ORDER_FLOW.indexOf(r.status||'Pending')+1)%ORDER_FLOW.length];
    return `<tr data-id="${r.id}">
      <td>${(r.dateISO||'').slice(0,10)}</td>
      <td>${r.phone||''}</td>
      <td>${r.item||''}</td>
      <td class="text-end">${Number(r.amount||0).toFixed(2)}</td>
      <td class="text-end">${Number(r.paid||0).toFixed(2)}</td>
      <td class="text-end fw-semibold">${Number(r.remaining||0).toFixed(2)}</td>
      <td><span class="badge text-bg-${r.status==='Delivered'?'success':r.status==='Done'?'primary':r.status==='In-Progress'?'warning text-dark':'secondary'}">${r.status||'Pending'}</span></td>
      <td><button class="btn btn-sm btn-outline-secondary btnNext">Next → ${next}</button></td>
    </tr>`;
  }).join('');

  // bind next
  $$('#tblOrdersBody .btnNext').forEach(btn=>{
    btn.addEventListener('click', async (ev)=>{
      const tr=ev.target.closest('tr'); const id=tr?.dataset.id; if(!id) return;
      const curr=tr.querySelector('td:nth-child(7) .badge')?.innerText||'Pending';
      const next=ORDER_FLOW[(ORDER_FLOW.indexOf(curr)+1)%ORDER_FLOW.length];
      const res=await api('/api/orders/status',{method:'POST', body:JSON.stringify({id, status: next})});
      if(res.ok){ showToast('Status updated'); loadOrders(); } else showToast(res.error||'Failed',false);
    });
  });
}
$('#orStatusFilter')?.addEventListener('change', loadOrders);

// FIX: submit order without page reload
$('#formOrder')?.addEventListener('submit', async e=>{
  e.preventDefault();
  const body=Object.fromEntries(new FormData(e.target).entries());
  const res=await api('/api/orders/add',{method:'POST',body:JSON.stringify(body)});
  if(res.ok){ e.target.reset(); showToast('Order saved'); loadOrders(); } else showToast(res.error||'Failed',false);
});

/* CASH + REPORTS (كما في نسختك المحسّنة) */
// ... اترك باقي الدوال عندك كما هي، أو استعمل نسختي المحسّنة السابقة.

/* Boot */
function boot(){
  ['salesFrom','salesTo','repFrom','repTo'].forEach(id=>{ if($('#'+id)) $('#'+id).value=today(); });
  bindSaleCalc();
  loadSales(); loadExpenses(); loadOrders();
  // … لو عندك بقية اللود (credit/cash/reports) استدعيها هنا كذلك.
  enableSort('#tblSales'); enableSort('#tblExp'); enableSort('#tblOr');
  tableFilter($('#salesSearch'),'#tblSalesBody');
}
document.addEventListener('DOMContentLoaded', boot);