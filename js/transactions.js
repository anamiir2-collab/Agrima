/* =========================================================================
   transactions.js — سجل الحركات: إضافة / تعديل / حذف مع سجل تدقيق
   Every mutation is audited (before/after snapshot) so historical records
   are never modified silently.
   ========================================================================= */
(function (global) {
  'use strict';
  const { comboKey, cleanStr, toNumberOrRaw, isComboComplete, round6 } = global.CALC;

  /* fingerprint for duplicate detection on re-import (NOT stored as id:
     legitimate manual re-entries with identical fields are still allowed
     but flagged during import preview) */
  function fingerprint(t) {
    return [cleanStr(t.date), cleanStr(t.quality), toNumberOrRaw(t.gsm), toNumberOrRaw(t.size),
      cleanStr(t.customer), cleanStr(t.permitNo), Number(t.addQty) || 0, Number(t.outQty) || 0,
      cleanStr(t.settlement)].join('||');
  }

  function validate(t) {
    const errors = [];
    if (!cleanStr(t.date)) errors.push({ field: 'date', msg: 'التاريخ مطلوب' });
    if (!cleanStr(t.quality)) errors.push({ field: 'quality', msg: 'اسم الصنف مطلوب' });
    if (!cleanStr(t.customer)) errors.push({ field: 'customer', msg: 'اسم العميل أو الجهة مطلوب' });
    const a = Number(t.addQty) || 0;
    const o = Number(t.outQty) || 0;
    if (a < 0 || o < 0) errors.push({ field: 'qty', msg: 'الكمية لا يمكن أن تكون سالبة' });
    if (a > 0 && o > 0) errors.push({ field: 'qty', msg: 'لا يمكن إدخال إضافة وصرف معًا في نفس الحركة' });
    if (a === 0 && o === 0) errors.push({ field: 'qty', msg: 'يجب إدخال كمية (إضافة أو صرف)' });
    if (!isComboComplete(t.quality, t.gsm, t.size)) {
      errors.push({ field: 'gsm', msg: 'الجرام والمقاس مطلوبان لحساب الرصيد' });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cleanStr(t.date))) {
      errors.push({ field: 'date', msg: 'صيغة التاريخ غير صحيحة' });
    }
    return errors;
  }

  /* ensure the product master contains this combo (auto-register on save) */
  function ensureProduct(t, source) {
    const combo = comboKey(t.quality, t.gsm, t.size);
    return global.DB.getAll('products').then((prods) => {
      const found = prods.find((p) => p.combo === combo);
      if (found) return found;
      const p = {
        quality: cleanStr(t.quality),
        gsm: toNumberOrRaw(t.gsm),
        size: toNumberOrRaw(t.size),
        combo,
        source: source || 'manual',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      return global.DB.add('products', p).then((id) => Object.assign(p, { id }));
    });
  }

  /* ---------- legacy mixed editor (addtx): atomic multi-row movement ----------
     The legacy unified editor used to save its rows one-by-one, so a
     failure mid-loop could leave a PARTIAL movement. All rows now insert
     inside ONE IndexedDB transaction (audit fix V5). */
  function addTransactionGroup(pendingRows) {
    const groupId = cleanStr(pendingRows.groupId) || newGroupId();
    const rows = pendingRows.map((t) => childRowOf(t, groupId));
    const errors = [];
    rows.forEach((r) => errors.push(...validate(r)));
    if (errors.length) return Promise.reject({ type: 'validation', errors });
    return global.DB.atomic(['transactions', 'products', 'audit'], (t) => {
      const txStore = t.objectStore('transactions');
      rows.forEach((r) => txStore.add(r));
      queueProductTopUp(t.objectStore('products'), rows);
      t.objectStore('audit').add({
        entity: 'movement', action: 'add', entityId: null, before: null, after: rows,
        at: new Date().toISOString(),
        details: `حركة مختلطة جديدة (${rows.length} سطر — ذرية)`,
      });
      return { groupId, added: rows.length };
    });
  }

  function addTransaction(t) {
    const errors = validate(t);
    if (errors.length) return Promise.reject({ type: 'validation', errors });
    const row = {
      date: cleanStr(t.date),
      quality: cleanStr(t.quality),
      gsm: toNumberOrRaw(t.gsm),
      size: toNumberOrRaw(t.size),
      customer: cleanStr(t.customer),
      permitNo: cleanStr(t.permitNo),
      addQty: round6(Number(t.addQty) || 0),
      outQty: round6(Number(t.outQty) || 0),
      weight: t.weight === '' || t.weight === null || t.weight === undefined ? null : (Number(t.weight) || null),
      settlement: cleanStr(t.settlement),
      notes: cleanStr(t.notes),
      /* optional movement-group id: children of one multi-size movement share it */
      groupId: cleanStr(t.groupId) || null,
      source: t.source || 'manual',
      excelRow: t.excelRow ?? null,
      fingerprint: fingerprint(t),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    return global.DB.add('transactions', row)
      .then((id) => Promise.all([
        global.DB.logAudit({ entity: 'transaction', action: 'add', entityId: id, before: null, after: row }),
        ensureProduct(row, 'manual'),
      ]).then(() => Object.assign(row, { id })));
  }

  function updateTransaction(id, changes) {
    return global.DB.get('transactions', id).then((before) => {
      if (!before) throw new Error('الحركة غير موجودة');
      const merged = Object.assign({}, before, changes);
      const errors = validate(merged);
      if (errors.length) return Promise.reject({ type: 'validation', errors });
      const after = Object.assign({}, before, {
        date: cleanStr(merged.date),
        quality: cleanStr(merged.quality),
        gsm: toNumberOrRaw(merged.gsm),
        size: toNumberOrRaw(merged.size),
        customer: cleanStr(merged.customer),
        permitNo: cleanStr(merged.permitNo),
        addQty: round6(Number(merged.addQty) || 0),
        outQty: round6(Number(merged.outQty) || 0),
        weight: merged.weight === '' || merged.weight === null || merged.weight === undefined ? null : (Number(merged.weight) || null),
        settlement: cleanStr(merged.settlement),
        notes: cleanStr(merged.notes),
        fingerprint: fingerprint(merged),
        updatedAt: new Date().toISOString(),
      });
      delete after.id;
      return global.DB.put('transactions', Object.assign({ id }, after))
        .then(() => Promise.all([
          global.DB.logAudit({ entity: 'transaction', action: 'edit', entityId: id, before, after }),
          ensureProduct(after, 'manual'),
        ]).then(() => Object.assign(after, { id })));
    });
  }

  function deleteTransaction(id) {
    return global.DB.get('transactions', id).then((before) => {
      if (!before) throw new Error('الحركة غير موجودة');
      return global.DB.del('transactions', id)
        .then(() => global.DB.logAudit({ entity: 'transaction', action: 'delete', entityId: id, before, after: null }));
    });
  }

  /* set settlement status (تصفيه) without touching quantities */
  function setSettlement(id, value) {
    const v = (value === 'غ' || value === 'ض') ? value : '';
    return updateTransaction(id, { settlement: v });
  }

  /* ---------------- movement groups (multi-size movements) ----------------
     A movement = N child transactions sharing groupId. Replace and delete
     run inside ONE IndexedDB transaction (all work happens inside the
     getAll success handler, so the transaction can never auto-commit early
     or leave a movement half-updated). */

  function normalizeRow(t) {
    return {
      date: cleanStr(t.date),
      quality: cleanStr(t.quality),
      gsm: toNumberOrRaw(t.gsm),
      size: toNumberOrRaw(t.size),
      customer: cleanStr(t.customer),
      permitNo: cleanStr(t.permitNo),
      addQty: round6(Number(t.addQty) || 0),
      outQty: round6(Number(t.outQty) || 0),
      weight: t.weight === '' || t.weight === null || t.weight === undefined ? null : (Number(t.weight) || null),
      settlement: cleanStr(t.settlement),
      notes: cleanStr(t.notes),
      groupId: cleanStr(t.groupId) || null,
      source: t.source || 'manual',
      excelRow: t.excelRow ?? null,
      fingerprint: fingerprint(t),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  function childRowOf(t, groupId) {
    const r = normalizeRow(t);
    r.groupId = groupId;
    return r;
  }

  function replaceMovement(existingGroup, pendingRows) {
    if (!existingGroup || !existingGroup.groupId) {
      return Promise.reject(new Error('لا يمكن تعديل حركة قديمة بهذه الطريقة / legacy rows use the simple editor'));
    }
    const groupId = existingGroup.groupId;
    const rows = pendingRows.map((t) => childRowOf(t, groupId));
    const errors = [];
    rows.forEach((r) => errors.push(...validate(r)));
    if (errors.length) return Promise.reject({ type: 'validation', errors });
    return global.DB.open().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(['transactions', 'products', 'audit'], 'readwrite');
      const txStore = t.objectStore('transactions');
      let removed = 0;
      const getAllReq = txStore.getAll();
      getAllReq.onsuccess = () => {
        const children = (getAllReq.result || []).filter((r) => r.groupId === groupId);
        removed = children.length;
        children.forEach((c) => txStore.delete(c.id));
        rows.forEach((r) => txStore.add(r));
        /* product master top-up for any new combo used by the movement */
        const prodStore = t.objectStore('products');
        rows.forEach((r) => {
          const combo = comboKey(r.quality, r.gsm, r.size);
          const g = prodStore.index('combo').get(combo);
          g.onsuccess = () => {
            if (!g.result) {
              prodStore.add({ quality: r.quality, gsm: r.gsm, size: r.size, combo,
                source: 'manual', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
            }
          };
        });
        t.objectStore('audit').add({
          entity: 'movement', action: 'edit', entityId: null,
          before: children, after: rows, at: new Date().toISOString(),
        });
      };
      t.oncomplete = () => resolve({ removed, added: rows.length });
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('transaction aborted'));
    }));
  }

  function deleteMovement(group) {
    if (group.groupId) {
      return global.DB.open().then((db) => new Promise((resolve, reject) => {
        const t = db.transaction(['transactions', 'audit'], 'readwrite');
        const txStore = t.objectStore('transactions');
        let removed = 0;
        const getAllReq = txStore.getAll();
        getAllReq.onsuccess = () => {
          const children = (getAllReq.result || []).filter((r) => r.groupId === group.groupId);
          removed = children.length;
          children.forEach((c) => txStore.delete(c.id));
          t.objectStore('audit').add({
            entity: 'movement', action: 'delete', entityId: null,
            before: children, after: null, at: new Date().toISOString(),
          });
        };
        t.oncomplete = () => resolve({ removed });
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error('transaction aborted'));
      }));
    }
    /* legacy single row */
    return deleteTransaction(group.legacyId);
  }

  /* =======================================================================
     ISSUE DOCUMENTS (أذون الصرف) — independent tax / non-tax numbering,
     duplicate protection, hard availability check and atomic writes.
     A document = a movement group whose rows carry outQty; its snapshot is
     the stored rows themselves, so later inventory changes can never alter
     an already-saved document.
     ======================================================================= */

  /* sequence keys: 'ض' (ضريبي) and 'غ' (غير ضريبي) are fully independent */
  const SEQ_KEYS = { 'ض': 'docSeqTax', 'غ': 'docSeqNontax' };
  const CLS_LABEL = { 'ض': 'ضريبي', 'غ': 'غير ضريبي' };

  function newGroupId() {
    try { return crypto.randomUUID(); } catch (e) {
      return 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }
  }

  /* largest numeric document number already used within one classification */
  function numericDocMax(rows, cls) {
    let max = 0;
    for (const r of rows) {
      if ((Number(r.outQty) || 0) <= 0) continue;
      if ((r.settlement || '') !== cls) continue;
      const n = parseInt(String(r.permitNo || '').trim(), 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
    return max;
  }

  /**
   * Next suggested document number for both classifications.
   * First run: initialized from the actual historical issue documents
   * (max numeric permitNo per classification + 1) and persisted, so
   * refreshing the browser never resets numbering. If history ever grows
   * beyond the stored counter (restore/import), it self-heals upward.
   */
  async function nextDocNumbers() {
    const all = await global.DB.getAll('transactions');
    const out = {};
    for (const cls of ['ض', 'غ']) {
      const key = SEQ_KEYS[cls];
      const stored = await global.DB.getSetting(key, null);
      const histMax = numericDocMax(all, cls);
      const n = Number(stored);
      if (stored === null || stored === undefined || stored === '' || !Number.isFinite(n)) {
        const seq = Math.max(1, histMax + 1);
        await global.DB.setSetting(key, seq);
        out[cls] = seq;
      } else if (histMax + 1 > n) {
        await global.DB.setSetting(key, histMax + 1);
        out[cls] = histMax + 1;
      } else {
        out[cls] = n;
      }
    }
    /* أمين المخزن يرى أذون نافذة اليومين فقط — أعلى رقم في كامل السجل يأتي
       من قاعدة البيانات عبر app_next_permit_no (SECURITY DEFINER) حتى لا
       يقترح رقمًا مستخدمًا بالفعل أسبوعًا سابقًا. الرفض النهائي يبقى محميًا
       بقيود التفرد في السحابة مهما حدث. */
    if (global.PERM && global.PERM.isWarehouse() && global.SB && global.SB.client() && navigator.onLine) {
      try {
        const { data, error } = await global.SB.client().rpc('app_next_permit_no');
        if (!error && data && typeof data === 'object') {
          for (const cls of ['ض', 'غ']) {
            const cloud = Number(cls === 'ض' ? data.tax : data.nontax);
            if (Number.isFinite(cloud) && cloud + 1 > out[cls]) {
              out[cls] = cloud + 1;
              await global.DB.setSetting(SEQ_KEYS[cls], out[cls]);
            }
          }
        }
      } catch (e) { /* بدون شبكة: العداد المحلي كما هو */ }
    }
    return { tax: out['ض'], nontax: out['غ'] };
  }

  /**
   * Availability gate: aggregate demand per (product,gsm,weight,size) bucket
   * must never exceed the stock computed WITHOUT the excluded voucher's rows
   * (so editing a document doesn't collide with its own old rows).
   * `exclude` may be: null · a groupId string · { ids: Set<rowId> } for
   * legacy merged vouchers whose rows carry no shared groupId.
   * Negative stock is prevented — never silently allowed.
   */
  function isExcludedRow(r, exclude) {
    if (!exclude) return false;
    if (typeof exclude === 'string') return r.groupId === exclude;
    if (exclude.groupId && r.groupId === exclude.groupId) return true;
    if (exclude.ids && exclude.ids.has(r.id)) return true;
    return false;
  }

  function checkIssueAvailability(allTx, pendingRows, exclude) {
    const avail = new Map();
    for (const r of allTx) {
      if (isExcludedRow(r, exclude)) continue;
      const k = global.CALC.comboKeyWOf(r);
      avail.set(k, (avail.get(k) || 0) + (Number(r.addQty) || 0) - (Number(r.outQty) || 0));
    }
    const demand = new Map();
    for (const r of pendingRows) {
      const k = global.CALC.comboKeyWOf(r);
      demand.set(k, { qty: (demand.get(k) || { qty: 0 }).qty + (Number(r.outQty) || 0), r });
    }
    const errors = [];
    for (const [k, d] of demand) {
      const free = avail.get(k) || 0;
      if (d.qty - free > 0) {
        const w = d.r.weight == null ? '—' : d.r.weight;
        errors.push({
          field: 'balance',
          msg: `الرصيد لا يكفي: ${d.r.quality} / ${d.r.gsm} جرام / وزن البكرة ${w} / مقاس ${d.r.size} — المتاح ${free} والمطلوب ${d.qty}`,
        });
      }
    }
    return errors;
  }

  /* product-master top-up queued inside an open atomic transaction */
  function queueProductTopUp(prodStore, rows) {
    for (const r of rows) {
      const combo = comboKey(r.quality, r.gsm, r.size);
      const g = prodStore.index('combo').get(combo);
      g.onsuccess = () => {
        if (!g.result) {
          prodStore.add({ quality: r.quality, gsm: r.gsm, size: r.size, combo,
            source: 'manual', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
        }
      };
    }
  }

  function bumpSeqInTx(settingsStore, cls, savedNo) {
    const seqKey = SEQ_KEYS[cls];
    if (!seqKey) return;
    const n = parseInt(String(savedNo || '').trim(), 10);
    if (!Number.isFinite(n) || n < 1) return; /* non-numeric numbers don't move the counter */
    const getReq = settingsStore.get(seqKey);
    getReq.onsuccess = () => {
      const cur = getReq.result ? Number(getReq.result.value) : 1;
      if (n >= cur) settingsStore.put({ key: seqKey, value: n + 1 });
    };
  }

  /* ---------- production save (إضافة إنتاج): one group, atomic ---------- */
  function saveProduction(header, sizes) {
    const groupId = newGroupId();
    const rows = sizes.map((s) => childRowOf({
      date: header.date,
      quality: header.quality,
      gsm: header.gsm,
      size: s.size,
      customer: 'الإنتاج',
      permitNo: '',
      addQty: s.qty,
      outQty: 0,
      weight: header.weight,
      settlement: '',
      notes: header.notes || '',
      source: header.source || 'manual',
    }, groupId));
    const errors = [];
    rows.forEach((r) => errors.push(...validate(r)));
    if (errors.length) return Promise.reject({ type: 'validation', errors });
    return global.DB.atomic(['transactions', 'products', 'audit'], (t) => {
      const txStore = t.objectStore('transactions');
      rows.forEach((r) => txStore.add(r));
      queueProductTopUp(t.objectStore('products'), rows);
      t.objectStore('audit').add({
        entity: 'movement', action: 'add', entityId: null, before: null, after: rows,
        at: new Date().toISOString(),
        details: `إضافة إنتاج: ${rows[0].quality} / ${rows[0].gsm} جرام / وزن ${header.weight} — ${rows.length} مقاس`,
      });
      return { groupId, added: rows.length };
    });
  }

  /* ---------- issue document save (صرف للعملاء): multi-group, atomic ---------- */
  function docRowsOf(doc, groupId) {
    const rows = [];
    for (const g of doc.groups) {
      for (const s of g.sizes) {
        rows.push(childRowOf({
          date: doc.date,
          quality: g.quality,
          gsm: g.gsm,
          size: s.size,
          customer: doc.customer,
          permitNo: doc.docNo,
          addQty: 0,
          outQty: s.qty,
          weight: g.weight,
          settlement: doc.classification,
          notes: doc.notes || '',
          source: doc.source || 'manual',
        }, groupId));
      }
    }
    return rows;
  }

  function saveIssueDocument(doc) {
    const groupId = newGroupId();
    const rows = docRowsOf(doc, groupId);
    const errors = [];
    rows.forEach((r) => errors.push(...validate(r)));
    if (!String(doc.docNo || '').trim()) {
      errors.push({ field: 'docNo', msg: 'رقم إذن الصرف مطلوب' });
    }
    if (!doc.groups || !doc.groups.length) {
      errors.push({ field: 'groups', msg: 'أضف مجموعة واحدة على الأقل' });
    }
    if (['ض', 'غ'].indexOf(doc.classification) < 0) {
      errors.push({ field: 'classification', msg: 'اختر التصنيف (ضريبي / غير ضريبي)' });
    }
    if (errors.length) return Promise.reject({ type: 'validation', errors });
    /* everything (duplicate check + availability + rows + counter + audit)
       happens inside ONE IndexedDB transaction: no partially saved document */
    return global.DB.atomic(['transactions', 'products', 'audit', 'settings'], (t, setFail) => {
      const txStore = t.objectStore('transactions');
      const getAllReq = txStore.getAll();
      getAllReq.onsuccess = () => {
        const all = getAllReq.result || [];
        const docNoNorm = String(doc.docNo).trim();
        const allErrors = [];
        const taken = all.some((r) => (Number(r.outQty) || 0) > 0
          && (r.settlement || '') === doc.classification
          && String(r.permitNo || '').trim() === docNoNorm);
        if (taken) {
          allErrors.push({ field: 'docNo',
            msg: `رقم الإذن "${docNoNorm}" مستخدم مسبقًا في تصنيف ${CLS_LABEL[doc.classification]} — اختر رقمًا آخر` });
        }
        allErrors.push(...checkIssueAvailability(all, rows, null));
        if (allErrors.length) { setFail({ type: 'validation', errors: allErrors }); t.abort(); return; }
        rows.forEach((r) => txStore.add(r));
        queueProductTopUp(t.objectStore('products'), rows);
        bumpSeqInTx(t.objectStore('settings'), doc.classification, docNoNorm);
        t.objectStore('audit').add({
          entity: 'movement', action: 'add', entityId: null, before: null, after: rows,
          at: new Date().toISOString(),
          details: `إذن صرف ${docNoNorm} (${CLS_LABEL[doc.classification]}) — العميل: ${doc.customer} — ${rows.length} مقاس`,
        });
      };
      return { groupId, added: rows.length };
    });
  }

  /* ---------- issue document EDIT: replace atomically with the same gates ---------- */
  function replaceIssueDocument(existingGroup, pendingRows, classification, docNo) {
    if (!existingGroup || !existingGroup.groupId) {
      return Promise.reject(new Error('لا يمكن تعديل حركة قديمة بهذه الطريقة / legacy rows use the simple editor'));
    }
    const groupId = existingGroup.groupId;
    const rows = pendingRows.map((t) => childRowOf(t, groupId));
    const errors = [];
    rows.forEach((r) => errors.push(...validate(r)));
    if (!String(docNo || '').trim()) errors.push({ field: 'docNo', msg: 'رقم إذن الصرف مطلوب' });
    if (['ض', 'غ'].indexOf(classification) < 0) {
      errors.push({ field: 'classification', msg: 'اختر التصنيف (ضريبي / غير ضريبي)' });
    }
    if (errors.length) return Promise.reject({ type: 'validation', errors });
    return global.DB.atomic(['transactions', 'products', 'audit', 'settings'], (t, setFail) => {
      const txStore = t.objectStore('transactions');
      const getAllReq = txStore.getAll();
      getAllReq.onsuccess = () => {
        const all = getAllReq.result || [];
        const children = all.filter((r) => r.groupId === groupId);
        const docNoNorm = String(docNo).trim();
        const allErrors = [];
        const taken = all.some((r) => (Number(r.outQty) || 0) > 0
          && r.groupId !== groupId
          && (r.settlement || '') === classification
          && String(r.permitNo || '').trim() === docNoNorm);
        if (taken) {
          allErrors.push({ field: 'docNo',
            msg: `رقم الإذن "${docNoNorm}" مستخدم مسبقًا في تصنيف ${CLS_LABEL[classification]} — اختر رقمًا آخر` });
        }
        allErrors.push(...checkIssueAvailability(all, rows, groupId));
        if (allErrors.length) { setFail({ type: 'validation', errors: allErrors }); t.abort(); return; }
        children.forEach((c) => txStore.delete(c.id));
        rows.forEach((r) => txStore.add(r));
        queueProductTopUp(t.objectStore('products'), rows);
        bumpSeqInTx(t.objectStore('settings'), classification, docNoNorm);
        t.objectStore('audit').add({
          entity: 'movement', action: 'edit', entityId: null, before: children, after: rows,
          at: new Date().toISOString(),
          details: `تعديل إذن صرف ${docNoNorm} (${CLS_LABEL[classification]}) — ${rows.length} مقاس`,
        });
      };
      return { removed: null, added: rows.length, groupId };
    });
  }

  /* =======================================================================
     ISSUE VOUCHERS (أذون الصرف المجمّعة) — voucher-level edit / delete.
     A voucher is one commercial document: app-saved documents share ONE
     groupId, while legacy (Excel-imported) vouchers are several independent
     rows with the same (permitNo, classification, customer). Both shapes
     are replaced/deleted ATOMICALLY — quantities can never be half-applied,
     and every operation is audited with before/after rows so history stays
     reversible.
     ======================================================================= */

  /**
   * Replace a whole voucher with new rows.
   * - App-saved voucher (groupId): children are re-derived from the groupId,
   *   replaced in place, same groupId preserved.
   * - Legacy merged voucher (no groupId): the exact stored rows
   *   (voucher.rowIds) are deleted and the new rows receive a fresh groupId,
   *   so the voucher becomes a first-class grouped document from now on.
   * Duplicate-number and availability gates exclude the voucher's OWN rows.
   */
  function replaceIssueVoucher(voucher, pendingRows, classification, docNo) {
    if (!voucher) return Promise.reject(new Error('لا يوجد إذن صرف للتعديل'));
    const isGroup = !!voucher.groupId;
    const groupId = isGroup ? voucher.groupId : newGroupId();
    const rows = pendingRows.map((t) => childRowOf(t, groupId));
    const errors = [];
    rows.forEach((r) => errors.push(...validate(r)));
    if (!String(docNo || '').trim()) errors.push({ field: 'docNo', msg: 'رقم إذن الصرف مطلوب' });
    if (['ض', 'غ'].indexOf(classification) < 0) {
      errors.push({ field: 'classification', msg: 'اختر التصنيف (ضريبي / غير ضريبي)' });
    }
    if (errors.length) return Promise.reject({ type: 'validation', errors });
    const excludeIds = isGroup ? null
      : new Set((voucher.rowIds || []).filter((x) => x != null));
    return global.DB.atomic(['transactions', 'products', 'audit', 'settings'], (t, setFail) => {
      const txStore = t.objectStore('transactions');
      const getAllReq = txStore.getAll();
      getAllReq.onsuccess = () => {
        const all = getAllReq.result || [];
        const own = isGroup
          ? (r) => r.groupId === groupId
          : (r) => excludeIds.has(r.id);
        const children = all.filter(own);
        const docNoNorm = String(docNo).trim();
        const allErrors = [];
        /* Duplicate-number gate only applies when the edit CHANGES the
           number or the classification: keeping the voucher's own identity
           cannot create a new conflict, and legacy data may legitimately
           hold the same number for another customer (never mixed by the
           voucher grouping). */
        const keptIdentity = docNoNorm === String(voucher.permitNo || '').trim()
          && classification === voucher.classification;
        if (!keptIdentity) {
          const taken = all.some((r) => (Number(r.outQty) || 0) > 0
            && !own(r)
            && (r.settlement || '') === classification
            && String(r.permitNo || '').trim() === docNoNorm);
          if (taken) {
            allErrors.push({ field: 'docNo',
              msg: `رقم الإذن "${docNoNorm}" مستخدم مسبقًا في تصنيف ${CLS_LABEL[classification]} — اختر رقمًا آخر` });
          }
        }
        allErrors.push(...checkIssueAvailability(all, rows, isGroup ? groupId : { ids: excludeIds }));
        if (allErrors.length) { setFail({ type: 'validation', errors: allErrors }); t.abort(); return; }
        children.forEach((c) => txStore.delete(c.id));
        rows.forEach((r) => txStore.add(r));
        queueProductTopUp(t.objectStore('products'), rows);
        bumpSeqInTx(t.objectStore('settings'), classification, docNoNorm);
        t.objectStore('audit').add({
          entity: 'movement', action: 'edit', entityId: null,
          before: children, after: rows,
          at: new Date().toISOString(),
          details: `تعديل إذن صرف ${docNoNorm} (${CLS_LABEL[classification]}) — ${rows.length} مقاس`,
        });
      };
      return { removed: null, added: rows.length, groupId };
    });
  }

  /**
   * Delete a whole voucher (all its measurement rows) and restore stock.
   * App-saved → children by groupId; legacy merged → by the stored row ids.
   */
  function deleteIssueVoucher(voucher) {
    if (voucher && voucher.groupId) return deleteMovement(voucher);
    if (!voucher || !Array.isArray(voucher.rowIds) || !voucher.rowIds.length) {
      return Promise.reject(new Error('لا توجد أسطر لحذف هذا الإذن'));
    }
    const ids = voucher.rowIds.filter((x) => x != null);
    return global.DB.atomic(['transactions', 'audit'], (t) => {
      const txStore = t.objectStore('transactions');
      const before = [];
      ids.forEach((id) => {
        const g = txStore.get(id);
        g.onsuccess = () => {
          if (g.result) { before.push(g.result); txStore.delete(id); }
        };
      });
      t.objectStore('audit').add({
        entity: 'movement', action: 'delete', entityId: null,
        before, after: null, at: new Date().toISOString(),
        details: voucher.permitNo
          ? `حذف إذن صرف ${voucher.permitNo} (${voucher.customer || ''}) — ${ids.length} مقاس`
          : `حذف حركة صرف — ${ids.length} مقاس`,
      });
      return { removed: ids.length };
    });
  }

  /* =======================================================================
     ROLLS & REELS (الرولات والبكر) — تسجيل البكر هو مصدر الإنتاج الجديد
     =======================================================================
     A roll (رول رئيسي) carries a generated immutable number and N reels
     (بكر). Saving a roll is ONE atomic transaction that inserts the roll,
     every reel (status «متاحة») and one production movement row per reel
     (addQty=1 with the reel's ACTUAL weight in kg) — so the balance, the
     production log and the reports update instantly and can never be
     half-applied. Re-importing / double-submitting cannot duplicate
     anything: the roll number is assigned inside the transaction as
     max(used)+1 and the unique rollNo/rollReel indexes abort any clash. */

  function uuid() {
    try { return crypto.randomUUID(); } catch (e) {
      return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    }
  }

  const REEL_STATUS = { available: 'متاحة', dispatched: 'مصروفة', returned: 'مرجعة للمورد', undefined: 'غير محددة' };

  function validateReelInput(r) {
    const errors = [];
    const no = parseInt(String(r.reelNo), 10);
    if (!Number.isFinite(no) || no < 1) errors.push(`رقم البكرة غير صحيح: "${r.reelNo}"`);
    const size = Number(r.size);
    if (!Number.isFinite(size) || size <= 0) errors.push(`بكرة ${r.reelNo}: المقاس مطلوب وأكبر من صفر`);
    const w = Number(r.weight);
    if (!Number.isFinite(w) || w <= 0) errors.push(`بكرة ${r.reelNo}: الوزن مطلوب وأكبر من صفر`);
    const g = Number(r.gram);
    if (!Number.isFinite(g) || g <= 0) errors.push(`بكرة ${r.reelNo}: الجرام مطلوب وأكبر من صفر`);
    if (!cleanStr(r.quality)) errors.push(`بكرة ${r.reelNo}: الصنف مطلوب`);
    return errors;
  }

  /* Largest roll number already used (rolls store = imported details + new
     registrations). Persisted floor in settings 'rollSeq' keeps numbers
     growing even if rolls are deleted — deleted numbers are never reused. */
  function maxRollNoInTx(rollStore, onDone) {
    const idx = rollStore.index('rollNo');
    const req = idx.openCursor(null, 'prev');
    req.onsuccess = () => {
      const cur = req.result;
      onDone(cur ? Number(cur.key) : 0);
    };
    req.onerror = () => onDone(0);
  }

  async function nextRollNo() {
    const db = await global.DB.open();
    const max = await new Promise((resolve) => {
      const t = db.transaction('rolls', 'readonly');
      maxRollNoInTx(t.objectStore('rolls'), resolve);
    });
    const seq = Number(await global.DB.getSetting('rollSeq', 0)) || 0;
    return Math.max(max + 1, seq || 1);
  }

  /* movement row for one reel (production source = تسجيل البكر) */
  function reelProductionRow(reel, roll, groupId) {
    return {
      date: roll.date,
      quality: cleanStr(reel.quality),
      gsm: toNumberOrRaw(reel.gram),
      size: toNumberOrRaw(reel.size),
      customer: 'الإنتاج',
      permitNo: '',
      addQty: 1,
      outQty: 0,
      weight: Number(reel.weight) || null,
      settlement: '',
      notes: `رول ${roll.rollNo} — بكرة ${reel.reelNo}`,
      groupId,
      rollNo: roll.rollNo,
      reelId: reel.id,
      source: 'reels',
      fingerprint: ['reel', roll.rollNo, reel.reelNo, reel.id].join('||'),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Save a roll + its reels + automatic production movements (one tx).
   * @param {{date, gram, notes, reels: Array}} payload
   * @returns {{rollNo, reels: n, movements: n}}
   */
  function saveRollWithReels(payload) {
    const errors = [];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cleanStr(payload.date))) errors.push('تاريخ الرول مطلوب بصيغة صحيحة');
    if (!payload.reels || !payload.reels.length) errors.push('أضف بكرة واحدة على الأقل قبل الحفظ');
    const seen = new Set();
    for (const r of payload.reels || []) {
      errors.push(...validateReelInput(r));
      const k = String(r.reelNo);
      if (seen.has(k)) errors.push(`رقم البكرة ${r.reelNo} مكرر داخل الرول`);
      seen.add(k);
    }
    if (errors.length) return Promise.reject({ type: 'validation', errors });

    /* -- DB.atomic's workFn is synchronous: the max-rollNo cursor and the
       settings read are consumed via nested onsuccess handlers so every
       next request is queued from inside the previous handler (the
       IndexedDB transaction can never auto-commit mid-flight). -- */
    return global.DB.atomic(['rolls', 'reels', 'transactions', 'products', 'audit', 'settings'], (t) => {
      const rollStore = t.objectStore('rolls');
      const reelStore = t.objectStore('reels');
      const txStore = t.objectStore('transactions');
      const prodStore = t.objectStore('products');
      const settingsStore = t.objectStore('settings');
      let assignedNo = null;
      const createdReelIds = []; /* exposed to the caller: purchase receiving links these ids */
      const fail = (msgs) => { saveRollWithReels._fail = msgs; try { t.abort(); } catch (e2) { /* noop */ } };

      /* 1) next number = max(used)+1 inside this transaction (concurrency-safe) */
      const idx = rollStore.index('rollNo');
      const cur = idx.openCursor(null, 'prev');
      cur.onsuccess = () => {
        const maxNo = cur.result ? Number(cur.result.key) : 0;
        const seqGet = settingsStore.get('rollSeq');
        seqGet.onsuccess = () => {
          const seqFloor = Number(seqGet.result ? seqGet.result.value : 0) || 0;
          assignedNo = Math.max(maxNo + 1, seqFloor || 1);

          /* 2) roll record */
          const grams = [...new Set(payload.reels.map((r) => Number(r.gram)).filter((g) => Number.isFinite(g) && g > 0))];
          const roll = {
            rollNo: assignedNo,
            gram: Number(payload.gram) > 0 ? Number(payload.gram) : (grams.length === 1 ? grams[0] : null),
            date: cleanStr(payload.date),
            notes: cleanStr(payload.notes || ''),
            source: 'reels',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          const addReq = rollStore.add(roll); /* unique rollNo index guards duplicates */
          addReq.onsuccess = () => { roll.id = addReq.result; };

          /* 3) reels (status متاحة) + 4) one production movement per reel */
          const groupId = 'R:roll-' + assignedNo;
          const movRows = [];
          payload.reels.forEach((r, i) => {
            const reel = {
              id: uuid(),
              rollNo: assignedNo,
              reelNo: parseInt(String(r.reelNo), 10),
              size: Number(r.size),
              weight: Number(r.weight),
              gram: Number(r.gram),
              quality: cleanStr(r.quality),
              status: 'available',
              permitRef: null,
              rollReel: assignedNo + '|' + parseInt(String(r.reelNo), 10),
              source: 'reels',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            };
            reelStore.add(reel);
            createdReelIds.push(reel.id);
            const row = reelProductionRow(reel, roll, groupId);
            movRows.push(row);
            txStore.add(row);
            /* product-master top-up */
            const combo = comboKey(reel.quality, reel.gram, reel.size);
            const g = prodStore.index('combo').get(combo);
            g.onsuccess = () => {
              if (!g.result) {
                prodStore.add({ quality: cleanStr(reel.quality), gsm: toNumberOrRaw(reel.gram),
                  size: toNumberOrRaw(reel.size), combo, source: 'reels',
                  createdAt: new Date().toISOString() });
              }
            };
          });

          /* 5) sequence floor + audit */
          settingsStore.put({ key: 'rollSeq', value: assignedNo + 1 });
          t.objectStore('audit').add({
            entity: 'roll', action: 'add', entityId: assignedNo, before: null,
            after: { roll, reels: payload.reels.length, movements: movRows.length },
            at: new Date().toISOString(),
            details: `تسجيل رول ${assignedNo} — ${payload.reels.length} بكرة — إنتاج تلقائي ${movRows.length} حركة`,
          });
        };
      };
      return { getRollNo: () => assignedNo, getReelIds: () => createdReelIds.slice() };
    }).then((res) => ({ rollNo: res.getRollNo(), reels: payload.reels.length, reelIds: res.getReelIds() }));
  }

  /* ---------- reel edit / delete ---------- */
  /* 'products' MUST be in the atomic scope: the product-master top-up below
     touches it — missing it aborted the whole edit (test-caught bug). */
  function updateReel(reelId, changes) {
    return global.DB.atomic(['reels', 'transactions', 'rolls', 'products', 'audit'], (t, setFail) => {
      const reelStore = t.objectStore('reels');
      const g = reelStore.get(reelId);
      g.onsuccess = () => {
        const before = g.result;
        if (!before) { setFail({ type: 'validation', errors: ['البكرة غير موجودة'] }); t.abort(); return; }
        if (before.status === 'dispatched' || before.status === 'returned') {
          setFail({ type: 'validation', errors: [before.status === 'returned'
            ? 'لا يمكن تعديل بكرة مرجعة للمورد — تعديلها يفسد سجل المرتجع. يمكن إلغاء المرتجع أولًا لعودتها للمخزون.'
            : 'لا يمكن تعديل بكرة مصروفة — تعديلها يفسد بيانات الصرف. احذف أو عدّل إذن الصرف أولًا.'] });
          t.abort(); return;
        }
        const merged = Object.assign({}, before, {
          reelNo: changes.reelNo !== undefined ? parseInt(String(changes.reelNo), 10) : before.reelNo,
          size: changes.size !== undefined ? Number(changes.size) : before.size,
          weight: changes.weight !== undefined ? Number(changes.weight) : before.weight,
          gram: changes.gram !== undefined ? Number(changes.gram) : before.gram,
          quality: changes.quality !== undefined ? cleanStr(changes.quality) : before.quality,
          updatedAt: new Date().toISOString(),
        });
        const errs = validateReelInput(merged);
        if (errs.length) { setFail({ type: 'validation', errors: errs }); t.abort(); return; }
        merged.rollReel = merged.rollNo + '|' + merged.reelNo;
        /* uniqueness of (rollNo,reelNo) excluding self */
        const dup = reelStore.index('rollReel').get(merged.rollReel);
        dup.onsuccess = () => {
          if (dup.result && dup.result.id !== reelId) {
            setFail({ type: 'validation', errors: [`رقم البكرة ${merged.reelNo} موجود مسبقًا في الرول ${merged.rollNo}`] });
            t.abort(); return;
          }
          reelStore.put(merged);
          /* keep the linked production movement in sync (available reels only)
             — balance recalculates automatically from the movement rows */
          if (before.source === 'reels') {
            const txStore = t.objectStore('transactions');
            const byReel = txStore.index('reelId').get(reelId);
            byReel.onsuccess = () => {
              const row = byReel.result;
              if (row) {
                const after = Object.assign({}, row, {
                  quality: merged.quality, gsm: toNumberOrRaw(merged.gram),
                  size: toNumberOrRaw(merged.size), weight: Number(merged.weight) || null,
                  notes: `رول ${merged.rollNo} — بكرة ${merged.reelNo}`,
                  fingerprint: ['reel', merged.rollNo, merged.reelNo, reelId].join('||'),
                  updatedAt: new Date().toISOString(),
                });
                txStore.put(after);
                /* product master top-up for the new combo */
                const prodStore = t.objectStore('products');
                const combo = comboKey(merged.quality, merged.gram, merged.size);
                const pg = prodStore.index('combo').get(combo);
                pg.onsuccess = () => {
                  if (!pg.result) prodStore.add({ quality: merged.quality, gsm: toNumberOrRaw(merged.gram),
                    size: toNumberOrRaw(merged.size), combo, source: 'reels', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
                };
              }
            };
          }
          t.objectStore('audit').add({
            entity: 'reel', action: 'edit', entityId: reelId, before, after: merged,
            at: new Date().toISOString(),
            details: `تعديل بكرة ${before.rollNo}/${before.reelNo}`,
          });
        };
      };
      return { ok: true };
    });
  }

  function deleteReel(reelId) {
    return global.DB.atomic(['reels', 'transactions', 'audit'], (t, setFail) => {
      const reelStore = t.objectStore('reels');
      const g = reelStore.get(reelId);
      g.onsuccess = () => {
        const reel = g.result;
        if (!reel) { setFail({ type: 'validation', errors: ['البكرة غير موجودة'] }); t.abort(); return; }
        if (reel.status === 'dispatched' || reel.status === 'returned') {
          setFail({ type: 'validation', errors: [reel.status === 'returned'
            ? 'لا يمكن حذف بكرة مرجعة للمورد — يمكن إلغاء المرتجع أولًا لعودتها للمخزون.'
            : 'لا يمكن حذف بكرة مصروفة — احذف أو عدّل إذن الصرف أولًا.'] });
          t.abort(); return;
        }
        reelStore.delete(reelId);
        if (reel.source === 'reels') {
          const txStore = t.objectStore('transactions');
          const byReel = txStore.index('reelId').get(reelId);
          byReel.onsuccess = () => { if (byReel.result) txStore.delete(byReel.result.id); };
        }
        t.objectStore('audit').add({
          entity: 'reel', action: 'delete', entityId: reelId, before: reel, after: null,
          at: new Date().toISOString(),
          details: `حذف بكرة ${reel.rollNo}/${reel.reelNo}`,
        });
      };
      return { ok: true };
    });
  }

  function deleteRoll(rollNo) {
    return global.DB.atomic(['rolls', 'reels', 'transactions', 'audit'], (t, setFail) => {
      const reelStore = t.objectStore('reels');
      const rollStore = t.objectStore('rolls');
      const byRoll = reelStore.index('rollNo').getAll(rollNo);
      byRoll.onsuccess = () => {
        const reels = byRoll.result || [];
        const locked = reels.filter((r) => r.status === 'dispatched' || r.status === 'returned');
        if (locked.length) {
          setFail({ type: 'validation', errors: [`لا يمكن حذف الرول ${rollNo}: ${locked.length} بكرة مرتبطة بأذون صرف أو مرتجعات موردين.`] });
          t.abort(); return;
        }
        const rollGet = rollStore.index('rollNo').get(rollNo);
        rollGet.onsuccess = () => {
          if (rollGet.result) rollStore.delete(rollGet.result.id);
          const txStore = t.objectStore('transactions');
          reels.forEach((r) => {
            reelStore.delete(r.id);
            if (r.source === 'reels') {
              const byReel = txStore.index('reelId').get(r.id);
              byReel.onsuccess = () => { if (byReel.result) txStore.delete(byReel.result.id); };
            }
          });
          t.objectStore('audit').add({
            entity: 'roll', action: 'delete', entityId: rollNo,
            before: { rollNo, reels: reels.length }, after: null,
            at: new Date().toISOString(),
            details: `حذف رول ${rollNo} بـ ${reels.length} بكرة`,
          });
        };
      };
      return { ok: true };
    });
  }

  /* bulk import of historical rolls/reels (details only — no movements) */
  function importRolls(rolls, meta) {
    const errors = [];
    const seenRoll = new Set(), seenReel = new Set();
    for (const roll of rolls) {
      if (!Number.isFinite(Number(roll.rollNo))) errors.push('رقم رول غير صحيح في البيانات المستوردة');
      if (seenRoll.has(roll.rollNo)) errors.push(`رول مكرر داخل الملف: ${roll.rollNo}`);
      seenRoll.add(roll.rollNo);
      for (const r of roll.reels || []) {
        const k = roll.rollNo + '|' + r.reelNo;
        if (seenReel.has(k)) errors.push(`بكرة مكررة داخل الملف: ${k}`);
        seenReel.add(k);
      }
    }
    if (errors.length) return Promise.reject({ type: 'validation', errors: errors.slice(0, 20) });
    let maxNo = 0;
    const rollRows = [], reelRows = [];
    for (const roll of rolls) {
      if (Number(roll.rollNo) > maxNo) maxNo = Number(roll.rollNo);
      rollRows.push({
        rollNo: Number(roll.rollNo),
        gram: Number(roll.gram) > 0 ? Number(roll.gram) : null,
        date: cleanStr(roll.date),
        notes: '',
        source: 'excel',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      for (const r of roll.reels || []) {
        reelRows.push({
          id: uuid(),
          rollNo: Number(roll.rollNo),
          reelNo: parseInt(String(r.reelNo), 10),
          size: Number(r.size) > 0 ? Number(r.size) : null,
          weight: Number(r.weight) > 0 ? Number(r.weight) : null,
          gram: Number(r.gram) > 0 ? Number(r.gram) : null,
          quality: cleanStr(r.quality),
          status: 'undefined', /* تاريخية: لا تُحسب في الرصيد */
          permitRef: null,
          rollReel: Number(roll.rollNo) + '|' + parseInt(String(r.reelNo), 10),
          source: 'excel',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }
    }
    return global.DB.atomic(['rolls', 'reels', 'settings', 'audit'], (t, setFail) => {
      const rollStore = t.objectStore('rolls');
      const reelStore = t.objectStore('reels');
      const settingsStore = t.objectStore('settings');
      let skipped = 0;
      rollRows.forEach((r) => {
        const dup = rollStore.index('rollNo').get(r.rollNo);
        dup.onsuccess = () => { if (dup.result) skipped++; else rollStore.add(r); };
      });
      reelRows.forEach((r) => {
        const dup = reelStore.index('rollReel').get(r.rollReel);
        dup.onsuccess = () => { if (!dup.result) reelStore.add(r); };
      });
      const seqGet = settingsStore.get('rollSeq');
      seqGet.onsuccess = () => {
        const cur = Number(seqGet.result ? seqGet.result.value : 0) || 0;
        if (maxNo + 1 > cur) settingsStore.put({ key: 'rollSeq', value: maxNo + 1 });
      };
      t.objectStore('audit').add({
        entity: 'roll', action: 'import', entityId: null,
        before: null, after: { rolls: rollRows.length, reels: reelRows.length },
        at: new Date().toISOString(),
        details: `استيراد تفاصيل الرولات: ${rollRows.length} رول، ${reelRows.length} بكرة (غير محددة — لا تدخل الرصيد)${meta ? ' — ' + meta : ''}`,
      });
      return { rolls: rollRows.length, reels: reelRows.length, skipped };
    });
  }

  /* =======================================================================
     PERMITS (أذون الصرف) — draft → approved with reel-level tracking
     =======================================================================
     A permit is a first-class document (رقم، نوع ضريبي/غير ضريبي مستقل،
     عميل، تاريخ، أسطر، ملاحظات، حالة). Saving a draft never touches stock;
     APPROVING runs inside one atomic transaction: availability gate,
     duplicate-number gate, per-reel availability (منع صرف بكرة مرتين),
     movement rows with groupId 'P:<permitId>', reel status flip to
     «مصروفة», sequence bump and audit — all or nothing. */

  const PERMIT_GROUP_PREFIX = 'P:';

  function permitLinesToRows(permit, reelWeightOf) {
    const rows = [];
    for (const line of permit.lines || []) {
      let weight = null;
      if (Array.isArray(line.reelIds) && line.reelIds.length) {
        weight = line.reelIds.reduce((s, id) => s + (reelWeightOf(id) || 0), 0);
        weight = global.CALC.round6(weight);
      } else if (line.weight != null && Number(line.weight) > 0) {
        weight = Number(line.weight);
      }
      rows.push({
        date: cleanStr(permit.date),
        quality: cleanStr(line.quality),
        gsm: toNumberOrRaw(line.gsm),
        size: toNumberOrRaw(line.size),
        customer: cleanStr(permit.customer),
        permitNo: cleanStr(permit.permitNo),
        addQty: 0,
        outQty: Number(line.qty) || 0,
        weight,
        settlement: permit.cls,
        notes: cleanStr(permit.notes || ''),
        groupId: PERMIT_GROUP_PREFIX + permit.id,
        permitId: permit.id,
        source: permit.source || 'permit',
        fingerprint: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
    return rows;
  }

  function validatePermit(p) {
    const errors = [];
    if (!cleanStr(p.permitNo)) errors.push('رقم الإذن مطلوب');
    if (['ض', 'غ'].indexOf(p.cls) < 0) errors.push('اختر نوع الإذن (ضريبي / غير ضريبي)');
    if (!cleanStr(p.customer)) errors.push('اسم العميل مطلوب');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cleanStr(p.date))) errors.push('التاريخ مطلوب بصيغة صحيحة');
    if (!p.lines || !p.lines.length) errors.push('أضف سطرًا واحدًا على الأقل لتفاصيل الصرف');
    for (const l of p.lines || []) {
      if (!cleanStr(l.quality)) errors.push('الصنف مطلوب في كل سطر');
      if (!(Number(l.gsm) > 0)) errors.push(`الجرام مطلوب في سطر ${l.size || '—'}`);
      if (!(Number(l.size) > 0)) errors.push('المقاس مطلوب في كل سطر');
      if (!(Number(l.qty) > 0)) errors.push(`العدد يجب أن يكون أكبر من صفر في المقاس ${l.size || '—'}`);
      if (Array.isArray(l.reelIds) && l.reelIds.length && l.reelIds.length !== Number(l.qty)) {
        errors.push(`المقاس ${l.size}: العدد يجب أن يساوي عدد البكر المحددة (${l.reelIds.length})`);
      }
    }
    return errors;
  }

  function permitKeyOf(p) {
    return cleanStr(p.cls) + '|' + cleanStr(p.permitNo);
  }

  /* 3-dim availability gate (same engine as the balance report the user
     sees — quantity per product/gsm/size). `excludeGroupId` removes the
     permit's own old rows when re-approving an edit. */
  function checkAvailability3D(allTx, pendingRows, excludeGroupId) {
    const avail = new Map();
    for (const r of allTx) {
      if (excludeGroupId && r.groupId === excludeGroupId) continue;
      const k = global.CALC.comboKeyOf(r);
      avail.set(k, (avail.get(k) || 0) + (Number(r.addQty) || 0) - (Number(r.outQty) || 0));
    }
    const errors = [];
    for (const row of pendingRows) {
      const k = global.CALC.comboKeyOf(row);
      const free = avail.get(k) || 0;
      const need = Number(row.outQty) || 0;
      if (need - free > 0) {
        errors.push(`الرصيد لا يكفي: ${row.quality} / ${row.gsm} جرام / مقاس ${row.size} — المتاح ${free} والمطلوب ${need}`);
      }
    }
    return errors;
  }

  /* numbers already approved at some point (persisted) — never reused
     silently even after the voucher is deleted */
  async function getUsedDocNos() {
    const v = await global.DB.getSetting('usedDocNos', []);
    return new Set(Array.isArray(v) ? v : []);
  }
  async function rememberUsedDocNo(cls, no) {
    const n = parseInt(String(no).trim(), 10);
    if (!Number.isFinite(n)) return;
    const set = await getUsedDocNos();
    const k = cls + '|' + n;
    if (set.has(k)) return;
    set.add(k);
    await global.DB.setSetting('usedDocNos', [...set].slice(-5000));
  }

  /**
   * Shared approval core (used by approve & replace-approved).
   * MUST run inside DB.atomic over [permits, transactions, products, reels,
   * audit, settings] with `allRows` already fetched. Every next IndexedDB
   * request is queued from inside the previous request's onsuccess handler
   * (no timers, no promise gaps) so the transaction can never auto-commit
   * mid-flight.
   */
  function approveCore(t, permit, allRows, setFail, opts) {
    const permitStore = t.objectStore('permits');
    const txStore = t.objectStore('transactions');
    const reelStore = t.objectStore('reels');
    const prodStore = t.objectStore('products');
    const settingsStore = t.objectStore('settings');
    const errors = [];
    const noNorm = cleanStr(permit.permitNo);
    const ownGroupId = permit.groupId || null;

    /* queue ALL reads synchronously: duplicate-permit lookup + every reel */
    const reelIds = new Set();
    for (const line of permit.lines || []) {
      for (const id of (line.reelIds || [])) reelIds.add(id);
    }
    const reelGets = new Map();
    for (const id of reelIds) reelGets.set(id, reelStore.get(id));
    const pkGet = permitStore.index('permitKey').get(permitKeyOf(permit));

    let pending = reelGets.size + 1;
    const step = () => { if (--pending > 0) return; finish(); };
    for (const [, req] of reelGets) req.onsuccess = step;
    if (reelGets.size === 0) { /* pkGet still counted */ }
    pkGet.onsuccess = step;

    function finish() {
      /* ---- 1) duplicate-number gates ---- */
      const taken = allRows.some((r) => (Number(r.outQty) || 0) > 0
        && (!ownGroupId || r.groupId !== ownGroupId)
        && (r.settlement || '') === permit.cls
        && String(r.permitNo || '').trim() === noNorm);
      const dupPermit = pkGet.result;
      if (dupPermit && dupPermit.id !== permit.id && dupPermit.status === 'approved') {
        errors.push(`رقم الإذن "${noNorm}" معتمد مسبقًا في التسلسل ${permit.cls === 'ض' ? 'الضريبي' : 'غير الضريبي'} — اختر رقمًا آخر`);
      }
      if (taken) {
        errors.push(`رقم الإذن "${noNorm}" مستخدم مسبقًا في ${permit.cls === 'ض' ? 'الضريبي' : 'غير الضريبي'} — اختر رقمًا آخر`);
      }
      /* ---- 2) reel-level gate: منع صرف بكرة مرتين ---- */
      for (const line of permit.lines || []) {
        for (const id of (line.reelIds || [])) {
          const reel = reelGets.get(id).result;
          if (!reel) {
            errors.push('بكرة محددة غير موجودة في المخزون — أعد تحديد البكر من القائمة');
          } else if (reel.status === 'dispatched') {
            /* fixing the v7 regression caught by tests: re-approving an
               edited permit keeps its own reels — allowed whenever the reel
               is dispatched BY THIS SAME permit (permitRef), with or
               without the legacy groupId */
            if (!(reel.permitRef && reel.permitRef.permitId === permit.id)) {
              errors.push(`البكرة ${reel.rollNo}/${reel.reelNo} مصروفة بالفعل — لا يمكن صرفها مرتين`);
            }
          } else if (reel.status === 'returned') {
            errors.push(`البكرة ${reel.rollNo}/${reel.reelNo} مرجعة للمورد — لا يمكن صرفها. ألغِ المرتجع أولًا لعودتها للمخزون.`);
          } else if (reel.status !== 'available') {
            errors.push(`البكرة ${reel.rollNo}/${reel.reelNo} حالتها «غير محددة» (بكرة تاريخية مستوردة) — لا يمكن صرفها بالتتبع الفردي`);
          }
        }
      }
      if (errors.length) { setFail({ type: 'validation', errors }); t.abort(); return; }

      /* ---- 3) movement rows: weight = actual reel weights when selected ---- */
      const rows = permitLinesToRows(permit, (id) => {
        const reel = reelGets.get(id);
        return reel && reel.result ? (Number(reel.result.weight) || 0) : 0;
      });
      /* ---- 4) 3-dim availability gate (matches the balance report) ---- */
      errors.push(...checkAvailability3D(allRows, rows, ownGroupId));
      if (errors.length) { setFail({ type: 'validation', errors }); t.abort(); return; }

      /* ---- 5) free reels no longer selected (re-approval of an edit) ---- */
      const oldReelIds = (opts && opts.oldReelIds) || [];
      const newReelIds = new Set(reelIds);
      for (const oldId of oldReelIds) {
        if (newReelIds.has(oldId)) continue;
        const g = reelStore.get(oldId);
        g.onsuccess = () => {
          if (g.result && g.result.status === 'dispatched'
            && g.result.permitRef && g.result.permitRef.permitId === permit.id) {
            reelStore.put(Object.assign({}, g.result, { status: 'available', permitRef: null, updatedAt: new Date().toISOString() }));
          }
        };
      }
      /* ---- 6) dispatch the selected reels ---- */
      for (const id of newReelIds) {
        const g = reelGets.get(id);
        const reel = g.result;
        reelStore.put(Object.assign({}, reel, {
          status: 'dispatched',
          permitRef: { permitId: permit.id, permitNo: noNorm, cls: permit.cls, customer: permit.customer, date: permit.date },
          updatedAt: new Date().toISOString(),
        }));
      }
      /* ---- 7) movement rows + master + counter + snapshot + audit ---- */
      rows.forEach((r) => {
        r.fingerprint = 'permit|' + permit.id + '|' + r.quality + '|' + r.gsm + '|' + r.size;
        txStore.add(r);
      });
      queueProductTopUp(prodStore, rows);
      bumpSeqInTx(settingsStore, permit.cls, noNorm);
      permit.status = 'approved';
      permit.groupId = PERMIT_GROUP_PREFIX + permit.id;
      permit.approvedAt = new Date().toISOString();
      permit.totals = {
        rolls: rows.reduce((s, r) => s + (Number(r.outQty) || 0), 0),
        weightKg: global.CALC.round6(rows.reduce((s, r) => s + (Number(r.weight) || 0), 0)),
        weightEstimated: rows.every((r) => r.weight == null),
      };
      permitStore.put(permit);
      t.objectStore('audit').add({
        entity: 'permit', action: 'approve', entityId: permit.id,
        before: null, after: { permitNo: noNorm, cls: permit.cls, customer: permit.customer, totals: permit.totals },
        at: new Date().toISOString(),
        details: `اعتماد إذن صرف ${noNorm} (${permit.cls === 'ض' ? 'ضريبي' : 'غير ضريبي'}) — ${permit.customer} — ${permit.totals.rolls} بكرة`,
      });
      rememberUsedDocNo(permit.cls, noNorm); /* fire-and-forget (separate tx) */
    }
  }

  /* ---------- save draft (no stock effect) ---------- */
  /* يقبل الحقل باسمي permitNo (API) أو docNo (نموذج الواجهة) */
  function normPermitInput(input) {
    return Object.assign({}, input, { permitNo: cleanStr(input.permitNo != null ? input.permitNo : input.docNo) });
  }

  async function savePermitDraft(input0) {
    const input = normPermitInput(input0);
    const permit = {
      id: uuid(),
      permitNo: cleanStr(input.permitNo),
      cls: input.cls,
      customer: cleanStr(input.customer),
      date: cleanStr(input.date),
      notes: cleanStr(input.notes || ''),
      status: 'draft',
      lines: input.lines || [],
      groupId: null,
      source: input.source || 'permit',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      approvedAt: null,
    };
    const errors = validatePermit(permit);
    if (errors.length) return Promise.reject({ type: 'validation', errors });
    /* duplicate-number check against permits + stored movements */
    const [permits, txRows] = await Promise.all([
      global.DB.getAll('permits'), global.DB.getAll('transactions'),
    ]);
    const clashPermit = permits.find((p) => p.id !== permit.id && permitKeyOf(p) === permitKeyOf(permit));
    if (clashPermit) {
      return Promise.reject({ type: 'validation', errors: [`رقم الإذن "${permit.permitNo}" مستخدم في تسلسل ${permit.cls === 'ض' ? 'الضريبي' : 'غير الضريبي'} (إذن ${clashPermit.status === 'approved' ? 'معتمد' : 'مسودة'} للعميل ${clashPermit.customer})`] });
    }
    const clashTx = txRows.some((r) => (Number(r.outQty) || 0) > 0 && (r.settlement || '') === permit.cls
      && String(r.permitNo || '').trim() === permit.permitNo);
    if (clashTx) {
      return Promise.reject({ type: 'validation', errors: [`رقم الإذن "${permit.permitNo}" مستخدم مسبقًا في ${permit.cls === 'ض' ? 'الضريبي' : 'غير الضريبي'} (حركات محفوظة)`] });
    }
    permit.permitKey = permitKeyOf(permit);
    await global.DB.put('permits', permit);
    await global.DB.logAudit({ entity: 'permit', action: 'draft', entityId: permit.id, before: null,
      after: { permitNo: permit.permitNo, cls: permit.cls, customer: permit.customer },
      details: `حفظ مسودة إذن صرف ${permit.permitNo} — لا خصم من الرصيد قبل الاعتماد` });
    return permit;
  }

  async function updatePermitDraft(permitId, input0) {
    const input = normPermitInput(input0);
    const before = await global.DB.get('permits', permitId);
    if (!before) return Promise.reject(new Error('الإذن غير موجود'));
    if (before.status !== 'draft') {
      return Promise.reject({ type: 'validation', errors: ['هذا الإذن معتمد — استخدم «تعديل إذن معتمد» لتعديله بأثر على الرصيد.'] });
    }
    const merged = Object.assign({}, before, {
      permitNo: cleanStr(input.permitNo),
      cls: input.cls,
      customer: cleanStr(input.customer),
      date: cleanStr(input.date),
      notes: cleanStr(input.notes || ''),
      lines: input.lines || [],
    });
    const errors = validatePermit(merged);
    if (errors.length) return Promise.reject({ type: 'validation', errors });
    const [permits, txRows] = await Promise.all([
      global.DB.getAll('permits'), global.DB.getAll('transactions'),
    ]);
    const clashPermit = permits.find((p) => p.id !== permitId && permitKeyOf(p) === permitKeyOf(merged));
    if (clashPermit) {
      return Promise.reject({ type: 'validation', errors: [`رقم الإذن "${merged.permitNo}" مستخدم في تسلسل ${merged.cls === 'ض' ? 'الضريبي' : 'غير الضريبي'} للعميل ${clashPermit.customer}`] });
    }
    const clashTx = txRows.some((r) => (Number(r.outQty) || 0) > 0 && (r.settlement || '') === merged.cls
      && String(r.permitNo || '').trim() === merged.permitNo);
    if (clashTx) {
      return Promise.reject({ type: 'validation', errors: [`رقم الإذن "${merged.permitNo}" مستخدم مسبقًا في ${merged.cls === 'ض' ? 'الضريبي' : 'غير الضريبي'} (حركات محفوظة)`] });
    }
    merged.permitKey = permitKeyOf(merged);
    merged.updatedAt = new Date().toISOString();
    await global.DB.put('permits', merged);
    await global.DB.logAudit({ entity: 'permit', action: 'edit-draft', entityId: permitId, before, after: merged,
      details: `تعديل مسودة إذن ${merged.permitNo}` });
    return merged;
  }

  /* ---------- approve: deduct + flip reels (one atomic tx) ---------- */
  function approvePermit(permitId) {
    return global.DB.atomic(['permits', 'transactions', 'products', 'reels', 'audit', 'settings'], (t, setFail) => {
      const g = t.objectStore('permits').get(permitId);
      g.onsuccess = () => {
        const permit = g.result;
        if (!permit) { setFail(new Error('الإذن غير موجود')); t.abort(); return; }
        if (permit.status !== 'draft') {
          setFail({ type: 'validation', errors: ['الإذن معتمد بالفعل — لا يُخصم مرتين.'] });
          t.abort(); return;
        }
        const errors = validatePermit(permit);
        if (errors.length) { setFail({ type: 'validation', errors }); t.abort(); return; }
        const allGet = t.objectStore('transactions').getAll();
        allGet.onsuccess = () => {
          approveCore(t, permit, allGet.result || [], setFail, { oldReelIds: [] });
        };
      };
      return { ok: true };
    }).then(() => global.DB.get('permits', permitId));
  }

  /* ---------- replace (draft update / approved re-deduct) ---------- */
  function replacePermit(permitId, input0) {
    const input = normPermitInput(input0);
    return global.DB.atomic(['permits', 'transactions', 'products', 'reels', 'audit', 'settings'], (t, setFail) => {
      const g = t.objectStore('permits').get(permitId);
      g.onsuccess = () => {
        const before = g.result;
        if (!before) { setFail(new Error('الإذن غير موجود')); t.abort(); return; }
        const merged = Object.assign({}, before, {
          permitNo: cleanStr(input.permitNo),
          cls: input.cls,
          customer: cleanStr(input.customer),
          date: cleanStr(input.date),
          notes: cleanStr(input.notes || ''),
          lines: input.lines || [],
        });
        const errors = validatePermit(merged);
        if (errors.length) { setFail({ type: 'validation', errors }); t.abort(); return; }
        if (before.status === 'draft') {
          const txStore = t.objectStore('transactions');
          const allGet = txStore.getAll();
          allGet.onsuccess = () => {
            const all = allGet.result || [];
            const clashes = [];
            const clashPermitKey = all.some((r) => (Number(r.outQty) || 0) > 0 && (r.settlement || '') === merged.cls
              && String(r.permitNo || '').trim() === merged.permitNo);
            const permitStore = t.objectStore('permits');
            const pkGet = permitStore.index('permitKey').get(permitKeyOf(merged));
            pkGet.onsuccess = () => {
              const pk = pkGet.result;
              if (pk && pk.id !== permitId) clashes.push(`رقم الإذن "${merged.permitNo}" مستخدم للعميل ${pk.customer}`);
              if (clashPermitKey) clashes.push(`رقم الإذن "${merged.permitNo}" مستخدم مسبقًا في ${merged.cls === 'ض' ? 'الضريبي' : 'غير الضريبي'} (حركات محفوظة)`);
              if (clashes.length) { setFail({ type: 'validation', errors: clashes }); t.abort(); return; }
              merged.permitKey = permitKeyOf(merged);
              merged.updatedAt = new Date().toISOString();
              permitStore.put(merged);
              t.objectStore('audit').add({ entity: 'permit', action: 'edit-draft', entityId: permitId,
                before, after: merged, at: new Date().toISOString(), details: `تعديل مسودة إذن ${merged.permitNo}` });
            };
          };
          return;
        }
        /* approved: re-run full gates, free old reels, re-deduct */
        const errors2 = [];
        const txStore = t.objectStore('transactions');
        const allGet = txStore.getAll();
        allGet.onsuccess = () => {
          const all = allGet.result || [];
          /* collect old reel ids from permit lines (before overwrite) */
          const oldReelIds = [];
          for (const l of before.lines || []) for (const id of (l.reelIds || [])) oldReelIds.push(id);
          const keptIdentity = cleanStr(merged.permitNo) === cleanStr(before.permitNo) && merged.cls === before.cls;
          if (!keptIdentity) {
            const permitStore = t.objectStore('permits');
            const pkGet = permitStore.index('permitKey').get(permitKeyOf(merged));
            pkGet.onsuccess = () => {
              const pk = pkGet.result;
              if (pk && pk.id !== permitId && pk.status === 'approved') {
                errors2.push(`رقم الإذن "${merged.permitNo}" معتمد مسبقًا للعميل ${pk.customer}`);
              }
              const taken = all.some((r) => (Number(r.outQty) || 0) > 0 && r.groupId !== before.groupId
                && (r.settlement || '') === merged.cls
                && String(r.permitNo || '').trim() === merged.permitNo);
              if (taken) errors2.push(`رقم الإذن "${merged.permitNo}" مستخدم مسبقًا في ${merged.cls === 'ض' ? 'الضريبي' : 'غير الضريبي'}`);
              if (errors2.length) { setFail({ type: 'validation', errors: errors2 }); t.abort(); return; }
              /* delete old movement rows, free old reels */
              const oldRows = all.filter((r) => r.groupId === before.groupId);
              oldRows.forEach((r) => txStore.delete(r.id));
              merged.permitKey = permitKeyOf(merged);
              merged.status = 'draft'; /* re-approved below by approveCore */
              merged.groupId = null;
              merged.approvedAt = null;
              merged.updatedAt = new Date().toISOString();
              t.objectStore('permits').put(merged);
              approveCore(t, merged, all.filter((r) => r.groupId !== before.groupId), setFail, { oldReelIds });
              t.objectStore('audit').add({ entity: 'permit', action: 'edit', entityId: permitId,
                before, after: merged, at: new Date().toISOString(), details: `تعديل إذن معتمد ${merged.permitNo} وإعادة احتساب الصرف` });
            };
          } else {
            const oldRows = all.filter((r) => r.groupId === before.groupId);
            oldRows.forEach((r) => txStore.delete(r.id));
            merged.permitKey = permitKeyOf(merged);
            merged.status = 'draft';
            merged.groupId = null;
            merged.approvedAt = null;
            merged.updatedAt = new Date().toISOString();
            t.objectStore('permits').put(merged);
            approveCore(t, merged, all.filter((r) => r.groupId !== before.groupId), setFail, { oldReelIds });
            t.objectStore('audit').add({ entity: 'permit', action: 'edit', entityId: permitId,
              before, after: merged, at: new Date().toISOString(), details: `تعديل إذن معتمد ${merged.permitNo} وإعادة احتساب الصرف` });
          }
        };
      };
      return { ok: true };
    }).then(() => global.DB.get('permits', permitId));
  }

  /* ---------- delete permit (restore stock + reels) ---------- */
  function deletePermit(permitId) {
    return global.DB.atomic(['permits', 'transactions', 'reels', 'audit'], (t, setFail) => {
      const g = t.objectStore('permits').get(permitId);
      g.onsuccess = () => {
        const permit = g.result;
        if (!permit) { setFail(new Error('الإذن غير موجود')); t.abort(); return; }
        const reelStore = t.objectStore('reels');
        if (permit.status === 'approved' && permit.groupId) {
          const txStore = t.objectStore('transactions');
          const byGroup = txStore.index('groupId').getAll(permit.groupId);
          byGroup.onsuccess = () => {
            const rows = byGroup.result || [];
            rows.forEach((r) => txStore.delete(r.id));
            /* free reels referenced by the permit */
            const reelIds = [];
            for (const l of permit.lines || []) for (const id of (l.reelIds || [])) reelIds.push(id);
            reelIds.forEach((id) => {
              const rg = reelStore.get(id);
              rg.onsuccess = () => {
                if (rg.result && rg.result.status === 'dispatched'
                  && (!rg.result.permitRef || rg.result.permitRef.permitId === permitId)) {
                  reelStore.put(Object.assign({}, rg.result, { status: 'available', permitRef: null, updatedAt: new Date().toISOString() }));
                }
              };
            });
            t.objectStore('permits').delete(permitId);
            t.objectStore('audit').add({ entity: 'permit', action: 'delete', entityId: permitId,
              before: permit, after: null, at: new Date().toISOString(),
              details: `حذف إذن صرف ${permit.permitNo} (${permit.cls === 'ض' ? 'ضريبي' : 'غير ضريبي'}) — ${permit.customer} — عودة الكميات والبكر للرصيد` });
          };
        } else {
          t.objectStore('permits').delete(permitId);
          t.objectStore('audit').add({ entity: 'permit', action: 'delete', entityId: permitId,
            before: permit, after: null, at: new Date().toISOString(),
            details: `حذف مسودة إذن ${permit.permitNo} — لم يكن له أثر على الرصيد` });
        }
      };
      return { ok: true };
    });
  }

  /* find available reels for the issue form's reel picker */
  async function findAvailableReels(quality, gsm, size) {
    const all = await global.DB.getAll('reels');
    const q = cleanStr(quality);
    const g = Number(gsm), s = Number(size);
    return all
      .filter((r) => r.status === 'available'
        && cleanStr(r.quality) === q && Number(r.gram) === g && Number(r.size) === s)
      .sort((a, b) => (a.rollNo - b.rollNo) || (a.reelNo - b.reelNo));
  }

  global.TX = { fingerprint, validate, addTransaction, addTransactionGroup, updateTransaction, deleteTransaction,
    setSettlement, ensureProduct, replaceMovement, deleteMovement,
    nextDocNumbers, checkIssueAvailability, saveProduction, saveIssueDocument,
    replaceIssueDocument, replaceIssueVoucher, deleteIssueVoucher, CLS_LABEL, SEQ_KEYS,
    /* rolls & reels */
    REEL_STATUS, nextRollNo, saveRollWithReels, updateReel, deleteReel, deleteRoll,
    importRolls, findAvailableReels,
    /* permits */
    savePermitDraft, updatePermitDraft, approvePermit, replacePermit, deletePermit,
    permitLinesToRows, validatePermit, getUsedDocNos, PERMIT_GROUP_PREFIX };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.TX;
  }
})(typeof window !== 'undefined' ? window : globalThis);
