/* =========================================================================
   inventory.js — رصيد المخزن (بحث/فلترة/ترتيب) + إدارة الأصناف + تفاصيل الصنف
   Hierarchy: Product → GSM → Roll Weight (KG) → Size → Quantity.
   Balances are computed per (product, gsm, roll-weight, size) bucket —
   two rolls with different weights are never combined. Legacy rows
   without a weight show as bucket «—». Zero-balance items are hidden.
   ========================================================================= */
(function (global) {
  'use strict';
  const { t, el, esc, fmtNum, toast, confirmDialog, openModal, closeModal } = global.UI;
  const App = global.App;
  const lang = () => global.UI.getLang() === 'ar';
  const familyOf = (name) => App.productFamily(name);
  const CANON = ['تست لينر معالج', 'توب لاينر'];

  /* ================= Inventory view ================= */
  async function renderInventory(host) {
    const reels = await global.DB.getAll('reels');
    /* Match the warehouse report exactly: one row per product + GSM + size.
       Roll weights are deliberately NOT a grouping dimension here. */
    const reportBalances = global.CALC.computeBalances(App.state.transactions);
    const rowsBase = [...reportBalances.values()]
      .filter((b) => Number(b.net) > 0)
      .map((b) => ({
        quality: b.quality, family: familyOf(b.quality), gsm: b.gsm, size: b.size,
        add: b.add, out: b.out, net: b.net,
        estWeight: global.CALC.productWeight(b.size, b.net, App.state.settings.weightFactor),
        key: global.CALC.comboKey(b.quality, b.gsm, b.size),
      }))
      .sort((a, b) => {
        const ia = CANON.indexOf(a.family), ib = CANON.indexOf(b.family);
        const oa = ia < 0 ? CANON.length : ia, ob = ib < 0 ? CANON.length : ib;
        return oa - ob || a.family.localeCompare(b.family, 'ar') ||
          Number(a.gsm) - Number(b.gsm) || Number(a.size) - Number(b.size);
      });
    const families = CANON.filter((f) => rowsBase.some((b) => b.family === f));

    host.innerHTML = `
      <div class="page-head"><h2>${esc(t('inventory'))}</h2>
        <div class="head-actions"><button class="btn btn-ghost" id="inv-export">${t('exportExcel')}</button></div></div>
      <div class="card filters">
        <input type="text" id="inv-search" placeholder="${lang() ? 'بحث باسم الصنف…' : 'Search product…'}">
        <select id="inv-family"><option value=""> ${lang() ? 'الصنف: الكل' : 'Product: all'}</option>
          ${families.map((f) => `<option value="${esc(f)}">${esc(f)}</option>`).join('')}</select>
        <select id="inv-gsm"><option value=""> ${t('gsm')}: ${t('all')}</option></select>
        <select id="inv-size"><option value=""> ${t('size')}: ${t('all')}</option></select>
        <label class="chk"><input type="checkbox" id="inv-available-only"> ${lang() ? 'البكر المتاحة في المخزن فقط' : 'Available reels in stock only'}</label>
        <select id="inv-sort">
          <option value="name">${lang() ? 'ترتيب: الصنف' : 'Sort: name'}</option>
          <option value="bal-desc">${lang() ? 'الرصيد (تنازلي)' : 'balance (high→low)'}</option>
          <option value="bal-asc">${lang() ? 'الرصيد (تصاعدي)' : 'balance (low→high)'}</option>
          <option value="weight-desc">${lang() ? 'الوزن التقريبي (تنازلي)' : 'estimated weight (high→low)'}</option>
        </select>
        <button class="btn btn-ghost" id="inv-clear">${t('reset')}</button>
      </div>
      <div class="card table-wrap" id="inv-table"></div>`;

    const gsms = [...new Set(rowsBase.map((b) => String(b.gsm)))].sort((a, b) => Number(a) - Number(b));
    const sizes = [...new Set(rowsBase.map((b) => String(b.size)))].sort((a, b) => Number(a) - Number(b));
    host.querySelector('#inv-gsm').innerHTML += gsms.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
    host.querySelector('#inv-size').innerHTML += sizes.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('');

    function matchingReels(row) {
      return reels.filter((r) =>
        global.CALC.comboKey(r.quality, r.gram, r.size) === row.key &&
        r.status === 'available'
      ).sort((a, b) => Number(a.rollNo) - Number(b.rollNo) || Number(a.reelNo) - Number(b.reelNo));
    }

    function draw() {
      const q = host.querySelector('#inv-search').value.trim().toLowerCase();
      const fam = host.querySelector('#inv-family').value;
      const gsm = host.querySelector('#inv-gsm').value;
      const size = host.querySelector('#inv-size').value;
      const sort = host.querySelector('#inv-sort').value;
      const availableOnly = host.querySelector('#inv-available-only').checked;
      let rows = rowsBase.map((r) => Object.assign({}, r, {
        estWeight: global.CALC.productWeight(r.size, r.net, App.state.settings.weightFactor),
        availableReels: matchingReels(r),
      }));
      if (q) rows = rows.filter((r) => r.quality.toLowerCase().includes(q) || r.family.toLowerCase().includes(q));
      if (fam) rows = rows.filter((r) => r.family === fam);
      if (gsm) rows = rows.filter((r) => String(r.gsm) === gsm);
      if (size) rows = rows.filter((r) => String(r.size) === size);
      if (availableOnly) rows = rows.filter((r) => r.availableReels.length > 0);
      if (sort === 'bal-desc') rows.sort((a, b) => b.net - a.net);
      else if (sort === 'bal-asc') rows.sort((a, b) => a.net - b.net);
      else if (sort === 'weight-desc') rows.sort((a, b) => b.estWeight - a.estWeight);

      const totalQty = global.CALC.round6(rows.reduce((sum, r) => sum + r.net, 0));
      const totalWeight = global.CALC.round6(rows.reduce((sum, r) => sum + r.estWeight, 0));
      host.querySelector('#inv-table').innerHTML = `
        <table class="data-table sticky-head">
          <thead><tr>
            <th>${t('quality')}</th><th>${t('gsm')}</th><th>${t('size')}</th>
            <th class="num">${t('addQty')}</th><th class="num">${t('outQty')}</th>
            <th class="num">${t('balance')}</th><th class="num">${lang() ? 'الوزن التقريبي (كجم)' : 'Estimated weight (kg)'}</th>
            <th>${t('actions')}</th>
          </tr></thead>
          <tbody>${rows.length ? rows.map((r) => `
            <tr>
              <td data-label="${t('quality')}">${esc(r.family)}</td>
              <td data-label="${t('gsm')}">${fmtNum(r.gsm)}</td>
              <td data-label="${t('size')}">${fmtNum(r.size)}</td>
              <td class="num pos" data-label="${t('addQty')}">${fmtNum(r.add)}</td>
              <td class="num neg" data-label="${t('outQty')}">${fmtNum(r.out)}</td>
              <td data-label="${t('balance')}"><span class="badge bal-pos">${fmtNum(r.net)}</span></td>
              <td class="num" data-label="${lang() ? 'الوزن التقريبي' : 'Estimated weight'}">${fmtNum(r.estWeight, 2)}</td>
              <td><button class="link-btn" data-view="${esc(r.key)}">${t('details')}</button></td>
            </tr>`).join('') : `<tr><td colspan="8" class="empty">${lang() ? 'لا توجد أصناف برصيد مطابقة للبحث' : 'no items match'}</td></tr>`}</tbody>
          <tfoot><tr>
            <td colspan="5">${t('total')} (${fmtNum(rows.length)} ${lang() ? 'مقاس' : 'sizes'})</td>
            <td class="num">${fmtNum(totalQty)}</td><td class="num">${fmtNum(totalWeight, 2)}</td><td></td>
          </tr></tfoot>
        </table>`;
      host.querySelectorAll('[data-view]').forEach((btn) =>
        btn.addEventListener('click', () => openDetails(btn.dataset.view)));
    }

    function openDetails(key) {
      const row = rowsBase.find((r) => r.key === key);
      if (!row) return;
      const list = matchingReels(row);
      const codesHtml = list.length ? list.map((r) => `
        <tr><td>${fmtNum(r.rollNo)}</td><td>${fmtNum(r.reelNo)}</td>
          <td>${r.size == null ? '—' : fmtNum(r.size)}</td>
          <td>${r.weight == null ? '—' : fmtNum(r.weight, 3)}</td>
          <td>${r.status === 'available' ? (lang() ? 'متاحة' : 'Available') : esc(r.status || '—')}</td></tr>`).join('')
        : `<tr><td colspan="5" class="empty">${lang() ? 'لا توجد أكواد بكر مسجلة كمتاحة لهذا المقاس' : 'No available reel codes recorded for this size'}</td></tr>`;
      const node = el(`<div>
        <div class="details-head"><div><h4>${esc(row.family)}</h4>
          <p class="muted">${t('gsm')}: <strong>${fmtNum(row.gsm)}</strong> — ${t('size')}: <strong>${fmtNum(row.size)}</strong></p></div>
          <div class="details-balance">
            <div class="stat-mini"><span>${t('balance')}</span><strong class="pos">${fmtNum(row.net)}</strong></div>
            <div class="stat-mini"><span>${lang() ? 'الوزن التقريبي' : 'Estimated weight'}</span><strong>${fmtNum(row.estWeight, 2)} ${t('kg')}</strong></div>
            <div class="stat-mini"><span>${lang() ? 'عدد الأكواد المسجلة' : 'Recorded reel codes'}</span><strong>${fmtNum(list.length)}</strong></div>
          </div></div>
        <h4>${lang() ? 'أكواد البكر الموجودة بالمخزن' : 'Available reel codes'}</h4>
        <div class="table-wrap scroll-tall"><table class="data-table">
          <thead><tr><th>${lang() ? 'كود الرول' : 'Roll code'}</th><th>${lang() ? 'كود البكرة' : 'Reel code'}</th>
            <th>${t('size')}</th><th>${lang() ? 'وزن البكرة (كجم)' : 'Reel weight (kg)'}</th><th>${lang() ? 'الحالة' : 'Status'}</th></tr></thead>
          <tbody>${codesHtml}</tbody></table></div>
      </div>`);
      openModal(node, { title: lang() ? 'تفاصيل المقاس وأكواد البكر' : 'Size details & reel codes', wide: true });
    }

    host.querySelector('#inv-search').addEventListener('input', draw);
    ['#inv-family','#inv-gsm','#inv-size','#inv-sort','#inv-available-only'].forEach((selector) =>
      host.querySelector(selector).addEventListener('change', draw));
    host.querySelector('#inv-clear').addEventListener('click', () => {
      ['#inv-search','#inv-family','#inv-gsm','#inv-size'].forEach((selector) => { host.querySelector(selector).value = ''; });
      host.querySelector('#inv-available-only').checked = false;
      host.querySelector('#inv-sort').value = 'name';
      draw();
    });
    host.querySelector('#inv-export').addEventListener('click', () => {
      const exportRows = rowsBase.map((r) => ({
        quality: r.quality, gsm: r.gsm, size: r.size, add: r.add, out: r.out, net: r.net,
        weight: null, estWeight: global.CALC.productWeight(r.size, r.net, App.state.settings.weightFactor),
      }));
      global.EXCEL.exportInventoryBuckets(exportRows, App.state.settings.weightFactor);
      toast(lang() ? 'تم تنزيل ملف رصيد المخزن' : 'inventory Excel downloaded', 'ok');
    });
    draw();
  }

  /* ================= Product management ================= */
  function renderProducts(host) {
    host.innerHTML = `
      <div class="page-head"><h2>${esc(t('products'))}</h2>
        <div class="head-actions">
          <label class="chk"><input type="checkbox" id="pr-all"> ${lang() ? 'إظهار كل المقاسات (حتى الرصيد الصفر)' : 'show all sizes (incl. zero)'}</label>
          <button class="btn btn-primary" id="pr-add">+ ${lang() ? 'مقاس جديد' : 'New size'}</button>
        </div></div>
      <p class="muted small">${lang() ? 'المنتجان المعتمدان فقط: «تست لينر معالج» و«توب لاينر» — لا يُسمح بأسماء جديدة لمنع التكرار.' : 'Only the two approved products: تست لينر معالج and توب لاينر — new names are blocked to prevent duplicates.'}</p>
      <div class="card table-wrap"><table class="data-table">
        <thead><tr><th>${t('quality')}</th><th>${t('gsm')}</th><th>${t('size')}</th>
          <th class="num">${t('balance')}</th><th>${lang() ? 'المصدر' : 'Source'}</th><th>${t('actions')}</th></tr></thead>
        <tbody id="pr-rows"></tbody></table></div>`;

    function draw() {
      const showAll = host.querySelector('#pr-all').checked;
      const rows = App.state.products.filter((p) => {
        if (showAll) return true;
        const balance = App.state.balances.get(p.combo);
        return balance && Number(balance.net) !== 0;
      }).slice().sort((a, b) => {
        const fa = familyOf(a.quality), fb = familyOf(b.quality);
        const ia = CANON.indexOf(fa), ib = CANON.indexOf(fb);
        const oa = ia < 0 ? CANON.length : ia, ob = ib < 0 ? CANON.length : ib;
        return oa - ob || fa.localeCompare(fb, 'ar') || Number(a.gsm) - Number(b.gsm) || Number(a.size) - Number(b.size);
      });
      const shownFamilies = new Set();
      host.querySelector('#pr-rows').innerHTML = rows.length ? rows.map((p) => {
        const b = App.state.balances.get(p.combo);
        const family = familyOf(p.quality);
        const showFamily = !shownFamilies.has(family);
        shownFamilies.add(family);
        return `<tr>
          <td data-label="${t('quality')}">${showFamily ? esc(family) : ''}</td>
          <td data-label="${t('gsm')}">${fmtNum(p.gsm)}</td>
          <td data-label="${t('size')}">${fmtNum(p.size)}</td>
          <td data-label="${t('balance')}" class="num">${fmtNum(b ? b.net : 0)}</td>
          <td data-label="${lang() ? 'المصدر' : 'Source'}">${esc(p.source || '')}</td>
          <td class="actions-cell">
            <button class="icon-btn" data-edit="${p.id}" title="${t('edit')}">✎</button>
            <button class="icon-btn danger" data-del="${p.id}" title="${t('del')}">🗑</button>
          </td></tr>`;
      }).join('') : `<tr><td colspan="6" class="empty">${lang() ? 'لا توجد أصناف برصيد — فعّل الإظهار الكل' : 'no items with stock'}</td></tr>`;
      host.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => editProduct(Number(b.dataset.edit))));
      host.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
        const p = App.state.products.find((x) => x.id === Number(b.dataset.del));
        if (!p) return;
        const hasTx = App.state.transactions.some((r) => global.CALC.sameCombo(r, p.quality, p.gsm, p.size));
        const msg = hasTx
          ? (lang()
            ? `⚠ هذا الصنف له حركات مسجلة (${fmtNum(App.state.transactions.filter((r) => global.CALC.sameCombo(r, p.quality, p.gsm, p.size)).length)} حركة). حذف الصنف لن يحذف الحركات لكن لن يظهر في قائمة الأصناف. متابعة؟`
            : 'This product has transactions. Delete it from the product list? Transactions are kept.')
          : (lang() ? `حذف الصنف "${p.quality} / ${p.gsm} / ${p.size}"؟` : `Delete "${p.quality} / ${p.gsm} / ${p.size}"?`);
        const ok = await confirmDialog({ title: lang() ? 'حذف صنف' : 'Delete product', message: msg, danger: true });
        if (!ok) return;
        await global.DB.del('products', p.id);
        await global.DB.logAudit({ entity: 'product', action: 'delete', entityId: p.id, before: p, after: null });
        toast(lang() ? 'تم الحذف' : 'deleted', 'ok');
        await App.refresh();
      }));
    }

    function editProduct(id) {
      const p = App.state.products.find((x) => x.id === id);
      const isNew = !p;
      const currentFamily = p ? familyOf(p.quality) : '';
      /* only the two approved product names can be selected/created */
      const options = [...new Set(CANON.concat(currentFamily && CANON.indexOf(currentFamily) < 0 ? [currentFamily] : []))];
      const node = el(`<div class="edit-prod">
        <label class="field"><span>${t('quality')} *</span>
          <select id="p-q">${options.map((o) => `<option ${p && o === p.quality ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>
        <label class="field"><span>${t('gsm')} *</span><input id="p-g" type="number" step="any" value="${esc(p && p.gsm != null ? p.gsm : '')}"></label>
        <label class="field"><span>${t('size')} *</span><input id="p-s" type="number" step="any" value="${esc(p && p.size != null ? p.size : '')}"></label>
        <div class="form-error" id="p-err"></div>
        <div class="confirm-actions">
          <button class="btn btn-primary" id="p-save">${t('save')}</button>
          <button class="btn btn-ghost" id="p-cancel">${t('cancel')}</button>
        </div></div>`);
      openModal(node, { title: isNew ? (lang() ? 'مقاس جديد' : 'New size') : (lang() ? 'تعديل صنف' : 'Edit product') });
      node.querySelector('#p-cancel').addEventListener('click', closeModal);
      node.querySelector('#p-save').addEventListener('click', async () => {
        const q = node.querySelector('#p-q').value.trim();
        const g = node.querySelector('#p-g').value;
        const s = node.querySelector('#p-s').value;
        const err = node.querySelector('#p-err');
        if (!q || g === '' || s === '') { err.textContent = lang() ? 'أكمل جميع الحقول' : 'fill all fields'; return; }
        const combo = global.CALC.comboKey(q, g, s);
        const clash = App.state.products.find((x) => x.combo === combo && (!p || x.id !== p.id));
        if (clash) { err.textContent = lang() ? 'يوجد صنف بنفس المواصفات' : 'duplicate combo exists'; return; }
        const rec = { quality: q, gsm: Number(g), size: Number(s), combo, source: p ? p.source : 'manual', createdAt: p ? p.createdAt : new Date().toISOString() };
        if (p) {
          await global.DB.put('products', Object.assign({ id: p.id }, rec));
          await global.DB.logAudit({ entity: 'product', action: 'edit', entityId: p.id, before: p, after: rec });
        } else {
          await global.DB.add('products', rec);
          await global.DB.logAudit({ entity: 'product', action: 'add', entityId: null, before: null, after: rec });
        }
        closeModal();
        toast(lang() ? 'تم الحفظ' : 'saved', 'ok');
        await App.refresh();
      });
    }

    host.querySelector('#pr-add').addEventListener('click', () => editProduct(null));
    host.querySelector('#pr-all').addEventListener('change', draw);
    draw();
  }

  global.App.registerView('inventory', renderInventory);
  global.App.registerView('products', renderProducts);
})(window);
