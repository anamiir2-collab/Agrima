# Agrima v9 — Full Technical & Functional Audit (Phase 1)

**Audited version:** v8-reservations-r3 (commit `41f2778`, the live GitHub Pages build)
**Audit date:** November 2026
**Method:** complete source reading of every file (`index.html`, `css/*`, all 12 `js/*` modules, `sw.js`, `manifest.json`, README, DELIVERY_REPORT) + reproducible runtime verification in a real Chromium session against a fresh local install (`python -m http.server`, agent-browser automation). Every bug listed below was confirmed in code **and** (where runtime-relevant) reproduced in the browser. No claim of breakage is made without evidence.

---

## 1. Architecture as found (documented before any change)

| Layer | File | Role |
| --- | --- | --- |
| Balance engine | `js/calculations.js` (`CALC`) | Faithful re-implementation of the Excel SUMIFS: balance = Σ(اضافه − صرف) grouped by (product, GSM, size), plus a roll-weight dimension `comboKeyW` and weight estimate `size × balance × 7.5`. No opening-balance record type; opening balances are ordinary rows with customer «رصيد اول المدة». |
| Storage | `js/database.js` (`DB`) | IndexedDB `inventory_pwa_db` **v2**: `products, transactions, audit, settings, rolls, reels, permits, customers, importlog`. Generic helpers + `bulkPut` + `atomic(storeNames, workFn)` (single readwrite transaction across stores). Upgrade path is strictly additive. |
| State & router | `js/app.js` (`App`) | In-memory snapshot (`products, transactions, permits, balances, balancesW, settings`), hash router with legacy redirects, movement tables, dashboard, customers view, safe one-time migrations, SW registration, boot error screen. |
| Movements/documents | `js/transactions.js` (`TX`) | Validation, audit log, grouped movements, tax/non-tax sequences (`docSeqTax`/`docSeqNontax`), availability gates (W-dim for legacy vouchers, 3-dim + per-reel for permits), draft→approve permits, rolls & reels registration (`saveRollWithReels` = one atomic tx inserting roll + reels + one production movement per reel). |
| UI shells | `js/ui.js` (`UI`) | i18n (ar/en), toasts, modals, confirm dialog, EventBus, SVG icons. |
| Modules | `rolls.js`, `inventory.js`, `issuedocs.js`, `reservations.js`, `reports.js`, `excel.js`, `backup.js` | Reel registration/management; inventory & products; permits + voucher collector `collectVouchers`; tracking-only reservations (LocalStorage, by design); 9 A4 paginated reports; SheetJS import/export; JSON backup/restore + settings. |
| PWA | `sw.js`, `manifest.json`, `index.html` | Precache of every asset with relative paths (subpath-safe), stale-while-revalidate for assets, network-first navigations, `?v=` cache-busting consistent with the SW cache name. |

Verified on a fresh install: **0 console errors / 0 page errors across all 19 routes**, service worker registers, manifest valid, all assets 200.

---

## 2. Verified bugs (each reproduced or proven in code)

