/* =========================================================================
   issuedocs.js — أذون الصرف: قائمة مجمّعة بإذن واحد لكل رقم + عرض احترافي A4
   -------------------------------------------------------------------------
   A voucher (إذن صرف) is ONE commercial document. Its identity is
   (permitNo, classification, customer) — never the displayed number alone —
   so a customer can never be mixed with another and tax/non-tax stay
   separate. App-saved documents carry one groupId; legacy Excel-imported
   vouchers are many independent rows sharing the same identity, and they
   are grouped here into a single voucher entry whose details keep every
   original measurement. Duplicate (product, GSM, roll weight, size) lines
   inside one voucher are combined by summing quantities — totals are always
   computed from the raw rows. The snapshot is the STORED rows themselves,
   so later inventory changes never alter an already-saved voucher.
   ========================================================================= */
(function (global) {
  'use strict';
  const { t, el, esc, fmtNum, fmtDate, toast, confirmDialog } = global.UI;
  const App = global.App;
  const lang = () => global.UI.getLang() === 'ar';
  const familyOf = (name) => App.productFamily(name);
  const CLS_LABEL = global.TX.CLS_LABEL; /* 'ض' → ضريبي / 'غ' → غير ضريبي */

  /* ---------------- voucher collector ----------------
     one voucher per (permitNo + classification + customer); rows without a
     permit number keep the old movement grouping (groupId / single row) */
  function collectIssueDocs(transactions) {
    const outRows = transactions.filter((r) => (Number(r.outQty) || 0) > 0 && !r.void);
    /* groupIds that also carry production (add) rows are mixed movements —
       they must never be treated as a grouped voucher, otherwise editing or
       deleting the voucher would wipe their production rows */
    const groupHasAdd = new Set();
    for (const r of transactions) {
      if (r.groupId && (Number(r.addQty) || 0) > 0) groupHasAdd.add(r.groupId);
    }
    const map = new Map();
    for (const r of outRows) {
      const permit = String(r.permitNo || '').trim();
      const customer = App.canonicalCustomer(r.customer) || r.customer || '';
      const cls = (r.settlement === 'ض' || r.settlement === 'غ') ? r.settlement : '';
      const key = permit
        ? 'V|' + cls + '|' + permit + '|' + customer
        : (r.groupId ? 'G:' + r.groupId : 'S:' + (r.id || 0));
      let g = map.get(key);
      if (!g) {
        g = {
          key,
          groupId: r.groupId || null, /* set below when ALL rows share one group */
          legacyId: permit ? null : (r.groupId ? null : r.id),
          permitNo: permit,
          customer,
          classification: cls,
          settlement: r.settlement,
          notes: r.notes || '',
          source: r.source,
          rows: [],
          rowIds: [],
        };
        map.set(key, g);
      }
      g.rows.push(r);
      if (r.id != null) g.rowIds.push(r.id);
    }
    const vouchers = [...map.values()];
    for (const g of vouchers) {
      /* grouped document only when every row belongs to one groupId AND that
         group carries no production rows (mixed movements stay legacy) */
      if (g.groupId && (!g.rows.every((r) => r.groupId === g.groupId) || groupHasAdd.has(g.groupId))) {
        g.groupId = null;
      }
      /* Latest date wins when the same permit identity was reused.
         Keep only rows belonging to that latest date; older reused-number
         entries must not inflate the current voucher totals. */
      g.date = g.rows.reduce((latest, row) =>
        String(row.date || '') > String(latest || '') ? row.date : latest, '');
      g.rows = g.rows.filter((row) => String(row.date || '') === String(g.date || ''));
      g.rowIds = g.rows.map((row) => row.id).filter((id) => id != null);
      /* dominant notes */
      const notes = new Map();
      for (const r of g.rows) { const n = String(r.notes || '').trim(); if (n) notes.set(n, (notes.get(n) || 0) + 1); }
      if (notes.size) g.notes = [...notes.entries()].sort((a, b) => b[1] - a[1])[0][0];
      /* sub-groups: one table per (product, gsm, roll weight); same size
         lines inside one voucher are combined by summing quantities */
      const subMap = new Map();
      for (const r of g.rows) {
        const key = global.CALC.comboGroupWOf(r); /* (product, gsm, weight) */
        if (!subMap.has(key)) {
          subMap.set(key, { quality: r.quality, family: familyOf(r.quality), gsm: r.gsm, weight: r.weight, sizes: [], sizeMap: new Map() });
        }
        const sg = subMap.get(key);
        const sk = String(r.size);
        const cur = sg.sizeMap.get(sk);
        const qty = Number(r.outQty) || 0;
        if (cur) cur.qty = global.CALC.round6(cur.qty + qty);
        else { const line = { size: r.size, qty, ids: [r.id] }; sg.sizeMap.set(sk, line); sg.sizes.push(line); }
      }
      g.docGroups = [...subMap.values()].map((sg) => {
        delete sg.sizeMap;
        sg.sizes.sort((a, b) => (Number(a.size) || 0) - (Number(b.size) || 0));
        sg.total = sg.sizes.reduce((s, x) => s + x.qty, 0);
        sg.totalWeight = sg.weight != null ? global.CALC.round6(sg.total * Number(sg.weight)) : null;
        return sg;
      });
      g.docGroups.sort((a, b) => String(a.family).localeCompare(String(b.family), 'ar') ||
        (Number(a.gsm) || 0) - (Number(b.gsm) || 0) ||
        ((a.weight == null ? -1 : a.weight) - (b.weight == null ? -1 : b.weight)));
      g.totalRolls = g.docGroups.reduce((s, sg) => s + sg.total, 0);
      /* voucher weight = Σ (bales × roll weight) over rows that carry a weight */
      const wKnown = g.docGroups.reduce((s, sg) => s + (sg.totalWeight || 0), 0);
      const wUnknown = g.rows.filter((r) => r.weight == null || r.weight === '').length;
      g.totalWeight = wKnown > 0 || wUnknown === 0 ? global.CALC.round6(wKnown) : null;
      g.totalWeightPartial = wUnknown > 0 && wKnown > 0;
      g.minId = g.rowIds.length ? Math.min(...g.rowIds) : 0;
    }
    return vouchers;
  }
  App.collectIssueDocs = collectIssueDocs;

  const clsBadge = (cls) => {
    if (!cls) return `<span class="muted small">—</span>`;
    return `<span class="badge ${cls === 'ض' ? 'badge-tax' : 'badge-nontax'}">${CLS_LABEL[cls]}</span>`;
  };

  /* ================= أذون الصرف — list page ================= */
  function renderIssuedocs(host) {
    host.innerHTML = `
      <div class="page-head"><h2>${esc(t('issuedocs'))}</h2>
        <div class="head-actions">
          <button class="btn btn-primary" id="docs-new">+ ${lang() ? 'إذن صرف جديد' : 'New issue document'}</button>
          <button class="btn btn-ghost" id="docs-exp">${t('exportExcel')}</button>
        </div></div>
      <div class="card filters">
        <input type="text" id="doc-q" placeholder="${lang() ? 'بحث برقم الإذن أو اسم العميل…' : 'Search voucher no. / customer…'}">
        <input type="date" id="doc-from" title="${t('from')}">
        <input type="date" id="doc-to" title="${t('to')}">
        <select id="doc-cls">
          <option value="">${t('classification')}: ${t('all')}</option>
          <option value="ض">${t('tax')}</option>
          <option value="غ">${t('nontax')}</option>
        </select>
        <select id="doc-sort">
          <option value="new">${t('newest')}</option>
          <option value="old">${t('oldest')}</option>
        </select>
        <button class="btn btn-ghost" id="doc-clear">${t('reset')}</button>
      </div>
      <div class="card table-wrap" id="doc-table-host"></div>`;

    let docs = [], page = 0;
    const PAGE_SIZE = 60;

    function applyFilters() {
      const q = host.querySelector('#doc-q').value.trim().toLowerCase();
      const from = host.querySelector('#doc-from').value;
      const to = host.querySelector('#doc-to').value;
      const cls = host.querySelector('#doc-cls').value;
      const sort = host.querySelector('#doc-sort').value;
      docs = collectIssueDocs(App.state.transactions).filter((d) =>
        (!from || d.date >= from) && (!to || d.date <= to) &&
        (!cls || d.classification === cls) &&
        (!q || String(d.permitNo || '').toLowerCase().includes(q) || String(d.customer || '').toLowerCase().includes(q)));
      docs.sort((a, b) => {
        const ta = `${a.date}|${a.minId || 0}`, tb = `${b.date}|${b.minId || 0}`;
        const cmp = ta < tb ? 1 : ta > tb ? -1 : 0; /* newest first */
        return sort === 'old' ? -cmp : cmp;
      });
      page = 0;
      renderRows();
    }

    function renderRows() {
      const host2 = host.querySelector('#doc-table-host');
      const total = docs.length;
      const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      if (page >= pages) page = pages - 1;
      if (page < 0) page = 0;
      const slice = docs.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
      const rolls = docs.reduce((s, d) => s + d.totalRolls, 0);
      const weights = docs.reduce((s, d) => s + (d.totalWeight || 0), 0);
      host2.innerHTML = `
        <table class="data-table">
          <thead><tr>
            <th>${t('docNo')}</th><th>${t('customer')}</th><th>${t('date')}</th>
            <th>${t('classification')}</th>
            <th class="num">${t('totalRolls')}</th><th class="num">${t('voucherWeight')}</th>
            <th>${t('actions')}</th>
          </tr></thead>
          <tbody>${slice.length ? slice.map(docRowHtml).join('') :
            `<tr><td colspan="7" class="empty">${lang() ? 'لا توجد أذون صرف مطابقة' : 'No matching issue documents'}</td></tr>`}</tbody>
          <tfoot><tr>
            <td colspan="4">${t('total')} (${fmtNum(total)} ${lang() ? 'إذن' : 'vouchers'})</td>
            <td class="num">${fmtNum(rolls)}</td>
            <td class="num">${fmtNum(weights, 3)}</td><td></td>
          </tr></tfoot>
        </table>
        ${pages > 1 ? `<div class="pager">
          <button class="btn btn-ghost" id="dpg-prev" ${page === 0 ? 'disabled' : ''}>‹</button>
          <span>${t('page')} ${page + 1} / ${fmtNum(pages)}</span>
          <button class="btn btn-ghost" id="dpg-next" ${page >= pages - 1 ? 'disabled' : ''}>›</button>
        </div>` : ''}`;

      host2.querySelectorAll('[data-act]').forEach((btn) => btn.addEventListener('click', async () => {
        const doc = docs.find((d) => d.key === btn.dataset.key);
        if (!doc) return;
        const act = btn.dataset.act;
        if (act === 'view') {
          App.pendingDoc = doc; App.autoPrintDoc = false;
          App.navigate('issuedoc');
        } else if (act === 'print') {
          App.pendingDoc = doc; App.autoPrintDoc = true;
          App.navigate('issuedoc');
        } else if (act === 'edit') {
          App.pendingEdit = doc;
          App.navigate('baker-issue');
        } else if (act === 'del') {
          const ok = await confirmDialog({
            title: lang() ? 'حذف إذن الصرف' : 'Delete issue voucher',
            message: lang()
              ? `سيتم حذف الإذن "${doc.permitNo || 'بدون رقم'}" بكل أسطره (${doc.rows.length} مقاس — ${fmtNum(doc.totalRolls)} بكرة) نهائيًا، وستُعاد كمياته إلى الرصيد تلقائيًا.\nالعميل: ${doc.customer} — التاريخ: ${fmtDate(doc.date)}`
              : `Delete voucher "${doc.permitNo || ''}" permanently (${doc.rows.length} sizes — ${fmtNum(doc.totalRolls)} bales)? Its quantities are restored to stock automatically.`,
            danger: true,
            extra: lang() ? `<code>${esc(doc.date)} — ${esc(doc.customer)}</code>` : '',
          });
          if (ok) {
            await global.TX.deleteIssueVoucher(doc);
            toast(lang() ? 'تم حذف الإذن وإعادة الكميات إلى الرصيد' : 'voucher deleted, quantities restored', 'ok');
            await App.refresh();
          }
        }
      }));
      const bind = (id, fn) => { const b = host2.querySelector(id); if (b) b.addEventListener('click', () => { fn(); renderRows(); }); };
      bind('#dpg-prev', () => { page--; });
      bind('#dpg-next', () => { page++; });
    }

    function docRowHtml(d) {
      const weightCell = d.totalWeight == null
        ? '<span class="muted">—</span>'
        : (d.totalWeightPartial
          ? `${fmtNum(d.totalWeight, 3)} <span class="muted small">+${lang() ? 'أسطر بلا وزن' : 'weightless lines'}</span>`
          : fmtNum(d.totalWeight, 3));
      return `<tr class="voucher-row">
        <td data-label="${t('docNo')}"><button class="voucher-no" data-act="view" data-key="${esc(d.key)}" title="${t('viewDoc')}">${esc(d.permitNo || '—')}</button>${d.rows.length > 1 ? `<span class="badge badge-multi" title="${lang() ? 'عدد المقاسات داخل الإذن' : 'sizes in this voucher'}">${fmtNum(d.docGroups.reduce((s, sg) => s + sg.sizes.length, 0))} ${lang() ? 'مقاسات' : 'sizes'}</span>` : ''}</td>
        <td data-label="${t('customer')}">${esc(d.customer || '')}</td>
        <td data-label="${t('date')}">${fmtDate(d.date)}</td>
        <td data-label="${t('classification')}">${clsBadge(d.classification)}</td>
        <td class="num" data-label="${t('totalRolls')}"><strong>${fmtNum(d.totalRolls)}</strong></td>
        <td class="num" data-label="${t('voucherWeight')}">${weightCell}</td>
        <td class="actions-cell">
          <button class="icon-btn" data-act="view" data-key="${esc(d.key)}" title="${t('viewDoc')}">👁</button>
          <button class="icon-btn" data-act="print" data-key="${esc(d.key)}" title="${t('printDoc')}">🖨</button>
          <button class="icon-btn" data-act="edit" data-key="${esc(d.key)}" title="${t('edit')}">✎</button>
          <button class="icon-btn danger" data-act="del" data-key="${esc(d.key)}" title="${t('del')}">🗑</button>
        </td></tr>`;
    }

    host.querySelector('#doc-q').addEventListener('input', applyFilters);
    host.querySelector('#doc-from').addEventListener('change', applyFilters);
    host.querySelector('#doc-to').addEventListener('change', applyFilters);
    host.querySelector('#doc-cls').addEventListener('change', applyFilters);
    host.querySelector('#doc-sort').addEventListener('change', applyFilters);
    host.querySelector('#doc-clear').addEventListener('click', () => {
      ['#doc-q', '#doc-from', '#doc-to', '#doc-cls'].forEach((s) => { host.querySelector(s).value = ''; });
      host.querySelector('#doc-sort').value = 'new';
      applyFilters();
    });
    host.querySelector('#docs-new').addEventListener('click', () => { App.pendingEdit = null; App.navigate('baker-issue'); });
    host.querySelector('#docs-exp').addEventListener('click', () => {
      const headers = [t('docNo'), t('customer'), t('date'), t('classification'), lang() ? 'الصنف' : 'Product',
        t('gsm'), t('rollWeight'), t('size'), t('outQty'), t('voucherWeight')];
      const rows = [];
      for (const d of docs) {
        for (const sg of d.docGroups) {
          for (const s of sg.sizes) {
            rows.push([d.permitNo || '', d.customer, d.date, d.classification ? CLS_LABEL[d.classification] : '',
              sg.family, sg.gsm == null ? '' : sg.gsm, sg.weight == null ? '' : sg.weight, s.size, s.qty,
              sg.weight != null ? global.CALC.round6(s.qty * Number(sg.weight)) : '']);
          }
        }
      }
      global.EXCEL.exportReportAOA(t('issuedocs'), headers, rows, null, 'اذون_الصرف');
      toast(lang() ? 'تم تنزيل ملف الإكسل' : 'Excel downloaded', 'ok');
    });

    applyFilters();
  }

  /* ================= إذن صرف — professional A4 voucher view ================= */
  function renderIssuedoc(host) {
    const d = App.pendingDoc;
    if (!d) { host.innerHTML = '<div class="card error-card">لم يتم تحديد إذن — ارجع إلى أذون الصرف.</div>'; return; }
    const company = App.state.settings.companyName || (lang() ? 'إدارة المخزن' : 'Inventory Management');

    /* One print table: quantity, size, GSM, product.
       Weight is calculated independently for each GSM, then converted kg→ton. */
    const printLines = new Map();
    for (const sg of d.docGroups) {
      const key = String(sg.family) + '||' + String(sg.gsm);
      let group = printLines.get(key);
      if (!group) {
        group = { family: sg.family, gsm: sg.gsm, bales: 0, weightKg: 0, sizes: new Map() };
        printLines.set(key, group);
      }
      for (const size of sg.sizes) {
        const sizeKey = String(size.size);
        const current = group.sizes.get(sizeKey) || { size: size.size, qty: 0 };
        current.qty += Number(size.qty) || 0;
        group.sizes.set(sizeKey, current);
        group.bales += Number(size.qty) || 0;
        if (sg.weight != null && sg.weight !== '') {
          group.weightKg += (Number(size.qty) || 0) * Number(sg.weight);
        }
      }
    }
    const printGroups = [...printLines.values()].sort((a, b) =>
      String(a.family).localeCompare(String(b.family), 'ar') ||
      (Number(a.gsm) || 0) - (Number(b.gsm) || 0));
    const printRows = printGroups.flatMap((group) =>
      [...group.sizes.values()].sort((a, b) => (Number(a.size) || 0) - (Number(b.size) || 0))
        .map((size) => [size.qty, size.size, group.gsm, group.family]));
    const printTable = `
      <table class="rp-table doc-issue-table">
        <thead><tr>
          <th>${lang() ? 'العدد' : 'Quantity'}</th>
          <th>${t('size')}</th>
          <th>${t('gsm')}</th>
          <th>${lang() ? 'الصنف' : 'Product'}</th>
        </tr></thead>
        <tbody>${printRows.map((row) => `<tr>
          <td>${fmtNum(row[0])}</td><td>${row[1] == null ? '—' : fmtNum(row[1])}</td>
          <td>${row[2] == null ? '—' : fmtNum(row[2])}</td><td>${esc(row[3] || '—')}</td>
        </tr>`).join('')}</tbody>
      </table>
      <table class="rp-table doc-gsm-totals">
        <thead><tr>
          <th>${lang() ? 'الجرام' : 'GSM'}</th>
          <th>${lang() ? 'إجمالي عدد البكر' : 'Total bales'}</th>
          <th>${lang() ? 'إجمالي الوزن (طن)' : 'Total weight (tons)'}</th>
        </tr></thead>
        <tbody>${printGroups.map((group) => `<tr>
          <td>${group.gsm == null ? '—' : fmtNum(group.gsm)}</td>
          <td>${fmtNum(group.bales)}</td>
          <td>${fmtNum(group.weightKg / 1000, 4)}</td>
        </tr>`).join('')}</tbody>
      </table>`;

    const totalBales = printGroups.reduce((sum, group) => sum + group.bales, 0);
    const totalWeightTons = printGroups.reduce((sum, group) => sum + group.weightKg, 0) / 1000;
    const weightNote = d.rows.some((row) => row.weight == null || row.weight === '')
      ? `<div class="doc-notes muted">${lang()
        ? 'ملاحظة: الوزن بالطن تقديري ولا يشمل أي أسطر لا يتوفر لها وزن البكرة.'
        : 'Note: tonnage is estimated and excludes lines without a recorded bale weight.'}</div>` : '';

    host.innerHTML = `
      <div class="page-head"><h2>${esc(t('issuedoc'))} ${d.permitNo ? '— ' + esc(d.permitNo) : ''}</h2>
        <div class="head-actions doc-actions">
          <button class="btn btn-primary" id="docv-print">🖨 ${t('printDoc')} (A4)</button>
          <button class="btn btn-ghost" id="docv-edit">✎ ${t('edit')}</button>
          <button class="btn btn-ghost" id="docv-back">${lang() ? '← رجوع لأذون الصرف' : '← Back'}</button>
        </div></div>
      <div id="print-root">
        <div class="print-page doc-page">
          <div class="rp-head">
            <div class="rp-co">${esc(company)}</div>
            <div class="rp-title">${lang() ? 'إذن صرف مخزني' : 'Stock Issue Voucher'}</div>
            <div class="rp-sub"><div>${t('docNo')}: <strong>${esc(d.permitNo || '—')}</strong> — ${t('classification')}: <strong>${d.classification ? CLS_LABEL[d.classification] : '—'}</strong></div></div>
          </div>
          <table class="doc-meta">
            <tbody><tr>
              <th>${t('customer')}</th><td>${esc(d.customer || '—')}</td>
              <th>${t('date')}</th><td>${fmtDate(d.date)}</td>
            </tr></tbody>
          </table>
          ${printTable}
          <table class="rp-table doc-total">
            <tbody>
              <tr><td class="doc-total-label">${t('totalRolls')}</td><td class="doc-total-num">${fmtNum(totalBales)} ${t('rolls')}</td></tr>
              <tr><td class="doc-total-label">${lang() ? 'إجمالي الوزن (طن)' : 'Total weight (tons)'}</td><td class="doc-total-num">${fmtNum(totalWeightTons, 4)}</td></tr>
            </tbody>
          </table>
          ${d.notes ? `<div class="doc-notes">${t('notes')}: ${esc(d.notes)}</div>` : ''}
          ${weightNote}
          <div class="rp-foot">
            <div class="sig-row">
              <div class="sig"><span>${t('deliverer')}</span><i></i></div>
              <div class="sig"><span>${t('receiver')}</span><i></i></div>
            </div>
          </div>
        </div>
      </div>`;

    host.querySelector('#docv-print').addEventListener('click', () => window.print());
    host.querySelector('#docv-edit').addEventListener('click', () => {
      App.pendingEdit = d; App.navigate('baker-issue');
    });
    host.querySelector('#docv-back').addEventListener('click', () => App.navigate('issuedocs'));
    if (App.autoPrintDoc) {
      App.autoPrintDoc = false;
      setTimeout(() => window.print(), 350); /* let fonts/layout settle */
    }
  }

  App.registerView('issuedocs', renderIssuedocs);
  App.registerView('issuedoc', renderIssuedoc);
})(typeof window !== 'undefined' ? window : globalThis);
