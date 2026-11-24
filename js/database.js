/* =========================================================================
   database.js — IndexedDB storage layer
   Agrima — نظام إدارة المخزون والرولات والبكر والإنتاج وأذون الصرف
   -------------------------------------------------------------------------
   Stores (v1 — kept untouched, existing user data stays valid):
     products     { id, quality, gsm, size, source, createdAt }  (id auto)
     transactions { id, date, quality, gsm, size, customer, permitNo,
                    addQty, outQty, weight, settlement, notes,
                    source, excelRow, fingerprint, createdAt, updatedAt }
     audit        { id, entity, action, entityId, before, after, at, details }
     settings     { key, value }

   Stores added in v2 (upgrade only CREATES new stores — never touches
   existing records, so old data survives unchanged):
     rolls        { id, rollNo (unique), gram, date, notes, source,
                    createdAt, updatedAt }                (id auto)
     reels        { id (uuid), rollNo, reelNo, size, weight, gram, quality,
                    status: 'available'|'dispatched'|'returned'|'undefined',
                    permitRef, source, rollReel (unique "rollNo|reelNo"),
                    createdAt, updatedAt }
     permits      { id (uuid), permitNo, cls 'ض'|'غ', customer, date, notes,
                    status: 'draft'|'approved', lines[], groupId,
                    createdAt, approvedAt, source }
     customers    { id, name (unique), notes, source, createdAt }
     importlog    { key (file fingerprint), fileName, kind, at, summary }

   Stores added in v3 (procurement — strictly additive as well; the v2→v3
   upgrade only CREATES the four stores below and never reads, rewrites or
   deletes any existing record or store):
     suppliers    { id (auto), code 'SUP-####' (unique), nameKey (unique
                    normalized name), name, phone, address, contact, notes,
                    archived, createdAt, updatedAt }
     purchases    { id (uuid), seq (numeric, display P-####), supplierId,
                    supplierName, supplierInvoiceNo, invoiceDate, lines[],
                    subtotal, extraCosts, discount, finalTotal, paid, notes,
                    status: 'draft'|'partial'|'received'|'cancelled',
                    createdAt, updatedAt }
     receives     { id (uuid), purchaseId, purchaseSeq, lineId, reelId,
                    rollNo, reelNo, quality, gsm, size, qty, weight,
                    weightSource 'actual'|'none', date, notes, createdAt }
                  — reelId is UNIQUE: one reel can be received/linked for
                    exactly one purchase invoice, ever.
     supreturns   { id (uuid), seq (numeric, display RT-####), supplierId,
                    supplierName, purchaseId, purchaseSeq, date, reason,
                    notes, lines[{lineId, quality, gsm, size, qty, reelIds,
                    weight}], status 'active'|'cancelled', cancelledAt,
                    cancelReason, createdAt, updatedAt }
   Procurement changes are audited in the existing `audit` store with
   entity 'supplier' | 'purchase' | 'receive' | 'return'.
   ========================================================================= */
