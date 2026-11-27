/* Local-only audit history screen. No authentication or cloud dependencies. */
(function (global) {
  'use strict';
  const PERM = global.PERM, UI = global.UI, App = global.App;
  const { t, esc, fmtNum, fmtDate, toast } = UI;
  async function renderAudit(host) {
    if (!PERM.isAdmin()) {
      host.innerHTML = `<div class="card error-card">هذه الشاشة متاحة لمدير النظام فقط.</div>`;
      return;
    }
    host.innerHTML = `
      <div class="page-head"><h2>سجل العمليات</h2>
        <div class="head-actions"><button class="btn btn-ghost" id="au-reload">تحديث</button></div></div>
      <p class="muted small">سجل محلي للعمليات المسجلة على هذا الجهاز.</p>
      <div class="card filters">
        <input type="text" id="au-q" placeholder="بحث في التفاصيل…">
        <select id="au-entity"><option value="">القسم: الكل</option>
          <option value="movement">الحركات</option><option value="permit">أذون الصرف</option>
          <option value="roll">الرولات</option><option value="reel">البكر</option>
          <option value="product">الأصناف</option><option value="user">المستخدمون</option>
          <option value="database">قاعدة البيانات</option></select>
        <input type="date" id="au-from" title="من تاريخ">
        <input type="date" id="au-to" title="إلى تاريخ">
        <button class="btn btn-ghost" id="au-clear">${t('reset')}</button>
      </div>
      <div class="card table-wrap" id="au-table"><div class="spinner"></div></div>`;

    let all = [];

    async function load() {
      const localRows = await global.DB.getAudit(2000);
      all = localRows.map((r) => ({
        at: r.at, entity: r.entity, action: r.action, entityId: r.entityId,
        details: r.details || (r.after && !r.before ? 'إضافة' : ''),
        actorEmail: 'محلي', origin: 'local',
      }));
      all.sort((a, b) => (a.at < b.at ? 1 : -1));
      draw();
    }

    function draw() {
      const q = host.querySelector('#au-q').value.trim().toLowerCase();
      const entity = host.querySelector('#au-entity').value;
      const from = host.querySelector('#au-from').value;
      const to = host.querySelector('#au-to').value;
      const rows = all.filter((r) =>
        (!entity || r.entity === entity) &&
        (!from || String(r.at).slice(0, 10) >= from) &&
        (!to || String(r.at).slice(0, 10) <= to) &&
        (!q || (r.details || '').toLowerCase().includes(q) || (r.actorEmail || '').toLowerCase().includes(q)));
      host.querySelector('#au-table').innerHTML = `
        <table class="data-table sticky-head">
          <thead><tr><th>الوقت</th><th>المستخدم</th><th>العملية</th><th>القسم</th><th>التفاصيل</th></tr></thead>
          <tbody>${rows.length ? rows.slice(0, 500).map((r) => `<tr>
            <td>${esc(r.at ? new Date(r.at).toLocaleString('en-GB') : '—')}</td>
            <td dir="ltr">${esc(r.actorEmail || '—')}</td>
            <td>${esc(r.action || '')}</td><td>${esc(r.entity || '')}</td>
            <td class="small">${esc(r.details || '')}</td>
            
          </tr>`).join('') : `<tr><td colspan="5" class="empty">لا توجد عمليات مطابقة</td></tr>`}</tbody>
        </table>`;
    }

    host.querySelector('#au-q').addEventListener('input', draw);
    host.querySelector('#au-entity').addEventListener('change', draw);
    host.querySelector('#au-from').addEventListener('change', draw);
    host.querySelector('#au-to').addEventListener('change', draw);
    host.querySelector('#au-clear').addEventListener('click', () => {
      ['#au-q', '#au-from', '#au-to'].forEach((s) => { host.querySelector(s).value = ''; });
      host.querySelector('#au-entity').value = '';
      draw();
    });
    host.querySelector('#au-reload').addEventListener('click', () => { load(); toast('تم التحديث', 'ok'); });
    await load();
  }
  App.registerView('audit', renderAudit);
})(window);
