/* =========================================================================
   app.js — التشغيل، الحالة العامة، التنقل، لوحة التحكم
   Agrima — نظام إدارة المخزون والرولات والبكر والإنتاج وأذون الصرف
   -------------------------------------------------------------------------
   قاعدة إلزامية: تسجيل البكر هو مصدر الإنتاج الجديد — لا يوجد نموذج
   إضافة إنتاج يدوي مستقل (أُزيل من الواجهة والمسارات). سجل الإنتاج
   للعرض والمراجعة فقط وتُضاف إليه الحركات تلقائيًا من تسجيل البكر.

   Routes:
     #dashboard   لوحة التحكم
     #inventory   الرصيد الحالي
     #reels-add   تسجيل البكر (إضافة رول جديد — مصدر الإنتاج)
     #rolls       إدارة الرولات والبكر
     #production  سجل الإنتاج (عرض ومراجعة)
     #issuedocs   أذون الصرف · #issuedoc عرض الإذن A4 · #baker-issue نموذج الإذن
     #outlog      سجل حركات الصرف
     #customers   العملاء
     #products    إدارة الأصناف
     #reports     التقارير والطباعة
     #import      الاستيراد والتصدير
     #backup      النسخ الاحتياطي · #settings الإعدادات
     #history     سجل الحركات الكامل (توافق) · #addtx محرر الحركات المختلطة
   Legacy links: #additions → #rolls · #baker → #rolls · #baker-add → #reels-add
   ========================================================================= */
