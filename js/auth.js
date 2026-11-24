/* =========================================================================
   auth.js — تسجيل الدخول/الخروج وإدارة الجلسة الآمنة
   -------------------------------------------------------------------------
   • شاشة دخول كاملة تظهر قبل أي بيانات (البوابة الأولى للتطبيق).
   • الجلسة تُخزَّن محليًا (Supabase Auth) فتعود للدخول دون إنترنت بالحساب
     نفسه مع دور المحفوظ — دون أي وصول للسحابة عند غياب الشبكة.
   • الدور يُقرأ من profiles (Supabase) ويُخزَّن نسخة محلية للعمل دون
     إنترنت — المصدر الرسمي هو قاعدة البيانات وتُفرض قيوده عبر RLS.
   • حساب بلا دور أو موقوف: شاشة واضحة ولا وصول لأي قسم.
   • «الدخول المحلي» متاح فقط عندما يكون الجهاز غير متصل — يعمل على بيانات
     الجهاز فقط بلا مزامنة (حفاظًا على العمل دون إنترنت كما كان سابقًا).
   • لا توجد أي كلمات مرور داخل ملفات المشروع.
   ========================================================================= */
(function (global) {
  'use strict';

  const PERM = global.PERM, SB = global.SB;
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const PROFILE_KEY = 'agrima_profile_cache';
  const listeners = [];
  let _session = null;
  let _resolved = false;

  function on(fn) { listeners.push(fn); }
  function emit(evt) { listeners.forEach((f) => { try { f(evt); } catch (e) { console.error(e); } }); }

  /* ---------------- cache المحفظة الشخصية (للعمل دون إنترنت) ---------------- */
  function cacheProfile(p) {
    try { localStorage.setItem(PROFILE_KEY, JSON.stringify({ p, at: Date.now() })); } catch (e) { /* private mode */ }
  }
  function cachedProfile() {
    try {
      const raw = localStorage.getItem(PROFILE_KEY);
      if (!raw) return null;
      const o = JSON.parse(raw);
      return o && o.p ? o.p : null;
    } catch (e) { return null; }
  }
  function cachedProfileFor(userId) {
    const p = cachedProfile();
    return p && (!userId || p.id === userId) ? p : null;
  }

  /* ---------------- شاشة الدخول ---------------- */
  function overlay() {
    let ov = document.getElementById('auth-gate');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'auth-gate';
      document.body.appendChild(ov);
    }
    return ov;
  }
  function hideGate() {
    const ov = document.getElementById('auth-gate');
    if (ov) ov.remove();
  }
  function setAppVisibility(visible) {
    const shell = document.querySelector('.app-shell');
    if (shell) shell.style.visibility = visible ? '' : 'hidden';
  }

  function renderGate(state0, message) {
    setAppVisibility(false);
    const ov = overlay();
    const offline = !navigator.onLine;
    const noLib = !SB.available();
    ov.innerHTML = `
      <div class="auth-scene">
        <div class="auth-card">
          <div class="auth-brand">
            <img src="assets/icons/icon-192.png" alt="" class="auth-logo">
            <div>
              <div class="auth-app">Agrima ERP</div>
              <div class="auth-sub">نظام إدارة المخزون والبكر وأذون الصرف</div>
            </div>
          </div>
          ${state0 === 'blocked'
            ? `<div class="auth-blocked">
                 <div class="auth-blocked-ic">⛔</div>
                 <h3>${esc(message || 'هذا الحساب لا يملك صلاحيات دخول')}</h3>
                 <p class="muted">تواصل مع مدير النظام لتفعيل حسابك ومنحك الدور المناسب
                 (مدير نظام أو أمين مخزن).</p>
                 <button class="btn btn-primary" id="auth-logout2">خروج</button>
               </div>`
            : `
          <h2 class="auth-title">تسجيل الدخول</h2>
          <p class="muted small auth-hint">الدخول بحسابك الممنوح من مدير النظام —
            كل صلاحياتك محفوظة في قاعدة البيانات ومحمية بسياسات RLS.</p>
          <form id="auth-form" novalidate>
            <label class="field"><span>البريد الإلكتروني</span>
              <input id="auth-email" type="email" autocomplete="username" required dir="ltr" placeholder="name@company.com"></label>
            <label class="field"><span>كلمة المرور</span>
              <input id="auth-pass" type="password" autocomplete="current-password" required placeholder="••••••••"></label>
            <div class="form-error" id="auth-err" role="alert"></div>
            <button type="submit" class="btn btn-primary auth-btn" id="auth-submit">دخول</button>
          </form>
          ${offline ? `<div class="auth-offline-note">📡 الجهاز غير متصل بالإنترنت
              <button class="btn btn-outline auth-btn" id="auth-local">الدخول بوضع محلي (بيانات هذا الجهاز فقط)</button>
            </div>` : ''}
          ${noLib ? `<p class="muted small">تنبيه: مكتبة الاتصال غير محمّلة (ذاكرة قديمة) — حدّث الصفحة عند توفر الإنترنت.</p>` : ''}
          <div class="auth-foot">حماية بياناتك: Supabase Auth + سياسات RLS — المفتاح المنشور لا يمنح أي وصول بحد ذاته.</div>
          `}
        </div>
      </div>`;

    const form = ov.querySelector('#auth-form');
    if (form) {
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const errBox = ov.querySelector('#auth-err');
        errBox.textContent = '';
        const email = ov.querySelector('#auth-email').value.trim();
        const pass = ov.querySelector('#auth-pass').value;
        if (!email || !pass) { errBox.textContent = 'أدخل البريد وكلمة المرور'; return; }
        const btn = ov.querySelector('#auth-submit');
        btn.disabled = true; btn.textContent = 'جارٍ التحقق…';
        try {
          await signIn(email, pass);
        } catch (e) {
          errBox.textContent = SB.humanError(e);
          btn.disabled = false; btn.textContent = 'دخول';
        }
      });
    }
    const localBtn = ov.querySelector('#auth-local');
    if (localBtn) localBtn.addEventListener('click', () => {
      PERM.setProfile({ role: PERM.ROLES.LOCAL, email: null, fullName: 'وضع محلي', active: true });
      _resolved = true;
      hideGate();
      setAppVisibility(true);
      emit({ type: 'local' });
    });
    const lg2 = ov.querySelector('#auth-logout2');
    if (lg2) lg2.addEventListener('click', () => signOut());
  }

  /* ---------------- تسجيل الدخول ---------------- */
  async function signIn(email, password) {
    const sb = SB.client();
    if (!sb) throw new Error('مكتبة الاتصال غير متاحة — حدّث الصفحة');
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    _session = data.session;
    const prof = await loadProfile(data.user);
    if (prof) cacheProfile(prof);
    applyProfile(prof);
    if (prof && prof.role) {
      try { await sb.rpc('app_record_login'); } catch (e) { /* best-effort */ }
    }
    return prof;
  }

  /* قراءة ملف المستخدم من قاعدة البيانات (المصدر الرسمي للدور) */
  async function loadProfile(user) {
    const sb = SB.client();
    if (!sb || !user) return null;
    const { data, error } = await sb.from('profiles').select('*').eq('id', user.id).maybeSingle();
    if (error) {
      console.warn('[auth] profile fetch failed — using cache', error.message);
      const cached = cachedProfileFor(user.id);
      return cached ? Object.assign(cached, { email: user.email, fromCache: true }) : null;
    }
    if (!data) {
      /* حساب أنشئ مباشرة في auth.users دون ملف شخصي */
      return { id: user.id, email: user.email, role: '', active: true, fullName: '' };
    }
    return {
      id: data.id, email: data.email || user.email, role: data.role || '',
      active: data.active !== false, fullName: data.full_name || '',
    };
  }

  function applyProfile(prof) {
    PERM.setProfile(prof || { role: PERM.ROLES.NONE });
    const blocked = !prof || !prof.role || prof.role === PERM.ROLES.NONE || prof.active === false;
    if (blocked) {
      _resolved = true;
      renderGate('blocked', prof && prof.active === false
        ? 'هذا الحساب موقوف من مدير النظام'
        : 'حسابك بانتظار منح الدور من مدير النظام');
      emit({ type: 'blocked' });
      return;
    }
    _resolved = true;
    hideGate();
    setAppVisibility(true);
    emit({ type: 'signed-in', profile: prof });
  }

  /* ---------------- استعادة الجلسة عند التشغيل ---------------- */
  async function restoreSession() {
    const sb = SB.client();
    if (!sb) return null;
    try {
      const { data } = await sb.auth.getSession();
      _session = data && data.session ? data.session : null;
      return _session;
    } catch (e) {
      console.warn('[auth] getSession failed (offline?)', e.message);
      return null;
    }
  }

  /**
   * بوابة التشغيل: تعرض شاشة الدخول أو تستعيد الجلسة المحفوظة.
   * تُرجع Promise تُحلّ بعد تحديد الدور نهائيًا.
   */
  async function ensureSignedIn() {
    const user = await restoreSession();
    if (user) {
      const prof = cachedProfileFor(user.user && user.user.id) || null;
      /* عرض سريع من الكاش ثم تحديث من الشبكة (يعمل حتى دون إنترنت) */
      if (prof) applyProfile(Object.assign({}, prof, { fromCache: true }));
      const fresh = await loadProfile(user.user);
      if (fresh) { cacheProfile(fresh); applyProfile(fresh); }
      else if (!prof) {
        /* لا كاش ولا شبكة: لا يمكن تحديد الدور — عرض شاشة الدخول مع تنبيه */
        renderGate('login', null);
        const errBox = document.querySelector('#auth-err');
        if (errBox) errBox.textContent = 'تعذر التحقق من حسابك — اتصل بالإنترنت مرة واحدة أو استخدم الدخول المحلي أدناه';
      }
      return;
    }
    renderGate('login', null);
    /* انتظار حتى يُحلّ الدخول */
    await new Promise((resolve) => {
      const check = setInterval(() => { if (_resolved) { clearInterval(check); resolve(); } }, 200);
    });
  }

  /* ---------------- تسجيل الخروج ---------------- */
  async function signOut() {
    const sb = SB.client();
    if (sb) { try { await sb.auth.signOut(); } catch (e) { /* offline: مسح محلي فقط */ } }
    _session = null;
    _resolved = false;
    try { localStorage.removeItem(PROFILE_KEY); } catch (e) { /* noop */ }
    PERM.setProfile({ role: PERM.ROLES.NONE });
    hideGate();
    renderGate('login', null);
    emit({ type: 'signed-out' });
  }

  /* تحديث حالة الاتصال: عند العودة أونلاين أعِد التحقق من الجلسة الموقوفة */
  function watchConnection() {
    window.addEventListener('online', async () => {
      const ov = document.getElementById('auth-gate');
      if (ov) { /* كان على شاشة الدخول والاتصال عاد — أعد الرسم لإخفاء زر الوضع المحلي */ renderGate('login', null); }
    });
    window.addEventListener('offline', () => {
      const ov = document.getElementById('auth-gate');
      if (ov) renderGate('login', null);
    });
  }

  global.AUTH = {
    ensureSignedIn, signIn, signOut, restoreSession,
    getSession: () => _session, currentUser: () => (_session && _session.user) || null,
    on, cacheProfile, loadProfile, watchConnection,
    get ready() { return _resolved; },
  };
})(window);
