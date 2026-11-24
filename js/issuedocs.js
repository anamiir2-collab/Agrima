/* =========================================================================
   issuedocs.js — أذون الصرف: مسودة ← اعتماد، اختيار البكر، تجميع المتكرر
   -------------------------------------------------------------------------
   القواعد المنفذة هنا:
   • الإذن مستند مستقل (رقم، نوع ضريبي/غير ضريبي بتسلسلين مستقلين، عميل،
     تاريخ، تفاصيل، عدد البكر، الوزن، ملاحظات، حالة الإذن معتمد/مسودة).
   • الحفظ كمسودة لا يخصم شيئًا؛ الاعتماد يتحقق من الرصيد ومن حالة كل بكرة
     (منع صرف بكرة مرتين) ويخصم ذريًا مع تحديث حالتها إلى «مصروفة».
   • جدول الإذن بترتيب إلزامي: العدد | المقاس | الجرام | الصنف، ونهايته
     إجمالي عدد البكر + إجمالي الوزن. الأوزان الفعلية من البكر المحددة،
     وإلا وزن الحركة الأصلي، وإلا وزن تقديري مُميّز بوضوح.
   • الأذون المستوردة (من انتاج و مبيعات) تُجمع تحت إذن واحد لكل
     (رقم + تصنيف + عميل) مع جمع كل المقاسات والكميات، اعتماد أحدث تاريخ
     والاحتفاظ بكل الأسطر. اختلاف العميل لنفس الرقم والتصنيف = تعارض
     يُعرض للمراجعة ولا يُدمج تلقائيًا. التكرار بين ضريبي وغير ضريبي
     يُعالج بشكل مستقل.
   • الطباعة من اللقطة المحفوظة نفسها (لا تتأثر بتغييرات لاحقة للمخزون)،
     والمسودة تُطبع بعلامة «مسودة — غير معتمدة».
   ========================================================================= */