| # | Severity | Where | Finding (verified) |
| --- | --- | --- | --- |
| V1 | **High** | `excel.js commitImport` → `DB.wipeAll()` | **“Import & replace” deletes far more than it announces.** The confirm dialog mentions only movements+products, but `wipeAll()` also clears `rolls`, `reels`, `permits`, `customers`, `importlog` — silently destroying roll/reel details and permits. |
| V2 | **Medium** | `js/app.js renderDashboard` vs `js/inventory.js` | **Dashboard stock total doesn’t reconcile with the Inventory screen / Warehouse report.** Dashboard sums `net` over all *product-master* rows **including negative buckets**; Inventory sums positive nets over **all transaction combos**. With any negative bucket (e.g. −3) the two screens show different “total balance”. The dashboard’s estimated weight can also go **negative**. |
| V3 | **Medium** | `js/ui.js I18N` + `index.html` + `js/app.js navigate()` | **i18n key collision on `rolls`.** `I18N.ar.rolls = 'بكرة'` (the *unit*) overwrites the nav label «إدارة الرولات والبكر» after any language switch (reproduced: sidebar shows “🔄بكرة”). `document.title` for `#rolls` likewise reads «بكرة — …». |
| V4 | **Medium** | `js/app.js navigate()` | **Wrong document titles for dashed routes**: `#reels-add`, `#issuedoc`, `#reservation-details`, `#reservation-form`, `#baker-issue`, `#addtx` render raw route ids (“reels-add — Agrima…”) because `t(route)` has no matching key. |
| V5 | **Medium** | `js/app.js txForm` submit | **Legacy mixed-movement editor is non-atomic**: `for (const line of pending) await TX.addTransaction(...)` — a failure mid-loop leaves a partial movement (rows 1..k saved, rest lost). Grouped *replace/delete* are atomic; group *create* is not. |
| V6 | **Medium** | `js/backup.js restoreBackup` | **Restore validates almost nothing**: only `app` tag + `transactions` array. Corrupted/foreign row shapes inside any store are written as-is and later break rendering screens; unknown top-level keys are dropped without mention. |
| V7 | **Low-Med** | `js/issuedocs.js collectVouchers` | **Permit weight differs between list and print**: approved permits whose lines carry a manual bale weight show «تقديري/est.» in the list (only `lines[].weightKg` from selected reels is summed), while the printed A4 doc correctly sums `line.weight × qty` — the same permit shows two different weights. |
| V8 | **Low** | `js/app.js` (~lines 496–799) | **Dead duplicate implementation**: a second `bakerIssueForm` + `baker-issue` view registration silently overridden by `issuedocs.js`. ~300 lines of conflicting legacy logic shipped in the bundle and SW precache. |
| V9 | **Low** | `js/app.js txTable` edit handler | **Blank English toast**: `toast(lang ? '…' : '', 'info')` shows an empty toast for English users on reel-sourced movements. |
| V10 | **Low** | `js/issuedocs.js` voucher picker | Awkward English micro-copy “no no.” for permits without a number. |
| V11 | **Info** | `js/app.js editCustomer` | Dead variable (`const rec = isNew ? null : null;`) — cosmetic. |
| V12 | **Info** | `js/transactions.js saveRollWithReels` | Unreachable internal `fail()` helper (abort-with-message path never invoked); uniqueness is actually enforced by the `rollNo` unique index. Cosmetic. |

### Things inspected and found **correct** (no fix applied)

- **Balance engine** matches the Excel SUMIFS contract; `round6` dust removal present; roll-weight dimension intentionally separate (never merged into the warehouse report).
- **No double-counting of stock**: imported detail reels are stored `status:'undefined'` with **no movement rows**; reel registration creates exactly **one** movement per reel (verified: 3 reels → 3 movement rows, all `source:'reels'`, unique `rollReel` index); dispatched reels stay excluded from availability (`findAvailableReels` filters `available`; approval gates reject re-dispatch).
- **Permit lifecycle**: drafts write no rows (verified: balances unchanged after draft save); approval is one atomic tx with duplicate-number gate, availability gate and reel flip; edit re-approves through the same gates; delete restores rows + frees reels; tax/non-tax sequences independent and persisted (`docSeqTax`/`docSeqNontax` + self-healing from history).
- **Reservations module**: provably write-free (no TX write call anywhere in the module); FCFS allocation recomputed from live data; per-line consumption keys prevent double counting; corrupt LocalStorage falls back safely.
- **Reports**: all 9 `totalsRow` arrays align with their headers; A4 pagination probe measured correctly; signatures/totals only on the last page; zero-hiding is consistent screen/Excel.
- **PWA/offline**: SW precache complete, relative paths (GitHub-Pages subpath safe), versioned cache + SKIP_WAITING flow, manifest icons present.
- **Excel import**: file fingerprint blocks re-import of the same file; duplicate detection via fingerprints; tons→kg unit conversion audited and one-shot.

---

## 3. Missing functions / gaps (filled in v9)

1. No **Suppliers** store or UI.
2. No **Purchase invoices** (draft / partial / received / cancelled), no multi-line purchase documents, no supplier-invoice duplicate protection.
3. No **receiving links** between purchase invoices and registered reels.
4. No **supplier returns** workflow (return documents, reel-status reversal, traceable movements).
5. No **purchase/supplier reports** (by date, supplier, product, GSM/size, history, returns, outstanding balances).
6. Backup schema 3 does not cover any procurement data.
7. DB v2 has no stores for any of the above.

---

## 4. Performance notes

- `loadAll()` rescans all transactions on every refresh (~24k rows in the real dataset) and rebuilds two balance maps — measured < 1 s locally; acceptable for an offline-first local app, unchanged by v9 (procurement data is kept in separate stores so inventory scans stay the same size).
- Heavy lists are paginated (120 groups / 60 vouchers / 40 rolls per page); reports measure page capacity with a DOM probe rather than fixed constants.
- Chart instances are destroyed before re-creation (no canvas leak).

---

## 5. Disposition

All confirmed defects V1–V10 are fixed in v9 (see `DELIVERY_REPORT.md` § “Fixed bugs”); V11–V12 cleaned up in passing. No feature, record, calculation or historical transaction was removed; DB v2 → v3 migration is strictly additive; LocalStorage keys and reservation data are untouched.
