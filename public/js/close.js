
// close.js — Cash Reconciliation + Expense Audit (read-only from existing APIs; saves locally)
(function(){
  const $ = (sel, root=document) => root.querySelector(sel);
  const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));
  const fmt = (n) => (isFinite(n) ? n.toLocaleString('en-US', {minimumFractionDigits:0, maximumFractionDigits:2}) : '0');

  function todayISO(){
    const d=new Date(); const p=n=>String(n).padStart(2,'0');
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
  }

  async function fetchJSON(url){
    const res = await fetch(url, {headers: {"accept":"application/json"}});
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function getAmountFrom(obj){
    // Heuristic to find amount field
    const prefs = ['total','amount','paid','value','net','price','sum'];
    for (const k of prefs) if (typeof obj[k] !== 'undefined' && !isNaN(+obj[k])) return +obj[k];
    // fallback: first numeric
    for (const [k,v] of Object.entries(obj)) if (typeof v === 'number') return v;
    return 0;
  }
  function isCashRecord(obj){
    const keys = Object.keys(obj);
    const vals = keys.map(k=>obj[k]).filter(v=>typeof v==='string').join(' ').toLowerCase();
    return /(cash|نقد|كاش)/.test(vals);
  }

  async function loadClose(){
    // defaults
    const date = $('#closeDate').value || todayISO();

    // Try getting a summary endpoint first (if exists)
    let source = 'Auto';
    let sales = [], expenses = [], creditPays = [];
    let sumCashSales = 0, sumCashExpenses = 0, sumCreditRepayCash = 0, deposits = 0;

    // Attempt 1: aggregated (optional)
    try {
      const s = await fetchJSON(`/api/report/summary?date=${date}`);
      if (s) {
        sumCashSales = +s.cashSales || 0;
        sumCashExpenses = +s.cashExpenses || 0;
        sumCreditRepayCash = +s.cashCreditRepay || 0;
        deposits = +s.deposits || 0;
        source = 'summary';
      }
    } catch(e){ /* ignore */ }

    // Attempt 2: lists
    if (source !== 'summary'){
      try {
        const sres = await fetchJSON(`/api/sales/list?date=${date}`);
        sales = Array.isArray(sres?.rows || sres) ? (sres.rows || sres) : [];
      } catch(e){}
      try {
        const eres = await fetchJSON(`/api/expenses/list?date=${date}`);
        expenses = Array.isArray(eres?.rows || eres) ? (eres.rows || eres) : [];
      } catch(e){}
      // credit payments if available
      try {
        const cres = await fetchJSON(`/api/credit/payments?date=${date}`);
        creditPays = Array.isArray(cres?.rows || cres) ? (cres.rows || cres) : [];
      } catch(e){}

      sumCashSales = sales.filter(isCashRecord).reduce((a,r)=>a+getAmountFrom(r),0);
      sumCashExpenses = expenses.filter(isCashRecord).reduce((a,r)=>a+getAmountFrom(r),0);
      sumCreditRepayCash = creditPays.filter(isCashRecord).reduce((a,r)=>a+getAmountFrom(r),0);
      source = 'lists';
    }

    // Render header figures
    $('#sumCashSales').textContent = fmt(sumCashSales);
    $('#sumCashExpenses').textContent = fmt(sumCashExpenses);
    $('#sumCreditRepayCash').textContent = fmt(sumCreditRepayCash);
    $('#sumDeposits').textContent = fmt(deposits);

    // Expected cash
    const expected = sumCashSales + sumCreditRepayCash - sumCashExpenses - deposits;
    $('#expectedCash').textContent = fmt(expected);

    // Expenses table
    renderExpensesTable(expenses, {threshold: +($('#expThresholdInput').value||0), cat: $('#expCatFilter').value, onlyUnapproved: $('#expOnlyUnapproved').checked});

    // Load saved local state for this date (count, approvals)
    loadLocal(date);

    // Status chips + finalize
    recomputeDiffAndStatus();

    // Data source hint
    $('#dataSourceHint').textContent = source === 'summary' ? 'بيانات من /api/report/summary' : 'تجميع من /api/sales/list و /api/expenses/list';
  }

  function buildDenoms(){
    const denoms = [1000,500,200,100,50,20,10,5,1];
    const tbody = $('#tblDenoms'); tbody.innerHTML = '';
    denoms.forEach(v=>{
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${v}</td>
        <td><input class="form-control form-control-sm denom-input" inputmode="numeric" min="0" id="d-${v}" value="0"></td>
        <td class="text-end"><span id="t-${v}">0</span></td>`;
      tbody.appendChild(tr);
    });
    // wire inputs
    tbody.addEventListener('input', e=>{
      if (e.target && e.target.id && e.target.id.startsWith('d-')){
        const v = +e.target.id.split('-')[1];
        const qty = Math.max(0, +e.target.value||0);
        $(`#t-${v}`).textContent = fmt(v * qty);
        calcCounted();
        recomputeDiffAndStatus();
      }
    });
  }

  function calcCounted(){
    let sum = 0;
    $$('#tblDenoms input[id^="d-"]').forEach(inp=>{
      const v = +inp.id.split('-')[1];
      const qty = Math.max(0, +inp.value||0);
      sum += v * qty;
    });
    $('#countedCash').textContent = fmt(sum);
    return sum;
  }

  // Expenses rendering + filters (client-side)
  function renderExpensesTable(rows, opts){
    const body = $('#tblExpensesBody'); body.innerHTML = '';
    if (!Array.isArray(rows)) rows = [];
    // derive unique categories
    const catSel = $('#expCatFilter');
    const cats = Array.from(new Set(rows.map(r => String(r.category || r.cat || r.type || '').trim()).filter(Boolean))).sort();
    // populate categories (once)
    if (catSel.dataset.filled !== '1'){
      cats.forEach(c=>{ const o=document.createElement('option'); o.value=c; o.textContent=c; catSel.appendChild(o); });
      catSel.dataset.filled = '1';
    }
    // filters
    const threshold = +opts.threshold || 0;
    const onlyUnapproved = !!opts.onlyUnapproved;
    const catFilter = (opts.cat || '').toLowerCase();

    // approvals local state
    const date = $('#closeDate').value || todayISO();
    const approvedSet = new Set(JSON.parse(localStorage.getItem(`expApproved:${date}`) || '[]'));

    let total = 0, unapproved = 0, approvedCount = 0;
    rows.forEach((r, idx)=>{
      const amount = getAmountFrom(r);
      const method = String(r.method || r.payment || r.payMethod || r.pay_type || '').trim();
      const cat = String(r.category || r.cat || r.type || '').trim();
      const desc = String(r.desc || r.description || r.note || r.notes || '').trim();
      const dateStr = String(r.date || r.createdAt || r.ts || '').split('T')[0];

      const idKey = r.id || r._id || `${dateStr}|${cat}|${amount}|${idx}`;
      const isApproved = approvedSet.has(String(idKey));

      // apply filters
      if (catFilter && cat.toLowerCase() !== catFilter) return;
      if (onlyUnapproved && isApproved) return;

      total += amount;
      if (!isApproved) unapproved += amount; else approvedCount++;

      const tr = document.createElement('tr');
      const warn = threshold && amount >= threshold ? 'text-danger fw-semibold' : '';
      tr.innerHTML = `<td>${dateStr||'-'}</td>
        <td>${cat||'-'}</td>
        <td>${desc||'-'}</td>
        <td>${method||'-'}</td>
        <td class="text-end ${warn}">${fmt(amount)}</td>
        <td><input class="form-check-input" type="checkbox" data-exp-id="${idKey}" ${isApproved?'checked':''}></td>`;
      body.appendChild(tr);
    });

    $('#totalExpensesToday').textContent = fmt(total);
    $('#totalUnapproved').textContent = fmt(unapproved);
    $('#approvedCount').textContent = fmt(approvedCount);

    // Wire checkbox changes
    body.addEventListener('change', (e)=>{
      if (e.target && e.target.matches('input[type="checkbox"][data-exp-id]')){
        const id = String(e.target.getAttribute('data-exp-id'));
        const date = $('#closeDate').value || todayISO();
        const cur = new Set(JSON.parse(localStorage.getItem(`expApproved:${date}`) || '[]'));
        if (e.target.checked) cur.add(id); else cur.delete(id);
        localStorage.setItem(`expApproved:${date}`, JSON.stringify(Array.from(cur)));
        // recompute counters
        // quick: re-render with same rows and filters
        renderExpensesTable(rows, {
          threshold: +($('#expThresholdInput').value||0),
          cat: $('#expCatFilter').value,
          onlyUnapproved: $('#expOnlyUnapproved').checked
        });
        recomputeDiffAndStatus();
      }
    }, {once:true});
  }

  function recomputeDiffAndStatus(){
    const expected = parseNumber($('#expectedCash').textContent);
    const counted = parseNumber($('#countedCash').textContent);
    const diff = counted - expected;
    const el = $('#diffCash');
    el.textContent = fmt(diff);
    el.classList.toggle('text-danger', Math.abs(diff) > 0.009);
    el.classList.toggle('text-success', Math.abs(diff) <= 0.009);

    // statuses
    $('#statusCash').textContent = `Cash: ${Math.abs(diff)<=0.009?'Balanced':'Diff ' + fmt(diff)}`;

    const date = $('#closeDate').value || todayISO();
    const unapproved = parseNumber($('#totalUnapproved').textContent);
    const hasUnapproved = unapproved > 0.009;
    $('#statusExp').textContent = `Expenses: ${hasUnapproved?'Pending':'Checked'}`;

    // finalize enable
    $('#btnFinalizeClose').disabled = !(Math.abs(diff)<=0.009 && !hasUnapproved);
  }

  function parseNumber(s){
    const n = parseFloat(String(s).replace(/[, ]/g,''));
    return isFinite(n)?n:0;
  }

  // Local storage save
  function saveLocal(date){
    const denoms = {};
    $$('#tblDenoms input[id^="d-"]').forEach(inp=>{ denoms[inp.id] = +inp.value || 0; });
    const data = {
      denoms,
      notes: $('#closeNotes').value || '',
      depositRef: $('#depositRef').value || '',
    };
    localStorage.setItem(`close:${date}`, JSON.stringify(data));
  }
  function loadLocal(date){
    buildDenoms();
    const raw = localStorage.getItem(`close:${date}`);
    if (!raw) { calcCounted(); return; }
    try {
      const data = JSON.parse(raw);
      if (data.denoms){
        for (const [id,val] of Object.entries(data.denoms)){
          const inp = document.getElementById(id);
          if (inp){ inp.value = val; const v=+id.split('-')[1]; document.getElementById('t-'+v).textContent = fmt(v*val); }
        }
      }
      $('#closeNotes').value = data.notes || '';
      $('#depositRef').value = data.depositRef || '';
    } catch {}
    calcCounted();
  }

  // Wire UI
  function wireEvents(){
    // date default + reload
    if (!$('#closeDate').value){
      $('#closeDate').value = todayISO();
    }
    $('#btnCloseReload').addEventListener('click', (e)=>{ e.preventDefault(); loadClose(); });
    $('#closeDate').addEventListener('change', ()=> loadClose());

    // filters
    $('#expThresholdInput').addEventListener('input', ()=> {
      const rows = window._lastExpensesRows || [];
      renderExpensesTable(rows, {
        threshold: +($('#expThresholdInput').value||0),
        cat: $('#expCatFilter').value,
        onlyUnapproved: $('#expOnlyUnapproved').checked
      });
      recomputeDiffAndStatus();
    });
    $('#expCatFilter').addEventListener('change', ()=> {
      const rows = window._lastExpensesRows || [];
      renderExpensesTable(rows, {
        threshold: +($('#expThresholdInput').value||0),
        cat: $('#expCatFilter').value,
        onlyUnapproved: $('#expOnlyUnapproved').checked
      });
      recomputeDiffAndStatus();
    });
    $('#expOnlyUnapproved').addEventListener('change', ()=> {
      const rows = window._lastExpensesRows || [];
      renderExpensesTable(rows, {
        threshold: +($('#expThresholdInput').value||0),
        cat: $('#expCatFilter').value,
        onlyUnapproved: $('#expOnlyUnapproved').checked
      });
      recomputeDiffAndStatus();
    });

    // buttons (local save)
    $('#btnSaveCount').addEventListener('click', ()=>{
      const date = $('#closeDate').value || todayISO();
      saveLocal(date);
      try { window.showToast && window.showToast('تم حفظ العدّ محليًا'); } catch {}
    });
    $('#btnSaveDeposit').addEventListener('click', ()=>{
      const date = $('#closeDate').value || todayISO();
      saveLocal(date);
      try { window.showToast && window.showToast('تم تسجيل الإيداع محليًا'); } catch {}
    });
    $('#btnPrintDeposit').addEventListener('click', ()=>{
      window.print();
    });
    $('#btnApproveAll').addEventListener('click', ()=>{
      const date = $('#closeDate').value || todayISO();
      const body = $('#tblExpensesBody');
      const ids = $$('input[type="checkbox"][data-exp-id]', body).map(x=>x.getAttribute('data-exp-id'));
      localStorage.setItem(`expApproved:${date}`, JSON.stringify(ids));
      // re-render
      renderExpensesTable(window._lastExpensesRows || [], {
        threshold: +($('#expThresholdInput').value||0),
        cat: $('#expCatFilter').value,
        onlyUnapproved: $('#expOnlyUnapproved').checked
      });
      recomputeDiffAndStatus();
    });
    $('#btnSaveExpApprovals').addEventListener('click', ()=>{
      const date = $('#closeDate').value || todayISO();
      // local only
      try { window.showToast && window.showToast('تم حفظ الاعتمادات محليًا'); } catch {}
    });

    $('#btnFinalizeClose').addEventListener('click', ()=>{
      const ok = !$('#btnFinalizeClose').disabled;
      if (!ok) return;
      const date = $('#closeDate').value || todayISO();
      saveLocal(date);
      try { window.showToast && window.showToast('تم إنهاء إقفال اليوم'); } catch {}
    });
  }

  document.addEventListener('DOMContentLoaded', ()=>{
    wireEvents();
    buildDenoms();
    loadClose().catch(err=>{
      console.error(err);
      // Still load local if exists
      const d = $('#closeDate').value || todayISO();
      loadLocal(d);
    });
  });

  // expose for boot-mpa (optional)
  window.loadClose = loadClose;
})();
