// public/js/employees.en.js
(function(){
  const $ = sel => document.querySelector(sel);
  const todayISO = () => new Date().toISOString().slice(0,10);

  // Elements
  const attEmployee = $('#att-employee');
  const attSession  = $('#att-session');
  const attTime     = $('#att-time');
  const attDate     = $('#att-date');
  const btnSaveAtt  = $('#btn-save-att');
  const btnRefreshAtt= $('#btn-refresh-att');
  const btnToday    = $('#btn-today');
  const tblAttBody  = $('#tbl-att tbody');

  const advEmployee = $('#adv-employee');
  const advAmount   = $('#adv-amount');
  const advNote     = $('#adv-note');
  const advDate     = $('#adv-date');
  const btnSaveAdv  = $('#btn-save-adv');
  const btnRefreshAdv= $('#btn-refresh-adv');
  const btnAdvToday = $('#btn-adv-today');
  const tblAdvBody  = $('#tbl-adv tbody');

  // Default dates
  attDate.value = todayISO();
  advDate.value = todayISO();

  // Load employees (try names endpoint, fallback to list)
  async function loadEmployees(){
    let names = [];
    try{
      const r = await fetch('/api/employees/names');
      if (r.ok) names = await r.json();
    }catch(e){ /* ignore */ }

    if (!Array.isArray(names) || names.length===0){
      try{
        const r2 = await fetch('/api/employees/list');
        const list = r2.ok ? await r2.json() : [];
        names = (Array.isArray(list)?list:[]).map(x => x.name).filter(Boolean);
      }catch(_){}
    }

    if (names.length===0){
      names = ['darmin','veronica','farida','shangel','roth','mary','walled','ahmed'];
    }

    const opts = names.map(n => `<option value="${n}">${n}</option>`).join('');
    attEmployee.innerHTML = opts;
    advEmployee.innerHTML = opts;
  }

  // Save attendance
  async function saveAttendance(){
    const payload = {
      employee: attEmployee.value,
      session:  attSession.value, // morning | evening
      time:     attTime.value.trim()
    };
    if(!payload.employee) return alert('Please select an employee');
    if(!payload.time) return alert('Please enter a time');
    const res = await fetch('/api/attendance/add', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(payload)
    });
    if(!res.ok){
      const t = await res.text();
      return alert('Error: '+t);
    }
    alert('Saved');
    await refreshAttendance();
  }

  // Day summary: try new endpoint; otherwise, build from list
  async function refreshAttendance(){
    const d = attDate.value || todayISO();
    try{
      const r = await fetch('/api/attendance/day-summary?date='+encodeURIComponent(d));
      if (r.ok){
        const j = await r.json();
        renderAttendanceRows(j.rows || []);
        return;
      }
    }catch(e){ /* ignore */ }

    // Fallback
    const q = new URLSearchParams({ from: d, to: d });
    const r2 = await fetch('/api/attendance/list?'+q.toString());
    const rows = r2.ok ? await r2.json() : [];
    const byEmp = new Map();
    for (const r of rows){
      const emp = (r.employee||'').trim(); if(!emp) continue;
      const g = byEmp.get(emp) || { ins: [], outs: [], updated: '' };
      const time = String(r.time||'');
      const mm = (/^(\d{1,2}):(\d{2})$/.test(time)) ? (parseInt(time.slice(0,time.indexOf(':')),10)*60 + parseInt(time.slice(time.indexOf(':')+1),10)) : null;
      const act = (r.action||'').toLowerCase();
      const ses = (r.session||'').toLowerCase();
      if (mm!=null){
        if (ses==='morning' || act.includes('check_in') || act==='in') g.ins.push({ t:mm, s: time });
        if (ses==='evening' || act.includes('check_out')|| act==='out') g.outs.push({ t:mm, s: time });
      }
      const u = r.updatedAt || r.createdAt || '';
      if (u > g.updated) g.updated = u;
      byEmp.set(emp, g);
    }
    const res = [];
    for (const [emp, g] of byEmp.entries()){
      const it = g.ins.length ? g.ins.sort((a,b)=>a.t-b.t)[0] : null;   // earliest in
      const ot = g.outs.length? g.outs.sort((a,b)=>b.t-a.t)[0] : null;  // latest out
      let overtime = 0, tag = '—';
      if (it && ot){
        const worked = ot.t - it.t;
        overtime = Math.max(0, worked - 480); // 8 hours
        tag = 'Full';
      } else if (it) tag='Morning';
      else if (ot) tag='Evening';
      res.push({ employee: emp, time_in: it?it.s:null, time_out: ot?ot.s:null, overtime_minutes: overtime, session_tag: tag, updated_at: g.updated });
    }
    renderAttendanceRows(res.sort((a,b)=> a.employee.localeCompare(b.employee)));
  }

  function renderAttendanceRows(rows){
    tblAttBody.innerHTML = rows.map(r=>`
      <tr>
        <td>${r.employee}</td>
        <td>${r.session_tag || '—'}</td>
        <td>${r.time_in || '—'}</td>
        <td>${r.time_out || '—'}</td>
        <td>${r.overtime_minutes ?? 0}</td>
        <td class="muted">${(r.updated_at||'').replace('T',' ').slice(0,16)}</td>
      </tr>
    `).join('');
  }

  // Save advance
  async function saveAdvance(){
    const payload = {
      employee: advEmployee.value,
      amount: Number(advAmount.value||0),
      paid: 0,
      note: advNote.value.trim()
    };
    if(!payload.employee) return alert('Please select an employee');
    if(!(payload.amount>0)) return alert('Please enter a valid amount');
    const res = await fetch('/api/emp_advances/add', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(payload)
    });
    if(!res.ok){
      const t = await res.text();
      return alert('Error: '+t);
    }
    advAmount.value=''; advNote.value='';
    alert('Saved');
    await refreshAdvances();
  }

  // List advances (day)
  async function refreshAdvances(){
    const d = advDate.value || todayISO();
    const q = new URLSearchParams({ from: d, to: d });
    const r = await fetch('/api/emp_advances/list?'+q.toString());
    const rows = r.ok ? await r.json() : [];
    tblAdvBody.innerHTML = rows.map(x=>`
      <tr>
        <td>${x.employee||''}</td>
        <td>${x.amount||0}</td>
        <td>${x.note||''}</td>
        <td class="muted">${String(x.createdAt||'').replace('T',' ').slice(0,16)}</td>
      </tr>
    `).join('');
  }

  // Events
  btnSaveAtt.addEventListener('click', saveAttendance);
  btnRefreshAtt.addEventListener('click', refreshAttendance);
  btnToday.addEventListener('click', ()=>{ attDate.value = todayISO(); refreshAttendance(); });

  btnSaveAdv.addEventListener('click', saveAdvance);
  btnRefreshAdv.addEventListener('click', refreshAdvances);
  btnAdvToday.addEventListener('click', ()=>{ advDate.value = todayISO(); refreshAdvances(); });

  // Init
  loadEmployees().then(()=>{ refreshAttendance(); refreshAdvances(); });
})();