(function (global) {
  'use strict';
  const { t, el, esc, fmtNum, fmtDate, todayISO, toast, confirmDialog, openModal, closeModal } = global.UI;
  const App = global.App;
  const lang = () => global.UI.getLang() === 'ar';
  const ar = lang;
  const familyOf = (name) => App.productFamily(name);
  const CLS_LABEL = global.TX.CLS_LABEL;
  const P_PREFIX = global.TX.PERMIT_GROUP_PREFIX;

  /* ================= voucher collector ================= */
  /**
   * موحّد العرض: أذون التطبيق (مسودات ومعتمدة) + الأذون المشتقة من الحركات.
   * كل عنصر شكل موحد للقائمة والعرض والطباعة.
   */
  function collectVouchers(transactions, permits) {
    const out = [];
    const permitGroupIds = new Set();
    for (const p of permits || []) {
      if (p.groupId) permitGroupIds.add(p.groupId);
      const lines = (p.lines || []).map((l) => ({
        quality: l.quality, family: familyOf(l.quality),
        gsm: l.gsm, weight: l.weight || null, size: l.size,
        qty: Number(l.qty) || 0,
        reelCount: (l.reelIds || []).length,
        reelIds: l.reelIds || [],
        weightKg: l.weightKg != null ? l.weightKg : null,
        weightEstimated: l.weightKg == null && !(l.reelIds || []).length && !(Number(l.weight) > 0),
      }));
      const totalRolls = lines.reduce((s, l) => s + l.qty, 0);
      const knownWeight = lines.some((l) => l.weightKg != null);
      /* الوزن من اللقطة المعتمدة نفسها (p.totals) إن وُجد — نفس ما تطبعه
           الشاشة، لا تناقص بين القائمة والطباعة للأوزان اليدوية (audit V7) */
      const approvedTotals = (p.status === 'approved' && p.totals) ? p.totals : null;
      const totalWeightKg = approvedTotals && approvedTotals.weightKg != null
        ? global.CALC.round6(approvedTotals.weightKg)
        : (knownWeight
          ? global.CALC.round6(lines.reduce((s, l) => s + (l.weightKg || 0), 0))
          : null);
      out.push({
        key: 'PT|' + p.id,
        kind: 'permit',
        permitId: p.id,
        status: p.status,
        permitNo: p.permitNo,
        cls: p.cls || '',
        customer: p.customer,
        date: p.date,
        notes: p.notes || '',
        dateFrom: p.date, dateTo: p.date,
        lines,
        rows: [],
        rowIds: [],
        groupId: p.groupId || null,
        source: p.source || 'permit',
        totalRolls,
        totalWeightKg,
        weightEstimated: approvedTotals ? !!approvedTotals.weightEstimated
          : (totalWeightKg == null && totalRolls > 0),
        minId: 0,
        createdAt: p.createdAt,
      });
    }
    /* derived vouchers from movement rows (imported + old app-saved) */
    const outRows = transactions.filter((r) => (Number(r.outQty) || 0) > 0 && !r.void && !permitGroupIds.has(r.groupId));
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
        ? 'DV|' + cls + '|' + permit + '|' + customer
        : (r.groupId ? 'DG:' + r.groupId : 'DS:' + (r.id || 0));
      let g = map.get(key);
      if (!g) {
        g = {
          key, kind: 'derived', permitId: null, status: 'approved',
          groupId: r.groupId || null,
          legacyId: permit ? null : (r.groupId ? null : r.id),
          permitNo: permit, customer, cls,
          notes: r.notes || '', source: r.source,
          rows: [], rowIds: [], dates: new Set(),
        };
        map.set(key, g);
      }
      g.rows.push(r);
      if (r.id != null) g.rowIds.push(r.id);
      if (r.date) g.dates.add(r.date);
    }
    const derived = [...map.values()];
    for (const g of derived) {
      if (g.groupId && (!g.rows.every((r) => r.groupId === g.groupId) || groupHasAdd.has(g.groupId))) {
        g.groupId = null;
      }
      /* أحدث تاريخ عند تكرار الرقم — مع الاحتفاظ بكل الأسطر */
      g.date = [...g.dates].sort().pop() || '';
      g.multiDate = g.dates.size > 1;
      const notes = new Map();
      for (const r of g.rows) { const n = String(r.notes || '').trim(); if (n && !/^رول \d+/.test(n)) notes.set(n, (notes.get(n) || 0) + 1); }
      if (notes.size) g.notes = [...notes.entries()].sort((a, b) => b[1] - a[1])[0][0];
      /* sub-groups: (product, gsm, roll-weight) — same sizes combined */
      const subMap = new Map();
      for (const r of g.rows) {
        const key = global.CALC.comboGroupWOf(r);
        if (!subMap.has(key)) subMap.set(key, { quality: r.quality, family: familyOf(r.quality), gsm: r.gsm, weight: r.weight, sizes: [], sizeMap: new Map() });
        const sg = subMap.get(key);
        const sk = String(r.size);
        const qty = Number(r.outQty) || 0;
        const cur = sg.sizeMap.get(sk);
        if (cur) { cur.qty = global.CALC.round6(cur.qty + qty); cur.ids.push(r.id); if (r.weight != null) cur.weights.push(Number(r.weight)); }
        else { const line = { size: r.size, qty, ids: [r.id], weights: r.weight != null ? [Number(r.weight)] : [] }; sg.sizeMap.set(sk, line); sg.sizes.push(line); }
      }
      g.docGroups = [...subMap.values()].map((sg) => {
        delete sg.sizeMap;
        sg.sizes.sort((a, b) => (Number(a.size) || 0) - (Number(b.size) || 0));
        sg.total = sg.sizes.reduce((s, x) => s + x.qty, 0);
        sg.totalWeight = sg.weights && sg.weights.length ? global.CALC.round6(sg.weights.reduce((a, b) => a + b, 0)) : null;
        return sg;
      });
      g.docGroups.sort((a, b) => String(a.family).localeCompare(String(b.family), 'ar') ||
        (Number(a.gsm) || 0) - (Number(b.gsm) || 0) ||
        ((a.weight == null ? -1 : a.weight) - (b.weight == null ? -1 : b.weight)));
      g.lines = [];
      for (const sg of g.docGroups) {
        for (const s of sg.sizes) {
          g.lines.push({
            quality: sg.quality, family: sg.family, gsm: sg.gsm, weight: sg.weight,
            size: s.size, qty: s.qty, reelCount: 0, reelIds: [],
            weightKg: s.weights && s.weights.length ? global.CALC.round6(s.weights.reduce((a, b) => a + b, 0)) : null,
            weightEstimated: !(s.weights && s.weights.length),
          });
        }
      }
      g.totalRolls = g.rows.reduce((s, r) => s + (Number(r.outQty) || 0), 0);
      const wKnown = g.rows.reduce((sum, row) => sum + (Number(row.weight) || 0), 0);
      g.totalWeightKg = g.rows.some((row) => row.weight != null && row.weight !== '') ? global.CALC.round6(wKnown) : null;
      g.weightEstimated = g.totalWeightKg == null;
      g.minId = g.rowIds.length ? Math.min(...g.rowIds) : 0;
      g.cls = g.cls || '';
      g.status = 'approved';
      out.push(g);
    }
    /* تعارض العملاء: نفس الرقم + نفس التصنيف عبر عملاء مختلفين — لا دمج */
    const byKey = new Map();
    for (const v of out) {
      if (!v.permitNo) continue;
      const k = (v.cls || '') + '|' + String(v.permitNo).trim();
      if (!byKey.has(k)) byKey.set(k, new Set());
      byKey.get(k).add(v.customer);
    }
    for (const v of out) {
      if (!v.permitNo) continue;
      const k = (v.cls || '') + '|' + String(v.permitNo).trim();
      const custs = byKey.get(k);
      if (custs && custs.size > 1) {
        v.customerConflict = true;
        v.conflictCustomers = [...custs].filter((c) => c !== v.customer).sort((a, b) => a.localeCompare(b, 'ar'));
      }
    }
    return out;
  }
  App.collectVouchers = collectVouchers;
  /* توافق قديم: التقارير ولوحة التحكم تستدعي collectIssueDocs */
  App.collectIssueDocs = function (transactions) {
    return collectVouchers(transactions, App.state.permits || [])
      .filter((v) => v.kind === 'derived' || v.status === 'approved');
  };

  const clsBadge = (cls) => {
    if (!cls) return `<span class="muted small">—</span>`;
    return `<span class="badge ${cls === 'ض' ? 'badge-tax' : 'badge-nontax'}">${CLS_LABEL[cls]}</span>`;
  };
  const statusBadge = (st) => st === 'draft'
    ? `<span class="badge badge-draft">${ar() ? 'مسودة — غير معتمدة' : 'draft'}</span>`
    : `<span class="badge badge-approved">${ar() ? 'معتمد' : 'approved'}</span>`;
  const conflictBadge = (v) => !v.customerConflict ? '' :
    `<span class="badge badge-conflict" title="${ar() ? 'نفس الرقم مستخدم لعملاء آخرين — للمراجعة، لا دمج تلقائي' : 'same number used by other customers'}">⚠ ${ar() ? 'تعارض عميل' : 'customer conflict'}</span>`;

  /* ================= أذون الصرف — list page ================= */
  function renderIssuedocs(host) {
    const keeper = global.PERM && global.PERM.isWarehouse();
    /* قاعدة اليومين: نافذة ثابتة بتوقيت مصر (اليوم + الأمس) — لا يعتمد
       على تاريخ يختاره المستخدم، وتُحدَّث تلقائيًا عند بداية يوم جديد */
    const winFrom = keeper ? global.PERM.keeperWindowStart() : '';
    const winTo = keeper ? global.PERM.cairoToday() : '';
    host.innerHTML = `
      <div class="page-head"><h2>${esc(t('issuedocs'))}</h2>
        <div class="head-actions">
          ${keeper ? '' : `<button class="btn btn-primary" id="docs-new">+ ${ar() ? 'إذن صرف جديد' : 'New issue permit'}</button>
          <button class="btn btn-ghost" id="docs-exp">${t('exportExcel')}</button>`}
        </div></div>
      ${keeper ? `<div class="card notice-card"><strong>صلاحيات العرض والطباعة فقط</strong>
        <div class="small muted">تعرض أذون اليوم ${fmtDate(winTo)} والأمس ${fmtDate(winFrom)} بتوقيت مصر — تُحدَّث النافذة تلقائيًا عند بداية يوم جديد.
        لا يمكنك إضافة أو تعديل أو حذف أو اعتماد أذون، ولا عرض الأذون الأقدم (محجوب من قاعدة البيانات نفسها).</div></div>` : ''}
      <div class="card filters">
        <input type="text" id="doc-q" placeholder="${ar() ? 'بحث برقم الإذن أو اسم العميل…' : 'Search voucher no. / customer…'}">
        <input type="date" id="doc-from" title="${t('from')}" value="${esc(winFrom)}" ${keeper ? 'readonly' : ''}>
        <input type="date" id="doc-to" title="${t('to')}" value="${esc(winTo)}" ${keeper ? 'readonly' : ''}>
        <select id="doc-cls">
          <option value="">${t('classification')}: ${t('all')}</option>
          <option value="ض">${t('tax')}</option>
          <option value="غ">${t('nontax')}</option>
        </select>
        <select id="doc-status">
          <option value="">${ar() ? 'الحالة: الكل' : 'Status: all'}</option>
          <option value="approved">${ar() ? 'معتمد' : 'approved'}</option>
          <option value="draft">${ar() ? 'مسودة' : 'draft'}</option>
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
      const from = keeper ? winFrom : host.querySelector('#doc-from').value;
      const to = keeper ? winTo : host.querySelector('#doc-to').value;
      const cls = host.querySelector('#doc-cls').value;
      const status = keeper ? '' : host.querySelector('#doc-status').value;
      const sort = host.querySelector('#doc-sort').value;
      docs = App.collectVouchers(App.state.transactions, App.state.permits).filter((d) =>
        (!from || d.date >= from) && (!to || d.date <= to) &&
        (!cls || d.cls === cls) &&
        (!status || d.status === status) &&
        (!q || String(d.permitNo || '').toLowerCase().includes(q) || String(d.customer || '').toLowerCase().includes(q)));
      docs.sort((a, b) => {
        const ta = `${a.date}|${a.minId || 0}`, tb = `${b.date}|${b.minId || 0}`;
        const cmp = ta < tb ? 1 : ta > tb ? -1 : 0;
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
      const weights = docs.reduce((s, d) => s + (d.totalWeightKg || 0), 0);
      host2.innerHTML = `
        <table class="data-table">
          <thead><tr>
            <th>${t('docNo')}</th><th>${t('customer')}</th><th>${t('date')}</th>
            <th>${t('classification')}</th><th>${ar() ? 'الحالة' : 'Status'}</th>
            <th class="num">${t('totalRolls')}</th><th class="num">${t('voucherWeight')} (${t('kg')})</th>
            <th>${t('actions')}</th>
          </tr></thead>
          <tbody>${slice.length ? slice.map(docRowHtml).join('') :
            `<tr><td colspan="8" class="empty">${ar() ? 'لا توجد أذون صرف مطابقة' : 'No matching issue permits'}</td></tr>`}</tbody>
          <tfoot><tr>
            <td colspan="5">${t('total')} (${fmtNum(total)} ${ar() ? 'إذن' : 'permits'})</td>
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
        if (act === 'view') { App.pendingDoc = doc; App.autoPrintDoc = false; App.navigate('issuedoc'); }
        else if (act === 'print') { App.pendingDoc = doc; App.autoPrintDoc = true; App.navigate('issuedoc'); }
        else if (act === 'edit') { App.pendingEdit = doc; App.navigate('baker-issue'); }
        else if (act === 'approve') {
          const ok = await confirmDialog({
            title: ar() ? 'اعتماد إذن الصرف' : 'Approve permit',
            message: ar()
              ? `اعتماد الإذن "${doc.permitNo}" للعميل ${doc.customer} (${fmtNum(doc.totalRolls)} بكرة)؟\nسيتم التحقق من الرصيد، وخصم الكميات، وتحديث حالة البكر المحددة إلى «مصروفة» — داخل عملية واحدة لا يمكن أن تنصف.`
              : `Approve permit "${doc.permitNo}"?`,
            yesLabel: ar() ? 'اعتماد' : 'Approve',
          });
          if (!ok) return;
          try {
            await global.TX.approvePermit(doc.permitId);
            toast(ar() ? `تم اعتماد الإذن ${doc.permitNo} وخصم ${fmtNum(doc.totalRolls)} بكرة من الرصيد` : 'permit approved', 'ok');
            await App.refresh();
          } catch (e) {
            openModal(el(`<div><div class="form-error">${(e && e.errors ? e.errors : [String(e.message || e)]).map((x) => `<div>• ${esc(x)}</div>`).join('')}</div>
              <div class="confirm-actions"><button class="btn btn-primary" onclick="document.querySelectorAll('.modal-overlay').forEach(n=>n.remove())">${t('close')}</button></div></div>`),
              { title: ar() ? 'تعذر الاعتماد' : 'Approval failed' });
          }
        } else if (act === 'del') {
          const ok = await confirmDialog({
            title: ar() ? 'حذف إذن الصرف' : 'Delete issue permit',
            message: doc.kind === 'permit' && doc.status === 'draft'
              ? ar() ? `حذف مسودة الإذن "${doc.permitNo}"؟ المسودة لا تؤثر على الرصيد وستحذف نهائيًا.`
              : ''
              : ar()
                ? `سيتم حذف الإذن "${doc.permitNo || 'بدون رقم'}" بكل أسطره (${fmtNum(doc.totalRolls)} بكرة) نهائيًا، وستُعاد كمياته وحالة بكره إلى الرصيد تلقائيًا.\nالعميل: ${doc.customer} — التاريخ: ${fmtDate(doc.date)}`
                : '',
            danger: true,
          });
          if (!ok) return;
          if (doc.kind === 'permit') {
            await global.TX.deletePermit(doc.permitId);
          } else {
            await global.TX.deleteIssueVoucher(doc);
          }
          toast(ar() ? 'تم الحذف وإعادة الكميات إلى الرصيد' : 'deleted, quantities restored', 'ok');
          await App.refresh();
        }
      }));
      const bind = (id, fn) => { const b = host2.querySelector(id); if (b) b.addEventListener('click', () => { fn(); renderRows(); }); };
      bind('#dpg-prev', () => { page--; });
      bind('#dpg-next', () => { page++; });
    }

    function docRowHtml(d) {
      const weightCell = d.totalWeightKg == null
        ? `<span class="muted">${ar() ? 'تقديري' : 'est.'}</span>`
        : `${fmtNum(d.totalWeightKg, 3)}${d.weightEstimated ? ` <span class="muted small">(${ar() ? 'جزئي' : 'partial'})</span>` : ''}`;
      const keeper = global.PERM && global.PERM.isWarehouse();
      const actions = [];
      actions.push(`<button class="icon-btn" data-act="view" data-key="${esc(d.key)}" title="${t('viewDoc')}">👁</button>`);
      actions.push(`<button class="icon-btn" data-act="print" data-key="${esc(d.key)}" title="${t('printDoc')}">🖨</button>`);
      if (!keeper) {
        actions.push(`<button class="icon-btn" data-act="edit" data-key="${esc(d.key)}" title="${t('edit')}">✎</button>`);
        if (d.kind === 'permit' && d.status === 'draft') {
          actions.push(`<button class="icon-btn approve" data-act="approve" data-key="${esc(d.key)}" title="${ar() ? 'اعتماد الإذن وخصم الرصيد' : 'Approve'}">✔</button>`);
        }
        actions.push(`<button class="icon-btn danger" data-act="del" data-key="${esc(d.key)}" title="${t('del')}">🗑</button>`);
      }
      return `<tr class="voucher-row ${d.kind === 'permit' && d.status === 'draft' ? 'row-draft' : ''}">
        <td data-label="${t('docNo')}"><button class="voucher-no" data-act="view" data-key="${esc(d.key)}" title="${t('viewDoc')}">${esc(d.permitNo || '—')}</button>
          ${d.multiDate ? `<span class="badge badge-multi" title="${ar() ? 'الإذن له أكثر من تاريخ — المعتمد الأحدث' : ''}">${ar() ? 'أحدث تاريخ' : 'latest date'}</span>` : ''}</td>
        <td data-label="${t('customer')}">${esc(d.customer || '')} ${conflictBadge(d)}</td>
        <td data-label="${t('date')}">${fmtDate(d.date)}</td>
        <td data-label="${t('classification')}">${clsBadge(d.cls)}</td>
        <td data-label="${ar() ? 'الحالة' : 'Status'}">${d.kind === 'permit' ? statusBadge(d.status) : `<span class="badge badge-imported">${ar() ? 'مستورد' : 'imported'}</span>`}</td>
        <td class="num" data-label="${t('totalRolls')}"><strong>${fmtNum(d.totalRolls)}</strong></td>
        <td class="num" data-label="${t('voucherWeight')}">${weightCell}</td>
        <td class="actions-cell">${actions.join('')}</td></tr>`;
    }

    host.querySelector('#doc-q').addEventListener('input', applyFilters);
    host.querySelector('#doc-from').addEventListener('change', applyFilters);
    host.querySelector('#doc-to').addEventListener('change', applyFilters);
    host.querySelector('#doc-cls').addEventListener('change', applyFilters);
    host.querySelector('#doc-status').addEventListener('change', applyFilters);
    host.querySelector('#doc-sort').addEventListener('change', applyFilters);
    host.querySelector('#doc-clear').addEventListener('click', () => {
      ['#doc-q', '#doc-cls'].forEach((s) => { host.querySelector(s).value = ''; });
      if (!keeper) {
        host.querySelector('#doc-from').value = '';
        host.querySelector('#doc-to').value = '';
        host.querySelector('#doc-status').value = '';
      } else {
        host.querySelector('#doc-from').value = winFrom;
        host.querySelector('#doc-to').value = winTo;
        host.querySelector('#doc-status').value = '';
      }
      host.querySelector('#doc-sort').value = 'new';
      applyFilters();
    });
    const newBtn = host.querySelector('#docs-new');
    if (newBtn) newBtn.addEventListener('click', () => { App.pendingEdit = null; App.navigate('baker-issue'); });
    const expBtn = host.querySelector('#docs-exp');
    if (expBtn) expBtn.addEventListener('click', () => {
      const headers = [t('docNo'), t('customer'), t('date'), t('classification'), ar() ? 'الحالة' : 'Status',
        t('quality'), t('gsm'), t('size'), t('outQty'), `${t('voucherWeight')} (${t('kg')})`];
      const rows = [];
      for (const d of docs) {
        for (const l of d.lines) {
          rows.push([d.permitNo || '', d.customer, d.date, d.cls ? CLS_LABEL[d.cls] : '',
            d.status === 'draft' ? (ar() ? 'مسودة' : 'draft') : (d.kind === 'permit' ? (ar() ? 'معتمد' : 'approved') : (ar() ? 'مستورد' : 'imported')),
            l.family, l.gsm == null ? '' : l.gsm, l.size, l.qty,
            l.weightKg != null ? l.weightKg : '']);
        }
      }
      global.EXCEL.exportReportAOA(t('issuedocs'), headers, rows, null, 'اذون_الصرف');
      toast(ar() ? 'تم تنزيل ملف الإكسل' : 'Excel downloaded', 'ok');
    });

    applyFilters();
  }

  /* ================= نموذج الإذن (مسودة + اعتماد + اختيار البكر) ================= */
  function bakerIssueForm(host, editTarget) {
    /* أمين المخزن لا يملك إنشاء أو تعديل أذون — حارس مزدوج فوق بوابة المسارات */
    if (global.PERM && global.PERM.isWarehouse()) {
      host.innerHTML = `<div class="card error-card">لا تملك صلاحية إنشاء أو تعديل أذون الصرف —
        صلاحياتك للعرض والطباعة فقط. أذون آخر يومين متاحة في قسم «أذون الصرف».</div>`;
      return;
    }
    /* editTarget: null → إذن جديد | {kind:'permit', voucher} → مسودة/معتمد | {kind:'legacy', voucher} → إذن قديم مستورد */
    const isEdit = !!editTarget;
    const kind = editTarget ? editTarget.kind : null;
    const voucher = editTarget ? editTarget.voucher : null;
    const families = familyOptionsOf();
    const customers = customerOptionsOf();
    let docNoDirty = false;
    let classification = voucher && voucher.cls ? voucher.cls : 'ض';
    let initialLines = [];

    if (kind === 'permit') {
      initialLines = (voucher.lines || []).map((l) => ({
        quality: l.family || familyOf(l.quality), gsm: l.gsm, weight: l.weight,
        size: l.size, qty: l.qty, reelIds: (l.reelIds || []).slice(),
      }));
    } else if (kind === 'legacy') {
      classification = voucher.cls || 'ض';
      const sub = new Map();
      for (const r of voucher.rows) {
        const key = global.CALC.comboGroupWOf(r);
        if (!sub.has(key)) sub.set(key, { quality: familyOf(r.quality), gsm: r.gsm, weight: r.weight, sizes: [], sizeMap: new Map() });
        const g2 = sub.get(key);
        const sk = String(r.size);
        const qty = Number(r.outQty) || 0;
        const cur = g2.sizeMap.get(sk);
        if (cur) cur.qty = global.CALC.round6(cur.qty + qty);
        else { const line = { size: r.size, qty }; g2.sizeMap.set(sk, line); g2.sizes.push(line); }
      }
      initialLines = [...sub.values()];
      initialLines.forEach((g2) => { delete g2.sizeMap; g2.sizes.sort((a, b) => (Number(a.size) || 0) - (Number(b.size) || 0)); });
    }

    host.innerHTML = `
      <div class="page-head"><h2>${isEdit
        ? (ar() ? `تعديل إذن صرف ${voucher ? esc(voucher.permitNo || '') : ''}` : 'Edit issue permit')
        : `${ar() ? 'إذن صرف جديد' : 'New issue permit'}`}</h2>
        <div class="head-actions"><button class="btn btn-ghost" id="bi-back">← ${t('issuedocs')}</button></div></div>
      <div class="card form-card">
        <p class="muted small form-sub">${ar()
          ? 'نوع الإذن (ضريبي/غير ضريبي) لكل نوع تسلسل مستقل — يُقترح الرقم التالي تلقائيًا ويُمنع التكرار داخل النوع. يمكن حفظ الإذن كمسودة دون أي خصم، ثم اعتماده ليُخصم من الرصيد وتتغير حالة البكر المحددة إلى «مصروفة». عند تحديد بكر فعلية يُحسب الوزن من أوزانها الحقيقية.'
          : 'Tax / non-tax sequences are independent. Save as draft (no deduction) then approve to deduct stock and flip the selected reels to «dispatched».'}</p>
        <form id="bi-form" novalidate>
          <div class="form-grid">
            <label class="field"><span>${t('date')} *</span>
              <input type="date" id="bi-date" required value="${esc(voucher ? voucher.date : todayISO())}"></label>
            <label class="field"><span>${t('customer')} *</span>
              <input type="text" id="bi-customer" list="bi-cust-list" required placeholder="${ar() ? 'اسم العميل' : 'customer name'}"
                value="${esc(voucher ? (voucher.customer || '') : '')}">
              <datalist id="bi-cust-list">${customers.map((c) => `<option value="${esc(c)}"></option>`).join('')}</datalist></label>
            <div class="field"><span>${t('classification')} *</span>
              <div class="seg-control" id="bi-cls">
                <button type="button" data-cls="ض" class="${classification === 'ض' ? 'active' : ''}">${t('tax')}</button>
                <button type="button" data-cls="غ" class="${classification === 'غ' ? 'active' : ''}">${t('nontax')}</button>
              </div></div>
            <label class="field"><span>${t('docNo')} *</span>
              <input type="text" id="bi-docno" required autocomplete="off" value="${esc(voucher ? (voucher.permitNo || '') : '')}">
              <span class="muted small" id="bi-docno-hint">${ar() ? 'يُقترح تلقائيًا — يمكن تعديله' : 'suggested automatically — editable'}</span></label>
            <label class="field field-wide"><span>${t('notes')}</span>
              <input type="text" id="bi-notes" value="${esc(voucher ? (voucher.notes || '') : '')}"></label>
          </div>
          <section class="field field-wide" id="bi-groups-section">
            <div class="card-head-row"><strong>${ar() ? 'تفاصيل الصرف — ترتيب الأعمدة: العدد، المقاس، الجرام، الصنف' : 'Issue details'}</strong>
              <button type="button" class="btn btn-ghost" id="bi-add-group">+ ${ar() ? 'إضافة سطر' : 'Add line'}</button></div>
            <div id="bi-groups"></div>
          </section>
          <div class="form-hint" id="bi-hint"></div>
          <div class="form-error" id="bi-error" role="alert"></div>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary" id="bi-approve">${isEdit && kind === 'permit' && voucher.status === 'approved'
              ? (ar() ? 'حفظ التعديل وإعادة الاعتماد' : 'Save & re-approve')
              : (ar() ? 'اعتماد وصرف من الرصيد' : 'Approve & deduct')}</button>
            <button type="button" class="btn btn-outline" id="bi-draft">${kind === 'legacy'
              ? (ar() ? 'حفظ كإذن (كالوضع القديم)' : 'Save (legacy)')
              : (ar() ? 'حفظ كمسودة (بدون خصم)' : 'Save draft (no deduction)')}</button>
            <button type="button" class="btn btn-ghost" id="bi-cancel">${t('cancel')}</button>
          </div>
        </form>
      </div>`;

    const form = host.querySelector('#bi-form');
    const groupsHost = host.querySelector('#bi-groups');
    const docNoIn = host.querySelector('#bi-docno');
    host.querySelector('#bi-back').addEventListener('click', () => App.navigate('issuedocs'));

    const suggestDocNo = async () => {
      if (isEdit) return;
      const n = await global.TX.nextDocNumbers();
      docNoIn.value = String(classification === 'ض' ? n.tax : n.nontax);
      docNoDirty = false;
    };
    host.querySelectorAll('#bi-cls button').forEach((b) => b.addEventListener('click', () => {
      classification = b.dataset.cls;
      host.querySelectorAll('#bi-cls button').forEach((x) => x.classList.toggle('active', x === b));
      suggestDocNo();
    }));
    docNoIn.addEventListener('input', () => { docNoDirty = true; });

    let refreshTotalsFn = null; /* يُربط بعد تعريف refreshTotals — يمنع التدابق */
    /* ---------- سطور الإذن: العدد | المقاس | الجرام | الصنف + اختيار البكر ---------- */
    const makeLineEl = (def) => {
      const d0 = def || { quality: families[0] || '', gsm: '', weight: '', size: '', qty: '', reelIds: [] };
      const g = el(`<div class="issue-line">
        <div class="form-grid issue-line-grid">
          <label class="field"><span>${ar() ? 'العدد (عدد البكر)' : 'Qty (bales)'} *</span>
            <input class="l-qty" type="number" min="1" step="1" placeholder="0" value="${esc(d0.qty == null ? '' : d0.qty)}"></label>
          <label class="field"><span>${t('size')} *</span>
            <input class="l-size" type="number" min="1" step="any" placeholder="100" value="${esc(d0.size == null ? '' : d0.size)}"></label>
          <label class="field"><span>${t('gsm')} *</span>
            <input class="l-gsm" type="number" min="1" step="any" list="bi-gsm-list" placeholder="125" value="${esc(d0.gsm == null ? '' : d0.gsm)}"></label>
          <label class="field"><span>${t('quality')} *</span>
            <select class="l-quality">${families.map((f) => `<option value="${esc(f)}" ${d0.quality === f ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select></label>
          <label class="field"><span>${ar() ? 'وزن بكرة (اختياري — يُستخدم إن لم تحدد بكر)' : 'Bale weight (optional)'}</span>
            <input class="l-weight" type="number" min="0.001" step="0.001" placeholder="${ar() ? 'تقديري إن تُرك فارغًا' : ''}" value="${esc(d0.weight == null ? '' : d0.weight)}"></label>
          <div class="field"><span>&nbsp;</span>
            <div class="line-btns">
              <button type="button" class="btn btn-ghost l-pick">${ar() ? 'تحديد البكر من المخزون' : 'Pick reels'}</button>
              <button type="button" class="btn btn-ghost l-remove">✕ ${ar() ? 'حذف السطر' : 'Remove'}</button>
            </div></div>
        </div>
        <div class="reel-picker" hidden></div>
        <div class="line-meta muted small"></div>
      </div>`);

      const picker = g.querySelector('.reel-picker');
      const meta = g.querySelector('.line-meta');
      const readLine = () => ({
        quality: g.querySelector('.l-quality').value,
        gsm: g.querySelector('.l-gsm').value === '' ? null : Number(g.querySelector('.l-gsm').value),
        weight: g.querySelector('.l-weight').value === '' ? null : Number(g.querySelector('.l-weight').value),
        size: g.querySelector('.l-size').value === '' ? null : Number(g.querySelector('.l-size').value),
        qty: Number(g.querySelector('.l-qty').value) || 0,
        reelIds: (g._selectedReels || []).map((r) => r.id),
      });

      /* تحديث ميتا السطر فقط — لا يستدعي refreshTotals إطلاقًا (منع تدابق) */
      const refreshMeta = () => {
        const sel = g._selectedReels || [];
        if (sel.length) {
          const w = global.CALC.round6(sel.reduce((s, r) => s + (Number(r.weight) || 0), 0));
          meta.innerHTML = `${ar() ? 'بكر محددة' : 'Reels selected'}: <strong>${fmtNum(sel.length)}</strong> — ${ar() ? 'الوزن الفعلي' : 'actual weight'}: <strong>${fmtNum(w, 3)}</strong> ${t('kg')} (${ar() ? 'من رولات' : 'from rolls'} ${esc([...new Set(sel.map((r) => r.rollNo))].slice(0, 6).map(fmtNum).join('، '))}${sel.length > 6 ? '…' : ''})`;
          g.querySelector('.l-qty').value = sel.length;
          g.querySelector('.l-qty').readOnly = true;
        } else {
          meta.textContent = '';
          g.querySelector('.l-qty').readOnly = false;
          const l = readLine();
          if (l.quality && l.gsm && l.size) {
            const bal = App.balanceOf(l.quality, l.gsm, l.size);
            let txt = `${ar() ? 'المتاح' : 'Available'}: ${fmtNum(bal.net)}`;
            if (l.qty > bal.net) txt += ` — ${ar() ? 'أكبر من المتاح' : 'exceeds available'}`;
            meta.textContent = txt;
          }
        }
      };

      g.querySelector('.l-remove').addEventListener('click', () => {
        if (groupsHost.querySelectorAll('.issue-line').length === 1) {
          g.querySelectorAll('input').forEach((i) => { i.value = ''; });
          g._selectedReels = [];
        } else g.remove();
        refreshTotals();
      });
      ['l-size', 'l-gsm', 'l-qty'].forEach((cls2) => g.querySelector('.' + cls2).addEventListener('input', refreshMeta));
      g.querySelector('.l-quality').addEventListener('change', refreshMeta);

      const showPicker = async () => {
        const l = readLine();
        if (!l.quality || !l.gsm || !l.size) {
          toast(ar() ? 'أكمل الصنف والجرام والمقاس أولًا لعرض البكر المتاحة' : 'Complete product, GSM and size first', 'warn');
          return;
        }
        const reels = await global.TX.findAvailableReels(l.quality, l.gsm, l.size);
        const selected = new Set((g._selectedReels || []).map((r) => r.id));
        picker.hidden = false;
        if (!reels.length) {
          picker.innerHTML = `<div class="muted small" style="padding:.4rem">${ar() ? 'لا توجد بكر متاحة (متتبعة) لهذا الصنف/الجرام/المقاس — يمكنك الصرف كحركة كمية بدون تحديد بكر.' : 'No tracked reels available — issue as quantity movement.'}</div>`;
          return;
        }
        picker.innerHTML = `
          <div class="picker-head">
            <strong>${ar() ? 'البكر المتاحة' : 'Available reels'} (${fmtNum(reels.length)})</strong>
            <span class="muted small">${ar() ? 'حدد البكر لصرفها بأوزانها الفعلية — العدد يُحسب تلقائيًا' : 'select reels for actual weights'}</span>
            <div class="picker-actions">
              <input type="number" class="pk-n" min="1" max="${reels.length}" value="${Math.min(reels.length, Math.max(1, Number(g.querySelector('.l-qty').value) || 1))}" title="${ar() ? 'عدد البكر' : 'count'}">
              <button type="button" class="btn btn-ghost pk-first">${ar() ? 'تحديد أول' : 'Select first'}</button>
              <button type="button" class="btn btn-ghost pk-clear">${ar() ? 'إلغاء التحديد' : 'Clear'}</button>
              <button type="button" class="btn btn-primary pk-done">${t('close')}</button>
            </div>
          </div>
          <div class="picker-list">${reels.map((r) => `
            <label class="pk-item"><input type="checkbox" data-id="${esc(r.id)}" ${selected.has(r.id) ? 'checked' : ''}>
              <span class="pk-code" dir="ltr">${fmtNum(r.rollNo)}/${fmtNum(r.reelNo)}</span>
              <span>${ar() ? 'مقاس' : 'size'} ${fmtNum(r.size)}</span>
              <span>${fmtNum(r.weight, 3)} ${t('kg')}</span>
              <span>${fmtNum(r.gram)} ${t('gsm')}</span>
            </label>`).join('')}</div>`;
        const syncSel = () => {
          const ids = [...picker.querySelectorAll('input[type=checkbox]:checked')].map((c) => c.dataset.id);
          g._selectedReels = reels.filter((r) => ids.includes(r.id));
          refreshMeta();
          if (typeof refreshTotalsFn === 'function') refreshTotalsFn();
        };
        picker.addEventListener('change', (e) => { if (e.target.type === 'checkbox') syncSel(); });
        picker.querySelector('.pk-first').addEventListener('click', () => {
          const n = Math.max(1, Math.min(reels.length, Number(picker.querySelector('.pk-n').value) || 1));
          picker.querySelectorAll('input[type=checkbox]').forEach((c, i) => { c.checked = i < n; });
          syncSel();
        });
        picker.querySelector('.pk-clear').addEventListener('click', () => {
          picker.querySelectorAll('input[type=checkbox]').forEach((c) => { c.checked = false; });
          syncSel();
        });
        picker.querySelector('.pk-done').addEventListener('click', () => { picker.hidden = true; });
      };
      g.querySelector('.l-pick').addEventListener('click', showPicker);

      g._selectedReels = (d0.reelIds || []).map((id) => ({ id })); /* resolved below */
      g._readLine = readLine;
      g._refreshMeta = refreshMeta;
      return g;
    };

    const datalistWrap = el(`<div><datalist id="bi-gsm-list">${App.knownGsms(null).map((x) => `<option value="${esc(x)}"></option>`).join('')}</datalist></div>`);
    host.appendChild(datalistWrap);

    /* resolve preselected reel ids to reel records (edit mode) */
    const preselectReels = async () => {
      if (!initialLines.some((l) => (l.reelIds || []).length)) return;
      const all = await global.DB.getAll('reels');
      const byId = new Map(all.map((r) => [r.id, r]));
      const lineEls = groupsHost.querySelectorAll('.issue-line');
      initialLines.forEach((l, i) => {
        const g = lineEls[i];
        if (!g) return;
        g._selectedReels = (l.reelIds || []).map((id) => byId.get(id)).filter(Boolean);
      });
      refreshTotals();
    };

    const renumber = () => {
      groupsHost.querySelectorAll('.issue-line .l-index').forEach((elm, i) => {
        elm.textContent = `${ar() ? 'سطر' : 'Line'} ${fmtNum(i + 1)}`;
      });
    };
    const addLine = (def) => { const g = makeLineEl(def); groupsHost.appendChild(g); return g; };
    host.querySelector('#bi-add-group').addEventListener('click', () => { addLine(null); refreshTotals(); });

    if (initialLines.length) initialLines.forEach((l) => addLine(l));
    else addLine(null);

    function refreshTotals() {
      let grand = 0, actualW = 0, recordedW = 0, estLines = 0;
      groupsHost.querySelectorAll('.issue-line').forEach((g) => {
        const sel = g._selectedReels || [];
        const qty = sel.length || (Number(g.querySelector('.l-qty').value) || 0);
        if (sel.length) actualW += sel.reduce((s, r) => s + (Number(r.weight) || 0), 0);
        else {
          const w = g.querySelector('.l-weight').value === '' ? null : Number(g.querySelector('.l-weight').value);
          if (w != null) recordedW += w * qty;
          else if (qty > 0) estLines += qty;
        }
        grand += qty;
      });
      const hint = host.querySelector('#bi-hint');
      if (hint) {
        const estW = Math.round(estLines * 7.5 * 1000) / 1000; /* تقديري بالمعامل الرسمي */
        hint.innerHTML = `${t('totalRolls')}: <strong>${fmtNum(global.CALC.round6(grand))}</strong> ${t('rolls')}
          &nbsp;•&nbsp; ${t('voucherWeight')}: <strong>${fmtNum(global.CALC.round6(actualW + recordedW), 3)}</strong> ${t('kg')}${estLines ? ` <span class="muted small">+ ${ar() ? 'تقديري' : 'estimated'} ${fmtNum(estW, 3)} ${ar() ? 'كجم لـ' : 'for'} ${fmtNum(estLines)} ${ar() ? 'بكرة بلا وزن مسجل' : 'weightless bales'}</span>` : ''}`;
      }
      groupsHost.querySelectorAll('.issue-line').forEach((g) => g._refreshMeta && g._refreshMeta());
    }
    refreshTotalsFn = refreshTotals;
    groupsHost.addEventListener('input', (e) => { if (e.target.matches('input')) refreshTotals(); });
    Promise.resolve().then(() => { preselectReels().then(refreshTotals); });

    /* ---------- read all lines ---------- */
    function readDoc() {
      const lines = [];
      let invalid = false;
      groupsHost.querySelectorAll('.issue-line').forEach((g) => {
        const quality = g.querySelector('.l-quality').value;
        const gsm = g.querySelector('.l-gsm').value === '' ? null : Number(g.querySelector('.l-gsm').value);
        const weight = g.querySelector('.l-weight').value === '' ? null : Number(g.querySelector('.l-weight').value);
        const size = g.querySelector('.l-size').value === '' ? null : Number(g.querySelector('.l-size').value);
        const sel = g._selectedReels || [];
        const qty = sel.length ? sel.length : (Number(g.querySelector('.l-qty').value) || 0);
        const reelIds = sel.map((r) => r.id);
        if (!quality || !Number.isFinite(gsm) || gsm <= 0 || !Number.isFinite(size) || size <= 0 || qty <= 0) invalid = true;
        lines.push({ quality, gsm, weight, size, qty, reelIds, weightKg: sel.length ? global.CALC.round6(sel.reduce((s, r) => s + (Number(r.weight) || 0), 0)) : null });
      });
      return {
        date: host.querySelector('#bi-date').value,
        customer: host.querySelector('#bi-customer').value.trim(),
        notes: host.querySelector('#bi-notes').value.trim(),
        docNo: docNoIn.value.trim(),
        cls: classification,
        lines,
        invalid,
      };
    }

    /* ---------- save: draft / approve / legacy ---------- */
    host.querySelector('#bi-cancel').addEventListener('click', () => App.navigate('issuedocs'));

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const errBox = host.querySelector('#bi-error');
      errBox.textContent = '';
      const doc = readDoc();
      const problems = [];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(doc.date)) problems.push(ar() ? 'التاريخ مطلوب بصيغة صحيحة' : 'Valid date required');
      if (!doc.customer) problems.push(ar() ? 'اسم العميل مطلوب' : 'Customer name required');
      if (!doc.docNo) problems.push(ar() ? 'رقم الإذن مطلوب' : 'Document number required');
      if (!doc.lines.length || doc.invalid) problems.push(ar() ? 'أكمل كل سطر: الصنف والجرام والمقاس وعدد أكبر من صفر' : 'Complete every line');
      const seenKey = new Set();
      for (const l of doc.lines) {
        const k = `${l.quality}|${l.gsm}|${l.size}`;
        if (seenKey.has(k)) problems.push(ar() ? `نفس المجموعة (الصنف/الجرام/المقاس ${l.size}) مكررة — اجمع العدد في سطر واحد` : `Duplicate line (${l.size})`);
        seenKey.add(k);
      }
      if (problems.length) {
        errBox.innerHTML = problems.map((p) => `• ${esc(p)}`).join('<br>');
        return;
      }
      try {
        if (kind === 'legacy') {
          /* إذن قديم مستورد — نفس مسار التوافق القديم */
          const pendingRows = [];
          for (const l of doc.lines) {
            pendingRows.push({
              date: doc.date, quality: l.quality, gsm: l.gsm, size: l.size,
              customer: doc.customer, permitNo: doc.docNo, addQty: 0, outQty: l.qty,
              weight: l.weight, settlement: doc.cls, notes: doc.notes, source: voucher.source || 'excel',
            });
          }
          await global.TX.replaceIssueVoucher(voucher, pendingRows, doc.cls, doc.docNo);
          toast(ar() ? 'تم تحديث الإذن وتحديث الرصيد تلقائيًا' : 'voucher updated', 'ok');
        } else if (kind === 'permit' && voucher.status === 'approved') {
          await global.TX.replacePermit(voucher.permitId, doc);
          toast(ar() ? `تم تعديل الإذن ${doc.docNo} وإعادة احتساب الصرف والرصيد` : 'permit updated & re-approved', 'ok');
        } else {
          /* مسودة جديدة أو تعديل مسودة ثم اعتماد */
          let saved;
          if (kind === 'permit') saved = await global.TX.updatePermitDraft(voucher.permitId, doc);
          else saved = await global.TX.savePermitDraft(doc);
          await global.TX.approvePermit(saved.id);
          toast(ar() ? `تم اعتماد الإذن ${doc.docNo} وخصم ${fmtNum(doc.lines.reduce((s, l) => s + l.qty, 0))} بكرة من الرصيد` : 'permit approved', 'ok');
        }
        await App.refresh();
        App.navigate('issuedocs');
      } catch (e) {
        if (e && e.type === 'validation') {
          errBox.innerHTML = e.errors.map((x) => `• ${esc(x)}`).join('<br>');
        } else {
          errBox.textContent = String(e.message || e);
          console.error(e);
        }
      }
    });

    host.querySelector('#bi-draft').addEventListener('click', async () => {
      const errBox = host.querySelector('#bi-error');
      errBox.textContent = '';
      const doc = readDoc();
      const problems = [];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(doc.date)) problems.push(ar() ? 'التاريخ مطلوب بصيغة صحيحة' : 'Valid date required');
      if (!doc.customer) problems.push(ar() ? 'اسم العميل مطلوب' : 'Customer name required');
      if (!doc.docNo) problems.push(ar() ? 'رقم الإذن مطلوب' : 'Document number required');
      if (!doc.lines.length || doc.invalid) problems.push(ar() ? 'أكمل كل سطر قبل الحفظ' : 'Complete every line');
      if (problems.length) {
        errBox.innerHTML = problems.map((p) => `• ${esc(p)}`).join('<br>');
        return;
      }
      try {
        if (kind === 'permit') {
          const saved = await global.TX.updatePermitDraft(voucher.permitId, doc);
          toast(ar() ? `تم تحديث المسودة ${saved.permitNo} — لا خصم قبل الاعتماد` : 'draft updated', 'ok');
        } else if (kind === 'legacy') {
          /* المسودة غير متاحة للأذون القديمة — استخدم زر الاعتماد */
          errBox.textContent = ar() ? 'الأذون المستوردة تُحفظ مباشرة (كالوضع القديم) — استخدم زر الاعتماد/الحفظ.' : '';
          return;
        } else {
          const saved = await global.TX.savePermitDraft(doc);
          toast(ar() ? `تم حفظ مسودة الإذن ${saved.permitNo} — لا خصم من الرصيد قبل الاعتماد` : 'draft saved', 'ok');
        }
        await App.refresh();
        App.navigate('issuedocs');
      } catch (e) {
        errBox.innerHTML = (e && e.errors ? e.errors : [String(e.message || e)]).map((x) => `• ${esc(x)}`).join('<br>');
      }
    });

    suggestDocNo();
  }

  function familyOptionsOf() {
    const extra = [];
    for (const p of App.state.products) {
      const f = App.productFamily(p.quality);
      if (!['تست لينر معالج', 'توب لاينر'].includes(f) && !extra.includes(f)) extra.push(f);
    }
    return ['تست لينر معالج', 'توب لاينر'].concat(extra);
  }
  function customerOptionsOf() {
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

  /* ================= إذن صرف — عرض/طباعة A4 من اللقطة المحفوظة ================= */
  function renderIssuedoc(host) {
    const keeper = global.PERM && global.PERM.isWarehouse();
    const d = App.pendingDoc;
    if (!d) { host.innerHTML = '<div class="card error-card">لم يتم تحديد إذن — ارجع إلى أذون الصرف.</div>'; return; }
    const company = App.state.settings.companyName || (ar() ? 'إدارة المخزن' : 'Inventory Management');

    /* جدول الإذن: العدد | المقاس | الجرام | الصنف — مجمّعًا من اللقطة المحفوظة */
    const lineMap = new Map();
    const weightMap = new Map();
    for (const l of d.lines) {
      const lk = [l.family || familyOf(l.quality), String(l.gsm), String(l.size)].join('||');
      const line = lineMap.get(lk) || { family: l.family || familyOf(l.quality), gsm: l.gsm, size: l.size, qty: 0 };
      line.qty += Number(l.qty) || 0;
      lineMap.set(lk, line);
      const wk = [l.family || familyOf(l.quality), String(l.gsm)].join('||');
      const wg = weightMap.get(wk) || { family: l.family || familyOf(l.quality), gsm: l.gsm, bales: 0, weightKg: 0, estBales: 0 };
      wg.bales += Number(l.qty) || 0;
      if (l.weightKg != null) wg.weightKg += l.weightKg;
      else if (Number(l.weight) > 0) wg.weightKg += Number(l.weight) * (Number(l.qty) || 0);
      else wg.estBales += Number(l.qty) || 0;
      weightMap.set(wk, wg);
    }
    const printGroups = [...weightMap.values()].sort((a, b) =>
      String(a.family).localeCompare(String(b.family), 'ar') || (Number(a.gsm) || 0) - (Number(b.gsm) || 0));
    const printRows = [...lineMap.values()].sort((a, b) =>
      String(a.family).localeCompare(String(b.family), 'ar') ||
      (Number(a.gsm) || 0) - (Number(b.gsm) || 0) ||
      (Number(a.size) || 0) - (Number(b.size) || 0));

    const printTable = `
      <table class="rp-table doc-issue-table">
        <thead><tr>
          <th>${ar() ? 'العدد' : 'Quantity'}</th>
          <th>${t('size')}</th>
          <th>${t('gsm')}</th>
          <th>${ar() ? 'الصنف' : 'Product'}</th>
        </tr></thead>
        <tbody>${printRows.map((row) => `<tr>
          <td>${fmtNum(row.qty)}</td><td>${row.size == null ? '—' : fmtNum(row.size)}</td>
          <td>${row.gsm == null ? '—' : fmtNum(row.gsm)}</td><td>${esc(row.family || '—')}</td>
        </tr>`).join('')}</tbody>
      </table>
      <table class="rp-table doc-gsm-totals">
        <thead><tr>
          <th>${ar() ? 'الجرام' : 'GSM'}</th>
          <th>${ar() ? 'إجمالي عدد البكر' : 'Total bales'}</th>
          <th>${ar() ? 'إجمالي الوزن (طن)' : 'Total weight (tons)'}</th>
        </tr></thead>
        <tbody>${printGroups.map((group) => `<tr>
          <td>${group.gsm == null ? '—' : fmtNum(group.gsm)}</td>
          <td>${fmtNum(group.bales)}</td>
          <td>${fmtNum(group.weightKg / 1000, 4)}${group.estBales ? ' <span class="rp-est">*</span>' : ''}</td>
        </tr>`).join('')}</tbody>
      </table>`;

    const totalBales = printGroups.reduce((sum, group) => sum + group.bales, 0);
    const totalWeightTons = printGroups.reduce((sum, group) => sum + group.weightKg, 0) / 1000;
    const hasEst = printGroups.some((g) => g.estBales > 0);
    const isDraft = d.kind === 'permit' && d.status === 'draft';
    const weightNote = hasEst
      ? `<div class="doc-note-est">* ${ar() ? 'جزء من الوزن تقديري (المقاس × 7.5) لبكر بلا وزن مسجل — لم يُستبدل أي وزن فعلي.' : '* partly estimated weight'}</div>`
      : '';

    host.innerHTML = `
      <div class="page-head"><h2>${esc(t('issuedoc'))} ${d.permitNo ? '— ' + esc(d.permitNo) : ''}</h2>
        <div class="head-actions doc-actions">
          <button class="btn btn-primary" id="docv-print">🖨 ${t('printDoc')} (A4)</button>
          ${!keeper && d.kind === 'permit' && d.status === 'draft' ? `<button class="btn btn-primary" id="docv-approve">✔ ${ar() ? 'اعتماد الإذن' : 'Approve'}</button>` : ''}
          ${!keeper ? `<button class="btn btn-ghost" id="docv-edit">✎ ${t('edit')}</button>` : ''}
          <button class="btn btn-ghost" id="docv-back">${ar() ? '← رجوع لأذون الصرف' : '← Back'}</button>
        </div></div>
      <div id="print-root">
        <div class="print-page doc-page ${isDraft ? 'doc-draft' : ''}">
          ${isDraft ? `<div class="draft-watermark">${ar() ? 'مسودة — غير معتمدة' : 'DRAFT'}</div>` : ''}
          <div class="rp-head">
            <div class="rp-co">${esc(company)}</div>
            <div class="rp-title">${ar() ? 'إذن صرف مخزني' : 'Stock Issue Voucher'}</div>
            <div class="rp-sub"><div>${t('docNo')}: <strong>${esc(d.permitNo || '—')}</strong> — ${t('classification')}: <strong>${d.cls ? CLS_LABEL[d.cls] : '—'}</strong> — ${ar() ? 'الحالة' : 'Status'}: <strong>${isDraft ? (ar() ? 'مسودة' : 'DRAFT') : (d.kind === 'permit' ? (ar() ? 'معتمد' : 'APPROVED') : (ar() ? 'مستورد' : 'IMPORTED'))}</strong></div></div>
          </div>
          <table class="doc-meta">
            <tbody><tr>
              <th>${t('customer')}</th><td>${esc(d.customer || '—')}${d.customerConflict ? ` <span class="rp-conflict">⚠ ${ar() ? 'تعارض عميل — نفس الرقم لعملاء آخرين' : 'customer conflict'}</span>` : ''}</td>
              <th>${t('date')}</th><td>${fmtDate(d.date)}${d.multiDate ? `<span class="muted small"> (${ar() ? 'أحدث تاريخ' : 'latest of several'})</span>` : ''}</td>
            </tr></tbody>
          </table>
          ${printTable}
          <table class="rp-table doc-total">
            <tbody>
              <tr><td class="doc-total-label">${t('totalRolls')}</td><td class="doc-total-num">${fmtNum(totalBales)} ${t('rolls')}</td></tr>
              <tr><td class="doc-total-label">${ar() ? 'إجمالي الوزن (طن)' : 'Total weight (tons)'}</td><td class="doc-total-num">${fmtNum(totalWeightTons, 4)}${hasEst ? ' *' : ''}</td></tr>
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
    const editBtn = host.querySelector('#docv-edit');
    if (editBtn) editBtn.addEventListener('click', () => { App.pendingEdit = d; App.navigate('baker-issue'); });
    const approveBtn = host.querySelector('#docv-approve');
    if (approveBtn) approveBtn.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: ar() ? 'اعتماد إذن الصرف' : 'Approve permit',
        message: ar() ? `اعتماد الإذن "${d.permitNo}" وخصم ${fmtNum(d.totalRolls)} بكرة من الرصيد؟` : 'Approve?',
        yesLabel: ar() ? 'اعتماد' : 'Approve',
      });
      if (!ok) return;
      try {
        await global.TX.approvePermit(d.permitId);
        toast(ar() ? 'تم الاعتماد والخصم' : 'approved', 'ok');
        await App.refresh();
        App.navigate('issuedocs');
      } catch (e) {
        toast((e && e.errors ? e.errors.join(' — ') : String(e.message || e)), 'err');
      }
    });
    host.querySelector('#docv-back').addEventListener('click', () => App.navigate('issuedocs'));
    if (App.autoPrintDoc) {
      App.autoPrintDoc = false;
      setTimeout(() => window.print(), 350);
    }
  }

  App.registerView('issuedocs', renderIssuedocs);
  App.registerView('baker-issue', (host) => {
    const pending = App.pendingEdit; App.pendingEdit = null;
    let target = null;
    if (pending && pending.kind === 'permit') target = { kind: 'permit', voucher: pending };
    else if (pending && pending.permitId) target = { kind: 'permit', voucher: pending };
    else if (pending && pending.groupId != null && !String(pending.groupId || '').startsWith(P_PREFIX) && !pending.permitId) target = { kind: 'legacy', voucher: pending };
    else if (pending && pending.kind === 'legacy') target = { kind: 'legacy', voucher: pending };
    bakerIssueForm(host, target);
  });
  App.registerView('issuedoc', renderIssuedoc);
})(typeof window !== 'undefined' ? window : globalThis);