(function (global) {
  'use strict';
  const { t, el, esc, fmtNum, fmtDate, todayISO, toast, confirmDialog, openModal, closeModal, EventBus } = global.UI;

  const App = {
    state: {
      ready: false,
      products: [],
      transactions: [],
      permits: [],
      balances: new Map(),
      balancesW: new Map(), /* roll-weight dimension: product→gsm→weight→size */
      settings: { companyName: '', lang: 'ar', weightFactor: 7.5 },
    },
    views: {},
    registerView(name, fn) { App.views[name] = fn; },
  };

  /* ---------------- shared helpers ---------------- */

  /* The business only has TWO product types. Everything else in the data is
     historical noise; map by name so all screens agree on one canonical set. */
  function productFamily(name) {
    const value = String(name || '').replace(/[\s\u0640]+/g, ' ').trim().toLowerCase();
    if (value.includes('تست') && value.includes('لينر') && value.includes('معالج')) return 'تست لينر معالج';
    if (value.includes('توب') && value.includes('لاينر')) return 'توب لاينر';
    return String(name || '').trim();
  }
  App.productFamily = productFamily;
  const CANON_FAMILIES = ['تست لينر معالج', 'توب لاينر'];

  /* production customer appears in the data as both 'انتاج' and 'الإنتاج' */
  function isProductionCustomer(name) {
    const v = String(name || '').replace(/[\s\u0640]+/g, '').toLowerCase();
    return v === 'انتاج' || v === 'الانتاج' || v === 'إنتاج' || v === 'الإنتاج';
  }
  function canonicalCustomer(name) {
    return isProductionCustomer(name) ? 'الإنتاج' : String(name || '').trim();
  }
  App.canonicalCustomer = canonicalCustomer;

  /* product dropdown: the two approved products are ALWAYS offered (even on
     a fresh database); historical non-canonical families stay for old data */
  function familyOptions() {
    const extra = [];
    for (const p of App.state.products) {
      const f = productFamily(p.quality);
      if (!CANON_FAMILIES.includes(f) && !extra.includes(f)) extra.push(f);
    }
    return CANON_FAMILIES.concat(extra);
  }

  /* unique customer list for dropdowns (production variants merged) */
  function customerOptions() {
    const seen = new Map();
    for (const r of App.state.transactions) {
      const raw = String(r.customer || '').trim();
      if (!raw) continue;
      const key = canonicalCustomer(raw);
      if (!seen.has(key)) seen.set(key, key);
    }
    return [...seen.keys()].filter((k) => k !== 'الإنتاج').sort((a, b) => a.localeCompare(b, 'ar'));
  }

  /* group transactions that belong to one movement (multi-size entry);
     legacy rows without groupId act as single-row groups */
  function buildGroups(rows) {
    const map = new Map();
    for (const r of rows) {
      const key = r.groupId ? 'G:' + r.groupId : 'S:' + (r.id || 0);
      let g = map.get(key);
      if (!g) {
        g = {
          key,
          groupId: r.groupId || null,
          legacyId: r.groupId ? null : r.id,
          date: r.date,
          quality: r.quality,
          gsm: r.gsm,
          customer: r.customer,
          permitNo: r.permitNo,
          settlement: r.settlement,
          notes: r.notes,
          source: r.source,
          void: r.void,
          rows: [],
        };
        map.set(key, g);
      }
      g.rows.push(r);
    }
    const groups = [...map.values()];
    for (const g of groups) {
      g.rows.sort((a, b) => (Number(a.size) || 0) - (Number(b.size) || 0));
      g.add = g.rows.reduce((s, r) => s + (Number(r.addQty) || 0), 0);
      g.out = g.rows.reduce((s, r) => s + (Number(r.outQty) || 0), 0);
      g.sizesLabel = g.rows.map((r) => `${fmtNum(r.size == null ? '—' : r.size)}×${fmtNum(r.addQty || r.outQty || 0)}`).join('، ');
    }
    groups.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.rows[0].id || 0) - (a.rows[0].id || 0)));
    return groups;
  }
  App.buildGroups = buildGroups;

  /* ---------------- data loading ---------------- */
  async function loadAll() {
    const [products, transactions, permits] = await Promise.all([
      global.DB.getAll('products'),
      global.DB.getAll('transactions'),
      global.DB.getAll('permits'),
    ]);
    App.state.products = products;
    App.state.transactions = transactions;
    App.state.permits = permits;
    if (global.PERM && global.PERM.isWarehouse()) {
      /* أمين المخزن: الرصيد من اللقطة التجميعية المستلمة من النظام
         (app_stock_balances عبر RLS) — لا يجوز حسابه من الحركات لأن
         جهازه يحمل أسطر نافذة اليومين فقط وليس كل التاريخ */
      const viewRows = await global.DB.getAll('stockview');
      const map = new Map();
      for (const r of viewRows) {
        map.set(r.key || global.CALC.comboKey(r.quality, r.gsm, r.size), {
          quality: r.quality, gsm: r.gsm, size: r.size,
          add: r.add, out: r.out, net: r.net,
        });
      }
      App.state.balances = map;
    } else {
      App.state.balances = global.CALC.computeBalances(transactions);
    }
    App.state.balancesW = global.CALC.computeBalancesByWeight(transactions);
    App.state.settings.companyName = await global.DB.getSetting('companyName', '');
    App.state.settings.lang = await global.DB.getSetting('lang', 'ar');
    const wf = await global.DB.getSetting('weightFactor', 7.5);
    App.state.settings.weightFactor = Number(wf) || 7.5;
    App.state.ready = true;
  }

  /* reload from DB and re-render current view */
  async function refresh() {
    await loadAll();
    EventBus.emit('data', null);
    render();
  }
  App.refresh = refresh;

  /* helper: balance of a combo from the live map (all roll weights combined) */
  function balanceOf(quality, gsm, size) {
    const key = global.CALC.comboKey(quality, gsm, size);
    return App.state.balances.get(key) || { quality, gsm, size, add: 0, out: 0, net: 0 };
  }
  App.balanceOf = balanceOf;

  /* helper: balance inside ONE roll-weight bucket (weight null → legacy rows) */
  function balanceBy(quality, gsm, weight, size) {
    const key = global.CALC.comboKeyW(quality, gsm, weight, size);
    return App.state.balancesW.get(key) || { quality, gsm, weight, size, add: 0, out: 0, net: 0 };
  }
  App.balanceBy = balanceBy;

  /* ---------------- router ----------------
     المسارات القديمة تعمل جميعها: حركة متابعة البكر أصبحت إدارة الرولات
     والبكر، وإضافة الإنتاج اليدوية أُزيلت (تسجيل البكر هو المصدر الوحيد) */
  const ROUTE_REDIRECT = {
    additions: 'rolls',
    withdrawals: 'issuedocs',
    baker: 'rolls',
    'baker-add': 'reels-add',
  };
  /* label of a route for the document title — explicit map for the dashed
     routes whose ids don't match i18n keys (audit fix V4), and a safe
     fallback that never prints a raw route id */
  const ROUTE_LABEL_KEYS = {
    'reels-add': 'reelsAdd', 'baker-issue': 'issuedocs', 'issuedoc': 'issuedoc',
    'reservation-details': 'reservationDetails', 'reservation-form': 'reservationForm',
    'addtx': 'addtx', 'purchase-form': 'purchaseForm', 'purchase-details': 'purchaseDetails',
    'purchases-reports': 'purchaseReports', 'rolls': 'rollsRoute',
  };
  function routeTitle(route) {
    const key = ROUTE_LABEL_KEYS[route] || route;
    const label = I18N_OR(key);
    return label && label !== key ? label : t('appName');
  }
  function I18N_OR(key) {
    const lang2 = UI.getLang() === 'en' ? 'en' : 'ar';
    return (UI.I18N[lang2] && UI.I18N[lang2][key]) || (lang2 === 'en' ? UI.I18N.ar[key] : undefined);
  }

  let currentRoute = 'dashboard';
  /* الصفحة الرئيسية لكل دور — أمين المخزن يبدأ من الرصيد الحالي مباشرة */
  function homeRoute() {
    if (global.PERM && global.PERM.routeAllowed('inventory') && global.PERM.isWarehouse()) return 'inventory';
    return 'dashboard';
  }
  function render() {
    const view = App.views[currentRoute] || App.views.dashboard;
    const host = document.getElementById('view');
    if (!host) { console.error('[app] #view host missing'); return; }
    host.innerHTML = '';
    Promise.resolve(view(host)).catch((e) => {
      console.error('[view]', currentRoute, e);
      host.innerHTML = `<div class="card error-card">${esc(e.message || e)}</div>`;
    });
  }
  function navigate(route) {
    const target = ROUTE_REDIRECT[route] || route;
    /* بوابة الصلاحيات: حتى لو عُدّل الرابط يدويًا لا يفتح مسارًا غير مسموح —
       المصدر الرسمي للدور هو قاعدة البيانات (RLS) والفحص هنا للواجهة */
    if (global.PERM && global.PERM.state.role != null && !global.PERM.routeAllowed(target)) {
      toast(UI.getLang() === 'ar' ? 'لا تملك صلاحية الوصول إلى هذا القسم' : 'No permission for this section', 'err');
      currentRoute = homeRoute();
    } else {
      currentRoute = target;
    }
    /* keep the URL in sync (deep links + refresh keep their context);
       replaceState avoids an extra history entry and hashchange loops */
    if (location.hash !== '#' + currentRoute) {
      try { history.replaceState(null, '', '#' + currentRoute); } catch (e2) { /* ignore */ }
    }
    document.querySelectorAll('.nav-item').forEach((n) => {
      n.classList.toggle('active', n.dataset.route === currentRoute);
    });
    document.title = `${routeTitle(currentRoute)} — ${t('appName')}`;
    render();
    closeMobileNav();
  }
  App.navigate = navigate;
  App.rerender = render;
  App.currentRoute = () => currentRoute;

  function closeMobileNav() {
    document.body.classList.remove('nav-open');
  }

  /* ---------------- shared dropdown data ---------------- */
  function knownGsms(family) {
    const set = new Set();
    for (const p of App.state.products) {
      if (family && productFamily(p.quality) !== family) continue;
      if (p.gsm != null && p.gsm !== '') set.add(String(p.gsm));
    }
    return [...set].sort((a, b) => Number(a) - Number(b));
  }
  function knownWeights() {
    const set = new Set();
    for (const r of App.state.transactions) {
      if (r.weight != null && r.weight !== '') set.add(String(Number(r.weight)));
    }
    return [...set].sort((a, b) => Number(a) - Number(b));
  }
  App.knownGsms = knownGsms;
  App.knownWeights = knownWeights;

  /* ---------------- movement form (add / edit group) ---------------- */
  function nextGroupId() {
    try { return crypto.randomUUID(); } catch (e) {
      return 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }
  }

  /**
   * Legacy unified movement form — kept ONLY for editing the rare mixed
   * (إضافة + صرف) groups; the daily flows are #baker-add / #baker-issue.
   */
  function txForm(host, editGroup, preset) {
    const isEdit = !!editGroup;
    const firstType = preset === 'out' ? 'out' : 'add';
    const customers = customerOptions();
    const families = familyOptions();
    const existing = editGroup || null;
    const ar = () => UI.getLang() === 'ar';
    const editCustomer = existing
      ? (existing.rows.map((r) => r.customer).find((c) => c && !isProductionCustomer(c)) || '')
      : '';

    host.innerHTML = `
      <div class="page-head"><h2>${isEdit
        ? (ar() ? 'تعديل حركة' : 'Edit movement')
        : (ar() ? 'حركة جديدة' : 'New movement')}</h2></div>
      <div class="card form-card">
        <p class="muted small form-sub">${ar()
          ? 'محرر الحركات المختلطة (إضافة وصرف في نفس الحركة) — للعمليات اليومية استخدم «حركة متابعة البكر».'
          : 'Legacy editor for mixed movements — for daily work use the blank-roll movement section.'}</p>
        <form id="tx-form" novalidate>
          <div class="form-grid">
            <label class="field"><span>${t('date')} *</span>
              <input type="date" id="f-date" required value="${esc(existing ? existing.date : todayISO())}"></label>
            <label class="field"><span>${t('quality')} *</span>
              <select id="f-quality" required>
                <option value="">— ${ar() ? 'اختر الصنف' : 'select product'} —</option>
                ${families.map((family) => `<option value="${esc(family)}" ${existing && productFamily(existing.quality) === family ? 'selected' : ''}>${esc(family)}</option>`).join('')}
              </select></label>
            <label class="field"><span>${t('gsm')} *</span>
              <input type="number" id="f-gsm" min="1" step="any" placeholder="135" value="${esc(existing && existing.gsm != null ? existing.gsm : '')}"></label>
            <label class="field"><span>${ar() ? 'العميل (لأسطر الصرف)' : 'Customer (for withdrawal rows)'}</span>
              <input type="text" id="f-customer" list="customer-list"
                placeholder="${ar() ? 'اختياري — بدون اسم يُسجَّل الصرف على الإنتاج' : 'optional — defaults to Production'}"
                value="${esc(editCustomer)}">
              <datalist id="customer-list">${customers.map((c) => `<option value="${esc(c)}"></option>`).join('')}</datalist></label>
            <label class="field"><span>${t('permit')}</span>
              <input type="text" id="f-permit" value="${esc(existing ? existing.permitNo : '')}"></label>
            <label class="field"><span>${t('rollWeight')}</span>
              <input type="number" id="f-weight" min="0" step="0.001" value="${esc(existing && existing.rows[0].weight != null ? existing.rows[0].weight : '')}"></label>
            <label class="field"><span>${t('settlement')}</span>
              <select id="f-settlement">
                <option value="">—</option>
                <option value="غ" ${existing && existing.settlement === 'غ' ? 'selected' : ''}>غ</option>
                <option value="ض" ${existing && existing.settlement === 'ض' ? 'selected' : ''}>ض</option>
              </select></label>
            <label class="field field-wide"><span>${t('notes')}</span>
              <input type="text" id="f-notes" value="${esc(existing ? existing.notes : '')}"></label>
          </div>
          <section class="field field-wide" id="multi-size-section">
            <div class="card-head-row"><strong>${ar() ? 'المقاسات والكميات' : 'Sizes and quantities'}</strong>
              <button type="button" class="btn btn-ghost" id="add-size-row">+ ${t('addSizeRow')}</button></div>
            <div id="size-rows"></div>
          </section>
          <div class="form-hint" id="balance-hint"></div>
          <div class="form-error" id="form-error" role="alert"></div>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary">${t('save')}</button>
            <button type="button" class="btn btn-ghost" id="f-cancel">${t('cancel')}</button>
          </div>
        </form>
      </div>`;

    const form = host.querySelector('#tx-form');
    const qSel = host.querySelector('#f-quality');
    const gsmIn = host.querySelector('#f-gsm');

    const rowsHost = host.querySelector('#size-rows');
    const addSizeRow = (type = firstType, sizeValue = '', qtyValue = '') => {
      const row = document.createElement('div');
      row.className = 'size-entry-row';
      row.dataset.type = type;
      row.innerHTML =
        '<div class="row-type seg-control" role="group">' +
          `<button type="button" data-t="add" class="${type === 'add' ? 'active' : ''}">${ar() ? 'إضافة' : 'Add'}</button>` +
          `<button type="button" data-t="out" class="${type === 'out' ? 'active' : ''}">${ar() ? 'صرف' : 'Withdraw'}</button>` +
        '</div>' +
        '<label class="field"><span>' + t('size') + ' *</span><input class="line-size" type="number" min="1" step="any" placeholder="100"></label>' +
        '<label class="field"><span class="line-qty-label"></span><input class="line-qty" type="number" min="1" step="1" placeholder="0"></label>' +
        '<button type="button" class="btn btn-ghost remove-size-row" aria-label="remove">×</button>' +
        '<div class="line-balance small"></div>';
      row.querySelector('.line-size').value = sizeValue == null ? '' : sizeValue;
      row.querySelector('.line-qty').value = qtyValue == null ? '' : qtyValue;
      const setQtyLabel = () => {
        row.querySelector('.line-qty-label').textContent =
          (row.dataset.type === 'add' ? t('addQty') : t('outQty')) + ' *';
      };
      setQtyLabel();
      row.querySelectorAll('.row-type button').forEach((b) => b.addEventListener('click', () => {
        row.dataset.type = b.dataset.t;
        row.querySelectorAll('.row-type button').forEach((x) => x.classList.toggle('active', x === b));
        setQtyLabel();
        row.querySelector('.line-size').dispatchEvent(new Event('input'));
      }));
      rowsHost.appendChild(row);
      row.querySelector('.remove-size-row').addEventListener('click', () => {
        if (rowsHost.querySelectorAll('.size-entry-row').length === 1) {
          row.querySelector('.line-size').value = '';
          row.querySelector('.line-qty').value = '';
        } else row.remove();
        updateHint();
      });
      const updateLineHint = () => {
        const size = Number(row.querySelector('.line-size').value);
        const q = qSel.value, gsm = Number(gsmIn.value);
        const hint = row.querySelector('.line-balance');
        if (q && gsm > 0 && size > 0) {
          const bal = balanceOf(q, gsm, size);
          let txt = (ar() ? 'الرصيد الحالي: ' : 'Current balance: ') + fmtNum(bal.net);
          if (row.dataset.type === 'out' && Number(row.querySelector('.line-qty').value) > bal.net) {
            txt += (ar() ? ' — الكمية أكبر من الرصيد' : ' — exceeds balance');
          }
          hint.textContent = txt;
        } else hint.textContent = '';
      };
      row.querySelector('.line-size').addEventListener('input', () => { updateLineHint(); updateHint(); });
      row.querySelector('.line-qty').addEventListener('input', () => { updateLineHint(); updateHint(); });
      return row;
    };
    host.querySelector('#add-size-row').addEventListener('click', () => { addSizeRow(firstType); updateHint(); });
    if (isEdit && existing) {
      existing.rows.forEach((r) => addSizeRow((Number(r.addQty) || 0) > 0 ? 'add' : 'out', r.size, r.addQty || r.outQty || 0));
    } else {
      addSizeRow(firstType);
    }
    const refreshLineHints = () => {
      rowsHost.querySelectorAll('.size-entry-row').forEach((row) => row.querySelector('.line-size').dispatchEvent(new Event('input')));
    };
    qSel.addEventListener('change', refreshLineHints);
    gsmIn.addEventListener('input', refreshLineHints);

    function updateHint() {
      const hint = host.querySelector('#balance-hint');
      if (!hint) return;
      const lines = readLines();
      if (!qSel.value || !Number(gsmIn.value) || !lines.length) { hint.innerHTML = ''; return; }
      const addSum = global.CALC.round6(lines.filter((l) => l.type === 'add').reduce((s, l) => s + l.qty, 0));
      const outSum = global.CALC.round6(lines.filter((l) => l.type === 'out').reduce((s, l) => s + l.qty, 0));
      const parts = [];
      if (addSum) parts.push((ar() ? 'إجمالي الإضافة: ' : 'Total additions: ') + `<strong>${fmtNum(addSum)}</strong>`);
      if (outSum) parts.push((ar() ? 'إجمالي الصرف: ' : 'Total withdrawals: ') + `<strong>${fmtNum(outSum)}</strong>`);
      hint.innerHTML = parts.join(' &nbsp;•&nbsp; ') || '';
    }

    host.querySelector('#f-cancel').addEventListener('click', () => navigate('history'));

    function readLines() {
      return [...host.querySelectorAll('.size-entry-row')].map((row) => ({
        type: row.dataset.type === 'out' ? 'out' : 'add',
        size: Number(row.querySelector('.line-size').value),
        qty: Number(row.querySelector('.line-qty').value),
      })).filter((l) => Number.isFinite(l.size) && l.size > 0);
    }

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const errBox = host.querySelector('#form-error');
      errBox.textContent = '';
      const quality = qSel.value.trim();
      const gsm = gsmIn.value ? Number(gsmIn.value) : null;
      const headerCustomer = host.querySelector('#f-customer').value.trim();
      const lines = readLines();
      const header = {
        date: host.querySelector('#f-date').value,
        quality, gsm,
        customer: headerCustomer,
        permitNo: host.querySelector('#f-permit').value.trim(),
        weight: host.querySelector('#f-weight').value === '' ? null : Number(host.querySelector('#f-weight').value),
        settlement: host.querySelector('#f-settlement').value,
        notes: host.querySelector('#f-notes').value.trim(),
        source: isEdit ? (existing.source || 'manual') : 'manual',
      };

      if (!/^\d{4}-\d{2}-\d{2}$/.test(header.date) || !quality || !Number.isFinite(gsm) || gsm <= 0 || !lines.length) {
        errBox.textContent = ar()
          ? 'أكمل التاريخ والصنف والجرام، وأدخل مقاسًا صحيحًا لكل سطر.'
          : 'Complete date, product and GSM, then enter a valid size in every row.';
        return;
      }
      if (lines.some((l) => !Number.isFinite(l.qty) || l.qty <= 0)) {
        errBox.textContent = ar()
          ? 'أدخل كمية صحيحة أكبر من صفر لكل مقاس.'
          : 'Enter a quantity greater than zero for every size.';
        return;
      }
      const dupKey = (l) => l.type + '|' + String(l.size);
      const seenKeys = new Set();
      let duplicated = false;
      for (const l of lines) {
        if (seenKeys.has(dupKey(l))) { duplicated = true; break; }
        seenKeys.add(dupKey(l));
      }
      if (duplicated) {
        errBox.textContent = ar()
          ? 'يوجد مقاس مكرر بنفس النوع (إضافة/صرف). اجمع كميته في سطر واحد.'
          : 'A size is repeated with the same type. Combine its quantity into one row.';
        return;
      }

      const pending = lines.map((l) => Object.assign({}, header, {
        size: l.size,
        addQty: l.type === 'add' ? l.qty : 0,
        outQty: l.type === 'out' ? l.qty : 0,
        customer: l.type === 'add' ? 'الإنتاج' : (headerCustomer || 'الإنتاج'),
      }));
      const negative = pending.filter((line) => line.outQty > 0 &&
        balanceOf(quality, gsm, line.size).net - line.outQty < 0);
      if (negative.length) {
        const ok = await confirmDialog({
          title: t('confirm'),
          message: ar()
            ? `تنبيه: الصرف أكبر من الرصيد في ${negative.length} مقاس (${negative.map((n) => n.size).join('، ')}). هل تريد المتابعة؟`
            : `Warning: withdrawal exceeds stock for ${negative.length} size(s) (${negative.map((n) => n.size).join(', ')}). Continue?`,
          danger: true, yesLabel: ar() ? 'متابعة بالسالب' : 'Proceed',
        });
        if (!ok) return;
      }

      try {
        if (isEdit) {
          await global.TX.replaceMovement(existing, pending);
          toast(ar() ? 'تم تحديث الحركة وتحديث الرصيد تلقائيًا' : 'movement updated, balances recalculated', 'ok');
        } else {
          /* one atomic multi-row movement (no partial writes on failure) */
          await global.TX.addTransactionGroup(pending);
          toast(ar()
            ? `تم تسجيل ${pending.length} مقاس وتحديث الأرصدة`
            : `${pending.length} size(s) saved and balances updated`, 'ok');
        }
        await refresh();
        const hasAdd = pending.some((l) => l.addQty > 0);
        const hasOut = pending.some((l) => l.outQty > 0);
        navigate(hasAdd && hasOut ? 'history' : (hasOut ? 'issuedocs' : 'baker'));
      } catch (saveError) {
        if (saveError && saveError.type === 'validation') {
          errBox.innerHTML = saveError.errors.map((x) => `• ${esc(x.msg)}`).join('<br>');
        } else {
          errBox.textContent = String(saveError.message || saveError);
          console.error(saveError);
        }
      }
    });
  }
  App.openTxForm = txForm;

  /* =======================================================================
     SECTION: حركة متابعة البكر
     ======================================================================= */

  /* ================= إضافة الإنتاج اليدوية أُزيلت =================
     تسجيل البكر (#reels-add في rolls.js) هو المصدر الوحيد للإنتاج الجديد:
     حفظ الرول يُنشئ حركات الإنتاج تلقائيًا ويحدث الرصيد. نموذج «إضافة
     إنتاج» المستقل حُذف من الواجهة والمسارات (#baker-add يتحول تلقائيًا)،
     والحركات التاريخية القديمة وسجل الإنتاج والتقارير محفوظة كما هي. */
  /* ---------- B. صرف للعملاء (إذن بمجموعات + ترقيم مستقل) ---------- */
  function bakerIssueForm(host, editGroup) {
    const isEdit = !!editGroup;
    const existing = editGroup || null;
    const ar = () => UI.getLang() === 'ar';
    const families = familyOptions();
    const customers = customerOptions();
    const weights = knownWeights();
    let docNoDirty = false;

    /* editing: rebuild groups from the stored rows (product/gsm/weight);
       identical sizes inside one voucher are combined by summing quantities */
    let initialGroups;
    let initialCls = 'ض';
    if (existing) {
      initialCls = existing.settlement === 'غ' ? 'غ' : 'ض';
      const sub = new Map();
      for (const r of existing.rows) {
        const key = global.CALC.comboGroupWOf(r); /* group = (product, gsm, weight), sizes inside */
        if (!sub.has(key)) sub.set(key, { quality: productFamily(r.quality), gsm: r.gsm, weight: r.weight, sizes: [], sizeMap: new Map() });
        const g = sub.get(key);
        const sk = String(r.size);
        const qty = Number(r.outQty) || 0;
        const cur = g.sizeMap.get(sk);
        if (cur) cur.qty = global.CALC.round6(cur.qty + qty);
        else { const line = { size: r.size, qty }; g.sizeMap.set(sk, line); g.sizes.push(line); }
      }
      initialGroups = [...sub.values()];
      initialGroups.forEach((g) => { delete g.sizeMap; g.sizes.sort((a, b) => (Number(a.size) || 0) - (Number(b.size) || 0)); });
    } else {
      initialGroups = null;
    }

    host.innerHTML = `
      <div class="page-head"><h2>${isEdit
        ? (ar() ? `تعديل إذن صرف ${existing ? existing.permitNo || '' : ''}` : 'Edit issue document')
        : `${t('bakerIssue')} — ${t('baker')}`}</h2>
        <div class="head-actions"><button class="btn btn-ghost" id="bi-back">← ${t('issuedocs')}</button></div></div>
      <div class="card form-card">
        <p class="muted small form-sub">${ar()
          ? 'أذون الصرف لها تسلسلان مستقلان: «ضريبي» و«غير ضريبي» — يُقترح الرقم التالي تلقائيًا ويمكن تعديله، ويُمنع تكرار الرقم داخل نفس التصنيف. كل مجموعة تحمل جرامها ووزن بكرتها ومقاساتها.'
          : 'Issue documents have two independent sequences: tax and non-tax. The next number is suggested automatically and stays editable; duplicates within one classification are rejected. Each group carries its own GSM, roll weight and sizes.'}</p>
        <form id="bi-form" novalidate>
          <div class="form-grid">
            <label class="field"><span>${t('date')} *</span>
              <input type="date" id="bi-date" required value="${esc(existing ? existing.date : todayISO())}"></label>
            <label class="field"><span>${t('customer')} *</span>
              <input type="text" id="bi-customer" list="bi-cust-list" required placeholder="${ar() ? 'اسم العميل' : 'customer name'}"
                value="${esc(existing ? (App.canonicalCustomer(existing.customer) || '') : '')}">
              <datalist id="bi-cust-list">${customers.map((c) => `<option value="${esc(c)}"></option>`).join('')}</datalist></label>
            <div class="field"><span>${t('classification')} *</span>
              <div class="seg-control" id="bi-cls">
                <button type="button" data-cls="ض" class="${initialCls === 'ض' ? 'active' : ''}">${t('tax')}</button>
                <button type="button" data-cls="غ" class="${initialCls === 'غ' ? 'active' : ''}">${t('nontax')}</button>
              </div></div>
            <label class="field"><span>${t('docNo')} *</span>
              <input type="text" id="bi-docno" required autocomplete="off">
              <span class="muted small" id="bi-docno-hint">${ar() ? 'يُقترح تلقائيًا — يمكن تعديله' : 'suggested automatically — editable'}</span></label>
            <label class="field field-wide"><span>${t('notes')}</span>
              <input type="text" id="bi-notes" value="${esc(existing ? existing.notes : '')}"></label>
          </div>
          <section class="field field-wide" id="bi-groups-section">
            <div class="card-head-row"><strong>${ar() ? 'مجموعات الصرف (كل مجموعة بجرام ووزن مختلف)' : 'Issue groups (each with its own GSM & weight)'}</strong>
              <button type="button" class="btn btn-ghost" id="bi-add-group">+ ${t('addGroup')}</button></div>
            <div id="bi-groups"></div>
          </section>
          <div class="form-hint" id="bi-hint"></div>
          <div class="form-error" id="bi-error" role="alert"></div>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary">${t('save')}</button>
            <button type="button" class="btn btn-ghost" id="bi-cancel">${t('cancel')}</button>
          </div>
        </form>
      </div>`;

    const form = host.querySelector('#bi-form');
    const groupsHost = host.querySelector('#bi-groups');
    const docNoIn = host.querySelector('#bi-docno');
    let classification = initialCls;
    host.querySelector('#bi-back').addEventListener('click', () => navigate('issuedocs'));

    const suggestDocNo = async () => {
      const n = await global.TX.nextDocNumbers();
      docNoIn.value = String(classification === 'ض' ? n.tax : n.nontax);
      docNoDirty = false;
    };
    host.querySelectorAll('#bi-cls button').forEach((b) => b.addEventListener('click', () => {
      classification = b.dataset.cls;
      host.querySelectorAll('#bi-cls button').forEach((x) => x.classList.toggle('active', x === b));
      suggestDocNo(); /* selection always displays the next number of that sequence */
    }));
    docNoIn.addEventListener('input', () => { docNoDirty = true; });
    if (isEdit) docNoIn.value = existing.permitNo || '';
    else suggestDocNo();

    /* ---------- groups ---------- */
    const groupDefs = initialGroups || [];
    const makeGroupEl = (def) => {
      const def0 = def || { quality: families[0] || '', gsm: '', weight: '', sizes: [] };
      const g = el(`<div class="issue-group">
        <div class="issue-group-head">
          <strong class="g-index"></strong>
          <button type="button" class="btn btn-ghost g-remove">✕ ${ar() ? 'حذف المجموعة' : 'Remove group'}</button>
        </div>
        <div class="form-grid">
          <label class="field"><span>${t('quality')} *</span>
            <select class="g-quality">${families.map((f) => `<option value="${esc(f)}" ${def0.quality === f ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select></label>
          <label class="field"><span>${t('gsm')} *</span>
            <input class="g-gsm" type="number" min="1" step="any" list="bi-gsm-list" placeholder="125" value="${esc(def0.gsm == null ? '' : def0.gsm)}"></label>
          <label class="field"><span>${t('rollWeight')} *</span>
            <input class="g-weight" type="number" min="0.001" step="0.001" list="bi-w-list" placeholder="500" value="${esc(def0.weight == null ? '' : def0.weight)}"></label>
        </div>
        <div class="sz-head" aria-hidden="true">
          <span>${t('size')} (${ar() ? 'سم' : 'cm'})</span>
          <span>${ar() ? 'عدد البكر' : 'Bale count'}</span>
          <span></span>
        </div>
        <div class="g-sizes"></div>
        <div class="issue-group-foot">
          <button type="button" class="btn btn-ghost g-add-size">+ ${t('addSizeRow')}</button>
          <span class="g-total muted small"></span>
        </div>
      </div>`);
      const sizesHost = g.querySelector('.g-sizes');
      const addSize = (sizeValue = '', qtyValue = '') => {
        const row = document.createElement('div');
        row.className = 'sz-row';
        row.innerHTML =
          '<input class="line-size" type="number" min="1" step="any" placeholder="100" aria-label="size">' +
          '<input class="line-qty" type="number" min="1" step="1" placeholder="0" aria-label="quantity">' +
          '<button type="button" class="btn btn-ghost remove-size-row" aria-label="remove">×</button>' +
          '<div class="line-balance small"></div>';
        row.querySelector('.line-size').value = sizeValue == null ? '' : sizeValue;
        row.querySelector('.line-qty').value = qtyValue == null ? '' : qtyValue;
        sizesHost.appendChild(row);
        row.querySelector('.remove-size-row').addEventListener('click', () => {
          if (sizesHost.querySelectorAll('.sz-row').length === 1) {
            row.querySelector('.line-size').value = '';
            row.querySelector('.line-qty').value = '';
          } else row.remove();
          refreshAll();
        });
        row.querySelector('.line-size').addEventListener('input', refreshAll);
        row.querySelector('.line-qty').addEventListener('input', refreshAll);
        return row;
      };
      g.querySelector('.g-add-size').addEventListener('click', () => { addSize(); refreshAll(); });
      g.querySelector('.g-remove').addEventListener('click', () => {
        if (groupsHost.querySelectorAll('.issue-group').length === 1) {
          g.querySelectorAll('.line-size, .line-qty').forEach((i) => { i.value = ''; });
        } else g.remove();
        renumber();
        refreshAll();
      });
      g._addSize = addSize;
      (def0.sizes && def0.sizes.length ? def0.sizes : [{}]).forEach((s) => addSize(s.size == null ? '' : s.size, s.qty == null ? '' : s.qty));
      return g;
    };

    const datalistWrap = el(`<div><datalist id="bi-gsm-list">${knownGsms(null).map((x) => `<option value="${esc(x)}"></option>`).join('')}</datalist>
      <datalist id="bi-w-list">${weights.map((w) => `<option value="${esc(w)}"></option>`).join('')}</datalist></div>`);
    host.appendChild(datalistWrap);

    const renumber = () => {
      groupsHost.querySelectorAll('.issue-group .g-index').forEach((elm, i) => {
        elm.textContent = `${ar() ? 'مجموعة' : 'Group'} ${fmtNum(i + 1)}`;
      });
    };
    const addGroup = (def) => {
      const g = makeGroupEl(def);
      groupsHost.appendChild(g);
      renumber();
      return g;
    };
    host.querySelector('#bi-add-group').addEventListener('click', () => {
      const first = groupsHost.querySelector('.issue-group');
      const inherit = first ? {
        quality: first.querySelector('.g-quality').value, gsm: '', weight: '', sizes: [],
      } : null;
      addGroup(inherit);
      refreshAll();
    });

    if (groupDefs.length) groupDefs.forEach((g) => addGroup(g));
    else addGroup(null);

    /* ---------- live totals + per-row balance hints ---------- */
    function refreshAll() {
      let grand = 0;
      groupsHost.querySelectorAll('.issue-group').forEach((g) => {
        const q = g.querySelector('.g-quality').value;
        const gsm = g.querySelector('.g-gsm').value === '' ? null : Number(g.querySelector('.g-gsm').value);
        const w = g.querySelector('.g-weight').value === '' ? null : Number(g.querySelector('.g-weight').value);
        let gtotal = 0;
        g.querySelectorAll('.sz-row').forEach((row) => {
          const size = Number(row.querySelector('.line-size').value);
          const qty = Number(row.querySelector('.line-qty').value) || 0;
          const hint = row.querySelector('.line-balance');
          if (q && gsm && size > 0) {
            const bal = balanceBy(q, gsm, w, size);
            let txt = (ar() ? 'المتاح: ' : 'Available: ') + fmtNum(bal.net);
            if (qty > bal.net) txt += (ar() ? ' — أكبر من المتاح' : ' — exceeds available');
            hint.textContent = txt;
          } else hint.textContent = '';
          if (size > 0) gtotal += qty;
        });
        g.querySelector('.g-total').innerHTML = `${ar() ? 'إجمالي المجموعة' : 'Group total'}: <strong>${fmtNum(global.CALC.round6(gtotal))}</strong> ${t('rolls')}`;
        grand += gtotal;
      });
      const hint = host.querySelector('#bi-hint');
      if (hint) hint.innerHTML = `${t('totalRolls')}: <strong>${fmtNum(global.CALC.round6(grand))}</strong> ${t('rolls')}`;
    }
    groupsHost.addEventListener('input', refreshAll);
    refreshAll();

    host.querySelector('#bi-cancel').addEventListener('click', () => navigate('issuedocs'));

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const errBox = host.querySelector('#bi-error');
      errBox.textContent = '';
      const date = host.querySelector('#bi-date').value;
      const customer = host.querySelector('#bi-customer').value.trim();
      const notes = host.querySelector('#bi-notes').value.trim();
      const docNo = docNoIn.value.trim();

      const groups = [];
      let invalid = false;
      groupsHost.querySelectorAll('.issue-group').forEach((g) => {
        const quality = g.querySelector('.g-quality').value;
        const gsm = g.querySelector('.g-gsm').value === '' ? null : Number(g.querySelector('.g-gsm').value);
        const weight = g.querySelector('.g-weight').value === '' ? null : Number(g.querySelector('.g-weight').value);
        const sizes = [];
        g.querySelectorAll('.sz-row').forEach((row) => {
          const size = Number(row.querySelector('.line-size').value);
          const qty = Number(row.querySelector('.line-qty').value);
          if (Number.isFinite(size) && size > 0) sizes.push({ size, qty });
        });
        if (!quality || !Number.isFinite(gsm) || gsm <= 0 || !Number.isFinite(weight) || weight <= 0 ||
            !sizes.length || sizes.some((s) => !Number.isFinite(s.qty) || s.qty <= 0)) invalid = true;
        groups.push({ quality, gsm, weight, sizes });
      });

      const problems = [];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) problems.push(ar() ? 'التاريخ مطلوب بصيغة صحيحة' : 'Valid date required');
      if (!customer) problems.push(ar() ? 'اسم العميل مطلوب' : 'Customer name required');
      if (!docNo) problems.push(ar() ? 'رقم الإذن مطلوب' : 'Document number required');
      if (!groups.length || invalid) problems.push(ar()
        ? 'أكمل بيانات كل مجموعة: الصنف والجرام ووزن البكرة ومقاس صحيح بكمية أكبر من صفر'
        : 'Complete every group: product, GSM, bale weight and a valid size with a quantity greater than zero');
      /* same (gsm,weight,size) bucket inside two groups = one bucket → combine */
      const seenBucket = new Set();
      for (const g of groups) {
        for (const s of g.sizes) {
          const k = global.CALC.comboKeyW(g.quality, g.gsm, g.weight, s.size);
          if (seenBucket.has(k)) problems.push(ar()
            ? `المقاس ${s.size} (نفس الجرام والوزن) مكرر بين المجموعات — اجمع كميته في مجموعة واحدة`
            : `Size ${s.size} with the same GSM/weight repeats across groups — combine it into one group`);
          seenBucket.add(k);
        }
      }
      if (problems.length) {
        errBox.innerHTML = problems.map((p) => `• ${esc(p)}`).join('<br>');
        return;
      }

      const doc = {
        date, customer, docNo,
        classification,
        notes,
        source: isEdit ? (existing.source || 'manual') : 'manual',
        groups,
      };
      try {
        if (isEdit) {
          const pendingRows = [];
          for (const g of groups) {
            for (const s of g.sizes) {
              pendingRows.push({
                date, quality: g.quality, gsm: g.gsm, size: s.size,
                customer, permitNo: docNo, addQty: 0, outQty: s.qty,
                weight: g.weight, settlement: classification,
                notes, source: doc.source,
              });
            }
          }
          await global.TX.replaceIssueVoucher(existing, pendingRows, classification, docNo);
          toast(ar() ? 'تم تحديث الإذن وتحديث الرصيد تلقائيًا' : 'voucher updated, balances recalculated', 'ok');
        } else {
          await global.TX.saveIssueDocument(doc);
          toast(ar() ? `تم حفظ إذن الصرف ${docNo} (${classification === 'ض' ? t('tax') : t('nontax')}) وتحديث الرصيد`
            : `Document ${docNo} saved and balances updated`, 'ok');
        }
        await refresh();
        navigate('issuedocs');
      } catch (saveError) {
        if (saveError && saveError.type === 'validation') {
          errBox.innerHTML = saveError.errors.map((x) => `• ${esc(x.msg)}`).join('<br>');
        } else {
          errBox.textContent = String(saveError.message || saveError);
          console.error(saveError);
        }
      }
    });
  }

  /* قسم «حركة متابعة البكر» القديم حُوّل إلى «إدارة الرولات والبكر» (#rolls)
     و«تسجيل البكر» (#reels-add) — انظر rolls.js */
  /* =======================================================================
     shared table renderer for movement lists
     ======================================================================= */
  function txTable(host, opts) {
    const lang = UI.getLang() === 'ar';
    let rows = App.state.transactions.slice();
    rows = rows.filter(opts.filter || (() => true));
    const customers = customerOptions();
    const families = CANON_FAMILIES.filter((f) => App.state.products.some((p) => productFamily(p.quality) === f));
    const showFilters = opts.preset === 'out' || opts.preset === null;
    host.innerHTML = `
      <div class="page-head"><h2>${esc(opts.title)}</h2>
        <div class="head-actions">
          ${opts.hideAdd ? '' : `<button class="btn btn-primary" id="btn-add-tx">+ ${esc(opts.addLabel || (lang ? 'حركة جديدة' : 'New movement'))}</button>`}
          <button class="btn btn-ghost" id="btn-exp-tx">${t('exportExcel')}</button>
        </div></div>
      ${showFilters ? `<div class="card filters">
        <input type="date" id="flt-from" title="${t('from')}">
        <input type="date" id="flt-to" title="${t('to')}">
        <input type="text" id="flt-q" list="flt-qlist" placeholder="${t('quality')}">
        <datalist id="flt-qlist">${families.map((q) => `<option value="${esc(q)}"></option>`).join('')}</datalist>
        <input type="text" id="flt-c" list="flt-clist" placeholder="${t('customer')}">
        <datalist id="flt-clist">${customers.map((c) => `<option value="${esc(c)}"></option>`).join('')}</datalist>
        <input type="text" id="flt-text" placeholder="${lang ? 'بحث في إذن الصرف / ملاحظات' : 'search permit/notes'}">
        <select id="flt-settle"><option value="">${t('settlement')}: ${t('all')}</option><option value="غ">غ</option><option value="ض">ض</option></select>
        <button class="btn btn-ghost" id="flt-clear">${t('reset')}</button>
      </div>` : ''}
      <div class="card table-wrap" id="tx-table-host"></div>`;

    const host2 = host.querySelector('#tx-table-host');
    const PAGE_SIZE = 120; /* groups per page — the real file has ~24k rows */
    let curGroups = [], page = 0;

    function applyFilters() {
      let list = rows;
      if (showFilters) {
        const from = host.querySelector('#flt-from').value;
        const to = host.querySelector('#flt-to').value;
        const q = host.querySelector('#flt-q').value.trim();
        const c = host.querySelector('#flt-c').value.trim();
        const text = host.querySelector('#flt-text').value.trim().toLowerCase();
        const st = host.querySelector('#flt-settle').value;
        list = rows.filter((r) =>
          (!from || r.date >= from) && (!to || r.date <= to) &&
          (!q || productFamily(r.quality) === q) &&
          (!c || canonicalCustomer(r.customer) === c) &&
          (!st || r.settlement === st) &&
          (!text || (r.permitNo || '').toLowerCase().includes(text) || (r.notes || '').toLowerCase().includes(text)));
      }
      curGroups = buildGroups(list);
      page = 0;
      renderRows();
    }

    function renderRows() {
      const total = curGroups.length;
      const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      if (page >= pages) page = pages - 1;
      if (page < 0) page = 0;
      const slice = curGroups.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
      const sumAdd = curGroups.reduce((s, g) => s + g.add, 0);
      const sumOut = curGroups.reduce((s, g) => s + g.out, 0);
      const nRows = curGroups.reduce((s, g) => s + g.rows.length, 0);
      host2.innerHTML = `
        <table class="data-table">
          <thead><tr>
            <th>${t('date')}</th><th>${t('quality')}</th><th>${t('gsm')}</th>
            <th>${t('rollWeight')}</th>
            <th>${lang ? 'المقاسات والكميات' : 'Sizes & quantities'}</th>
            <th>${t('customer')}</th><th>${t('permit')}</th>
            <th class="num">${t('addQty')}</th><th class="num">${t('outQty')}</th>
            <th>${t('settlement')}</th><th>${t('actions')}</th>
          </tr></thead>
          <tbody>${slice.length ? slice.map(groupRowHtml).join('') :
            `<tr><td colspan="11" class="empty">${esc(t('emptyState'))}</td></tr>`}</tbody>
          <tfoot><tr>
            <td colspan="7">${t('total')} (${fmtNum(total)} ${lang ? 'حركة' : 'movements'} — ${fmtNum(nRows)} ${lang ? 'سطر' : 'rows'})</td>
            <td class="num">${fmtNum(sumAdd)}</td><td class="num">${fmtNum(sumOut)}</td>
            <td colspan="2"></td>
          </tr></tfoot>
        </table>
        ${pages > 1 ? `<div class="pager">
          <button class="btn btn-ghost" id="pg-first" ${page === 0 ? 'disabled' : ''}>«</button>
          <button class="btn btn-ghost" id="pg-prev" ${page === 0 ? 'disabled' : ''}>‹</button>
          <span>${lang ? 'صفحة' : 'Page'} ${page + 1} / ${fmtNum(pages)}</span>
          <button class="btn btn-ghost" id="pg-next" ${page >= pages - 1 ? 'disabled' : ''}>›</button>
          <button class="btn btn-ghost" id="pg-last" ${page >= pages - 1 ? 'disabled' : ''}>»</button>
        </div>` : ''}`;
      host2.querySelectorAll('[data-act]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const key = btn.dataset.key;
          const act = btn.dataset.act;
          const group = curGroups.find((g) => g.key === key);
          if (!group) return;
          /* the list view may show only one side of a mixed movement —
             edit & delete must always operate on the FULL group */
          const full = group.groupId
            ? App.buildGroups(App.state.transactions.filter((r) => r.groupId === group.groupId))[0]
            : group;
          if (act === 'edit') {
            /* حركات إنتاج مصدرها تسجيل البكر: التعديل من تفاصيل الرول فقط */
            if (full.rows[0] && full.rows[0].source === 'reels') {
              toast(lang ? 'حركة إنتاج من تسجيل البكر — التعديل من «إدارة الرولات والبكر» عبر تفاصيل الرول' : 'Reel-sourced production — edit from roll details', 'info');
              if (App.openRollDetails) App.openRollDetails(full.rows[0].rollNo);
              return;
            }
            /* أذون التطبيق (P:groupId): التعديل من نموذج الإذن */
            if (full.groupId && String(full.groupId).startsWith(global.TX.PERMIT_GROUP_PREFIX)) {
              const pid = String(full.groupId).slice(global.TX.PERMIT_GROUP_PREFIX.length);
              const v = App.collectVouchers(App.state.transactions, App.state.permits)
                .find((x) => x.permitId === pid);
              if (v) { App.pendingEdit = v; navigate('baker-issue'); return; }
            }
            if (!full.groupId) { App.openLegacyEditModal(full.rows[0]); return; }
            const hasAdd = full.add > 0, hasOut = full.out > 0;
            if (hasAdd && hasOut) { App.pendingEdit = { type: 'mixed', group: full }; navigate('addtx'); }
            else if (hasOut) { App.pendingEdit = { type: 'issue', group: full }; navigate('baker-issue'); }
            else { toast(lang ? 'حركة الإنتاج تُعد من «إدارة الرولات والبكر»' : 'Production movements are edited from Rolls & reels', 'info'); }
          } else if (act === 'del') {
            const ok = await confirmDialog({
              title: lang ? 'حذف حركة' : 'Delete movement',
              message: lang
                ? (full.rows.length > 1
                  ? `سيتم حذف الحركة بكل مقاساتها (${full.rows.length} سطر) نهائيًا وتحديث الرصيد تلقائيًا.\nالصنف: ${full.quality} — الجرام: ${full.gsm}\nالمقاسات: ${full.sizesLabel}`
                  : `سيتم حذف الحركة نهائيًا وتحديث الرصيد تلقائيًا.\nالصنف: ${full.quality} — الجرام: ${full.gsm} — المقاس: ${full.rows[0].size} — الكمية: ${full.add || full.out}`)
                : `Delete this movement permanently and recalculate balances?\n${full.quality} / ${full.gsm} — ${full.sizesLabel}`,
              danger: true, extra: lang ? `<code>${esc(full.date)} — ${esc(canonicalCustomer(full.customer) || '')}</code>` : '',
            });
            if (full.rows[0] && full.rows[0].source === 'reels') {
              toast(lang ? 'حركة إنتاج من تسجيل البكر — الحذف من تفاصيل الرول في «إدارة الرولات والبكر»' : 'Delete reel-sourced production from roll details', 'err');
              return;
            }
            if (ok) {
              await global.TX.deleteMovement(full);
              toast(lang ? 'تم الحذف وتحديث الرصيد' : 'deleted, balances updated', 'ok');
              await refresh();
            }
          }
        });
      });
      const bind = (id, fn) => { const b = host2.querySelector(id); if (b) b.addEventListener('click', () => { fn(); renderRows(); }); };
      bind('#pg-first', () => { page = 0; });
      bind('#pg-prev', () => { page--; });
      bind('#pg-next', () => { page++; });
      bind('#pg-last', () => { page = Math.ceil(curGroups.length / PAGE_SIZE) - 1; });
    }

    function groupWeightLabel(g) {
      const ws = [...new Set(g.rows.map((r) => (r.weight == null || r.weight === '') ? null : Number(r.weight)))];
      if (ws.length === 1 && ws[0] != null) return fmtNum(ws[0]);
      return '—';
    }

    function groupRowHtml(g) {
      const voidBadge = g.void ? `<span class="badge badge-void">${lang ? 'ملغاة' : 'void'}</span>` : '';
      const first = g.rows[0];
      const incomplete = !global.CALC.isComboComplete(first.quality, first.gsm, first.size) && !g.void
        ? `<span class="badge badge-warn" title="${lang ? 'ببيانات ناقصة — لا تدخل في حساب الرصيد' : 'incomplete — excluded from balances'}">⚠</span>` : '';
      const multi = g.rows.length > 1 ? `<span class="badge badge-multi">${g.rows.length} ${lang ? 'مقاس' : 'sizes'}</span>` : '';
      return `<tr class="${g.add > 0 ? 'row-add' : 'row-out'}">
        <td data-label="${t('date')}">${fmtDate(g.date)}</td>
        <td data-label="${t('quality')}">${esc(productFamily(g.quality))} ${voidBadge}${incomplete}</td>
        <td data-label="${t('gsm')}">${g.gsm == null ? '—' : fmtNum(g.gsm)}</td>
        <td data-label="${t('rollWeight')}">${groupWeightLabel(g)}</td>
        <td data-label="${lang ? 'المقاسات والكميات' : 'Sizes'}"><span class="sizes-label">${esc(g.sizesLabel)}</span> ${multi}</td>
        <td data-label="${t('customer')}">${esc(canonicalCustomer(g.customer) || '')}</td>
        <td data-label="${t('permit')}">${esc(g.permitNo || '')}</td>
        <td class="num pos" data-label="${t('addQty')}">${g.add ? fmtNum(g.add) : ''}</td>
        <td class="num neg" data-label="${t('outQty')}">${g.out ? fmtNum(g.out) : ''}</td>
        <td data-label="${t('settlement')}">${esc(g.settlement || '')}</td>
        <td class="actions-cell">
          <button class="icon-btn" data-act="edit" data-key="${esc(g.key)}" title="${t('edit')}">✎</button>
          <button class="icon-btn danger" data-act="del" data-key="${esc(g.key)}" title="${t('del')}">🗑</button>
        </td></tr>`;
    }

    if (showFilters) {
      host.querySelector('#flt-from').addEventListener('change', applyFilters);
      host.querySelector('#flt-to').addEventListener('change', applyFilters);
      host.querySelector('#flt-q').addEventListener('input', applyFilters);
      host.querySelector('#flt-c').addEventListener('input', applyFilters);
      host.querySelector('#flt-text').addEventListener('input', applyFilters);
      host.querySelector('#flt-settle').addEventListener('change', applyFilters);
      host.querySelector('#flt-clear').addEventListener('click', () => {
        ['#flt-from', '#flt-to', '#flt-q', '#flt-c', '#flt-text', '#flt-settle'].forEach((s) => { host.querySelector(s).value = ''; });
        applyFilters();
      });
    }
    const addBtn = host.querySelector('#btn-add-tx');
    if (addBtn) addBtn.addEventListener('click', () => {
      App.pendingEdit = null;
      const target = opts.addTarget || (opts.preset === 'out' ? 'baker-issue' : 'baker-add');
      navigate(target);
    });
    host.querySelector('#btn-exp-tx').addEventListener('click', () => {
      global.EXCEL.exportTransactions(rows);
      toast(lang ? 'تم تنزيل ملف الإكسل' : 'Excel downloaded', 'ok');
    });
    applyFilters();
  }
  App.txTable = txTable;

  /* legacy single-row editor (rows imported from Excel without a groupId);
     shared by txTable and أذون الصرف */
  function openLegacyEditModal(txRow) {
    const lang = UI.getLang() === 'ar';
    const node = el(`<div class="edit-tx-form">
      <div class="form-grid">
        <label class="field"><span>${t('date')}</span><input id="e-date" type="date" value="${esc(txRow.date)}"></label>
        <label class="field"><span>${t('quality')}</span><input id="e-quality" type="text" value="${esc(txRow.quality)}"></label>
        <label class="field"><span>${t('gsm')}</span><input id="e-gsm" type="number" step="any" value="${esc(txRow.gsm == null ? '' : txRow.gsm)}"></label>
        <label class="field"><span>${t('size')}</span><input id="e-size" type="number" step="any" value="${esc(txRow.size == null ? '' : txRow.size)}"></label>
        <label class="field"><span>${t('customer')}</span><input id="e-customer" type="text" value="${esc(txRow.customer || '')}"></label>
        <label class="field"><span>${t('permit')}</span><input id="e-permit" type="text" value="${esc(txRow.permitNo || '')}"></label>
        <label class="field"><span>${t('addQty')}</span><input id="e-add" type="number" min="0" step="1" value="${txRow.addQty || ''}"></label>
        <label class="field"><span>${t('outQty')}</span><input id="e-out" type="number" min="0" step="1" value="${txRow.outQty || ''}"></label>
        <label class="field"><span>${t('rollWeight')}</span><input id="e-weight" type="number" step="0.001" value="${esc(txRow.weight == null ? '' : txRow.weight)}"></label>
        <label class="field"><span>${t('settlement')}</span>
          <select id="e-settlement"><option value="">—</option>
            <option value="غ" ${txRow.settlement === 'غ' ? 'selected' : ''}>غ</option>
            <option value="ض" ${txRow.settlement === 'ض' ? 'selected' : ''}>ض</option></select></label>
        <label class="field field-wide"><span>${t('notes')}</span><input id="e-notes" type="text" value="${esc(txRow.notes || '')}"></label>
      </div>
      <div class="form-error" id="e-error"></div>
      <div class="confirm-actions">
        <button class="btn btn-primary" id="e-save">${t('save')}</button>
        <button class="btn btn-ghost" id="e-cancel">${t('cancel')}</button>
      </div></div>`);
    openModal(node, { title: lang ? 'تعديل حركة (التعديل مسجل في سجل التدقيق)' : 'Edit transaction (audited)', wide: true });
    node.querySelector('#e-cancel').addEventListener('click', closeModal);
    node.querySelector('#e-save').addEventListener('click', async () => {
      try {
        await global.TX.updateTransaction(txRow.id, {
          date: node.querySelector('#e-date').value,
          quality: node.querySelector('#e-quality').value,
          gsm: node.querySelector('#e-gsm').value === '' ? null : Number(node.querySelector('#e-gsm').value),
          size: node.querySelector('#e-size').value === '' ? null : Number(node.querySelector('#e-size').value),
          customer: node.querySelector('#e-customer').value,
          permitNo: node.querySelector('#e-permit').value,
          addQty: Number(node.querySelector('#e-add').value) || 0,
          outQty: Number(node.querySelector('#e-out').value) || 0,
          weight: node.querySelector('#e-weight').value === '' ? null : Number(node.querySelector('#e-weight').value),
          settlement: node.querySelector('#e-settlement').value,
          notes: node.querySelector('#e-notes').value,
        });
        closeModal();
        toast(lang ? 'تم التعديل وتحديث الرصيد تلقائيًا' : 'updated, balances recalculated', 'ok');
        await refresh();
      } catch (e2) {
        if (e2 && e2.type === 'validation') node.querySelector('#e-error').innerHTML = e2.errors.map((x) => `• ${esc(x.msg)}`).join('<br>');
        else node.querySelector('#e-error').textContent = String(e2.message || e2);
      }
    });
  }
  App.openLegacyEditModal = openLegacyEditModal;

  /* ---------------- dashboard ---------------- */
  function renderDashboard(host) {
    const lang = UI.getLang() === 'ar';
    const tx = App.state.transactions;
    const g = global.CALC.grandTotals(tx);
    const products = App.state.products;
    /* الإجماليات مطابقة لشاشة الرصيد والتقرير: البكر الموجودة فعليًا
       (net > 0) عبر كل التركيبات من محرك الحساب القائم نفسه — لا أعداد
       سالبة ولا مضاعفة (audit fix V2). */
    let stockTotal = 0, weightTotal = 0;
    for (const b of App.state.balances.values()) {
      if (Number(b.net) > 0) {
        stockTotal += b.net;
        weightTotal += global.CALC.productWeight(b.size, b.net, App.state.settings.weightFactor);
      }
    }
    stockTotal = global.CALC.round6(stockTotal);
    weightTotal = global.CALC.round6(weightTotal);
    const nProduction = buildGroups(tx.filter((r) => (Number(r.addQty) || 0) > 0 && r.source !== 'reels')).length;
    const nReelMovements = tx.filter((r) => r.source === 'reels').length;
    /* أذون التطبيق (مسودات + معتمدة) + الأذون المشتقة من الحركات */
    const vouchers = App.collectVouchers(tx, App.state.permits);
    const nDocs = vouchers.filter((v) => v.status === 'approved').length;
    const nDrafts = vouchers.filter((v) => v.status === 'draft').length;
    const I = global.UI.ICON;
    const cards = [
      { icon: I.balance, num: fmtNum(stockTotal), label: `${t('totalBalance')} (${t('rolls')})`, accent: 'green' },
      { icon: I.products, num: fmtNum(products.length), label: t('totalProducts'), accent: 'teal' },
      { icon: I.countAdd, num: fmtNum(nProduction + nReelMovements), label: lang ? 'حركات الإنتاج (منها البكر المسجلة)' : 'Production movements', accent: 'teal' },
      { icon: I.countOut, num: fmtNum(nDocs + nDrafts), label: `${t('countOut')} (${lang ? 'معتمدة' : 'approved'}${nDrafts ? ` + ${fmtNum(nDrafts)} ${lang ? 'مسودة' : 'drafts'}` : ''})`, accent: 'amber' },
      { icon: I.add, num: fmtNum(g.add), label: lang ? 'إجمالي الإضافات للإنتاج' : 'Total production additions', accent: 'green' },
      { icon: I.out, num: fmtNum(g.out), label: lang ? 'إجمالي الصرف للعملاء' : 'Total customer withdrawals', accent: 'amber' },
    ];
    /* إحصاءات الرولات والبكر (متتبعة فقط) */
    global.DB.getAll('reels').then((reels) => {
      const box = host.querySelector('#dash-reels-line');
      if (!box) return;
      const avail = reels.filter((r) => r.status === 'available');
      const disp = reels.filter((r) => r.status === 'dispatched');
      const undef = reels.filter((r) => r.status === 'undefined');
      const wAvail = avail.reduce((s, r) => s + (Number(r.weight) || 0), 0);
      box.innerHTML = lang
        ? `البكر المتتبعة: <strong>${fmtNum(reels.length)}</strong> — متاحة: <strong>${fmtNum(avail.length)}</strong> بوزن فعلي <strong>${fmtNum(wAvail, 3)}</strong> كجم — مصروفة: <strong>${fmtNum(disp.length)}</strong> — غير محددة (مستوردة تاريخية): <strong>${fmtNum(undef.length)}</strong>`
        : `Tracked reels: ${reels.length} — available: ${avail.length} (${wAvail.toFixed(3)} kg) — dispatched: ${disp.length} — undefined (imported): ${undef.length}`;
    }).catch(() => {});

    /* inventory by product (2 canonical families + totals) */
    const famRows = CANON_FAMILIES.map((family) => {
      let net = 0, buckets = 0;
      for (const p of products) {
        if (productFamily(p.quality) !== family) continue;
        const b = App.state.balances.get(p.combo);
        net += b ? b.net : 0;
        buckets++;
      }
      return { family, net: global.CALC.round6(net), buckets };
    }).filter((r) => r.buckets > 0);

    /* low-stock / negative buckets (roll-weight dimension) */
    const low = [];
    for (const row of App.state.balancesW.values()) {
      if (row.net <= 0 && (row.add > 0 || row.out > 0)) low.push(row);
    }
    low.sort((a, b) => a.net - b.net);

    host.innerHTML = `
      <div class="page-head"><h2>${lang ? 'لوحة التحكم' : 'Dashboard'}</h2>
        <div class="head-actions">
          ${tx.length === 0 ? `<button class="btn btn-primary" id="btn-import-dash">${t('importExcel')}</button>` : ''}
          <button class="btn btn-primary" id="btn-new-dash">+ ${lang ? 'تسجيل بكر' : 'Register reels'}</button>
        </div></div>
      <div class="card weight-line" id="dash-reels-line"></div>
      <div class="stats-grid">
        ${cards.map((c) => `<div class="stat-card accent-${c.accent}">
          <div class="stat-icon">${c.icon}</div>
          <div class="stat-num">${c.num}</div>
          <div class="stat-label">${esc(c.label)}</div>
        </div>`).join('')}
      </div>
      <div class="card weight-line">${lang ? 'إجمالي وزن الرصيد التقديري' : 'Estimated stock weight'}: <strong>${fmtNum(weightTotal, 2)}</strong> ${t('kg')} <span class="muted">(${lang ? 'المقاس × الرصيد ×' : 'size × balance ×'} ${App.state.settings.weightFactor})</span></div>
      ${low.length ? `<div class="card notice-card low-stock-card">
        <strong>${t('lowStock')}: ${fmtNum(low.length)}</strong>
        <div class="small muted">${low.slice(0, 5).map((r) =>
          `${esc(productFamily(r.quality))} ${r.gsm == null ? '—' : fmtNum(r.gsm)}g / وزن ${r.weight == null ? '—' : fmtNum(r.weight)} / ${r.size == null ? '—' : fmtNum(r.size)} → ${fmtNum(r.net)}`).join(' · ')}${low.length > 5 ? ' …' : ''}</div>
      </div>` : ''}
      <div class="dash-grid">
        <div class="card chart-card"><h3>${t('monthlyMovement')}</h3><div class="chart-box"><canvas id="chart-monthly"></canvas></div></div>
        <div class="card chart-card"><h3>${t('topProducts')}</h3><div class="chart-box"><canvas id="chart-top"></canvas></div></div>
      </div>
      <div class="grid-2">
        <div class="card">
          <div class="card-head-row"><h3>${t('byProduct')}</h3>
            <button class="link-btn" data-nav="inventory">${t('viewAll')}</button></div>
          <table class="data-table">
            <thead><tr><th>${t('quality')}</th><th class="num">${lang ? 'عدد الأصناف' : 'Items'}</th><th class="num">${t('balance')} (${t('rolls')})</th></tr></thead>
            <tbody>${famRows.length ? famRows.map((r) => `<tr><td>${esc(r.family)}</td><td class="num">${fmtNum(r.buckets)}</td><td class="num"><strong>${fmtNum(r.net)}</strong></td></tr>`).join('')
              : `<tr><td colspan="3" class="empty">${esc(t('emptyState'))}</td></tr>`}</tbody>
          </table>
        </div>
        <div class="card">
          <div class="card-head-row"><h3>${t('recentTx')}</h3>
            <button class="link-btn" data-nav="history">${t('viewAll')}</button></div>
          <div class="table-wrap"><table class="data-table">
            <thead><tr><th>${t('date')}</th><th>${t('quality')}</th><th>${t('gsm')}</th><th>${t('size')}</th><th>${t('customer')}</th><th class="num">${t('addQty')}</th><th class="num">${t('outQty')}</th></tr></thead>
            <tbody>${recentRows(tx)}</tbody>
          </table></div>
        </div>
      </div>`;

    function recentRows(list) {
      const sorted = list.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.id || 0) - (a.id || 0))).slice(0, 8);
      if (!sorted.length) return `<tr><td colspan="7" class="empty">${esc(t('emptyState'))}</td></tr>`;
      return sorted.map((r) => `<tr>
        <td>${fmtDate(r.date)}</td><td>${esc(productFamily(r.quality))}</td>
        <td>${r.gsm == null ? '—' : fmtNum(r.gsm)}</td><td>${r.size == null ? '—' : fmtNum(r.size)}</td>
        <td>${esc(canonicalCustomer(r.customer) || '')}</td>
        <td class="num pos">${r.addQty ? fmtNum(r.addQty) : ''}</td>
        <td class="num neg">${r.outQty ? fmtNum(r.outQty) : ''}</td></tr>`).join('');
    }

    host.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', () => navigate(b.dataset.nav)));
    const imp = host.querySelector('#btn-import-dash');
    if (imp) imp.addEventListener('click', () => global.BACKUP.openImportDialog());
    host.querySelector('#btn-new-dash').addEventListener('click', () => {
      App.pendingEdit = null;
      navigate('reels-add');
    });

    drawCharts(host);
  }

  /* charts are (re)created on every render → destroy previous instances to
     avoid leaking canvas contexts and animation frames */
  const _charts = { monthly: null, top: null };
  function drawCharts(host) {
    if (!global.Chart) return;
    const dark = document.documentElement.dataset.theme === 'dark';
    const tick = dark ? '#9fb3c8' : '#64748B';
    const months = {};
    for (const r of App.state.transactions) {
      if (!r.date) continue;
      const m = r.date.slice(0, 7);
      months[m] = months[m] || { a: 0, o: 0 };
      months[m].a += Number(r.addQty) || 0;
      months[m].o += Number(r.outQty) || 0;
    }
    const keys = Object.keys(months).sort().slice(-12);
    const monthlyCanvas = host.querySelector('#chart-monthly');
    if (monthlyCanvas && keys.length) {
      if (_charts.monthly) { _charts.monthly.destroy(); _charts.monthly = null; }
      _charts.monthly = new global.Chart(monthlyCanvas.getContext('2d'), {
        type: 'bar',
        data: {
          labels: keys.map((k) => k.slice(0, 4) + '/' + k.slice(5, 7)),
          datasets: [
            { label: t('add'), data: keys.map((k) => months[k].a), backgroundColor: '#14B8A6', borderRadius: 5, maxBarThickness: 26 },
            { label: t('out'), data: keys.map((k) => months[k].o), backgroundColor: '#D97706', borderRadius: 5, maxBarThickness: 26 },
          ],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { labels: { color: tick, boxWidth: 10, font: { size: 11 } } } },
          scales: {
            x: { ticks: { color: tick, font: { size: 10 } }, grid: { display: false } },
            y: { ticks: { color: tick, font: { size: 10 } }, grid: { color: 'rgba(100,116,139,.12)' } },
          },
        },
      });
    }
    const arr = [];
    for (const row of App.state.balancesW.values()) {
      if (row.net > 0) arr.push({
        label: `${productFamily(row.quality)} ${row.gsm}g — ${row.weight != null ? row.weight + 'kg — ' : ''}${row.size}`,
        net: row.net,
      });
    }
    arr.sort((a, b) => b.net - a.net);
    const top = arr.slice(0, 10);
    const topCanvas = host.querySelector('#chart-top');
    if (topCanvas && top.length) {
      if (_charts.top) { _charts.top.destroy(); _charts.top = null; }
      _charts.top = new global.Chart(topCanvas.getContext('2d'), {
        type: 'bar',
        data: {
          labels: top.map((x) => x.label),
          datasets: [{ label: t('balance'), data: top.map((x) => x.net), backgroundColor: '#134E4A', borderRadius: 5, maxBarThickness: 16 }],
        },
        options: {
          indexAxis: 'y', responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { ticks: { color: tick, font: { size: 10 } }, grid: { color: 'rgba(100,116,139,.12)' } },
            y: { ticks: { color: tick, font: { size: 10 } }, grid: { display: false } },
          },
        },
      });
    }
  }

  /* ---------------- view registrations ---------------- */
  App.registerView('dashboard', renderDashboard);
  /* سجل الإنتاج — للعرض والمراجعة فقط (الإنتاج يُسجل من تسجيل البكر تلقائيًا) */
  App.registerView('production', (host) => txTable(host, {
    title: global.UI.getLang() === 'ar' ? 'سجل الإنتاج (عرض ومراجعة — الإنتاج يُسجل من تسجيل البكر)' : 'Production log (view only)',
    filter: (r) => (Number(r.addQty) || 0) > 0, preset: 'add', hideAdd: true,
  }));
  /* سجل حركات الصرف */
  App.registerView('outlog', (host) => txTable(host, {
    title: global.UI.getLang() === 'ar' ? 'سجل حركات الصرف' : 'Withdrawal movements log',
    filter: (r) => (Number(r.outQty) || 0) > 0, preset: 'out', hideAdd: true,
  }));
  App.registerView('baker-issue', (host) => {
    const pending = App.pendingEdit; App.pendingEdit = null;
    const edit = pending && pending.group ? pending.group : (pending || null);
    bakerIssueForm(host, edit);
  });
  App.registerView('addtx', (host) => {
    const pending = App.pendingEdit; App.pendingEdit = null;
    const preset = pending ? null : (App.pendingPreset == null ? 'add' : App.pendingPreset);
    App.pendingPreset = null;
    const edit = pending && pending.group ? pending.group : (pending || null);
    txForm(host, edit, preset);
  });
  App.registerView('history', (host) => txTable(host, {
    title: global.UI.getLang() === 'ar' ? 'سجل الحركات الكامل' : 'Full transaction history',
    filter: () => true, preset: null, hideAdd: true,
  }));

  /* ---------------- العملاء ---------------- */
  function renderCustomers(host) {
    const ar2 = () => UI.getLang() === 'ar';
    host.innerHTML = `
      <div class="page-head"><h2>${ar2() ? 'العملاء' : 'Customers'}</h2>
        <div class="head-actions"><button class="btn btn-primary" id="cu-add">+ ${ar2() ? 'عميل جديد' : 'New customer'}</button></div></div>
      <div class="card filters"><input type="text" id="cu-search" placeholder="${ar2() ? 'بحث باسم العميل…' : 'Search…'}"></div>
      <div class="card table-wrap"><table class="data-table">
        <thead><tr><th>${ar2() ? 'اسم العميل' : 'Customer'}</th>
          <th class="num">${ar2() ? 'عدد الأذون' : 'Permits'}</th>
          <th class="num">${ar2() ? 'إجمالي الصرف (بكر)' : 'Total issued (bales)'}</th>
          <th>${ar2() ? 'المصدر' : 'Source'}</th><th>${t('actions')}</th></tr></thead>
        <tbody id="cu-rows"></tbody></table></div>`;
    let rows = [];
    async function load() {
      const [saved, permits] = await Promise.all([
        global.DB.getAll('customers'), Promise.resolve(App.state.permits || []),
      ]);
      const stats = new Map(); /* name → {permits, qty} */
      for (const r of App.state.transactions) {
        if ((Number(r.outQty) || 0) <= 0) continue;
        const name = App.canonicalCustomer(r.customer) || '';
        if (!name || name === 'الإنتاج') continue;
        const s = stats.get(name) || { permits: new Set(), qty: 0 };
        if (r.permitNo) s.permits.add((r.settlement || '') + '|' + r.permitNo);
        s.qty += Number(r.outQty) || 0;
        stats.set(name, s);
      }
      for (const p of permits) {
        const s = stats.get(p.customer) || { permits: new Set(), qty: 0 };
        if (p.status === 'approved') {
          s.permits.add((p.cls || '') + '|' + p.permitNo);
          const tot = (p.totals && p.totals.rolls) || 0;
          /* الكميات محسوبة أصلا من حركات الاعتماد — لا نجمع مرتين */
        }
        stats.set(p.customer, s);
      }
      const names = new Set([...stats.keys()]);
      for (const c of saved) names.add(c.name);
      rows = [...names].map((name) => {
        const s = stats.get(name) || { permits: new Set(), qty: 0 };
        const rec = saved.find((c) => c.name === name);
        return { name, permits: s.permits.size, qty: s.qty, rec };
      }).sort((a, b) => a.name.localeCompare(b.name, 'ar'));
      draw();
    }
    function draw() {
      const q = host.querySelector('#cu-search').value.trim().toLowerCase();
      const list = q ? rows.filter((r) => r.name.toLowerCase().includes(q)) : rows;
      host.querySelector('#cu-rows').innerHTML = list.length ? list.map((r) => `<tr>
        <td data-label="${ar2() ? 'العميل' : 'Customer'}">${esc(r.name)}</td>
        <td class="num">${fmtNum(r.permits)}</td>
        <td class="num">${fmtNum(r.qty)}</td>
        <td>${r.rec ? `<span class="badge">${ar2() ? 'محفوظ' : 'saved'}</span>` : `<span class="badge badge-multi">${ar2() ? 'من الحركات' : 'from history'}</span>`}</td>
        <td class="actions-cell">
          ${r.rec ? `<button class="icon-btn" data-edit="${r.rec.id}" title="${t('edit')}">✎</button>
          <button class="icon-btn danger" data-del="${r.rec.id}" title="${t('del')}">🗑</button>` : '<span class="muted small">—</span>'}
        </td></tr>`).join('') : `<tr><td colspan="5" class="empty">${ar2() ? 'لا يوجد عملاء' : 'no customers'}</td></tr>`;
      host.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => editCustomer(Number(b.dataset.edit))));
      host.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
        const rec = (await global.DB.getAll('customers')).find((c) => c.id === Number(b.dataset.del));
        if (!rec) return;
        const used = rows.some((r) => r.name === rec.name && r.permits > 0);
        if (used) { toast(ar2() ? 'لا يمكن حذف عميل له حركات صرف محفوظة' : 'customer has movements', 'err'); return; }
        const ok = await confirmDialog({ title: ar2() ? 'حذف عميل' : 'Delete customer', message: `حذف "${rec.name}"؟`, danger: true });
        if (!ok) return;
        await global.DB.del('customers', rec.id);
        if (global.SYNC && rec.sid) global.SYNC.recordTombstones('customers', [rec.sid]).catch(() => {});
        toast(ar2() ? 'تم الحذف' : 'deleted', 'ok');
        load();
      }));
    }
    function editCustomer(id) {
      const isNew = !id;
      const rec = isNew ? null : null; /* loaded async below */
      global.DB.getAll('customers').then((saved) => {
        const cur = isNew ? null : saved.find((c) => c.id === id);
        const node = el(`<div>
          <label class="field"><span>${ar2() ? 'اسم العميل' : 'Name'} *</span>
            <input id="c-name" type="text" value="${esc(cur ? cur.name : '')}" placeholder="${ar2() ? 'مثال: دهب للكرتون' : ''}"></label>
          <label class="field"><span>${t('notes')}</span>
            <input id="c-notes" type="text" value="${esc(cur ? (cur.notes || '') : '')}"></label>
          <div class="form-error" id="c-err"></div>
          <div class="confirm-actions">
            <button class="btn btn-primary" id="c-save">${t('save')}</button>
            <button class="btn btn-ghost" id="c-cancel">${t('cancel')}</button>
          </div></div>`);
        openModal(node, { title: isNew ? (ar2() ? 'عميل جديد' : 'New customer') : (ar2() ? 'تعديل عميل' : 'Edit customer') });
        node.querySelector('#c-cancel').addEventListener('click', closeModal);
        node.querySelector('#c-save').addEventListener('click', async () => {
          const name = node.querySelector('#c-name').value.trim();
          if (!name) { node.querySelector('#c-err').textContent = ar2() ? 'الاسم مطلوب' : 'name required'; return; }
          const dup = saved.find((c) => c.name === name && (!cur || c.id !== cur.id));
          if (dup) { node.querySelector('#c-err').textContent = ar2() ? 'العميل موجود بالفعل' : 'duplicate customer'; return; }
          if (cur) await global.DB.put('customers', Object.assign({}, cur, { name, notes: node.querySelector('#c-notes').value.trim(), updatedAt: new Date().toISOString() }));
          else await global.DB.add('customers', { name, notes: node.querySelector('#c-notes').value.trim(), source: 'manual', createdAt: new Date().toISOString() });
          closeModal();
          toast(ar2() ? 'تم الحفظ' : 'saved', 'ok');
          load();
        });
      });
    }
    host.querySelector('#cu-add').addEventListener('click', () => editCustomer(null));
    host.querySelector('#cu-search').addEventListener('input', draw);
    load();
  }
  App.registerView('customers', renderCustomers);

  /* ---------------- مهاجرات آمنة (تعمل مرة واحدة، لا تمس شيئًا إلا بمراجعة) ---------------- */
  async function runSafeMigrations() {
    /* 1) تصحيح وحدة الوزن: عمود «الوزن» في انتاج و مبيعات بالأطنان (تم
       التحقق مقابل ملف التفاصيل: إنتاج 2025-01-01 = 51.5 طن = 51,500 كجم).
       السجلات القديمة المستوردة كانت تُخزن كما هي — تحول ×1000 إلى كجم
       مرة واحدة مع تسجيل العملية في سجل التدقيق. القيم الكبيرة (≥100)
       تُترك كما هي احتياطًا لأنها قد تكون كجم بالفعل. لا يمس الرصيد:
       الحساب يعتمد الكميات فقط. */
    const migrated = await global.DB.getSetting('weightUnitMigrated', false);
    if (!migrated) {
      const all = await global.DB.getAll('transactions');
      const targets = all.filter((r) => r.source === 'excel' && r.weight != null
        && Number(r.weight) > 0 && Number(r.weight) < 100 && r.weightUnit !== 'kg');
      if (targets.length) {
        await global.DB.atomic(['transactions', 'audit'], (t) => {
          const st = t.objectStore('transactions');
          targets.forEach((r) => {
            const after = Object.assign({}, r, {
              weight: Math.round(Number(r.weight) * 1000 * 1000) / 1000,
              weightUnit: 'kg',
              weightWasTons: Number(r.weight),
              updatedAt: new Date().toISOString(),
            });
            st.put(after);
          });
          t.objectStore('audit').add({
            entity: 'database', action: 'migrate-weights', entityId: null,
            before: null, after: { converted: targets.length },
            at: new Date().toISOString(),
            details: `تصحيح وحدة الوزن للأطنان → كجم (${targets.length} سطر مستورد) — لا أثر على أرصدة الكميات`,
          });
        });
      }
      await global.DB.setSetting('weightUnitMigrated', true);
    }
    /* 2) تعبئة العملاء من تاريخ الصرف (مرة واحدة، بدون تكرار) */
    const seeded = await global.DB.getSetting('customersSeeded', false);
    if (!seeded) {
      const existing = await global.DB.getAll('customers');
      const have = new Set(existing.map((c) => c.name));
      const names = new Set();
      for (const r of App.state.transactions) {
        if ((Number(r.outQty) || 0) <= 0) continue;
        const name = App.canonicalCustomer(r.customer) || '';
        if (!name || name === 'الإنتاج' || name === 'رصيد اول المدة') continue;
        names.add(name);
      }
      const addList = [...names].filter((n) => !have.has(n)).slice(0, 2000).map((name) => ({
        name, notes: '', source: 'history', createdAt: new Date().toISOString(),
      }));
      if (addList.length) await global.DB.bulkPut('customers', addList);
      await global.DB.setSetting('customersSeeded', true);
    }
  }

  /* ---------------- boot ---------------- */
  function setLoadingStatus(msg) {
    const el2 = document.getElementById('boot-status');
    if (el2) el2.textContent = msg;
  }

  /* إظهار عناصر القائمة حسب الدور (أمين المخزن يرى قسمين فقط) */
  function applyNavPermissions() {
    const role = global.PERM ? global.PERM.state.role : null;
    if (role == null) return;
    document.querySelectorAll('.nav-item[data-route]').forEach((n) => {
      const allowed = global.PERM.routeAllowed(n.dataset.route);
      n.style.display = allowed ? '' : 'none';
    });
    /* أخفِ عناوين المجموعات التي لم يتبقَّ لها أي قسم مسموح */
    document.querySelectorAll('.nav-group-title').forEach((title) => {
      let anyVisible = false;
      let node = title.nextElementSibling;
      while (node && !node.classList.contains('nav-group-title')) {
        if (node.classList.contains('nav-item') && node.style.display !== 'none') { anyVisible = true; break; }
        node = node.nextElementSibling;
      }
      title.style.display = anyVisible ? '' : 'none';
    });
    document.body.classList.toggle('role-warehouse', global.PERM.isWarehouse());
    document.body.classList.toggle('role-admin', global.PERM.isAdmin());
  }

  /* شريط المستخدم: الاسم والدور + حالة المزامنة (شريط علوي) */
  function renderTopbarUser() {
    const box = document.getElementById('topbar-user');
    if (!box) return;
    const P = global.PERM;
    const name = (P && (P.state.fullName || (P.isLocal() ? 'وضع محلي' : P.state.email))) || '';
    const role = P ? P.roleLabel() : '';
    const show = P && (P.isAdmin() || P.isWarehouse());
    box.innerHTML = show ? `
      <div class="user-chip" id="user-chip" role="button" tabindex="0" title="الحساب والصلاحيات">
        <span class="user-avatar">${esc(String(name || 'U').trim().charAt(0) || 'U')}</span>
        <span class="user-meta"><strong>${esc(name || 'المستخدم')}</strong><small>${esc(role)}</small></span>
        <span class="user-caret">▾</span>
      </div>
      <div class="user-menu" id="user-menu" hidden>
        <div class="user-menu-head"><strong>${esc(name || '')}</strong>
          <span class="muted small">${esc(P.state.email || '')}</span>
          <span class="badge badge-tax">${esc(role)}</span></div>
        ${P.isAdmin() ? `<a href="#users" class="user-menu-item" data-menu-route="users">المستخدمون والصلاحيات</a>
        <a href="#audit" class="user-menu-item" data-menu-route="audit">سجل العمليات</a>
        <a href="#sync" class="user-menu-item" data-menu-route="sync">المزامنة والحساب</a>` : ''}
        ${P.isWarehouse() ? `<a href="#sync" class="user-menu-item" data-menu-route="sync">الاتصال والحساب</a>` : ''}
        <button class="user-menu-item danger" id="um-logout">تسجيل الخروج</button>
      </div>` : '';
    const chip = document.getElementById('user-chip');
    const menu = document.getElementById('user-menu');
    if (chip && menu) {
      const toggle = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; };
      chip.addEventListener('click', toggle);
      chip.addEventListener('keydown', (e) => { if (e.key === 'Enter') toggle(e); });
      document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target)) menu.hidden = true; });
      menu.querySelectorAll('[data-menu-route]').forEach((a) => a.addEventListener('click', () => { menu.hidden = true; navigate(a.dataset.menuRoute); }));
      const lo = document.getElementById('um-logout');
      if (lo) lo.addEventListener('click', async () => {
        menu.hidden = true;
        if (global.SYNC) { try { await global.SYNC.run(); } catch (e2) { /* محاولة أخيرة للمزامنة */ } }
        await global.AUTH.signOut();
        location.reload();
      });
    }
  }

  /* شارة حالة المزامنة في الشريط العلوي */
  function renderSyncChip(s) {
    const chip = document.getElementById('sync-chip');
    if (!chip) return;
    const P = global.PERM;
    if (!P || !(P.isAdmin() || P.isWarehouse())) { chip.style.display = 'none'; return; }
    chip.style.display = '';
    const online = s ? s.online : navigator.onLine;
    chip.className = 'sync-chip ' + (!online ? 'sync-off'
      : s && s.state === 'syncing' ? 'sync-busy'
      : s && s.state === 'error' ? 'sync-err' : 'sync-ok');
    chip.textContent = !online ? 'غير متصل — محلي'
      : s && s.state === 'syncing' ? '⟳ مزامنة…'
      : s && s.state === 'error' ? '⚠ فشل المزامنة'
      : s && s.lastSync ? '✓ متماثل ' + new Date(s.lastSync).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
      : '✓ متصل';
    if (P.isWarehouse()) chip.title = 'استقبال الرصيد وأذون اليومين حسب صلاحياتك';
    else chip.title = s && s.message ? s.message : 'حالة المزامنة مع Supabase';
  }

  /* PWA service worker — يُسجَّل مبكرًا وبالتوازي مع بوابة الدخول حتى
     يثبَّت التطبيق للعمل دون إنترنت من أول زيارة (قبل تسجيل الدخول) */
  function registerServiceWorker() {
    if (!('serviceWorker' in navigator) || !(location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) return;
    let reloadingForWorker = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloadingForWorker) return;
      reloadingForWorker = true;
      location.reload();
    });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(async (reg) => {
      console.log('[sw] registered, scope', reg.scope);
      await reg.update().catch(() => {});
      if (reg.waiting) reg.waiting.postMessage('SKIP_WAITING');
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            nw.postMessage('SKIP_WAITING');
          }
        });
      });
    }).catch((e) => console.warn('[sw] registration failed', e));
  }

  async function boot() {
    if (boot._started) return; /* prevent double initialization */
    boot._started = true;

    setLoadingStatus(UI.getLang() === 'ar' ? 'فتح قاعدة البيانات المحلية…' : 'Opening the local database…');
    await global.DB.open(); /* typed errors: blocked / timeout / unavailable */
    registerServiceWorker();

    setLoadingStatus(UI.getLang() === 'ar' ? 'التحقق من الحساب والصلاحيات…' : 'Checking session & permissions…');
    /* بوابة الدخول: شاشة تسجيل الدخول أو استعادة الجلسة المحفوظة —
       لا يُعرض أي بيانات قبل تحديد الدور. مؤقّت التشغيل (15 ثانية)
       يبدأ فقط بعد حلّ البوابة حتى لا يظهر خطأ وهميًا على شاشة الدخول */
    if (global.AUTH) {
      global.AUTH.watchConnection();
      await global.AUTH.ensureSignedIn();
    }

    /* belt & braces: even if data loading somehow never settles, show a way
       out — armed AFTER the login gate so a user reading the login screen
       never sees a false startup error */
    let dataLoaded = false;
    const dataTimer = setTimeout(() => {
      if (!dataLoaded) showBootError(new Error(
        UI.getLang() === 'ar'
          ? 'استغرق تحميل البيانات أكثر من 15 ثانية. أغلق أي تبويبات أخرى للتطبيق ثم أعد المحاولة.'
          : 'Loading data took longer than 15 seconds. Close other app tabs and retry.'
      ));
    }, 15000);

    setLoadingStatus(UI.getLang() === 'ar' ? 'تحميل الأصناف والحركات…' : 'Loading products & movements…');
    document.querySelectorAll('.nav-item').forEach((n) => {
      n.addEventListener('click', (e) => { e.preventDefault(); navigate(n.dataset.route); });
    });
    const burger = document.getElementById('nav-toggle');
    if (burger) burger.addEventListener('click', () => document.body.classList.toggle('nav-open'));
    const backdrop = document.getElementById('nav-backdrop');
    if (backdrop) backdrop.addEventListener('click', closeMobileNav);

    await loadAll();
    applyNavPermissions();
    renderTopbarUser();
    if (global.SYNC) {
      renderSyncChip(global.SYNC.status);
      global.UI.EventBus.on('sync-status', renderSyncChip);
      global.SYNC.startAutoSync();
    }
    document.body.classList.add('loaded');
    navigate((location.hash || '#' + homeRoute()).replace('#', ''));
    dataLoaded = true;
    clearTimeout(dataTimer);
    /* مهاجرات آمنة بعد أول عرض ناجح — لا تحجب التشغيل أبدًا */
    runSafeMigrations().catch((e) => console.warn('[migrations]', e));

    window.addEventListener('hashchange', () => {
      const r = location.hash.replace('#', '');
      if (r && r !== currentRoute) navigate(r);
    });

    /* Service worker مُسجَّل مبكرًا في registerServiceWorker() أعلاه —
       لا تسجيل ثانٍ هنا (كان يؤخر التثبيت حتى بعد تسجيل الدخول) */

    /* offline indicator — distinct from database errors */
    const badge = document.getElementById('net-status');
    const upd = () => { if (badge) { badge.textContent = navigator.onLine ? '' : t('offline'); badge.classList.toggle('show', !navigator.onLine); } };
    window.addEventListener('online', upd); window.addEventListener('offline', upd); upd();
  }

  global.App = App;

  /* global error diagnostics — never silently swallow runtime failures */
  window.addEventListener('unhandledrejection', (e) => {
    console.error('[unhandled rejection]', e.reason);
  });
  window.addEventListener('error', (e) => {
    console.error('[script error]', e.message, e.filename + ':' + e.lineno);
  });

  /* startup screen: visible progress, typed error screen, retry button */
  function showBootError(error) {
    const host = document.getElementById('view');
    if (!host) return;
    const ar = UI.getLang() === 'ar';
    const kind = error && error.kind;
    let title = ar ? 'تعذر تشغيل البرنامج' : 'The app could not start';
    let hint = '';
    if (kind === 'blocked' || /أغلق أي تبويبات/.test(error.message || '')) {
      title = ar ? 'قاعدة البيانات مشغولة' : 'Database is busy';
      hint = ar
        ? 'يبدو أن نسخة أخرى من البرنامج مفتوحة في تبويب آخر. أغلقها ثم أعد المحاولة.'
        : 'Another tab seems to hold the database. Close it and retry.';
    } else if (!navigator.onLine && !location.protocol.startsWith('http')) {
      title = ar ? 'لا يوجد اتصال' : 'You are offline';
      hint = ar ? 'افتح البرنامج مرة واحدة مع اتصال إنترنت حتى يُثبَّت للعمل بدون إنترنت.' : 'Open once online so the app can install for offline use.';
    }
    const message = error && error.message ? error.message : String(error || 'Unknown error');
    console.error('[startup failed]', error);
    host.innerHTML = `
      <div class="boot-error" role="alert">
        <div class="boot-error-ic">⚠️</div>
        <h2>${esc(title)}</h2>
        <p>${ar ? 'حدثت مشكلة أثناء فتح قاعدة البيانات المحلية أو تحميل ملفات البرنامج.' : 'A problem occurred while opening the local database or loading app files.'}</p>
        ${hint ? `<p class="boot-error-hint">${esc(hint)}</p>` : ''}
        <p class="muted small" style="overflow-wrap:anywhere" dir="ltr">${esc(message)}</p>
        <button type="button" class="btn btn-primary" id="boot-retry">${ar ? 'إعادة المحاولة' : 'Try again'}</button>
        <p class="muted small">${ar ? 'بياناتك المحفوظة لم تُحذف — بقاءها مضمون. إن استمرت المشكلة أرسل صورة لهذه الرسالة.' : 'Your saved data was NOT deleted. If this persists, send a screenshot of this message.'}</p>
      </div>`;
    const retry = host.querySelector('#boot-retry');
    if (retry) retry.addEventListener('click', () => location.reload());
  }

  document.addEventListener('DOMContentLoaded', () => {
    /* يبدأ مؤقّت حماية تحميل البيانات داخل boot() بعد بوابة الدخول —
       لا مؤقّت هنا كي لا يظهر خطأ تشغيل وهمي أثناء شاشة تسجيل الدخول */
    boot().then(() => {
      const loading = document.getElementById('boot-loading');
      if (loading) loading.remove();
    }).catch((error) => {
      showBootError(error);
    });
  });
})(window);
