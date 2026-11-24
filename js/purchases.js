/* =========================================================================
   purchases.js — الموردون والمشتريات (v9) + استلام البكر + مرتجعات الموردين
   -------------------------------------------------------------------------
   القاعدة الأهم (تكامل المخزون):
   • محرك الرصيد القائم هو السلطة الوحيدة على المخزون. هذا القسم لا يضيف
     أي كمية للمخزون من تلقاء نفسه أبدًا.
   • الاستلام الفعلي يجري حصرًا عبر «تسجيل البكر» القائم (TX.saveRollWithReels):
     كل بكرة مسجلة تُنشئ حركة إنتاج واحدة بالضبط عبر الآلية القائمة نفسها،
     ثم يُسجل الرابط مع الفاتورة (متجر receives) — الرابط لا ينشئ حركة ثانية.
   • ربط بكر متاحة مسبقًا بفاتورة = تسجيل رابط فقط، بلا أي حركة مخزنية.
   • البكرة الواحدة لا تُربط إلا بفاتورة شراء واحدة (فهرس reelId الفريد).
   • مرتجعات الموردين تُنفذ كحركات صرف صريحة قابلة للتتبع (source
     'supplier-return') وحالة البكرة تتغير إلى «مرجعة للمورد» — لا تعديل
     صامت على أي سجل تاريخي، وإلغاء المرتجع ينشئ حركة عكس صريحة.
   • فواتير الشراء لا تلمس المخزون: مسودة / جزئي / مستلمة / ملغاة.
   التخزين (DB v3 — ترحيل إضافي بحت):
     suppliers / purchases / receives / supreturns — منفصلة تمامًا عن
     متاجر المخزون القائمة، وتدخل النسخة الاحتياطية (schema 4).
   الترقيم: مورد SUP-#### · فاتورة P-#### · مرتجع RT-#### (تسلسلات محفوظة
     في الإعدادات ولا يُعاد استخدام رقم محذوف).
   ========================================================================= */
