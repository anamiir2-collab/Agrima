/* =========================================================================
   reservations.js — حجوزات العملاء (Customer Reel Reservations)
   -------------------------------------------------------------------------
   ⚠ القاعدة الأهم: هذا القسم نظام تتبع وتنظيم مستقل فقط — لا ينفذ أي
   عملية مخزنية أو إنتاجية أو مالية أو صرف فعليًا:
   • الحجوزات لا تخصم ولا تضيف من المخزون إطلاقًا.
   • الحجوزات لا تعدل سجلات الإنتاج.
   • التحويل بين العملاء لا يعدل المخزون.
   • ربط إذن صرف مرجعي فقط: لا ينشئ إذنًا ولا يعدل إذنًا قائمًا ولا يكرر
     عملية صرف. أذون الصرف القائمة تبقى المصدر الوحيد لعمليات الصرف.
   • لا يغير هذا القسم أي حساب أو تقرير قائم.

   التخزين: مفاتيح LocalStorage مستقلة تمامًا عن قاعدة البيانات التشغيلية
   (IndexedDB) — لا تلمس أي مفتاح قائم:
     agrima_customer_reservations          الحجوزات وبنودها
     agrima_reservation_transfers          التحويلات بين العملاء
     agrima_reservation_cancellations      سجل الإلغاءات
     agrima_reservation_delivery_links     روابط أذون الصرف (مرجعية فقط)
     agrima_reservation_audit_log          سجل تدقيق مستقل للقسم

   متابعة التوفر (قراءة فقط من البيانات القائمة):
   • الرصيد الفعلي للمقاس من محرك الرصيد القائم App.balanceOf كما هو.
   • التوزيع FCFS بترتيب إنشاء الحجوزات: كل كمية محجوزة لحجز نشط آخر
     لا تُعد متاحة مرة أخرى — التمييز دائمًا بين:
     المخزون الكلي / المحجوز للحجوزات / غير المخصص / بانتظار الإنتاج / المحمّل.
   • الوزن التقديري بنفس طريقة التطبيق القائمة: المقاس × الكمية × المعامل
     (7.5 افتراضيًا — CALC.productWeight) — بلا أي وزن فعلي.

   ربط أذون الصرف (مرجعي فقط):
   • كل سطر إذن له مفتاح مرجعي (مفتاح الإذن + ترتيب السطر + الصنف/الجرام/
     المقاس + معرفات البكر إن وجدت) — سجل الاستهلاك يمنع عدّ كمية الصرف
     نفسها مرتين عبر أكثر من حجز.
   • الإذن يُقرأ فقط: الرقم والتاريخ والعميل المسجل فيه والكميات.
   • إذا حُذف الإذن لاحقًا يظهر الرابط كـ«إذن محذوف» ويخرج من إجماليات
     المحمّل — السجل التاريخي لا يُحذف.

   التحويل بين العملاء: سجل مستقل يبقى أثره مرتبطًا بالحجز الأصلي —
   لا حذف ولا إعادة كتابة للتاريخ.
   ========================================================================= */
