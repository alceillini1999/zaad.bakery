/* Zaad Bakery Pro Frontend */
// ... (باقي الكود كما هو دون تغيير) ...

/* ---------- EMPLOYEES + ATTENDANCE ---------- */
async function loadEmployees(){
  const res = await api('/api/employees/list');
  const rows = (res && Array.isArray(res.rows)) ? res.rows : [];
  // *** تم حذف تعبئة جدول الموظفين نهائياً ***

  // fill selects (attEmployee, purEmployee, advEmployee)
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

// Form handlers (لا تغيير)
$('#formEmployee')?.addEventListener('submit', async (e)=>{
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target).entries());
  const res = await api('/api/employees/add',{ method:'POST', body: JSON.stringify(body) });
  if(res.ok){ showToast('Employee saved'); e.target.reset(); loadEmployees(); } else showToast(res.error||'Failed', false);
});

// ... (باقي كود app.js كما هو دون أي تعديل) ...