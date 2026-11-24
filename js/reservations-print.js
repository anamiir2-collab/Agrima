/* =========================================================================
   reservations-print.js — طباعة حجوزات العملاء (الكشف الموحّد)
   -------------------------------------------------------------------------
   القاعدة: جدول واحد للشاشة والطباعة — الطباعة تعيد استخدام نفس عنصر
   الجدول المعروض على الشاشة ونفس دوال بناء الصفوف والإجماليات من
   reservations.js (App.reservationReportRows / App.renderResvUnifiedTable).
   لا يُبنى جدول منفصل للطباعة ولا تُحسب الأرقام بصيغة ثانية. الفرق الوحيد
   بين الشاشة والطباعة: إخفاء أدوات التحكم وتنسيق الورقة عبر css/print.css.

   «طباعة كشف مجمّع»: اختيار عميل واحد أو عدة عملاء أو تحديد الكل — ثم
   تُطببع جميع بنود حجوزات العملاء المحددين فقط (مع استبعاد الحجوزات
   الملغاة بالكامل). الاختيار والطباعة قراءة فقط ولا يعدلان أي بيانات.
   ========================================================================= */
(function (global) {
  'use strict';

  const LABELS = {
    ar: {
      print: 'طباعة', multi: 'طباعة كشف مجمّع', choose: 'اختيار العملاء للطباعة',
      chooseSub: 'يُطبع الكشف المجمّع لجميع بنود حجوزات العملاء المحددين — الحجوزات الملغاة بالكامل مستبعدة.',
      all: 'تحديد الكل', none: 'إلغاء التحديد', run: 'طباعة المحدد', cancel: 'إلغاء',
      noRes: 'لا توجد حجوزات نشطة متاحة للطباعة.',
      noItems: 'لا توجد بنود حجوزات للعملاء المحددين.',
      selectOne: 'حدد عميلًا واحدًا على الأقل.',
      noTable: 'افتح قسم حجوزات العملاء أولًا لطباعة الكشف المجمّع.',
      reservations: 'حجز', items: 'بند',
    },
    en: {
      print: 'Print', multi: 'Print combined report', choose: 'Select customers to print',
      chooseSub: 'Prints all reservation items of the selected customers — fully cancelled reservations are excluded.',
      all: 'Select all', none: 'Clear selection', run: 'Print selected', cancel: 'Cancel',
      noRes: 'No active reservations to print.',
      noItems: 'No reservation items for the selected customers.',
      selectOne: 'Select at least one customer.',
      noTable: 'Open the reservations section first to print the combined report.',
      reservations: 'reservations', items: 'items',
    },
  };

  const ar = () => !global.UI || typeof global.UI.getLang !== 'function' || global.UI.getLang() === 'ar';
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  const number = (value, digits) => Number(value || 0).toLocaleString(ar() ? 'ar-EG' : 'en-US', { maximumFractionDigits: digits == null ? 2 : digits });
  const dateText = () => {
    try {
      return new Intl.DateTimeFormat(ar() ? 'ar-EG' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date());
    } catch (e) { return new Date().toLocaleString(); }
  };
  const L = () => (ar() ? LABELS.ar : LABELS.en);
  const RL = () => (global.App && typeof global.App.reservationReportLabels === 'function'
    ? global.App.reservationReportLabels() : null);

  /* قائمة العملاء المتاح طباعتهم — من مصدر الكشف الموحّد نفسه (قراءة فقط) */
  function getCustomerChoices() {
    const app = global.App;
    if (!app || typeof app.reservationReportRows !== 'function') return [];
    const rows = app.reservationReportRows(null);
    const map = new Map();
    for (const x of rows) {
      const cur = map.get(x.customerKey) || { key: x.customerKey, name: x.customer || x.customerKey, reservations: new Set(), items: 0 };
      cur.reservations.add(x.reservationId);
      cur.items += 1;
      map.set(x.customerKey, cur);
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'ar'));
  }

  function openCombinedPicker() {
    const labels = L();
    const choices = getCustomerChoices();
    if (!choices.length) { global.alert(labels.noRes); return; }
    const overlay = global.document.createElement('div');
    overlay.className = 'resv-print-picker-overlay';
    overlay.innerHTML = '<div class="resv-print-picker" role="dialog" aria-modal="true">' +
      '<h3>' + labels.choose + '</h3>' +
      '<p class="resv-print-picker-sub">' + labels.chooseSub + '</p>' +
      '<div class="resv-print-picker-actions"><button type="button" data-select="all">' + labels.all + '</button>' +
      '<button type="button" data-select="none">' + labels.none + '</button></div>' +
      '<div class="resv-print-picker-list">' + choices.map((c) =>
        '<label><input type="checkbox" value="' + esc(c.key) + '" checked><span>' + esc(c.name) +
        '</span><small>' + esc(String(c.reservations.size)) + ' ' + esc(labels.reservations) +
        ' — ' + esc(String(c.items)) + ' ' + esc(labels.items) + '</small></label>'
      ).join('') + '</div>' +
      '<div class="resv-print-picker-footer"><button type="button" data-cancel>' + labels.cancel + '</button>' +
      '<button type="button" class="primary" data-print>' + labels.run + '</button></div></div>';
    global.document.body.appendChild(overlay);
    overlay.addEventListener('click', (event) => { if (event.target === overlay || event.target.closest('[data-cancel]')) overlay.remove(); });
    overlay.querySelector('[data-select="all"]').addEventListener('click', () => overlay.querySelectorAll('input[type="checkbox"]').forEach((x) => { x.checked = true; }));
    overlay.querySelector('[data-select="none"]').addEventListener('click', () => overlay.querySelectorAll('input[type="checkbox"]').forEach((x) => { x.checked = false; }));
    overlay.querySelector('[data-print]').addEventListener('click', () => {
      const keys = new Set(Array.from(overlay.querySelectorAll('input[type="checkbox"]:checked')).map((x) => x.value));
      if (!keys.size) { global.alert(labels.selectOne); return; }
      overlay.remove();
      printCombinedCustomers(keys);
    });
  }

  /* تحديث توقيت الطباعة في الترويسة الموجودة (نفس العنصر — لا ترويسة ثانية).
     يُكتب فقط عند تغيّر النص فعليًا: الكتابة غير المشروطة تطلق
     MutationObserver في decorateView فتعيد الكتابة — حلقة لا نهائية. */
  function refreshHeadingDate() {
    const rl = RL();
    if (!rl) return;
    const el = global.document.querySelector('#view .resv-print-date');
    const text = rl.printedAt + ': ' + dateText();
    if (el && el.textContent !== text) el.textContent = text;
  }

  /**
   * طباعة الكشف المجمّع للعملاء المحددين — عبر نفس عنصر الجدول المعروض على
   * الشاشة (#rv-table-host) ونفس دوال البناء والحساب، ثم تُعاد الصفوف الكاملة
   * بعد انتهاء الطباعة. لا يُنشأ عنصر طباعة منفصل إطلاقًا.
   */
  function printCombinedCustomers(customerKeys) {
    const app = global.App;
    const labels = L();
    const view = global.document.getElementById('view');
    const container = view ? view.querySelector('#rv-table-host') : null;
    if (!app || !container || typeof app.renderResvUnifiedTable !== 'function'
      || typeof app.reservationReportRows !== 'function') {
      global.alert(labels.noTable);
      return;
    }
    const rows = app.reservationReportRows(customerKeys);
    if (!rows.length) { global.alert(labels.noItems); return; }

    refreshHeadingDate();
    /* نفس الجدول المعروض على الشاشة — نفس الدالة، نفس الصفوف، نفس الإجماليات.
       عمود الإجراءات يبقى في العنصر ويُخفى عند الطباعة عبر css/print.css. */
    container.innerHTML = app.renderResvUnifiedTable(rows, { actions: true });

    let restored = false;
    const restore = () => {
      if (restored) return;
      restored = true;
      global.removeEventListener('afterprint', restore);
      /* إعادة عرض القسم بالصفوف الكاملة (البيانات لم تُلمس — قراءة فقط) */
      if (app.currentRoute && app.currentRoute() === 'reservations') app.rerender();
    };
    global.addEventListener('afterprint', restore, { once: true });
    global.setTimeout(restore, 60000); /* احتياط للمتصفحات التي لا تطلق afterprint */
    global.print();
  }

  function decorateView() {
    const app = global.App;
    const view = global.document.getElementById('view');
    if (!app || !view) return;
    const route = typeof app.currentRoute === 'function' ? app.currentRoute() : '';
    if (route !== 'reservations' && route !== 'reservation-details') return;
    const head = view.querySelector('.page-head');
    const labels = L();

    if (head) {
      const actions = head.querySelector('.head-actions');
      if (actions) {
        /* الأزرار تُبنى داخل renderReservations نفسه — تُضاف هنا فقط إن غابت
           (مثل مسار تفاصيل الحجز) لضمان عدم التكرار أبدًا */
        if (route === 'reservations' && !actions.querySelector('.resv-multi-print-btn')) {
          const multi = global.document.createElement('button');
          multi.type = 'button'; multi.className = 'btn btn-primary resv-multi-print-btn';
          multi.textContent = '▤ ' + labels.multi;
          multi.addEventListener('click', openCombinedPicker);
          actions.appendChild(multi);
        }
        if (!actions.querySelector('.resv-print-btn')) {
          const button = global.document.createElement('button');
          button.type = 'button'; button.className = 'btn btn-ghost resv-print-btn';
          button.textContent = '▤ ' + labels.print;
          button.addEventListener('click', () => { refreshHeadingDate(); global.print(); });
          actions.appendChild(button);
        }
      }
    }
    if (!view.querySelector('.resv-print-heading')) {
      const rl = RL();
      const title = global.document.createElement('div');
      title.className = 'resv-print-heading';
      title.style.display = 'none';
      title.innerHTML = rl
        ? '<div class="resv-print-company">' + rl.company + '</div>' +
          '<div class="resv-print-title">' + esc(rl.report) + '</div>' +
          '<div class="resv-print-date">' + rl.printedAt + ': ' + dateText() + '</div>'
        : '';
      view.insertBefore(title, view.firstChild);
    } else {
      refreshHeadingDate(); /* إبقاء توقيت الطباعة محدّثًا */
    }
  }

  function start() {
    const view = global.document.getElementById('view');
    if (!view || !global.MutationObserver) return;
    const observer = new MutationObserver(decorateView);
    observer.observe(view, { childList: true, subtree: true });
    decorateView();
  }
  if (global.document.readyState === 'loading') global.document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();

  global.App = global.App || {};
  global.App.openCombinedResvPicker = openCombinedPicker;
})(window);
