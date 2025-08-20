/* Invoice builder for Zaad Bakery */
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

const fmt = v => (Number(v||0)).toFixed(2);
function todayISO(){ return new Date().toISOString().slice(0,10); }
function randomId(){ return ('INV-' + (Date.now().toString(36) + Math.random().toString(36).slice(2,6)).toUpperCase()); }
let INV_ID = randomId();

function addRow(name='', price='', qty='1'){
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input class="form-control form-control-sm name" placeholder="e.g., Croissant" value="${name}"></td>
    <td><input class="form-control form-control-sm text-end price" type="number" min="0" step="0.01" value="${price}"></td>
    <td><input class="form-control form-control-sm text-end qty" type="number" min="1" step="1" value="${qty}"></td>
    <td class="text-end lineTotal">0.00</td>
    <td><button class="btn btn-sm btn-outline-danger del"><i class="bi bi-x-lg"></i></button></td>
  `;
  $('#itemsBody').appendChild(tr);
  tr.addEventListener('input', recalc);
  tr.querySelector('.del').addEventListener('click', ()=>{ tr.remove(); recalc(); });
  recalc();
}
function getItems(){
  return $$('#itemsBody tr').map(tr=>{
    const name = tr.querySelector('.name').value.trim();
    const price = parseFloat(tr.querySelector('.price').value||'0');
    const qty   = parseInt(tr.querySelector('.qty').value||'0',10);
    return { name, price, qty, lineTotal: +(price*qty).toFixed(2) };
  }).filter(x=>x.name && x.qty>0);
}
function recalc(){
  let sub=0;
  $$('#itemsBody tr').forEach(tr=>{
    const price = parseFloat(tr.querySelector('.price').value||'0');
    const qty   = parseInt(tr.querySelector('.qty').value||'0',10);
    const line  = price*qty;
    tr.querySelector('.lineTotal').textContent = fmt(line);
    sub += line;
  });
  $('#subTotal').textContent = fmt(sub);
  $('#grandTotal').textContent = fmt(sub);
}
async function createPDF(){
  const phone = $('#clientPhone').value.trim();
  const name  = $('#clientName').value.trim();
  const items = getItems();
  if(!items.length) { alert('Add at least one item.'); return null; }
  const res = await fetch('/api/invoices/create', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ id: INV_ID, clientPhone: phone, clientName: name, items })
  }).then(r=>r.json());
  if(!res?.ok){ alert(res?.error || 'Failed to create invoice'); return null; }
  INV_ID = res.id || INV_ID;
  $('#invIdPreview').textContent = INV_ID;
  return res;
}
$('#btnAddRow').addEventListener('click', (e)=>{ e.preventDefault(); addRow(); });
$('#btnDownload').addEventListener('click', async (e)=>{
  e.preventDefault();
  const r = await createPDF(); if(!r) return;
  $('#btnDownload').href = r.url;
  window.open(r.url, '_blank');
});
$('#btnWhatsApp').addEventListener('click', async ()=>{
  const r = await createPDF(); if(!r) return;
  window.open(r.waLink, '_blank');
});
document.addEventListener('DOMContentLoaded', ()=>{
  $('#invDate').textContent = todayISO();
  $('#invIdPreview').textContent = INV_ID;

  // Prefill from URL (من زر Orders > Invoice)
  const url = new URL(location.href);
  const phone = url.searchParams.get('phone')||'';
  const item  = url.searchParams.get('item')||'';
  const price = url.searchParams.get('price')||'';
  if(phone) $('#clientPhone').value = phone;
  if(item || price) addRow(item, price||'', 1); else addRow();
});