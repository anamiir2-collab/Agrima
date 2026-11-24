/* =========================================================================
   tests/test-reservations-report.js — اختبار آلي للكشف الموحّد لحجوزات
   العملاء (جدول واحد للشاشة والطباعة).
   Run: node tests/test-reservations-report.js
   يغطي منطق الأرقام فقط (المحرك القائم غير ملموس): صف لكل بند، الإجماليات،
   التوزيع FCFS، التحويل بين العملاء بلا ازدواج، تحميل الكميات المحوّلة،
   الإلغاء الجزئي/الكلي، الإذن المحذوف، تصفية العملاء للطباعة، وباني الجدول.
   ========================================================================= */
'use strict';

/* ---------- بيئة المتصفح الدنيا لعمل reservations.js في Node ---------- */
const storeMap = new Map();
try {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { return { getItem: (k) => (storeMap.has(k) ? storeMap.get(k) : null), setItem: (k, v) => { storeMap.set(k, String(v)); }, removeItem: (k) => { storeMap.delete(k); }, clear: () => storeMap.clear() }; },
  });
} catch (e) { /* Node قد يوفّر localStorage افتراضيًا — نستخدمه كما هو */ }

require('../js/calculations.js'); /* → global CALC */
require('../js/ui.js');           /* → global UI */

const CALC = globalThis.CALC;

/* ---------- نسخة مبسّطة من مساعدات App القائمة (قراءة فقط) ---------- */
function productFamilyStub(name) {
  const value = String(name || '').replace(/[\s\u0640]+/g, ' ').trim().toLowerCase();
  if (value.includes('تست') && value.includes('لينر') && value.includes('معالج')) return 'تست لينر معالج';
  if (value.includes('توب') && value.includes('لاينر')) return 'توب لاينر';
  return String(name || '').trim();
}
function canonicalCustomerStub(name) {
  const v = String(name || '').replace(/[\s\u0640]+/g, '').toLowerCase();
  const isProd = v === 'انتاج' || v === 'الانتاج' || v === 'إنتاج' || v === 'الإنتاج';
  return isProd ? 'الإنتاج' : String(name || '').trim();
}

const stockMap = new Map(); /* comboKey → net */
const vouchersList = [];    /* أذون صرف (شكل collectVouchers الموحّد) */

globalThis.App = {
  state: { transactions: [], permits: [], products: [], settings: { weightFactor: 7.5 } },
  balanceOf(quality, gsm, size) {
    const key = CALC.comboKey(quality, gsm, size);
    return { quality, gsm, size, add: stockMap.get(key) || 0, out: 0, net: stockMap.get(key) || 0 };
  },
  collectVouchers(transactions, permits) { return vouchersList.slice(); },
  canonicalCustomer: canonicalCustomerStub,
  productFamily: productFamilyStub,
  /* نقاط ربط الواجهة — لا تستخدمها هذه الاختبارات لكن التحميل يحتاجها */
  views: {},
  registerView(name, fn) { this.views[name] = fn; },
  currentRoute: () => 'reservations',
  navigate: () => {},
  rerender: () => {},
};

/* الآن يمكن تحميل reservations.js (يستخدم App.stub أعلاه) */
const RESV = require('../js/reservations.js');
const Store = RESV.Store;
const uid = RESV.uid;

