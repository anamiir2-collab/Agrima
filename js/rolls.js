/* =========================================================================
   rolls.js — تسجيل البكر (مصدر الإنتاج الجديد) + إدارة الرولات والبكر
   -------------------------------------------------------------------------
   القواعد المنفذة هنا:
   • رقم الرول يتولد تلقائيًا (أعلى رقم مستخدم + 1) وهو للعرض فقط — لا
     يمكن تعديله يدويًا، ولا يُعاد استخدام رقم محذوف (أرضية rollSeq دائمة)،
     والتعيين الفعلي يجري داخل معاملة الحفظ نفسها لمنع تعارض الحفظ المتزامن.
   • جدول البكر أعمدته بالترتيب: رقم البكرة | المقاس | الوزن | الجرام | الصنف
     — كل البيانات يدخلها المستخدم، وعدد البكرات وإجمالي الوزن يحسبان
     تلقائيًا من الصفوف المكتملة فقط.
   • الحفظ ذري: رول + بكر + حركة إنتاج تلقائية لكل بكرة (بوزنها الفعلي)
     + تحديث الرصيد فورًا. لا يمكن حفظ رول بدون بكر.
   • إدارة الرولات: بحث، تفاصيل، تعديل بكر (ممنوع للمصروفة)، حذف وفق قواعد
     المخزون، طباعة تفاصيل الرول، تصدير Excel، وحالة كل بكرة.
   • البكر المستوردة تاريخيًا (من ملف اجمالي المخزن) حالتها «غير محددة»
     ولا تدخل الرصيد — تظهر هنا للتفاصيل والمراجعة فقط.
   ========================================================================= */
