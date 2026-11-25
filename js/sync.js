/* =========================================================================
   sync.js — المزامنة الآمنة مع Supabase (محلي أولًا — Local-first)
   -------------------------------------------------------------------------
   المبادئ الصارمة (حماية البيانات أولاً):
   1) IndexedDB يبقى المصدر والعمل دون إنترنت — المزامنة طبقة نقل فقط.
   2) كل سجل له معرف ثابت فريد sid (UUID) يطابق عمود sid في Supabase —
      أساس منع التكرار نهائيًا.
   3) قاعدة التعارض: لا يُكتب فوق سجل أحدث بسجل أقدم مطلقًا.
      - سجل محلي أحدث → يفوز المحلي ويُرفع (دفع لاحق).
      - سجل سحابي أحدث وسجل محلي غير مُعدَّل محليًا → يُقبل السحابي.
      - سجل محلي مُعدَّل ولم يُرفع → المحلي يفوز ويُسجَّل تعارض في sync_logs.
   4) الحذف ينتقل بعظام قبر (tombstones) — لا حذف صامت ولا بيانات تعود
      (resurrect) بعد المزامنة.
   5) عمليات المسح الشامل (wipe) تُسجّل عظام قبر لكل ما حُذف قبل المسح —
      فلا تعود السجلات الممسوحة من السحابة.
   6) أمين المخزن: يرى رصيدًا تجميديًا وأذون نافذة اليومين عبر RLS ووظائف
      SECURITY DEFINER فقط — يرفع أذون الصرف التي أنشأها محليًا (داخل
      النافذة) ولا يرفع أي بيانات أخرى إلى السحابة مطلقًا.
   7) كل جلسة مزامنة تُسجَّل في sync_logs (نجاح/فشل/أعداد/أخطاء).
   8) أي فشل شبكة لا يمس البيانات المحلية — المحاولة القادمة تعيد ما فشل.
   ========================================================================= */
