/* =========================================================================
   permissions.js — نظام الصلاحيات: مدير النظام + أمين المخزن
   -------------------------------------------------------------------------
   الأدوار:
     admin     مدير النظام — كل الأقسام وكل العمليات دون استثناء.
     warehouse أمين المخزن — قراءة وطباعة فقط: الرصيد الحالي + أذون
                 اليوم والأمس بتوقيت مصر Africa/Cairo. ممنوع عليه أي
                 إضافة/تعديل/حذف/اعتماد/تصدير/استيراد/نسخ احتياطي/إعدادات.
     local     وضع محلي (دون إنترنت وبلا جلسة محفوظة) — يعمل على بيانات
                 هذا الجهاز فقط كما كان التطبيق يعمل سابقًا، بدون أي وصول
                 للسحابة ولا مزامنة. يظهر هذا الخيار فقط عندما يكون الجهاز
                 غير متصل بالإنترنت.
     none      حساب بلا دور (بعد التسجيل وقبل موافقة المدير) أو حساب
                 موقوف — صفر وصول.
   المصدر الرسمي للدور هو Supabase (profiles.role) وتُفرض القيود هناك
   عبر RLS؛ هذه الوحدة تُطبّق نفس القواعد على الواجهة وتمنع الوصول
   للمسارات والأزرار.
   ========================================================================= */
(function (global) {
  'use strict';

  const ROLES = { ADMIN: 'admin', WAREHOUSE: 'warehouse', LOCAL: 'local', NONE: '' };

  /* ---------------- توقيت مصر Africa/Cairo ----------------
     كل حسابات «آخر يومين» تتم بتوقيت القاهرة وليس توقيت الجهاز. */

  /** تاريخ اليوم (ISO YYYY-MM-DD) بتوقيت القاهرة */
  function cairoToday(now) {
    const d = now ? new Date(now) : new Date();
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(d).reduce((m, p) => { m[p.type] = p.value; return m; }, {});
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  /** بداية نافذة أمين المخزن = تاريخ الأمس بتوقيت القاهرة (ISO) */
  function keeperWindowStart(now) {
    const d = now ? new Date(now) : new Date();
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(d).reduce((m, p) => { m[p.type] = p.value; return m; }, {});
    const dt = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) - 24 * 3600 * 1000);
    return dt.toISOString().slice(0, 10);
  }

  /** هل تاريخ الإذن (ISO) داخل نافذة اليومين المسموحة لأمين المخزن؟ */
  function inKeeperWindow(dateISO, now) {
    if (!dateISO) return false;
    const d = String(dateISO).slice(0, 10);
    return d >= keeperWindowStart(now) && d <= cairoToday(now);
  }

  /* ---------------- مصفوفة الصلاحيات ----------------
     مسارات التطبيق: من يحق له فتح كل مسار؟ يُفحص في navigate() —
     حتى لو عدّل المستخدم الرابط يدويًا لا يفتح مسارًا غير مسموح. */
  const ROUTE_ACCESS = {
    admin: 'all',
    local: 'all',
    warehouse: ['inventory', 'issuedocs', 'issuedoc'],
    '': [],
  };

  /* قدرات محددة تُفحص قبل كل زر كتابة (إضافة/تعديل/حذف/اعتماد…) */
  const CAPABILITIES = [
    'add',            // إضافة أي بيانات (بكر، حركات، أذون، عملاء، أصناف، حجوزات)
    'edit',           // تعديل أي بيانات
    'delete',         // حذف أي بيانات
    'approve',        // اعتماد أذون الصرف
    'settlement',     // تسويات الصرف
    'stockWrite',     // تعديل أرصدة المخزن
    'oldPermits',     // عرض أذون أقدم من آخر يومين
    'reports',        // التقارير العامة
    'customersView',  // عرض بيانات العملاء والحجوزات
    'usersManage',    // إدارة المستخدمين والصلاحيات
    'settings',       // الإعدادات
    'importExport',   // استيراد أو تصدير البيانات
    'backup',         // النسخ الاحتياطي أو الاستعادة
    'auditView',      // الاطلاع على سجل العمليات
    'sync',           // المزامنة (دفع البيانات للسحابة)
    'print',          // طباعة الإذن (مسموح لأمين المخزن)
  ];

  const MATRIX = {
    admin: CAPABILITIES.reduce((m, c) => { m[c] = true; return m; }, {}),
    local: CAPABILITIES.reduce((m, c) => { m[c] = c !== 'sync' && c !== 'oldPermits' ? true : (c === 'oldPermits'); return m; }, {}),
    /* أمين المخزن: عرض + بحث + طباعة فقط */
    warehouse: { print: true },
    '': {},
  };

  const state = { role: null, userId: null, email: null, fullName: null, active: true };

  function setProfile(p) {
    state.role = p && p.role != null ? p.role : ROLES.NONE;
    state.userId = p && p.id ? p.id : null;
    state.email = p && p.email ? p.email : null;
    state.fullName = p && p.fullName ? p.fullName : '';
    state.active = !p || p.active !== false;
    if (state.role === ROLES.ADMIN && !state.active) state.role = ROLES.NONE;
  }

  function role() { return state.role; }
  function isAdmin() { return state.role === ROLES.ADMIN; }
  function isWarehouse() { return state.role === ROLES.WAREHOUSE; }
  function isLocal() { return state.role === ROLES.LOCAL; }
  function signedIn() { return state.role === ROLES.ADMIN || state.role === ROLES.WAREHOUSE; }

  function can(cap) {
    const m = MATRIX[state.role];
    return !!(m && m[cap]);
  }

  /** هل يحق للدور الحالي فتح المسار؟ */
  function routeAllowed(route) {
    const access = ROUTE_ACCESS[state.role];
    if (access === 'all') return true;
    if (!Array.isArray(access)) return false;
    return access.indexOf(route) >= 0;
  }

  /** القسم يعرض في القائمة الجانبية؟ */
  function navVisible(route) {
    return routeAllowed(route);
  }

  /* وصف الدور للعرض */
  function roleLabel(r) {
    const v = r == null ? state.role : r;
    return v === ROLES.ADMIN ? 'مدير النظام'
      : v === ROLES.WAREHOUSE ? 'أمين المخزن'
      : v === ROLES.LOCAL ? 'وضع محلي'
      : 'بدون صلاحيات';
  }

  global.PERM = {
    ROLES, CAPABILITIES, MATRIX, ROUTE_ACCESS, state,
    setProfile, role, isAdmin, isWarehouse, isLocal, signedIn,
    can, routeAllowed, navVisible, roleLabel,
    cairoToday, keeperWindowStart, inKeeperWindow,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.PERM;
})(typeof window !== 'undefined' ? window : globalThis);