(function (global) {
  'use strict';
  const { t, el, esc, fmtNum, fmtDate, todayISO, toast, confirmDialog, openModal, closeModal } = global.UI;
  const App = global.App;
  const lang = () => global.UI.getLang() === 'ar';
  const ar = lang;
  const familyOf = (n) => App.productFamily(n);
  const STATUS_LABEL = global.TX.REEL_STATUS; /* available/dispatched/undefined */

  const statusBadge = (s) => {
    if (s === 'available') return '<span class="badge badge-st-avail">متاحة</span>';
    if (s === 'dispatched') return '<span class="badge badge-st-disp">مصروفة</span>';
    if (s === 'returned') return '<span class="badge badge-st-returned">مرجعة للمورد</span>';
    return '<span class="badge badge-st-undef">غير محددة</span>';
  };

  /* فتح تفاصيل رول من أي شاشة (سجل الإنتاج/الصرف مثلاً) */
  App.openRollDetails = (rollNo) => {
    if (App.currentRoute() !== 'rolls') App.navigate('rolls');
    setTimeout(() => { if (App._openRollDetailsNow) App._openRollDetailsNow(Number(rollNo)); }, 90);
  };

  /* ================= 1) تسجيل البكر (إضافة رول جديد) ================= */
  function renderReelsAdd(host) {
    const families = ['تست لينر معالج', 'توب لاينر'];
    host.innerHTML = `
      <div class="page-head"><h2>${ar() ? 'تسجيل البكر — إضافة رول جديد' : 'Register reels — new roll'}</h2>
        <div class="head-actions"><button class="btn btn-ghost" id="ra-back">← ${ar() ? 'إدارة الرولات' : 'Rolls'}</button></div></div>
      <div class="card form-card">
        <p class="muted small form-sub">${ar()
          ? 'تسجيل البكر هو مصدر الإنتاج الجديد: عند الحفظ تُنشأ حركة إنتاج تلقائية لكل بكرة وتضاف إلى الرصيد مباشرة — لا حاجة لأي شاشة إنتاج أخرى. رقم الرول تلقائي وغير قابل للتعديل.'
          : 'Reel registration is the only source of new production: saving creates one automatic production movement per reel and updates the balance instantly.'}</p>
        <form id="ra-form" novalidate>
          <div class="form-grid">
            <label class="field"><span>${ar() ? 'رقم الرول (تلقائي)' : 'Roll no. (automatic)'}</span>
              <input type="text" id="ra-rollno" readonly class="readonly-num" dir="ltr">
              <span class="muted small">${ar() ? 'يتولد تلقائيًا ولا يمكن تعديله' : 'auto-generated, immutable'}</span></label>
            <label class="field"><span>${t('date')} *</span>
              <input type="date" id="ra-date" required value="${esc(todayISO())}"></label>
            <label class="field"><span>${t('gsm')} — ${ar() ? 'جرام الرول (يُقترح لكل البكر)' : 'roll GSM (default for reels)'}</span>
              <input type="number" id="ra-gram" min="1" step="any" list="ra-gsm-list" placeholder="125">
              <datalist id="ra-gsm-list">${App.knownGsms(null).map((g) => `<option value="${esc(g)}"></option>`).join('')}</datalist></label>
            <label class="field field-wide"><span>${t('notes')}</span>
              <input type="text" id="ra-notes"></label>
          </div>
          <section class="field field-wide">
            <div class="card-head-row"><strong>${ar() ? 'جدول البكر' : 'Reels table'}</strong>
              <button type="button" class="btn btn-ghost" id="ra-add-row">+ ${ar() ? 'إضافة بكرة' : 'Add reel'}</button></div>
            <div class="reel-grid-head" aria-hidden="true">
              <span>${ar() ? 'رقم البكرة' : 'Reel no.'}</span>
              <span>${t('size')}</span>
              <span>${ar() ? 'الوزن (كجم)' : 'Weight (kg)'}</span>
              <span>${t('gsm')}</span>
              <span>${t('quality')}</span>
              <span></span>
            </div>
            <div id="ra-rows"></div>
            <div class="reel-totals" id="ra-totals"></div>
          </section>
          <div class="form-error" id="ra-error" role="alert"></div>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary">${ar() ? 'حفظ الرول والبكر (إنتاج تلقائي)' : 'Save roll & reels'}</button>
            <button type="button" class="btn btn-ghost" id="ra-cancel">${t('cancel')}</button>
          </div>
        </form>
      </div>`;

    let suggestedNo = null;
    global.TX.nextRollNo().then((n) => {
      suggestedNo = n;
      const inp = host.querySelector('#ra-rollno');
      if (inp && !inp.value) inp.value = String(n);
    });

    host.querySelector('#ra-back').addEventListener('click', () => App.navigate('rolls'));
    const rowsHost = host.querySelector('#ra-rows');
    const gramIn = host.querySelector('#ra-gram');

    const readRows = () => [...rowsHost.querySelectorAll('.reel-row')].map((row) => ({
      reelNo: row.querySelector('.re-no').value,
      size: Number(row.querySelector('.re-size').value),
      weight: Number(row.querySelector('.re-weight').value),
      gram: Number(row.querySelector('.re-gram').value),
      quality: row.querySelector('.re-quality').value,
    })).filter((r) => !(r.reelNo === '' && !r.size && !r.weight && !r.gram && r.quality === ''));

    const updateTotals = () => {
      const rows = readRows().filter((r) => Number(r.size) > 0 || Number(r.weight) > 0);
      const complete = rows.filter((r) => String(r.reelNo).trim() !== '' && r.size > 0 && r.weight > 0 && r.gram > 0 && r.quality);
      const count = complete.length;
      const weight = global.CALC.round6(complete.reduce((s, r) => s + (Number(r.weight) || 0), 0));
      host.querySelector('#ra-totals').innerHTML = `${ar() ? 'عدد البكرات (تلقائي)' : 'Reel count (auto)'}: <strong>${fmtNum(count)}</strong>
        &nbsp;•&nbsp; ${ar() ? 'إجمالي الوزن' : 'Total weight'}: <strong>${fmtNum(weight, 3)}</strong> ${t('kg')}`;
    };

    const addRow = (prefill) => {
      const p = prefill || {};
      const row = document.createElement('div');
      row.className = 'reel-row';
      row.innerHTML = `
        <input class="re-no" type="number" min="1" step="1" placeholder="1" aria-label="reel no">
        <input class="re-size" type="number" min="1" step="any" placeholder="100" aria-label="size">
        <input class="re-weight" type="number" min="0.001" step="0.001" placeholder="7.99" aria-label="weight">
        <input class="re-gram" type="number" min="1" step="any" placeholder="125" aria-label="gsm">
        <select class="re-quality" aria-label="quality">
          <option value="">—</option>
          ${families.map((f) => `<option value="${esc(f)}">${esc(f)}</option>`).join('')}
        </select>
        <button type="button" class="btn btn-ghost re-remove" aria-label="remove">×</button>`;
      row.querySelector('.re-no').value = p.reelNo == null ? '' : p.reelNo;
      row.querySelector('.re-size').value = p.size == null ? '' : p.size;
      row.querySelector('.re-weight').value = p.weight == null ? '' : p.weight;
      row.querySelector('.re-gram').value = p.gram == null ? '' : p.gram;
      if (p.quality) row.querySelector('.re-quality').value = p.quality;
      row.querySelector('.re-remove').addEventListener('click', () => { row.remove(); renumber(); updateTotals(); });
      row.addEventListener('input', updateTotals);
      rowsHost.appendChild(row);
      return row;
    };
    const renumber = () => {
      const rows = [...rowsHost.querySelectorAll('.reel-row')];
      rows.forEach((row, i) => {
        const no = row.querySelector('.re-no');
        if (!no.value || no.value === String(i)) { /* suggest sequential number */ }
      });
    };
    host.querySelector('#ra-add-row').addEventListener('click', () => {
      const rows = readRows();
      const nextNo = rows.length ? Math.max(...rows.map((r) => parseInt(String(r.reelNo), 10) || 0)) + 1 : 1;
      const row = addRow({ reelNo: nextNo, gram: gramIn.value });
      row.querySelector('.re-size').focus();
      updateTotals();
    });
    gramIn.addEventListener('input', () => {
      rowsHost.querySelectorAll('.re-gram').forEach((g) => { if (!g.value) g.value = gramIn.value; });
      updateTotals();
    });
    addRow({ reelNo: 1 });
    updateTotals();
    host.querySelector('#ra-cancel').addEventListener('click', () => App.navigate('rolls'));

    host.querySelector('#ra-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const errBox = host.querySelector('#ra-error');
      errBox.textContent = '';
      const rows = readRows();
      const complete = rows.filter((r) => String(r.reelNo).trim() !== '' && r.size > 0 && r.weight > 0 && r.gram > 0 && r.quality);
      const incomplete = rows.length - complete.length;
      if (!complete.length) {
        errBox.textContent = ar()
          ? 'أضف بكرة واحدة مكتملة على الأقل (رقم بكرة، مقاس، وزن، جرام، صنف) — الصفوف الناقصة لا تُحفظ.'
          : 'Add at least one complete reel row.';
        return;
      }
      const seen = new Set();
      for (const r of complete) {
        if (seen.has(String(r.reelNo))) {
          errBox.textContent = ar() ? `رقم البكرة ${r.reelNo} مكرر داخل الرول.` : `Reel no. ${r.reelNo} duplicated.`;
          return;
        }
        seen.add(String(r.reelNo));
      }
      try {
        const res = await global.TX.saveRollWithReels({
          date: host.querySelector('#ra-date').value,
          gram: Number(gramIn.value) > 0 ? Number(gramIn.value) : null,
          notes: host.querySelector('#ra-notes').value.trim(),
          reels: complete,
        });
        toast(ar()
          ? (suggestedNo && res.rollNo !== suggestedNo
            ? `تم حفظ الرول برقم ${fmtNum(res.rollNo)} (تغيّر الرقم المقترح لحماية التسلسل) — ${fmtNum(res.reels)} بكرة وأُضيفت للرصيد والإنتاج تلقائيًا`
            : `تم حفظ الرول ${fmtNum(res.rollNo)} — ${fmtNum(res.reels)} بكرة وأُضيفت للرصيد والإنتاج تلقائيًا`)
          : `Roll ${res.rollNo} saved — ${res.reels} reels added to stock & production`, 'ok', 5200);
        await App.refresh();
        App.navigate('rolls');
      } catch (e) {
        if (e && e.type === 'validation') errBox.innerHTML = e.errors.map((x) => `• ${esc(x)}`).join('<br>');
        else { errBox.textContent = String(e.message || e); console.error(e); }
      }
    });
  }

  /* ================= 2) إدارة الرولات والبكر ================= */
  function renderRolls(host) {
    host.innerHTML = `
      <div class="page-head"><h2>${ar() ? 'إدارة الرولات والبكر' : 'Rolls & reels management'}</h2>
        <div class="head-actions">
          <button class="btn btn-primary" id="rl-new">+ ${ar() ? 'تسجيل رول جديد' : 'New roll'}</button>
          <button class="btn btn-ghost" id="rl-export">${t('exportExcel')}</button>
        </div></div>
      <div class="card filters">
        <input type="text" id="rl-search" inputmode="numeric" placeholder="${ar() ? 'بحث برقم الرول…' : 'Search roll no.…'}">
        <select id="rl-source">
          <option value="">${ar() ? 'المصدر: الكل' : 'Source: all'}</option>
          <option value="reels">${ar() ? 'تسجيل البكر' : 'App-registered'}</option>
          <option value="excel">${ar() ? 'مستورد (اجمالي المخزن)' : 'Imported'}</option>
        </select>
        <select id="rl-status">
          <option value="">${ar() ? 'حالة البكر: الكل' : 'Reel status: all'}</option>
          <option value="available">${ar() ? 'فيها بكر متاحة' : 'has available'}</option>
          <option value="dispatched">${ar() ? 'فيها بكر مصروفة' : 'has dispatched'}</option>
          <option value="returned">${ar() ? 'فيها بكر مرجعة للمورد' : 'has returned-to-supplier'}</option>
          <option value="undefined">${ar() ? 'غير محددة (مستوردة)' : 'undefined (imported)'}</option>
        </select>
        <button class="btn btn-ghost" id="rl-clear">${t('reset')}</button>
      </div>
      <div class="card table-wrap" id="rl-table"></div>`;

    let rolls = [], reelsByRoll = new Map(), page = 0;
    const PAGE_SIZE = 40;

    async function load() {
      rolls = await global.DB.getAll('rolls');
      const reels = await global.DB.getAll('reels');
      reelsByRoll = new Map();
      for (const r of reels) {
        if (!reelsByRoll.has(r.rollNo)) reelsByRoll.set(r.rollNo, []);
        reelsByRoll.get(r.rollNo).push(r);
      }
      rolls.sort((a, b) => b.rollNo - a.rollNo); /* newest first */
      /* الحماية من سباق التنقل السريع: لو استُبدلت الشاشة أثناء التحميل
         فلا شيء يُرسم (كان يطلق خطأ TypeError عند قراءة حقول اختفت) */
      if (!host.querySelector('#rl-search')) return;
      draw();
    }

    function applyFilters() {
      const q = host.querySelector('#rl-search').value.trim();
      const src = host.querySelector('#rl-source').value;
      const st = host.querySelector('#rl-status').value;
      let list = rolls;
      if (q) list = list.filter((r) => String(r.rollNo).includes(q));
      if (src) list = list.filter((r) => (r.source || '') === src);
      if (st) {
        list = list.filter((r) => {
          const rs = reelsByRoll.get(r.rollNo) || [];
          if (st === 'undefined') return rs.length && rs.every((x) => x.status === 'undefined');
          return rs.some((x) => x.status === st);
        });
      }
      return list;
    }

    function draw() {
      const list = applyFilters();
      const host2 = host.querySelector('#rl-table');
      const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
      if (page >= pages) page = pages - 1;
      if (page < 0) page = 0;
      const slice = list.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
      const totReels = list.reduce((s, r) => s + (reelsByRoll.get(r.rollNo) || []).length, 0);
      const totWeight = list.reduce((s, r) => s + (reelsByRoll.get(r.rollNo) || []).reduce((s2, x) => s2 + (Number(x.weight) || 0), 0), 0);
      host2.innerHTML = `
        <table class="data-table">
          <thead><tr>
            <th>${ar() ? 'رقم الرول' : 'Roll no.'}</th><th>${t('date')}</th><th>${t('gsm')}</th>
            <th class="num">${ar() ? 'عدد البكر' : 'Reels'}</th>
            <th class="num">${ar() ? 'إجمالي الوزن (كجم)' : 'Total weight (kg)'}</th>
            <th>${ar() ? 'الحالات' : 'Statuses'}</th><th>${ar() ? 'المصدر' : 'Source'}</th><th>${t('actions')}</th>
          </tr></thead>
          <tbody>${slice.length ? slice.map(rowHtml).join('') : `<tr><td colspan="8" class="empty">${ar() ? 'لا توجد رولات — سجّل أول رول من «تسجيل البكر»' : 'No rolls yet'}</td></tr>`}</tbody>
          <tfoot><tr>
            <td colspan="3">${t('total')} (${fmtNum(list.length)} ${ar() ? 'رول' : 'rolls'})</td>
            <td class="num">${fmtNum(totReels)}</td>
            <td class="num">${fmtNum(totWeight, 3)}</td>
            <td colspan="3"></td>
          </tr></tfoot>
        </table>
        ${pages > 1 ? `<div class="pager">
          <button class="btn btn-ghost" id="rlp-prev" ${page === 0 ? 'disabled' : ''}>‹</button>
          <span>${t('page')} ${page + 1} / ${fmtNum(pages)}</span>
          <button class="btn btn-ghost" id="rlp-next" ${page >= pages - 1 ? 'disabled' : ''}>›</button>
        </div>` : ''}`;

      host2.querySelectorAll('[data-act]').forEach((btn) => btn.addEventListener('click', async () => {
        const rollNo = Number(btn.dataset.key);
        const act = btn.dataset.act;
        if (act === 'view') openDetails(rollNo);
        else if (act === 'print') openDetails(rollNo, { autoPrint: true });
        else if (act === 'del') {
          const reels = reelsByRoll.get(rollNo) || [];
          const ok = await confirmDialog({
            title: ar() ? 'حذف رول' : 'Delete roll',
            message: ar()
              ? `سيتم حذف الرول ${fmtNum(rollNo)} بكل بكره (${reels.length}) وحركات إنتاجه من التطبيق نهائيًا. الرولات المستوردة تُحذف من التفاصيل فقط. متابعة؟`
              : `Delete roll ${rollNo} with its ${reels.length} reels?`,
            danger: true,
          });
          if (!ok) return;
          try {
            await global.TX.deleteRoll(rollNo);
            toast(ar() ? 'تم حذف الرول وتحديث الرصيد' : 'roll deleted', 'ok');
            await App.refresh();
            load();
          } catch (e) {
            const msg = e && e.errors ? e.errors.join(' — ') : (e.message || e);
            toast(ar() ? `تعذر الحذف: ${msg}` : String(msg), 'err');
          }
        }
      }));
      const prev = host2.querySelector('#rlp-prev'), next = host2.querySelector('#rlp-next');
      if (prev) prev.addEventListener('click', () => { page--; draw(); });
      if (next) next.addEventListener('click', () => { page++; draw(); });
    }

    function rollStatusCounts(rollNo) {
      const rs = reelsByRoll.get(rollNo) || [];
      let a = 0, d = 0, r = 0, u = 0;
      for (const x of rs) {
        if (x.status === 'available') a++;
        else if (x.status === 'dispatched') d++;
        else if (x.status === 'returned') r++;
        else u++;
      }
      return { a, d, r, u, total: rs.length, weight: rs.reduce((s, x) => s + (Number(x.weight) || 0), 0) };
    }

    function rowHtml(r) {
      const c = rollStatusCounts(r.rollNo);
      const src = r.source === 'excel'
        ? `<span class="badge badge-src-excel">${ar() ? 'مستورد' : 'imported'}</span>`
        : `<span class="badge">${ar() ? 'تسجيل بكر' : 'app'}</span>`;
      return `<tr>
        <td data-label="${ar() ? 'رقم الرول' : 'Roll'}"><button class="voucher-no" data-act="view" data-key="${r.rollNo}">${fmtNum(r.rollNo)}</button></td>
        <td data-label="${t('date')}">${fmtDate(r.date)}</td>
        <td data-label="${t('gsm')}">${r.gram == null ? '—' : fmtNum(r.gram)}</td>
        <td class="num" data-label="${ar() ? 'عدد البكر' : 'Reels'}">${fmtNum(c.total)}</td>
        <td class="num" data-label="${ar() ? 'الوزن' : 'Weight'}">${fmtNum(c.weight, 3)}</td>
        <td data-label="${ar() ? 'الحالات' : 'Status'}">${c.a ? `<span class="badge badge-st-avail">${fmtNum(c.a)}</span>` : ''} ${c.d ? `<span class="badge badge-st-disp">${fmtNum(c.d)}</span>` : ''} ${c.u ? `<span class="badge badge-st-undef">${fmtNum(c.u)}</span>` : ''}</td>
        <td data-label="${ar() ? 'المصدر' : 'Source'}">${src}</td>
        <td class="actions-cell">
          <button class="icon-btn" data-act="view" data-key="${r.rollNo}" title="${t('details')}">👁</button>
          <button class="icon-btn" data-act="print" data-key="${r.rollNo}" title="${t('printDoc')}">🖨</button>
          <button class="icon-btn danger" data-act="del" data-key="${r.rollNo}" title="${t('del')}">🗑</button>
        </td></tr>`;
    }

    /* ---------- تفاصيل الرول + تعديل/حذف البكر + طباعة/تصدير ---------- */
    App._openRollDetailsNow = (rollNo, opts) => openDetails(rollNo, opts);
    function openDetails(rollNo, opts) {
      const roll = rolls.find((r) => r.rollNo === rollNo);
      const reels = (reelsByRoll.get(rollNo) || []).slice().sort((a, b) => a.reelNo - b.reelNo);
      if (!roll && !reels.length) { toast(ar() ? 'الرول غير موجود' : 'roll not found', 'err'); return; }
      const c = rollStatusCounts(rollNo);
      const node = el(`<div class="roll-details">
        <div class="details-head">
          <div><h4>${ar() ? 'الرول' : 'Roll'} ${fmtNum(rollNo)}</h4>
          <p class="muted">${t('date')}: <strong>${fmtDate(roll ? roll.date : '')}</strong> — ${t('gsm')}: <strong>${roll && roll.gram != null ? fmtNum(roll.gram) : '—'}</strong> — ${ar() ? 'المصدر' : 'Source'}: <strong>${roll && roll.source === 'excel' ? (ar() ? 'مستورد (تفاصيل فقط)' : 'imported') : (ar() ? 'تسجيل بكر' : 'app')}</strong>${roll && roll.notes ? ' — ' + esc(roll.notes) : ''}</p></div>
          <div class="details-balance">
            <div class="stat-mini"><span>${ar() ? 'عدد البكر' : 'Reels'}</span><strong>${fmtNum(c.total)}</strong></div>
            <div class="stat-mini"><span>${ar() ? 'إجمالي الوزن' : 'Total weight'}</span><strong>${fmtNum(c.weight, 3)} ${t('kg')}</strong></div>
            <div class="stat-mini"><span>${ar() ? 'متاحة' : 'Available'}</span><strong>${fmtNum(c.a)}</strong></div>
            <div class="stat-mini"><span>${ar() ? 'مصروفة' : 'Dispatched'}</span><strong>${fmtNum(c.d)}</strong></div>
            <div class="stat-mini"><span>${ar() ? 'مرجعة للمورد' : 'Returned'}</span><strong>${fmtNum(c.r || 0)}</strong></div>
            <div class="stat-mini"><span>${ar() ? 'غير محددة' : 'Undefined'}</span><strong>${fmtNum(c.u)}</strong></div>
          </div></div>
        ${roll && roll.source === 'excel' ? `<p class="muted small">${ar() ? 'بكر هذا الرول مستوردة من ملف «اجمالي المخزن 2025» — حالتها «غير محددة» ولا تدخل في حساب الرصيد (قاعدة منع مضاعفة المخزون). يمكن تصرفها كحركة كمية فقط.' : 'Imported detail reels — status «undefined», never counted in the balance.'}</p>` : ''}
        <div class="table-wrap"><table class="data-table">
          <thead><tr>
            <th>${ar() ? 'رقم البكرة' : 'Reel no.'}</th><th>${t('size')}</th><th>${ar() ? 'الوزن (كجم)' : 'Weight (kg)'}</th>
            <th>${t('gsm')}</th><th>${t('quality')}</th><th>${ar() ? 'الحالة' : 'Status'}</th><th>${t('actions')}</th>
          </tr></thead>
          <tbody id="rl-reels-body">${reels.length ? reels.map(reelRowHtml).join('') : `<tr><td colspan="7" class="empty">—</td></tr>`}</tbody>
        </table></div>
        <div class="confirm-actions" style="margin-top:.8rem">
          <button class="btn btn-primary" id="rl-print-roll">🖨 ${ar() ? 'طباعة تفاصيل الرول' : 'Print roll details'}</button>
          <button class="btn btn-ghost" id="rl-export-roll">${t('exportExcel')}</button>
          <button class="btn btn-ghost" id="rl-close">${t('close')}</button>
        </div>
      </div>`);
      function reelRowHtml(r) {
        return `<tr>
          <td data-label="${ar() ? 'رقم البكرة' : 'Reel'}">${fmtNum(r.reelNo)}</td>
          <td data-label="${t('size')}">${r.size == null ? '—' : fmtNum(r.size)}</td>
          <td data-label="${ar() ? 'الوزن' : 'Weight'}">${r.weight == null ? '—' : fmtNum(r.weight, 3)}</td>
          <td data-label="${t('gsm')}">${r.gram == null ? '—' : fmtNum(r.gram)}</td>
          <td data-label="${t('quality')}">${esc(r.quality || '—')}</td>
          <td data-label="${ar() ? 'الحالة' : 'Status'}">${statusBadge(r.status)}${r.permitRef ? `<span class="muted small"> (${esc(r.permitRef.permitNo || '')})</span>` : ''}</td>
          <td class="actions-cell">
            <button class="icon-btn" data-edit="${r.id}" title="${t('edit')}">✎</button>
            <button class="icon-btn danger" data-del="${r.id}" title="${t('del')}">🗑</button>
          </td></tr>`;
      }
      node.querySelector('#rl-close').addEventListener('click', closeModal);
      node.querySelector('#rl-print-roll').addEventListener('click', () => { closeModal(); printRoll(rollNo); });
      node.querySelector('#rl-export-roll').addEventListener('click', () => exportRoll(rollNo));
      node.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
        const reel = reels.find((x) => x.id === b.dataset.edit);
        if (reel) editReel(reel, () => { closeModal(); App.refresh().then(load); });
      }));
      node.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
        const reel = reels.find((x) => x.id === b.dataset.del);
        if (!reel) return;
        if (reel.status === 'dispatched') {
          toast(ar() ? 'لا يمكن حذف بكرة مصروفة — احذف أو عدّل إذن الصرف أولًا.' : 'dispatched reel cannot be deleted', 'err');
          return;
        }
        const ok = await confirmDialog({
          title: ar() ? 'حذف بكرة' : 'Delete reel',
          message: ar()
            ? `حذف البكرة ${fmtNum(reel.reelNo)} (مقاس ${fmtNum(reel.size)} — وزن ${fmtNum(reel.weight, 3)} كجم) نهائيًا؟${reel.source === 'reels' ? ' ستُخصم من الرصيد وحركة الإنتاج المرتبطة بها.' : ' بكرة مستوردة — تُحذف من التفاصيل فقط.'}`
            : `Delete reel ${reel.reelNo}?`,
          danger: true,
        });
        if (!ok) return;
        try {
          await global.TX.deleteReel(reel.id);
          toast(ar() ? 'تم الحذف وتحديث الرصيد' : 'deleted', 'ok');
          closeModal();
          await App.refresh();
          load();
        } catch (e) {
          toast(e && e.errors ? e.errors.join(' — ') : String(e.message || e), 'err');
        }
      }));
      openModal(node, { title: ar() ? `تفاصيل الرول ${fmtNum(rollNo)}` : `Roll ${rollNo} details`, wide: true });
      if (opts && opts.autoPrint) { closeModal(); printRoll(rollNo); }
    }

    function editReel(reel, onDone) {
      if (reel.status === 'dispatched') {
        toast(ar() ? 'لا يمكن تعديل بكرة مصروفة — تعديلها يفسد بيانات الصرف. عدّل إذن الصرف أولًا.' : 'dispatched reel is locked', 'err');
        return;
      }
      const families = ['تست لينر معالج', 'توب لاينر'];
      const node = el(`<div class="edit-reel-form">
        <div class="form-grid">
          <label class="field"><span>${ar() ? 'رقم البكرة' : 'Reel no.'} *</span>
            <input id="er-no" type="number" min="1" step="1" value="${esc(reel.reelNo)}"></label>
          <label class="field"><span>${t('size')} *</span>
            <input id="er-size" type="number" min="1" step="any" value="${esc(reel.size == null ? '' : reel.size)}"></label>
          <label class="field"><span>${ar() ? 'الوزن (كجم)' : 'Weight (kg)'} *</span>
            <input id="er-weight" type="number" min="0.001" step="0.001" value="${esc(reel.weight == null ? '' : reel.weight)}"></label>
          <label class="field"><span>${t('gsm')} *</span>
            <input id="er-gram" type="number" min="1" step="any" value="${esc(reel.gram == null ? '' : reel.gram)}"></label>
          <label class="field"><span>${t('quality')} *</span>
            <select id="er-quality">${families.concat(familyOf(reel.quality) && !families.includes(familyOf(reel.quality)) ? [familyOf(reel.quality)] : []).map((f) => `<option ${f === familyOf(reel.quality) ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select></label>
        </div>
        ${reel.source === 'reels' ? `<p class="muted small">${ar() ? 'تعديل البكرة سيحدّث حركة الإنتاج المرتبطة بها ويعيد حساب الرصيد — لن تنشأ حركة جديدة مكررة.' : 'Editing updates the linked production movement and recalculates the balance.'}</p>`
          : `<p class="muted small">${ar() ? 'بكرة مستوردة (غير محددة) — التعديل لا يؤثر على الرصيد.' : 'Imported reel — no balance effect.'}</p>`}
        <div class="form-error" id="er-error"></div>
        <div class="confirm-actions">
          <button class="btn btn-primary" id="er-save">${t('save')}</button>
          <button class="btn btn-ghost" id="er-cancel">${t('cancel')}</button>
        </div></div>`);
      openModal(node, { title: ar() ? `تعديل بكرة ${fmtNum(reel.rollNo)}/${fmtNum(reel.reelNo)}` : 'Edit reel' });
      node.querySelector('#er-cancel').addEventListener('click', closeModal);
      node.querySelector('#er-save').addEventListener('click', async () => {
        try {
          await global.TX.updateReel(reel.id, {
            reelNo: node.querySelector('#er-no').value,
            size: node.querySelector('#er-size').value,
            weight: node.querySelector('#er-weight').value,
            gram: node.querySelector('#er-gram').value,
            quality: node.querySelector('#er-quality').value,
          });
          closeModal();
          toast(ar() ? 'تم تعديل البكرة وتحديث الرصيد' : 'reel updated', 'ok');
          onDone();
        } catch (e) {
          node.querySelector('#er-error').innerHTML = (e && e.errors ? e.errors : [String(e.message || e)]).map((x) => `• ${esc(x)}`).join('<br>');
        }
      });
    }

    /* ---------- طباعة تفاصيل الرول (A4) ---------- */
    function printRoll(rollNo) {
      const roll = rolls.find((r) => r.rollNo === rollNo);
      const reels = (reelsByRoll.get(rollNo) || []).slice().sort((a, b) => a.reelNo - b.reelNo);
      const company = App.state.settings.companyName || (ar() ? 'إدارة المخزن' : 'Inventory Management');
      const totalW = reels.reduce((s, r) => s + (Number(r.weight) || 0), 0);
      const root = document.createElement('div');
      root.id = 'print-root';
      root.innerHTML = `
        <div class="print-page doc-page">
          <div class="rp-head">
            <div class="rp-co">${esc(company)}</div>
            <div class="rp-title">${ar() ? 'تفاصيل رول' : 'Roll details'}</div>
            <div class="rp-sub"><div>${ar() ? 'رقم الرول' : 'Roll no.'}: <strong>${fmtNum(rollNo)}</strong>${roll && roll.date ? ' — ' + t('date') + ': <strong>' + fmtDate(roll.date) + '</strong>' : ''} — ${t('gsm')}: <strong>${roll && roll.gram != null ? fmtNum(roll.gram) : '—'}</strong></div></div>
          </div>
          <table class="rp-table doc-issue-table">
            <thead><tr>
              <th>${ar() ? 'رقم البكرة' : 'Reel no.'}</th><th>${t('size')}</th><th>${ar() ? 'الوزن (كجم)' : 'Weight (kg)'}</th>
              <th>${t('gsm')}</th><th>${t('quality')}</th><th>${ar() ? 'الحالة' : 'Status'}</th>
            </tr></thead>
            <tbody>${reels.map((r) => `<tr>
              <td>${fmtNum(r.reelNo)}</td><td>${r.size == null ? '—' : fmtNum(r.size)}</td>
              <td>${r.weight == null ? '—' : fmtNum(r.weight, 3)}</td><td>${r.gram == null ? '—' : fmtNum(r.gram)}</td>
              <td>${esc(r.quality || '—')}</td><td>${STATUS_LABEL[r.status] || '—'}</td>
            </tr>`).join('')}</tbody>
          </table>
          <table class="rp-table doc-total">
            <tbody>
              <tr><td class="doc-total-label">${ar() ? 'عدد البكرات' : 'Reel count'}</td><td class="doc-total-num">${fmtNum(reels.length)}</td></tr>
              <tr><td class="doc-total-label">${ar() ? 'إجمالي الوزن (كجم)' : 'Total weight (kg)'}</td><td class="doc-total-num">${fmtNum(totalW, 3)}</td></tr>
            </tbody>
          </table>
          <div class="rp-foot">
            <div class="sig-row">
              <div class="sig"><span>${ar() ? 'أمين المخزن' : 'Storekeeper'}</span><i></i></div>
              <div class="sig"><span>${ar() ? 'المحاسب' : 'Accountant'}</span><i></i></div>
            </div>
          </div>
        </div>`;
      const old = document.getElementById('print-root');
      if (old) old.remove();
      const view = document.getElementById('view');
      view.appendChild(root);
      window.print();
      setTimeout(() => root.remove(), 500);
    }

    /* ---------- تصدير الرولات والبكر إلى Excel ---------- */
    function exportRoll(rollNo) {
      const reels = (reelsByRoll.get(rollNo) || []).slice().sort((a, b) => a.reelNo - b.reelNo);
      global.EXCEL.exportReportAOA(
        ar() ? `تفاصيل الرول ${rollNo}` : `Roll ${rollNo}`,
        [ar() ? 'رقم البكرة' : 'Reel', t('size'), ar() ? 'الوزن (كجم)' : 'Weight (kg)', t('gsm'), t('quality'), ar() ? 'الحالة' : 'Status'],
        reels.map((r) => [r.reelNo, r.size == null ? '' : r.size, r.weight == null ? '' : r.weight, r.gram == null ? '' : r.gram, r.quality || '', STATUS_LABEL[r.status] || '']),
        null, `رول_${rollNo}`);
      toast(ar() ? 'تم تنزيل ملف الإكسل' : 'Excel downloaded', 'ok');
    }

    host.querySelector('#rl-new').addEventListener('click', () => { App.navigate('reels-add'); });
    host.querySelector('#rl-search').addEventListener('input', () => { page = 0; draw(); });
    host.querySelector('#rl-source').addEventListener('change', () => { page = 0; draw(); });
    host.querySelector('#rl-status').addEventListener('change', () => { page = 0; draw(); });
    host.querySelector('#rl-clear').addEventListener('click', () => {
      host.querySelector('#rl-search').value = '';
      host.querySelector('#rl-source').value = '';
      host.querySelector('#rl-status').value = '';
      page = 0; draw();
    });
    host.querySelector('#rl-export').addEventListener('click', () => {
      const rows = [];
      const list = applyFilters().slice().sort((a, b) => b.rollNo - a.rollNo);
      for (const r of list) {
        const rs = (reelsByRoll.get(r.rollNo) || []).slice().sort((a, b) => a.reelNo - b.reelNo);
        for (const x of rs) {
          rows.push([r.rollNo, r.date || '', r.gram == null ? '' : r.gram, x.reelNo,
            x.size == null ? '' : x.size, x.weight == null ? '' : x.weight,
            x.gram == null ? '' : x.gram, x.quality || '', STATUS_LABEL[x.status] || '']);
        }
      }
      global.EXCEL.exportReportAOA(ar() ? 'الرولات والبكر' : 'Rolls & reels',
        [ar() ? 'رقم الرول' : 'Roll', t('date'), t('gsm'), ar() ? 'رقم البكرة' : 'Reel', t('size'), ar() ? 'الوزن (كجم)' : 'Weight (kg)', t('gsm'), t('quality'), ar() ? 'الحالة' : 'Status'],
        rows, null, 'الرولات_والبكر');
      toast(ar() ? 'تم تنزيل ملف الإكسل' : 'Excel downloaded', 'ok');
    });

    load();
  }

  App.registerView('reels-add', renderReelsAdd);
  App.registerView('rolls', renderRolls);
})(window);