(function (global) {
  'use strict';

  const SB = global.SB, PERM = global.PERM, UI = global.UI;
  const uuid = () => {
    try { return crypto.randomUUID(); } catch (e) {
      return 'sid-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    }
  };
  const r6 = (n) => Math.round(Number(n || 0) * 1e6) / 1e6;
  const nowISO = () => new Date().toISOString();

  /* ---------------- خريطة المتاجر ↔ الجداول ----------------
     convToLocal / convToRemote تحويلات حقول صريحة — لا افتراضات. */
  const STORES = {
    products: {
      table: 'products', orderBy: 'updated_at',
      toRemote: (r) => ({
        sid: r.sid, quality: r.quality, gsm: r.gsm, size: r.size, combo: r.combo,
        source: r.source || null, created_at: r.createdAt || null, updated_at: r.updatedAt || r.createdAt || nowISO(),
      }),
      toLocal: (r) => ({
        sid: r.sid, quality: r.quality, gsm: r.gsm, size: r.size, combo: r.combo,
        source: r.source || 'cloud', createdAt: r.created_at, updatedAt: r.updated_at,
      }),
      keyOf: (r) => r.combo,
    },
    transactions: {
      table: 'transactions', orderBy: 'updated_at',
      toRemote: (r) => ({
        sid: r.sid, date: r.date, quality: r.quality, gsm: r.gsm, size: r.size,
        customer: r.customer, permit_no: r.permitNo || '', add_qty: r.addQty || 0,
        out_qty: r.outQty || 0, weight: r.weight == null || r.weight === '' ? null : Number(r.weight),
        settlement: r.settlement || '', notes: r.notes || '', group_id: r.groupId || null,
        source: r.source || 'manual', created_at: r.createdAt || null,
        updated_at: r.updatedAt || r.createdAt || nowISO(),
      }),
      toLocal: (r) => ({
        sid: r.sid, date: r.date, quality: r.quality, gsm: r.gsm, size: r.size,
        customer: r.customer, permitNo: r.permit_no || '', addQty: Number(r.add_qty) || 0,
        outQty: Number(r.out_qty) || 0, weight: r.weight == null ? null : Number(r.weight),
        settlement: r.settlement || '', notes: r.notes || '', groupId: r.group_id || null,
        source: r.source || 'cloud', createdAt: r.created_at, updatedAt: r.updated_at,
        permitId: r.group_id && String(r.group_id).startsWith('P:') ? String(r.group_id).slice(2) : null,
      }),
      keyOf: (r) => null,
    },
    rolls: {
      table: 'rolls', orderBy: 'updated_at',
      toRemote: (r) => ({
        sid: r.sid, roll_no: r.rollNo, gram: r.gram, date: r.date || null,
        notes: r.notes || '', source: r.source || null,
        created_at: r.createdAt || null, updated_at: r.updatedAt || r.createdAt || nowISO(),
      }),
      toLocal: (r) => ({
        sid: r.sid, rollNo: Number(r.roll_no), gram: r.gram == null ? null : Number(r.gram),
        date: r.date || '', notes: r.notes || '', source: r.source || 'cloud',
        createdAt: r.created_at, updatedAt: r.updated_at,
      }),
      keyOf: (r) => r.rollNo,
    },
    reels: {
      table: 'reels', orderBy: 'updated_at',
      toRemote: (r) => ({
        sid: r.sid, roll_no: r.rollNo, reel_no: r.reelNo, size: r.size, weight: r.weight,
        gram: r.gram, quality: r.quality, status: r.status, permit_ref: r.permitRef || null,
        source: r.source || null, roll_reel: r.rollReel || (r.rollNo + '|' + r.reelNo),
        created_at: r.createdAt || null, updated_at: r.updatedAt || r.createdAt || nowISO(),
      }),
      toLocal: (r) => ({
        id: r.sid, sid: r.sid, rollNo: r.roll_no == null ? null : Number(r.roll_no),
        reelNo: r.reel_no, size: r.size == null ? null : Number(r.size),
        weight: r.weight == null ? null : Number(r.weight), gram: r.gram == null ? null : Number(r.gram),
        quality: r.quality, status: r.status, permitRef: r.permit_ref || null,
        source: r.source || 'cloud', rollReel: r.roll_reel,
        createdAt: r.created_at, updatedAt: r.updated_at,
      }),
      keyOf: (r) => r.rollReel,
    },
    permits: {
      table: 'permits', orderBy: 'updated_at',
      toRemote: (r) => ({
        sid: r.sid || r.id, permit_no: r.permitNo, cls: r.cls, customer: r.customer,
        date: r.date, notes: r.notes || '', status: r.status, lines: r.lines || [],
        totals: r.totals || null, source: r.source || 'permit', group_id: r.groupId || null,
        created_by: r.created_by || PERM.state.userId || null,
        approved_at: r.approvedAt || null, created_at: r.createdAt || null,
        updated_at: r.updatedAt || r.createdAt || nowISO(),
      }),
      toLocal: (r) => ({
        id: r.sid, sid: r.sid, permitNo: r.permit_no, cls: r.cls, customer: r.customer,
        date: r.date, notes: r.notes || '', status: r.status, lines: r.lines || [],
        totals: r.totals || null, source: r.source || 'permit', groupId: r.group_id || null,
        approvedAt: r.approved_at, createdAt: r.created_at, updatedAt: r.updated_at,
        permitKey: (r.cls || '') + '|' + (r.permit_no || ''),
      }),
      keyOf: (r) => r.id,
    },
    customers: {
      table: 'customers', orderBy: 'updated_at',
      toRemote: (r) => ({
        sid: r.sid, name: r.name, notes: r.notes || '', source: r.source || null,
        created_at: r.createdAt || null, updated_at: r.updatedAt || r.createdAt || nowISO(),
      }),
      toLocal: (r) => ({
        sid: r.sid, name: r.name, notes: r.notes || '', source: r.source || 'cloud',
        createdAt: r.created_at, updatedAt: r.updated_at,
      }),
      keyOf: (r) => r.name,
    },
    audit: {
      table: 'audit_logs', pushOnly: true, orderBy: 'at',
      toRemote: (r) => ({
        sid: r.sid, actor: PERM.state.userId, actor_email: PERM.state.email,
        entity: r.entity, action: r.action, entity_id: r.entityId == null ? null : String(r.entityId),
        before: r.before == null ? null : r.before, after: r.after == null ? null : r.after,
        details: r.details || null, origin: r.origin || 'local', device: navigator.userAgent.slice(0, 200),
        at: r.at || nowISO(),
      }),
      toLocal: null,
      keyOf: () => null,
    },
  };

  /* ================= النواة النقية (قابلة للاختبار خارج المتصفح) ================= */
  const SYNC_CORE = {
    /** دمج السحابة في المحلية — القاعدة: الأحدث يفوز، والمحلي المعدّل يفوز دائمًا.
     * @returns {{apply: Array, conflicts: Array, pushes: Array}} */
    mergePull(localRows, remoteRows, opts) {
      const dirtySet = (opts && opts.dirtySids) || new Set();
      const bySid = new Map();
      for (const r of localRows) if (r.sid) bySid.set(r.sid, r);
      const apply = [], conflicts = [], pushes = [];
      for (const remote of remoteRows) {
        const sid = remote.sid;
        if (!sid) continue;
        const local = bySid.get(sid);
        if (!local) { apply.push(remote); continue; }
        const ru = remote.updated_at || remote.created_at || '';
        const lu = local.updatedAt || local.createdAt || '';
        if (dirtySet.has(sid)) {
          /* محلي مُعدَّل ولم يُرفع: المحلي يفوز ويُرفع — مع تسجيل تعارض */
          if (String(lu) >= String(ru)) {
            conflicts.push({ sid, winner: 'local', at: ru });
            pushes.push(remote);
          } else {
            /* السحابي أحدث: نقبل السحابي (لا نكتب فوق الأحدث بالأقدم) */
            conflicts.push({ sid, winner: 'remote', at: ru });
            apply.push(remote);
          }
          continue;
        }
        if (String(ru) > String(lu)) apply.push(remote);
        else if (String(lu) > String(ru)) pushes.push(remote);
      }
      return { apply, conflicts, pushes };
    },
    /** توليد معرفات ثابتة لصفوف بلا sid (إضافي — لا يمس بقية الحقول) */
    ensureSids(rows) {
      const changed = [];
      for (const r of rows) {
        if (!r.sid) { r.sid = uuid(); changed.push(r); }
      }
      return changed;
    },
    /** هل الصف مرشح للدفع؟ (أحدث من آخر دفع ولم يُسحب للتو) */
    isPushCandidate(r, lastPushAt) {
      const u = r.updatedAt || r.createdAt || r.at || null;
      if (!u) return false;
      if (r.syncedAt && String(u) <= String(r.syncedAt)) return false;
      return String(u) >= String(lastPushAt || '');
    },
  };

  /* ---------------- حالة المزامنة + أحداث الواجهة ---------------- */
  const status = {
    state: 'idle', /* idle | syncing | ok | error | offline */
    lastSync: null, pending: 0, message: '', online: navigator.onLine, progress: null,
  };
  function setStatus(patch) {
    Object.assign(status, patch);
    try { global.UI.EventBus.emit('sync-status', Object.assign({}, status)); } catch (e) { /* noop */ }
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => { status.online = true; setStatus({ online: true }); });
    window.addEventListener('offline', () => { status.online = false; setStatus({ online: false, state: 'offline' }); });
  }

  /* ---------------- مساعدات التخزين ---------------- */
  const SKEY = (k) => 'sync:' + k;
  function getSetting(k, d) { return global.DB.getSetting(SKEY(k), d); }
  function setSetting(k, v) { return global.DB.setSetting(SKEY(k), v); }

  async function recordTombstones(store, sids) {
    if (!sids || !sids.length) return;
    const rows = sids.filter(Boolean).map((sid) => ({ id: store + '|' + sid, store, sid, at: nowISO() }));
    await global.DB.bulkPut('tombstones', rows);
  }

  /* تعيين sid لكل الصفوف بلا معرف ثابت (إضافي بحت) */
  async function ensureStoreSids(store) {
    const marker = 'sid-migration-v2:' + store;
    if (await getSetting(marker, false)) return;
    const rows = await global.DB.getAll(store);
    const changed = SYNC_CORE.ensureSids(rows);
    let normalized = 0;
    for (const row of rows) {
      if (!row.updatedAt) {
        row.updatedAt = row.createdAt || row.at || nowISO();
        if (changed.indexOf(row) < 0) changed.push(row);
        normalized++;
      }
    }
    if (changed.length) await global.DB.bulkPut(store, changed);
    await setSetting(marker, true);
    global.console && console.log(`[sync] initialized ${store}: ${changed.length} rows (${normalized} timestamps)`);
  }

  /* ---------------- سجل المزامنة ---------------- */
  async function logSync(entries) {
    const sb = SB.client();
    if (!sb || !PERM.signedIn()) return;
    const rows = entries.map((e) => ({
      actor: PERM.state.userId, actor_email: PERM.state.email,
      direction: e.direction, store: e.store, rows: e.rows || 0,
      ok: e.ok !== false, message: e.message || null,
    }));
    try { await sb.from('sync_logs').insert(rows); } catch (e) { /* best-effort */ }
  }

  /* ================= الدفع (Push) — للمدير فقط ================= */
  async function pushStore(storeName, cfg, lastPushAt, retrySids) {
    const sb = SB.client();
    await ensureStoreSids(storeName);
    const field = cfg.orderBy === 'at' ? 'at' : 'updatedAt';
    const range = lastPushAt && typeof IDBKeyRange !== 'undefined'
      ? IDBKeyRange.lowerBound(lastPushAt, false) : undefined;
    const indexed = await global.DB.getAllByIndexRange(storeName, field, range);
    const retryRows = retrySids.size
      ? await global.DB.getManyByIndex(storeName, 'sid', [...retrySids]) : [];
    const bySid = new Map();
    indexed.forEach((r) => { if (r) bySid.set(r.sid || ('local:' + r.id), r); });
    retryRows.forEach((r) => { if (r && r.sid) bySid.set(r.sid, r); });
    const cand = [...bySid.values()].filter((r) =>
      SYNC_CORE.isPushCandidate(r, lastPushAt) || retrySids.has(r.sid));
    const missingSid = cand.filter((r) => !r.sid);
    if (missingSid.length) {
      missingSid.forEach((r) => { r.sid = uuid(); });
      await global.DB.bulkPut(storeName, missingSid);
    }
    if (!cand.length) return { pushed: 0, failed: 0, failedSids: [] };
    const payload = cand.map(cfg.toRemote);
    const pushedSids = [], failedSids = new Set();
    const CHUNK = 300;
    for (let i = 0; i < payload.length; i += CHUNK) {
      const chunk = payload.slice(i, i + CHUNK);
      const { error } = await sb.from(cfg.table).upsert(chunk, { onConflict: 'sid' });
      if (error) {
        chunk.forEach((r) => failedSids.add(r.sid));
        console.error('[sync] push', storeName, error.message);
      } else {
        chunk.forEach((r) => pushedSids.push(r.sid));
      }
    }
    /* علّم الصفوف المرفوعة فقط لتجنب صدى الدفع — الفاشل يعاد تلقائيًا */
    if (pushedSids.length) {
      const now = nowISO();
      const doneSet = new Set(pushedSids);
      await global.DB.bulkPut(storeName, cand
        .filter((r) => doneSet.has(r.sid))
        .map((r) => Object.assign({}, r, { syncedAt: now })));
    }
    return { pushed: pushedSids.length, failed: failedSids.size, failedSids: [...failedSids] };
  }

  async function pushDeletes() {
    const sb = SB.client();
    const tombs = await global.DB.getAll('tombstones');
    if (!tombs.length) return { deleted: 0, failed: 0 };
    let deleted = 0, failed = 0;
    const grouped = new Map();
    for (const t of tombs) {
      const cfg = STORES[t.store];
      if (!cfg) continue;
      if (!grouped.has(t.store)) grouped.set(t.store, []);
      grouped.get(t.store).push(t);
    }
    for (const [storeName, rows] of grouped) {
      const cfg = STORES[storeName];
      for (let i = 0; i < rows.length; i += 100) {
        const chunk = rows.slice(i, i + 100);
        const { error } = await sb.from(cfg.table).delete().in('sid', chunk.map((r) => r.sid));
        if (error) {
          failed += chunk.length;
          console.error('[sync] batch delete', storeName, error.message);
          continue;
        }
        await global.DB.bulkDel('tombstones', chunk.map((r) => r.id));
        deleted += chunk.length;
      }
    }
    return { deleted, failed };
  }

  /* ================= السحب (Pull) ================= */
  async function pullStore(storeName, cfg, lastPullAt) {
    const sb = SB.client();
    const remoteRows = [];
    const RANGE = 1000;
    let from = 0;
    for (;;) {
      let q = sb.from(cfg.table).select('*').order(cfg.orderBy, { ascending: true }).range(from, from + RANGE - 1);
      if (lastPullAt && cfg.orderBy === 'updated_at') q = q.gt('updated_at', lastPullAt);
      const { data, error } = await q;
      if (error) throw error;
      if (!data || !data.length) break;
      remoteRows.push(...data);
      if (data.length < RANGE) break;
      from += RANGE;
    }
    if (!remoteRows.length) return { applied: 0, conflicts: 0 };

    /* عظام القبر: السجلات المحذوفة محليًا لا تعود من السحابة */
    const tombs = await global.DB.getAllByIndexRange('tombstones', 'store', IDBKeyRange.only(storeName));
    const deadSids = new Set(tombs.map((t) => t.sid));
    const alive = remoteRows.filter((r) => !deadSids.has(r.sid));

    const localRows = (await global.DB.getManyByIndex(storeName, 'sid', alive.map((r) => r.sid)))
      .filter(Boolean);
    const { apply, conflicts, pushes } = SYNC_CORE.mergePull(localRows, alive, { dirtySids: new Set() });
    if (apply.length) {
      /* الصفوف السحابية تُخزن محليًا مع الحفاظ على مفتاحها المحلي القائم —
         متاجر المفتاح التلقائي (autoIncrement) تحافظ على id الحالي،
         ومتاجر UUID (reels/permits) مفتاحها هو sid نفسه */
      const AUTO = new Set(['products', 'transactions', 'customers', 'rolls']);
      const bySid = new Map(localRows.filter((r) => r.sid).map((r) => [r.sid, r]));
      const toWrite = apply.map((r) => {
        const row = cfg.toLocal(r);
        const existing = bySid.get(r.sid);
        if (existing && existing.id != null && AUTO.has(storeName)) row.id = existing.id;
        row.syncedAt = nowISO();
        return row;
      });
      await global.DB.bulkPut(storeName, toWrite);
    }
    return { applied: apply.length, conflicts: conflicts.length, pushes: pushes.length };
  }

  /* ================= رصيد أمين المخزن (دوال تجميعية عبر RLS) ================= */
  async function pullKeeperStock() {
    const sb = SB.client();
    const { data, error } = await sb.rpc('app_stock_balances');
    if (error) throw error;
    const rows = (data || []).map((r) => ({
      key: global.CALC.comboKey(r.quality, r.gsm, r.size),
      quality: r.quality, gsm: r.gsm, size: r.size,
      add: r6(r.add_qty), out: r6(r.out_qty), net: r6(r.net),
      updatedAt: nowISO(),
    }));
    await global.DB.bulkPut('stockview', rows);
    return rows.length;
  }

  /* أسطر الصرف داخل نافذة اليومين — تُخزن محليًا لبناء الأذون المشتقة */
  async function pullKeeperRecentOutRows() {
    const sb = SB.client();
    const { data, error } = await sb.rpc('app_recent_out_rows');
    if (error) throw error;
    const bySidRows = await global.DB.getManyByIndex('transactions', 'sid', (data || []).map((r) => r.sid));
    const bySid = new Map(bySidRows.filter(Boolean).map((r) => [r.sid, r]));
    const toWrite = [];
    for (const r of data || []) {
      if (bySid.has(r.sid)) continue; /* موجود محليًا — لا تكرار */
      const row = STORES.transactions.toLocal(r);
      row.syncedAt = nowISO();
      row.source = r.source || 'cloud';
      toWrite.push(row);
    }
    if (toWrite.length) await global.DB.bulkPut('transactions', toWrite);
    return toWrite.length;
  }

  /* ================= تطهير نافذة أمين المخزن =================
     على جهاز أمين المخزن لا يُبقى أي أذون/حركات صرف خارج نافذة اليومين
     (اليوم + الأمس بتوقيت القاهرة) — حتى ما سُحب بالأمس يجب أن يختفي
     عند بداية يوم جديد. الصفوف المحلية القديمة بلا وسم سحابي لا تُمس
     (حماية بيانات جهاز كان مستخدمًا سابقًا بغير حساب). */
  async function purgeKeeperWindow() {
    const deadPermits = [], deadTx = [];
    for (const p of await global.DB.getAll('permits')) {
      if (!PERM.inKeeperWindow(p.date)) deadPermits.push(p.id);
    }
    for (const r of await global.DB.getAll('transactions')) {
      const fromCloud = !!r.syncedAt || r.source === 'cloud';
      if (fromCloud && !PERM.inKeeperWindow(r.date)) deadTx.push(r.id);
    }
    for (const id of deadPermits) await global.DB.del('permits', id);
    for (const id of deadTx) await global.DB.del('transactions', id);
    return { permits: deadPermits.length, tx: deadTx.length };
  }

  /* ================= الجلسة الكاملة ================= */
  let _running = false, _queued = false;
  async function run(opts) {
    const warehouse = PERM.isWarehouse();
    const sb = SB.client();
    if (_running) { _queued = true; return { skipped: 'queued' }; }
    if (!sb) return { skipped: 'no-lib' };
    if (!PERM.signedIn() && !warehouse) return { skipped: 'not-signed-in' };
    if (!status.online) { setStatus({ state: 'offline', message: 'غير متصل — البيانات محفوظة محليًا' }); return { skipped: 'offline' }; }
    _running = true;
    setStatus({ state: 'syncing', message: 'جارٍ المزامنة…', progress: { completed: 0, total: warehouse ? 6 : 13, phase: 'pull' } });
    const startedAt = nowISO();
    const logs = [];
    let ok = true, changedLocal = false;
    try {
      /* تأكد من وجود متاجر المزامنة (ترحيل v4) */
      await global.DB.open();

      /* ---------- أمين المخزن: سحب + رفع أذونه المحلية فقط ---------- */
      if (warehouse) {
        const [nb, ntx, np, nr, nro] = await Promise.all([
          pullKeeperStock(), pullKeeperRecentOutRows(),
          pullStore('permits', STORES.permits, await getSetting('pull:permits', null)),
          pullStore('reels', STORES.reels, await getSetting('pull:reels', null)),
          pullStore('rolls', STORES.rolls, await getSetting('pull:rolls', null)),
        ]);
        await Promise.all(['permits', 'reels', 'rolls'].map((name) => setSetting('pull:' + name, startedAt)));
        setStatus({ progress: { completed: 5, total: 6, phase: 'pull' } });
        /* رفع أذون الصرف أنشئت على هذا الجهاز ولم تُرفع بعد (مسودات أمين
           المخزن). RLS يسمح بالإدراج داخل نافذة اليومين فقط والفشل يعاد
           تلقائيًا في الدورة التالية — لا يُعتبر السجل متزامنًا قبل تأكيد
           الحفظ في Supabase (العلّم بالـ syncedAt يحدث بعد نجاح الرفع فقط). */
        let pushedPermits = 0, failedPermits = 0;
        try {
          const lastPush = await getSetting('push:permits', null);
          const res = await pushStore('permits', STORES.permits, lastPush, new Set());
          pushedPermits = res.pushed; failedPermits = res.failed;
          if (res.failed === 0) await setSetting('push:permits', startedAt);
          else ok = false;
          logs.push({ direction: 'push', store: 'permits', rows: res.pushed, ok: res.failed === 0, message: res.failed ? `${res.failed} فشل` : null });
        } catch (e) {
          ok = false;
          logs.push({ direction: 'push', store: 'permits', rows: 0, ok: false, message: e.message });
        }
        if (ok && failedPermits === 0) await setSetting('lastSyncAt', nowISO());
        const lastSuccessfulSync = await getSetting('lastSyncAt', null);
        const purged = await purgeKeeperWindow();
        setStatus({ progress: { completed: 6, total: 6, phase: 'done' } });
        setStatus({
          state: ok && failedPermits === 0 ? 'ok' : 'error',
          lastSync: lastSuccessfulSync,
          pending: failedPermits,
          message: !ok || failedPermits
            ? 'فشل جزء من المزامنة — سيعاد تلقائيًا'
            : `تم تحديث الرصيد وأذون اليومين${pushedPermits ? ` — رفع ${pushedPermits} إذن` : ''}`,
        });
        logs.push({ direction: 'pull', store: 'stock', rows: nb + ntx, ok: true });
        await logSync(logs);
        try { global.App && global.App.refresh(); } catch (e) { /* noop */ }
        return { pulled: { balances: nb, outRows: ntx, permits: np.applied || 0, reels: nr.applied || 0, rolls: nro.applied || 0, purged }, pushed: pushedPermits };
      }

      /* ---------- المدير: سحب ثم دفع ---------- */
      let pending = 0, conflictsTotal = 0;
      const pullNames = ['products', 'rolls', 'reels', 'permits', 'customers', 'transactions'];
      let progressDone = 0;
      await Promise.all(pullNames.map(async (storeName) => {
        const cfg = STORES[storeName];
        const lastPull = await getSetting('pull:' + storeName, null);
        try {
          const res = await pullStore(storeName, cfg, lastPull);
          conflictsTotal += res.conflicts || 0;
          if (res.applied) changedLocal = true;
          await setSetting('pull:' + storeName, startedAt);
          logs.push({ direction: 'pull', store: storeName, rows: res.applied || 0, ok: true });
        } catch (e) {
          ok = false;
          logs.push({ direction: 'pull', store: storeName, rows: 0, ok: false, message: e.message });
          console.error('[sync] pull failed', storeName, e);
        } finally {
          progressDone++;
          setStatus({ progress: { completed: progressDone, total: 13, phase: 'pull' } });
        }
      }));

      const retryRaw = await getSetting('retry:sids', []);
      const retrySids = new Set(Array.isArray(retryRaw) ? retryRaw : []);

      let pushedTotal = 0, failedTotal = 0, delTotal = 0;
      const newRetry = [];
      const pushNames = ['products', 'rolls', 'reels', 'permits', 'customers', 'transactions', 'audit'];
      let pushDone = 0;
      await Promise.all(pushNames.map(async (storeName) => {
        const cfg = STORES[storeName];
        if (!cfg || !cfg.toRemote) return;
        const lastPush = await getSetting('push:' + storeName, null);
        try {
          const res = await pushStore(storeName, cfg, lastPush, retrySids);
          pushedTotal += res.pushed; failedTotal += res.failed;
          (res.failedSids || []).forEach((sid) => newRetry.push(sid));
          if (res.failed === 0) await setSetting('push:' + storeName, startedAt);
          else ok = false;
          logs.push({ direction: 'push', store: storeName, rows: res.pushed, ok: res.failed === 0, message: res.failed ? `${res.failed} فشل` : null });
        } catch (e) {
          ok = false;
          logs.push({ direction: 'push', store: storeName, rows: 0, ok: false, message: e.message });
        } finally {
          pushDone++;
          setStatus({ progress: { completed: 6 + pushDone, total: 13, phase: 'push' } });
        }
      }));
      try {
        const del = await pushDeletes();
        delTotal = del.deleted;
        if (del.failed) ok = false;
        logs.push({ direction: 'push', store: 'tombstones', rows: del.deleted, ok: del.failed === 0, message: del.failed ? `${del.failed} فشل` : null });
      } catch (e) {
        ok = false;
        logs.push({ direction: 'push', store: 'tombstones', rows: 0, ok: false, message: e.message });
      }
      await setSetting('retry:sids', newRetry);

      const tombCount = await global.DB.count('tombstones');
      const completedAt = nowISO();
      if (ok && failedTotal === 0 && tombCount === 0 && newRetry.length === 0) {
        await setSetting('lastSyncAt', completedAt);
      }
      const lastSuccessfulSync = await getSetting('lastSyncAt', null);
      setStatus({
        state: ok ? 'ok' : 'error',
        lastSync: lastSuccessfulSync,
        pending: tombCount + newRetry.length,
        progress: { completed: 13, total: 13, phase: 'done' },
        message: ok
          ? `تمت المزامنة${pushedTotal ? ` — رفع ${pushedTotal} سجل` : ''}${delTotal ? ` — حذف ${delTotal}` : ''}${conflictsTotal ? ` — ${conflictsTotal} تعارض حُلَّ بالأحدث` : ''}`
          : 'فشل جزء من المزامنة — سيعاد تلقائيًا',
      });
      await logSync(logs);
      return { ok, pushed: pushedTotal, deleted: delTotal, conflicts: conflictsTotal };
    } catch (e) {
      console.error('[sync] run failed', e);
      setStatus({ state: 'error', message: SB.humanError(e) });
      return { error: e.message || String(e) };
    } finally {
      _running = false;
      try {
        global.App && global.App.refresh && changedLocal && !PERM.isWarehouse() && global.App.refresh();
      } catch (e) { /* noop */ }
      if (_queued) {
        _queued = false;
        setTimeout(() => run({ queued: true }).catch(() => {}), 250);
      }
    }
  }

  /* دفع سجل تدقيق محلي إلى السحابة (لحظي ومحاولة هادئة) */
  async function pushAuditNow(entry) {
    if (!PERM.can('sync') || !status.online) return;
    const cfg = STORES.audit;
    try {
      const sb = SB.client();
      if (!sb) return;
      const payload = cfg.toRemote(entry);
      await sb.from(cfg.table).insert(payload);
    } catch (e) { /* يُلتقط في الدفع الدوري لاحقًا (updatedAt > lastPush) */ }
  }

  /* ---------------- Realtime: تحديث لحظي من الأجهزة الأخرى ----------------
     اشتراك في بث Supabase (يحترم RLS تلقائيًا) — أي إضافة/تعديل/حذف في
     السحابة يستدعي مزامنة فورية بعد تجميع الأحداث المتتالية (debounce).
     إن تعذر البث تبقى المزامنة الدورية كل دقيقتين كما هي. */
  let _rtChannel = null, _rtTimer = null;
  function startRealtime() {
    const sb = SB.client();
    if (!sb || _rtChannel || typeof window === 'undefined') return;
    try {
      _rtChannel = sb.channel('agrima-changes')
        .on('postgres_changes', { event: '*', schema: 'public' }, () => {
          if (!status.online || !PERM.signedIn()) return;
          if (_running) { _queued = true; return; }
          clearTimeout(_rtTimer);
          _rtTimer = setTimeout(() => run().catch(() => {}), 1800);
        })
        .subscribe((s) => {
          if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') { try { sb.removeChannel(_rtChannel); } catch (e2) { /* noop */ } _rtChannel = null; }
        });
    } catch (e) { /* بث غير متاح — الدورية تكفي */ }
  }

  /* مؤقّت دوري: مزامنة تلقائية للمدير كل دقيقتين عند الاتصال */
  function startAutoSync() {
    if (typeof window === 'undefined') return;
    startRealtime();
    setInterval(() => {
      if (status.online && PERM.can('sync')) run().catch(() => {});
    }, 120000);
    window.addEventListener('online', () => {
      if (PERM.can('sync')) setTimeout(() => run().catch(() => {}), 1500);
    });
    if (PERM.signedIn() || PERM.isWarehouse()) setTimeout(() => run().catch(() => {}), 800);
  }

  global.SYNC = {
    STORES, SYNC_CORE, run, status, startAutoSync, pushAuditNow,
    recordTombstones, ensureStoreSids,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { SYNC_CORE, STORES };
  }
})(typeof window !== 'undefined' ? window : globalThis);
