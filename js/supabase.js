/* =========================================================================
   supabase.js — إعداد الاتصال بـ Supabase (نقطة واحدة لكل التطبيق)
   -------------------------------------------------------------------------
   • يستخدم المكتبة الرسمية المحلية vendor/supabase.js (تعمل بعد تنزيلها
     مرة واحدة — لا اعتماد على CDN عند التشغيل).
   • Publishable Key فقط — لا يوجد ولا يجوز وجود أي Service Role Key في
     هذا المستودع. الحماية الفعلية: Supabase Auth + سياسات RLS على مستوى
     قاعدة البيانات (انظر sql/rls-policies.sql).
   • الاتصال يُنشأ مرة واحدة؛ تعمل بقية الوحدات عبر SB.client().
   • بدون إنترنت: يبقى الكائن جاهزًا وعمليات الشبكة تفشل بهدوء —
     التطبيق يستمر على IndexedDB المحلي كما هو.
   ========================================================================= */
(function (global) {
  'use strict';

  const SUPABASE_URL = 'https://mhobdjqbpsjmbvjditti.supabase.co';
  const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_BnjxcTO5wkVUhCRdpBtDnw_UyPA6RCS';

  let _client = null;

  function available() {
    return !!(global.supabase && typeof global.supabase.createClient === 'function');
  }

  function client() {
    if (!available()) return null;
    if (!_client) {
      try {
        _client = global.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
          auth: {
            /* الجلسة تُخزن محليًا لتعمل العودة للدخول بدون إنترنت */
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: false,
            storageKey: 'agrima_auth_session',
          },
          global: { headers: { 'X-Client-Info': 'agrima-erp/1.0' } },
        });
      } catch (e) {
        console.error('[supabase] init failed', e);
        _client = null;
      }
    }
    return _client;
  }

  /* رسالة خطأ عربية مفهومة من خطأ supabase-js */
  function humanError(e) {
    const msg = (e && (e.message || e.msg)) || String(e || '');
    if (/Failed to fetch|NetworkError|network/i.test(msg)) {
      return 'لا يوجد اتصال بالإنترنت — أعد المحاولة عند عودة الشبكة';
    }
    if (/Invalid login credentials/i.test(msg)) return 'البريد الإلكتروني أو كلمة المرور غير صحيحة';
    if (/Email not confirmed/i.test(msg)) return 'البريد الإلكتروني غير مؤكد — راجع بريدك أو تواصل مع مدير النظام';
    if (/User already registered|already exists/i.test(msg)) return 'هذا البريد مسجل بالفعل';
    if (/Password.*weak|at least/i.test(msg)) return 'كلمة المرور ضعيفة — استخدم 8 أحرف على الأقل مع أرقام ورموز';
    if (/rate limit|too many/i.test(msg)) return 'محاولات كثيرة — انتظر قليلًا ثم أعد المحاولة';
    if (/signup requires a valid password/i.test(msg)) return 'كلمة المرور مطلوبة (8 أحرف على الأقل)';
    if (/Invalid API key/i.test(msg)) return 'مفتاح المشروع غير صحيح — راجع إعداد js/supabase.js';
    return msg;
  }

  global.SB = { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, client, available, humanError };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.SB;
})(typeof window !== 'undefined' ? window : globalThis);
