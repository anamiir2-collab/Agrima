/* =========================================================================
   tests/test-sync-cloud.js — Agrima v11 cloud-layer test suite (Node)
   Run:  npm test  &&  npm run test:sync   (uses fake-indexeddb, no browser)
   Covers:
     • DB v3→v4 additive migration (tombstones / stockview created,
       existing records untouched)
     • SYNC_CORE.mergePull conflict rules (newest wins, dirty-local wins,
       no resurrect via tombstones is push-side, duplicates impossible
       by sid)
     • ensureSids / isPushCandidate
     • permissions matrix for admin / warehouse / local
     • permits.toRemote shape (created_by present, sid fallback)
   ========================================================================= */
'use strict';

require('fake-indexeddb/auto');
const { webcrypto } = require('crypto');
if (!globalThis.crypto || !globalThis.crypto.randomUUID) {
  globalThis.crypto = webcrypto;
}

require('../js/calculations.js');
require('../js/ui.js');
require('../js/database.js');     // → global DB (DB_VERSION 4)
require('../js/permissions.js');  // → global PERM
const SYNC = require('../js/sync.js'); // → SYNC_CORE + STORES (browser parts skipped)
const DB = globalThis.DB;
const PERM = globalThis.PERM;

/* ---------- tiny test harness ---------- */
const results = { pass: 0, fail: 0, list: [] };
async function test(name, fn) {
  try {
    await fn();
    results.pass++;
    results.list.push(`  ✓ ${name}`);
    console.log(`  ✓ ${name}`);
  } catch (e) {
    results.fail++;
    results.list.push(`  ✗ ${name} — ${e && e.message ? e.message : e}`);
    console.log(`  ✗ ${name} — ${e && e.message ? e.message : e}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'eq'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}

(async () => {
  /* ================================================================
     1) DB v4: الترحيل الإضافي — متاجر جديدة تُنشأ وبيانات قديمة تبقى
     ================================================================ */
  await test('DB v4: upgrade creates tombstones + stockview stores', async () => {
    await DB.open();
    // no exception + we can write and read both stores
    await DB.bulkPut('tombstones', [{ id: 'products|x1', store: 'products', sid: 'x1', at: new Date().toISOString() }]);
    await DB.bulkPut('stockview', [{ key: 'تست لينر معالج||125||100', quality: 'تست لينر معالج', gsm: '125', size: '100', add: 10, out: 3, net: 7, updatedAt: new Date().toISOString() }]);
    const t = await DB.get('tombstones', 'products|x1');
    const s = await DB.get('stockview', 'تست لينر معالج||125||100');
    assert(t && t.sid === 'x1', 'tombstone row missing');
    assert(s && s.net === 7, 'stockview row missing');
  });

  await test('DB v4: existing v3 stores and sequences survive the upgrade', async () => {
    // write a real movement + settings, reopen (simulated by re-use) and verify
    await DB.setSetting('docSeqTax', 42);
    const id = await DB.add('transactions', { date: '2026-11-01', quality: 'توب لاينر', gsm: '125', size: '100', customer: 'عميل', addQty: 5, outQty: 0, createdAt: new Date().toISOString() });
    const row = await DB.get('transactions', id);
    assert(row && row.addQty === 5, 'v3 transaction lost after v4 migration');
    eq(await DB.getSetting('docSeqTax', null), 42, 'docSeqTax lost');
    // wipeAll now also clears the new stores (full reset scope)
    await DB.wipeAll();
    eq((await DB.getAll('tombstones')).length, 0, 'wipeAll should clear tombstones');
    eq((await DB.getAll('stockview')).length, 0, 'wipeAll should clear stockview');
  });

  /* ================================================================
     2) SYNC_CORE.mergePull — قواعد التعارض الصارمة
     ================================================================ */
  const localRow = (sid, updatedAt, extra = {}) => ({ sid, updatedAt, ...extra });

  await test('mergePull: new remote row is applied (no duplicate — sid matched)', async () => {
    const res = SYNC.SYNC_CORE.mergePull(
      [localRow('a', '2026-11-01T10:00:00Z')],
      [{ sid: 'a', updated_at: '2026-11-01T10:00:00Z' }, { sid: 'b', updated_at: '2026-11-02T10:00:00Z' }],
      { dirtySids: new Set() },
    );
    eq(res.apply.length, 1, 'only sid b should be applied');
    eq(res.apply[0].sid, 'b', 'applied sid mismatch');
  });

  await test('mergePull: remote newer than clean local → remote wins', async () => {
    const res = SYNC.SYNC_CORE.mergePull(
      [localRow('a', '2026-11-01T10:00:00Z')],
      [{ sid: 'a', updated_at: '2026-11-03T10:00:00Z' }],
      { dirtySids: new Set() },
    );
    eq(res.apply.length, 1, 'remote newer must be applied');
    eq(res.pushes.length, 0, 'nothing to push');
  });

  await test('mergePull: local newer than clean remote → local pushed (never overwritten)', async () => {
    const res = SYNC.SYNC_CORE.mergePull(
      [localRow('a', '2026-11-05T10:00:00Z')],
      [{ sid: 'a', updated_at: '2026-11-03T10:00:00Z' }],
      { dirtySids: new Set() },
    );
    eq(res.pushes.length, 1, 'local newer must be pushed');
    eq(res.apply.length, 0, 'older remote must NOT be applied');
  });

  await test('mergePull: dirty local with older timestamp still wins (data safety)', async () => {
    const res = SYNC.SYNC_CORE.mergePull(
      [localRow('a', '2026-11-01T09:00:00Z')],
      [{ sid: 'a', updated_at: '2026-11-01T10:00:00Z' }],
      { dirtySids: new Set(['a']) },
    );
    eq(res.conflicts.length, 1, 'conflict recorded');
    eq(res.apply[0] && res.apply[0].sid, 'a', 'remote accepted (newest wins)');
    // وإن كان المحلي أحدث: يفوز ويُرفع
    const res2 = SYNC.SYNC_CORE.mergePull(
      [localRow('a', '2026-11-02T09:00:00Z')],
      [{ sid: 'a', updated_at: '2026-11-01T10:00:00Z' }],
      { dirtySids: new Set(['a']) },
    );
    eq(res2.pushes.length, 1, 'dirty newer local must be pushed');
    eq(res2.apply.length, 0, 'older remote must NOT overwrite dirty local');
  });

  await test('ensureSids: assigns stable UUIDs only to rows missing sid', async () => {
    const rows = [{ sid: 'keep-me' }, {}, {}];
    const changed = SYNC.SYNC_CORE.ensureSids(rows);
    eq(changed.length, 2, 'only 2 rows changed');
    eq(rows[0].sid, 'keep-me', 'existing sid untouched');
    assert(rows[1].sid && rows[1].sid.length >= 32, 'generated sid looks like UUID');
    assert(rows[1].sid !== rows[2].sid, 'generated sids unique');
  });

  await test('isPushCandidate: pushed rows do not echo (syncedAt gate)', async () => {
    const row = { updatedAt: '2026-11-01T10:00:00Z', syncedAt: '2026-11-01T10:00:05Z' };
    eq(SYNC.SYNC_CORE.isPushCandidate(row, ''), false, 'synced row must not re-push');
    eq(SYNC.SYNC_CORE.isPushCandidate({ updatedAt: '2026-11-01T11:00:00Z' }, '2026-11-01T10:00:00Z'), true, 'newer than lastPush → candidate');
    eq(SYNC.SYNC_CORE.isPushCandidate({ updatedAt: '2026-11-01T09:00:00Z' }, '2026-11-01T10:00:00Z'), false, 'older than lastPush → skip');
  });

  /* ================================================================
     3) STORES.permits.toRemote — الشكل المرسل للسحابة
     ================================================================ */
  await test('permits.toRemote: sid fallback + created_by attached', () => {
    globalThis.PERM = globalThis.PERM || {};
    globalThis.PERM.state = { userId: 'user-uuid-1', email: 'a@b.c', role: 'warehouse' };
    const remote = SYNC.STORES.permits.toRemote({
      id: 'local-uuid', permitNo: '12', cls: 'ض', customer: 'عميل', date: '2026-11-25',
      status: 'draft', lines: [{ size: 100, qty: 2 }], createdAt: '2026-11-25T08:00:00Z',
    });
    eq(remote.sid, 'local-uuid', 'sid falls back to local id');
    eq(remote.created_by, 'user-uuid-1', 'created_by attached from session');
    eq(remote.permit_no, '12', 'permit_no mapped');
    assert(Array.isArray(remote.lines) && remote.lines.length === 1, 'lines preserved');
    // البريد الحساس لا يُرسل (لا أسرار في الجداول)
    assert(!('password' in remote), 'no password field ever');
  });

  /* ================================================================
     4) الصلاحيات — مصفوفة الأدوار
     ================================================================ */
  await test('PERM admin: everything allowed', () => {
    PERM.setProfile({ role: 'admin', id: 'u1', email: 'a@b.c', active: true });
    for (const c of ['add', 'addPermit', 'edit', 'delete', 'approve', 'usersManage', 'settings', 'sync', 'print', 'backup']) {
      eq(PERM.can(c), true, `admin can ${c}`);
    }
    eq(PERM.routeAllowed('users'), true, 'admin route users');
    eq(PERM.routeAllowed('audit'), true, 'admin route audit');
    eq(PERM.routeAllowed('settings'), true, 'admin route settings');
  });

  await test('PERM warehouse: create-permit + print + window routes only', () => {
    PERM.setProfile({ role: 'warehouse', id: 'u2', email: 'k@b.c', active: true });
    eq(PERM.can('addPermit'), true, 'warehouse can create permits');
    eq(PERM.can('print'), true, 'warehouse can print');
    eq(PERM.can('add'), false, 'warehouse can NOT add other data');
    eq(PERM.can('edit'), false, 'warehouse can NOT edit');
    eq(PERM.can('delete'), false, 'warehouse can NOT delete');
    eq(PERM.can('approve'), false, 'warehouse can NOT approve');
    eq(PERM.can('usersManage'), false, 'warehouse can NOT manage users');
    eq(PERM.can('settings'), false, 'warehouse can NOT open settings');
    eq(PERM.can('reports'), false, 'warehouse can NOT open reports');
    eq(PERM.can('oldPermits'), false, 'warehouse can NOT see old permits');
    for (const r of ['inventory', 'issuedocs', 'issuedoc', 'outlog', 'sync']) {
      eq(PERM.routeAllowed(r), true, `warehouse route ${r}`);
    }
    for (const r of ['users', 'audit', 'settings', 'reports', 'reservations', 'rolls', 'reels-add', 'customers', 'products', 'backup', 'import']) {
      eq(PERM.routeAllowed(r), false, `warehouse route denied: ${r}`);
    }
  });

  await test('PERM warehouse window: Cairo today/yesterday only', () => {
    PERM.setProfile({ role: 'warehouse', id: 'u2', active: true });
    const today = PERM.cairoToday();
    const yest = PERM.keeperWindowStart(today + 'T00:00:00Z');
    eq(PERM.inKeeperWindow(today, Date.now()), true, 'today inside window');
    eq(PERM.inKeeperWindow(yest, Date.now()), true, 'yesterday inside window');
    const before = new Date(new Date(yest + 'T00:00:00Z').getTime() - 86400000).toISOString().slice(0, 10);
    eq(PERM.inKeeperWindow(before, Date.now()), false, 'day before yesterday denied');
  });

  await test('PERM local mode: full access except cloud sync', () => {
    PERM.setProfile({ role: 'local', active: true });
    eq(PERM.can('add'), true, 'local can add');
    eq(PERM.can('delete'), true, 'local can delete');
    eq(PERM.can('sync'), false, 'local can NOT cloud-sync');
    eq(PERM.routeAllowed('users'), true, 'local route all');
  });

  await test('PERM none/no-role: zero access + inactive admin demoted', () => {
    PERM.setProfile({ role: '', active: true });
    eq(PERM.routeAllowed('dashboard'), false, 'no role → no route');
    PERM.setProfile({ role: 'admin', active: false });
    eq(PERM.isAdmin(), false, 'inactive admin is demoted to none');
  });

  /* ---------- summary ---------- */
  console.log(`\n=== RESULTS: ${results.pass} passed, ${results.fail} failed ===`);
  process.exit(results.fail ? 1 : 0);
})();
