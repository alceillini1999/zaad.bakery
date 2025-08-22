/* Zaad Bakery front JS (stable, defensive) */
(function(){
  const $ = (q,ctx=document)=>ctx.querySelector(q);
  const $$= (q,ctx=document)=>Array.from(ctx.querySelectorAll(q));

  function fmt(n){ n=+n||0; return n.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2}); }

  /* ---------------- Cash Count ---------------- */
  const DENOMS = [1000,500,200,100,50,40,20,10,5,1];

  function updateCashModeUI(){
    const mode = $('input[name="cashMode"]:checked')?.value || 'morning';
    const isManual = ['till_no_out','send_money_out','withdrawal_out','cash_out'].includes(mode);
    const denomsBox = $('#cashDenoms');
    const manualBox = $('#cashManual');
    if (denomsBox) denomsBox.classList.toggle('hidden', isManual);
    if (manualBox) manualBox.classList.toggle('hidden', !isManual);
    renderCashTotal();
  }

  function calcDenomsTotal(){
    let sum=0;
    for(const d of DENOMS){
      const inp = $(`#qty_${d}`) || $(`#qty${d}`) || $(`[data-denom="${d}"]`);
      const v = parseFloat(inp?.value || '0');
      if (isFinite(v)) sum += d*v;
    }
    return sum;
  }

  function renderCashTotal(){
    const mode = $('input[name="cashMode"]:checked')?.value || 'morning';
    let total = 0;
    if (['till_no_out','send_money_out','withdrawal_out','cash_out'].includes(mode)){
      total = parseFloat($('#cashManualAmount')?.value || '0');
      if (!isFinite(total)) total = 0;
    } else {
      total = calcDenomsTotal();
    }
    $('#cashTotal').textContent = fmt(total);
  }

  async function safeJSON(res){
    const t = await res.text();
    try { return JSON.parse(t); } catch { return {ok:false, raw:t}; }
  }

  async function postJSON(url, body){
    const res = await fetch(url, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return safeJSON(res);
  }

  async function saveCashCount(){
    const mode  = $('input[name="cashMode"]:checked')?.value || 'morning';
    const note  = $('#cashNote')?.value || '';
    let total   = 0;
    let breakdown = null;

    if (['till_no_out','send_money_out','withdrawal_out','cash_out'].includes(mode)){
      total = parseFloat($('#cashManualAmount')?.value || '0'); if(!isFinite(total)) total=0;
    } else {
      total = calcDenomsTotal();
      breakdown = {};
      for(const d of DENOMS){
        const v = parseFloat(($(`#qty_${d}`)||$(`#qty${d}`)||$(`[data-denom="${d}"]`))?.value || '0');
        if (v>0) breakdown[d]=v;
      }
    }

    const payload = { mode, total, note, breakdown };

    // Try primary endpoint then fallback
    try {
      await postJSON('/api/cash', payload);
    } catch(_) {
      await postJSON('/api/cash/add', payload);
    }

    // refresh
    renderCashTotal();
    refreshCashHistory().catch(()=>{});
  }

  async function refreshCashHistory(){
    const body = $('#cashHistoryBody');
    if (!body) return;
    function draw(rows){
      if(!rows || !rows.length){
        body.innerHTML = `<tr><td colspan="4" class="note">No data.</td></tr>`; return;
      }
      body.innerHTML = rows.map(r=>{
        const dt = r.date || r.DateISO || r.createdAt || r.CreatedAt || '';
        const sess = r.session || r.Session || r.mode || '';
        const tot = fmt(r.total ?? r.Total ?? 0);
        const note = r.note ?? r.Note ?? '';
        return `<tr><td>${dt}</td><td>${sess}</td><td>${tot}</td><td>${note}</td></tr>`;
      }).join('');
    }

    // Try endpoints in sequence
    try {
      const r = await fetch('/api/cash/history'); if (r.ok){ const j=await safeJSON(r); draw(j.items||j.data||j); return; }
    } catch{}
    try {
      const r = await fetch('/api/cash?history=1'); if (r.ok){ const j=await safeJSON(r); draw(j.items||j.data||j); return; }
    } catch{}
    try {
      const r = await fetch('/api/cash'); if (r.ok){ const j=await safeJSON(r); draw(j.items||j.data||j); return; }
    } catch{}
    draw([]);
  }

  /* ---------------- Reports ---------------- */
  function readNumber(obj, ...keys){
    for (const k of keys){ if (obj && obj[k]!=null) return +obj[k]||0; }
    return 0;
  }

  function renderReportSummary(summary){
    if (!summary) summary = {};

    const expenses        = readNumber(summary,'expenses','Expenses');
    const salesCash       = readNumber(summary,'salesCash','sales_cash','SalesCash');
    const salesTill       = readNumber(summary,'salesTill','sales_till','SalesTill','tillSales');
    const salesSend       = readNumber(summary,'salesSend','sales_send','SalesSend');
    const salesWithdrawal = readNumber(summary,'salesWithdrawal','sales_withdrawal','SalesWithdrawal');

    const cashMorning     = readNumber(summary,'cashMorning','cash_morning','CashMorning');
    const cashEvening     = readNumber(summary,'cashEvening','cash_evening','CashEvening');

    const cashOut         = readNumber(summary,'cashOut','cash_out','CashOut');
    const tillOut         = readNumber(summary,'tillOut','till_no_out','tillOutManual','TillOut');
    const withdrawalOut   = readNumber(summary,'withdrawalOut','withdrawal_out','WithdrawalOut');
    const sendOut         = readNumber(summary,'sendOut','send_money_out','SendOut');

    // KPI bindings
    $('#kpi-expenses').textContent          = fmt(expenses);
    $('#kpi-sales-cash').textContent        = fmt(salesCash);
    $('#kpi-sales-till').textContent        = fmt(salesTill);
    $('#kpi-sales-send').textContent        = fmt(salesSend);
    $('#kpi-sales-withdrawal').textContent  = fmt(salesWithdrawal);

    $('#kpi-cash-morning').textContent      = fmt(cashMorning);
    $('#kpi-cash-evening').textContent      = fmt(cashEvening);

    // Cash available in casher (definition shared earlier)
    const cashAvailable = (salesCash + withdrawalOut) - expenses;
    $('#kpi-cash-available').textContent    = fmt(cashAvailable);

    // Outs
    $('#kpi-cash-out').textContent          = fmt(cashOut);
    $('#kpi-till-out').textContent          = fmt(tillOut);
    $('#kpi-withdrawal-out').textContent    = fmt(withdrawalOut);
    $('#kpi-send-out').textContent          = fmt(sendOut);

    // Remaining logic (sales - out) as default
    $('#kpi-cash-remaining').textContent        = fmt(cashAvailable - cashOut);
    $('#kpi-till-remaining').textContent        = fmt(salesTill - tillOut);
    $('#kpi-withdrawal-remaining').textContent  = fmt(salesWithdrawal - withdrawalOut);
    $('#kpi-send-remaining').textContent        = fmt(salesSend - sendOut);

    // Card #7: Total sales (all channels)
    const totalAll = salesCash + salesTill + salesSend + salesWithdrawal;
    $('#kpi-total-sales').textContent       = fmt(totalAll);
  }

  async function runReport(){
    const from = $('#fromDate')?.value || '';
    const to   = $('#toDate')?.value   || '';

    const qs = new URLSearchParams({from,to}).toString();
    let data=null;

    try {
      let r = await fetch('/api/reports?'+qs); 
      if (r.ok) data = await safeJSON(r);
    } catch{}
    if (!data) {
      // fallback alternative endpoints
      try { let r = await fetch('/api/report?'+qs); if (r.ok) data=await safeJSON(r); } catch{}
    }

    // Expect { summary: {...} } or flat object
    const summary = (data && (data.summary || data)) || {};
    renderReportSummary(summary);
    // keep last for hotfix hooks
    window.__lastReport = {summary};
    return summary;
  }

  /* ---------------- Wire events ---------------- */
  document.addEventListener('input', (e)=>{
    if (e.target.matches('#cashManualAmount, [id^="qty_"], [data-denom]')) renderCashTotal();
  });
  document.addEventListener('change', (e)=>{
    if (e.target.name === 'cashMode') updateCashModeUI();
  });
  $('#btnSaveCash')?.addEventListener('click', ()=> saveCashCount().catch(console.error));
  $('#btnRun')?.addEventListener('click', ()=> runReport().catch(console.error));

  // init
  (function init(){
    // default dates = today
    try {
      const today = new Date();
      const iso = (d)=> d.toISOString().slice(0,10);
      if ($('#fromDate') && !$('#fromDate').value) $('#fromDate').value = iso(today);
      if ($('#toDate') && !$('#toDate').value) $('#toDate').value = iso(today);
    } catch{}
    updateCashModeUI();
    refreshCashHistory().catch(()=>{});
    runReport().catch(()=>{});
  })();
})();