(function (global) {
  'use strict';
  const CALC = global.CALC;
  const DB = global.DB;
  const TX = global.TX;

  /* ================= core helpers (DOM-free — Node-testable) ================= */
  function cleanStr(v) { return v == null ? '' : String(v).trim(); }
  function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
  function round6(n) { return CALC ? CALC.round6(n) : Math.round(n * 1e6) / 1e6; }
  function uuid() {
    try { return global.crypto.randomUUID(); } catch (e) {
      return 'pur-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    }
  }
  function nowISO() { return new Date().toISOString(); }
  function pad4(n) { return String(n).padStart(4, '0'); }
  function normName(v) {
    return cleanStr(v).replace(/[\u064B-\u0652\u0670]/g, '')
      .replace(/[\u0622\u0623\u0625]/g, '\u0627').replace(/\u0649/g, '\u064A')
      .replace(/\u0640/g, '').replace(/\s+/g, ' ').toLowerCase();
  }
  const PURCHASE_STATUS = {
    draft: { ar: 'مسودة', en: 'Draft' },
    partial: { ar: 'مستلمة جزئيًا', en: 'Partially received' },
    received: { ar: 'مستلمة بالكامل', en: 'Fully received' },
    cancelled: { ar: 'ملغاة', en: 'Cancelled' },
  };
  function purchaseStatusLabel(st) {
    const s = PURCHASE_STATUS[st] || PURCHASE_STATUS.draft;
    return global.UI ? (global.UI.getLang() === 'ar' ? s.ar : s.en) : s.ar;
  }

  /* Largest numeric sequence used in a store + persisted floor → next seq.
     Reads inside the caller's atomic transaction via getAll (procurement
     stores are small), so a seq can never repeat even after deletions. */
  function nextSeqInTx(store, settingsStore, seqKey, prefixRe, onDone) {
    const allReq = store.getAll();
    allReq.onsuccess = () => {
      let maxSeq = 0;
      for (const row of (allReq.result || [])) {
        const m = prefixRe.exec(cleanStr(row.seq));
        if (m) maxSeq = Math.max(maxSeq, Number(m[1]));
      }
      const g = settingsStore.get(seqKey);
      g.onsuccess = () => {
        const floor = Number(g.result ? g.result.value : 0) || 0;
        const n = Math.max(maxSeq + 1, floor || 1);
        settingsStore.put({ key: seqKey, value: n + 1 });
        onDone(n);
      };
    };
    allReq.onerror = () => onDone(1);
  }

  /* ================= SUPPLIERS ================= */
  function validateSupplier(s) {
    const errors = [];
    if (!cleanStr(s.name)) errors.push('اسم المورد مطلوب');
    if (cleanStr(s.name).length > 120) errors.push('اسم المورد طويل جدًا');
    return errors;
  }

  function createSupplier(input) {
    const rec = {
      name: cleanStr(input.name),
      phone: cleanStr(input.phone),
      address: cleanStr(input.address),
      contact: cleanStr(input.contact),
      notes: cleanStr(input.notes),
      archived: false,
      createdAt: nowISO(), updatedAt: null,
    };
    const errors = validateSupplier(rec);
    if (errors.length) return Promise.reject({ type: 'validation', errors });
    rec.nameKey = normName(rec.name);
    return DB.atomic(['suppliers', 'audit', 'settings'], (t, setFail) => {
      const st = t.objectStore('suppliers');
      const dup = st.index('nameKey').get(rec.nameKey);
      dup.onsuccess = () => {
        if (dup.result) {
          setFail({ type: 'validation', errors: [`يوجد مورد بنفس الاسم بالفعل: «${dup.result.name}» — منع إنشاء مورد مكرر`] });
          t.abort(); return;
        }
        const setStore = t.objectStore('settings');
        nextSeqInTx(st, setStore, 'supplierSeq', /^(\d+)$/, (n) => {
          rec.code = 'SUP-' + pad4(n);
          const addReq = st.add(rec); /* unique code + nameKey indexes guard races */
          addReq.onsuccess = () => { rec.id = addReq.result; };
          t.objectStore('audit').add({
            entity: 'supplier', action: 'add', entityId: rec.id, before: null, after: rec,
            at: nowISO(), details: `إضافة مورد ${rec.code} — ${rec.name}`,
          });
        });
      };
      return { get: () => rec };
    }).then((res) => res.get());
  }

  function updateSupplier(id, changes) {
    return DB.atomic(['suppliers', 'audit'], (t, setFail) => {
      const st = t.objectStore('suppliers');
      const g = st.get(id);
      g.onsuccess = () => {
        const before = g.result;
        if (!before) { setFail({ type: 'validation', errors: ['المورد غير موجود'] }); t.abort(); return; }
        const merged = Object.assign({}, before, {
          name: cleanStr(changes.name !== undefined ? changes.name : before.name),
          phone: cleanStr(changes.phone !== undefined ? changes.phone : before.phone),
          address: cleanStr(changes.address !== undefined ? changes.address : before.address),
          contact: cleanStr(changes.contact !== undefined ? changes.contact : before.contact),
          notes: cleanStr(changes.notes !== undefined ? changes.notes : before.notes),
          updatedAt: nowISO(),
        });
        const errors = validateSupplier(merged);
        if (errors.length) { setFail({ type: 'validation', errors }); t.abort(); return; }
        merged.nameKey = normName(merged.name);
        const dup = st.index('nameKey').get(merged.nameKey);
        dup.onsuccess = () => {
          if (dup.result && dup.result.id !== id) {
            setFail({ type: 'validation', errors: [`يوجد مورد آخر بنفس الاسم: «${dup.result.name}»`] });
            t.abort(); return;
          }
          st.put(merged);
          t.objectStore('audit').add({
            entity: 'supplier', action: 'edit', entityId: id, before, after: merged,
            at: nowISO(), details: `تعديل مورد ${before.code} — ${merged.name}`,
          });
        };
      };
      return { ok: true };
    });
  }

  function setSupplierArchived(id, archived) {
    return DB.atomic(['suppliers', 'audit'], (t, setFail) => {
      const st = t.objectStore('suppliers');
      const g = st.get(id);
      g.onsuccess = () => {
        const before = g.result;
        if (!before) { setFail({ type: 'validation', errors: ['المورد غير موجود'] }); t.abort(); return; }
        const after = Object.assign({}, before, { archived: !!archived, updatedAt: nowISO() });
        st.put(after);
        t.objectStore('audit').add({
          entity: 'supplier', action: archived ? 'archive' : 'unarchive', entityId: id,
          before, after, at: nowISO(),
          details: `${archived ? 'أرشفة' : 'إلغاء أرشفة'} مورد ${before.code} — ${before.name}`,
        });
      };
      return { ok: true };
    });
  }

  /* Suppliers WITH historical transactions (purchases/receives/returns)
     can never be permanently deleted — archive them instead. */
  function deleteSupplier(id) {
    return DB.atomic(['suppliers', 'purchases', 'receives', 'supreturns', 'audit'], (t, setFail) => {
      const st = t.objectStore('suppliers');
      const g = st.get(id);
      g.onsuccess = () => {
        const before = g.result;
        if (!before) { setFail({ type: 'validation', errors: ['المورد غير موجود'] }); t.abort(); return; }
        const pu = t.objectStore('purchases').index('supplierId').getAll(id);
        const re = t.objectStore('receives').index('purchaseId').getAll();
        const rt = t.objectStore('supreturns').index('supplierId').getAll(id);
        pu.onsuccess = () => {
          const purchaseIds = new Set((pu.result || []).map((p) => p.id));
          re.onsuccess = () => {
            const hasReceive = (re.result || []).some((r) => purchaseIds.has(r.purchaseId));
            rt.onsuccess = () => {
              if ((pu.result || []).length || hasReceive || (rt.result || []).length) {
                setFail({ type: 'validation', errors: [`لا يمكن حذف المورد ${before.name}: له سجل مشتريات/استلامات/مرتجعات — استخدم «أرشفة» بدل الحذف.`] });
                t.abort(); return;
              }
              st.delete(id);
              t.objectStore('audit').add({
                entity: 'supplier', action: 'delete', entityId: id, before, after: null,
                at: nowISO(), details: `حذف مورد بلا سجلات: ${before.code} — ${before.name}`,
              });
            };
          };
        };
      };
      return { ok: true };
    });
  }

  /* ================= PURCHASE INVOICES ================= */
  /* line: {quality, gsm, size, qty, unitPrice, priceBasis 'reel'|'kg'} */
  function normalizeLine(l, i, wf) {
    const qty = Math.max(0, Math.floor(num(l.qty)));
    const unitPrice = Math.max(0, num(l.unitPrice));
    const priceBasis = l.priceBasis === 'kg' ? 'kg' : 'reel';
    const size = num(l.size);
    const line = {
      id: l.id || uuid(),
      quality: cleanStr(l.quality),
      gsm: l.gsm == null || l.gsm === '' ? null : num(l.gsm),
      size: size > 0 ? size : null,
      qty,
      unitPrice, priceBasis,
      receivedQty: Math.max(0, Math.floor(num(l.receivedQty))),
      returnedQty: Math.max(0, Math.floor(num(l.returnedQty))),
      weightActual: round6(Math.max(0, num(l.weightActual))),
      weightEstimated: size > 0 && qty > 0 && wf > 0 ? round6(qty * size * (wf || 7.5)) : null,
    };
    line.lineTotal = line.priceBasis === 'kg'
      ? round6(unitPrice * (line.weightActual || line.weightEstimated || 0))
      : round6(unitPrice * line.qty);
    return line;
  }

  function validatePurchase(p) {
    const errors = [];
    if (!cleanStr(p.supplierId)) errors.push('اختر المورد');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cleanStr(p.invoiceDate))) errors.push('تاريخ الفاتورة مطلوب بصيغة صحيحة');
    if (!p.lines || !p.lines.length) errors.push('أضف سطر شراء واحدًا على الأقل');
    for (const l of p.lines || []) {
      if (!cleanStr(l.quality)) errors.push('الصنف مطلوب في كل سطر');
      if (!(num(l.gsm) > 0)) errors.push(`الجرام مطلوب في سطر ${l.size == null ? '—' : l.size}`);
      if (!(num(l.size) > 0)) errors.push('المقاس مطلوب في كل سطر');
      if (!(num(l.qty) > 0)) errors.push(`الكمية يجب أن تكون أكبر من صفر (مقاس ${l.size == null ? '—' : l.size})`);
      if (num(l.unitPrice) < 0) errors.push('السعر لا يمكن أن يكون سالبًا');
    }
    if (num(p.extraCosts) < 0 || num(p.discount) < 0) errors.push('المصاريف والخصم لا يمكن أن يكونا سالبين');
    if (num(p.paid) < 0) errors.push('المدفوع لا يمكن أن يكون سالبًا');
    return errors;
  }

  function recomputePurchaseTotals(p, wf) {
    for (const l of p.lines) {
      if (l.weightEstimated == null && l.size > 0 && l.qty > 0) {
        l.weightEstimated = round6(l.qty * l.size * (wf || 7.5));
      }
      l.lineTotal = l.priceBasis === 'kg'
        ? round6(num(l.unitPrice) * (l.weightActual || l.weightEstimated || 0))
        : round6(num(l.unitPrice) * l.qty);
    }
    p.subtotal = round6(p.lines.reduce((s, l) => s + (l.lineTotal || 0), 0));
    p.finalTotal = round6(num(p.subtotal) + num(p.extraCosts) - num(p.discount));
    p.remaining = round6(num(p.finalTotal) - num(p.paid));
    const anyReceived = p.lines.some((l) => (l.receivedQty || 0) > 0);
    const allReceived = p.lines.every((l) => (l.receivedQty || 0) >= l.qty);
    if (p.status === 'cancelled') { /* keep cancelled flag */ }
    else if (anyReceived && allReceived) p.status = 'received';
    else if (anyReceived) p.status = 'partial';
    else p.status = 'draft';
    return p;
  }

  /* supplierInvoiceNo duplicate protection per supplier — exceptions only
     through the explicit `allowException` review flag (audited). */
  function createPurchase(input) {
    const wf = (global.App && global.App.state && global.App.state.settings.weightFactor) || 7.5;
    const p = {
      id: uuid(),
      seq: null,
      supplierId: input.supplierId,
      supplierName: cleanStr(input.supplierName),
      supplierInvoiceNo: cleanStr(input.supplierInvoiceNo),
      invoiceDate: cleanStr(input.invoiceDate),
      lines: (input.lines || []).map((l) => normalizeLine(l, 0, wf)),
      extraCosts: round6(num(input.extraCosts)),
      discount: round6(num(input.discount)),
      paid: round6(num(input.paid)),
      notes: cleanStr(input.notes),
      status: 'draft',
      invoiceNoException: false,
      createdAt: nowISO(), updatedAt: null,
    };
    const errors = validatePurchase(p);
    if (errors.length) return Promise.reject({ type: 'validation', errors });
    const allowException = !!input.allowException;
    return DB.atomic(['purchases', 'suppliers', 'audit', 'settings'], (t, setFail) => {
      const pStore = t.objectStore('purchases');
      const sGet = t.objectStore('suppliers').get(Number(p.supplierId));
      sGet.onsuccess = () => {
        const sup = sGet.result;
        if (!sup) { setFail({ type: 'validation', errors: ['المورد غير موجود'] }); t.abort(); return; }
        p.supplierId = sup.id;
        p.supplierName = sup.name;
        const allReq = pStore.getAll();
        allReq.onsuccess = () => {
          const all = allReq.result || [];
          const errs = [];
          if (p.supplierInvoiceNo) {
            const dup = all.find((x) => Number(x.supplierId) === sup.id
              && cleanStr(x.supplierInvoiceNo) === p.supplierInvoiceNo
              && x.status !== 'cancelled');
            if (dup && !allowException) {
              errs.push({ field: 'invoiceNo', msg: `رقم فاتورة المورد «${p.supplierInvoiceNo}» مستخدم مسبقًا في الفاتورة ${purchaseSeqLabel(dup)} لنفس المورد — راجع الاستثناء أو غيّر الرقم` });
            } else if (dup && allowException) {
              p.invoiceNoException = true;
            }
          }
          if (errs.length) { setFail({ type: 'validation', errors: errs }); t.abort(); return; }
          nextSeqInTx(pStore, t.objectStore('settings'), 'purchaseSeq', /^(\d+)$/, (n) => {
            p.seq = n;
            recomputePurchaseTotals(p, wf);
            const addReq = pStore.add(p);
            addReq.onsuccess = () => { p.idSaved = p.id; };
            t.objectStore('audit').add({
              entity: 'purchase', action: 'add', entityId: p.id, before: null, after: p,
              at: nowISO(),
              details: `فاتورة شراء ${purchaseSeqLabel(p)} — المورد: ${sup.name} — ${p.lines.length} سطر — الإجمالي ${p.finalTotal}${p.invoiceNoException ? ' (رقم فاتورة مورد مكرر — استثناء معتمد بمراجعة)' : ''}`,
            });
          });
        };
      };
      return { get: () => p };
    }).then((res) => res.get());
  }

  function purchaseSeqLabel(p) { return 'P-' + pad4(num(p && p.seq)); }
  function returnSeqLabel(r) { return 'RT-' + pad4(num(r && r.seq)); }

  function updatePurchase(id, input) {
    const wf = (global.App && global.App.state && global.App.state.settings.weightFactor) || 7.5;
    return DB.atomic(['purchases', 'receives', 'audit'], (t, setFail) => {
      const pStore = t.objectStore('purchases');
      const g = pStore.get(id);
      g.onsuccess = () => {
        const before = g.result;
        if (!before) { setFail({ type: 'validation', errors: ['الفاتورة غير موجودة'] }); t.abort(); return; }
        if (before.status !== 'draft') {
          setFail({ type: 'validation', errors: ['لا يمكن تعديل فاتورة غير مسودة — الفواتير التي بدأ استلامها أو الملغاة تبقى كما هي لحفظ السجل.'] });
          t.abort(); return;
        }
        const merged = Object.assign({}, before, {
          supplierInvoiceNo: cleanStr(input.supplierInvoiceNo !== undefined ? input.supplierInvoiceNo : before.supplierInvoiceNo),
          invoiceDate: cleanStr(input.invoiceDate !== undefined ? input.invoiceDate : before.invoiceDate),
          extraCosts: round6(num(input.extraCosts !== undefined ? input.extraCosts : before.extraCosts)),
          discount: round6(num(input.discount !== undefined ? input.discount : before.discount)),
          paid: round6(num(input.paid !== undefined ? input.paid : before.paid)),
          notes: cleanStr(input.notes !== undefined ? input.notes : before.notes),
          updatedAt: nowISO(),
        });
        if (input.lines) merged.lines = input.lines.map((l) => normalizeLine(l, 0, wf));
        const errors = validatePurchase(merged);
        if (errors.length) { setFail({ type: 'validation', errors }); t.abort(); return; }
        const allReq = pStore.getAll();
        allReq.onsuccess = () => {
          const errs = [];
          /* keeping the invoice's own number is never a conflict (same rule
             as the issue-permit editor); only a CHANGED number is checked */
          const keptIdentity = cleanStr(merged.supplierInvoiceNo) === cleanStr(before.supplierInvoiceNo);
          if (merged.supplierInvoiceNo && !keptIdentity) {
            const dup = (allReq.result || []).find((x) => x.id !== id
              && Number(x.supplierId) === Number(merged.supplierId)
              && cleanStr(x.supplierInvoiceNo) === merged.supplierInvoiceNo
              && x.status !== 'cancelled');
            if (dup && !before.invoiceNoException) {
              errs.push({ field: 'invoiceNo', msg: `رقم فاتورة المورد «${merged.supplierInvoiceNo}» مستخدم مسبقًا في ${purchaseSeqLabel(dup)} لنفس المورد` });
            }
          }
          if (errs.length) { setFail({ type: 'validation', errors: errs }); t.abort(); return; }
          recomputePurchaseTotals(merged, wf);
          pStore.put(merged);
          t.objectStore('audit').add({
            entity: 'purchase', action: 'edit', entityId: id, before, after: merged,
            at: nowISO(), details: `تعديل فاتورة شراء ${purchaseSeqLabel(merged)}`,
          });
        };
      };
      return { ok: true };
    });
  }

  /* Cancel = status flag only. Received reels keep their (real) movements —
     with explicit confirmation when any receiving is already linked. */
  function cancelPurchase(id, opts) {
    return DB.atomic(['purchases', 'receives', 'audit'], (t, setFail) => {
      const pStore = t.objectStore('purchases');
      const g = pStore.get(id);
      g.onsuccess = () => {
        const before = g.result;
        if (!before) { setFail({ type: 'validation', errors: ['الفاتورة غير موجودة'] }); t.abort(); return; }
        if (before.status === 'cancelled') {
          setFail({ type: 'validation', errors: ['الفاتورة ملغاة بالفعل'] }); t.abort(); return;
        }
        const recReq = t.objectStore('receives').index('purchaseId').getAll(id);
        recReq.onsuccess = () => {
          const linked = (recReq.result || []).length;
          if (linked && !(opts && opts.force)) {
            setFail({ type: 'validation', errors: [`الفاتورة عليها ${linked} عملية استلام بكر مسجلة — إلغاؤها لا يحذف البكر ولا حركاتها. أكّد الإلغاء للاحتفاظ بالبكر كأصول مخزنية فعلية.`] });
            t.abort(); return;
          }
          const after = Object.assign({}, before, { status: 'cancelled', cancelledAt: nowISO(), updatedAt: nowISO() });
          pStore.put(after);
          t.objectStore('audit').add({
            entity: 'purchase', action: 'cancel', entityId: id, before, after,
            at: nowISO(),
            details: `إلغاء فاتورة شراء ${purchaseSeqLabel(before)}${linked ? ` — بقاء ${linked} استلام وبكرها وحركاتها كما هي` : ''}`,
          });
        };
      };
      return { ok: true };
    });
  }

  /* Hard delete allowed ONLY for untouched drafts (no receiving links) —
     anything else is historical and stays. */
  function deletePurchase(id) {
    return DB.atomic(['purchases', 'receives', 'audit'], (t, setFail) => {
      const pStore = t.objectStore('purchases');
      const g = pStore.get(id);
      g.onsuccess = () => {
        const before = g.result;
        if (!before) { setFail({ type: 'validation', errors: ['الفاتورة غير موجودة'] }); t.abort(); return; }
        const recReq = t.objectStore('receives').index('purchaseId').getAll(id);
        recReq.onsuccess = () => {
          if ((recReq.result || []).length || before.status !== 'draft') {
            setFail({ type: 'validation', errors: ['لا يمكن حذف فاتورة بدأ استلامها أو غير مسودة — السجل التاريخي محفوظ. استخدم «إلغاء» بدلًا من الحذف.'] });
            t.abort(); return;
          }
          pStore.delete(id);
          t.objectStore('audit').add({
            entity: 'purchase', action: 'delete', entityId: id, before, after: null,
            at: nowISO(), details: `حذف مسودة فاتورة شراء ${purchaseSeqLabel(before)} (بلا استلامات)`,
          });
        };
      };
      return { ok: true };
    });
  }

  /* ================= RECEIVING (استلام البكر) =================
     ONE entry point for both flows:
     • kind 'register': the reels were JUST created through the existing
       reel-registration engine (TX.saveRollWithReels) — the movement rows
       already exist exactly once; this only records the links.
     • kind 'link': already-registered AVAILABLE reels are being linked to
       the invoice — no movement is created or modified here either.
     The unique `receives.reelId` index makes double-linking impossible. */
  function linkReels(payload) {
    const ids = [...new Set((payload.reelIds || []).map((v) => String(v)))].filter(Boolean);
    if (!ids.length) return Promise.reject({ type: 'validation', errors: ['لم تُحدد بكر للاستلام'] });
    return DB.atomic(['purchases', 'receives', 'reels', 'audit'], (t, setFail) => {
      const wf = (global.App && global.App.state && global.App.state.settings.weightFactor) || 7.5;
      const pGet = t.objectStore('purchases').get(payload.purchaseId);
      const reelGets = ids.map((id) => t.objectStore('reels').get(id));
      const dupGets = ids.map((id) => t.objectStore('receives').index('reelId').get(id));
      let pending = 1 + reelGets.length + dupGets.length;
      const step = () => { if (--pending > 0) return; finish(); };
      reelGets.forEach((r) => { r.onsuccess = step; });
      dupGets.forEach((r) => { r.onsuccess = step; });
      pGet.onsuccess = step;

      function finish() {
        const p = pGet.result;
        const errs = [];
        if (!p) errs.push('فاتورة الشراء غير موجودة');
        else if (p.status === 'cancelled') errs.push('الفاتورة ملغاة — لا يمكن استلام بكر عليها. أنشئ فاتورة صحيحة أو راجع الاستلام.');
        const line = p ? (p.lines || []).find((l) => l.id === payload.lineId) : null;
        if (p && !line) errs.push('بند الفاتورة غير موجود — حدّث الفاتورة وأعد المحاولة');
        const reels = reelGets.map((g) => g.result);
        let weightSum = 0;
        reels.forEach((r, i) => {
          if (!r) { errs.push('بكرة محددة غير موجودة في المخزون — أعد التحديد'); return; }
          if (r.status !== 'available') {
            errs.push(`البكرة ${r.rollNo}/${r.reelNo} حالتها «${TX.REEL_STATUS[r.status] || r.status}» — لا يمكن استلامها/ربطها`);
            return;
          }
          if (line && (cleanStr(r.quality) !== cleanStr(line.quality)
            || String(CALC.toNumberOrRaw(r.gram)) !== String(CALC.toNumberOrRaw(line.gsm))
            || String(CALC.toNumberOrRaw(r.size)) !== String(CALC.toNumberOrRaw(line.size)))) {
            errs.push(`البكرة ${r.rollNo}/${r.reelNo} لا تطابق مواصفات البند (${line.quality} / ${line.gsm} جرام / مقاس ${line.size})`);
            return;
          }
          if (dupGets[i].result) {
            errs.push(`البكرة ${r.rollNo}/${r.reelNo} مرتبطة مسبقًا بفاتورة شراء أخرى — لا يمكن ربط بكرة بفاتورتين`);
          }
          weightSum += Number(r.weight) || 0;
        });
        if (line && line.receivedQty + ids.length > line.qty) {
          errs.push(`الاستلام يتجاوز كمية البند: المطلوب ${line.qty} — المستلم سابقًا ${line.receivedQty} — المحدد الآن ${ids.length}`);
        }
        if (errs.length) { setFail({ type: 'validation', errors: errs }); t.abort(); return; }

        const recStore = t.objectStore('receives');
        const date = cleanStr(payload.date) || (global.UI ? global.UI.todayISO() : '');
        ids.forEach((reelId, i) => {
          const r = reels[i];
          recStore.add({
            id: uuid(), purchaseId: p.id, purchaseSeq: p.seq, lineId: line.id,
            reelId, rollNo: r.rollNo, reelNo: r.reelNo,
            quality: cleanStr(r.quality), gsm: CALC.toNumberOrRaw(r.gram), size: CALC.toNumberOrRaw(r.size),
            qty: 1, weight: Number(r.weight) || 0,
            weightSource: Number(r.weight) > 0 ? 'actual' : 'none',
            date, notes: cleanStr(payload.notes || ''),
            kind: payload.kind === 'register' ? 'register' : 'link',
            createdAt: nowISO(),
          });
        });
        line.receivedQty += ids.length;
        line.weightActual = round6(num(line.weightActual) + weightSum);
        recomputePurchaseTotals(p, wf);
        p.updatedAt = nowISO();
        t.objectStore('purchases').put(p);
        t.objectStore('audit').add({
          entity: 'receive', action: 'add', entityId: p.id, before: null,
          after: { purchase: purchaseSeqLabel(p), reels: ids.length, weight: round6(weightSum), kind: payload.kind || 'link' },
          at: nowISO(),
          details: `استلام ${ids.length} بكرة على الفاتورة ${purchaseSeqLabel(p)} — ${p.supplierName}${payload.kind === 'register' ? ' (عبر تسجيل البكر — حركة الإنتاج أنشئت مرة واحدة بالآلية القائمة)' : ' (ربط بكر مسجلة مسبقًا — بلا أي حركة مخزنية جديدة)'}`,
        });
      }
      return { ok: true };
    });
  }

  /* Full receiving flow for new goods: register the reels through the
     EXISTING engine (exactly one production movement per reel) then link.
     If the link step fails, the reels still exist correctly (movements
     intact) and the user can retry via «ربط بكر متاحة» — no stock is ever
     duplicated or lost. */
  function receiveRegister(payload) {
    return TX.saveRollWithReels({
      date: payload.date,
      gram: payload.gram,
      notes: payload.notes || '',
      reels: payload.reels,
    }).then((res) => linkReels({
      purchaseId: payload.purchaseId,
      lineId: payload.lineId,
      reelIds: res.reelIds,
      date: payload.date,
      notes: (payload.notes || '') + '',
      kind: 'register',
    }).then(() => res));
  }

  /* Tracking correction: remove a wrong link (no stock effect — the reel
     and its movement stay untouched). */
  function unlinkReceive(receiveId) {
    return DB.atomic(['purchases', 'receives', 'audit'], (t, setFail) => {
      const wf = (global.App && global.App.state && global.App.state.settings.weightFactor) || 7.5;
      const g = t.objectStore('receives').get(receiveId);
      g.onsuccess = () => {
        const rec = g.result;
        if (!rec) { setFail({ type: 'validation', errors: ['سجل الاستلام غير موجود'] }); t.abort(); return; }
        const pGet = t.objectStore('purchases').get(rec.purchaseId);
        pGet.onsuccess = () => {
          const p = pGet.result;
          if (!p) { setFail({ type: 'validation', errors: ['الفاتورة المرتبطة لم تعد موجودة'] }); t.abort(); return; }
          const line = (p.lines || []).find((l) => l.id === rec.lineId);
          if (line) {
            line.receivedQty = Math.max(0, line.receivedQty - (rec.qty || 1));
            line.weightActual = round6(Math.max(0, num(line.weightActual) - (num(rec.weight) || 0)));
          }
          recomputePurchaseTotals(p, wf);
          p.updatedAt = nowISO();
          t.objectStore('purchases').put(p);
          t.objectStore('receives').delete(receiveId);
          t.objectStore('audit').add({
            entity: 'receive', action: 'delete', entityId: receiveId, before: rec, after: null,
            at: nowISO(), details: `إزالة رابط استلام (${rec.rollNo}/${rec.reelNo}) من الفاتورة ${purchaseSeqLabel(p)} — البكرة وحركتها كما هي`,
          });
        };
      };
      return { ok: true };
    });
  }

  /* ================= SUPPLIER RETURNS (مرتجعات الموردين) ================= */

  function createReturn(input) {
    const errors = [];
    const date = cleanStr(input.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) errors.push('تاريخ المرتجع مطلوب بصيغة صحيحة');
    const lines = (input.lines || []).map((l) => ({
      lineId: l.lineId || null,
      quality: cleanStr(l.quality),
      gsm: l.gsm == null || l.gsm === '' ? null : num(l.gsm),
      size: num(l.size) > 0 ? num(l.size) : null,
      qty: Math.max(0, Math.floor(num(l.qty))),
      reelIds: [...new Set((l.reelIds || []).map(String))].filter(Boolean),
      weight: 0,
    })).filter((l) => l.qty > 0 || l.reelIds.length);
    if (!lines.length) errors.push('أضف بند مرتجع واحدًا على الأقل');
    for (const l of lines) {
      if (!cleanStr(l.quality)) errors.push('الصنف مطلوب في كل بند مرتجع');
      if (!(num(l.gsm) > 0)) errors.push('الجرام مطلوب في كل بند مرتجع');
      if (!(num(l.size) > 0)) errors.push('المقاس مطلوب في كل بند مرتجع');
      if (l.reelIds.length && l.reelIds.length !== l.qty) {
        errors.push(`المقاس ${l.size}: الكمية يجب أن تساوي عدد البكر المحددة (${l.reelIds.length})`);
      }
      if (!l.reelIds.length && !(l.qty > 0)) errors.push(`المقاس ${l.size}: أدخل كمية أو حدد بكرًا`);
    }
    if (errors.length) return Promise.reject({ type: 'validation', errors });
    const supplierId = Number(input.supplierId);
    const purchaseId = input.purchaseId || null;

    return DB.atomic(['supreturns', 'suppliers', 'purchases', 'reels', 'transactions', 'products', 'audit', 'settings'], (t, setFail) => {
      let created = null;
      const sGet = t.objectStore('suppliers').get(supplierId);
      sGet.onsuccess = () => {
        const sup = sGet.result;
        if (!sup) { setFail({ type: 'validation', errors: ['المورد غير موجود'] }); t.abort(); return; }

        const finishLines = (purchase) => {
          const errs = [];
          const reelStore = t.objectStore('reels');
          const allReelReq = reelStore.getAll();
          allReelReq.onsuccess = () => {
            const allReels = allReelReq.result || [];
            const byId = new Map(allReels.map((r) => [r.id, r]));
            /* reels already inside ANY active return — prevent returning twice */
            const actReq = t.objectStore('supreturns').index('status').getAll('active');
            actReq.onsuccess = () => {
              const returnedIds = new Set();
              for (const r of (actReq.result || [])) {
                for (const l of (r.lines || [])) for (const id of (l.reelIds || [])) returnedIds.add(id);
              }
              for (const l of lines) {
                if (l.reelIds.length) {
                  for (const id of l.reelIds) {
                    const reel = byId.get(id);
                    if (!reel) { errs.push('بكرة محددة غير موجودة في المخزون'); continue; }
                    if (reel.status === 'dispatched') { errs.push(`البكرة ${reel.rollNo}/${reel.reelNo} مصروفة للعميل — لا يمكن مرتجعها للمورد`); continue; }
                    if (reel.status !== 'available') { errs.push(`البكرة ${reel.rollNo}/${reel.reelNo} حالتها «${TX.REEL_STATUS[reel.status] || reel.status}» — يمكن مرتجع البكر المتاحة فقط`); continue; }
                    if (returnedIds.has(id)) { errs.push(`البكرة ${reel.rollNo}/${reel.reelNo} داخل مرتجع نشط بالفعل — لا يمكن مرتجعها مرتين`); continue; }
                    l.weight += Number(reel.weight) || 0;
                  }
                }
                if (purchase && l.lineId) {
                  const pl = (purchase.lines || []).find((x) => x.id === l.lineId);
                  if (pl) {
                    if (l.qty > Math.max(0, (pl.receivedQty || 0) - (pl.returnedQty || 0))) {
                      errs.push(`المرتجع يتجاوز المتبقي القابل للمرتجع في البند (مقاس ${pl.size}): المستلم ${pl.receivedQty} — المرتجع سابقًا ${pl.returnedQty || 0}`);
                    }
                  }
                }
              }
              if (errs.length) { setFail({ type: 'validation', errors: errs }); t.abort(); return; }

              nextSeqInTx(t.objectStore('supreturns'), t.objectStore('settings'), 'returnSeq', /^(\d+)$/, (seqN) => {
                const ret = {
                  id: uuid(), seq: seqN,
                  supplierId: sup.id, supplierName: sup.name,
                  purchaseId: purchase ? purchase.id : null,
                  purchaseSeq: purchase ? purchase.seq : null,
                  date, reason: cleanStr(input.reason), notes: cleanStr(input.notes),
                  lines: lines.map((l) => Object.assign({}, l, { weight: round6(l.weight) })),
                  status: 'active', cancelledAt: null, cancelReason: '',
                  createdAt: nowISO(), updatedAt: null,
                };
                const retNo = returnSeqLabel(ret);
                /* explicit, traceable stock-out movements (one per reel or one
                   per quantity line) through the same transaction engine */
                const groupId = 'RT:' + ret.id;
                const txStore = t.objectStore('transactions');
                const rows = [];
                for (const l of ret.lines) {
                  if (l.reelIds.length) {
                    for (const id of l.reelIds) {
                      const reel = byId.get(id);
                      rows.push({
                        date, quality: cleanStr(reel.quality), gsm: CALC.toNumberOrRaw(reel.gram),
                        size: CALC.toNumberOrRaw(reel.size), customer: sup.name, permitNo: '',
                        addQty: 0, outQty: 1, weight: Number(reel.weight) || null,
                        settlement: '', notes: `${retNo} مرتجع مورد — رول ${reel.rollNo}/بكرة ${reel.reelNo}`,
                        groupId, returnId: ret.id, source: 'supplier-return',
                        fingerprint: null, createdAt: nowISO(), updatedAt: null,
                      });
                    }
                  } else {
                    rows.push({
                      date, quality: l.quality, gsm: CALC.toNumberOrRaw(l.gsm),
                      size: CALC.toNumberOrRaw(l.size), customer: sup.name, permitNo: '',
                      addQty: 0, outQty: l.qty, weight: null,
                      settlement: '', notes: `${retNo} مرتجع مورد — مقاس ${l.size} (كمية)`,
                      groupId, returnId: ret.id, source: 'supplier-return',
                      fingerprint: null, createdAt: nowISO(), updatedAt: null,
                    });
                  }
                }
                const vErrs = [];
                rows.forEach((r) => vErrs.push(...TX.validate(r)));
                if (vErrs.length) { setFail({ type: 'validation', errors: vErrs }); t.abort(); return; }
                rows.forEach((r) => txStore.add(r));
                /* product-master top-up (same helper the app already uses) */
                if (TX.ensureProduct) { /* async-safe top-up outside tx for new combos */ }
                const prodStore = t.objectStore('products');
                rows.forEach((r) => {
                  const combo = CALC.comboKey(r.quality, r.gsm, r.size);
                  const pg = prodStore.index('combo').get(combo);
                  pg.onsuccess = () => {
                    if (!pg.result) prodStore.add({ quality: r.quality, gsm: r.gsm, size: r.size,
                      combo, source: 'supplier-return', createdAt: nowISO() });
                  };
                });
                /* flip returned reels to «مرجعة للمورد» */
                for (const l of ret.lines) {
                  for (const id of l.reelIds) {
                    const reel = byId.get(id);
                    reelStore.put(Object.assign({}, reel, {
                      status: 'returned',
                      returnRef: { returnId: ret.id, returnNo: retNo, date, supplierName: sup.name },
                      updatedAt: nowISO(),
                    }));
                  }
                }
                /* track on the purchase line — never rewrite history */
                if (purchase) {
                  for (const l of ret.lines) {
                    if (!l.lineId) continue;
                    const pl = (purchase.lines || []).find((x) => x.id === l.lineId);
                    if (pl) pl.returnedQty = (pl.returnedQty || 0) + l.qty;
                  }
                  purchase.updatedAt = nowISO();
                  t.objectStore('purchases').put(purchase);
                }
                const addReq = t.objectStore('supreturns').add(ret);
                addReq.onsuccess = () => { created = ret; };
                t.objectStore('audit').add({
                  entity: 'return', action: 'add', entityId: ret.id, before: null,
                  after: ret, at: nowISO(),
                  details: `مرتجع مورد ${retNo} — ${sup.name}${purchase ? ` على الفاتورة ${purchaseSeqLabel(purchase)}` : ''} — ${ret.lines.reduce((s, l) => s + l.qty, 0)} بكرة/كمية — حركات صرف صريحة ${rows.length}`,
                });
              });
            };
          };
        };

        if (purchaseId) {
          const pGet = t.objectStore('purchases').get(purchaseId);
          pGet.onsuccess = () => {
            const purchase = pGet.result;
            if (!purchase) { setFail({ type: 'validation', errors: ['فاتورة الشراء المرتبطة غير موجودة'] }); t.abort(); return; }
            finishLines(purchase);
          };
        } else finishLines(null);
      };
      return { get: () => created };
    }).then((res) => res.get() || Promise.reject(new Error('لم يُسجل المرتجع')));
  }

  /* Cancelling a return creates EXPLICIT reversal movements (addQty,
     source 'return-cancel') and restores the reels to «متاحة» — recorded
     exactly once (guarded by the status check). History is preserved. */
  function cancelReturn(returnId, cancelReason) {
    return DB.atomic(['supreturns', 'reels', 'transactions', 'products', 'purchases', 'audit'], (t, setFail) => {
      const g = t.objectStore('supreturns').get(returnId);
      g.onsuccess = () => {
        const ret = g.result;
        if (!ret) { setFail({ type: 'validation', errors: ['المرتجع غير موجود'] }); t.abort(); return; }
        if (ret.status !== 'active') {
          setFail({ type: 'validation', errors: ['المرتجع ملغى بالفعل — العكس مسجل مرة واحدة ولا يُعاد'] });
          t.abort(); return;
        }
        const retNo = returnSeqLabel(ret);
        const now = nowISO();
        const reelStore = t.objectStore('reels');
        const allReq = reelStore.getAll();
        allReq.onsuccess = () => {
          const byId = new Map((allReq.result || []).map((r) => [r.id, r]));
          const txStore = t.objectStore('transactions');
          const groupId = 'RTC:' + ret.id;
          const rows = [];
          for (const l of ret.lines) {
            if (l.reelIds.length) {
              for (const id of l.reelIds) {
                const reel = byId.get(id);
                if (!reel) continue;
                rows.push({
                  date: global.UI ? global.UI.todayISO() : ret.date,
                  quality: cleanStr(reel.quality), gsm: CALC.toNumberOrRaw(reel.gram),
                  size: CALC.toNumberOrRaw(reel.size), customer: ret.supplierName, permitNo: '',
                  addQty: 1, outQty: 0, weight: Number(reel.weight) || null,
                  settlement: '', notes: `إلغاء ${retNo} — عكس مرتجع مورد (عودة البكرة للمخزون)`,
                  groupId, returnId: ret.id, source: 'return-cancel',
                  fingerprint: null, createdAt: now, updatedAt: null,
                });
                if (reel.status === 'returned' && reel.returnRef && reel.returnRef.returnId === ret.id) {
                  reelStore.put(Object.assign({}, reel, { status: 'available', returnRef: null, updatedAt: now }));
                }
              }
            } else {
              rows.push({
                date: global.UI ? global.UI.todayISO() : ret.date,
                quality: l.quality, gsm: CALC.toNumberOrRaw(l.gsm), size: CALC.toNumberOrRaw(l.size),
                customer: ret.supplierName, permitNo: '',
                addQty: l.qty, outQty: 0, weight: null,
                settlement: '', notes: `إلغاء ${retNo} — عكس مرتجع مورد`,
                groupId, returnId: ret.id, source: 'return-cancel',
                fingerprint: null, createdAt: now, updatedAt: null,
              });
            }
          }
          rows.forEach((r) => txStore.add(r));
          const prodStore = t.objectStore('products');
          rows.forEach((r) => {
            const combo = CALC.comboKey(r.quality, r.gsm, r.size);
            const pg = prodStore.index('combo').get(combo);
            pg.onsuccess = () => {
              if (!pg.result) prodStore.add({ quality: r.quality, gsm: r.gsm, size: r.size,
                combo, source: 'return-cancel', createdAt: nowISO() });
            };
          });
          if (ret.purchaseId) {
            const pGet = t.objectStore('purchases').get(ret.purchaseId);
            pGet.onsuccess = () => {
              const p = pGet.result;
              if (p) {
                for (const l of ret.lines) {
                  if (!l.lineId) continue;
                  const pl = (p.lines || []).find((x) => x.id === l.lineId);
                  if (pl) pl.returnedQty = Math.max(0, (pl.returnedQty || 0) - l.qty);
                }
                p.updatedAt = now;
                t.objectStore('purchases').put(p);
              }
            };
          }
          const after = Object.assign({}, ret, {
            status: 'cancelled', cancelledAt: now,
            cancelReason: cleanStr(cancelReason || ''), updatedAt: now,
          });
          t.objectStore('supreturns').put(after);
          t.objectStore('audit').add({
            entity: 'return', action: 'cancel', entityId: ret.id, before: ret, after,
            at: now, details: `إلغاء مرتجع ${retNo} — حركات عكس صريحة (${rows.length}) وعودة البكر للمخزون`,
          });
        };
      };
      return { ok: true };
    });
  }

  global.PUR = {
    PURCHASE_STATUS, purchaseStatusLabel, purchaseSeqLabel, returnSeqLabel,
    normName, validateSupplier, createSupplier, updateSupplier, setSupplierArchived, deleteSupplier,
    validatePurchase, recomputePurchaseTotals, createPurchase, updatePurchase, cancelPurchase, deletePurchase,
    linkReels, receiveRegister, unlinkReceive,
    createReturn, cancelReturn,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.PUR;

  /* ================= UI (browser only) ================= */
  if (!global.App || !global.UI) return;

  const UI = global.UI;
  const App = global.App;
  const { t, el, esc, fmtNum, fmtDate, todayISO, toast, confirmDialog, openModal, closeModal } = UI;
  const lang = () => UI.getLang() === 'ar';
  const ar = lang;
  const familyOf = (n) => App.productFamily(n);
  const CANON = ['تست لينر معالج', 'توب لاينر'];
  const wfSetting = () => App.state.settings.weightFactor || 7.5;
  const PUR_ST_BADGE = {
    draft: 'badge-draft', partial: 'badge-multi', received: 'badge-approved', cancelled: 'badge-st-undef',
  };
  const purStatusBadge = (st) => `<span class="badge ${PUR_ST_BADGE[st] || ''}">${esc(purchaseStatusLabel(st))}</span>`;
  const seqLabel = (p) => 'P-' + pad4(num(p && p.seq));
  const retLabel = (r) => 'RT-' + pad4(num(r && r.seq));

  async function loadProcurement() {
    const [suppliers, purchases, receives, returns] = await Promise.all([
      DB.getAll('suppliers'), DB.getAll('purchases'),
      DB.getAll('receives'), DB.getAll('supreturns'),
    ]);
    return { suppliers, purchases, receives, returns };
  }

  /* =============== الموردون — #suppliers =============== */
  function renderSuppliers(host) {
    host.innerHTML = `
      <div class="page-head"><h2>${ar() ? 'الموردون' : 'Suppliers'}</h2>
        <div class="head-actions">
          <button class="btn btn-primary" id="sup-add">+ ${ar() ? 'مورد جديد' : 'New supplier'}</button>
          <button class="btn btn-ghost" id="sup-exp">${t('exportExcel')}</button>
        </div></div>
      <div class="card filters">
        <input type="text" id="sup-search" placeholder="${ar() ? 'بحث بالاسم أو الهاتف أو الكود…' : 'Search name / phone / code…'}">
        <select id="sup-archived">
          <option value="">${ar() ? 'الحالة: نشط' : 'Active only'}</option>
          <option value="all">${ar() ? 'الكل (مع المؤرشف)' : 'All (incl. archived)'}</option>
          <option value="arch">${ar() ? 'المؤرشف فقط' : 'Archived only'}</option>
        </select>
        <button class="btn btn-ghost" id="sup-clear">${t('reset')}</button>
      </div>
      <div class="card table-wrap" id="sup-table"></div>`;

    let data = null;
    load().catch((e) => console.error('[suppliers]', e));
    async function load() {
      data = await loadProcurement();
      if (!host.querySelector('#sup-search')) return; /* fast navigation race guard */
      draw();
    }
    function statsOf(sup) {
      const purchases = data.purchases.filter((p) => Number(p.supplierId) === sup.id);
      const purchaseIds = new Set(purchases.map((p) => p.id));
      const receives = data.receives.filter((r) => purchaseIds.has(r.purchaseId));
      const returns = data.returns.filter((r) => Number(r.supplierId) === sup.id && r.status === 'active');
      const purchasedQty = purchases.reduce((s, p) => s + p.lines.reduce((s2, l) => s2 + (l.receivedQty || 0), 0), 0);
      const returnedQty = returns.reduce((s, r) => s + r.lines.reduce((s2, l) => s2 + (l.qty || 0), 0), 0);
      const totals = purchases.filter((p) => p.status !== 'cancelled')
        .reduce((s, p) => ({ final: s.final + num(p.finalTotal), paid: s.paid + num(p.paid) }), { final: 0, paid: 0 });
      return {
        purchases: purchases.length, receives: receives.length, returns: returns.length,
        purchasedQty, returnedQty,
        purchasesTotal: round6(totals.final), paidTotal: round6(totals.paid),
        outstanding: round6(totals.final - totals.paid),
      };
    }
    function draw() {
      const q = host.querySelector('#sup-search').value.trim().toLowerCase();
      const arch = host.querySelector('#sup-archived').value;
      let list = data.suppliers.slice();
      if (arch === '') list = list.filter((s) => !s.archived);
      else if (arch === 'arch') list = list.filter((s) => s.archived);
      if (q) list = list.filter((s) => (s.name || '').toLowerCase().includes(q)
        || (s.phone || '').toLowerCase().includes(q) || (s.code || '').toLowerCase().includes(q)
        || (s.contact || '').toLowerCase().includes(q));
      list.sort((a, b) => (a.code || '').localeCompare(b.code || ''));
      const host2 = host.querySelector('#sup-table');
      host2.innerHTML = `
        <table class="data-table">
          <thead><tr>
            <th>${ar() ? 'الكود' : 'Code'}</th><th>${ar() ? 'اسم المورد' : 'Supplier'}</th>
            <th>${ar() ? 'الهاتف' : 'Phone'}</th><th>${ar() ? 'مسؤول التواصل' : 'Contact'}</th>
            <th class="num">${ar() ? 'فواتير الشراء' : 'Purchases'}</th>
            <th class="num">${ar() ? 'إجمالي المشتريات' : 'Purchases total'}</th>
            <th class="num">${ar() ? 'المرتجعات (بكر)' : 'Returns'}</th>
            <th class="num">${ar() ? 'المتبقي غير المدفوع' : 'Outstanding'}</th>
            <th>${ar() ? 'الحالة' : 'Status'}</th><th>${t('actions')}</th>
          </tr></thead>
          <tbody>${list.length ? list.map((s) => {
            const st = statsOf(s);
            return `<tr>
              <td data-label="${ar() ? 'الكود' : 'Code'}"><button class="voucher-no" data-view="${s.id}">${esc(s.code || '—')}</button></td>
              <td data-label="${ar() ? 'المورد' : 'Supplier'}">${esc(s.name)}</td>
              <td data-label="${ar() ? 'الهاتف' : 'Phone'}" dir="ltr">${esc(s.phone || '—')}</td>
              <td data-label="${ar() ? 'التواصل' : 'Contact'}">${esc(s.contact || '—')}</td>
              <td class="num" data-label="${ar() ? 'الفواتير' : 'Invoices'}">${fmtNum(st.purchases)}</td>
              <td class="num" data-label="${ar() ? 'المشتريات' : 'Total'}">${fmtNum(st.purchasesTotal, 2)}</td>
              <td class="num" data-label="${ar() ? 'المرتجعات' : 'Returns'}">${fmtNum(st.returnedQty)}</td>
              <td class="num" data-label="${ar() ? 'المتبقي' : 'Outstanding'}">${st.outstanding > 0 ? `<strong class="warn-text">${fmtNum(st.outstanding, 2)}</strong>` : fmtNum(st.outstanding, 2)}</td>
              <td data-label="${ar() ? 'الحالة' : 'Status'}">${s.archived ? `<span class="badge badge-st-undef">${ar() ? 'مؤرشف' : 'archived'}</span>` : `<span class="badge badge-st-avail">${ar() ? 'نشط' : 'active'}</span>`}</td>
              <td class="actions-cell">
                <button class="icon-btn" data-view="${s.id}" title="${t('details')}">👁</button>
                <button class="icon-btn" data-edit="${s.id}" title="${t('edit')}">✎</button>
                <button class="icon-btn" data-arch="${s.id}" title="${s.archived ? (ar() ? 'إلغاء الأرشفة' : 'Unarchive') : (ar() ? 'أرشفة' : 'Archive')}">${s.archived ? '📂' : '📦'}</button>
                <button class="icon-btn danger" data-del="${s.id}" title="${t('del')}">🗑</button>
              </td></tr>`;
          }).join('') : `<tr><td colspan="10" class="empty">${ar() ? 'لا يوجد موردون — أضف أول مورد' : 'No suppliers yet'}</td></tr>`}</tbody>
          <tfoot><tr>
            <td colspan="4">${t('total')} (${fmtNum(list.length)} ${ar() ? 'مورد' : 'suppliers'})</td>
            <td class="num">${fmtNum(list.reduce((s, x) => s + statsOf(x).purchases, 0))}</td>
            <td class="num">${fmtNum(round6(list.reduce((s, x) => s + statsOf(x).purchasesTotal, 0)), 2)}</td>
            <td class="num">${fmtNum(list.reduce((s, x) => s + statsOf(x).returnedQty, 0))}</td>
            <td class="num">${fmtNum(round6(list.reduce((s, x) => s + statsOf(x).outstanding, 0)), 2)}</td>
            <td colspan="2"></td>
          </tr></tfoot>
        </table>`;
      host2.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => openSupplierDetails(Number(b.dataset.view))));
      host2.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => editSupplier(Number(b.dataset.edit))));
      host2.querySelectorAll('[data-arch]').forEach((b) => b.addEventListener('click', async () => {
        const sup = data.suppliers.find((s) => s.id === Number(b.dataset.arch));
        if (!sup) return;
        if (!sup.archived) {
          const ok = await confirmDialog({
            title: ar() ? 'أرشفة مورد' : 'Archive supplier',
            message: ar() ? `أرشفة «${sup.name}»؟ لن يظهر في قوائم الاختيار الافتراضية وتبقى كل فواتيره وسجلاته كما هي.` : `Archive "${sup.name}"? History is kept.`,
          });
          if (!ok) return;
        }
        await PUR.setSupplierArchived(sup.id, !sup.archived);
        toast(ar() ? 'تم الحفظ' : 'saved', 'ok');
        load();
      }));
      host2.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
        const sup = data.suppliers.find((s) => s.id === Number(b.dataset.del));
        if (!sup) return;
        const ok = await confirmDialog({
          title: ar() ? 'حذف مورد' : 'Delete supplier',
          message: ar() ? `حذف «${sup.name}» نهائيًا؟ الحذف متاح فقط للمورد بلا أي سجل مشتريات أو مرتجعات — الموردون بسجل تاريخي يُؤرشفون بدل الحذف.` : `Delete "${sup.name}"? Only suppliers with no history can be deleted.`,
          danger: true,
        });
        if (!ok) return;
        try {
          await PUR.deleteSupplier(sup.id);
          toast(ar() ? 'تم الحذف' : 'deleted', 'ok');
          load();
        } catch (e) {
          toast((e && e.errors ? e.errors.join(' — ') : String(e.message || e)), 'err');
        }
      }));
    }
    function editSupplier(id) {
      const isNew = !id;
      const cur = isNew ? null : data.suppliers.find((s) => s.id === id);
      const node = el(`<div class="sup-form">
        <div class="form-grid">
          <label class="field"><span>${ar() ? 'اسم المورد' : 'Supplier name'} *</span>
            <input id="s-name" type="text" value="${esc(cur ? cur.name : '')}" placeholder="${ar() ? 'مثال: مصنع الورق الوطني' : 'supplier name'}"></label>
          <label class="field"><span>${ar() ? 'رقم الهاتف' : 'Phone'}</span>
            <input id="s-phone" type="tel" dir="ltr" value="${esc(cur ? (cur.phone || '') : '')}" placeholder="01xxxxxxxxx"></label>
          <label class="field"><span>${ar() ? 'مسؤول التواصل' : 'Contact person'}</span>
            <input id="s-contact" type="text" value="${esc(cur ? (cur.contact || '') : '')}"></label>
          <label class="field"><span>${ar() ? 'العنوان' : 'Address'}</span>
            <input id="s-address" type="text" value="${esc(cur ? (cur.address || '') : '')}"></label>
          <label class="field field-wide"><span>${t('notes')}</span>
            <input id="s-notes" type="text" value="${esc(cur ? (cur.notes || '') : '')}"></label>
          ${isNew ? `<label class="field field-wide"><span class="muted small">${ar() ? 'كود المورد ورقمه يُنشآن تلقائيًا عند الحفظ (SUP-####)' : 'Supplier code is assigned automatically (SUP-####)'}</span></label>` : ''}
        </div>
        <div class="form-error" id="s-err"></div>
        <div class="confirm-actions">
          <button class="btn btn-primary" id="s-save">${t('save')}</button>
          <button class="btn btn-ghost" id="s-cancel">${t('cancel')}</button>
        </div></div>`);
      openModal(node, { title: isNew ? (ar() ? 'مورد جديد' : 'New supplier') : (ar() ? `تعديل مورد ${cur.code}` : 'Edit supplier') });
      node.querySelector('#s-cancel').addEventListener('click', closeModal);
      node.querySelector('#s-save').addEventListener('click', async () => {
        const errBox = node.querySelector('#s-err');
        errBox.textContent = '';
        const payload = {
          name: node.querySelector('#s-name').value,
          phone: node.querySelector('#s-phone').value,
          contact: node.querySelector('#s-contact').value,
          address: node.querySelector('#s-address').value,
          notes: node.querySelector('#s-notes').value,
        };
        try {
          if (isNew) {
            const sup = await PUR.createSupplier(payload);
            toast(ar() ? `تم إضافة المورد ${sup.code} — ${sup.name}` : `Supplier ${sup.code} added`, 'ok');
          } else {
            await PUR.updateSupplier(id, payload);
            toast(ar() ? 'تم حفظ تعديلات المورد' : 'supplier updated', 'ok');
          }
          closeModal();
          load();
        } catch (e) {
          errBox.innerHTML = (e && e.errors ? e.errors : [String(e.message || e)]).map((x) =>
            `• ${esc(typeof x === 'string' ? x : x.msg)}`).join('<br>');
        }
      });
    }

    /* تفاصيل المورد: كل فواتيره + مرتجعاته + إجمالياته + سجل حركة مختصر */
    function openSupplierDetails(id) {
      const sup = data.suppliers.find((s) => s.id === id);
      if (!sup) return;
      const st = statsOf(sup);
      const purchases = data.purchases.filter((p) => Number(p.supplierId) === id)
        .sort((a, b) => (b.invoiceDate || '').localeCompare(a.invoiceDate || ''));
      const returns = data.returns.filter((r) => Number(r.supplierId) === id)
        .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      const node = el(`<div class="sup-details">
        <div class="details-head">
          <div><h4>${esc(sup.code)} — ${esc(sup.name)}</h4>
            <p class="muted small">${ar() ? 'الهاتف' : 'Phone'}: <span dir="ltr">${esc(sup.phone || '—')}</span>
             — ${ar() ? 'التواصل' : 'Contact'}: ${esc(sup.contact || '—')}
             — ${ar() ? 'العنوان' : 'Address'}: ${esc(sup.address || '—')}
             ${sup.notes ? ' — ' + esc(sup.notes) : ''}</p></div>
          <div class="details-balance">
            <div class="stat-mini"><span>${ar() ? 'فواتير الشراء' : 'Purchase invoices'}</span><strong>${fmtNum(st.purchases)}</strong></div>
            <div class="stat-mini"><span>${ar() ? 'إجمالي المشتريات' : 'Purchases total'}</span><strong>${fmtNum(st.purchasesTotal, 2)}</strong></div>
            <div class="stat-mini"><span>${ar() ? 'المدفوع' : 'Paid'}</span><strong>${fmtNum(st.paidTotal, 2)}</strong></div>
            <div class="stat-mini"><span>${ar() ? 'المتبقي' : 'Outstanding'}</span><strong>${fmtNum(st.outstanding, 2)}</strong></div>
            <div class="stat-mini"><span>${ar() ? 'بكر مستلمة' : 'Reels received'}</span><strong>${fmtNum(st.purchasedQty)}</strong></div>
            <div class="stat-mini"><span>${ar() ? 'بكر مرتجعة' : 'Reels returned'}</span><strong>${fmtNum(st.returnedQty)}</strong></div>
          </div></div>
        <h4>${ar() ? 'فواتير الشراء' : 'Purchase invoices'}</h4>
        <div class="table-wrap"><table class="data-table">
          <thead><tr><th>${ar() ? 'الرقم' : 'No.'}</th><th>${ar() ? 'رقم فاتورة المورد' : 'Supplier inv.'}</th>
          <th>${t('date')}</th><th class="num">${ar() ? 'الإجمالي' : 'Total'}</th>
          <th class="num">${ar() ? 'المدفوع' : 'Paid'}</th><th class="num">${ar() ? 'المتبقي' : 'Remaining'}</th>
          <th>${ar() ? 'الحالة' : 'Status'}</th></tr></thead>
          <tbody>${purchases.length ? purchases.map((p) => `<tr>
            <td data-label="${ar() ? 'الرقم' : 'No.'}"><strong dir="ltr">${esc(seqLabel(p))}</strong></td>
            <td data-label="${ar() ? 'فاتورة المورد' : 'Supplier inv.'}" dir="ltr">${esc(p.supplierInvoiceNo || '—')}</td>
            <td data-label="${t('date')}">${fmtDate(p.invoiceDate)}</td>
            <td class="num" data-label="${ar() ? 'الإجمالي' : 'Total'}">${fmtNum(p.finalTotal, 2)}</td>
            <td class="num" data-label="${ar() ? 'المدفوع' : 'Paid'}">${fmtNum(p.paid, 2)}</td>
            <td class="num" data-label="${ar() ? 'المتبقي' : 'Rem.'}">${fmtNum(p.remaining, 2)}</td>
            <td data-label="${ar() ? 'الحالة' : 'Status'}">${purStatusBadge(p.status)}</td>
          </tr>`).join('') : `<tr><td colspan="7" class="empty">${ar() ? 'لا فواتير' : 'No invoices'}</td></tr>`}</tbody>
        </table></div>
        <h4>${ar() ? 'المرتجعات' : 'Returns'}</h4>
        <div class="table-wrap"><table class="data-table">
          <thead><tr><th>${ar() ? 'الرقم' : 'No.'}</th><th>${t('date')}</th>
          <th class="num">${ar() ? 'الكمية المرتجعة' : 'Returned qty'}</th><th>${ar() ? 'السبب' : 'Reason'}</th>
          <th>${ar() ? 'الحالة' : 'Status'}</th></tr></thead>
          <tbody>${returns.length ? returns.map((r) => `<tr>
            <td><strong dir="ltr">${esc(retLabel(r))}</strong></td>
            <td>${fmtDate(r.date)}</td>
            <td class="num">${fmtNum(r.lines.reduce((s, l) => s + (l.qty || 0), 0))}</td>
            <td>${esc(r.reason || '—')}</td>
            <td>${r.status === 'active' ? `<span class="badge badge-st-avail">${ar() ? 'ساري' : 'active'}</span>` : `<span class="badge badge-st-undef">${ar() ? 'ملغي' : 'cancelled'}</span>`}</td>
          </tr>`).join('') : `<tr><td colspan="5" class="empty">${ar() ? 'لا مرتجعات' : 'No returns'}</td></tr>`}</tbody>
        </table></div>
        <div class="confirm-actions" style="margin-top:.8rem">
          <button class="btn btn-ghost" id="sd-close">${t('close')}</button>
        </div></div>`);
      node.querySelector('#sd-close').addEventListener('click', closeModal);
      openModal(node, { title: ar() ? 'تفاصيل المورد وسجل معاملاته' : 'Supplier details & history', wide: true });
    }

    host.querySelector('#sup-add').addEventListener('click', () => editSupplier(null));
    host.querySelector('#sup-search').addEventListener('input', draw);
    host.querySelector('#sup-archived').addEventListener('change', draw);
    host.querySelector('#sup-clear').addEventListener('click', () => {
      host.querySelector('#sup-search').value = '';
      host.querySelector('#sup-archived').value = '';
      draw();
    });
    host.querySelector('#sup-exp').addEventListener('click', () => {
      if (!data) return;
      const rows = data.suppliers.slice().sort((a, b) => (a.code || '').localeCompare(b.code || '')).map((s) => {
        const st = statsOf(s);
        return [s.code, s.name, s.phone || '', s.contact || '', s.address || '', st.purchases,
          st.purchasesTotal, st.paidTotal, st.outstanding, st.returnedQty,
          s.archived ? (ar() ? 'مؤرشف' : 'archived') : (ar() ? 'نشط' : 'active')];
      });
      global.EXCEL.exportReportAOA(ar() ? 'الموردون' : 'Suppliers',
        [ar() ? 'الكود' : 'Code', ar() ? 'الاسم' : 'Name', ar() ? 'الهاتف' : 'Phone', ar() ? 'التواصل' : 'Contact',
         ar() ? 'العنوان' : 'Address', ar() ? 'عدد الفواتير' : 'Invoices', ar() ? 'إجمالي المشتريات' : 'Purchases total',
         ar() ? 'المدفوع' : 'Paid', ar() ? 'المتبقي' : 'Outstanding', ar() ? 'المرتجعات' : 'Returned qty', ar() ? 'الحالة' : 'Status'],
        rows, null, 'الموردون');
      toast(ar() ? 'تم تنزيل ملف الإكسل' : 'Excel downloaded', 'ok');
    });
  }

  /* =============== المشتريات — قائمة #purchases =============== */
  function renderPurchases(host) {
    host.innerHTML = `
      <div class="page-head"><h2>${ar() ? 'المشتريات' : 'Purchases'}</h2>
        <div class="head-actions">
          <button class="btn btn-primary" id="pu-new">+ ${ar() ? 'فاتورة شراء جديدة' : 'New purchase invoice'}</button>
          <button class="btn btn-ghost" id="pu-new-ret">↩ ${ar() ? 'مرتجع مورد' : 'Supplier return'}</button>
          <button class="btn btn-ghost" id="pu-exp">${t('exportExcel')}</button>
        </div></div>
      <div class="card notice-card resv-notice">
        <strong>${ar() ? 'قاعدة تكامل المخزون' : 'Stock integration rule'}</strong>
        <div class="small muted">${ar()
          ? 'فواتير الشراء لا تضيف للمخزون من تلقاء نفسها. الاستلام يجري حصرًا عبر «تسجيل البكر» القائم (حركة إنتاج واحدة لكل بكرة) ثم تُربط البكر بالفاتورة — أو بربط بكر متاحة مسجلة مسبقًا بلا أي حركة إضافية.'
          : 'Purchase invoices never add stock by themselves. Receiving goes through the existing reel-registration engine (one movement per reel), then reels are linked to the invoice — or already-registered available reels are linked with no extra movement.'}</div>
      </div>
      <div class="card filters">
        <input type="text" id="pu-q" placeholder="${ar() ? 'بحث برقم الفاتورة أو رقم فاتورة المورد أو اسم المورد…' : 'Search invoice / supplier inv. / supplier…'}">
        <select id="pu-supplier"><option value="">${ar() ? 'المورد: الكل' : 'Supplier: all'}</option></select>
        <select id="pu-status">
          <option value="">${ar() ? 'الحالة: الكل' : 'Status: all'}</option>
          ${Object.keys(PURCHASE_STATUS).map((k) => `<option value="${k}">${esc(purchaseStatusLabel(k))}</option>`).join('')}
        </select>
        <input type="date" id="pu-from" title="${t('from')}">
        <input type="date" id="pu-to" title="${t('to')}">
        <button class="btn btn-ghost" id="pu-clear">${t('reset')}</button>
      </div>
      <div class="card table-wrap" id="pu-table"></div>`;

    let data = null;
    load().catch((e) => console.error('[purchases]', e));
    async function load() {
      data = await loadProcurement();
      if (!host.querySelector('#pu-q')) return;
      const sel = host.querySelector('#pu-supplier');
      const cur = sel.value;
      sel.innerHTML = `<option value="">${ar() ? 'المورد: الكل' : 'Supplier: all'}</option>`
        + data.suppliers.slice().sort((a, b) => (a.code || '').localeCompare(b.code || ''))
          .map((s) => `<option value="${s.id}">${esc(s.code)} — ${esc(s.name)}</option>`).join('');
      if (cur) sel.value = cur;
      draw();
    }
    function invoiceWeight(p) {
      const actual = p.lines.reduce((s, l) => s + (l.weightActual || 0), 0);
      const est = p.lines.reduce((s, l) => s + (l.weightEstimated || 0), 0);
      return { actual: round6(actual), est: round6(est) };
    }
    function filtered() {
      const q = host.querySelector('#pu-q').value.trim().toLowerCase();
      const sup = host.querySelector('#pu-supplier').value;
      const st = host.querySelector('#pu-status').value;
      const from = host.querySelector('#pu-from').value;
      const to = host.querySelector('#pu-to').value;
      let list = data.purchases.slice();
      if (sup) list = list.filter((p) => String(p.supplierId) === sup);
      if (st) list = list.filter((p) => p.status === st);
      if (from) list = list.filter((p) => p.invoiceDate >= from);
      if (to) list = list.filter((p) => p.invoiceDate <= to);
      if (q) list = list.filter((p) => seqLabel(p).toLowerCase().includes(q)
        || (p.supplierInvoiceNo || '').toLowerCase().includes(q)
        || (p.supplierName || '').toLowerCase().includes(q));
      list.sort((a, b) => (b.invoiceDate || '').localeCompare(a.invoiceDate || '') || (num(b.seq) - num(a.seq)));
      return list;
    }
    function draw() {
      const list = filtered();
      const host2 = host.querySelector('#pu-table');
      const totals = list.reduce((acc, p) => {
        acc.total += p.status === 'cancelled' ? 0 : num(p.finalTotal);
        acc.paid += p.status === 'cancelled' ? 0 : num(p.paid);
        acc.qty += p.lines.reduce((s, l) => s + (l.receivedQty || 0), 0);
        return acc;
      }, { total: 0, paid: 0, qty: 0 });
      host2.innerHTML = `
        <table class="data-table">
          <thead><tr>
            <th>${ar() ? 'الرقم' : 'No.'}</th><th>${ar() ? 'المورد' : 'Supplier'}</th>
            <th>${ar() ? 'فاتورة المورد' : 'Supplier inv.'}</th><th>${t('date')}</th>
            <th class="num">${ar() ? 'الأسطر' : 'Lines'}</th>
            <th class="num">${ar() ? 'مستلم (بكر)' : 'Received'}</th>
            <th class="num">${ar() ? 'الإجمالي' : 'Total'}</th>
            <th class="num">${ar() ? 'المدفوع' : 'Paid'}</th>
            <th class="num">${ar() ? 'المتبقي' : 'Remaining'}</th>
            <th>${ar() ? 'الحالة' : 'Status'}</th><th>${t('actions')}</th>
          </tr></thead>
          <tbody>${list.length ? list.map((p) => {
            const received = p.lines.reduce((s, l) => s + (l.receivedQty || 0), 0);
            return `<tr>
              <td data-label="${ar() ? 'الرقم' : 'No.'}"><button class="voucher-no" data-view="${p.id}">${esc(seqLabel(p))}</button></td>
              <td data-label="${ar() ? 'المورد' : 'Supplier'}">${esc(p.supplierName)}</td>
              <td data-label="${ar() ? 'فاتورة المورد' : 'Supplier inv.'}" dir="ltr">${esc(p.supplierInvoiceNo || '—')}</td>
              <td data-label="${t('date')}">${fmtDate(p.invoiceDate)}</td>
              <td class="num" data-label="${ar() ? 'الأسطر' : 'Lines'}">${fmtNum(p.lines.length)}</td>
              <td class="num" data-label="${ar() ? 'مستلم' : 'Received'}">${fmtNum(received)}</td>
              <td class="num" data-label="${ar() ? 'الإجمالي' : 'Total'}">${fmtNum(p.finalTotal, 2)}</td>
              <td class="num" data-label="${ar() ? 'المدفوع' : 'Paid'}">${fmtNum(p.paid, 2)}</td>
              <td class="num" data-label="${ar() ? 'المتبقي' : 'Rem.'}">${fmtNum(p.remaining, 2)}</td>
              <td data-label="${ar() ? 'الحالة' : 'Status'}">${purStatusBadge(p.status)}</td>
              <td class="actions-cell">
                <button class="icon-btn" data-view="${p.id}" title="${ar() ? 'عرض واستلام' : 'View & receive'}">👁</button>
                ${p.status === 'draft' ? `<button class="icon-btn" data-edit="${p.id}" title="${t('edit')}">✎</button>` : ''}
                ${p.status !== 'cancelled' ? `<button class="icon-btn danger" data-cancel="${p.id}" title="${ar() ? 'إلغاء الفاتورة' : 'Cancel invoice'}">🚫</button>` : ''}
                ${p.status === 'draft' ? `<button class="icon-btn danger" data-del="${p.id}" title="${t('del')}">🗑</button>` : ''}
              </td></tr>`;
          }).join('') : `<tr><td colspan="11" class="empty">${ar() ? 'لا توجد فواتير شراء — أنشئ أول فاتورة' : 'No purchase invoices yet'}</td></tr>`}</tbody>
          <tfoot><tr>
            <td colspan="5">${t('total')} (${fmtNum(list.length)} ${ar() ? 'فاتورة' : 'invoices'})</td>
            <td class="num">${fmtNum(totals.qty)}</td>
            <td class="num">${fmtNum(round6(totals.total), 2)}</td>
            <td class="num">${fmtNum(round6(totals.paid), 2)}</td>
            <td class="num">${fmtNum(round6(totals.total - totals.paid), 2)}</td>
            <td colspan="2"></td>
          </tr></tfoot>
        </table>`;
      host2.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => {
        App.pendingPurchaseId = b.dataset.view; App.navigate('purchase-details');
      }));
      host2.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
        App.pendingPurchaseEdit = b.dataset.edit; App.navigate('purchase-form');
      }));
      host2.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', async () => {
        const p = data.purchases.find((x) => x.id === b.dataset.cancel);
        if (!p) return;
        const linked = data.receives.filter((r) => r.purchaseId === p.id).length;
        const ok = await confirmDialog({
          title: ar() ? 'إلغاء فاتورة شراء' : 'Cancel purchase invoice',
          message: ar()
            ? `إلغاء الفاتورة ${seqLabel(p)}؟${linked ? `\n⚠ عليها ${fmtNum(linked)} عملية استلام — البكر المستلمة وحركات إنتاجها تبقى كما هي (أصول مخزنية فعلية) ولا تُحذف.` : ''}`
            : `Cancel invoice ${seqLabel(p)}?`,
          danger: true, yesLabel: ar() ? 'إلغاء الفاتورة' : 'Cancel invoice',
        });
        if (!ok) return;
        try {
          await PUR.cancelPurchase(p.id, { force: linked > 0 });
          toast(ar() ? 'تم إلغاء الفاتورة — البكر المستلمة وحركاتها كما هي' : 'invoice cancelled', 'ok');
          load();
        } catch (e) {
          toast((e && e.errors ? e.errors.join(' — ') : String(e.message || e)), 'err');
        }
      }));
      host2.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
        const p = data.purchases.find((x) => x.id === b.dataset.del);
        if (!p) return;
        const ok = await confirmDialog({
          title: ar() ? 'حذف مسودة فاتورة' : 'Delete draft invoice',
          message: ar() ? `حذف المسودة ${seqLabel(p)} نهائيًا؟ المسودات بلا استلامات فقط يمكن حذفها.` : `Delete draft ${seqLabel(p)}?`,
          danger: true,
        });
        if (!ok) return;
        try {
          await PUR.deletePurchase(p.id);
          toast(ar() ? 'تم حذف المسودة' : 'draft deleted', 'ok');
          load();
        } catch (e) {
          toast((e && e.errors ? e.errors.join(' — ') : String(e.message || e)), 'err');
        }
      }));
    }
    host.querySelector('#pu-new').addEventListener('click', () => { App.pendingPurchaseEdit = null; App.navigate('purchase-form'); });
    host.querySelector('#pu-new-ret').addEventListener('click', () => openReturnModal(null, () => load()));
    ['#pu-q', '#pu-from', '#pu-to'].forEach((s) => host.querySelector(s).addEventListener('input', draw));
    ['#pu-supplier', '#pu-status'].forEach((s) => host.querySelector(s).addEventListener('change', draw));
    host.querySelector('#pu-clear').addEventListener('click', () => {
      ['#pu-q', '#pu-from', '#pu-to'].forEach((s) => { host.querySelector(s).value = ''; });
      host.querySelector('#pu-supplier').value = '';
      host.querySelector('#pu-status').value = '';
      draw();
    });
    host.querySelector('#pu-exp').addEventListener('click', () => {
      if (!data) return;
      const rows = filtered().map((p) => {
        const received = p.lines.reduce((s, l) => s + (l.receivedQty || 0), 0);
        return [seqLabel(p), p.supplierName, p.supplierInvoiceNo || '', p.invoiceDate,
          p.lines.reduce((s, l) => s + l.qty, 0), received,
          round6(p.lines.reduce((s, l) => s + (l.weightActual || 0), 0)),
          round6(p.lines.reduce((s, l) => s + (l.weightEstimated || 0), 0)),
          p.subtotal, p.extraCosts || 0, p.discount || 0, p.finalTotal, p.paid, p.remaining,
          purchaseStatusLabel(p.status)];
      });
      global.EXCEL.exportReportAOA(ar() ? 'فواتير الشراء' : 'Purchase invoices',
        [ar() ? 'الرقم' : 'No.', ar() ? 'المورد' : 'Supplier', ar() ? 'فاتورة المورد' : 'Supplier inv.', t('date'),
         ar() ? 'الكمية المطلوبة' : 'Ordered qty', ar() ? 'المستلم' : 'Received',
         `${ar() ? 'الوزن الفعلي' : 'Actual weight'} (${t('kg')})`, `${ar() ? 'الوزن التقديري' : 'Estimated weight'} (${t('kg')})`,
         ar() ? 'المجموع الفرعي' : 'Subtotal', ar() ? 'مصاريف' : 'Extra costs', ar() ? 'خصم' : 'Discount',
         ar() ? 'الإجمالي' : 'Total', ar() ? 'المدفوع' : 'Paid', ar() ? 'المتبقي' : 'Remaining', ar() ? 'الحالة' : 'Status'],
        rows, null, 'فواتير_الشراء');
      toast(ar() ? 'تم تنزيل ملف الإكسل' : 'Excel downloaded', 'ok');
    });
  }

  /* =============== نموذج فاتورة شراء — #purchase-form =============== */
  function renderPurchaseForm(host) {
    const editId = App.pendingPurchaseEdit || null;
    App.pendingPurchaseEdit = null;
    loadProcurement().then(({ suppliers, purchases }) => {
      const existing = editId ? purchases.find((p) => p.id === editId) : null;
      if (editId && !existing) { host.innerHTML = '<div class="card error-card">الفاتورة غير موجودة.</div>'; return; }
      if (existing && existing.status !== 'draft') {
        host.innerHTML = `<div class="card error-card">${ar() ? 'لا يمكن تعديل فاتورة غير مسودة — الفواتير التي بدأ استلامها أو الملغاة محفوظة كما هي.' : 'Only draft invoices are editable.'}</div>`;
        return;
      }
      const activeSuppliers = suppliers.filter((s) => !s.archived);
      const families = CANON.concat(App.state.products.map((p) => App.productFamily(p.quality))
        .filter((f) => !CANON.includes(f)));
      const fams = [...new Set(families)];

      const lines = existing ? existing.lines.map((l) => Object.assign({}, l)) : [];
      const lineRow = (l) => `
        <div class="pur-line" data-id="${esc(l.id)}">
          <label class="field"><span>${t('quality')} *</span>
            <select class="pl-quality">${fams.map((f) => `<option value="${esc(f)}" ${l.quality === f ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select></label>
          <label class="field"><span>${t('gsm')} *</span>
            <input class="pl-gsm" type="number" min="1" step="any" placeholder="125" value="${esc(l.gsm == null ? '' : l.gsm)}"></label>
          <label class="field"><span>${t('size')} *</span>
            <input class="pl-size" type="number" min="1" step="any" placeholder="100" value="${esc(l.size == null ? '' : l.size)}"></label>
          <label class="field"><span>${ar() ? 'الكمية (بكر)' : 'Qty (reels)'} *</span>
            <input class="pl-qty" type="number" min="1" step="1" placeholder="10" value="${esc(l.qty || '')}"></label>
          <label class="field"><span>${ar() ? 'أساس السعر' : 'Price basis'}</span>
            <select class="pl-basis"><option value="reel" ${l.priceBasis !== 'kg' ? 'selected' : ''}>${ar() ? 'لكل بكرة' : 'per reel'}</option><option value="kg" ${l.priceBasis === 'kg' ? 'selected' : ''}>${ar() ? 'لكل كجم' : 'per kg'}</option></select></label>
          <label class="field"><span>${ar() ? 'سعر الوحدة' : 'Unit price'} *</span>
            <input class="pl-price" type="number" min="0" step="0.0001" placeholder="0" value="${esc(l.unitPrice == null ? '' : l.unitPrice)}"></label>
          <div class="field"><span>${ar() ? 'إجمالي السطر' : 'Line total'}</span>
            <div class="pl-total muted small">—</div></div>
          <button type="button" class="btn btn-ghost pl-remove" title="${ar() ? 'حذف السطر' : 'Remove'}">✕</button>
        </div>`;
      const readLine = (row) => ({
        id: row.dataset.id || undefined,
        quality: row.querySelector('.pl-quality').value,
        gsm: row.querySelector('.pl-gsm').value === '' ? null : Number(row.querySelector('.pl-gsm').value),
        size: row.querySelector('.pl-size').value === '' ? null : Number(row.querySelector('.pl-size').value),
        qty: Number(row.querySelector('.pl-qty').value) || 0,
        priceBasis: row.querySelector('.pl-basis').value,
        unitPrice: Number(row.querySelector('.pl-price').value) || 0,
      });

      host.innerHTML = `
        <div class="page-head"><h2>${existing
          ? (ar() ? `تعديل مسودة فاتورة ${esc(seqLabel(existing))}` : 'Edit draft invoice')
          : (ar() ? 'فاتورة شراء جديدة' : 'New purchase invoice')}</h2>
          <div class="head-actions"><button class="btn btn-ghost" id="pf-back">← ${ar() ? 'المشتريات' : 'Purchases'}</button></div></div>
        <div class="card form-card">
          <p class="muted small form-sub">${ar()
            ? 'الفاتورة مسودة لا تؤثر على المخزون. عند وصول البكر استلمها من شاشة الفاتورة عبر «تسجيل البكر» (حركة إنتاج تلقائية واحدة لكل بكرة بالآلية القائمة) أو اربط بكرًا متاحة مسجلة مسبقًا. رقم فاتورة المورد يُمنع تكراره لنفس المورد إلا كاستثناء معتمد بالمراجعة.'
            : 'Draft invoices never touch stock. Receive reels through the existing registration engine, or link already-registered available reels. Duplicate supplier invoice numbers per supplier are blocked unless confirmed as a reviewed exception.'}</p>
          <form id="pf-form" novalidate>
            <div class="form-grid">
              <label class="field"><span>${ar() ? 'المورد' : 'Supplier'} *</span>
                <select id="pf-supplier" required>
                  <option value="">— ${ar() ? 'اختر المورد' : 'select supplier'} —</option>
                  ${activeSuppliers.map((s) => `<option value="${s.id}" ${existing && Number(existing.supplierId) === s.id ? 'selected' : ''}>${esc(s.code)} — ${esc(s.name)}</option>`).join('')}
                </select>
                <span class="muted small">${activeSuppliers.length ? '' : (ar() ? 'لا يوجد موردون — أضف موردًا أولًا من قسم «الموردون»' : 'No suppliers yet — add one first')}</span></label>
              <label class="field"><span>${ar() ? 'رقم فاتورة المورد' : 'Supplier invoice no.'}</span>
                <input id="pf-invoiceno" type="text" dir="ltr" autocomplete="off" value="${esc(existing ? (existing.supplierInvoiceNo || '') : '')}"></label>
              <label class="field"><span>${t('date')} *</span>
                <input id="pf-date" type="date" required value="${esc(existing ? existing.invoiceDate : todayISO())}"></label>
              <label class="field"><span>${ar() ? 'مصاريف إضافية (شحن/نقل…)' : 'Additional costs'}</span>
                <input id="pf-extra" type="number" min="0" step="0.01" value="${esc(existing ? (existing.extraCosts || '') : '')}"></label>
              <label class="field"><span>${ar() ? 'خصم' : 'Discount'}</span>
                <input id="pf-discount" type="number" min="0" step="0.01" value="${esc(existing ? (existing.discount || '') : '')}"></label>
              <label class="field"><span>${ar() ? 'المدفوع (اختياري)' : 'Paid amount (optional)'}</span>
                <input id="pf-paid" type="number" min="0" step="0.01" value="${esc(existing ? (existing.paid || '') : '')}"></label>
              <label class="field field-wide"><span>${t('notes')}</span>
                <input id="pf-notes" type="text" value="${esc(existing ? (existing.notes || '') : '')}"></label>
            </div>
            <section class="field field-wide">
              <div class="card-head-row"><strong>${ar() ? 'أسطر الشراء (منتجات ومقاسات متعددة في فاتورة واحدة)' : 'Purchase lines'}</strong>
                <button type="button" class="btn btn-ghost" id="pf-add-line">+ ${ar() ? 'إضافة سطر' : 'Add line'}</button></div>
              <div id="pf-lines">${lines.map(lineRow).join('')}</div>
            </section>
            <div class="form-hint" id="pf-totals"></div>
            <div class="form-error" id="pf-error" role="alert"></div>
            <div class="form-actions">
              <button type="submit" class="btn btn-primary">${t('save')} ${ar() ? '(مسودة — بلا أثر على المخزون)' : '(draft — no stock effect)'}</button>
              <button type="button" class="btn btn-ghost" id="pf-cancel">${t('cancel')}</button>
            </div>
          </form>
        </div>`;

      const linesHost = host.querySelector('#pf-lines');
      const addLine = (l) => {
        const wrap = el(lineRow(l || { quality: fams[0] || '', gsm: '', size: '', qty: '', unitPrice: '', priceBasis: 'reel', id: uuid() }));
        linesHost.appendChild(wrap);
        const refresh = () => {
          const l2 = readLine(wrap);
          const est = l2.priceBasis === 'kg'
            ? round6(l2.unitPrice * (l2.size && l2.qty ? l2.qty * l2.size * wfSetting() : 0))
            : round6(l2.unitPrice * l2.qty);
          wrap.querySelector('.pl-total').innerHTML = `<strong>${fmtNum(est, 2)}</strong>`;
          updateTotals();
        };
        wrap.querySelectorAll('input, select').forEach((i) => i.addEventListener('input', refresh));
        wrap.querySelector('.pl-remove').addEventListener('click', () => { wrap.remove(); updateTotals(); });
        refresh();
      };
      host.querySelector('#pf-add-line').addEventListener('click', () => addLine(null));
      if (!lines.length) addLine(null);

      function readForm() {
        return {
          supplierId: host.querySelector('#pf-supplier').value,
          supplierInvoiceNo: host.querySelector('#pf-invoiceno').value.trim(),
          invoiceDate: host.querySelector('#pf-date').value,
          extraCosts: Number(host.querySelector('#pf-extra').value) || 0,
          discount: Number(host.querySelector('#pf-discount').value) || 0,
          paid: Number(host.querySelector('#pf-paid').value) || 0,
          notes: host.querySelector('#pf-notes').value.trim(),
          lines: [...linesHost.querySelectorAll('.pur-line')].map(readLine).filter((l) => l.quality || l.qty),
        };
      }
      function updateTotals() {
        const f = readForm();
        const p = {
          lines: f.lines.map((l) => PUR.normalizeLine ? l : l),
        };
        /* live mirror of recomputePurchaseTotals without touching the record */
        let subtotal = 0;
        for (const l of f.lines) {
          const est = l.priceBasis === 'kg'
            ? round6(l.unitPrice * (l.size && l.qty ? l.qty * l.size * wfSetting() : 0))
            : round6(l.unitPrice * l.qty);
          subtotal += est;
        }
        const extra = f.extraCosts || 0, disc = f.discount || 0;
        const total = round6(subtotal + extra - disc);
        host.querySelector('#pf-totals').innerHTML = `
          ${ar() ? 'المجموع الفرعي' : 'Subtotal'}: <strong>${fmtNum(subtotal, 2)}</strong>
          &nbsp;•&nbsp; ${ar() ? 'الإجمالي النهائي' : 'Final total'}: <strong>${fmtNum(total, 2)}</strong>
          &nbsp;•&nbsp; ${ar() ? 'المتبقي بعد المدفوع' : 'Remaining after paid'}: <strong>${fmtNum(round6(total - (f.paid || 0)), 2)}</strong>`;
      }
      host.querySelectorAll('#pf-extra, #pf-discount, #pf-paid').forEach((i) => i.addEventListener('input', updateTotals));
      updateTotals();

      host.querySelector('#pf-back').addEventListener('click', () => App.navigate('purchases'));
      host.querySelector('#pf-cancel').addEventListener('click', () => App.navigate('purchases'));

      host.querySelector('#pf-form').addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const errBox = host.querySelector('#pf-error');
        errBox.textContent = '';
        const f = readForm();
        const problems = [];
        if (!f.supplierId) problems.push(ar() ? 'اختر المورد' : 'Select a supplier');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(f.invoiceDate)) problems.push(ar() ? 'التاريخ مطلوب بصيغة صحيحة' : 'Valid date required');
        if (!f.lines.length) problems.push(ar() ? 'أضف سطر شراء واحدًا على الأقل' : 'Add at least one line');
        const comboSeen = new Set();
        for (const l of f.lines) {
          if (!l.quality || !(l.gsm > 0) || !(l.size > 0) || !(l.qty > 0)) {
            problems.push(ar() ? 'أكمل كل سطر: الصنف والجرام والمقاس والكمية أكبر من صفر' : 'Complete every line');
          }
          const k = CALC.comboKey(l.quality, l.gsm, l.size);
          if (comboSeen.has(k)) problems.push(ar() ? `نفس المواصفات (الصنف/الجرام/المقاس ${l.size}) مكررة — اجمع الكمية في سطر واحد` : 'Duplicate line — combine quantities');
          comboSeen.add(k);
        }
        if (problems.length) { errBox.innerHTML = problems.map((x) => `• ${esc(x)}`).join('<br>'); return; }

        const saveWith = async (allowException) => {
          const payload = Object.assign({}, f, { allowException });
          if (existing) await PUR.updatePurchase(existing.id, payload);
          else await PUR.createPurchase(payload);
        };
        try {
          await saveWith(false);
          toast(ar() ? 'تم حفظ مسودة الفاتورة — بلا أثر على المخزون' : 'Draft invoice saved', 'ok');
          await App.refresh();
          App.navigate('purchases');
        } catch (e) {
          const errs = (e && e.errors) || [String(e.message || e)];
          const dupInvoice = errs.find((x) => typeof x === 'object' && x.field === 'invoiceNo');
          if (dupInvoice) {
            const ok = await confirmDialog({
              title: ar() ? 'مراجعة استثناء — رقم فاتورة مورد مكرر' : 'Review exception — duplicate supplier invoice no.',
              message: ar()
                ? `${dupInvoice.msg}\n\nإذا راجعت المستند الورقي وتأكدت أن هذا استثناء مشروع (مثال: المورد يعيد استخدام رقمه)، يمكنك الحفظ كاستثناء معتمد — سيُسجل في سجل التدقيق بعلامة «استثناء معتمد بمراجعة».`
                : `${dupInvoice.msg}\n\nSave as a reviewed exception? It will be flagged in the audit log.`,
              danger: true, yesLabel: ar() ? 'حفظ كاستثناء معتمد' : 'Save as reviewed exception',
            });
            if (ok) {
              try {
                await saveWith(true);
                toast(ar() ? 'تم حفظ الفاتورة كاستثناء معتمد بمراجعة (مسجل في سجل التدقيق)' : 'Saved as reviewed exception (audited)', 'ok', 5000);
                await App.refresh();
                App.navigate('purchases');
                return;
              } catch (e2) {
                errBox.innerHTML = ((e2 && e2.errors) || [String(e2.message || e2)]).map((x) => `• ${esc(typeof x === 'string' ? x : x.msg)}`).join('<br>');
                return;
              }
            }
          }
          errBox.innerHTML = errs.map((x) => `• ${esc(typeof x === 'string' ? x : x.msg)}`).join('<br>');
        }
      });
    });
  }

  /* =============== تفاصيل الفاتورة + الاستلام — #purchase-details =============== */
  function renderPurchaseDetails(host) {
    const id = App.pendingPurchaseId;
    App.pendingPurchaseId = null;
    let data = null;
    load().catch((e) => console.error('[purchase-details]', e));
    async function load() {
      data = await loadProcurement();
      const p = data.purchases.find((x) => x.id === id);
      if (!p) {
        host.innerHTML = `<div class="card error-card">${ar() ? 'الفاتورة غير موجودة — ارجع إلى قائمة المشتريات.' : 'Invoice not found.'}</div>`;
        return;
      }
      draw(p);
    }
    function draw(p) {
      const receives = data.receives.filter((r) => r.purchaseId === p.id)
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      const returns = data.returns.filter((r) => r.purchaseId === p.id);
      const w = p.lines.reduce((acc, l) => ({ a: acc.a + (l.weightActual || 0), e: acc.e + (l.weightEstimated || 0) }), { a: 0, e: 0 });
      const canReceive = p.status === 'draft' || p.status === 'partial';
      host.innerHTML = `
        <div class="page-head"><h2>${ar() ? 'فاتورة شراء' : 'Purchase invoice'} <span dir="ltr">${esc(seqLabel(p))}</span>
          ${purStatusBadge(p.status)}</h2>
          <div class="head-actions doc-actions">
            <button class="btn btn-primary" id="pd-print">🖨 ${ar() ? 'طباعة الفاتورة (A4)' : 'Print invoice (A4)'}</button>
            ${p.status === 'draft' ? `<button class="btn btn-ghost" id="pd-edit">✎ ${t('edit')}</button>` : ''}
            ${canReceive ? '' : ''}
            <button class="btn btn-ghost" id="pd-back">← ${ar() ? 'المشتريات' : 'Purchases'}</button>
          </div></div>
        <div class="card">
          <div class="details-head">
            <div><h4>${esc(p.supplierName)}</h4>
              <p class="muted small">${ar() ? 'رقم فاتورة المورد' : 'Supplier inv.'}: <strong dir="ltr">${esc(p.supplierInvoiceNo || '—')}</strong>
                — ${t('date')}: <strong>${fmtDate(p.invoiceDate)}</strong>
                ${p.invoiceNoException ? `— <span class="badge badge-conflict">${ar() ? 'رقم مكرر: استثناء معتمد بمراجعة' : 'duplicate no.: reviewed exception'}</span>` : ''}
                ${p.notes ? ' — ' + t('notes') + ': ' + esc(p.notes) : ''}</p></div>
            <div class="details-balance">
              <div class="stat-mini"><span>${ar() ? 'المجموع الفرعي' : 'Subtotal'}</span><strong>${fmtNum(p.subtotal, 2)}</strong></div>
              <div class="stat-mini"><span>${ar() ? 'مصاريف' : 'Extra'}</span><strong>${fmtNum(p.extraCosts || 0, 2)}</strong></div>
              <div class="stat-mini"><span>${ar() ? 'خصم' : 'Discount'}</span><strong>${fmtNum(p.discount || 0, 2)}</strong></div>
              <div class="stat-mini"><span>${ar() ? 'الإجمالي النهائي' : 'Final total'}</span><strong>${fmtNum(p.finalTotal, 2)}</strong></div>
              <div class="stat-mini"><span>${ar() ? 'المدفوع' : 'Paid'}</span><strong>${fmtNum(p.paid, 2)}</strong></div>
              <div class="stat-mini"><span>${ar() ? 'المتبقي' : 'Remaining'}</span><strong>${fmtNum(p.remaining, 2)}</strong></div>
            </div></div>
          <div class="card" style="box-shadow:none;border:none;padding:0">
            <div class="table-wrap"><table class="data-table">
              <thead><tr>
                <th>${t('quality')}</th><th class="num">${t('gsm')}</th><th class="num">${t('size')}</th>
                <th class="num">${ar() ? 'الكمية المطلوبة' : 'Ordered'}</th>
                <th class="num">${ar() ? 'المستلم' : 'Received'}</th>
                <th class="num">${ar() ? 'المرتجع' : 'Returned'}</th>
                <th class="num">${ar() ? 'الوزن الفعلي' : 'Actual wt'}</th>
                <th class="num">${ar() ? 'الوزن التقديري' : 'Est. wt'}</th>
                <th>${ar() ? 'السعر' : 'Price'}</th><th class="num">${ar() ? 'إجمالي السطر' : 'Line total'}</th>
                ${canReceive ? `<th>${t('actions')}</th>` : ''}
              </tr></thead>
              <tbody>${p.lines.map((l) => `<tr>
                <td data-label="${t('quality')}">${esc(App.productFamily(l.quality))}</td>
                <td class="num" data-label="${t('gsm')}">${fmtNum(l.gsm)}</td>
                <td class="num" data-label="${t('size')}">${fmtNum(l.size)}</td>
                <td class="num" data-label="${ar() ? 'المطلوبة' : 'Ordered'}">${fmtNum(l.qty)}</td>
                <td class="num pos" data-label="${ar() ? 'المستلم' : 'Received'}"><strong>${fmtNum(l.receivedQty || 0)}</strong>${l.receivedQty >= l.qty ? ' ✓' : ''}</td>
                <td class="num neg" data-label="${ar() ? 'المرتجع' : 'Returned'}">${fmtNum(l.returnedQty || 0)}</td>
                <td class="num" data-label="${ar() ? 'وزن فعلي' : 'Actual'}">${fmtNum(l.weightActual || 0, 3)}</td>
                <td class="num muted" data-label="${ar() ? 'وزن تقديري' : 'Est.'}">${l.weightEstimated == null ? '—' : fmtNum(l.weightEstimated, 2)}</td>
                <td data-label="${ar() ? 'السعر' : 'Price'}" class="small muted">${fmtNum(l.unitPrice, 2)} / ${l.priceBasis === 'kg' ? t('kg') : ar() ? 'بكرة' : 'reel'}</td>
                <td class="num" data-label="${ar() ? 'الإجمالي' : 'Total'}"><strong>${fmtNum(l.lineTotal, 2)}</strong></td>
                ${canReceive ? `<td class="actions-cell">
                  <button class="icon-btn" data-reg="${esc(l.id)}" title="${ar() ? 'استلام بكر جديدة عبر تسجيل البكر' : 'Receive via reel registration'}">➕</button>
                  <button class="icon-btn" data-link="${esc(l.id)}" title="${ar() ? 'ربط بكر متاحة مسجلة مسبقًا' : 'Link available reels'}">🔗</button>
                </td>` : ''}
              </tr>`).join('')}</tbody>
              <tfoot><tr>
                <td colspan="3">${t('total')}</td>
                <td class="num">${fmtNum(p.lines.reduce((s, l) => s + l.qty, 0))}</td>
                <td class="num">${fmtNum(p.lines.reduce((s, l) => s + (l.receivedQty || 0), 0))}</td>
                <td class="num">${fmtNum(p.lines.reduce((s, l) => s + (l.returnedQty || 0), 0))}</td>
                <td class="num">${fmtNum(round6(w.a), 3)}</td>
                <td class="num">${fmtNum(round6(w.e), 2)}</td>
                <td></td><td class="num">${fmtNum(p.subtotal, 2)}</td>
                ${canReceive ? '<td></td>' : ''}
              </tr></tfoot>
            </table></div>
          </div>
          ${canReceive ? `<p class="muted small">${ar()
            ? 'الاستلام بطريقتين: ➕ تسجيل بكر جديدة (رول جديد ببكره — حركة إنتاج تلقائية واحدة لكل بكرة عبر محرك التسجيل القائم) أو 🔗 ربط بكر متاحة مسجلة مسبقًا (بلا أي حركة إضافية). البكرة لا تُربط بفاتورتين.'
            : 'Receive via ➕ reel registration (one automatic production movement per reel) or 🔗 link already-registered available reels (no extra movement). One reel links to one invoice only.'}</p>` : ''}
          ${p.status === 'cancelled' ? `<div class="card notice-card">${ar() ? '⚠ الفاتورة ملغاة — البكر المستلمة قبل الإلغاء تبقى أصولًا مخزنية فعلية بحركاتها الصحيحة.' : 'Cancelled — already received reels stay in stock with their movements.'}</div>` : ''}
        </div>
        <div class="card">
          <div class="card-head-row"><h3>${ar() ? 'سجل الاستلام (روابط البكر بالفاتورة)' : 'Receiving log (reel links)'}</h3></div>
          <div class="table-wrap"><table class="data-table">
            <thead><tr><th>${t('date')}</th><th>${ar() ? 'البكرة' : 'Reel'}</th>
            <th>${t('quality')}</th><th class="num">${t('gsm')}</th><th class="num">${t('size')}</th>
            <th class="num">${ar() ? 'الوزن الفعلي' : 'Actual wt'}</th>
            <th>${ar() ? 'طريقة الاستلام' : 'Method'}</th><th></th></tr></thead>
            <tbody>${receives.length ? receives.map((r) => `<tr>
              <td data-label="${t('date')}">${fmtDate(r.date)}</td>
              <td data-label="${ar() ? 'البكرة' : 'Reel'}"><strong dir="ltr">${fmtNum(r.rollNo)}/${fmtNum(r.reelNo)}</strong></td>
              <td>${esc(App.productFamily(r.quality))}</td>
              <td class="num">${fmtNum(r.gsm)}</td><td class="num">${fmtNum(r.size)}</td>
              <td class="num">${fmtNum(r.weight, 3)}</td>
              <td>${r.kind === 'register' ? `<span class="badge badge-st-avail">${ar() ? 'تسجيل بكر' : 'registered'}</span>` : `<span class="badge">${ar() ? 'ربط بكر متاحة' : 'linked'}</span>`}</td>
              <td class="actions-cell"><button class="icon-btn danger" data-unlink="${esc(r.id)}" title="${ar() ? 'إزالة الرابط (تصحيح تتبع — البكرة وحركتها كما هي)' : 'Unlink'}">✕</button></td>
            </tr>`).join('') : `<tr><td colspan="8" class="empty">${ar() ? 'لا استلامات بعد' : 'No receiving yet'}</td></tr>`}</tbody>
          </table></div>
        </div>
        <div class="card">
          <div class="card-head-row"><h3>${ar() ? 'مرتجعات مرتبطة بالفاتورة' : 'Returns on this invoice'}</h3>
            ${p.status !== 'cancelled' && receives.length ? `<button class="btn btn-warn" id="pd-return">↩ ${ar() ? 'إنشاء مرتجع' : 'Create return'}</button>` : ''}</div>
          <div class="table-wrap"><table class="data-table">
            <thead><tr><th>${ar() ? 'الرقم' : 'No.'}</th><th>${t('date')}</th>
            <th class="num">${ar() ? 'الكمية' : 'Qty'}</th><th>${ar() ? 'السبب' : 'Reason'}</th>
            <th>${ar() ? 'الحالة' : 'Status'}</th></tr></thead>
            <tbody>${returns.length ? returns.map((r) => `<tr>
              <td><strong dir="ltr">${esc(retLabel(r))}</strong></td><td>${fmtDate(r.date)}</td>
              <td class="num">${fmtNum(r.lines.reduce((s, l) => s + (l.qty || 0), 0))}</td>
              <td>${esc(r.reason || '—')}</td>
              <td>${r.status === 'active' ? `<span class="badge badge-st-avail">${ar() ? 'ساري' : 'active'}</span>` : `<span class="badge badge-st-undef">${ar() ? 'ملغي' : 'cancelled'}</span>`}</td>
            </tr>`).join('') : `<tr><td colspan="5" class="empty">${ar() ? 'لا مرتجعات' : 'No returns'}</td></tr>`}</tbody>
          </table></div>
        </div>`;

      host.querySelector('#pd-back').addEventListener('click', () => App.navigate('purchases'));
      host.querySelector('#pd-print').addEventListener('click', () => printPurchase(p, receives));
      const editBtn = host.querySelector('#pd-edit');
      if (editBtn) editBtn.addEventListener('click', () => { App.pendingPurchaseEdit = p.id; App.navigate('purchase-form'); });
      host.querySelectorAll('[data-reg]').forEach((b) => b.addEventListener('click', () => {
        const line = p.lines.find((l) => l.id === b.dataset.reg);
        openReceiveRegisterModal(p, line, () => load());
      }));
      host.querySelectorAll('[data-link]').forEach((b) => b.addEventListener('click', () => {
        const line = p.lines.find((l) => l.id === b.dataset.link);
        openLinkReelsModal(p, line, () => load());
      }));
      host.querySelectorAll('[data-unlink]').forEach((b) => b.addEventListener('click', async () => {
        const rec = data.receives.find((r) => r.id === b.dataset.unlink);
        if (!rec) return;
        const ok = await confirmDialog({
          title: ar() ? 'إزالة رابط استلام' : 'Unlink receiving record',
          message: ar()
            ? `إزالة رابط البكرة ${rec.rollNo}/${rec.reelNo} من الفاتورة؟ البكرة وحركة إنتاجها تبقى كما هي في المخزون — تصحيح تتبع فقط.`
            : 'Remove this link? The reel and its movement stay untouched.',
          danger: true,
        });
        if (!ok) return;
        try {
          await PUR.unlinkReceive(rec.id);
          toast(ar() ? 'تمت إزالة الرابط — المخزون لم يتغير' : 'Link removed (no stock change)', 'ok');
          load();
        } catch (e) { toast(String(e.message || e), 'err'); }
      }));
      const retBtn = host.querySelector('#pd-return');
      if (retBtn) retBtn.addEventListener('click', () => openReturnModal(p, () => load()));
    }

    /* استلام بكر جديدة عبر محرك تسجيل البكر القائم — حركة إنتاج واحدة لكل بكرة */
    function openReceiveRegisterModal(purchase, line, onDone) {
      const remaining = line.qty - (line.receivedQty || 0);
      const node = el(`<div class="pur-receive-form">
        <p class="muted small form-sub">${ar()
          ? `استلام بكر جديدة للبند (مقاس ${fmtNum(line.size)} — ${fmtNum(line.gsm)} جرام — ${esc(App.productFamily(line.quality))}). الحفظ ينشئ رولًا جديدًا عبر محرك «تسجيل البكر» القائم نفسه: حركة إنتاج واحدة لكل بكرة بوزنها الفعلي، ثم تُربط البكر بالفاتورة — بلا أي حركة مزدوجة.`
          : 'Registers a new roll through the existing reel-registration engine (one movement per reel), then links the reels to this invoice.'}</p>
        <div class="form-grid">
          <label class="field"><span>${t('date')} *</span>
            <input id="rr-date" type="date" value="${esc(todayISO())}"></label>
          <label class="field"><span>${t('gsm')} — ${ar() ? 'جرام الرول (يقترح من البند)' : 'roll GSM'}</span>
            <input id="rr-gram" type="number" min="1" step="any" value="${esc(line.gsm)}"></label>
          <label class="field"><span>${ar() ? 'عدد البكر المستلمة' : 'Reels to receive'} *</span>
            <input id="rr-count" type="number" min="1" step="1" max="${remaining}" value="${remaining}"></label>
          <label class="field"><span>${t('notes')}</span>
            <input id="rr-notes" type="text" value="${ar() ? `استلام فاتورة ` : 'Receiving '}${esc(seqLabel(purchase))}"></label>
        </div>
        <section class="field field-wide">
          <div class="card-head-row"><strong>${ar() ? 'جدول البكر (رقم تلقائي | مقاس | وزن فعلي)' : 'Reels (auto no. | size | actual weight)'}</strong>
            <button type="button" class="btn btn-ghost" id="rr-add">+ ${ar() ? 'إضافة بكرة' : 'Add reel'}</button></div>
          <div class="reel-grid-head" aria-hidden="true">
            <span>${ar() ? 'رقم البكرة' : 'Reel no.'}</span><span>${t('size')}</span>
            <span>${ar() ? 'الوزن (كجم)' : 'Weight (kg)'}</span><span>${t('gsm')}</span><span></span>
          </div>
          <div id="rr-rows"></div>
          <div class="reel-totals" id="rr-totals"></div>
        </section>
        <div class="form-error" id="rr-error" role="alert"></div>
        <div class="confirm-actions">
          <button class="btn btn-primary" id="rr-save">${ar() ? 'حفظ الرول وربط البكر بالفاتورة' : 'Save roll & link to invoice'}</button>
          <button class="btn btn-ghost" id="rr-cancel">${t('cancel')}</button>
        </div></div>`);
      openModal(node, { title: ar() ? `استلام — تسجيل بكر للفاتورة ${seqLabel(purchase)}` : 'Receive via reel registration', wide: true });
      const rowsHost = node.querySelector('#rr-rows');
      const gramIn = node.querySelector('#rr-gram');
      const addRow = (i) => {
        const row = document.createElement('div');
        row.className = 'reel-row';
        row.innerHTML = `
          <input class="re-no" type="number" min="1" step="1" value="${i}" aria-label="reel no">
          <input class="re-size" type="number" min="1" step="any" value="${esc(line.size)}" aria-label="size">
          <input class="re-weight" type="number" min="0.001" step="0.001" placeholder="7.99" aria-label="weight">
          <input class="re-gram" type="number" min="1" step="any" value="${esc(line.gsm)}" aria-label="gsm">
          <span class="muted small">${esc(App.productFamily(line.quality))}</span>
          <button type="button" class="btn btn-ghost re-remove" aria-label="remove">×</button>`;
        row.querySelector('.re-remove').addEventListener('click', () => { row.remove(); updateTotals(); });
        row.addEventListener('input', updateTotals);
        rowsHost.appendChild(row);
      };
      const updateTotals = () => {
        const rows = [...rowsHost.querySelectorAll('.reel-row')].map((r) => ({
          reelNo: r.querySelector('.re-no').value,
          size: Number(r.querySelector('.re-size').value) || 0,
          weight: Number(r.querySelector('.re-weight').value) || 0,
          gram: Number(r.querySelector('.re-gram').value) || 0,
        })).filter((r) => r.reelNo !== '' || r.size > 0 || r.weight > 0);
        const complete = rows.filter((r) => String(r.reelNo).trim() !== '' && r.size > 0 && r.weight > 0 && r.gram > 0);
        node.querySelector('#rr-totals').innerHTML =
          `${ar() ? 'عدد البكرات المكتملة' : 'Complete reels'}: <strong>${fmtNum(complete.length)}</strong>
           &nbsp;•&nbsp; ${ar() ? 'إجمالي الوزن الفعلي' : 'Total actual weight'}: <strong>${fmtNum(round6(complete.reduce((s, r) => s + r.weight, 0)), 3)}</strong> ${t('kg')}`;
      };
      for (let i = 1; i <= Math.min(remaining, 10); i++) addRow(i);
      updateTotals();
      node.querySelector('#rr-add').addEventListener('click', () => {
        const rows = [...rowsHost.querySelectorAll('.reel-row')];
        const nextNo = rows.length ? Math.max(...rows.map((r) => parseInt(r.querySelector('.re-no').value, 10) || 0)) + 1 : 1;
        addRow(nextNo);
        updateTotals();
      });
      node.querySelector('#rr-cancel').addEventListener('click', closeModal);
      node.querySelector('#rr-save').addEventListener('click', async () => {
        const errBox = node.querySelector('#rr-error');
        errBox.textContent = '';
        const date = node.querySelector('#rr-date').value;
        const notes = node.querySelector('#rr-notes').value.trim();
        const reels = [...rowsHost.querySelectorAll('.reel-row')].map((r) => ({
          reelNo: r.querySelector('.re-no').value,
          size: Number(r.querySelector('.re-size').value) || 0,
          weight: Number(r.querySelector('.re-weight').value) || 0,
          gram: Number(r.querySelector('.re-gram').value) || 0,
          quality: line.quality,
        })).filter((r) => String(r.reelNo).trim() !== '' && r.size > 0 && r.weight > 0 && r.gram > 0);
        const problems = [];
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) problems.push(ar() ? 'التاريخ مطلوب' : 'Date required');
        if (!reels.length) problems.push(ar() ? 'أضف بكرًا مكتملة (رقم، مقاس، وزن فعلي، جرام)' : 'Add complete reels');
        const seen = new Set();
        for (const r of reels) {
          if (seen.has(String(r.reelNo))) problems.push(ar() ? `رقم البكرة ${r.reelNo} مكرر` : `Duplicate reel no. ${r.reelNo}`);
          seen.add(String(r.reelNo));
          if (String(CALC.toNumberOrRaw(r.size)) !== String(CALC.toNumberOrRaw(line.size))
            || String(CALC.toNumberOrRaw(r.gram)) !== String(CALC.toNumberOrRaw(line.gsm))) {
            problems.push(ar() ? `البكرة ${r.reelNo}: المقاس والجرام يجب أن يطابقا البند (${line.size} / ${line.gsm})` : `Reel ${r.reelNo}: size/GSM must match the line`);
          }
        }
        if (reels.length > remaining) problems.push(ar() ? `عدد البكر (${reels.length}) يتجاوز المتبقي على البند (${remaining})` : 'Reels exceed the line remainder');
        if (problems.length) { errBox.innerHTML = problems.map((x) => `• ${esc(x)}`).join('<br>'); return; }
        try {
          const res = await PUR.receiveRegister({
            purchaseId: purchase.id, lineId: line.id, date,
            gram: Number(gramIn.value) > 0 ? Number(gramIn.value) : line.gsm,
            notes, reels,
          });
          closeModal();
          toast(ar()
            ? `تم استلام ${fmtNum(res.reels)} بكرة عبر تسجيل الرول ${fmtNum(res.rollNo)} — حركة إنتاج واحدة لكل بكرة وربطها بالفاتورة`
            : `Roll ${res.rollNo} registered & linked (${res.reels} reels)`, 'ok', 6000);
          await App.refresh();
          if (typeof onDone === 'function') onDone();
        } catch (e) {
          errBox.innerHTML = ((e && e.errors) || [String(e.message || e)]).map((x) => `• ${esc(typeof x === 'string' ? x : x.msg)}`).join('<br>');
        }
      });
    }

    /* ربط بكر متاحة مسجلة مسبقًا — بلا أي حركة مخزنية إضافية */
    function openLinkReelsModal(purchase, line, onDone) {
      DB.getAll('reels').then(async (allReels) => {
        const data = await loadProcurement();
        const linkedIds = new Set(data.receives.map((r) => r.reelId));
        const matches = allReels
          .filter((r) => r.status === 'available'
            && cleanStr(r.quality) === cleanStr(line.quality)
            && String(CALC.toNumberOrRaw(r.gram)) === String(CALC.toNumberOrRaw(line.gsm))
            && String(CALC.toNumberOrRaw(r.size)) === String(CALC.toNumberOrRaw(line.size)))
          .sort((a, b) => (a.rollNo - b.rollNo) || (a.reelNo - b.reelNo));
        const remaining = line.qty - (line.receivedQty || 0);
        const node = el(`<div class="pur-link-form">
          <p class="muted small form-sub">${ar()
            ? `ربط بكر «متاحة» مسجلة مسبقًا بالفاتورة (مقاس ${fmtNum(line.size)} — ${fmtNum(line.gsm)} جرام — ${esc(App.productFamily(line.quality))}). الربط تسجيل مرجعي فقط: البكر لها حركاتها القائمة ولا تنشأ أي حركة إضافية. البكر المرتبطة بفواتير أخرى لا تظهر.`
            : 'Link already-registered AVAILABLE reels — reference only, no extra movement.'}</p>
          ${matches.length ? `<div class="picker-list" style="max-height:300px">${matches.map((r) => `
            <label class="pk-item"><input type="checkbox" data-id="${esc(r.id)}" ${linkedIds.has(r.id) ? 'disabled' : ''}>
              <span class="pk-code" dir="ltr">${fmtNum(r.rollNo)}/${fmtNum(r.reelNo)}</span>
              <span>${fmtNum(r.weight, 3)} ${t('kg')}</span>
              ${linkedIds.has(r.id) ? `<span class="badge badge-st-undef">${ar() ? 'مرتبطة بفاتورة أخرى' : 'linked to another invoice'}</span>` : ''}
            </label>`).join('')}</div>`
          : `<div class="empty">${ar() ? 'لا توجد بكر متاحة بهذه المواصفات — استلم بكرًا جديدة عبر «تسجيل البكر».' : 'No available reels with these specs — receive new ones via registration.'}</div>`}
          <div class="form-error" id="lk-error" role="alert"></div>
          <div class="confirm-actions">
            <button class="btn btn-primary" id="lk-save" ${matches.length ? '' : 'disabled'}>${ar() ? 'ربط البكر المحددة' : 'Link selected reels'}</button>
            <button class="btn btn-ghost" id="lk-cancel">${t('cancel')}</button>
          </div></div>`);
        openModal(node, { title: ar() ? `ربط بكر متاحة — ${seqLabel(purchase)}` : 'Link available reels', wide: true });
        node.querySelector('#lk-cancel').addEventListener('click', closeModal);
        node.querySelector('#lk-save').addEventListener('click', async () => {
          const errBox = node.querySelector('#lk-error');
          errBox.textContent = '';
          const ids = [...node.querySelectorAll('input[type=checkbox]:checked')].map((c) => c.dataset.id);
          if (!ids.length) { errBox.textContent = ar() ? 'حدد بكرًا واحدة على الأقل' : 'Select at least one reel'; return; }
          if (ids.length > remaining) {
            errBox.textContent = ar() ? `المحدد (${ids.length}) يتجاوز المتبقي على البند (${remaining})` : 'Selection exceeds the line remainder';
            return;
          }
          try {
            await PUR.linkReels({ purchaseId: purchase.id, lineId: line.id, reelIds: ids, date: todayISO(), kind: 'link' });
            closeModal();
            toast(ar() ? `تم ربط ${fmtNum(ids.length)} بكرة بالفاتورة — بلا أي حركة مخزنية إضافية` : 'Reels linked (no stock movement)', 'ok');
            await App.refresh();
            if (typeof onDone === 'function') onDone();
          } catch (e) {
            errBox.innerHTML = ((e && e.errors) || [String(e.message || e)]).map((x) => `• ${esc(typeof x === 'string' ? x : x.msg)}`).join('<br>');
          }
        });
      });
    }

    /* طباعة فاتورة الشراء A4 من بياناتها المحفوظة */
    function printPurchase(p, receives) {
      const company = App.state.settings.companyName || (ar() ? 'إدارة المخزن' : 'Inventory Management');
      const ordered = p.lines.reduce((s, l) => s + l.qty, 0);
      const received = p.lines.reduce((s, l) => s + (l.receivedQty || 0), 0);
      const root = document.createElement('div');
      root.id = 'print-root';
      root.innerHTML = `
        <div class="print-page doc-page">
          <div class="rp-head">
            <div class="rp-co">${esc(company)}</div>
            <div class="rp-title">${ar() ? 'فاتورة شراء' : 'Purchase Invoice'} <span dir="ltr">${esc(seqLabel(p))}</span></div>
            <div class="rp-sub"><div>${ar() ? 'الحالة' : 'Status'}: <strong>${esc(purchaseStatusLabel(p.status))}</strong> — ${ar() ? 'فاتورة المورد' : 'Supplier inv.'}: <strong dir="ltr">${esc(p.supplierInvoiceNo || '—')}</strong>${p.invoiceNoException ? ' (' + (ar() ? 'استثناء معتمد بمراجعة' : 'reviewed exception') + ')' : ''}</div></div>
          </div>
          <table class="doc-meta"><tbody><tr>
            <th>${ar() ? 'المورد' : 'Supplier'}</th><td>${esc(p.supplierName)}</td>
            <th>${t('date')}</th><td>${fmtDate(p.invoiceDate)}</td>
          </tr></tbody></table>
          <table class="rp-table doc-issue-table">
            <thead><tr>
              <th>${t('quality')}</th><th>${t('gsm')}</th><th>${t('size')}</th>
              <th>${ar() ? 'الكمية' : 'Qty'}</th><th>${ar() ? 'المستلم' : 'Received'}</th>
              <th>${ar() ? 'الوزن الفعلي (كجم)' : 'Actual wt (kg)'}</th>
              <th>${ar() ? 'الوزن التقديري (كجم)' : 'Est. wt (kg)'}</th>
              <th>${ar() ? 'السعر' : 'Unit price'}</th><th>${ar() ? 'الإجمالي' : 'Line total'}</th>
            </tr></thead>
            <tbody>${p.lines.map((l) => `<tr>
              <td>${esc(App.productFamily(l.quality))}</td>
              <td>${fmtNum(l.gsm)}</td><td>${fmtNum(l.size)}</td>
              <td>${fmtNum(l.qty)}</td><td>${fmtNum(l.receivedQty || 0)}</td>
              <td>${fmtNum(l.weightActual || 0, 3)}</td>
              <td>${l.weightEstimated == null ? '—' : fmtNum(l.weightEstimated, 2)}</td>
              <td>${fmtNum(l.unitPrice, 2)} / ${l.priceBasis === 'kg' ? t('kg') : (ar() ? 'بكرة' : 'reel')}</td>
              <td>${fmtNum(l.lineTotal, 2)}</td>
            </tr>`).join('')}</tbody>
          </table>
          <table class="rp-table doc-total"><tbody>
            <tr><td class="doc-total-label">${ar() ? 'إجمالي الكمية المطلوبة / المستلمة' : 'Ordered / received qty'}</td><td class="doc-total-num">${fmtNum(ordered)} / ${fmtNum(received)}</td></tr>
            <tr><td class="doc-total-label">${ar() ? 'المجموع الفرعي' : 'Subtotal'}</td><td class="doc-total-num">${fmtNum(p.subtotal, 2)}</td></tr>
            <tr><td class="doc-total-label">${ar() ? 'مصاريف إضافية / خصم' : 'Extra costs / discount'}</td><td class="doc-total-num">${fmtNum(p.extraCosts || 0, 2)} / ${fmtNum(p.discount || 0, 2)}</td></tr>
            <tr><td class="doc-total-label">${ar() ? 'الإجمالي النهائي' : 'Final total'}</td><td class="doc-total-num">${fmtNum(p.finalTotal, 2)}</td></tr>
            <tr><td class="doc-total-label">${ar() ? 'المدفوع / المتبقي' : 'Paid / remaining'}</td><td class="doc-total-num">${fmtNum(p.paid, 2)} / ${fmtNum(p.remaining, 2)}</td></tr>
          </tbody></table>
          ${p.notes ? `<div class="doc-notes">${t('notes')}: ${esc(p.notes)}</div>` : ''}
          <div class="rp-foot"><div class="sig-row">
            <div class="sig"><span>${ar() ? 'أمين المخزن' : 'Storekeeper'}</span><i></i></div>
            <div class="sig"><span>${ar() ? 'المحاسب' : 'Accountant'}</span><i></i></div>
          </div></div>
        </div>`;
      const old = document.getElementById('print-root');
      if (old) old.remove();
      document.getElementById('view').appendChild(root);
      window.print();
      setTimeout(() => root.remove(), 500);
    }
  }

  /* =============== مرتجع مورد — حوار عام (من المشتريات أو المورد) =============== */
  function openReturnModal(purchase, onDone) {
    Promise.all([loadProcurement(), DB.getAll('reels')]).then(([data, allReels]) => {
      const suppliers = data.suppliers.filter((s) => !s.archived);
      const purchases = data.purchases.filter((p) => p.status !== 'cancelled');
      const activeReturnReelIds = new Set();
      for (const r of data.returns.filter((x) => x.status === 'active')) {
        for (const l of (r.lines || [])) for (const id of (l.reelIds || [])) activeReturnReelIds.add(id);
      }
      const node = el(`<div class="pur-return-form">
        <p class="muted small form-sub">${ar()
          ? 'المرتجع يُسجل كحركات صرف صريحة قابلة للتتبع (لا تعديل صامت على أي سجل). البكر القابلة للمرتجع: المتاحة فقط — المصروفة للعملاء لا يمكن مرتجعها، والبكرة لا تُرتجع مرتين. اختر بكرًا محددة كلما توفرت، وإلا سجّل الكمية.'
          : 'Returns create explicit traceable out-movements. Only AVAILABLE reels can be returned — dispatched reels are blocked and a reel can never be returned twice. Select specific reel codes when available.'}</p>
        <div class="form-grid">
          <label class="field"><span>${ar() ? 'المورد' : 'Supplier'} *</span>
            <select id="rt-supplier">
              <option value="">— ${ar() ? 'اختر المورد' : 'select'} —</option>
              ${suppliers.map((s) => `<option value="${s.id}" ${purchase && Number(purchase.supplierId) === s.id ? 'selected' : ''}>${esc(s.code)} — ${esc(s.name)}</option>`).join('')}
            </select></label>
          <label class="field"><span>${ar() ? 'الفاتورة الأصلية (اختياري)' : 'Original invoice (optional)'}</span>
            <select id="rt-purchase"><option value="">— ${ar() ? 'بلا فاتورة' : 'none'} —</option></select></label>
          <label class="field"><span>${t('date')} *</span>
            <input id="rt-date" type="date" value="${esc(todayISO())}"></label>
          <label class="field"><span>${ar() ? 'سبب الإرجاع' : 'Reason'}</span>
            <input id="rt-reason" type="text" placeholder="${ar() ? 'مثال: عيوب صناعة / كمية زائدة' : 'defects / excess qty'}"></label>
          <label class="field field-wide"><span>${t('notes')}</span>
            <input id="rt-notes" type="text"></label>
        </div>
        <section class="field field-wide">
          <div class="card-head-row"><strong>${ar() ? 'بنود المرتجع' : 'Return lines'}</strong>
            <button type="button" class="btn btn-ghost" id="rt-add-line">+ ${ar() ? 'إضافة بند' : 'Add line'}</button></div>
          <div id="rt-lines"></div>
        </section>
        <div class="form-error" id="rt-error" role="alert"></div>
        <div class="confirm-actions">
          <button class="btn btn-warn" id="rt-save">${ar() ? 'تسجيل المرتجع (حركات صرف صريحة)' : 'Record return'}</button>
          <button class="btn btn-ghost" id="rt-cancel">${t('cancel')}</button>
        </div></div>`);
      openModal(node, { title: ar() ? 'مرتجع مورد جديد' : 'New supplier return', wide: true });

      const supSel = node.querySelector('#rt-supplier');
      const purSel = node.querySelector('#rt-purchase');
      const linesHost = node.querySelector('#rt-lines');
      const fillPurchases = () => {
        const sid = Number(supSel.value);
        const opts = sid ? purchases.filter((p) => Number(p.supplierId) === sid) : [];
        purSel.innerHTML = `<option value="">— ${ar() ? 'بلا فاتورة' : 'none'} —</option>`
          + opts.map((p) => `<option value="${esc(p.id)}" ${purchase && p.id === purchase.id ? 'selected' : ''}>${esc(seqLabel(p))} — ${fmtDate(p.invoiceDate)} — ${esc(p.supplierInvoiceNo || '')}</option>`).join('');
        if (purchase && opts.some((p) => p.id === purchase.id)) purSel.value = purchase.id;
      };
      supSel.addEventListener('change', fillPurchases);
      fillPurchases();

      const supplierOf = () => suppliers.find((s) => String(s.id) === String(supSel.value)) || null;
      const purchaseOf = () => data.purchases.find((p) => p.id === purSel.value) || null;

      const addLine = (preset) => {
        const wrap = el(`<div class="rt-line" data-id="${esc(uuid())}">
          <div class="form-grid">
            <label class="field"><span>${t('quality')} *</span>
              <select class="rl-quality">
                <option value="">—</option>
                ${CANON.concat([...new Set(App.state.products.map((p) => App.productFamily(p.quality)))].filter((f) => !CANON.includes(f))).map((f) => `<option value="${esc(f)}">${esc(f)}</option>`).join('')}
              </select></label>
            <label class="field"><span>${t('gsm')} *</span>
              <input class="rl-gsm" type="number" min="1" step="any" placeholder="125"></label>
            <label class="field"><span>${t('size')} *</span>
              <input class="rl-size" type="number" min="1" step="any" placeholder="100"></label>
            <label class="field"><span>${ar() ? 'الكمية المرتجعة' : 'Return qty'} *</span>
              <input class="rl-qty" type="number" min="1" step="1" placeholder="1"></label>
            <label class="field"><span>${ar() ? 'بند الفاتورة' : 'Invoice line'}</span>
              <select class="rl-lineid"><option value="">—</option></select></label>
            <div class="field"><span>&nbsp;</span>
              <div class="line-btns">
                <button type="button" class="btn btn-ghost rl-pick">${ar() ? 'تحديد بكر' : 'Pick reels'}</button>
                <button type="button" class="btn btn-ghost rl-remove">✕ ${ar() ? 'حذف' : 'Remove'}</button>
              </div></div>
          </div>
          <div class="picker-list rl-picker" hidden style="max-height:220px"></div>
          <div class="line-meta muted small"></div>
        </div>`);
        linesHost.appendChild(wrap);
        wrap._selected = [];
        const fillLineIds = () => {
          const p = purchaseOf();
          const sel = wrap.querySelector('.rl-lineid');
          sel.innerHTML = `<option value="">—</option>` + (p ? p.lines.map((l) =>
            `<option value="${esc(l.id)}">${esc(App.productFamily(l.quality))} / ${fmtNum(l.gsm)} / ${fmtNum(l.size)} (${ar() ? 'مستلم' : 'rcvd'} ${fmtNum(l.receivedQty || 0)})</option>`).join('') : '');
          if (preset && preset.lineId) sel.value = preset.lineId;
        };
        wrap.querySelector('.rl-lineid').addEventListener('change', () => {
          const p = purchaseOf();
          const lid = wrap.querySelector('.rl-lineid').value;
          if (p && lid) {
            const l = p.lines.find((x) => x.id === lid);
            if (l) {
              wrap.querySelector('.rl-quality').value = l.quality;
              wrap.querySelector('.rl-gsm').value = l.gsm;
              wrap.querySelector('.rl-size').value = l.size;
              wrap.querySelector('.rl-qty').value = '';
            }
          }
        });
        wrap.querySelector('.rl-remove').addEventListener('click', () => wrap.remove());
        wrap.querySelector('.rl-pick').addEventListener('click', () => {
          const picker = wrap.querySelector('.rl-picker');
          const q = wrap.querySelector('.rl-quality').value;
          const g = Number(wrap.querySelector('.rl-gsm').value);
          const s = Number(wrap.querySelector('.rl-size').value);
          if (!q || !(g > 0) || !(s > 0)) {
            toast(ar() ? 'أكمل الصنف والجرام والمقاس أولًا' : 'Complete product, GSM and size first', 'warn');
            return;
          }
          const matches = allReels.filter((r) => r.status === 'available'
            && cleanStr(r.quality) === cleanStr(q)
            && String(CALC.toNumberOrRaw(r.gram)) === String(CALC.toNumberOrRaw(g))
            && String(CALC.toNumberOrRaw(r.size)) === String(CALC.toNumberOrRaw(s)))
            .sort((a, b) => (a.rollNo - b.rollNo) || (a.reelNo - b.reelNo));
          const sel = new Set(wrap._selected.map((r) => r.id));
          picker.hidden = false;
          picker.innerHTML = matches.length ? matches.map((r) => `
            <label class="pk-item"><input type="checkbox" data-id="${esc(r.id)}" ${sel.has(r.id) ? 'checked' : ''} ${activeReturnReelIds.has(r.id) ? 'disabled title="' + (ar() ? 'داخل مرتجع نشط' : 'in an active return') + '"' : ''}>
              <span class="pk-code" dir="ltr">${fmtNum(r.rollNo)}/${fmtNum(r.reelNo)}</span>
              <span>${fmtNum(r.weight, 3)} ${t('kg')}</span>
            </label>`).join('')
            : `<div class="muted small" style="padding:.4rem">${ar() ? 'لا توجد بكر متاحة بهذه المواصفات — سجّل المرتجع ككمية.' : 'No available reels — record as a quantity return.'}</div>`;
          picker.querySelectorAll('input[type=checkbox]').forEach((c) => c.addEventListener('change', () => {
            const ids = [...picker.querySelectorAll('input:checked')].map((x) => x.dataset.id);
            wrap._selected = matches.filter((r) => ids.includes(r.id));
            const w = round6(wrap._selected.reduce((s2, r) => s2 + (Number(r.weight) || 0), 0));
            wrap.querySelector('.line-meta').innerHTML = wrap._selected.length
              ? `${ar() ? 'بكر محددة' : 'Selected'}: <strong>${fmtNum(wrap._selected.length)}</strong> — ${ar() ? 'الوزن' : 'weight'}: <strong>${fmtNum(w, 3)}</strong> ${t('kg')}`
              : '';
            if (wrap._selected.length) wrap.querySelector('.rl-qty').value = wrap._selected.length;
          }));
        });
        if (preset) {
          wrap.querySelector('.rl-quality').value = preset.quality || '';
          wrap.querySelector('.rl-gsm').value = preset.gsm == null ? '' : preset.gsm;
          wrap.querySelector('.rl-size').value = preset.size == null ? '' : preset.size;
          wrap.querySelector('.rl-qty').value = preset.qty || '';
        }
        fillLineIds();
        return wrap;
      };
      node.querySelector('#rt-add-line').addEventListener('click', () => addLine(null));
      addLine(null);

      node.querySelector('#rt-cancel').addEventListener('click', closeModal);
      node.querySelector('#rt-save').addEventListener('click', async () => {
        const errBox = node.querySelector('#rt-error');
        errBox.textContent = '';
        const sup = supplierOf();
        if (!sup) { errBox.textContent = ar() ? 'اختر المورد' : 'Select a supplier'; return; }
        const p = purchaseOf();
        const lines = [...linesHost.querySelectorAll('.rt-line')].map((wrap) => {
          const pickReels = wrap._selected || [];
          const qty = pickReels.length ? pickReels.length : (Number(wrap.querySelector('.rl-qty').value) || 0);
          const lid = wrap.querySelector('.rl-lineid').value;
          return {
            lineId: lid || null,
            quality: wrap.querySelector('.rl-quality').value,
            gsm: wrap.querySelector('.rl-gsm').value === '' ? null : Number(wrap.querySelector('.rl-gsm').value),
            size: wrap.querySelector('.rl-size').value === '' ? null : Number(wrap.querySelector('.rl-size').value),
            qty,
            reelIds: pickReels.map((r) => r.id),
          };
        }).filter((l) => l.qty > 0 || l.reelIds.length);
        const problems = [];
        if (!/^\d{4}-\d{2}-\d{2}$/.test(node.querySelector('#rt-date').value)) problems.push(ar() ? 'التاريخ مطلوب' : 'Date required');
        if (!lines.length) problems.push(ar() ? 'أضف بند مرتجع واحدًا على الأقل' : 'Add at least one return line');
        for (const l of lines) {
          if (!l.quality || !(l.gsm > 0) || !(l.size > 0) || !(l.qty > 0)) problems.push(ar() ? 'أكمل كل بند (الصنف والجرام والمقاس والكمية أو تحديد بكر)' : 'Complete every line');
        }
        if (problems.length) { errBox.innerHTML = problems.map((x) => `• ${esc(x)}`).join('<br>'); return; }
        const ok = await confirmDialog({
          title: ar() ? 'تأكيد تسجيل المرتجع' : 'Confirm return',
          message: ar()
            ? `تسجيل مرتجع إلى «${sup.name}» بـ ${fmtNum(lines.reduce((s, l) => s + l.qty, 0))} بكرة/كمية؟ سيُنشئ حركات صرف صريحة في المخزون وتتغير حالة البكر المحددة إلى «مرجعة للمورد».`
            : 'Record this return with explicit out-movements?',
          danger: true, yesLabel: ar() ? 'تسجيل المرتجع' : 'Record return',
        });
        if (!ok) return;
        try {
          const ret = await PUR.createReturn({
            supplierId: sup.id,
            purchaseId: p ? p.id : null,
            date: node.querySelector('#rt-date').value,
            reason: node.querySelector('#rt-reason').value.trim(),
            notes: node.querySelector('#rt-notes').value.trim(),
            lines,
          });
          closeModal();
          toast(ar() ? `تم تسجيل المرتجع ${retLabel(ret)} — حركات صرف صريحة قابلة للتتبع` : `Return ${retLabel(ret)} recorded`, 'ok', 5000);
          await App.refresh();
          if (typeof onDone === 'function') onDone();
        } catch (e) {
          errBox.innerHTML = ((e && e.errors) || [String(e.message || e)]).map((x) => `• ${esc(typeof x === 'string' ? x : x.msg)}`).join('<br>');
        }
      });
    });
  }

  /* =============== تقارير المشتريات — تبويب داخل #purchases-reports =============== */
  const PUR_REPORTS = [
    { id: 'purchases', ar: 'تقرير المشتريات (فترة)', en: 'Purchases by period' },
    { id: 'by-supplier', ar: 'المشتريات حسب المورد', en: 'Purchases by supplier' },
    { id: 'by-product', ar: 'المشتريات حسب الصنف والجرام والمقاس', en: 'Purchases by product / GSM / size' },
    { id: 'supplier-history', ar: 'سجل تعاملات مورد', en: 'Supplier transaction history' },
    { id: 'returns', ar: 'تقرير مرتجعات الموردين', en: 'Supplier returns' },
    { id: 'outstanding', ar: 'الأرصدة المستحقة على الفواتير', en: 'Outstanding invoice balances' },
  ];

  function renderPurchaseReports(host) {
    host.innerHTML = `
      <div class="page-head"><h2>${ar() ? 'تقارير المشتريات والموردين' : 'Purchases & suppliers reports'}</h2>
        <div class="head-actions"><button class="btn btn-ghost" id="pr-back">← ${ar() ? 'المشتريات' : 'Purchases'}</button></div></div>
      <p class="muted small">${ar() ? 'تقارير مشتريات وتتبع تعاملات الموردين — ليست نظامًا محاسبيًا كاملًا: الأرصدة المستحقة تظهر فقط حيث سُجل مدفوع/إجمالي في الفاتورة.' : 'Procurement tracking reports — not a full accounting system; outstanding balances appear only where totals/payments were recorded.'}</p>
      <div class="report-picker">${PUR_REPORTS.map((r, i) => `
        <button class="report-card ${i === 0 ? 'active' : ''}" data-report="${r.id}">
          <span>🛒</span><span>${lang() ? r.ar : r.en}</span></button>`).join('')}
      </div>
      <div class="card filters" id="prp-filters"></div>
      <div class="rep-actions">
        <button class="btn btn-primary" id="prp-print">🖨 ${lang() ? 'طباعة التقرير (A4)' : 'Print report (A4)'}</button>
        <button class="btn btn-ghost" id="prp-excel">${t('exportExcel')}</button>
      </div>
      <div id="print-root"></div>`;

    let current = 'purchases';
    let lastModel = null;
    load().catch((e) => console.error('[purchase-reports]', e));
    async function load() {
      const data = await loadProcurement();
      if (!host.querySelector('#prp-filters')) return;
      buildFilters(data);
      build(data);
    }
    function buildFilters(data) {
      const F = host.querySelector('#prp-filters');
      F.innerHTML = '';
      const add = (html) => F.appendChild(el(html));
      const supplierOpts = data.suppliers.slice().sort((a, b) => (a.code || '').localeCompare(b.code || ''))
        .map((s) => `<option value="${s.id}">${esc(s.code)} — ${esc(s.name)}</option>`).join('');
      add(`<label class="fl"><span>${t('from')}</span><input type="date" id="prp-from"></label>`);
      add(`<label class="fl"><span>${t('to')}</span><input type="date" id="prp-to"></label>`);
      if (['by-supplier', 'supplier-history'].includes(current)) {
        add(`<label class="fl"><span>${ar() ? 'المورد' : 'Supplier'}</span><select id="prp-supplier"><option value="">${t('all')}</option>${supplierOpts}</select></label>`);
      }
      if (current === 'by-product') {
        add(`<label class="fl"><span>${t('quality')}</span><select id="prp-product"><option value="">${t('all')}</option>${CANON.map((f) => `<option>${esc(f)}</option>`).join('')}</select></label>`);
        add(`<label class="fl"><span>${t('gsm')}</span><input type="number" id="prp-gsm" placeholder="${t('all')}"></label>`);
        add(`<label class="fl"><span>${t('size')}</span><input type="number" id="prp-size" placeholder="${t('all')}"></label>`);
      }
      if (current === 'purchases' || current === 'returns') {
        add(`<label class="fl"><span>${ar() ? 'المورد' : 'Supplier'}</span><select id="prp-supplier2"><option value="">${t('all')}</option>${supplierOpts}</select></label>`);
      }
      const run = el(`<div class="fl fl-btn"><button class="btn btn-primary" id="prp-run">${lang() ? 'عرض التقرير' : 'Generate'}</button></div>`);
      F.appendChild(run);
      run.querySelector('#prp-run').addEventListener('click', () => loadProcurement().then(build));
      F.querySelectorAll('input, select').forEach((i) => i.addEventListener('change', () => loadProcurement().then(build)));
    }
    host.querySelectorAll('.report-card').forEach((b) => b.addEventListener('click', () => {
      current = b.dataset.report;
      host.querySelectorAll('.report-card').forEach((x) => x.classList.toggle('active', x === b));
      load();
    }));
    host.querySelector('#pr-back').addEventListener('click', () => App.navigate('purchases'));

    function build(data) {
      const from = host.querySelector('#prp-from') ? host.querySelector('#prp-from').value : '';
      const to = host.querySelector('#prp-to') ? host.querySelector('#prp-to').value : '';
      const supF = (id1, id2) => {
        const v = (host.querySelector('#' + id1) || {}).value || (host.querySelector('#' + id2) || {}).value || '';
        return v ? Number(v) : null;
      };
      const supplier = supF('prp-supplier', 'prp-supplier2');
      const product = (host.querySelector('#prp-product') || {}).value || '';
      const gsm = (host.querySelector('#prp-gsm') || {}).value || '';
      const size = (host.querySelector('#prp-size') || {}).value || '';
      const inPeriod = (d) => (!from || d >= from) && (!to || d <= to);
      const purchases = data.purchases.filter((p) => p.status !== 'cancelled' && inPeriod(p.invoiceDate)
        && (!supplier || Number(p.supplierId) === supplier));
      const rep = PUR_REPORTS.find((r) => r.id === current);
      const title = lang() ? rep.ar : rep.en;
      const subtitle = [`${t('from')}: ${from ? fmtDate(from) : '—'} — ${t('to')}: ${to ? fmtDate(to) : '—'}`];
      let model = null;
      if (current === 'purchases') {
        const rows = [];
        for (const p of purchases) {
          for (const l of p.lines) {
            rows.push([seqLabel(p), fmtDate(p.invoiceDate), p.supplierName, p.supplierInvoiceNo || '',
              App.productFamily(l.quality), fmtNum(l.gsm), fmtNum(l.size), fmtNum(l.qty),
              fmtNum(l.receivedQty || 0), fmtNum(l.weightActual || 0, 3), fmtNum(l.lineTotal, 2)]);
          }
        }
        const total = round6(purchases.reduce((s, p) => s + num(p.finalTotal), 0));
        model = {
          title, subtitle,
          summary: [`${ar() ? 'عدد الفواتير' : 'Invoices'}: ${fmtNum(purchases.length)}`,
            `${ar() ? 'إجمالي المشتريات' : 'Purchases total'}: ${fmtNum(total, 2)}`],
          headers: [ar() ? 'الرقم' : 'No.', t('date'), ar() ? 'المورد' : 'Supplier', ar() ? 'فاتورة المورد' : 'Supplier inv.',
            t('quality'), t('gsm'), t('size'), ar() ? 'الكمية' : 'Qty', ar() ? 'المستلم' : 'Received',
            `${ar() ? 'الوزن الفعلي' : 'Actual wt'} (${t('kg')})`, ar() ? 'إجمالي السطر' : 'Line total'],
          rows,
          totalsRow: [ar() ? 'الإجمالي' : 'Total', `${fmtNum(purchases.length)} ${ar() ? 'فاتورة' : 'invoices'}`, '', '', '', '', '', '', '', '',
            fmtNum(round6(purchases.reduce((s, p) => s + p.lines.reduce((s2, l) => s2 + l.lineTotal, 0), 0)), 2)],
        };
      } else if (current === 'by-supplier') {
        const rows = [];
        const sups = data.suppliers.filter((s) => !supplier || s.id === supplier);
        for (const s of sups) {
          const ps = purchases.filter((p) => Number(p.supplierId) === s.id);
          const qty = ps.reduce((s2, p) => s2 + p.lines.reduce((s3, l) => s3 + l.qty, 0), 0);
          const rcv = ps.reduce((s2, p) => s2 + p.lines.reduce((s3, l) => s3 + (l.receivedQty || 0), 0), 0);
          const total = round6(ps.reduce((s2, p) => s2 + num(p.finalTotal), 0));
          rows.push([s.code, s.name, fmtNum(ps.length), fmtNum(qty), fmtNum(rcv), fmtNum(total, 2)]);
        }
        model = {
          title, subtitle,
          headers: [ar() ? 'الكود' : 'Code', ar() ? 'المورد' : 'Supplier', ar() ? 'عدد الفواتير' : 'Invoices',
            ar() ? 'الكمية المطلوبة' : 'Ordered', ar() ? 'المستلم' : 'Received', ar() ? 'إجمالي المشتريات' : 'Total'],
          rows,
          totalsRow: [ar() ? 'الإجمالي' : 'Total', `${fmtNum(sups.length)} ${ar() ? 'مورد' : 'suppliers'}`, '',
            fmtNum(rows.reduce((s, r) => s + (Number(String(r[3]).replace(/,/g, '')) || 0), 0)),
            fmtNum(rows.reduce((s, r) => s + (Number(String(r[4]).replace(/,/g, '')) || 0), 0)),
            fmtNum(round6(rows.reduce((s, r) => s + (Number(String(r[5]).replace(/,/g, '')) || 0), 0)), 2)],
        };
      } else if (current === 'by-product') {
        const map = new Map();
        for (const p of purchases) {
          for (const l of p.lines) {
            if (product && App.productFamily(l.quality) !== product) continue;
            if (gsm && String(l.gsm) !== String(Number(gsm))) continue;
            if (size && String(l.size) !== String(Number(size))) continue;
            const k = CALC.comboKey(l.quality, l.gsm, l.size);
            const row = map.get(k) || { quality: l.quality, gsm: l.gsm, size: l.size, qty: 0, rcv: 0, ret: 0, total: 0 };
            row.qty += l.qty; row.rcv += (l.receivedQty || 0); row.ret += (l.returnedQty || 0);
            row.total += l.lineTotal;
            map.set(k, row);
          }
        }
        const rows = [...map.values()].map((r) => [App.productFamily(r.quality), fmtNum(r.gsm), fmtNum(r.size),
          fmtNum(r.qty), fmtNum(r.rcv), fmtNum(r.ret), fmtNum(round6(r.total), 2)]);
        model = {
          title, subtitle,
          summary: [`${ar() ? 'صافي المشتريات (المستلم − المرتجع)' : 'Net purchased (received − returned)'}: ${fmtNum(round6([...map.values()].reduce((s, r) => s + r.rcv - r.ret, 0)))}`],
          headers: [t('quality'), t('gsm'), t('size'), ar() ? 'الكمية المطلوبة' : 'Ordered', ar() ? 'المستلم' : 'Received',
            ar() ? 'المرتجع' : 'Returned', ar() ? 'إجمالي التكلفة' : 'Total cost'],
          rows,
          totalsRow: [ar() ? 'الإجمالي' : 'Total', '', '',
            fmtNum([...map.values()].reduce((s, r) => s + r.qty, 0)),
            fmtNum([...map.values()].reduce((s, r) => s + r.rcv, 0)),
            fmtNum([...map.values()].reduce((s, r) => s + r.ret, 0)),
            fmtNum(round6([...map.values()].reduce((s, r) => s + r.total, 0)), 2)],
        };
      } else if (current === 'supplier-history') {
        const s = data.suppliers.find((x) => x.id === supplier);
        if (!s) { toast(ar() ? 'اختر المورد أولًا' : 'Select a supplier first', 'warn'); return; }
        const rows = [];
        for (const p of purchases.filter((p2) => Number(p2.supplierId) === s.id)) {
          rows.push([fmtDate(p.invoiceDate), ar() ? 'فاتورة شراء' : 'Purchase', seqLabel(p), p.supplierInvoiceNo || '',
            fmtNum(p.lines.reduce((s2, l) => s2 + l.qty, 0)), fmtNum(p.finalTotal, 2), fmtNum(p.paid, 2), fmtNum(p.remaining, 2)]);
        }
        for (const r of data.returns.filter((r2) => Number(r2.supplierId) === s.id && inPeriod(r2.date))) {
          rows.push([fmtDate(r.date), ar() ? 'مرتجع مورد' : 'Return', retLabel(r), '',
            `-${fmtNum(r.lines.reduce((s2, l) => s2 + (l.qty || 0), 0))}`, '', '', '']);
        }
        rows.sort((a, b) => String(b[0]).localeCompare(String(a[0])));
        model = {
          title: `${title} — ${s.code} ${s.name}`,
          subtitle,
          headers: [t('date'), ar() ? 'النوع' : 'Type', ar() ? 'الرقم' : 'No.', ar() ? 'فاتورة المورد' : 'Supplier inv.',
            ar() ? 'الكمية' : 'Qty', ar() ? 'الإجمالي' : 'Total', ar() ? 'المدفوع' : 'Paid', ar() ? 'المتبقي' : 'Remaining'],
          rows,
        };
      } else if (current === 'returns') {
        const list = data.returns.filter((r) => inPeriod(r.date) && (!supplier || Number(r.supplierId) === supplier));
        const rows = [];
        for (const r of list) {
          for (const l of r.lines) {
            rows.push([retLabel(r), fmtDate(r.date), r.supplierName,
              r.purchaseSeq ? seqLabel({ seq: r.purchaseSeq }) : '—',
              App.productFamily(l.quality), fmtNum(l.gsm), fmtNum(l.size), fmtNum(l.qty),
              l.reelIds && l.reelIds.length ? fmtNum(l.reelIds.length) : ar() ? 'كمية' : 'qty',
              fmtNum(l.weight || 0, 3), r.status === 'active' ? (ar() ? 'ساري' : 'active') : (ar() ? 'ملغي' : 'cancelled')]);
          }
        }
        model = {
          title, subtitle,
          summary: [`${ar() ? 'عدد المرتجعات' : 'Returns'}: ${fmtNum(list.length)} — ${ar() ? 'إجمالي الكميات المرتجعة' : 'Total returned'}: ${fmtNum(list.reduce((s, r) => s + r.lines.reduce((s2, l) => s2 + (l.qty || 0), 0), 0))}`],
          headers: [ar() ? 'الرقم' : 'No.', t('date'), ar() ? 'المورد' : 'Supplier', ar() ? 'الفاتورة' : 'Invoice',
            t('quality'), t('gsm'), t('size'), ar() ? 'الكمية' : 'Qty', ar() ? 'بكر محددة' : 'Reels',
            `${ar() ? 'الوزن' : 'Weight'} (${t('kg')})`, ar() ? 'الحالة' : 'Status'],
          rows,
        };
      } else if (current === 'outstanding') {
        const rows = [];
        let tot = 0;
        for (const p of purchases.filter((p2) => num(p2.finalTotal) - num(p2.paid) > 0)) {
          rows.push([seqLabel(p), fmtDate(p.invoiceDate), p.supplierName, p.supplierInvoiceNo || '',
            fmtNum(p.finalTotal, 2), fmtNum(p.paid, 2), fmtNum(p.remaining, 2)]);
          tot += num(p.remaining);
        }
        model = {
          title, subtitle,
          summary: [`${ar() ? 'إجمالي المستحق' : 'Total outstanding'}: ${fmtNum(round6(tot), 2)}`],
          headers: [ar() ? 'الرقم' : 'No.', t('date'), ar() ? 'المورد' : 'Supplier', ar() ? 'فاتورة المورد' : 'Supplier inv.',
            ar() ? 'الإجمالي' : 'Total', ar() ? 'المدفوع' : 'Paid', ar() ? 'المستحق' : 'Outstanding'],
          rows,
          totalsRow: [ar() ? 'الإجمالي' : 'Total', '', '', '', '', '', fmtNum(round6(tot), 2)],
        };
      }
      lastModel = model;
      const root = host.querySelector('#print-root');
      if (root && model) {
        root.innerHTML = '';
        App.paginateReport(model).forEach((page) => root.appendChild(page));
      }
    }

    host.querySelector('#prp-print').addEventListener('click', () => {
      if (!lastModel) { loadProcurement().then(build); }
      setTimeout(() => window.print(), 150);
    });
    host.querySelector('#prp-excel').addEventListener('click', () => {
      if (!lastModel) return;
      global.EXCEL.exportReportAOA(lastModel.title, lastModel.headers, lastModel.rows,
        lastModel.totalsRow || null, (lastModel.title || 'تقرير').replace(/\s+/g, '_'));
      toast(ar() ? 'تم تنزيل التقرير بصيغة إكسل' : 'report exported', 'ok');
    });
  }

  /* ---------------- view registrations ---------------- */
  App.registerView('suppliers', renderSuppliers);
  App.registerView('purchases', renderPurchases);
  App.registerView('purchase-form', renderPurchaseForm);
  App.registerView('purchase-details', renderPurchaseDetails);
  App.registerView('purchases-reports', renderPurchaseReports);
  App.openReturnModal = openReturnModal;
})(typeof window !== 'undefined' ? window : globalThis);