/* ---------- أدوات الاختبار ---------- */
let pass = 0, fail = 0;
async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log('  ✓ ' + name);
  } catch (e) {
    fail++;
    console.error('  ✗ ' + name + ' — ' + (e && e.message ? e.message : e));
  }
}
function eq(actual, expected, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error((msg || 'mismatch') + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}
function ok(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

/* ---------- بناء بيانات الاختبار ---------- */
const Q_TEST = 'تست لينر معالج', Q_TOP = 'توب لاينر';
function setStock(quality, gsm, size, net) { stockMap.set(CALC.comboKey(quality, gsm, size), net); }
function resetStore() {
  storeMap.clear();
  stockMap.clear();
  vouchersList.length = 0;
  globalThis.App.state.transactions = [];
}
function addReservation({ id, seq, customer, createdAt, date, items, cancelled }) {
  const rec = {
    id, seq, customer, createdAt, date: date || '2025-01-01',
    notes: '', cancelled: !!cancelled,
    items: items.map((it, i) => ({
      id: it.id || (id + '_i' + (i + 1)),
      quality: it.quality, gsm: it.gsm, size: it.size,
      qtyRequired: it.qty,
    })),
  };
  Store.saveOne('reservations', rec);
  return rec;
}
function addVoucher({ key, no, customer, date, lines }) {
  vouchersList.push({
    key, kind: 'permit', permitId: key, status: 'approved',
    permitNo: no, cls: 'ض', customer, date, notes: '',
    lines: lines.map((l) => ({ quality: l.quality, family: productFamilyStub(l.quality), gsm: l.gsm, weight: null, size: l.size, qty: l.qty, reelCount: 0, reelIds: [], weightKg: null, weightEstimated: false })),
    rows: [], rowIds: [], groupId: null, source: 'permit',
    totalRolls: lines.reduce((s, l) => s + l.qty, 0), totalWeightKg: null,
    weightEstimated: true, minId: 0, createdAt: date,
  });
}
function addLink({ id, reservation, itemId, voucher, lineIndex, loadedQty, covers, transferId }) {
  Store.saveOne('links', {
    id, reservationId: reservation.id, reservationSeq: reservation.seq, customer: reservation.customer,
    itemId, voucherKey: voucher.key, voucherKind: 'permit', voucherPermitId: voucher.key,
    voucherNo: voucher.permitNo, voucherCls: 'ض', voucherDate: voucher.date, voucherCustomer: voucher.customer,
    lineIndex, lineQty: voucher.lines[lineIndex].qty,
    matched: { quality: reservation.items[0].quality, gsm: reservation.items[0].gsm, size: reservation.items[0].size },
    loadedQty, covers: covers || 'remaining', transferId: transferId || null,
    notes: '', linkedAt: '2025-02-01T00:00:00Z',
  });
}

/* ========================================================================= */
(async () => {
  console.log('\n=== اختبار الكشف الموحّد لحجوزات العملاء ===\n');

  /* ---------- 1) عميل ببند واحد ---------- */
  await test('عميل ببند واحد: صف واحد — عدد البكر/المتاح/المحمّل صحيحة', async () => {
    resetStore();
    setStock(Q_TEST, 120, 110, 100);
    const r1 = addReservation({ id: 'r1', seq: 1, customer: 'عميل أ', createdAt: '2025-01-01T10:00:00Z', items: [{ quality: Q_TEST, gsm: 120, size: 110, qty: 60 }] });
    const rows = RESV.reservationReportRows(null);
    eq(rows.length, 1, 'row count');
    eq([rows[0].customer, rows[0].qty, rows[0].available, rows[0].loaded], ['عميل أ', 60, 60, 0], 'row values');
    const t = RESV.reservationReportTotals(rows);
    eq([t.qty, t.available, t.loaded, t.count], [60, 60, 0, 1], 'totals');
  });

  /* ---------- 2) عميل بعدة أنواع/مقاسات + FCFS ---------- */
  await test('عميل بعدة بنود + توزيع FCFS بين عميلين (المحجوز لآخر لا يُعاد)', async () => {
    resetStore();
    setStock(Q_TEST, 120, 110, 100);
    setStock(Q_TOP, 140, 110, 10);
    addReservation({ id: 'r1', seq: 1, customer: 'عميل أ', createdAt: '2025-01-01T10:00:00Z', items: [{ quality: Q_TEST, gsm: 120, size: 110, qty: 60 }] });
    addReservation({ id: 'r2', seq: 2, customer: 'عميل ب', createdAt: '2025-01-02T10:00:00Z', items: [
      { quality: Q_TEST, gsm: 120, size: 110, qty: 80 },
      { quality: Q_TOP, gsm: 140, size: 110, qty: 5 },
    ] });
    const rows = RESV.reservationReportRows(null);
    eq(rows.length, 3, 'one row per item');
    eq(rows.map((x) => [x.customer, x.qty, x.available]), [
      ['عميل أ', 60, 60], ['عميل ب', 80, 40], ['عميل ب', 5, 5],
    ], 'FCFS rows (80 requested → only 40 left in stock)');
    const t = RESV.reservationReportTotals(rows);
    eq([t.qty, t.available, t.loaded], [145, 105, 0], 'totals across rows');
  });

  /* ---------- 3) التحويل بين العملاء: لا ازدواج ---------- */
  await test('تحويل 30 من عميل أ إلى عميل ج: لا صف جديد لج ولا تضاعف في الإجماليات', async () => {
    resetStore();
    setStock(Q_TEST, 120, 110, 100);
    const r1 = addReservation({ id: 'r1', seq: 1, customer: 'عميل أ', createdAt: '2025-01-01T10:00:00Z', items: [{ quality: Q_TEST, gsm: 120, size: 110, qty: 60 }] });
    addReservation({ id: 'r2', seq: 2, customer: 'عميل ج', createdAt: '2025-01-02T10:00:00Z', items: [{ quality: Q_TEST, gsm: 120, size: 110, qty: 10 }] });
    Store.saveOne('transfers', {
      id: 't1', fromReservationId: r1.id, fromReservationSeq: 1, fromCustomer: r1.customer,
      toCustomer: 'عميل ج', toReservationId: null,
      itemId: r1.items[0].id, quality: Q_TEST, gsm: 120, size: 110,
      qty: 30, date: '2025-01-05', notes: '', status: 'active', cancelReason: '',
      createdAt: '2025-01-05T00:00:00Z',
    });
    const rows = RESV.reservationReportRows(null);
    eq(rows.length, 2, 'no extra row for the receiving customer');
    eq(rows.map((x) => [x.customer, x.qty, x.available, x.loaded]), [
      ['عميل أ', 60, 30, 0], ['عميل ج', 10, 10, 0],
    ], 'transferred qty stays in source row only (60 = 30 loaded-later + 30 remaining)');
    const t = RESV.reservationReportTotals(rows);
    eq(t.qty, 70, 'total qty NOT doubled (70, not 100)');
  });

  /* ---------- 4) المحمّل: الكمية المحوّلة تُحسب فقط إذا حُمّلت فعليًا ---------- */
  await test('تحميل الكمية المحوّلة عبر إذن مرتبط يحسب للمصدر — غير المحمّل لا يُحسب', async () => {
    resetStore();
    setStock(Q_TEST, 120, 110, 100);
    const r1 = addReservation({ id: 'r1', seq: 1, customer: 'عميل أ', createdAt: '2025-01-01T10:00:00Z', items: [{ quality: Q_TEST, gsm: 120, size: 110, qty: 60 }] });
    addReservation({ id: 'r2', seq: 2, customer: 'عميل ج', createdAt: '2025-01-02T10:00:00Z', items: [{ quality: Q_TEST, gsm: 120, size: 110, qty: 10 }] });
    const tr = {
      id: 't1', fromReservationId: r1.id, fromReservationSeq: 1, fromCustomer: r1.customer,
      toCustomer: 'عميل ج', toReservationId: null,
      itemId: r1.items[0].id, quality: Q_TEST, gsm: 120, size: 110,
      qty: 30, date: '2025-01-05', notes: '', status: 'active', cancelReason: '',
      createdAt: '2025-01-05T00:00:00Z',
    };
    Store.saveOne('transfers', tr);
    const v1 = { key: 'PT|v1', permitNo: 'ض-101', customer: 'عميل ج', date: '2025-01-06', lines: [{ quality: Q_TEST, gsm: 120, size: 110, qty: 30 }] };
    addVoucher(v1);
    /* 20 حُمّلت فعليًا من الكمية المحوّلة + 10 من متبقي البند نفسه */
    addLink({ id: 'l1', reservation: r1, itemId: r1.items[0].id, voucher: v1, lineIndex: 0, loadedQty: 20, covers: 'transfer', transferId: tr.id });
    addLink({ id: 'l2', reservation: r1, itemId: r1.items[0].id, voucher: v1, lineIndex: 0, loadedQty: 10, covers: 'remaining' });
    const rows = RESV.reservationReportRows(null);
    eq(rows.map((x) => [x.customer, x.qty, x.available, x.loaded]), [
      ['عميل أ', 60, 20, 30], ['عميل ج', 10, 10, 0],
    ], 'أ: loaded = 20 (transferred-load) + 10 (own) = 30; ج: received-by-transfer NOT counted again');
    const t = RESV.reservationReportTotals(rows);
    eq(t.loaded, 30, 'loaded counted exactly once');
    /* إلغاء التحويل → تعود الكمية غير المخصصة لمتاح المصدر (سلوك المحرك القائم)،
       والمحمّل الفعلي (30) يبقى كما هو لأن الروابط تاريخية */
    tr.status = 'cancelled';
    Store.saveOne('transfers', tr);
    const rows2 = RESV.reservationReportRows(null);
    eq(rows2.map((x) => [x.customer, x.qty, x.available, x.loaded]), [
      ['عميل أ', 60, 50, 30], ['عميل ج', 10, 10, 0],
    ], 'cancelled transfer: remaining back to source customer, loaded history unchanged');
  });

  /* ---------- 5) الإلغاء الجزئي يعدّل عدد البكر ---------- */
  await test('إلغاء جزئي (15 من 30): عدد البكر = 15 والمتاح لا يتجاوز المخزون', async () => {
    resetStore();
    setStock(Q_TEST, 120, 110, 50);
    const r1 = addReservation({ id: 'r1', seq: 1, customer: 'عميل أ', createdAt: '2025-01-01T10:00:00Z', items: [{ quality: Q_TEST, gsm: 120, size: 110, qty: 40 }] });
    const r2 = addReservation({ id: 'r2', seq: 2, customer: 'عميل ب', createdAt: '2025-01-02T10:00:00Z', items: [{ quality: Q_TEST, gsm: 120, size: 110, qty: 30 }] });
    Store.saveOne('cancellations', {
      id: 'c1', reservationId: r2.id, reservationSeq: 2, customer: r2.customer,
      itemId: r2.items[0].id, level: 'partial',
      quality: Q_TEST, gsm: 120, size: 110, qty: 15, date: '2025-01-07', reason: 'خفض الطلب',
      createdAt: '2025-01-07T00:00:00Z',
    });
    const rows = RESV.reservationReportRows(null);
    eq(rows.map((x) => [x.customer, x.qty, x.available]), [
      ['عميل أ', 40, 40], ['عميل ب', 15, 10],
    ], 'ب: qty adjusted to 15; available capped by remaining stock (10)');
  });

  /* ---------- 6) الإلغاء الكلي للحجز: مستبعد نهائيًا ---------- */
  await test('حجز ملغى بالكامل لا يظهر في الكشف ولا في الإجماليات', async () => {
    resetStore();
    setStock(Q_TEST, 120, 110, 50);
    const r1 = addReservation({ id: 'r1', seq: 1, customer: 'عميل أ', createdAt: '2025-01-01T10:00:00Z', items: [{ quality: Q_TEST, gsm: 120, size: 110, qty: 40 }] });
    const r3 = addReservation({ id: 'r3', seq: 3, customer: 'عميل د', createdAt: '2025-01-03T10:00:00Z', items: [{ quality: Q_TEST, gsm: 120, size: 110, qty: 20 }] });
    r3.cancelled = true; r3.cancelDate = '2025-01-08';
    Store.saveOne('reservations', r3);
    const rows = RESV.reservationReportRows(null);
    eq(rows.map((x) => x.customer), ['عميل أ'], 'cancelled reservation excluded');
    const t = RESV.reservationReportTotals(rows);
    eq(t.qty, 40, 'totals exclude the cancelled reservation');
  });

  /* ---------- 7) بند أُلغي بالكامل بعد تحميل جزء منه ---------- */
  await test('بند أُلغي بالكامل بعد تحميل 10: يبقى ظاهرًا بعدد البكر = المحمّل', async () => {
    resetStore();
    setStock(Q_TEST, 120, 110, 50);
    const r4 = addReservation({ id: 'r4', seq: 4, customer: 'عميل هـ', createdAt: '2025-01-04T10:00:00Z', items: [{ quality: Q_TEST, gsm: 120, size: 110, qty: 25 }] });
    const v2 = { key: 'PT|v2', permitNo: 'ض-102', customer: 'عميل هـ', date: '2025-01-05', lines: [{ quality: Q_TEST, gsm: 120, size: 110, qty: 10 }] };
    addVoucher(v2);
    addLink({ id: 'l3', reservation: r4, itemId: r4.items[0].id, voucher: v2, lineIndex: 0, loadedQty: 10, covers: 'remaining' });
    Store.saveOne('cancellations', {
      id: 'c2', reservationId: r4.id, reservationSeq: 4, customer: r4.customer,
      itemId: r4.items[0].id, level: 'item',
      quality: Q_TEST, gsm: 120, size: 110, qty: 15, date: '2025-01-09', reason: '',
      createdAt: '2025-01-09T00:00:00Z',
    });
    const rows = RESV.reservationReportRows(null);
    eq(rows.map((x) => [x.customer, x.qty, x.available, x.loaded]), [['عميل هـ', 10, 0, 10]],
      'cancelled-remaining item keeps its loaded history visible');
  });

  /* ---------- 8) إذن محذوف يخرج من المحمّل ---------- */
  await test('رابط بإذن محذوف: كميته تخرج من المحمّل (المجموع لا يزدوج)', async () => {
    resetStore();
    setStock(Q_TEST, 120, 110, 50);
    const r1 = addReservation({ id: 'r1', seq: 1, customer: 'عميل أ', createdAt: '2025-01-01T10:00:00Z', items: [{ quality: Q_TEST, gsm: 120, size: 110, qty: 20 }] });
    const ghost = { key: 'PT|gone', permitNo: 'ض-999', customer: 'عميل أ', date: '2025-01-03', lines: [{ quality: Q_TEST, gsm: 120, size: 110, qty: 12 }] };
    addLink({ id: 'lx', reservation: r1, itemId: r1.items[0].id, voucher: ghost, lineIndex: 0, loadedQty: 12, covers: 'remaining' });
    const rows = RESV.reservationReportRows(null);
    eq(rows[0].loaded, 0, 'stale link excluded from loaded');
  });

  /* ---------- 9) طباعة عملاء محددين (فرز + استبعاد) ---------- */
  await test('طباعة عميل محدد: صفوف ذلك العميل فقط بنفس الدالة', async () => {
    resetStore();
    setStock(Q_TEST, 120, 110, 200);
    addReservation({ id: 'r1', seq: 1, customer: 'عميل أ', createdAt: '2025-01-01T10:00:00Z', items: [{ quality: Q_TEST, gsm: 120, size: 110, qty: 30 }] });
    addReservation({ id: 'r2', seq: 2, customer: 'عميل ب', createdAt: '2025-01-02T10:00:00Z', items: [{ quality: Q_TEST, gsm: 120, size: 110, qty: 20 }] });
    addReservation({ id: 'r3', seq: 3, customer: 'عميل ج', createdAt: '2025-01-03T10:00:00Z', items: [{ quality: Q_TOP, gsm: 140, size: 110, qty: 8 }] });
    const onlyB = RESV.reservationReportRows(new Set(['عميل ب']));
    eq(onlyB.map((x) => x.customer), ['عميل ب'], 'subset rows');
    const aAndC = RESV.reservationReportRows(new Set(['عميل أ', 'عميل ج']));
    eq(aAndC.map((x) => x.customer).sort(), ['عميل أ', 'عميل ج'], 'multi-customer subset');
    const all = RESV.reservationReportRows(null);
    const tAll = RESV.reservationReportTotals(all);
    const tSub = RESV.reservationReportTotals(aAndC);
    eq(tAll.qty - tSub.qty, 20, 'subset totals subtract cleanly (no shared rows)');
  });

  /* ---------- 10) توافق مزوّد الطباعة القديم مع الكشف الموحّد ---------- */
  await test('getReservationPrintRows يعيد نفس أرقام الكشف الموحّد', async () => {
    resetStore();
    setStock(Q_TEST, 120, 110, 100);
    const r1 = addReservation({ id: 'r1', seq: 1, customer: 'عميل أ', createdAt: '2025-01-01T10:00:00Z', items: [{ quality: Q_TEST, gsm: 120, size: 110, qty: 60 }] });
    const legacy = globalThis.App.getReservationPrintRows([r1.id]);
    eq(legacy.length, 1, 'legacy provider rows');
    eq([legacy[0].required, legacy[0].available, legacy[0].loaded], [60, 60, 0], 'same numbers as unified rows');
    const unified = RESV.reservationReportRows(null)[0];
    eq([unified.qty, unified.available, unified.loaded], [legacy[0].required, legacy[0].available, legacy[0].loaded], 'single source of truth');
  });

  /* ---------- 11) باني الجدول الموحّد: 7 أعمدة + إجراءات + إجماليات ---------- */
  await test('باني الجدول: 7 أعمدة ثابتة بترتيبها + عمود إجراءات للشاشة + صف إجماليات', async () => {
    resetStore();
    setStock(Q_TEST, 120, 110, 100);
    addReservation({ id: 'r1', seq: 1, customer: 'عميل أ', createdAt: '2025-01-01T10:00:00Z', items: [{ quality: Q_TEST, gsm: 120, size: 110, qty: 60 }] });
    const rows = RESV.reservationReportRows(null);
    const html = RESV.unifiedTableHtml(rows, { actions: true });
    const headers = (html.match(/<th[ >]/g) || []).length;
    eq(headers, 8, '7 data columns + actions column');
    for (const head of ['اسم العميل', 'النوع', 'الجرام', 'المقاس', 'عدد البكر', 'المتاح', 'المحمّل']) {
      ok(html.includes('<th>' + head + '</th>') || html.includes('<th class="num">' + head + '</th>'), 'header missing: ' + head);
    }
    ok(html.includes('resv-actions-col'), 'actions column flagged for print hiding');
    ok(html.includes('<tfoot>') && html.includes('60'), 'totals row with values');
    ok(html.includes('data-open='), 'customer name opens details');
    const htmlPrint = RESV.unifiedTableHtml(rows, { actions: false });
    eq((htmlPrint.match(/<th[ >]/g) || []).length, 7, 'print mode: exactly 7 columns');
    const empty = RESV.unifiedTableHtml([], { actions: false });
    ok(empty.includes('لا توجد بنود حجوزات'), 'empty-state message');
  });

  /* ---------- 12) لا بيانات: أصفار بلا أخطاء ---------- */
  await test('لا حجوزات: صفوف فارغة وإجماليات أصفار بلا أخطاء', async () => {
    resetStore();
    const rows = RESV.reservationReportRows(null);
    eq(rows.length, 0, 'no rows');
    const t = RESV.reservationReportTotals(rows);
    eq([t.qty, t.available, t.loaded, t.count], [0, 0, 0, 0], 'zero totals');
  });

  console.log('\n=== النتيجة: ' + pass + ' نجاح / ' + fail + ' فشل ===\n');
  process.exit(fail ? 1 : 0);
})();