(function (global) {
  'use strict';

  const DB_NAME = 'inventory_pwa_db';
  /* v2: rolls / reels / permits / customers / importlog.
     v3: suppliers / purchases / receives / supreturns (procurement).
     The upgrade handler below ONLY creates object stores & indexes —
     existing stores, keys and records are never read, rewritten or deleted,
     so upgrading a live user database is purely additive (safe migration). */
  const DB_VERSION = 3;

  let _db = null;
  let _openPromise = null;

  /* Typed error so the boot screen can tell the user exactly what to do. */
  function dbError(kind, message, cause) {
    const e = new Error(message);
    e.name = 'DBError';
    e.kind = kind; /* 'blocked' | 'timeout' | 'unavailable' | 'io' */
    e.cause = cause;
    return e;
  }

  function open() {
    /* one shared open attempt: concurrent callers wait on the same promise */
    if (_db) return Promise.resolve(_db);
    if (_openPromise) return _openPromise;
    _openPromise = new Promise((resolve, reject) => {
      let req;
      try {
        if (typeof indexedDB === 'undefined') {
          throw dbError('unavailable', 'IndexedDB غير متاح في هذا المتصفح / IndexedDB is not available here');
        }
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (err) {
        _openPromise = null;
        reject(dbError('unavailable', 'IndexedDB غير متاح / IndexedDB is not available', err));
        return;
      }
      /* If another tab holds an older connection, the open request would
         hang forever without onblocked — one of the real causes of the
         endless "جاري التحميل" state. */
      req.onblocked = () => {
        console.warn('[db] open blocked — another tab holds the database');
      };
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('products')) {
          const s = db.createObjectStore('products', { keyPath: 'id', autoIncrement: true });
          s.createIndex('quality', 'quality', { unique: false });
          s.createIndex('combo', 'combo', { unique: true });
        }
        if (!db.objectStoreNames.contains('transactions')) {
          const s = db.createObjectStore('transactions', { keyPath: 'id', autoIncrement: true });
          s.createIndex('date', 'date', { unique: false });
          s.createIndex('quality', 'quality', { unique: false });
          s.createIndex('combo', 'combo', { unique: false });
          s.createIndex('customer', 'customer', { unique: false });
          s.createIndex('fingerprint', 'fingerprint', { unique: false });
          s.createIndex('groupId', 'groupId', { unique: false });
          s.createIndex('reelId', 'reelId', { unique: false });
        }
        if (!db.objectStoreNames.contains('audit')) {
          const s = db.createObjectStore('audit', { keyPath: 'id', autoIncrement: true });
          s.createIndex('at', 'at', { unique: false });
          s.createIndex('entity', 'entity', { unique: false });
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
        /* ---- v2 stores (rolls & bales & permits & customers) ---- */
        if (!db.objectStoreNames.contains('rolls')) {
          const s = db.createObjectStore('rolls', { keyPath: 'id', autoIncrement: true });
          s.createIndex('rollNo', 'rollNo', { unique: true });
          s.createIndex('date', 'date', { unique: false });
        }
        if (!db.objectStoreNames.contains('reels')) {
          const s = db.createObjectStore('reels', { keyPath: 'id' });
          s.createIndex('rollNo', 'rollNo', { unique: false });
          s.createIndex('status', 'status', { unique: false });
          s.createIndex('rollReel', 'rollReel', { unique: true });
          s.createIndex('quality', 'quality', { unique: false });
        }
        if (!db.objectStoreNames.contains('permits')) {
          const s = db.createObjectStore('permits', { keyPath: 'id' });
          s.createIndex('status', 'status', { unique: false });
          s.createIndex('cls', 'cls', { unique: false });
          s.createIndex('date', 'date', { unique: false });
          s.createIndex('permitKey', 'permitKey', { unique: true });
        }
        if (!db.objectStoreNames.contains('customers')) {
          const s = db.createObjectStore('customers', { keyPath: 'id', autoIncrement: true });
          s.createIndex('name', 'name', { unique: true });
        }
        if (!db.objectStoreNames.contains('importlog')) {
          db.createObjectStore('importlog', { keyPath: 'key' });
        }
        /* ---- v3 stores (procurement: suppliers & purchases) ---- */
        if (!db.objectStoreNames.contains('suppliers')) {
          const s = db.createObjectStore('suppliers', { keyPath: 'id', autoIncrement: true });
          s.createIndex('code', 'code', { unique: true });
          s.createIndex('nameKey', 'nameKey', { unique: true });
          s.createIndex('archived', 'archived', { unique: false });
        }
        if (!db.objectStoreNames.contains('purchases')) {
          const s = db.createObjectStore('purchases', { keyPath: 'id' });
          s.createIndex('seq', 'seq', { unique: true });
          s.createIndex('supplierId', 'supplierId', { unique: false });
          s.createIndex('status', 'status', { unique: false });
          s.createIndex('invoiceDate', 'invoiceDate', { unique: false });
        }
        if (!db.objectStoreNames.contains('receives')) {
          const s = db.createObjectStore('receives', { keyPath: 'id' });
          s.createIndex('purchaseId', 'purchaseId', { unique: false });
          s.createIndex('reelId', 'reelId', { unique: true }); /* one reel ↔ one purchase, ever */
          s.createIndex('lineId', 'lineId', { unique: false });
        }
        if (!db.objectStoreNames.contains('supreturns')) {
          const s = db.createObjectStore('supreturns', { keyPath: 'id' });
          s.createIndex('seq', 'seq', { unique: true });
          s.createIndex('supplierId', 'supplierId', { unique: false });
          s.createIndex('purchaseId', 'purchaseId', { unique: false });
          s.createIndex('status', 'status', { unique: false });
          s.createIndex('date', 'date', { unique: false });
        }
      };
      req.onsuccess = () => {
        _db = req.result;
        _db.onversionchange = () => { /* another tab upgraded: release ours */
          try { _db.close(); } catch (e2) { /* ignore */ }
          _db = null; _openPromise = null;
        };
        resolve(_db);
      };
      req.onerror = () => {
        _openPromise = null;
        reject(dbError('io', 'فشل فتح قاعدة البيانات المحلية / Failed to open the local database', req.error));
      };
      /* hard timeout: never leave the app on the loading screen forever */
      setTimeout(() => {
        if (_db) return;
        try { req.cancel && req.cancel(); } catch (e3) { /* no-op */ }
        _openPromise = null;
        reject(dbError('timeout',
          'استغرق فتح قاعدة البيانات أكثر من 10 ثوانٍ. أغلق أي تبويبات أخرى للتطبيق ثم أعد المحاولة / Database open timed out — close other app tabs and retry'));
      }, 10000);
    });
    return _openPromise;
  }

  function tx(store, mode, fn) {
    return open().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const st = t.objectStore(store);
      let out;
      try { out = fn(st); } catch (err) { reject(err); return; }
      const reqs = Array.isArray(out) ? out : [out];
      let done = 0;
      const results = [];
      let settled = false;
      const finish = (fn2) => { if (!settled) { settled = true; fn2(); } };
      if (reqs.length === 0) { finish(() => resolve([])); return; }
      reqs.forEach((r, i) => {
        if (!r) { done++; results[i] = undefined; return; }
        r.onsuccess = () => { results[i] = r.result; done++; if (done >= reqs.length) finish(() => resolve(Array.isArray(out) ? results : results[0])); };
        r.onerror = () => finish(() => reject(r.error));
      });
      t.onabort = () => finish(() => reject(t.error));
    }));
  }

  /* ---------- generic helpers ---------- */
  const DB = {
    open,
    getAll: (store) => tx(store, 'readonly', (st) => st.getAll()),
    get: (store, key) => tx(store, 'readonly', (st) => st.get(key)),
    count: (store) => tx(store, 'readonly', (st) => st.count()),
    put: (store, val) => tx(store, 'readwrite', (st) => st.put(val)),
    add: (store, val) => tx(store, 'readwrite', (st) => st.add(val)),
    del: (store, key) => tx(store, 'readwrite', (st) => st.delete(key)),
    clear: (store) => tx(store, 'readwrite', (st) => st.clear()),

    /* Atomic bulk import: runs inside ONE IndexedDB transaction so a failure
       rolls everything back (no partial imports). */
    bulkPut(store, items) {
      return open().then((db) => new Promise((resolve, reject) => {
        const t = db.transaction(store, 'readwrite');
        const st = t.objectStore(store);
        items.forEach((it) => st.put(it));
        t.oncomplete = () => resolve(items.length);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }));
    },

    /* Atomic cross-store work unit: `workFn` runs inside ONE readwrite
       transaction over several stores and queues its own requests (add/put/
       getAll...). Resolves with workFn's return value on complete; any
       abort/error rejects with the queued failure, so document saving +
       numbering counters can never be half-applied. */
    atomic(storeNames, workFn) {
      return open().then((db) => new Promise((resolve, reject) => {
        let t;
        try {
          t = db.transaction(storeNames, 'readwrite');
        } catch (err) { reject(err); return; }
        let result = null, fail = null;
        try {
          result = workFn(t, (e) => { fail = e || fail; });
        } catch (err) {
          fail = err;
          try { t.abort(); } catch (e2) { /* already aborted */ }
        }
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(fail || t.error);
        t.onabort = () => reject(fail || t.error || new Error('transaction aborted'));
      }));
    },

    /* ---------- settings ---------- */
    getSetting(key, fallback) {
      return DB.get('settings', key).then((v) => (v === undefined ? fallback : v.value));
    },
    setSetting(key, value) {
      return DB.put('settings', { key, value });
    },

    /* ---------- audit ---------- */
    logAudit(entry) {
      return DB.add('audit', Object.assign({ at: new Date().toISOString() }, entry));
    },
    getAudit(limit) {
      return DB.getAll('audit').then((rows) => {
        rows.sort((a, b) => (a.at < b.at ? 1 : -1));
        return limit ? rows.slice(0, limit) : rows;
      });
    },

    /* wipe everything (used only from explicit "reset" in settings and from
       restore, requires typed confirmation in the UI). Clears every store —
       including the v3 procurement stores — and resets all sequences. */
    wipeAll() {
      return Promise.all([
        DB.clear('products'), DB.clear('transactions'), DB.clear('audit'),
        DB.clear('rolls'), DB.clear('reels'), DB.clear('permits'),
        DB.clear('customers'), DB.clear('importlog'),
        DB.clear('suppliers'), DB.clear('purchases'),
        DB.clear('receives'), DB.clear('supreturns'),
      ]).then(() => Promise.all([
        DB.setSetting('lastImport', null),
        DB.setSetting('docSeqTax', null),
        DB.setSetting('docSeqNontax', null),
        DB.setSetting('rollSeq', null),
        DB.setSetting('supplierSeq', null),
        DB.setSetting('purchaseSeq', null),
        DB.setSetting('returnSeq', null),
      ]));
    },

    /* Replace ONLY the balance-file scope (products + transactions). Used by
       the Excel "import & replace" flow: roll/reel details, permits,
       customers and all procurement stores survive — the dialog announces
       exactly this scope. Sequences self-heal from the new rows. */
    wipeBalanceScope() {
      return Promise.all([
        DB.clear('products'), DB.clear('transactions'),
      ]);
    },
  };

  global.DB = DB;

  /* Node export for automated tests */
  if (typeof module !== 'undefined' && module.exports) module.exports = DB;
})(typeof window !== 'undefined' ? window : globalThis);
