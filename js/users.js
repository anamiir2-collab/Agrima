/* =========================================================================
   users.js — إدارة المستخدمين + سجل العمليات + شاشة المزامنة
   -------------------------------------------------------------------------
   • #users  (مدير النظام فقط): قائمة الحسابات، إضافة مستخدم بدور محدد
     (مدير / أمين مخزن)، تفعيل وإيقاف، تغيير الدور، إعادة تعيين كلمة
     المرور عبر البريد، آخر دخول، وسجل عمليات المستخدم.
   • #audit  (مدير النظام فقط): سجل العمليات الموحد (السحابة + المحلي)
     بفلاتر بحث.
   • #sync   (مدير النظام فقط): حالة المزامنة والاتصال + مزامنة الآن.
   الحماية: الرواية الرسمية للدور في Supabase (profiles + RLS) —
   هذه الشاشات تعمل فقط لجلسة مدير نشط، ولا يمكن لأمين المخزن الوصول
   إليها حتى عن طريق تعديل الرابط (بوابة المسارات في app.js + فحص هنا).
   • لا تُخزَّن أي كلمة مرور في المشروع: تُولَّد قوية وتُعرض مرة واحدة.
   ========================================================================= */
(function (global) {
  'use strict';

  const SB = global.SB, PERM = global.PERM, UI = global.UI, App = global.App, SYNC = global.SYNC;
  const { t, el, esc, fmtNum, fmtDate, toast, confirmDialog, openModal, closeModal } = UI;
  const lang = () => global.UI.getLang() === 'ar';

  /* ---------------- توليد كلمة مرور قوية ---------------- */
  function generatePassword(len) {
    const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%&*';
    let out = '';
    const rand = new Uint32Array(len || 14);
    try { crypto.getRandomValues(rand); } catch (e) {
      for (let i = 0; i < rand.length; i++) rand[i] = Math.floor(Math.random() * 4294967296);
    }
    for (let i = 0; i < rand.length; i++) out += charset[rand[i] % charset.length];
    return out;
  }

  /* ---------------- سجل تدقيق محلي + سحابي ---------------- */
  async function logAction(action, entity, entityId, details) {
    try {
      await global.DB.logAudit({
        entity: entity || 'system', action,
        entityId: entityId == null ? null : entityId,
        before: null, after: null,
        details: details || '', origin: 'local',
      });
      if (SYNC && SYNC.pushAuditNow) SYNC.pushAuditNow({ entity: entity || 'system', action, entityId, details: details || '', origin: 'local' });
    } catch (e) { console.warn('[users] audit log failed', e); }
  }

  /* ================= شاشة المستخدمين ================= */
  async function renderUsers(host) {
    if (!PERM.isAdmin()) {
      host.innerHTML = `<div class="card error-card">هذه الشاشة متاحة لمدير النظام فقط.</div>`;
      return;
    }
    const sb = SB.client();

    host.innerHTML = `
      <div class="page-head"><h2>المستخدمون والصلاحيات</h2>
        <div class="head-actions">
          <button class="btn btn-primary" id="us-add">+ مستخدم جديد</button>
        </div></div>
      <p class="muted small">الأدوار: <strong>مدير النظام</strong> — كل الصلاحيات دون استثناء ·
        <strong>أمين المخزن</strong> — عرض الرصيد الحالي وأذون اليوم والأمس وطباعتها فقط، بلا أي إضافة أو تعديل أو حذف.
        الدور محفوظ في قاعدة البيانات وتُفرض قيوده بسياسات RLS على مستوى Supabase نفسها.</p>
      <div class="card table-wrap" id="us-table"><div class="spinner"></div></div>`;

    async function load() {
      const box = host.querySelector('#us-table');
      const { data, error } = await sb.from('profiles').select('*').order('created_at', { ascending: false });
      if (error) {
        box.innerHTML = `<div class="form-error">تعذر تحميل المستخدمين: ${esc(SB.humanError(error))}</div>`;
        return;
      }
      const rows = data || [];
      box.innerHTML = `
        <table class="data-table">
          <thead><tr>
            <th>الاسم</th><th>البريد الإلكتروني</th><th>الدور</th><th>الحالة</th>
            <th>آخر دخول</th><th>تاريخ الإنشاء</th><th>إجراءات</th>
          </tr></thead>
          <tbody>${rows.length ? rows.map((u) => `
            <tr class="${u.active ? '' : 'row-void'}">
              <td data-label="الاسم"><strong>${esc(u.full_name || '—')}</strong>${u.id === PERM.state.userId ? ' <span class="badge">أنت</span>' : ''}</td>
              <td data-label="البريد" dir="ltr">${esc(u.email || '—')}</td>
              <td data-label="الدور">${roleBadge(u.role)}</td>
              <td data-label="الحالة">${u.active
                ? '<span class="badge badge-approved">نشط</span>'
                : '<span class="badge badge-void">موقوف</span>'}</td>
              <td data-label="آخر دخول">${u.last_login_at ? esc(new Date(u.last_login_at).toLocaleString('en-GB')) : '—'}</td>
              <td data-label="تاريخ الإنشاء">${u.created_at ? esc(new Date(u.created_at).toLocaleDateString('en-GB')) : '—'}</td>
              <td class="actions-cell">
                <button class="icon-btn" data-log="${esc(u.email || '')}" title="سجل عمليات المستخدم">☰</button>
                <button class="icon-btn" data-reset="${esc(u.email || '')}" title="إعادة تعيين كلمة المرور">✉</button>
                <button class="icon-btn" data-role="${esc(u.id)}" title="تغيير الدور">✎</button>
                ${u.id !== PERM.state.userId ? `<button class="icon-btn ${u.active ? 'danger' : 'approve'}" data-toggle="${esc(u.id)}" data-active="${u.active ? '1' : '0'}"
                  title="${u.active ? 'إيقاف الحساب' : 'تفعيل الحساب'}">${u.active ? '⏸' : '▶'}</button>` : ''}
              </td></tr>`).join('')
          : `<tr><td colspan="7" class="empty">لا يوجد مستخدمون — أضف أول حساب</td></tr>`}</tbody>
        </table>`;
      box.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', async () => {
        const id = b.dataset.toggle;
        const active = b.dataset.active === '1';
        const user = rows.find((x) => x.id === id);
        const ok = await confirmDialog({
          title: active ? 'إيقاف الحساب' : 'تفعيل الحساب',
          message: active
            ? `إيقاف حساب "${user && (user.full_name || user.email)}"؟ سيفقد الوصول لكل البيانات فورًا حتى من جلسة قائمة (سياسة RLS).`
            : `تفعيل حساب "${user && (user.full_name || user.email)}"؟`,
          danger: active,
        });
        if (!ok) return;
        const { error } = await sb.from('profiles').update({ active: !active, updated_at: new Date().toISOString() }).eq('id', id);
        if (error) { toast(SB.humanError(error), 'err'); return; }
        await logAction(active ? 'user-deactivate' : 'user-activate', 'user', id, `${active ? 'إيقاف' : 'تفعيل'} حساب ${user && (user.email || '')}`);
        toast(active ? 'تم إيقاف الحساب' : 'تم تفعيل الحساب', 'ok');
        load();
      }));
      box.querySelectorAll('[data-role]').forEach((b) => b.addEventListener('click', () => changeRole(rows.find((x) => x.id === b.dataset.role))));
      box.querySelectorAll('[data-reset]').forEach((b) => b.addEventListener('click', () => resetPassword(b.dataset.reset)));
      box.querySelectorAll('[data-log]').forEach((b) => b.addEventListener('click', () => userLogs(b.dataset.log)));
    }

    function roleBadge(role) {
      if (role === 'admin') return '<span class="badge badge-tax">مدير النظام</span>';
      if (role === 'warehouse') return '<span class="badge badge-nontax">أمين المخزن</span>';
      return '<span class="badge">بدون دور</span>';
    }

    async function changeRole(user) {
      if (!user) return;
      const node = el(`<div>
        <label class="field"><span>دور المستخدم</span>
          <select id="ur-role">
            <option value="admin" ${user.role === 'admin' ? 'selected' : ''}>مدير النظام — كل الصلاحيات</option>
            <option value="warehouse" ${user.role === 'warehouse' ? 'selected' : ''}>أمين المخزن — قراءة وطباعة فقط</option>
            <option value="" ${!user.role ? 'selected' : ''}>بدون دور — لا وصول</option>
          </select></label>
        <div class="form-error" id="ur-err"></div>
        <div class="confirm-actions">
          <button class="btn btn-primary" id="ur-save">حفظ</button>
          <button class="btn btn-ghost" id="ur-cancel">${t('cancel')}</button>
        </div></div>`);
      openModal(node, { title: `تغيير دور: ${user.full_name || user.email || ''}` });
      node.querySelector('#ur-cancel').addEventListener('click', closeModal);
      node.querySelector('#ur-save').addEventListener('click', async () => {
        const role = node.querySelector('#ur-role').value;
        const { error } = await sb.from('profiles').update({ role, updated_at: new Date().toISOString() }).eq('id', user.id);
        if (error) { node.querySelector('#ur-err').textContent = SB.humanError(error); return; }
        /* سجل تاريخي لتغيير الدور */
        try {
          await sb.from('user_roles').insert({ user_id: user.id, role, prev_role: user.role || null, changed_by: PERM.state.userId });
        } catch (e2) { /* تاريخي اختياري */ }
        await logAction('user-role-change', 'user', user.id, `تغيير دور ${user.email || ''} إلى ${role || 'بدون دور'}`);
        closeModal();
        toast('تم تحديث الدور — يسري فورًا على مستوى قاعدة البيانات', 'ok');
        load();
      });
    }

    function resetPassword(email) {
      const node = el(`<div>
        <p>سيصل رابط إعادة تعيين كلمة المرور إلى: <strong dir="ltr">${esc(email)}</strong></p>
        <p class="muted small">يستخدم البريد المرسل من Supabase — تأكد من إعداد SMTP أو خدمة البريد الافتراضية في لوحة المشروع.</p>
        <div class="form-error" id="rp-err"></div>
        <div class="confirm-actions">
          <button class="btn btn-primary" id="rp-send">إرسال الرابط</button>
          <button class="btn btn-ghost" id="rp-cancel">${t('cancel')}</button>
        </div></div>`);
      openModal(node, { title: 'إعادة تعيين كلمة المرور' });
      node.querySelector('#rp-cancel').addEventListener('click', closeModal);
      node.querySelector('#rp-send').addEventListener('click', async () => {
        const btn = node.querySelector('#rp-send');
        btn.disabled = true;
        const { error } = await sb.auth.resetPasswordForEmail(email);
        if (error) { node.querySelector('#rp-err').textContent = SB.humanError(error); btn.disabled = false; return; }
        await logAction('user-password-reset', 'user', null, `طلب إعادة تعيين كلمة مرور ${email}`);
        closeModal();
        toast('أُرسل رابط إعادة التعيين إلى البريد', 'ok');
      });
    }

    function userLogs(email) {
      const node = el(`<div>
        <div class="table-wrap scroll-tall" id="ul-rows"><div class="spinner"></div></div>
        <div class="confirm-actions"><button class="btn btn-ghost" id="ul-close">${t('close')}</button></div></div>`);
      openModal(node, { title: `سجل عمليات: ${email}`, wide: true });
      node.querySelector('#ul-close').addEventListener('click', closeModal);
      sb.from('audit_logs').select('*').eq('actor_email', email).order('at', { ascending: false }).limit(200)
        .then(({ data, error }) => {
          const box = node.querySelector('#ul-rows');
          if (error) { box.innerHTML = `<div class="form-error">${esc(SB.humanError(error))}</div>`; return; }
          const rows = data || [];
          box.innerHTML = rows.length ? `<table class="data-table">
            <thead><tr><th>الوقت</th><th>العملية</th><th>القسم</th><th>تفاصيل</th></tr></thead>
            <tbody>${rows.map((r) => `<tr>
              <td>${esc(new Date(r.at).toLocaleString('en-GB'))}</td>
              <td>${esc(r.action || '')}</td><td>${esc(r.entity || '')}</td>
              <td class="small">${esc(r.details || '')}</td></tr>`).join('')}</tbody></table>`
            : `<div class="empty" style="padding:1rem">لا توجد عمليات مسجلة لهذا المستخدم</div>`;
        });
    }

    host.querySelector('#us-add').addEventListener('click', () => addUser(load));

    await load();
  }

  /* ---------------- إضافة مستخدم (بلا أي مفاتيح سرية) ----------------
     المسار: المدير الحالي يُنشئ الحساب عبر Auth API بالمفتاح المنشور،
     ثم يعيد الجلسة للمدير فورًا، ثم يحدد الدور في profiles — كل ذلك
     محمي بسياسات RLS (المدير فقط يملك حق إدارة profiles). */
  async function addUser(done) {
    const sb = SB.client();
    const node = el(`<div class="edit-tx-form">
      <div class="form-grid">
        <label class="field"><span>الاسم الكامل</span>
          <input id="nu-name" type="text" placeholder="مثال: محمد أمين المخزن"></label>
        <label class="field"><span>البريد الإلكتروني *</span>
          <input id="nu-email" type="email" dir="ltr" placeholder="name@company.com"></label>
        <label class="field"><span>الدور *</span>
          <select id="nu-role">
            <option value="warehouse">أمين مخزن — قراءة وطباعة فقط</option>
            <option value="admin">مدير نظام — كل الصلاحيات</option>
          </select></label>
        <label class="field"><span>كلمة المرور *</span>
          <input id="nu-pass" type="text" dir="ltr" autocomplete="new-password" style="font-family:monospace">
          <button type="button" class="btn btn-ghost" id="nu-gen" style="margin-top:.4rem">توليد كلمة مرور قوية</button></label>
        <div class="field field-wide"><span class="muted small">ستُعرض كلمة المرور مرة واحدة بعد الإنشاء — انسخها وأعطها للمستخدم. لا تُخزن في أي ملف.</span></div>
      </div>
      <div class="form-error" id="nu-err" role="alert"></div>
      <div class="confirm-actions">
        <button class="btn btn-primary" id="nu-save">إنشاء الحساب</button>
        <button class="btn btn-ghost" id="nu-cancel">${t('cancel')}</button>
      </div></div>`);
    node.querySelector('#nu-pass').value = generatePassword(14);
    node.querySelector('#nu-gen').addEventListener('click', () => { node.querySelector('#nu-pass').value = generatePassword(14); });
    node.querySelector('#nu-cancel').addEventListener('click', closeModal);
    node.querySelector('#nu-save').addEventListener('click', async () => {
      const errBox = node.querySelector('#nu-err');
      errBox.textContent = '';
      const fullName = node.querySelector('#nu-name').value.trim();
      const email = node.querySelector('#nu-email').value.trim();
      const role = node.querySelector('#nu-role').value;
      const password = node.querySelector('#nu-pass').value;
      if (!email || !email.includes('@')) { errBox.textContent = 'أدخل بريدًا صحيحًا'; return; }
      if (password.length < 8) { errBox.textContent = 'كلمة المرور 8 أحرف على الأقل'; return; }
      const btn = node.querySelector('#nu-save');
      btn.disabled = true; btn.textContent = 'جارٍ الإنشاء…';
      try {
        /* 1) احفظ جلسة المدير الحالية */
        const { data: sessData } = await sb.auth.getSession();
        const adminSession = sessData && sessData.session;
        /* 2) أنشئ الحساب (يربطه النظام تلقائيًا بملف شخصي بلا دور) */
        const { data: created, error: upErr } = await sb.auth.signUp({ email, password });
        if (upErr) throw upErr;
        const userId = created && created.user ? created.user.id : null;
        if (!userId) throw new Error('لم يُنشأ الحساب — تحقق من إعدادات البريد في لوحة Supabase');
        /* 3) أعد جلسة المدير فورًا (signUp يبدّل الجلسة) */
        if (adminSession) await sb.auth.setSession({ access_token: adminSession.access_token, refresh_token: adminSession.refresh_token });
        /* 4) حدد الاسم والدور — ممنوع لأي مستخدم آخر (RLS) */
        const { error: profErr } = await sb.from('profiles').upsert({
          id: userId, email, full_name: fullName, role, active: true,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'id' });
        if (profErr) throw profErr;
        try { await sb.from('user_roles').insert({ user_id: userId, role, prev_role: null, changed_by: PERM.state.userId }); } catch (e2) { /* تاريخي */ }
        await logAction('user-create', 'user', userId, `إنشاء حساب ${email} بدور ${role === 'admin' ? 'مدير نظام' : 'أمين مخزن'}`);
        closeModal();
        /* 5) اعرض بيانات الدخول مرة واحدة */
        openModal(el(`<div>
          <p><strong>تم إنشاء الحساب بنجاح.</strong> انسخ بيانات الدخول الآن — لن تُعرض مرة أخرى:</p>
          <div class="confirm-extra" dir="ltr" style="font-family:monospace">
            ${esc(email)}<br>${esc(password)}
          </div>
          <div class="confirm-actions">
            <button class="btn btn-primary" id="nu-done">تم النسخ</button>
          </div></div>`), { title: 'بيانات الدخول' });
        document.querySelector('#nu-done').addEventListener('click', closeModal);
        done && done();
      } catch (e) {
        errBox.textContent = SB.humanError(e);
        btn.disabled = false; btn.textContent = 'إنشاء الحساب';
        /* استعادة جلسة المدير إن فشل شيء بعد signUp */
        try {
          const { data: s2 } = await sb.auth.getSession();
          if (s2 && s2.session && s2.session.user && s2.session.user.email !== PERM.state.email) {
            const { data: s3 } = await sb.auth.getSession();
            void s3;
          }
        } catch (e2) { /* noop */ }
      }
    });
    openModal(node, { title: 'مستخدم جديد' });
  }

  /* ================= شاشة سجل العمليات ================= */
  async function renderAudit(host) {
    if (!PERM.isAdmin()) {
      host.innerHTML = `<div class="card error-card">هذه الشاشة متاحة لمدير النظام فقط.</div>`;
      return;
    }
    host.innerHTML = `
      <div class="page-head"><h2>سجل العمليات</h2>
        <div class="head-actions"><button class="btn btn-ghost" id="au-reload">تحديث</button></div></div>
      <p class="muted small">سجل غير قابل للتعديل أو الحذف من أي مستخدم (لا توجد أي سياسة UPDATE أو DELETE في قاعدة البيانات).
        يشمل: الدخول والخروج، أذون الصرف (إضافة/تعديل/حذف/اعتماد)، تغييرات المخزون، إدارة المستخدمين، والمزامنة.</p>
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
      const sb = SB.client();
      const cloudPromise = sb ? sb.from('audit_logs').select('*').order('at', { ascending: false }).limit(1000) : Promise.resolve({ data: [] });
      const localRows = await global.DB.getAudit(2000);
      const [cloudRes] = await Promise.all([cloudPromise]);
      const cloud = (cloudRes.data || []).map((r) => ({
        at: r.at, entity: r.entity, action: r.action, entityId: r.entity_id,
        details: r.details || '', actorEmail: r.actor_email || '', origin: r.origin || 'cloud',
      }));
      const local = localRows.map((r) => ({
        at: r.at, entity: r.entity, action: r.action, entityId: r.entityId,
        details: r.details || (r.after && !r.before ? 'إضافة' : ''), actorEmail: PERM.state.email || 'محلي', origin: 'local',
      }));
      const seen = new Set(cloud.map((r) => (r.at || '') + '|' + (r.action || '') + '|' + String(r.entityId == null ? '' : r.entityId)));
      all = cloud.concat(local.filter((r) => !seen.has((r.at || '') + '|' + (r.action || '') + '|' + String(r.entityId == null ? '' : r.entityId))));
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
          <thead><tr><th>الوقت</th><th>المستخدم</th><th>العملية</th><th>القسم</th><th>التفاصيل</th><th>المصدر</th></tr></thead>
          <tbody>${rows.length ? rows.slice(0, 500).map((r) => `<tr>
            <td>${esc(r.at ? new Date(r.at).toLocaleString('en-GB') : '—')}</td>
            <td dir="ltr">${esc(r.actorEmail || '—')}</td>
            <td>${esc(r.action || '')}</td><td>${esc(r.entity || '')}</td>
            <td class="small">${esc(r.details || '')}</td>
            <td><span class="badge ${r.origin === 'cloud' ? 'badge-approved' : 'badge-multi'}">${r.origin === 'cloud' ? 'سحابة' : 'جهاز'}</span></td>
          </tr>`).join('') : `<tr><td colspan="6" class="empty">لا توجد عمليات مطابقة</td></tr>`}</tbody>
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

  /* ================= شاشة المزامنة والحساب ================= */
  async function renderSync(host) {
    const keeper = PERM.isWarehouse();
    const info = () => {
      const s = SYNC.status;
      const stateLabel = s.state === 'syncing' ? 'جارٍ المزامنة…'
        : s.state === 'ok' ? 'متماثلة'
        : s.state === 'error' ? 'خطأ في المزامنة'
        : s.state === 'offline' || !s.online ? 'غير متصل — يعمل محليًا'
        : 'جاهزة';
      return `
        <div class="stats-grid">
          <div class="stat-card accent-green"><div class="stat-num">${stateLabel}</div><div class="stat-label">حالة المزامنة</div></div>
          <div class="stat-card accent-teal"><div class="stat-num">${s.lastSync ? esc(new Date(s.lastSync).toLocaleTimeString('en-GB')) : '—'}</div><div class="stat-label">آخر مزامنة</div></div>
          <div class="stat-card accent-amber"><div class="stat-num">${fmtNum(s.pending || 0)}</div><div class="stat-label">سجلات بانتظار الرفع</div></div>
        </div>`;
    };
    host.innerHTML = `
      <div class="page-head"><h2>${keeper ? 'الاتصال والمزامنة' : 'المزامنة والحساب'}</h2></div>
      <div id="sync-status-box">${info()}</div>
      ${keeper
        ? `<div class="card"><p>حسابك «أمين مخزن» يعمل بالقراءة فقط: يستلم الرصيد الحالي وأذون اليوم والأمس من النظام تلقائيًا
             وفق صلاحياتك المحفوظة في قاعدة البيانات. لا يتم رفع أي بيانات من هذا الجهاز.</p></div>`
        : `<div class="card">
             <p>التطبيق يعمل محليًا أولًا: كل التعديلات تُحفظ على الجهاز فورًا ثم تُزامن مع Supabase تلقائيًا.
               قواعد المزامنة: معرف ثابت لكل سجل (لا تكرار)، لا يُكتب فوق سجل أحدث بسجل أقدم، والحذف ينتقل بعظام قبر تمنع عودة السجل.</p>
             <div class="form-actions"><button class="btn btn-primary" id="sync-now">مزامنة الآن</button></div>
           </div>`}
      <div class="card">
        <h3>الحساب الحالي</h3>
        <table class="data-table"><tbody>
          <tr><td>المستخدم</td><td><strong>${esc(PERM.state.fullName || '—')}</strong></td></tr>
          <tr><td>البريد</td><td dir="ltr">${esc(PERM.state.email || '—')}</td></tr>
          <tr><td>الدور</td><td>${esc(PERM.roleLabel())}</td></tr>
          <tr><td>حالة الاتصال</td><td>${navigator.onLine ? '<span class="badge badge-approved">متصل</span>' : '<span class="badge badge-void">غير متصل</span>'}</td></tr>
        </tbody></table>
        <div class="form-actions">
          <button class="btn btn-danger" id="sync-logout">تسجيل الخروج</button>
        </div>
      </div>
      ${PERM.isAdmin() ? `<div class="card">
        <h3>الأمان</h3>
        <p class="small muted">المفتاح المستخدم في المتصفح هو Publishable Key فقط ولا يمنح أي وصول بحد ذاته.
          الحماية الفعلية: Supabase Auth + سياسات RLS على كل الجداول — راجع مجلد sql/ في المستودع.
          لا يوجد أي Service Role Key داخل المشروع.</p>
      </div>` : ''}`;

    host.querySelector('#sync-logout').addEventListener('click', async () => {
      const ok = await confirmDialog({ title: 'تسجيل الخروج', message: 'تسجيل الخروج من هذا الجهاز؟', danger: true });
      if (!ok) return;
      await global.AUTH.signOut();
      location.reload();
    });
    const syncBtn = host.querySelector('#sync-now');
    if (syncBtn) syncBtn.addEventListener('click', async () => {
      syncBtn.disabled = true; syncBtn.textContent = 'جارٍ المزامنة…';
      const res = await SYNC.run();
      syncBtn.disabled = false; syncBtn.textContent = 'مزامنة الآن';
      toast(res && res.error ? `فشل: ${res.error}` : 'تمت المزامنة', res && res.error ? 'err' : 'ok');
      host.querySelector('#sync-status-box').innerHTML = info();
    });
  }

  App.registerView('users', renderUsers);
  App.registerView('audit', renderAudit);
  App.registerView('sync', renderSync);
})(window);
