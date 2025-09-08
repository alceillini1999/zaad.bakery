
// boot-mpa.js — auto-load data per page after refresh (without touching app.js APIs)
(function(){
  function call(fn){ try { return typeof fn === 'function' ? fn() : undefined; } catch(e){ console.error(e); } }
  function onReady(fn){ if (document.readyState !== 'loading') fn(); else document.addEventListener('DOMContentLoaded', fn); }

  onReady(function(){
    const path = (location.pathname || '').toLowerCase();

    // Reports: ensure default dates on first load
    if (path.endsWith('/reports.html') || path.endsWith('/reports')) {
      try {
        const rf=document.getElementById('repFrom'), rt=document.getElementById('repTo');
        if (rf && !rf.value){ const d=new Date(); const p=n=>String(n).padStart(2,'0'); const t=`${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`; rf.value=t; }
        if (rt && !rt.value){ rt.value=rf ? rf.value : undefined; }
      } catch(e){ /* ignore */ }
    }

    // Route to the right loader(s)
    if (path.endsWith('/index.html') || path === '/' || path === '') {
      call(window.loadSales);
    } else if (path.endsWith('/expenses.html')) {
      call(window.loadExpenses);
    } else if (path.endsWith('/orders.html')) {
      call(window.loadOrders);
    } else if (path.endsWith('/credit.html')) {
      call(window.loadCredit);
    } else if (path.endsWith('/cash.html')) {
      call(window.loadCash);
      call(window.loadDenoms); // optional if exists
    } else if (path.endsWith('/employees.html')) {
      call(window.loadEmployees);
    } else if (path.endsWith('/reports.html')) {
      if (typeof window.runReport === 'function') {
        Promise.resolve(window.runReport()).catch(()=>{});
      }
    }
  });

  // Optional: re-run loader when socket re-connects (if using socket.io)
  try {
    if (window.socket && typeof window.socket.on === 'function') {
      window.socket.on('connect', () => {
        const path = (location.pathname || '').toLowerCase();
        if (path.endsWith('/index.html') || path === '/' || path === '') { call(window.loadSales); }
        else if (path.endsWith('/expenses.html')) { call(window.loadExpenses); }
        else if (path.endsWith('/orders.html')) { call(window.loadOrders); }
        else if (path.endsWith('/credit.html')) { call(window.loadCredit); }
        else if (path.endsWith('/cash.html')) { call(window.loadCash); call(window.loadDenoms); }
        else if (path.endsWith('/employees.html')) { call(window.loadEmployees); }
        else if (path.endsWith('/reports.html')) { if (typeof window.runReport === 'function') Promise.resolve(window.runReport()).catch(()=>{}); }
      });
    }
  } catch(e){ /* ignore */ }
})();
