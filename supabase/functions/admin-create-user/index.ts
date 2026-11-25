// ============================================================================
// Agrima ERP — Edge Function: admin-create-user
// ---------------------------------------------------------------------------
// الغرض: إنشاء حساب مستخدم جديد وتأكيد بريده الإلكتروني تلقائيًا وتعيين
// دوره — من داخل التطبيق وبواسطة مدير النظام فقط، دون فتح لوحة Supabase.
//
// الأمان (بالترتيب):
//   1) المفتاح المستخدم للاتصال من المتصفح هو Publishable Key فقط —
//      Service Role Key موجود هنا داخل بيئة الدالة (Secrets) ولا يظهر
//      لأي عميل إطلاقًا.
//   2) المفتاح السري لا يُستخدم إلا بعد التحقق من أن صاحب الطلب جلسة
//      صالحة لمدير نظام نشط (profiles.role = 'admin' AND active).
//   3) verify_jwt مفعّل افتراضيًا عند النشر — أي طلب بلا JWT صالح لا
//      يصل إلى الكود أصلًا.
//   4) لا يعمل التسجيل العام عبر هذه الدالة — لا إنشاء حسابات من غير
//      مدير، ولا تجاوز ممكن عبر تعديل الواجهة أو إرسال طلبات مباشرة.
//   5) كلمات المرور لا تُخزن إلا في auth.users (هاش bcrypt داخلي) —
//      لا تظهر نصًا عاديًا في أي جدول.
//
// النشر (من مجلد المشروع):
//   supabase functions deploy admin-create-user \
//     --project-ref kcaertzyohhtcftlahcp
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

Deno.serve(async (req: Request) => {
  /* preflight CORS للاتصال من صفحات GitHub Pages */
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  try {
    /* ---------- 1) التحقق من هوية صاحب الطلب ---------- */
    const authHeader = req.headers.get('Authorization') || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token) return json({ error: 'مطلوب رمز الجلسة (Authorization)' }, 401);

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );

    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userData?.user) {
      return json({ error: 'جلسة غير صالحة — سجّل الدخول من جديد' }, 401);
    }
    const caller = userData.user;

    /* ---------- 2) صاحب الطلب مدير نظام نشط؟ ---------- */
    const { data: prof, error: profErr } = await admin
      .from('profiles')
      .select('role, active, email')
      .eq('id', caller.id)
      .maybeSingle();

    if (profErr) return json({ error: 'تعذر التحقق من الصلاحيات' }, 500);
    if (!prof || prof.role !== 'admin' || prof.active === false) {
      /* تسجيل المحاولة المخالفة للسجل الأمني */
      await admin.from('audit_logs').insert({
        sid: crypto.randomUUID(),
        actor: caller.id,
        actor_email: caller.email ?? null,
        entity: 'user',
        action: 'admin-create-user-denied',
        details: `محاولة إنشاء مستخدم من غير مدير: ${caller.email ?? caller.id}`,
        origin: 'edge',
      }).then(() => null, () => null);
      return json({ error: 'هذه العملية متاحة لمدير النظام فقط' }, 403);
    }

    /* ---------- 3) فحص صحة البيانات قبل الحفظ ---------- */
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return json({ error: 'جسم الطلب غير صالح' }, 400);
    }

    const email = String(body.email ?? '').trim().toLowerCase();
    const password = String(body.password ?? '');
    const fullName = String(body.full_name ?? '').trim().slice(0, 120);
    const role = String(body.role ?? '');

    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!EMAIL_RE.test(email)) {
      return json({ error: 'البريد الإلكتروني غير صالح' }, 400);
    }
    if (password.length < 8 || password.length > 72) {
      return json({ error: 'كلمة المرور 8 أحرف على الأقل (و72 كحد أقصى)' }, 400);
    }
    if (!['admin', 'warehouse'].includes(role)) {
      return json({ error: 'الدور يجب أن يكون admin أو warehouse' }, 400);
    }

    /* ---------- 4) إنشاء الحساب مع تأكيد البريد تلقائيًا ---------- */
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // ← تأكيد فوري: المستخدم يدخل مباشرة بلا بريد
      user_metadata: { full_name: fullName },
      ban_duration: '0s',
    });

    if (createErr) {
      const msg = createErr.message || 'تعذر إنشاء الحساب';
      const status = /already|registered|exists/i.test(msg) ? 409 : 400;
      return json({ error: msg }, status);
    }
    if (!created?.user?.id) {
      return json({ error: 'لم تُرجع خدمة الحسابات معرف المستخدم' }, 500);
    }

    /* ---------- 5) حفظ الملف والدور في profiles ---------- */
    const { error: upsertErr } = await admin
      .from('profiles')
      .upsert(
        {
          id: created.user.id,
          email,
          full_name: fullName,
          role,
          active: true,
        },
        { onConflict: 'id' },
      );

    if (upsertErr) {
      /* الحساب أُنشئ لكن الملف فشل — رسالة واضحة بدل فشل صامت */
      return json({
        error: `أُنشئ الحساب لكن فشل حفظ الدور: ${upsertErr.message}. أعد المحاولة أو حدّد الدور من شاشة المستخدمين.`,
        user: { id: created.user.id, email },
      }, 500);
    }

    /* ---------- 6) سجل تدقيق غير قابل للتعديل ---------- */
    await admin.from('audit_logs').insert({
      sid: crypto.randomUUID(),
      actor: caller.id,
      actor_email: caller.email ?? null,
      entity: 'user',
      action: 'user-create',
      entity_id: created.user.id,
      after: { email, role, full_name: fullName, email_confirmed: true },
      details: `إنشاء حساب ${email} بدور ${role === 'admin' ? 'مدير نظام' : 'أمين مخزن'} مع تأكيد البريد تلقائيًا`,
      origin: 'edge',
    }).then(() => null, () => null);

    return json({
      user: {
        id: created.user.id,
        email,
        role,
        full_name: fullName,
        email_confirmed: true,
      },
    });
  } catch (e) {
    console.error('[admin-create-user]', e);
    return json({ error: 'خطأ غير متوقع في الخدمة' }, 500);
  }
});