(function (global) {
  'use strict';
  const { t, el, esc, fmtNum, fmtDate, todayISO, toast, confirmDialog, openModal, closeModal, EventBus } = global.UI;
  const App = global.App;
  const CALC = global.CALC;
  const lang = () => global.UI.getLang() === 'ar';
  const ar = lang;

  /* ================= 1) التخزين المستقل (LocalStorage) ================= */
  const KEYS = {
    reservations: 'agrima_customer_reservations',
    transfers: 'agrima_reservation_transfers',
    cancellations: 'agrima_reservation_cancellations',
    links: 'agrima_reservation_delivery_links',
    audit: 'agrima_reservation_audit_log',
  };
  const AUDIT_MAX = 800;

  function lsRead(key, fallback) {
    try {
      const raw = global.localStorage.getItem(key);
      if (raw == null || raw === '') return fallback;
      const v = JSON.parse(raw);
      return v == null ? fallback : v;
    } catch (e) {
      /* بيانات تالفة: لا نتوقف أبدًا ونعيد القيمة الافتراضية —
         بيانات التطبيق القائمة في IndexedDB غير متأثرة أصلًا */
      console.error('[reservations] corrupted store "' + key + '" — using safe fallback', e);
      return fallback;
    }
  }
  function lsWrite(key, value) {
    try {
      global.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      console.error('[reservations] write failed for "' + key + '"', e);
      toast(ar() ? 'تعذر حفظ بيانات الحجوزات محليًا (مساحة التخزين ممتلئة؟)' : 'Failed to save reservation data locally', 'err');
      return false;
    }
  }

  const Store = {
    getAll(name) { const v = lsRead(KEYS[name], []); return Array.isArray(v) ? v : []; },
    setAll(name, arr) { return lsWrite(KEYS[name], Array.isArray(arr) ? arr : []); },
    find(name, id) { return Store.getAll(name).find((x) => x.id === id) || null; },
    saveOne(name, rec) {
      const all = Store.getAll(name);
      const i = all.findIndex((x) => x.id === rec.id);
      if (i >= 0) all[i] = rec; else all.push(rec);
      return Store.setAll(name, all);
    },
    removeOne(name, id) {
      const all = Store.getAll(name).filter((x) => x.id !== id);
      return Store.setAll(name, all);
    },
  };

  function uid(prefix) {
    let s = '';
    try { s = global.crypto.randomUUID(); } catch (e) {
      s = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    }
    return prefix + '_' + s;
  }
  function nextSeq(reservations) {
    return reservations.reduce((m, r) => Math.max(m, Number(r.seq) || 0), 0) + 1;
  }
  function audit(action, details, extra) {
    try {
      const log = Store.getAll('audit');
      log.push(Object.assign({
        id: uid('a'), at: new Date().toISOString(), action, details: String(details || ''),
      }, extra || {}));
      while (log.length > AUDIT_MAX) log.shift();
      Store.setAll('audit', log);
    } catch (e) { console.error('[reservations] audit failed', e); }
  }

  /* ================= 2) مسميات الحالات ================= */
  const ITEM_STATUS = {
    available: { ar: 'متاح في المخزون', en: 'Available in stock' },
    awaiting: { ar: 'بانتظار الإنتاج', en: 'Awaiting production' },
    received: { ar: 'استُلم في المخزون', en: 'Received into stock' },
    loaded: { ar: 'تم التحميل', en: 'Loaded' },
    transferred: { ar: 'محوّل لعميل آخر', en: 'Transferred' },
    cancelled: { ar: 'ملغى', en: 'Cancelled' },
  };
  const RES_STATUS = {
    open: { ar: 'مفتوحة', en: 'Open' },
    loaded: { ar: 'مكتملة التحميل', en: 'Fully loaded' },
    transferred: { ar: 'محوّلة بالكامل', en: 'Fully transferred' },
    cancelled: { ar: 'ملغاة', en: 'Cancelled' },
  };
  const itemStatusLabel = (s, partial) => {
    const st = ITEM_STATUS[s] || ITEM_STATUS.awaiting;
    const base = ar() ? st.ar : st.en;
    return partial ? base + (ar() ? ' (جزئيًا)' : ' (partial)') : base;
  };
  const resStatusLabel = (s) => {
    const st = RES_STATUS[s] || RES_STATUS.open;
    return ar() ? st.ar : st.en;
  };

  /* ================= 3) محرك الحساب والتتبع (قراءة فقط) =================
     يبني لقطة كاملة من البيانات الحية: الرصيد من App.balanceOf (محرك
     الإكسل القائم كما هو)، والحركات للكشف عن إنتاج لاحق للحجز، وأذون
     الصرف من App.collectVouchers — كلها قراءة فقط بلا أي كتابة. */

  /* مفتاح سطر الإذن المرجعي — هوية مستقرة لمنع العد المزدوج */
  function voucherLineKey(voucherKey, lineIndex, line) {
    const reelIds = (line && line.reelIds && line.reelIds.length)
      ? 'R:' + line.reelIds.slice().sort().join(',') : '';
    return [voucherKey, 'L' + lineIndex,
      App.productFamily(line && line.quality), line && line.gsm, line && line.size, reelIds,
    ].join('::');
  }

  /**
   * لقطة التتبع الكاملة.
   * @returns {Map} reservationId → لقطة الحجز { items: Map, totals, status, ... }
   */
  function computeAll() {
    const reservations = Store.getAll('reservations');
    const transfers = Store.getAll('transfers');
    const cancellations = Store.getAll('cancellations');
    const links = Store.getAll('links');

    /* أذون الصرف الحية — قراءة فقط */
    const vouchers = App.collectVouchers(App.state.transactions, App.state.permits || []);
    const voucherByKey = new Map(vouchers.map((v) => [v.key, v]));

    /* أحدث حركة إنتاج لكل تركيبة (لتمييز «استُلم في المخزون») — قراءة فقط */
    const lastProdAdd = new Map();
    for (const r of App.state.transactions) {
      if (!(Number(r.addQty) > 0) || !r.date) continue;
      const k = CALC.comboKey(r.quality, r.gsm, r.size);
      const d = String(r.date);
      if (!lastProdAdd.has(k) || d > lastProdAdd.get(k)) lastProdAdd.set(k, d);
    }

    /* سجل استهلاك أسطر الأذون عبر كل الروابط (منع العد المزدوج) */
    const consumed = new Map();
    for (const lk of links) {
      const v = voucherByKey.get(lk.voucherKey);
      if (!v) continue; /* إذن محذوف: كميته لم تعد موجودة في البيانات */
      const line = (v.lines || [])[lk.lineIndex];
      if (!line) continue;
      const k = voucherLineKey(lk.voucherKey, lk.lineIndex, line);
      consumed.set(k, CALC.round6((consumed.get(k) || 0) + (Number(lk.loadedQty) || 0)));
    }

    /* رصيد فعلي لكل تركيبة مطلوبة — من المحرك القائم (قراءة فقط) */
    const stockOf = (quality, gsm, size) => {
      const b = App.balanceOf(quality, gsm, size);
      return Math.max(0, CALC.round6(b.net || 0));
    };

    /* البنود النشطة بترتيب الإنشاء (FCFS للتوزيع) */
    const active = reservations.filter((r) => !r.cancelled);
    active.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));

    const stockLeft = new Map(); /* comboKey → المتاح غير المخصص الآن */
    const snapshot = new Map();
    const ensureRes = (r) => {
      if (!snapshot.has(r.id)) {
        snapshot.set(r.id, {
          id: r.id, seq: r.seq, reservation: r,
          items: new Map(),
          totals: { required: 0, available: 0, awaiting: 0, loaded: 0, loadedTransferred: 0, transferred: 0, cancelled: 0, remaining: 0, estWeight: 0 },
          transfersIn: [], transfersOut: [], links: [], cancellations: [],
        });
      }
      return snapshot.get(r.id);
    };
    for (const r of reservations) ensureRes(r);

    /* التحويلات النشطة والمُلغاة تُجمَّع لكل حجز — ما حُمّل منها يُحسب بعد جمع الروابط أدناه */
    for (const tr of transfers) {
      const s = snapshot.get(tr.fromReservationId);
      if (s) s.transfersOut.push(tr);
      if (tr.toReservationId && snapshot.has(tr.toReservationId)) snapshot.get(tr.toReservationId).transfersIn.push(tr);
    }
    for (const c of cancellations) {
      const s = snapshot.get(c.reservationId);
      if (s) s.cancellations.push(c);
    }
    for (const lk of links) {
      const s = snapshot.get(lk.reservationId);
      if (s) {
        const v = voucherByKey.get(lk.voucherKey);
        s.links.push(Object.assign({ _voucher: v || null, _stale: !v }, lk));
      }
    }
    /* ما حُمّل فعليًا من كل تحويل عبر أذون مرتبطة (بعد جمع الروابط أعلاه) */
    for (const tr of transfers) {
      const s = snapshot.get(tr.fromReservationId);
      if (!s) continue;
      tr._loadedSoFar = CALC.round6(s.links
        .filter((lk) => lk.transferId === tr.id && !lk._stale)
        .reduce((sum, lk) => sum + (Number(lk.loadedQty) || 0), 0));
    }

    /* تفاصيل كل بند */
    const orderedItems = [];
    for (const r of reservations) {
      const s = snapshot.get(r.id);
      (r.items || []).forEach((it, idx) => {
        const combo = CALC.comboKey(it.quality, it.gsm, it.size);
        const itemLinks = s.links.filter((lk) => lk.itemId === it.id && !lk._stale);
        /* المحمّل من متطلبات البند نفسها — لا يشمل تحميل الكميات المحوّلة لعملاء آخرين (تُعرض منفصلة لمنع الازدواج) */
        const loaded = CALC.round6(itemLinks
          .filter((lk) => lk.covers !== 'transfer')
          .reduce((sum, lk) => sum + (Number(lk.loadedQty) || 0), 0));
        const loadedTransferred = CALC.round6(itemLinks
          .filter((lk) => lk.covers === 'transfer')
          .reduce((sum, lk) => sum + (Number(lk.loadedQty) || 0), 0));
        const transferred = CALC.round6(s.transfersOut
          .filter((x) => x.itemId === it.id && x.status === 'active')
          .reduce((sum, x) => sum + (Number(x.qty) || 0), 0));
        const cancelled = CALC.round6(s.cancellations
          .filter((x) => x.itemId === it.id)
          .reduce((sum, x) => sum + (Number(x.qty) || 0), 0));
        const required = CALC.round6(Number(it.qtyRequired) || 0);
        const remaining = Math.max(0, CALC.round6(required - loaded - transferred - cancelled));
        const st = {
          item: it, idx, combo, required, loaded, loadedTransferred, transferred, cancelled, remaining,
          available: 0, awaiting: 0, status: 'awaiting', statusPartial: false,
          estWeightPerReel: CALC.productWeight(it.size, 1, App.state.settings.weightFactor),
          estWeightTotal: CALC.productWeight(it.size, required, App.state.settings.weightFactor),
        };
        s.items.set(it.id, st);
        orderedItems.push({ res: r, snap: s, st, createdAt: String(r.createdAt || '') });
      });
    }

    /* تمريرة التوزيع FCFS: المخزون الفعلي يُخصص للبنود النشطة بترتيب
       إنشاء الحجوزات — الكمية المحجوزة لحجز آخر لا تعد متاحة */
    for (const entry of orderedItems) {
      if (entry.res.cancelled) { entry.st.status = 'cancelled'; continue; } /* الحجز الملغى لا يستهلك تخصيصًا */
      const { st } = entry;
      if (st.remaining <= 0) {
        const anyLoaded = st.loaded + st.loadedTransferred > 0;
        st.status = anyLoaded ? 'loaded' : (st.cancelled > 0 ? 'cancelled' : (st.transferred > 0 ? 'transferred' : 'loaded'));
        continue;
      }
      const cur = stockLeft.has(st.combo) ? stockLeft.get(st.combo) : stockOfFromCombo(st.combo);
      const take = Math.min(st.remaining, cur);
      stockLeft.set(st.combo, CALC.round6(cur - take));
      st.available = CALC.round6(take);
      st.awaiting = CALC.round6(st.remaining - take);
      const prodAfter = lastProdAdd.get(st.combo);
      const covered = st.available > 0;
      if (covered && prodAfter && String(entry.res.date || '') < String(prodAfter)) st.status = 'received';
      else if (covered) st.status = 'available';
      else st.status = 'awaiting';
      st.statusPartial = covered && st.awaiting > 0;
    }
    function stockOfFromCombo(combo) {
      /* comboKey = quality||gsm||size — نستخرج المكونات للقراءة من الرصيد */
      const parts = String(combo).split('||');
      return stockOf(parts[0], parts[1], parts[2]);
    }

    /* إجماليات كل حجز وحالته */
    for (const r of reservations) {
      const s = snapshot.get(r.id);
      for (const st of s.items.values()) {
        s.totals.required += st.required;
        s.totals.available += st.available;
        s.totals.awaiting += st.awaiting;
        s.totals.loaded += st.loaded;
        s.totals.loadedTransferred += st.loadedTransferred;
        s.totals.transferred += st.transferred;
        s.totals.cancelled += st.cancelled;
        s.totals.remaining += st.remaining;
        s.totals.estWeight += st.estWeightTotal;
      }
      for (const k of Object.keys(s.totals)) {
        if (k !== 'estWeight') s.totals[k] = CALC.round6(s.totals[k]);
        else s.totals[k] = CALC.round6(s.totals[k]);
      }
      if (r.cancelled) s.status = 'cancelled';
      else if (s.totals.remaining <= 0) {
        s.status = (s.totals.loaded + (s.totals.loadedTransferred || 0)) > 0
          ? 'loaded' : (s.totals.transferred > 0 ? 'transferred' : 'cancelled');
      } else s.status = 'open';
      /* الكميات المستلمة عبر التحويل لهذا العميل (عرض مستقل بلا دمج) */
      s.receivedViaTransfers = CALC.round6(transfers
        .filter((x) => x.status === 'active' && App.canonicalCustomer(x.toCustomer || '') === App.canonicalCustomer(r.customer || ''))
        .reduce((sum, x) => sum + (Number(x.qty) || 0), 0));
    }

    /* المخزون الكلي / المخصص / غير المخصص لكل تركيبة محجوزة */
    const allocation = new Map(); /* comboKey → { physical, allocated, unallocated } */
    for (const entry of orderedItems) {
      if (!allocation.has(entry.st.combo)) {
        const physical = stockOfFromCombo(entry.st.combo);
        allocation.set(entry.st.combo, { physical, allocated: 0, unallocated: physical });
      }
    }
    for (const entry of orderedItems) {
      if (entry.res.cancelled) continue;
      const a = allocation.get(entry.st.combo);
      a.allocated = CALC.round6(a.allocated + entry.st.available);
      a.unallocated = CALC.round6(a.unallocated - entry.st.available);
    }

    return {
      reservations, transfers, cancellations, links,
      vouchers, voucherByKey, consumed, snapshot, allocation,
      activeCount: active.length,
      grand: {
        reservations: reservations.length,
        requested: CALC.round6([...snapshot.values()].filter((s) => !s.reservation.cancelled).reduce((sum, s) => sum + s.totals.required, 0)),
        available: CALC.round6([...snapshot.values()].filter((s) => !s.reservation.cancelled).reduce((sum, s) => sum + s.totals.available, 0)),
        awaiting: CALC.round6([...snapshot.values()].filter((s) => !s.reservation.cancelled).reduce((sum, s) => sum + s.totals.awaiting, 0)),
        loaded: CALC.round6([...snapshot.values()].filter((s) => !s.reservation.cancelled).reduce((sum, s) => sum + s.totals.loaded, 0)),
        transferred: CALC.round6(transfers.filter((x) => x.status === 'active').reduce((sum, x) => sum + (Number(x.qty) || 0), 0)),
        cancelled: CALC.round6(cancellations.reduce((sum, x) => sum + (Number(x.qty) || 0), 0)),
      },
    };
  }
  App.reservationsCompute = computeAll;

  /* شارة حالة البند / الحجز */
  function itemStatusChip(st) {
    return `<span class="resv-chip resv-st-${esc(st.status)}">${esc(itemStatusLabel(st.status, st.statusPartial))}</span>`;
  }
  function resStatusChip(status) {
    return `<span class="resv-chip resv-st-${esc(status)}">${esc(resStatusLabel(status))}</span>`;
  }

  /* ================= 3.5) الكشف الموحّد (شاشة + طباعة) =================
     جدول واحد، مصدر بيانات واحد، ودوال حساب واحدة — للشاشة والطباعة معًا.
     • كل بند حجز في صف مستقل بأعمدة ثابتة (اسم العميل / النوع / الجرام /
       المقاس / عدد البكر / المتاح / المحمّل) وصف إجماليات في النهاية.
     • الحجز الملغى بالكامل لا يظهر إطلاقًا (في الجدول ولا في الطباعة).
     • عدد البكر  = المطلوب − الملغى (الإلغاء الجزئي يعدّل الرقم نفسه،
       والكمية المحوّلة تبقى في عدد البكر للعميل صاحب الحجز الأصلي —
       لا تُنشأ صفوف إضافية للعميل المستلم حتى لا تتضاعف الإجماليات).
     • المتاح    = التخصيص الفعلي من الرصيد الحي (محرك القائم FCFS كما هو).
     • المحمّل   = المحمّل فعليًا عبر أذون صرف مرتبطة + تحميل الكميات
       المحوّلة إذا حُمّلت فعليًا فقط — الكمية المحوّلة غير المحمّلة لا تُحسب.
     لا حسابات جديدة ولا نسخة طباعة مستقلة: الطباعة تعيد استخدام نفس الدوال
     ونفس عنصر الجدول المعروض على الشاشة. */
  function reservationReportRows(customerKeys) {
    const S = computeAll();
    const rows = [];
    for (const r of S.reservations) {
      if (r.cancelled) continue; /* حجز ملغى بالكامل: مستبعد نهائيًا */
      const s = S.snapshot.get(r.id);
      const custKey = App.canonicalCustomer(r.customer || '');
      if (customerKeys && !customerKeys.has(custKey)) continue;
      const voucherNos = [...new Set(s.links.map((lk) => String(lk.voucherNo || '').trim()).filter(Boolean))];
      for (const st of s.items.values()) {
        const qty = CALC.round6(st.required - st.cancelled);
        if (qty <= 0) continue; /* بند ملغى بالكامل بلا تحميل/تحويل سابق */
        rows.push({
          reservationId: r.id, seq: r.seq, createdAt: String(r.createdAt || ''),
          customer: r.customer || '', customerKey: custKey, date: r.date,
          itemId: st.item.id,
          quality: App.productFamily(st.item.quality),
          gsm: st.item.gsm, size: st.item.size,
          qty, available: CALC.round6(st.available),
          loaded: CALC.round6(st.loaded + st.loadedTransferred),
          voucherNos, status: s.status,
        });
      }
    }
    rows.sort((a, b) =>
      a.customerKey.localeCompare(b.customerKey, 'ar') ||
      a.createdAt.localeCompare(b.createdAt) ||
      (Number(a.seq) || 0) - (Number(b.seq) || 0));
    return rows;
  }

  /* الإجماليات تُحسب من نفس صفوف الكشف المعروضة فقط — لا مصدر ثانٍ */
  function reservationReportTotals(rows) {
    return (rows || []).reduce((acc, x) => ({
      qty: CALC.round6(acc.qty + (Number(x.qty) || 0)),
      available: CALC.round6(acc.available + (Number(x.available) || 0)),
      loaded: CALC.round6(acc.loaded + (Number(x.loaded) || 0)),
      count: acc.count + 1,
    }), { qty: 0, available: 0, loaded: 0, count: 0 });
  }

  /* باني الجدول الموحّد — نفس العنصر للشاشة والطباعة. عمود الإجراءات يظهر
     على الشاشة فقط ويُخفى عند الطباعة عبر css/print.css (أعمدة الطباعة = 7) */
  function unifiedTableHtml(rows, opts) {
    const withActions = !opts || opts.actions !== false;
    const totals = reservationReportTotals(rows);
    const cols = withActions ? 8 : 7;
    const L = {
      customer: ar() ? 'اسم العميل' : 'Customer',
      type: ar() ? 'النوع' : 'Type',
      gsm: ar() ? 'الجرام' : 'GSM',
      size: ar() ? 'المقاس' : 'Size',
      qty: ar() ? 'عدد البكر' : 'Reels',
      available: ar() ? 'المتاح' : 'Available',
      loaded: ar() ? 'المحمّل' : 'Loaded',
      actions: t('actions'),
      total: ar() ? 'الإجمالي' : 'Total',
      items: ar() ? 'بند' : 'items',
      empty: ar() ? 'لا توجد بنود حجوزات — ابدأ بـ«حجز جديد»' : 'No reservation items yet',
      details: ar() ? 'تفاصيل الحجز' : 'Details',
      trf: ar() ? 'تحويل كمية لعميل آخر' : 'Transfer',
      cnl: ar() ? 'إلغاء كمية/حجز' : 'Cancel',
    };
    return `<table class="data-table resv-unified-table" id="rv-unified-table">
      <thead><tr>
        <th>${L.customer}</th><th>${L.type}</th>
        <th class="num">${L.gsm}</th><th class="num">${L.size}</th>
        <th class="num">${L.qty}</th><th class="num">${L.available}</th><th class="num">${L.loaded}</th>
        ${withActions ? `<th class="resv-actions-col">${L.actions}</th>` : ''}
      </tr></thead>
      <tbody>${(rows || []).length ? rows.map((x) => `
        <tr>
          <td data-label="${L.customer}" class="resv-cust"><button class="voucher-no" data-open="${esc(x.reservationId)}" title="${L.details}">${esc(x.customer)}</button></td>
          <td data-label="${L.type}">${esc(x.quality)}</td>
          <td class="num" data-label="${L.gsm}">${fmtNum(x.gsm)}</td>
          <td class="num" data-label="${L.size}">${fmtNum(x.size)}</td>
          <td class="num" data-label="${L.qty}">${fmtNum(x.qty)}</td>
          <td class="num pos" data-label="${L.available}">${fmtNum(x.available)}</td>
          <td class="num" data-label="${L.loaded}">${fmtNum(x.loaded)}</td>
          ${withActions ? `<td class="actions-cell">
            <button class="icon-btn" data-open="${esc(x.reservationId)}" title="${L.details}">👁</button>
            <button class="icon-btn" data-trf="${esc(x.reservationId)}" data-trf-item="${esc(x.itemId || '')}" title="${L.trf}">⇄</button>
            <button class="icon-btn danger" data-cnl="${esc(x.reservationId)}" data-cnl-item="${esc(x.itemId || '')}" title="${L.cnl}">🚫</button>
            <button class="icon-btn" data-edit="${esc(x.reservationId)}" title="${t('edit')}">✎</button>
          </td>` : ''}
        </tr>`).join('') : `<tr><td colspan="${cols}" class="empty">${L.empty}</td></tr>`}</tbody>
      <tfoot><tr>
        <td colspan="4">${L.total} (${fmtNum(totals.count)} ${L.items})</td>
        <td class="num">${fmtNum(totals.qty)}</td>
        <td class="num">${fmtNum(totals.available)}</td>
        <td class="num">${fmtNum(totals.loaded)}</td>
        ${withActions ? '<td></td>' : ''}
      </tr></tfoot>
    </table>`;
  }
  App.reservationReportRows = reservationReportRows;
  App.reservationReportTotals = reservationReportTotals;
  App.renderResvUnifiedTable = unifiedTableHtml;

  /* ترويسة الكشف والتوقيعات — مصدر واحد للاسم النصي (شاشة + طباعة) */
  const REPORT_LABELS = {
    ar: {
      company: 'شركة اجريماسترز للاستثمار والتنمية الزراعية',
      report: 'كشف متابعة حجوزات البكر للعملاء',
      printedAt: 'تاريخ الطباعة', sign1: 'توقيع المسؤول', sign2: 'توقيع أمين المخزن',
    },
    en: {
      company: 'Agrima Company',
      report: 'Customer Reel Reservations Follow-up Statement',
      printedAt: 'Printed on', sign1: 'Manager signature', sign2: 'Storekeeper signature',
    },
  };
  App.reservationReportLabels = () => (ar() ? REPORT_LABELS.ar : REPORT_LABELS.en);
  const RL = () => App.reservationReportLabels();

  /* توقيت الطباعة الفعلي (تاريخ + وقت) — يُحدَّث عند كل عرض وكل طباعة */
  function printStamp() {
    try {
      return new Intl.DateTimeFormat(ar() ? 'ar-EG' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date());
    } catch (e) { return new Date().toLocaleString(); }
  }
  function refreshPrintStamp() {
    const d = global.document.querySelector('.resv-print-date');
    if (d && App.currentRoute && App.currentRoute() === 'reservations') d.textContent = RL().printedAt + ': ' + printStamp();
  }
  App.reservationPrintStamp = printStamp;

  /* ================= 4) لوحة الحجوزات (#reservations) ================= */
  function renderReservations(host) {
    const S = computeAll();
    const g = S.grand;
    const I = global.UI.ICON;
    host.innerHTML = `
      <div class="page-head"><h2>${ar() ? 'حجوزات العملاء' : 'Customer reel reservations'}</h2>
        <div class="head-actions">
          <button class="btn btn-primary" id="rv-new">+ ${ar() ? 'حجز جديد' : 'New reservation'}</button>
          <button class="btn btn-primary resv-multi-print-btn" id="rv-print-multi" title="${ar() ? 'طباعة كشف مجمّع لعملاء محددين' : 'Print combined statement for selected customers'}">▤ ${ar() ? 'طباعة كشف مجمّع' : 'Print combined report'}</button>
          <button class="btn btn-ghost resv-print-btn" id="rv-print">▤ ${ar() ? 'طباعة' : 'Print'}</button>
          <button class="btn btn-ghost" id="rv-trf-log">${ar() ? 'سجل التحويلات' : 'Transfer history'}</button>
          <button class="btn btn-ghost" id="rv-cnl-log">${ar() ? 'سجل الإلغاءات' : 'Cancellation history'}</button>
        </div></div>
      <div class="card notice-card resv-notice">
        <strong>${ar() ? 'قسم حجوزات العملاء — نظام تتبع وتنظيم مستقل فقط' : 'Tracking-only section'}</strong>
        <div class="small muted">${ar()
          ? 'لا يخصم أو يضيف من المخزون، ولا يعدل الإنتاج، ولا ينشئ أو يعدل أذون الصرف — الروابط مع أذون الصرف مرجعية للعرض فقط.'
          : 'Never deducts or adds inventory, never modifies production, never creates or changes issue documents — links are reference-only.'}</div>
      </div>
      <div class="stats-grid resv-stats">
        ${[
          { icon: I.products, num: fmtNum(g.reservations), label: ar() ? 'إجمالي الحجوزات' : 'Total reservations', accent: 'teal' },
          { icon: I.add, num: fmtNum(g.requested), label: ar() ? 'البكر المطلوبة' : 'Reels requested', accent: 'green' },
          { icon: I.balance, num: fmtNum(g.available), label: ar() ? 'متاح في المخزون' : 'Available in stock', accent: 'green' },
          { icon: I.chart, num: fmtNum(g.awaiting), label: ar() ? 'بانتظار الإنتاج' : 'Awaiting production', accent: 'amber' },
          { icon: I.countOut, num: fmtNum(g.loaded), label: ar() ? 'محمّلة للعملاء' : 'Reels loaded', accent: 'teal' },
          { icon: I.out, num: fmtNum(g.transferred), label: ar() ? 'محوّلة بين العملاء' : 'Reels transferred', accent: 'amber' },
          { icon: I.out, num: fmtNum(g.cancelled), label: ar() ? 'ملغاة' : 'Reels cancelled', accent: 'red' },
        ].map((c) => `<div class="stat-card accent-${c.accent}">
          <div class="stat-icon">${c.icon}</div>
          <div class="stat-num">${c.num}</div>
          <div class="stat-label">${esc(c.label)}</div>
        </div>`).join('')}
      </div>
      <div class="card filters">
        <input type="text" id="rv-q" placeholder="${ar() ? 'بحث: اسم العميل / المقاس / رقم إذن الصرف…' : 'Search customer / size / note no…'}">
        <select id="rv-status">
          <option value="">${ar() ? 'الحالة: الكل' : 'Status: all'}</option>
          <option value="open">${ar() ? 'مفتوحة' : 'Open'}</option>
          <option value="loaded">${ar() ? 'مكتملة التحميل' : 'Fully loaded'}</option>
          <option value="transferred">${ar() ? 'محوّلة بالكامل' : 'Fully transferred'}</option>
        </select>
        <button class="btn btn-ghost" id="rv-clear">${t('reset')}</button>
      </div>
      <div class="card resv-report-card" id="rv-report-card">
        <div class="resv-print-heading">
          <div class="resv-print-company">${RL().company}</div>
          <div class="resv-print-title">${RL().report}</div>
          <div class="resv-print-date">${RL().printedAt}: ${printStamp()}</div>
        </div>
        <div class="table-wrap" id="rv-table-host"></div>
        <div class="resv-print-signatures">
          <div class="resv-print-sign">${RL().sign1}<span></span></div>
          <div class="resv-print-sign">${RL().sign2}<span></span></div>
        </div>
      </div>`;

    host.querySelector('#rv-new').addEventListener('click', () => { App.pendingReservationEdit = null; App.navigate('reservation-form'); });
    host.querySelector('#rv-trf-log').addEventListener('click', () => openTransfersLog());
    host.querySelector('#rv-cnl-log').addEventListener('click', () => openCancellationsLog());
    host.querySelector('#rv-print').addEventListener('click', () => { refreshPrintStamp(); global.print(); });
    host.querySelector('#rv-print-multi').addEventListener('click', () => {
      if (typeof App.openCombinedResvPicker === 'function') App.openCombinedResvPicker();
      else toast(ar() ? 'وحدة الطباعة لم تُحمّل بعد' : 'Print module not loaded yet', 'warn');
    });

    let rows = [];
    function refreshRows() {
      rows = App.reservationReportRows(null);
      applyFilters();
    }
    function applyFilters() {
      const q = host.querySelector('#rv-q').value.trim().toLowerCase();
      const st = host.querySelector('#rv-status').value;
      const filtered = rows.filter((x) => {
        if (st && x.status !== st) return false;
        if (!q) return true;
        const hitCust = String(x.customer || '').toLowerCase().includes(q);
        const hitType = String(x.quality || '').toLowerCase().includes(q);
        const hitSize = String(x.size) === q || String(x.gsm) === q;
        const hitNote = (x.voucherNos || []).some((v) => v.toLowerCase().includes(q));
        return hitCust || hitType || hitSize || hitNote;
      });
      renderRows(filtered);
    }

    /* نفس باني الجدول الموحّد المستخدم في الطباعة — لا جدول ثانٍ */
    function renderRows(list) {
      const host2 = host.querySelector('#rv-table-host');
      host2.innerHTML = unifiedTableHtml(list, { actions: true });
      host2.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => { App.pendingReservationId = b.dataset.open; App.navigate('reservation-details'); }));
      host2.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => { App.pendingReservationEdit = b.dataset.edit; App.navigate('reservation-form'); }));
      host2.querySelectorAll('[data-trf]').forEach((b) => b.addEventListener('click', () => openTransferModal(b.dataset.trf, b.dataset.trfItem || null, () => refreshRows())));
      host2.querySelectorAll('[data-cnl]').forEach((b) => b.addEventListener('click', () => openCancelModal(b.dataset.cnl, b.dataset.cnlItem || null, () => refreshRows())));
    }

    host.querySelector('#rv-q').addEventListener('input', applyFilters);
    host.querySelector('#rv-status').addEventListener('change', applyFilters);
    host.querySelector('#rv-clear').addEventListener('click', () => {
      host.querySelector('#rv-q').value = ''; host.querySelector('#rv-status').value = ''; applyFilters();
    });
    refreshRows();
  }

  /* ================= 5) سجل التحويلات العام ================= */
  function openTransfersLog() {
    const S = computeAll();
    const list = S.transfers.slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    const node = el(`<div class="resv-log">
      ${list.length ? `<div class="table-wrap"><table class="data-table">
        <thead><tr><th>${ar() ? 'التاريخ' : 'Date'}</th><th>${ar() ? 'من الحجز' : 'From'}</th>
        <th>${ar() ? 'العميل الأصلي' : 'Original customer'}</th><th>${ar() ? 'إلى عميل' : 'To customer'}</th>
        <th>${ar() ? 'الصنف' : 'Product'}</th><th class="num">${ar() ? 'الجرام' : 'GSM'}</th>
        <th class="num">${ar() ? 'المقاس' : 'Size'}</th><th class="num">${ar() ? 'الكمية' : 'Qty'}</th>
        <th>${ar() ? 'الحالة' : 'Status'}</th><th>${t('notes')}</th></tr></thead>
        <tbody>${list.map((x) => `
          <tr>
            <td data-label="${t('date')}">${fmtDate(x.date)}</td>
            <td data-label="${ar() ? 'من الحجز' : 'From'}"><button class="voucher-no" data-jump="${esc(x.fromReservationId)}">حجز #${fmtNum(x.fromReservationSeq)}</button></td>
            <td data-label="${ar() ? 'الأصلي' : 'Original'}">${esc(x.fromCustomer)}</td>
            <td data-label="${ar() ? 'إلى' : 'To'}">${esc(x.toCustomer)}</td>
            <td data-label="${ar() ? 'الصنف' : 'Product'}">${esc(App.productFamily(x.quality))}</td>
            <td class="num" data-label="${t('gsm')}">${fmtNum(x.gsm)}</td>
            <td class="num" data-label="${t('size')}">${fmtNum(x.size)}</td>
            <td class="num" data-label="${ar() ? 'الكمية' : 'Qty'}"><strong>${fmtNum(x.qty)}</strong></td>
            <td data-label="${ar() ? 'الحالة' : 'Status'}">${x.status === 'active'
              ? `<span class="resv-chip resv-st-available">${ar() ? 'ساري' : 'active'}</span>`
              : `<span class="resv-chip resv-st-cancelled">${ar() ? 'ملغي' : 'cancelled'}${x.cancelReason ? ' — ' + esc(x.cancelReason) : ''}</span>`}</td>
            <td data-label="${t('notes')}">${esc(x.notes || '—')}</td>
          </tr>`).join('')}</tbody>
      </table></div>`
      : `<div class="empty" style="padding:1.2rem">${ar() ? 'لا توجد تحويلات بعد' : 'No transfers yet'}</div>`}
    </div>`);
    node.querySelectorAll('[data-jump]').forEach((b) => b.addEventListener('click', () => {
      closeModal(); App.pendingReservationId = b.dataset.jump; App.navigate('reservation-details');
    }));
    openModal(node, { title: ar() ? 'سجل التحويلات بين العملاء (تتبع فقط)' : 'Transfer history', wide: true });
  }

  /* ================= 6) سجل الإلغاءات العام ================= */
  function openCancellationsLog() {
    const S = computeAll();
    const list = S.cancellations.slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    const node = el(`<div class="resv-log">
      ${list.length ? `<div class="table-wrap"><table class="data-table">
        <thead><tr><th>${ar() ? 'التاريخ' : 'Date'}</th><th>${ar() ? 'الحجز' : 'Reservation'}</th>
        <th>${ar() ? 'العميل' : 'Customer'}</th><th>${ar() ? 'الصنف' : 'Product'}</th>
        <th class="num">${ar() ? 'الجرام' : 'GSM'}</th><th class="num">${ar() ? 'المقاس' : 'Size'}</th>
        <th class="num">${ar() ? 'الكمية الملغاة' : 'Cancelled qty'}</th><th>${ar() ? 'النطاق' : 'Scope'}</th>
        <th>${ar() ? 'السبب' : 'Reason'}</th></tr></thead>
        <tbody>${list.map((x) => {
          const s = S.snapshot.get(x.reservationId);
          return `<tr>
            <td data-label="${t('date')}">${fmtDate(x.date)}</td>
            <td data-label="${ar() ? 'الحجز' : 'Reservation'}">${s ? `<button class="voucher-no" data-jump="${esc(x.reservationId)}">حجز #${fmtNum(s.reservation.seq)}</button>` : '—'}</td>
            <td data-label="${ar() ? 'العميل' : 'Customer'}">${esc(x.customer || (s ? s.reservation.customer : ''))}</td>
            <td data-label="${ar() ? 'الصنف' : 'Product'}">${esc(App.productFamily(x.quality))}</td>
            <td class="num" data-label="${t('gsm')}">${fmtNum(x.gsm)}</td>
            <td class="num" data-label="${t('size')}">${fmtNum(x.size)}</td>
            <td class="num" data-label="${ar() ? 'الملغاة' : 'Cancelled'}"><strong>${fmtNum(x.qty)}</strong></td>
            <td data-label="${ar() ? 'النطاق' : 'Scope'}">${x.level === 'reservation' ? (ar() ? 'إلغاء حجز كامل' : 'whole reservation') : (x.level === 'item' ? (ar() ? 'بند كامل' : 'whole item') : (ar() ? 'جزء من بند' : 'partial'))}</td>
            <td data-label="${ar() ? 'السبب' : 'Reason'}">${esc(x.reason || '—')}</td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>`
      : `<div class="empty" style="padding:1.2rem">${ar() ? 'لا توجد إلغاءات' : 'No cancellations'}</div>`}
    </div>`);
    node.querySelectorAll('[data-jump]').forEach((b) => b.addEventListener('click', () => {
      closeModal(); App.pendingReservationId = b.dataset.jump; App.navigate('reservation-details');
    }));
    openModal(node, { title: ar() ? 'سجل الإلغاءات (لا يؤثر على المخزون أو الإنتاج)' : 'Cancellation history', wide: true });
  }

  /* ================= 7) حوار التحويل بين العملاء =================
     سجل مستقل فقط: لا يخصم/يضيف مخزونًا — الكمية تبقى مرتبطة بالحجز الأصلي */
  function customerList() {
    const seen = new Map();
    for (const r of App.state.transactions) {
      const raw = String(r.customer || '').trim();
      if (!raw) continue;
      const key = App.canonicalCustomer(raw);
      if (!seen.has(key)) seen.set(key, key);
    }
    for (const p of App.state.permits || []) {
      if (p.customer && !seen.has(p.customer)) seen.set(p.customer, p.customer);
    }
    return [...seen.keys()].filter((k) => k !== 'الإنتاج').sort((a, b) => a.localeCompare(b, 'ar'));
  }

  function openTransferModal(reservationId, itemId, onDone) {
    const S = computeAll();
    const candidates = S.reservations.filter((r) => !r.cancelled && S.snapshot.get(r.id).totals.remaining > 0);
    if (!candidates.length) { toast(ar() ? 'لا توجد حجوزات نشطة بكمية متبقية للتحويل' : 'No active reservations with remaining qty', 'warn'); return; }
    if (reservationId && !candidates.some((r) => r.id === reservationId)) {
      toast(ar() ? 'لا توجد كمية متبقية في هذا الحجز للتحويل' : 'No remaining qty in this reservation', 'warn');
      return;
    }
    const customers = customerList();
    const node = el(`<div class="resv-form">
      <p class="muted small form-sub">${ar()
        ? 'تحويل جزء من حجز عميل إلى عميل آخر — تسجيل تتبع فقط: لا يخصم أو يضيف من المخزون، وتبقى الكمية مرتبطة بالحجز الأصلي في السجل.'
        : 'Transfer part of a reservation to another customer — tracking record only; no inventory change.'}</p>
      <div class="form-grid">
        <label class="field"><span>${ar() ? 'الحجز المصدر' : 'Source reservation'} *</span>
          <select id="trf-res">${candidates.map((r) => {
            const s = S.snapshot.get(r.id);
            return `<option value="${esc(r.id)}" ${r.id === reservationId ? 'selected' : ''}>حجز #${fmtNum(r.seq)} — ${esc(r.customer)} (${ar() ? 'متبقي' : 'remaining'} ${fmtNum(s.totals.remaining)})</option>`;
          }).join('')}</select></label>
        <label class="field"><span>${ar() ? 'البند' : 'Item'} *</span>
          <select id="trf-item"></select></label>
        <label class="field"><span>${ar() ? 'الكمية المحوّلة (بكر)' : 'Transfer qty (reels)'} *</span>
          <input type="number" id="trf-qty" min="1" step="1" value="1"></label>
        <label class="field"><span>${ar() ? 'العميل المستلم' : 'Receiving customer'} *</span>
          <input type="text" id="trf-to" list="trf-cust-list" placeholder="${ar() ? 'اسم العميل المستلم' : 'customer name'}">
          <datalist id="trf-cust-list">${customers.map((c) => `<option value="${esc(c)}"></option>`).join('')}</datalist></label>
        <label class="field"><span>${t('date')} *</span>
          <input type="date" id="trf-date" value="${esc(todayISO())}"></label>
        <label class="field field-wide"><span>${t('notes')}</span>
          <input type="text" id="trf-notes"></label>
      </div>
      <div class="form-hint" id="trf-hint"></div>
      <div class="form-error" id="trf-error" role="alert"></div>
      <div class="confirm-actions">
        <button class="btn btn-primary" id="trf-save">${t('save')}</button>
        <button class="btn btn-ghost" id="trf-cancel">${t('cancel')}</button>
      </div></div>`);

    const resSel = node.querySelector('#trf-res');
    const itemSel = node.querySelector('#trf-item');
    const qtyIn = node.querySelector('#trf-qty');
    const hint = node.querySelector('#trf-hint');
    const fillItems = () => {
      const s = S.snapshot.get(resSel.value);
      if (!s) return;
      const items = [...s.items.values()].filter((st) => st.remaining > 0);
      itemSel.innerHTML = items.map((st) => {
        if (itemId && st.item.id === itemId) return `<option value="${esc(st.item.id)}" selected>${esc(App.productFamily(st.item.quality))} — ${ar() ? 'جرام' : 'gsm'} ${fmtNum(st.item.gsm)} — ${ar() ? 'مقاس' : 'size'} ${fmtNum(st.item.size)} (${ar() ? 'متبقي' : 'remaining'} ${fmtNum(st.remaining)})</option>`;
        return `<option value="${esc(st.item.id)}">${esc(App.productFamily(st.item.quality))} — ${ar() ? 'جرام' : 'gsm'} ${fmtNum(st.item.gsm)} — ${ar() ? 'مقاس' : 'size'} ${fmtNum(st.item.size)} (${ar() ? 'متبقي' : 'remaining'} ${fmtNum(st.remaining)})</option>`;
      }).join('') || `<option value="">${ar() ? 'لا بنود متبقية' : 'no items with remaining qty'}</option>`;
      updateHint();
    };
    const currentSt = () => {
      const s = S.snapshot.get(resSel.value);
      return s ? s.items.get(itemSel.value) : null;
    };
    const updateHint = () => {
      const st = currentSt();
      if (!st) { hint.innerHTML = ''; return; }
      hint.innerHTML = `${ar() ? 'المطلوب' : 'Required'}: <strong>${fmtNum(st.required)}</strong>
        &nbsp;•&nbsp; ${ar() ? 'محمّل' : 'Loaded'}: <strong>${fmtNum(st.loaded)}</strong>
        &nbsp;•&nbsp; ${ar() ? 'محوّل سابقًا' : 'Transferred'}: <strong>${fmtNum(st.transferred)}</strong>
        &nbsp;•&nbsp; ${ar() ? 'ملغى' : 'Cancelled'}: <strong>${fmtNum(st.cancelled)}</strong>
        &nbsp;•&nbsp; ${ar() ? 'المتبقي القابل للتحويل' : 'Remaining'}: <strong>${fmtNum(st.remaining)}</strong>`;
      qtyIn.max = String(st.remaining);
    };
    resSel.addEventListener('change', fillItems);
    itemSel.addEventListener('change', updateHint);
    fillItems();

    node.querySelector('#trf-cancel').addEventListener('click', closeModal);
    node.querySelector('#trf-save').addEventListener('click', () => {
      const err = node.querySelector('#trf-error');
      err.textContent = '';
      const st = currentSt();
      const res = Store.find('reservations', resSel.value);
      const qty = Math.floor(Number(qtyIn.value) || 0);
      const to = node.querySelector('#trf-to').value.trim();
      const date = node.querySelector('#trf-date').value;
      const notes = node.querySelector('#trf-notes').value.trim();
      if (!res || !st) { err.textContent = ar() ? 'اختر الحجز والبند' : 'Select reservation and item'; return; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { err.textContent = ar() ? 'التاريخ مطلوب' : 'Date required'; return; }
      if (!to) { err.textContent = ar() ? 'اسم العميل المستلم مطلوب' : 'Receiving customer required'; return; }
      if (!qty || qty <= 0) { err.textContent = ar() ? 'أدخل كمية أكبر من صفر' : 'Qty must be greater than zero'; return; }
      if (qty > st.remaining) { err.textContent = ar()
        ? `الكمية أكبر من المتبقي (${fmtNum(st.remaining)}) — لا يمكن تحويل كميات محمّلة أو ملغاة`
        : `Qty exceeds remaining (${fmtNum(st.remaining)})`; return; }
      if (App.canonicalCustomer(to) === App.canonicalCustomer(res.customer)) {
        err.textContent = ar() ? 'العميل المستلم هو نفسه عميل الحجز' : 'Receiver equals the reservation customer';
        return;
      }
      const rec = {
        id: uid('trf'),
        fromReservationId: res.id, fromReservationSeq: res.seq, fromCustomer: res.customer,
        toCustomer: to, toReservationId: null,
        itemId: st.item.id, quality: st.item.quality, gsm: st.item.gsm, size: st.item.size,
        qty, date, notes, status: 'active', cancelReason: '',
        createdAt: new Date().toISOString(),
      };
      Store.saveOne('transfers', rec);
      audit('transfer', `تحويل ${qty} بكرة من حجز #${res.seq} (${res.customer}) إلى ${to} — مقاس ${st.item.size} / جرام ${st.item.gsm}`, { reservationId: res.id });
      closeModal();
      toast(ar() ? `تم تسجيل تحويل ${fmtNum(qty)} بكرة إلى ${to} — تتبع فقط دون تغيير المخزون` : 'Transfer recorded (tracking only)', 'ok');
      if (typeof onDone === 'function') onDone();
    });
    openModal(node, { title: ar() ? 'تحويل كمية حجز إلى عميل آخر' : 'Transfer reservation qty' });
  }

  /* ================= 8) حوار الإلغاء (حجز / بند / جزء) =================
     ممنوع إلغاء كمية محمّلة — الحد الأقصى = المتبقي غير المحمّل */
  function openCancelModal(reservationId, itemId, onDone) {
    const S = computeAll();
    const res = Store.find('reservations', reservationId);
    if (!res) return;
    const s = S.snapshot.get(reservationId);
    if (res.cancelled) { toast(ar() ? 'الحجز ملغى بالكامل مسبقًا' : 'Reservation already cancelled', 'info'); return; }
    const items = [...s.items.values()].filter((st) => st.remaining > 0);
    if (!items.length) { toast(ar() ? 'لا توجد كمية متبقية قابلة للإلغاء' : 'Nothing remaining to cancel', 'info'); return; }

    const node = el(`<div class="resv-form">
      <p class="muted small form-sub">${ar()
        ? 'الإلغاء تتبع فقط: لا يعدل المخزون أو الإنتاج أو أذون الصرف. لا يمكن إلغاء كميات تم تحميلها فعليًا — الحد الأقصى هو الكمية المتبقية.'
        : 'Cancellation is tracking only. Loaded quantities cannot be cancelled — max is the remaining quantity.'}</p>
      <div class="form-grid">
        <label class="field"><span>${ar() ? 'نطاق الإلغاء' : 'Scope'} *</span>
          <select id="cnl-scope">
            ${itemId ? '' : `<option value="reservation">${ar() ? 'إلغاء الحجز بالكامل (كل البنود المتبقية)' : 'Whole reservation'}</option>`}
            ${items.map((st) => `<option value="${esc(st.item.id)}" ${st.item.id === itemId ? 'selected' : ''}>${esc(App.productFamily(st.item.quality))} — ${ar() ? 'جرام' : 'gsm'} ${fmtNum(st.item.gsm)} — ${ar() ? 'مقاس' : 'size'} ${fmtNum(st.item.size)} (${ar() ? 'متبقي' : 'remaining'} ${fmtNum(st.remaining)})</option>`).join('')}
          </select></label>
        <label class="field"><span>${ar() ? 'الكمية الملغاة (بكر)' : 'Cancelled qty (reels)'}</span>
          <input type="number" id="cnl-qty" min="1" step="1"></label>
        <label class="field"><span>${t('date')} *</span>
          <input type="date" id="cnl-date" value="${esc(todayISO())}"></label>
        <label class="field field-wide"><span>${ar() ? 'سبب الإلغاء (اختياري)' : 'Reason (optional)'}</span>
          <input type="text" id="cnl-reason"></label>
      </div>
      <div class="form-hint" id="cnl-hint"></div>
      <div class="form-error" id="cnl-error" role="alert"></div>
      <div class="confirm-actions">
        <button class="btn btn-danger" id="cnl-save">${ar() ? 'تسجيل الإلغاء' : 'Record cancellation'}</button>
        <button class="btn btn-ghost" id="cnl-cancel">${t('cancel')}</button>
      </div></div>`);

    const scopeSel = node.querySelector('#cnl-scope');
    const qtyIn = node.querySelector('#cnl-qty');
    const hint = node.querySelector('#cnl-hint');
    const currentSt = () => s.items.get(scopeSel.value);
    const updateHint = () => {
      const st = currentSt();
      if (!st) { hint.innerHTML = ''; qtyIn.value = ''; return; }
      hint.innerHTML = `${ar() ? 'الأصلي' : 'Original'}: <strong>${fmtNum(st.required)}</strong>
        &nbsp;•&nbsp; ${ar() ? 'محمّل' : 'Loaded'}: <strong>${fmtNum(st.loaded)}</strong>
        &nbsp;•&nbsp; ${ar() ? 'محوّل' : 'Transferred'}: <strong>${fmtNum(st.transferred)}</strong>
        &nbsp;•&nbsp; ${ar() ? 'ملغى سابقًا' : 'Cancelled'}: <strong>${fmtNum(st.cancelled)}</strong>
        &nbsp;•&nbsp; ${ar() ? 'الحد الأقصى للإلغاء (المتبقي)' : 'Max cancellable (remaining)'}: <strong>${fmtNum(st.remaining)}</strong>`;
      qtyIn.max = String(st.remaining);
      qtyIn.value = String(st.remaining);
    };
    scopeSel.addEventListener('change', updateHint);
    updateHint();

    node.querySelector('#cnl-cancel').addEventListener('click', closeModal);
    node.querySelector('#cnl-save').addEventListener('click', () => {
      const err = node.querySelector('#cnl-error');
      err.textContent = '';
      const date = node.querySelector('#cnl-date').value;
      const reason = node.querySelector('#cnl-reason').value.trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { err.textContent = ar() ? 'التاريخ مطلوب' : 'Date required'; return; }
      const whole = scopeSel.value === 'reservation';
      const targets = whole ? items : [currentSt()].filter(Boolean);
      if (!targets.length) { err.textContent = ar() ? 'اختر نطاق الإلغاء' : 'Select scope'; return; }
      const qty = whole ? 0 : (Math.floor(Number(qtyIn.value) || 0));
      for (const st of targets) {
        const q = whole ? st.remaining : qty;
        if (!q || q <= 0) { err.textContent = ar() ? 'أدخل كمية أكبر من صفر' : 'Qty must be greater than zero'; return; }
        if (q > st.remaining) { err.textContent = ar()
          ? `الكمية أكبر من المتبقي (${fmtNum(st.remaining)}) — ممنوع إلغاء الكميات المحمّلة أو المحوّلة`
          : `Qty exceeds remaining (${fmtNum(st.remaining)}) — loaded quantities cannot be cancelled`;
          return; }
      }
      const msg = whole
        ? ar() ? `إلغاء الحجز بالكامل؟ سيتم إلغاء الكميات المتبقية (${targets.map((x) => fmtNum(x.remaining)).join(' + ')} بكرة) مع الحفاظ على الكميات المحمّلة والمحوّلة كما هي.`
          : 'Cancel the whole reservation (remaining quantities)?'
        : ar() ? `إلغاء ${fmtNum(qty)} بكرة من البند المحدد؟` : `Cancel ${qty} reel(s)?`;
      confirmDialog({ title: ar() ? 'تأكيد الإلغاء' : 'Confirm cancellation', message: msg, danger: true })
        .then((ok) => {
          if (!ok) return;
          const now = new Date().toISOString();
          for (const st of targets) {
            const q = whole ? st.remaining : qty;
            Store.saveOne('cancellations', {
              id: uid('cnl'), reservationId: res.id, reservationSeq: res.seq,
              customer: res.customer, itemId: st.item.id,
              level: whole ? 'reservation' : (q === st.remaining ? 'item' : 'partial'),
              quality: st.item.quality, gsm: st.item.gsm, size: st.item.size,
              qty: q, date, reason, createdAt: now,
            });
            audit('cancel', `إلغاء ${q} بكرة من حجز #${res.seq} (${res.customer}) — مقاس ${st.item.size} / جرام ${st.item.gsm}${reason ? ' — السبب: ' + reason : ''}`, { reservationId: res.id });
          }
          if (whole) {
            const fresh = Store.find('reservations', res.id);
            fresh.cancelled = true;
            fresh.cancelDate = date;
            fresh.cancelReason = reason;
            fresh.updatedAt = now;
            Store.saveOne('reservations', fresh);
            audit('cancel-reservation', `إلغاء الحجز #${res.seq} (${res.customer}) بالكامل`, { reservationId: res.id });
          }
          closeModal();
          toast(ar() ? 'تم تسجيل الإلغاء — لا تأثير على المخزون أو الإنتاج أو الأذون' : 'Cancellation recorded (no inventory effect)', 'ok');
          if (typeof onDone === 'function') onDone();
        });
    });
    openModal(node, { title: ar() ? 'إلغاء كمية / حجز' : 'Cancel quantity / reservation' });
  }

  /* ================= 9) حوار ربط إذن صرف (مرجعي فقط) =================
     • يقرأ الإذن فقط: الرقم/التاريخ/العميل المسجل/الكميات.
     • سجل الاستهلاك يمنع عدّ كمية الصرف نفسها لأكثر من حجز.
     • لا ينشئ إذنًا ولا يعدل إذنًا ولا يكرر عملية صرف. */
  function openLinkModal(reservationId, itemId, onDone) {
    const S = computeAll();
    const res = Store.find('reservations', reservationId);
    if (!res) return;
    const s = S.snapshot.get(reservationId);
    const activeItems = [...s.items.values()].filter((st) => st.remaining > 0);
    if (!activeItems.length) { toast(ar() ? 'لا توجد كمية متبقية في هذا الحجز' : 'No remaining qty', 'info'); return; }
    const vouchers = S.vouchers.filter((v) => v.status !== 'draft' && v.totalRolls > 0)
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    const drafts = S.vouchers.filter((v) => v.status === 'draft').length;

    /* اقتراح البند تلقائيًا حسب تركيبات الإذن */
    const suggestItem = (v) => {
      if (!v) return itemId || (activeItems[0] && activeItems[0].item.id);
      for (const l of v.lines || []) {
        const hit = activeItems.find((st) =>
          App.productFamily(st.item.quality) === App.productFamily(l.quality)
          && String(st.item.gsm) === String(l.gsm) && String(st.item.size) === String(l.size));
        if (hit) return hit.item.id;
      }
      return itemId || (activeItems[0] && activeItems[0].item.id);
    };

    const node = el(`<div class="resv-form resv-link-form">
      <p class="muted small form-sub">${ar()
        ? 'ربط مرجعي فقط: يُعرض من الإذن رقمه وتاريخه وعميله المسجل وكمياته — لا يُنشأ إذن جديد ولا يُعدل القائم ولا يُكرر أي صرف. كمية الصرف نفسها لا تُحسب مرتين عبر أكثر من حجز (سجل الاستهلاك).'
        : 'Reference-only link to an existing delivery note. The note stays the sole source of truth; delivered quantities are never counted twice.'}</p>
      ${drafts ? `<div class="resv-warn small">${ar()
        ? `ملاحظة: ${fmtNum(drafts)} مسودة إذن غير معتمدة لن تظهر هنا لأنها لم تُصرف من المخزون بعد.`
        : 'Draft permits are excluded (nothing issued yet).'}</div>` : ''}
      <div class="form-grid">
        <label class="field field-wide"><span>${ar() ? 'إذن الصرف القائم' : 'Existing delivery note'} *</span>
          <select id="lnk-voucher">
            <option value="">— ${ar() ? 'اختر إذن الصرف' : 'select delivery note'} —</option>
            ${vouchers.map((v) => `<option value="${esc(v.key)}">${esc(v.permitNo || (ar() ? 'بدون رقم' : 'no no.'))} — ${esc(v.customer)} — ${fmtDate(v.date)} — ${fmtNum(v.totalRolls)} ${ar() ? 'بكرة' : 'reels'}${v.kind === 'derived' ? (ar() ? ' (مستورد)' : ' (imported)') : ''}</option>`).join('')}
          </select></label>
        <label class="field"><span>${ar() ? 'بند الحجز المستهدف' : 'Target reservation item'} *</span>
          <select id="lnk-item">${activeItems.map((st) => `<option value="${esc(st.item.id)}">${esc(App.productFamily(st.item.quality))} — ${ar() ? 'جرام' : 'gsm'} ${fmtNum(st.item.gsm)} — ${ar() ? 'مقاس' : 'size'} ${fmtNum(st.item.size)} (${ar() ? 'متبقي' : 'remaining'} ${fmtNum(st.remaining)})</option>`).join('')}</select></label>
        <label class="field"><span>${ar() ? 'الكمية المحسوبة من هذا الإذن (بكر)' : 'Qty counted from this note'} *</span>
          <input type="number" id="lnk-qty" min="1" step="1"></label>
        <label class="field field-wide" id="lnk-transfer-wrap" hidden><span>${ar() ? 'التحويل المفسّر (العميل الفعلي المستلم ≠ عميل الحجز)' : 'Explaining transfer'}</span>
          <select id="lnk-transfer"></select></label>
      </div>
      <div class="resv-lines-box" id="lnk-lines" hidden></div>
      <div class="form-hint" id="lnk-hint"></div>
      <div class="form-error" id="lnk-error" role="alert"></div>
      <div class="confirm-actions">
        <button class="btn btn-primary" id="lnk-save" disabled>${t('save')}</button>
        <button class="btn btn-ghost" id="lnk-cancel">${t('cancel')}</button>
      </div></div>`);

    const vSel = node.querySelector('#lnk-voucher');
    const iSel = node.querySelector('#lnk-item');
    const qtyIn = node.querySelector('#lnk-qty');
    const linesBox = node.querySelector('#lnk-lines');
    const hint = node.querySelector('#lnk-hint');
    const err = node.querySelector('#lnk-error');
    let currentLineIdx = -1;
    let currentUnconsumed = 0;

    const currentSt = () => s.items.get(iSel.value);

    vSel.addEventListener('change', () => {
      currentLineIdx = -1; currentUnconsumed = 0;
      err.textContent = ''; hint.innerHTML = '';
      qtyIn.value = '';
      const v = S.voucherByKey.get(vSel.value);
      if (!v) { linesBox.hidden = true; node.querySelector('#lnk-save').disabled = true; return; }
      iSel.value = suggestItem(v);
      const st = currentSt();
      /* أسطر الإذن + ما حُسب سابقًا منها لأي حجز آخر */
      const rowsHtml = (v.lines || []).map((l, i) => {
        const key = voucherLineKey(v.key, i, l);
        const used = CALC.round6(S.consumed.get(key) || 0);
        const free = CALC.round6((Number(l.qty) || 0) - used);
        return `<tr data-idx="${i}" class="${free > 0 ? '' : 'resv-line-used'}">
          <td data-label="${ar() ? 'الصنف' : 'Product'}">${esc(App.productFamily(l.quality))}</td>
          <td class="num" data-label="${t('gsm')}">${fmtNum(l.gsm)}</td>
          <td class="num" data-label="${t('size')}">${fmtNum(l.size)}</td>
          <td class="num" data-label="${ar() ? 'كمية الإذن' : 'Note qty'}">${fmtNum(l.qty)}</td>
          <td class="num" data-label="${ar() ? 'محسوب سابقًا لحجوزات' : 'Already linked'}">${fmtNum(used)}</td>
          <td class="num" data-label="${ar() ? 'المتاح للربط' : 'Linkable'}"><strong>${fmtNum(free)}</strong></td>
          <td data-label=""><button class="btn btn-ghost resv-pick-line" ${free > 0 ? '' : 'disabled'}>${ar() ? 'اختيار' : 'Pick'}</button></td>
        </tr>`;
      }).join('');
      linesBox.hidden = false;
      linesBox.innerHTML = `<div class="card-head-row"><strong>${ar() ? 'أسطر الإذن والكميات المرجعية' : 'Note lines'}</strong>
        <span class="muted small">${ar() ? `العميل المسجل في الإذن: ${esc(v.customer)} — التاريخ: ${fmtDate(v.date)}` : ''}</span></div>
        <div class="table-wrap"><table class="data-table">
        <thead><tr><th>${ar() ? 'الصنف' : 'Product'}</th><th class="num">${t('gsm')}</th><th class="num">${t('size')}</th>
        <th class="num">${ar() ? 'كمية الإذن' : 'Note qty'}</th><th class="num">${ar() ? 'محسوب سابقًا' : 'Already linked'}</th>
        <th class="num">${ar() ? 'المتاح للربط' : 'Linkable'}</th><th></th></tr></thead>
        <tbody>${rowsHtml}</tbody></table></div>`;
      linesBox.querySelectorAll('.resv-pick-line').forEach((b) => b.addEventListener('click', () => {
        const tr = b.closest('tr');
        currentLineIdx = Number(tr.dataset.idx);
        const l = v.lines[currentLineIdx];
        const key = voucherLineKey(v.key, currentLineIdx, l);
        currentUnconsumed = CALC.round6((Number(l.qty) || 0) - (S.consumed.get(key) || 0));
        linesBox.querySelectorAll('tr').forEach((x) => x.classList.toggle('resv-line-selected', x === tr));
        const st2 = currentSt();
        const trSel = tSel.value ? s.transfersOut.find((x) => x.id === tSel.value) : null;
        const trLeft = trSel ? CALC.round6(trSel.qty - (trSel._loadedSoFar || 0)) : null;
        const maxQ = trSel ? Math.min(currentUnconsumed, trLeft)
          : Math.min(currentUnconsumed, st2 ? st2.remaining : 0);
        qtyIn.max = String(maxQ);
        qtyIn.value = String(maxQ > 0 ? maxQ : '');
        hint.innerHTML = `${ar() ? 'المتاح للربط من هذا السطر' : 'Linkable from this line'}: <strong>${fmtNum(currentUnconsumed)}</strong>
          &nbsp;•&nbsp; ${trSel
            ? `${ar() ? 'المتبقي على التحويل' : 'Transfer remaining'}: <strong>${fmtNum(trLeft)}</strong>`
            : `${ar() ? 'المتبقي على البند' : 'Item remaining'}: <strong>${fmtNum(st2 ? st2.remaining : 0)}</strong>`}`;
      }));
      /* تفسير تحويل / تحميل كمية محوّلة */
      const wrap = node.querySelector('#lnk-transfer-wrap');
      const tSel = node.querySelector('#lnk-transfer');
      const matching = s.transfersOut.filter((x) => x.status === 'active' && App.canonicalCustomer(x.toCustomer) === App.canonicalCustomer(v.customer) && (x.qty - (x._loadedSoFar || 0)) > 0);
      const fillItemOptions = () => {
        iSel.innerHTML = activeItems.map((st) => `<option value="${esc(st.item.id)}">${esc(App.productFamily(st.item.quality))} — ${ar() ? 'جرام' : 'gsm'} ${fmtNum(st.item.gsm)} — ${ar() ? 'مقاس' : 'size'} ${fmtNum(st.item.size)} (${ar() ? 'متبقي' : 'remaining'} ${fmtNum(st.remaining)})</option>`).join('');
        if (itemId && activeItems.some((st) => st.item.id === itemId)) iSel.value = itemId;
      };
      fillItemOptions();
      /* تحميل الكمية المحوّلة يُحسب إلزاميًا على بند الحجز الأصلي الذي تحوّلت منه */
      tSel.addEventListener('change', () => {
        const tr3 = tSel.value ? s.transfersOut.find((x) => x.id === tSel.value) : null;
        if (tr3) {
          iSel.innerHTML = `<option value="${esc(tr3.itemId)}" selected>${esc(App.productFamily(tr3.quality))} — ${ar() ? 'جرام' : 'gsm'} ${fmtNum(tr3.gsm)} — ${ar() ? 'مقاس' : 'size'} ${fmtNum(tr3.size)} (${ar() ? 'بند التحويل الأصلي' : 'transfer source item'})</option>`;
          iSel.disabled = true;
        } else {
          iSel.disabled = false;
          fillItemOptions();
        }
      });
      if (App.canonicalCustomer(v.customer) !== App.canonicalCustomer(res.customer) || matching.length) {
        wrap.hidden = false;
        tSel.innerHTML = matching.length
          ? `<option value="">— ${ar() ? 'بدون تحويل — حساب على متبقي البند' : 'no transfer — count against item remaining'} —</option>`
            + matching.map((x) => `<option value="${esc(x.id)}">${ar() ? 'تحميل كمية محوّلة' : 'load transferred qty'}: ${fmtNum(x.qty - (x._loadedSoFar || 0))} ${ar() ? 'بكرة إلى' : 'to'} ${esc(x.toCustomer)} — ${fmtDate(x.date)}</option>`).join('')
          : `<option value="">${ar() ? 'لا يوجد تحويل مسجل لهذا العميل — سيُسجل الرابط بتنبيه' : 'no matching transfer — link saved with warning'}</option>`;
      } else wrap.hidden = true;
      node.querySelector('#lnk-save').disabled = false;
    });

    node.querySelector('#lnk-cancel').addEventListener('click', closeModal);
    node.querySelector('#lnk-save').addEventListener('click', () => {
      err.textContent = '';
      const v = S.voucherByKey.get(vSel.value);
      const tSel2 = node.querySelector('#lnk-transfer');
      const transfer = (!tSel2.closest('.field').hidden && tSel2.value)
        ? s.transfersOut.find((x) => x.id === tSel2.value) : null;
      /* تحميل كمية محوّلة → البند الهدف هو بند التحويل الأصلي حتمًا */
      const st = transfer ? s.items.get(transfer.itemId) : currentSt();
      const qty = Math.floor(Number(qtyIn.value) || 0);
      if (!v) { err.textContent = ar() ? 'اختر إذن الصرف' : 'Select a delivery note'; return; }
      if (!st) { err.textContent = ar() ? 'اختر بند الحجز' : 'Select item'; return; }
      if (currentLineIdx < 0) { err.textContent = ar() ? 'اختر سطر الإذن المطلوب ربطه' : 'Pick a note line'; return; }
      if (!qty || qty <= 0) { err.textContent = ar() ? 'أدخل كمية أكبر من صفر' : 'Qty must be greater than zero'; return; }
      if (qty > currentUnconsumed) { err.textContent = ar()
        ? `الكمية أكبر من المتاح للربط من هذا السطر (${fmtNum(currentUnconsumed)}) — ممنوع عدّ كمية الصرف نفسها مرتين`
        : `Qty exceeds linkable (${fmtNum(currentUnconsumed)})`; return; }
      if (transfer) {
        const trLeft = CALC.round6(transfer.qty - (transfer._loadedSoFar || 0));
        if (qty > trLeft) { err.textContent = ar()
          ? `الكمية أكبر من المتبقي على التحويل (${fmtNum(trLeft)})`
          : `Qty exceeds transfer remaining (${fmtNum(trLeft)})`; return; }
      } else if (qty > st.remaining) { err.textContent = ar()
        ? `الكمية أكبر من المتبقي على البند (${fmtNum(st.remaining)})`
        : `Qty exceeds item remaining (${fmtNum(st.remaining)})`; return; }
      const line = v.lines[currentLineIdx];
      const rec = {
        id: uid('lnk'),
        reservationId: res.id, reservationSeq: res.seq, customer: res.customer, itemId: st.item.id,
        voucherKey: v.key, voucherKind: v.kind,
        voucherPermitId: v.permitId || null,
        voucherNo: String(v.permitNo || ''), voucherCls: v.cls || '',
        voucherDate: v.date, voucherCustomer: v.customer,
        lineIndex: currentLineIdx, lineQty: Number(line.qty) || 0,
        matched: { quality: st.item.quality, gsm: st.item.gsm, size: st.item.size },
        loadedQty: qty,
        covers: transfer ? 'transfer' : 'remaining',
        transferId: transfer ? transfer.id : null,
        notes: '', linkedAt: new Date().toISOString(),
      };
      Store.saveOne('links', rec);
      const warnCust = App.canonicalCustomer(v.customer) !== App.canonicalCustomer(res.customer)
        ? ` — ${ar() ? `تنبيه: العميل الفعلي المستلم في الإذن (${v.customer})` : ''}` : '';
      audit('link', transfer
        ? `ربط إذن ${rec.voucherNo} بحجز #${res.seq} — تحميل ${qty} بكرة من الكمية المحوّلة إلى ${transfer.toCustomer} (مقاس ${st.item.size} / جرام ${st.item.gsm})`
        : `ربط إذن ${rec.voucherNo} بحجز #${res.seq} — ${qty} بكرة (مقاس ${st.item.size} / جرام ${st.item.gsm})${warnCust}`, { reservationId: res.id });
      closeModal();
      toast(ar() ? `تم ربط الإذن ${rec.voucherNo} مرجعيًا — ${fmtNum(qty)} بكرة محسوبة على الحجز` : 'Delivery note linked (reference only)', 'ok');
      if (typeof onDone === 'function') onDone();
    });
    openModal(node, { title: ar() ? 'ربط إذن صرف قائم (مرجعي فقط)' : 'Link existing delivery note', wide: true });
  }

  /* إزالة رابط (تصحيح تتبع فقط — لا يلمس الإذن نفسه) */
  function unlinkLink(linkId, onDone) {
    const lk = Store.find('links', linkId);
    if (!lk) return;
    confirmDialog({
      title: ar() ? 'إزالة الرابط' : 'Unlink delivery note',
      message: ar()
        ? `إزالة الربط المرجعي مع الإذن ${lk.voucherNo} (${fmtNum(lk.loadedQty)} بكرة) من هذا الحجز؟\nالإذن نفسه لن يُعدل ولا يُحذف — تصحيح للتتبع فقط.`
        : 'Remove this reference link? The delivery note itself is untouched.',
      danger: true, yesLabel: ar() ? 'إزالة الرابط' : 'Unlink',
    }).then((ok) => {
      if (!ok) return;
      Store.removeOne('links', linkId);
      audit('unlink', `إزالة رابط الإذن ${lk.voucherNo} من حجز #${lk.reservationSeq} (${fmtNum(lk.loadedQty)} بكرة)`, { reservationId: lk.reservationId });
      toast(ar() ? 'تمت إزالة الرابط — الإذن القائم لم يُعدل' : 'Link removed (note untouched)', 'ok');
      if (typeof onDone === 'function') onDone();
    });
  }

  /* إلغاء تحويل (تصحيح تتبع — السجل يبقى) */
  function cancelTransfer(transferId, onDone) {
    const tr = Store.find('transfers', transferId);
    if (!tr || tr.status !== 'active') return;
    confirmDialog({
      title: ar() ? 'إلغاء التحويل' : 'Cancel transfer',
      message: ar()
        ? `إلغاء تحويل ${fmtNum(tr.qty)} بكرة من ${tr.fromCustomer} إلى ${tr.toCustomer}؟\nيُسجل الإلغاء ويبقى السجل التاريخي — لا تأثير على المخزون.`
        : 'Record transfer cancellation? History is preserved.',
      danger: true, yesLabel: ar() ? 'إلغاء التحويل' : 'Cancel transfer',
    }).then((ok) => {
      if (!ok) return;
      const fresh = Store.find('transfers', transferId);
      fresh.status = 'cancelled';
      fresh.cancelledAt = new Date().toISOString();
      Store.saveOne('transfers', fresh);
      audit('cancel-transfer', `إلغاء تحويل ${fmtNum(tr.qty)} بكرة من حجز #${tr.fromReservationSeq} إلى ${tr.toCustomer}`, { reservationId: tr.fromReservationId });
      toast(ar() ? 'تم إلغاء التحويل — المخزون لم يتغير' : 'Transfer cancelled (no inventory change)', 'ok');
      if (typeof onDone === 'function') onDone();
    });
  }

  /* ================= 10) نموذج حجز جديد / تعديل حجز ================= */
  function familyOptionsRes() {
    const extra = [];
    for (const p of App.state.products) {
      const f = App.productFamily(p.quality);
      if (!['تست لينر معالج', 'توب لاينر'].includes(f) && !extra.includes(f)) extra.push(f);
    }
    return ['تست لينر معالج', 'توب لاينر'].concat(extra);
  }

  function renderReservationForm(host) {
    const editId = App.pendingReservationEdit || null;
    App.pendingReservationEdit = null;
    const existing = editId ? Store.find('reservations', editId) : null;
    if (editId && !existing) { host.innerHTML = '<div class="card error-card">الحجز غير موجود.</div>'; return; }
    const families = familyOptionsRes();
    const customers = customerList();
    const gsmList = App.knownGsms(null);
    /* البنود المرجعية: هل البند عليه سجلات؟ (يمنع حذفه عند التعديل) */
    const lockedItems = existing ? new Set((() => {
      const set = new Set();
      for (const tr of Store.getAll('transfers')) if (tr.fromReservationId === existing.id) set.add(tr.itemId);
      for (const c of Store.getAll('cancellations')) if (c.reservationId === existing.id) set.add(c.itemId);
      for (const lk of Store.getAll('links')) if (lk.reservationId === existing.id) set.add(lk.itemId);
      return set;
    })()) : new Set();
    const consumedQty = (itId) => {
      if (!existing) return 0;
      const s = computeAll().snapshot.get(existing.id);
      const st = s ? s.items.get(itId) : null;
      return st ? CALC.round6(st.loaded + st.transferred + st.cancelled) : 0;
    };

    host.innerHTML = `
      <div class="page-head"><h2>${existing
        ? (ar() ? `تعديل حجز #${fmtNum(existing.seq)} — ${esc(existing.customer)}` : 'Edit reservation')
        : (ar() ? 'حجز عميل جديد' : 'New customer reservation')}</h2>
        <div class="head-actions"><button class="btn btn-ghost" id="rf-back">← ${ar() ? 'حجوزات العملاء' : 'Reservations'}</button></div></div>
      <div class="card form-card">
        <p class="muted small form-sub">${ar()
          ? 'سجل طلب عميل من البكر: العميل والتاريخ وملاحظات وبنود (الصنف/الجرام/المقاس/الكمية المطلوبة). الوزن التقديري بنفس طريقة التطبيق (المقاس × الكمية × المعامل) — للتتبع فقط دون أي عملية مخزنية.'
          : 'Register a customer reel request — tracking only. Estimated weight reuses the established app method (size × qty × factor).'}</p>
        <form id="rf-form" novalidate>
          <div class="form-grid">
            <label class="field"><span>${ar() ? 'اسم العميل' : 'Customer name'} *</span>
              <input type="text" id="rf-customer" list="rf-cust-list" required placeholder="${ar() ? 'مثال: أحمد عوض' : 'customer'}" value="${esc(existing ? existing.customer : '')}">
              <datalist id="rf-cust-list">${customers.map((c) => `<option value="${esc(c)}"></option>`).join('')}</datalist></label>
            <label class="field"><span>${ar() ? 'تاريخ الحجز' : 'Reservation date'} *</span>
              <input type="date" id="rf-date" required value="${esc(existing ? existing.date : todayISO())}"></label>
            <label class="field field-wide"><span>${t('notes')}</span>
              <input type="text" id="rf-notes" value="${esc(existing ? (existing.notes || '') : '')}"></label>
          </div>
          <section class="field field-wide">
            <div class="card-head-row"><strong>${ar() ? 'بنود الحجز — يمكن تكرار المقاس بجرام أو صنف مختلف' : 'Items'}</strong>
              <button type="button" class="btn btn-ghost" id="rf-add-item">+ ${ar() ? 'إضافة بند' : 'Add item'}</button></div>
            <div id="rf-items"></div>
            <div class="resv-form-totals muted small" id="rf-totals"></div>
          </section>
          <div class="form-error" id="rf-error" role="alert"></div>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary">${t('save')}</button>
            <button type="button" class="btn btn-ghost" id="rf-cancel">${t('cancel')}</button>
          </div>
        </form>
      </div>`;

    host.querySelector('#rf-back').addEventListener('click', () => App.navigate('reservations'));
    host.querySelector('#rf-cancel').addEventListener('click', () => App.navigate('reservations'));
    const itemsHost = host.querySelector('#rf-items');

    const addItemRow = (it) => {
      const d = it || { quality: families[0] || '', gsm: '', size: '', qtyRequired: '' };
      const locked = it && lockedItems.has(it.id);
      const row = document.createElement('div');
      row.className = 'resv-item-row' + (locked ? ' resv-item-locked' : '');
      row.innerHTML = `
        <label class="field"><span>${ar() ? 'الصنف' : 'Product'} *</span>
          <select class="ri-quality">${families.map((f) => `<option value="${esc(f)}" ${d.quality === f ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select></label>
        <label class="field"><span>${t('gsm')} *</span>
          <input class="ri-gsm" type="number" min="1" step="any" list="rf-gsm-list" placeholder="125" value="${esc(d.gsm == null ? '' : d.gsm)}"></label>
        <label class="field"><span>${ar() ? 'المقاس' : 'Size'} *</span>
          <input class="ri-size" type="number" min="1" step="any" placeholder="140" value="${esc(d.size == null ? '' : d.size)}"></label>
        <label class="field"><span>${ar() ? 'الكمية المطلوبة (بكر)' : 'Qty required'} *</span>
          <input class="ri-qty" type="number" min="1" step="1" placeholder="10" value="${esc(d.qtyRequired == null ? '' : d.qtyRequired)}"></label>
        <div class="field resv-est"><span>${ar() ? 'الوزن التقديري' : 'Estimated weight'}</span>
          <div class="resv-est-val muted small">—</div></div>
        <div class="field resv-est"><span>${ar() ? 'المطلوب + المحجوز' : 'Required (+used)'}</span>
          <div class="resv-used-val muted small">—</div></div>
        <div class="resv-item-actions">
          ${locked ? `<span class="badge badge-warn" title="${ar() ? 'عليه سجلات تحويل/إلغاء/ربط — لا يمكن حذف البند، ويمكن تخفيض الكمية حتى المقدار المستخدم' : 'has records'}">${ar() ? 'مثبّت' : 'locked'}</span>` : ''}
          <button type="button" class="btn btn-ghost resv-remove-item" ${locked ? 'disabled title="' + (ar() ? 'عليه سجلات — لا يمكن الحذف' : 'has records') + '"' : ''}>✕</button>
        </div>`;
      if (it) row.dataset.id = it.id;
      itemsHost.appendChild(row);
      const refresh = () => {
        const size = Number(row.querySelector('.ri-size').value);
        const qty = Number(row.querySelector('.ri-qty').value) || 0;
        const estEl = row.querySelector('.resv-est-val');
        estEl.textContent = size > 0 && qty > 0
          ? `≈ ${fmtNum(CALC.productWeight(size, qty, App.state.settings.weightFactor), 2)} ${t('kg')} (${ar() ? 'المقاس × الكمية ×' : 'size × qty ×'} ${App.state.settings.weightFactor})`
          : '—';
        if (it) {
          const used = consumedQty(it.id);
          row.querySelector('.resv-used-val').textContent = used > 0
            ? `${ar() ? 'مستخدم (محمّل/محوّل/ملغى)' : 'used'}: ${fmtNum(used)}`
            : '—';
        }
      };
      row.querySelectorAll('input').forEach((inp) => inp.addEventListener('input', () => { refresh(); updateTotals(); }));
      row.querySelector('.resv-remove-item').addEventListener('click', () => {
        row.remove(); updateTotals();
      });
      refresh();
      return row;
    };

    host.querySelector('#rf-add-item').addEventListener('click', () => addItemRow(null));
    const gsmDatalist = el(`<div><datalist id="rf-gsm-list">${gsmList.map((x) => `<option value="${esc(x)}"></option>`).join('')}</datalist></div>`);
    host.appendChild(gsmDatalist);

    if (existing) (existing.items || []).forEach((it) => addItemRow(it));
    else addItemRow(null);

    function updateTotals() {
      let qty = 0, weight = 0, n = 0;
      itemsHost.querySelectorAll('.resv-item-row').forEach((row) => {
        const size = Number(row.querySelector('.ri-size').value);
        const q = Number(row.querySelector('.ri-qty').value) || 0;
        if (size > 0 && q > 0) { n++; qty += q; weight += CALC.productWeight(size, q, App.state.settings.weightFactor); }
      });
      host.querySelector('#rf-totals').innerHTML = n
        ? `${ar() ? 'عدد البنود' : 'Items'}: <strong>${fmtNum(n)}</strong>
           &nbsp;•&nbsp; ${t('totalRolls')}: <strong>${fmtNum(CALC.round6(qty))}</strong>
           &nbsp;•&nbsp; ${ar() ? 'إجمالي الوزن التقديري' : 'Total est. weight'}: <strong>${fmtNum(CALC.round6(weight), 2)}</strong> ${t('kg')}`
        : '';
    }
    updateTotals();

    host.querySelector('#rf-form').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const err = host.querySelector('#rf-error');
      err.textContent = '';
      const customer = host.querySelector('#rf-customer').value.trim();
      const date = host.querySelector('#rf-date').value;
      const notes = host.querySelector('#rf-notes').value.trim();
      const items = [];
      itemsHost.querySelectorAll('.resv-item-row').forEach((row) => {
        const quality = row.querySelector('.ri-quality').value;
        const gsm = row.querySelector('.ri-gsm').value === '' ? null : Number(row.querySelector('.ri-gsm').value);
        const size = row.querySelector('.ri-size').value === '' ? null : Number(row.querySelector('.ri-size').value);
        const qtyRequired = Math.floor(Number(row.querySelector('.ri-qty').value) || 0);
        if (quality && gsm > 0 && size > 0 && qtyRequired > 0) {
          items.push({ id: row.dataset.id || uid('itm'), quality, gsm, size, qtyRequired });
        }
      });
      const problems = [];
      if (!customer) problems.push(ar() ? 'اسم العميل مطلوب' : 'Customer name required');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) problems.push(ar() ? 'تاريخ الحجز مطلوب' : 'Date required');
      if (!items.length) problems.push(ar() ? 'أدخل بندًا واحدًا على الأقل كاملًا (الصنف والجرام والمقاس والكمية)' : 'At least one complete item is required');
      /* تكرار نفس التركيبة داخل الحجز — لا يُسمح (المقاس نفسه بجرام مختلف مسموح) */
      const seen = new Set();
      for (const it of items) {
        const k = CALC.comboKey(it.quality, it.gsm, it.size);
        if (seen.has(k)) problems.push(ar()
          ? `التركيبة (${esc(App.productFamily(it.quality))} — جرام ${fmtNum(it.gsm)} — مقاس ${fmtNum(it.size)}) مكررة — اجمع كميتها في بند واحد`
          : 'Duplicate (product, gsm, size) combination — combine quantities');
        seen.add(k);
      }
      /* عند التعديل: الكمية الجديدة لا تقل عن المحمّل + المحوّل + الملغى */
      if (existing) {
        const s = computeAll().snapshot.get(existing.id);
        for (const it of items) {
          const st = s ? s.items.get(it.id) : null;
          if (st && it.qtyRequired < st.loaded + st.transferred + st.cancelled) {
            problems.push(ar()
              ? `بند مقاس ${fmtNum(it.size)} / جرام ${fmtNum(it.gsm)}: الكمية الجديدة (${fmtNum(it.qtyRequired)}) أقل من المحمّل+المحوّل+الملغى (${fmtNum(CALC.round6(st.loaded + st.transferred + st.cancelled))})`
              : 'Qty below already loaded/transferred/cancelled');
          }
        }
      }
      if (problems.length) {
        err.innerHTML = problems.map((p) => `• ${esc(p)}`).join('<br>');
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
      const now = new Date().toISOString();
      if (existing) {
        const fresh = Store.find('reservations', existing.id);
        const oldById = new Map((fresh.items || []).map((x) => [x.id, x]));
        fresh.items = items.map((it) => {
          const old = oldById.get(it.id);
          return old ? Object.assign({}, old, { quality: it.quality, gsm: it.gsm, size: it.size, qtyRequired: it.qtyRequired })
            : Object.assign({ createdAt: now }, it);
        });
        fresh.customer = customer; fresh.date = date; fresh.notes = notes;
        fresh.updatedAt = now;
        Store.saveOne('reservations', fresh);
        audit('edit', `تعديل حجز #${fresh.seq} (${customer}) — ${items.length} بند`, { reservationId: fresh.id });
        toast(ar() ? 'تم حفظ التعديل — السجلات التاريخية محفوظة' : 'Reservation updated', 'ok');
        App.pendingReservationId = fresh.id;
        App.navigate('reservation-details');
      } else {
        const all = Store.getAll('reservations');
        const rec = {
          id: uid('res'), seq: nextSeq(all), customer, date, notes,
          cancelled: false, cancelDate: null, cancelReason: '',
          createdAt: now, updatedAt: now,
          items: items.map((it) => Object.assign({ createdAt: now }, it)),
        };
        Store.saveOne('reservations', rec);
        audit('create', `حجز جديد #${rec.seq} للعميل ${customer} — ${items.length} بند / ${items.reduce((s, x) => s + x.qtyRequired, 0)} بكرة`, { reservationId: rec.id });
        toast(ar() ? `تم حفظ الحجز #${fmtNum(rec.seq)} — تتبع فقط دون أي تأثير على المخزون` : 'Reservation saved (tracking only)', 'ok');
        App.pendingReservationId = rec.id;
        App.navigate('reservation-details');
      }
    });
  }

  /* ================= 11) شاشة تفاصيل الحجز ================= */
  function renderReservationDetails(host) {
    const id = App.pendingReservationId;
    App.pendingReservationId = null;
    const res = id ? Store.find('reservations', id) : null;
    if (!res) {
      const all = Store.getAll('reservations');
      const fallback = all.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0];
      if (fallback) { App.pendingReservationId = fallback.id; return renderReservationDetails(host); }
      host.innerHTML = `<div class="card error-card">${ar() ? 'لا يوجد حجز محدد — ارجع إلى قائمة الحجوزات.' : 'No reservation selected.'}
        <div style="margin-top:.6rem"><button class="btn btn-primary" id="rd-back0">← ${ar() ? 'حجوزات العملاء' : 'Reservations'}</button></div></div>`;
      const b0 = host.querySelector('#rd-back0'); if (b0) b0.addEventListener('click', () => App.navigate('reservations'));
      return;
    }
    const S = computeAll();
    const s = S.snapshot.get(res.id);
    const tt = s.totals;
    const estTotal = tt.estWeight;
    const clsChip = (cls) => cls === 'ض'
      ? '<span class="badge badge-tax">ضريبي</span>'
      : '<span class="badge badge-nontax">غير ضريبي</span>';
    const reload = () => { App.pendingReservationId = res.id; App.rerender(); };

    host.innerHTML = `
      <div class="page-head"><h2>${ar() ? `حجز #${fmtNum(res.seq)} — ${esc(res.customer)}` : `Reservation #${fmtNum(res.seq)}`}</h2>
        <div class="head-actions">
          <button class="btn btn-ghost" id="rd-back">← ${ar() ? 'حجوزات العملاء' : 'Reservations'}</button>
          ${!res.cancelled ? `<button class="btn btn-ghost" id="rd-edit">✎ ${t('edit')}</button>` : ''}
        </div></div>
      ${res.cancelled ? `<div class="card notice-card resv-notice">
        <strong>${ar() ? 'الحجز ملغى بالكامل' : 'Reservation cancelled'}</strong>
        <div class="small muted">${ar() ? 'تاريخ الإلغاء' : 'Cancelled on'}: ${fmtDate(res.cancelDate)}${res.cancelReason ? ' — ' + esc(res.cancelReason) : ''}
        — ${ar() ? 'الكميات المحمّلة والمحوّلة قبل الإلغاء محفوظة في السجل كما هي' : ''}</div></div>` : ''}
      <div class="resv-meta-grid">
        <div class="card resv-meta"><div class="muted small">${ar() ? 'العميل' : 'Customer'}</div><div class="resv-meta-val">${esc(res.customer)}</div></div>
        <div class="card resv-meta"><div class="muted small">${ar() ? 'تاريخ الحجز' : 'Date'}</div><div class="resv-meta-val">${fmtDate(res.date)}</div></div>
        <div class="card resv-meta"><div class="muted small">${ar() ? 'الحالة' : 'Status'}</div><div class="resv-meta-val">${resStatusChip(s.status)}</div></div>
        <div class="card resv-meta"><div class="muted small">${t('notes')}</div><div class="resv-meta-val resv-notes">${esc(res.notes || '—')}</div></div>
      </div>
      <div class="stats-grid resv-stats resv-stats-sm">
        ${[
          { num: fmtNum(tt.required), label: ar() ? 'المطلوبة أصلًا' : 'Requested', accent: 'green' },
          { num: fmtNum(tt.available), label: ar() ? 'متاح في المخزون' : 'Available', accent: 'green' },
          { num: fmtNum(tt.awaiting), label: ar() ? 'بانتظار الإنتاج' : 'Awaiting', accent: 'amber' },
          { num: fmtNum(tt.loaded), label: ar() ? 'محمّلة (من أذون مرتبطة)' : 'Loaded', accent: 'teal' },
          { num: fmtNum(tt.loadedTransferred), label: ar() ? 'تحميل محوّل لعملاء آخرين' : 'Loaded transferred', accent: 'amber' },
          { num: fmtNum(tt.transferred), label: ar() ? 'محوّلة لعملاء آخرين' : 'Transferred out', accent: 'amber' },
          { num: fmtNum(tt.cancelled), label: ar() ? 'ملغاة' : 'Cancelled', accent: 'red' },
          { num: fmtNum(tt.remaining), label: ar() ? 'المتبقية للعميل' : 'Remaining', accent: 'teal' },
          { num: `${fmtNum(estTotal, 2)}`, label: `${ar() ? 'الوزن التقديري (كجم)' : 'Est. weight (kg)'}`, accent: 'teal' },
        ].map((c) => `<div class="stat-card accent-${c.accent}">
          <div class="stat-num">${c.num}</div>
          <div class="stat-label">${esc(c.label)}</div>
        </div>`).join('')}
      </div>
      ${s.receivedViaTransfers > 0 ? `<div class="card weight-line">${ar() ? 'مستلم عبر تحويلات من حجوزات عملاء آخرين (عرض مستقل — لا يُدمج مع المطلوب):' : 'Received via transfers (displayed separately):'} <strong>${fmtNum(s.receivedViaTransfers)}</strong> ${t('rolls')}</div>` : ''}

      <div class="card">
        <div class="card-head-row"><h3>${ar() ? 'بنود الحجز والمتابعة' : 'Reservation items'}</h3>
          <div class="btn-row">
            ${!res.cancelled && tt.remaining > 0 ? `<button class="btn btn-primary" id="rd-link">🔗 ${ar() ? 'ربط إذن صرف' : 'Link delivery note'}</button>
            <button class="btn btn-ghost" id="rd-transfer">⇄ ${ar() ? 'تحويل كمية' : 'Transfer qty'}</button>
            <button class="btn btn-warn" id="rd-cancel">🚫 ${ar() ? 'إلغاء كمية/حجز' : 'Cancel qty'}</button>` : ''}
          </div></div>
        <div class="table-wrap"><table class="data-table resv-items-table">
          <thead><tr>
            <th>${ar() ? 'الصنف' : 'Product'}</th><th class="num">${t('gsm')}</th><th class="num">${t('size')}</th>
            <th class="num">${ar() ? 'المطلوبة' : 'Required'}</th>
            <th class="num">${ar() ? 'متاح الآن' : 'Available'}</th>
            <th class="num">${ar() ? 'بانتظار' : 'Awaiting'}</th>
            <th class="num">${ar() ? 'محمّلة' : 'Loaded'}</th>
            <th class="num">${ar() ? 'تحميل المحوّل' : 'Transferred loaded'}</th>
            <th class="num">${ar() ? 'محوّلة' : 'Transferred'}</th>
            <th class="num">${ar() ? 'ملغاة' : 'Cancelled'}</th>
            <th class="num">${ar() ? 'المتبقي' : 'Remaining'}</th>
            <th>${ar() ? 'الوزن التقديري' : 'Est. weight'}</th>
            <th>${ar() ? 'الحالة' : 'Status'}</th>
            <th>${t('actions')}</th>
          </tr></thead>
          <tbody>${[...s.items.values()].map((st) => `
            <tr>
              <td data-label="${ar() ? 'الصنف' : 'Product'}">${esc(App.productFamily(st.item.quality))}</td>
              <td class="num" data-label="${t('gsm')}">${fmtNum(st.item.gsm)}</td>
              <td class="num" data-label="${t('size')}">${fmtNum(st.item.size)}</td>
              <td class="num" data-label="${ar() ? 'المطلوبة' : 'Required'}">${fmtNum(st.required)}</td>
              <td class="num pos" data-label="${ar() ? 'متاح' : 'Available'}">${fmtNum(st.available)}</td>
              <td class="num" data-label="${ar() ? 'بانتظار' : 'Awaiting'}">${fmtNum(st.awaiting)}</td>
              <td class="num" data-label="${ar() ? 'محمّلة' : 'Loaded'}">${fmtNum(st.loaded)}</td>
              <td class="num" data-label="${ar() ? 'تحميل المحوّل' : 'Transferred loaded'}">${fmtNum(st.loadedTransferred)}</td>
              <td class="num" data-label="${ar() ? 'محوّلة' : 'Transferred'}">${fmtNum(st.transferred)}</td>
              <td class="num" data-label="${ar() ? 'ملغاة' : 'Cancelled'}">${fmtNum(st.cancelled)}</td>
              <td class="num" data-label="${ar() ? 'المتبقي' : 'Remaining'}"><strong>${fmtNum(st.remaining)}</strong></td>
              <td data-label="${ar() ? 'الوزن التقديري' : 'Est. weight'}" class="small muted">≈ ${fmtNum(st.estWeightTotal, 2)} ${t('kg')}</td>
              <td data-label="${ar() ? 'الحالة' : 'Status'}">${itemStatusChip(st)}</td>
              <td class="actions-cell">
                ${st.remaining > 0 && !res.cancelled ? `
                  <button class="icon-btn" data-trf="${esc(st.item.id)}" title="${ar() ? 'تحويل كمية من هذا البند' : 'Transfer from item'}">⇄</button>
                  <button class="icon-btn" data-link="${esc(st.item.id)}" title="${ar() ? 'ربط إذن صرف بهذا البند' : 'Link note'}">🔗</button>
                  <button class="icon-btn danger" data-cnl="${esc(st.item.id)}" title="${ar() ? 'إلغاء كمية (كاملة/جزئية)' : 'Cancel qty'}">🚫</button>`
                : '<span class="muted small">—</span>'}
              </td>
            </tr>`).join('')}</tbody>
        </table></div>
      </div>

      <div class="card">
        <div class="card-head-row"><h3>${ar() ? 'سجل التحويلات المرتبطة (صادر/وارد)' : 'Transfer history'}</h3></div>
        <div class="table-wrap"><table class="data-table">
          <thead><tr><th>${t('date')}</th><th>${ar() ? 'الاتجاه' : 'Direction'}</th><th>${ar() ? 'الطرف الآخر' : 'Other party'}</th>
          <th>${ar() ? 'الصنف' : 'Product'}</th><th class="num">${t('gsm')}</th><th class="num">${t('size')}</th>
          <th class="num">${ar() ? 'الكمية' : 'Qty'}</th><th>${ar() ? 'الحالة' : 'Status'}</th><th>${t('notes')}</th><th></th></tr></thead>
          <tbody>${(() => {
            const out = s.transfersOut.map((x) => ({ x, dir: 'out' }));
            const inn = s.transfersIn.map((x) => ({ x, dir: 'in' }));
            const list = out.concat(inn).sort((a, b) => String(b.x.createdAt || '').localeCompare(String(a.x.createdAt || '')));
            if (!list.length) return `<tr><td colspan="10" class="empty">${ar() ? 'لا تحويلات' : 'No transfers'}</td></tr>`;
            return list.map(({ x, dir }) => `<tr>
              <td data-label="${t('date')}">${fmtDate(x.date)}</td>
              <td data-label="${ar() ? 'الاتجاه' : 'Direction'}">${dir === 'out'
                ? `<span class="badge badge-tax">${ar() ? 'محوّل إلى' : 'To'}</span>`
                : `<span class="badge badge-nontax">${ar() ? 'مستلم من' : 'From'}</span>`}</td>
              <td data-label="${ar() ? 'الطرف' : 'Party'}">${dir === 'out' ? esc(x.toCustomer) : esc(x.fromCustomer)} ${dir === 'out' ? `(${ar() ? 'حجز أصلي' : 'source'}: #${fmtNum(x.fromReservationSeq)})` : ''}</td>
              <td data-label="${ar() ? 'الصنف' : 'Product'}">${esc(App.productFamily(x.quality))}</td>
              <td class="num" data-label="${t('gsm')}">${fmtNum(x.gsm)}</td>
              <td class="num" data-label="${t('size')}">${fmtNum(x.size)}</td>
              <td class="num" data-label="${ar() ? 'الكمية' : 'Qty'}"><strong>${fmtNum(x.qty)}</strong></td>
              <td data-label="${ar() ? 'الحالة' : 'Status'}">${x.status === 'active'
                ? (x._loadedSoFar >= x.qty
                  ? `<span class="resv-chip resv-st-loaded">${ar() ? 'محمّل بالكامل للعميل المستلم' : 'fully loaded'}</span>`
                  : `<span class="resv-chip resv-st-available">${ar() ? 'ساري — محمّل' : 'active — loaded'} ${fmtNum(x._loadedSoFar || 0)}/${fmtNum(x.qty)}</span>`)
                : `<span class="resv-chip resv-st-cancelled">${ar() ? 'ملغي' : 'cancelled'}</span>`}</td>
              <td data-label="${t('notes')}">${esc(x.notes || '—')}</td>
              <td class="actions-cell">${x.status === 'active' ? `<button class="icon-btn danger" data-ctrf="${esc(x.id)}" title="${ar() ? 'إلغاء هذا التحويل' : 'Cancel transfer'}">🚫</button>` : ''}</td>
            </tr>`).join('');
          })()}</tbody>
        </table></div>
      </div>

      <div class="card">
        <div class="card-head-row"><h3>${ar() ? 'أذون الصرف المرتبطة (مرجعية — القراءة فقط)' : 'Linked delivery notes (reference-only)'}</h3></div>
        <div class="table-wrap"><table class="data-table">
          <thead><tr><th>${ar() ? 'رقم الإذن' : 'Note no.'}</th><th>${ar() ? 'تاريخه' : 'Note date'}</th>
          <th>${ar() ? 'العميل المسجل في الإذن' : 'Note customer'}</th>
          <th>${ar() ? 'المقاس / الجرام المحمّل' : 'Size / GSM loaded'}</th>
          <th class="num">${ar() ? 'كمية الإذن' : 'Note qty'}</th>
          <th class="num">${ar() ? 'المحسوب على الحجز' : 'Counted here'}</th>
          <th>${ar() ? 'نوع الربط' : 'Link type'}</th>
          <th>${ar() ? 'البكر الفعلية المستلمة' : 'Actual receiver'}</th>
          <th>${ar() ? 'حالة الرابط' : 'Link status'}</th><th></th></tr></thead>
          <tbody>${(() => {
            if (!s.links.length) return `<tr><td colspan="10" class="empty">${ar() ? 'لا توجد أذون مرتبطة' : 'No linked notes'}</td></tr>`;
            return s.links.map((lk) => {
              const v = lk._voucher;
              const line = v ? (v.lines || [])[lk.lineIndex] : null;
              const st = s.items.get(lk.itemId);
              const sameCust = App.canonicalCustomer(lk.voucherCustomer) === App.canonicalCustomer(res.customer);
              const receiverCell = sameCust
                ? `<span class="muted small">${ar() ? 'عميل الحجز نفسه' : 'same as reservation'}</span>`
                : `${esc(lk.voucherCustomer)}${lk.transferId
                  ? `<div class="muted small">${ar() ? 'مفسَّر بتحويل من الحجز الأصلي' : 'explained by transfer'}</div>`
                  : `<div class="muted small resv-warn-inline">${ar() ? 'بدون تحويل مسجل' : 'no transfer record'}</div>`}`;
              const linkStatusCell = lk._stale
                ? `<span class="resv-chip resv-st-cancelled">${ar() ? 'الإذن لم يعد موجودًا — خرج من الإجماليات' : 'note deleted — excluded'}</span>`
                : `<span class="resv-chip resv-st-loaded">${ar() ? 'سليم — محسوب في المحمّل' : 'active — counted'}</span>`;
              return `<tr>
                <td data-label="${ar() ? 'رقم الإذن' : 'Note'}"><strong dir="ltr">${esc(lk.voucherNo || '—')}</strong>${lk.voucherCls ? ' ' + clsChip(lk.voucherCls) : ''}</td>
                <td data-label="${ar() ? 'التاريخ' : 'Date'}">${fmtDate(lk.voucherDate)}</td>
                <td data-label="${ar() ? 'عميل الإذن' : 'Note customer'}">${esc(lk.voucherCustomer)}</td>
                <td data-label="${ar() ? 'المقاس/الجرام' : 'Size/GSM'}">${line
                  ? `${ar() ? 'مقاس' : 'size'} ${fmtNum(line.size)} — ${ar() ? 'جرام' : 'gsm'} ${fmtNum(line.gsm)} — ${esc(App.productFamily(line.quality))}`
                  : (ar() ? 'الإذن غير متاح للقراءة' : 'n/a')}</td>
                <td class="num" data-label="${ar() ? 'كمية الإذن' : 'Note qty'}">${line ? fmtNum(line.qty) : '—'}</td>
                <td class="num" data-label="${ar() ? 'المحسوب' : 'Counted'}"><strong>${fmtNum(lk.loadedQty)}</strong>${st ? `<div class="muted small">${ar() ? 'من بند' : 'item'}: مقاس ${fmtNum(st.item.size)} / جرام ${fmtNum(st.item.gsm)}</div>` : ''}</td>
                <td data-label="${ar() ? 'المستلم' : 'Receiver'}">${receiverCell}</td>
                <td data-label="${ar() ? 'نوع الربط' : 'Link type'}">${lk.covers === 'transfer'
                  ? `<span class="resv-chip resv-st-transferred">${ar() ? 'تحميل كمية محوّلة' : 'transferred load'}</span>`
                  : `<span class="muted small">${ar() ? 'تغطية متبقي البند' : 'covers item remaining'}</span>`}</td>
                <td data-label="${ar() ? 'الحالة' : 'Status'}">${linkStatusCell}</td>
                <td class="actions-cell"><button class="icon-btn danger" data-unlink="${esc(lk.id)}" title="${ar() ? 'إزالة الرابط (الإذن لا يُعدل)' : 'Unlink'}">✕</button></td>
              </tr>`;
            }).join('');
          })()}</tbody>
        </table></div>
        <p class="muted small" style="padding:.4rem .6rem">${ar()
          ? 'هذا الربط مرجعي فقط — القراءة من الإذن الأصلي دون أي تعديل عليه، ولا يُنشأ إذن جديد، ولا تُحسب كمية الصرف نفسها مرتين.'
          : 'Reference-only reading from existing notes; nothing is created or modified.'}</p>
      </div>

      <div class="card">
        <div class="card-head-row"><h3>${ar() ? 'سجل الإلغاءات المرتبطة' : 'Cancellation history'}</h3></div>
        <div class="table-wrap"><table class="data-table">
          <thead><tr><th>${t('date')}</th><th>${ar() ? 'الصنف' : 'Product'}</th>
          <th class="num">${t('gsm')}</th><th class="num">${t('size')}</th>
          <th class="num">${ar() ? 'الكمية الملغاة' : 'Cancelled qty'}</th>
          <th>${ar() ? 'النطاق' : 'Scope'}</th><th>${ar() ? 'السبب' : 'Reason'}</th></tr></thead>
          <tbody>${(() => {
            const list = s.cancellations.slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
            if (!list.length) return `<tr><td colspan="7" class="empty">${ar() ? 'لا إلغاءات' : 'No cancellations'}</td></tr>`;
            return list.map((x) => `<tr>
              <td data-label="${t('date')}">${fmtDate(x.date)}</td>
              <td data-label="${ar() ? 'الصنف' : 'Product'}">${esc(App.productFamily(x.quality))}</td>
              <td class="num" data-label="${t('gsm')}">${fmtNum(x.gsm)}</td>
              <td class="num" data-label="${t('size')}">${fmtNum(x.size)}</td>
              <td class="num" data-label="${ar() ? 'الملغاة' : 'Cancelled'}"><strong>${fmtNum(x.qty)}</strong></td>
              <td data-label="${ar() ? 'النطاق' : 'Scope'}">${x.level === 'reservation' ? (ar() ? 'حجز كامل' : 'whole reservation') : (x.level === 'item' ? (ar() ? 'بند كامل' : 'whole item') : (ar() ? 'جزء من بند' : 'partial'))}</td>
              <td data-label="${ar() ? 'السبب' : 'Reason'}">${esc(x.reason || '—')}</td>
            </tr>`).join('');
          })()}</tbody>
        </table></div>
      </div>`;

    host.querySelector('#rd-back').addEventListener('click', () => App.navigate('reservations'));
    const editBtn = host.querySelector('#rd-edit');
    if (editBtn) editBtn.addEventListener('click', () => { App.pendingReservationEdit = res.id; App.navigate('reservation-form'); });
    const linkBtn = host.querySelector('#rd-link');
    if (linkBtn) linkBtn.addEventListener('click', () => openLinkModal(res.id, null, reload));
    const trfBtn = host.querySelector('#rd-transfer');
    if (trfBtn) trfBtn.addEventListener('click', () => openTransferModal(res.id, null, reload));
    const cnlBtn = host.querySelector('#rd-cancel');
    if (cnlBtn) cnlBtn.addEventListener('click', () => openCancelModal(res.id, null, reload));
    host.querySelectorAll('[data-trf]').forEach((b) => b.addEventListener('click', () => openTransferModal(res.id, b.dataset.trf, reload)));
    host.querySelectorAll('[data-link]').forEach((b) => b.addEventListener('click', () => openLinkModal(res.id, b.dataset.link, reload)));
    host.querySelectorAll('[data-cnl]').forEach((b) => b.addEventListener('click', () => openCancelModal(res.id, b.dataset.cnl, reload)));
    host.querySelectorAll('[data-unlink]').forEach((b) => b.addEventListener('click', () => unlinkLink(b.dataset.unlink, reload)));
    host.querySelectorAll('[data-ctrf]').forEach((b) => b.addEventListener('click', () => cancelTransfer(b.dataset.ctrf, reload)));
  }

  /* ================= 12) التسجيل في المسارات والتحديث الحي ================= */
  App.registerView('reservations', renderReservations);
  App.registerView('reservation-form', renderReservationForm);
  App.registerView('reservation-details', renderReservationDetails);
  App.openReservationDetails = (id) => { App.pendingReservationId = id; App.navigate('reservation-details'); };
  /* Read-only data provider for the combined printable reservation report.
     (محتفظ به للتوافق — مصدره الآن نفس دالة الكشف الموحّد تمامًا) */
  App.getReservationPrintRows = (reservationIds) => {
    const selected = new Set((reservationIds || []).map(String));
    return reservationReportRows(null)
      .filter((x) => selected.has(String(x.reservationId)))
      .map((x) => ({
        reservationId: x.reservationId,
        customer: x.customer,
        quality: x.quality,
        gsm: x.gsm,
        size: x.size,
        required: x.qty,
        available: x.available,
        loaded: x.loaded,
      }));
  };
  App.openTransferModal = openTransferModal;
  App.openCancelModal = openCancelModal;
  App.openLinkModal = openLinkModal;

  /* إعادة عرض القسم عند تحديث البيانات القائمة (إنتاج جديد / اعتماد إذن)
     — قراءة فقط: الحساب يعاد تلقائيًا من أحدث بيانات المخزون والإنتاج */
  EventBus.on('data', () => {
    const r = App.currentRoute();
    if (r === 'reservations' || r === 'reservation-details') App.rerender();
  });
  EventBus.on('lang', () => {
    const r = App.currentRoute();
    if (r === 'reservations' || r === 'reservation-details' || r === 'reservation-form') App.rerender();
  });

  /* Node export for automated tests */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { KEYS, Store, computeAll, voucherLineKey, uid, reservationReportRows, reservationReportTotals, unifiedTableHtml };
  }


})(typeof window !== 'undefined' ? window : globalThis);
