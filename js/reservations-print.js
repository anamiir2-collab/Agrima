/* =========================================================================
   reservations-print.js — طباعة حجوزات العملاء
   Supports a single reservation and a combined multi-customer report.
   Printing is read-only and never changes reservation or inventory data.
   ========================================================================= */
(function (global) {
  'use strict';

  const LABELS = {
    ar: { print: 'طباعة', multi: 'طباعة كشف مجمّع', choose: 'اختيار الحجوزات للطباعة', all: 'تحديد الكل', none: 'إلغاء التحديد', run: 'طباعة المحدد', cancel: 'إلغاء', company: 'شركة اجريماسترز للاستثمار والتنمية الزراعية', report: 'كشف حجوزات البكر للعملاء', date: 'تاريخ الطباعة', customer: 'اسم العميل', type: 'النوع', size: 'المقاس', gsm: 'الجرام', qty: 'عدد البكر', available: 'المتاح', loaded: 'المحمّل', totalQty: 'إجمالي البكر', totalAvailable: 'إجمالي المتاح', totalLoaded: 'إجمالي المحمّل', signatures: ['المسؤول', 'أمين المخزن'] },
    en: { print: 'Print', multi: 'Print combined report', choose: 'Select reservations to print', all: 'Select all', none: 'Clear selection', run: 'Print selected', cancel: 'Cancel', company: 'Agrima Company', report: 'Customer Reel Reservations Report', date: 'Printed on', customer: 'Customer', type: 'Type', size: 'Size', gsm: 'GSM', qty: 'Reel count', available: 'Available', loaded: 'Loaded', totalQty: 'Total reels', totalAvailable: 'Total available', totalLoaded: 'Total loaded', signatures: ['Manager', 'Storekeeper'] }
  };

  const ar = () => !global.UI || typeof global.UI.getLang !== 'function' || global.UI.getLang() === 'ar';
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  const number = (value, digits) => Number(value || 0).toLocaleString(ar() ? 'ar-EG' : 'en-US', { maximumFractionDigits: digits == null ? 2 : digits });
  const dateText = () => new Intl.DateTimeFormat(ar() ? 'ar-EG' : 'en-GB', { dateStyle: 'medium' }).format(new Date());

  function getReservations() {
    try {
      const list = JSON.parse(global.localStorage.getItem('agrima_customer_reservations') || '[]');
      return Array.isArray(list) ? list.filter((r) => r && !r.cancelled) : [];
    } catch (e) { console.error('[reservations-print] cannot read reservations', e); return []; }
  }

  function estimateWeight(item) {
    const qty = Number(item.qtyRequired) || 0;
    const size = Number(item.size) || 0;
    const calc = global.CALC;
    const factor = global.App && global.App.state && global.App.state.settings
      ? global.App.state.settings.weightFactor : 7.5;
    if (calc && typeof calc.productWeight === 'function') return Number(calc.productWeight(size, qty, factor)) || 0;
    return size * qty * (Number(factor) || 7.5);
  }

  function openCombinedPicker() {
    const labels = ar() ? LABELS.ar : LABELS.en;
    const reservations = getReservations().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    if (!reservations.length) {
      global.alert(ar() ? 'لا توجد حجوزات نشطة متاحة للطباعة.' : 'No active reservations to print.');
      return;
    }
    const overlay = global.document.createElement('div');
    overlay.className = 'resv-print-picker-overlay';
    overlay.innerHTML = '<div class="resv-print-picker" role="dialog" aria-modal="true">' +
      '<h3>' + labels.choose + '</h3>' +
      '<div class="resv-print-picker-actions"><button type="button" data-select="all">' + labels.all + '</button><button type="button" data-select="none">' + labels.none + '</button></div>' +
      '<div class="resv-print-picker-list">' + reservations.map((r) =>
        '<label><input type="checkbox" value="' + esc(r.id) + '" checked><span>' + esc(r.customer || '—') +
        '</span><small>' + esc(r.date || '') + ' — ' + (ar() ? 'حجز #' : 'Reservation #') + esc(r.seq || '') + '</small></label>'
      ).join('') + '</div>' +
      '<div class="resv-print-picker-footer"><button type="button" data-cancel>' + labels.cancel + '</button><button type="button" class="primary" data-print>' + labels.run + '</button></div></div>';
    global.document.body.appendChild(overlay);
    overlay.addEventListener('click', (event) => { if (event.target === overlay || event.target.closest('[data-cancel]')) overlay.remove(); });
    overlay.querySelector('[data-select="all"]').addEventListener('click', () => overlay.querySelectorAll('input[type="checkbox"]').forEach((x) => { x.checked = true; }));
    overlay.querySelector('[data-select="none"]').addEventListener('click', () => overlay.querySelectorAll('input[type="checkbox"]').forEach((x) => { x.checked = false; }));
    overlay.querySelector('[data-print]').addEventListener('click', () => {
      const ids = new Set(Array.from(overlay.querySelectorAll('input[type="checkbox"]:checked')).map((x) => x.value));
      const selected = reservations.filter((r) => ids.has(String(r.id)));
      if (!selected.length) { global.alert(ar() ? 'حدد حجزًا واحدًا على الأقل.' : 'Select at least one reservation.'); return; }
      overlay.remove();
      printCombined(selected);
    });
  }

  function printCombined(reservations) {
    const labels = ar() ? LABELS.ar : LABELS.en;
    const app = global.App;
    if (!app || typeof app.getReservationPrintRows !== 'function') {
      global.alert(ar() ? 'تعذر تجهيز بيانات الكشف. حدّث التطبيق وحاول مرة أخرى.' : 'Could not prepare report data. Refresh and try again.');
      return;
    }
    const rowsData = app.getReservationPrintRows(reservations.map((r) => r.id));
    if (!rowsData.length) {
      global.alert(ar() ? 'لا توجد بنود في الحجوزات المحددة.' : 'No reservation items in the selected records.');
      return;
    }
    let totalQty = 0, totalAvailable = 0, totalLoaded = 0;
    const rows = rowsData.map((item) => {
      const qty = Number(item.required) || 0;
      const available = Number(item.available) || 0;
      const loaded = Number(item.loaded) || 0;
      totalQty += qty;
      totalAvailable += available;
      totalLoaded += loaded;
      return '<tr><td>' + esc(item.customer || '—') + '</td><td>' + esc(item.quality || '—') +
        '</td><td>' + esc(item.gsm) + '</td><td>' + esc(item.size) +
        '</td><td>' + number(qty, 0) + '</td><td>' + number(available, 0) +
        '</td><td>' + number(loaded, 0) + '</td></tr>';
    });
    const report = global.document.createElement('section');
    report.id = 'resv-multi-print';
    report.innerHTML = '<header><div class="resv-multi-company">' + labels.company + '</div><h1>' + labels.report +
      '</h1><div>' + labels.date + ': ' + dateText() + '</div></header>' +
      '<table><thead><tr><th>' + labels.customer + '</th><th>' + labels.type + '</th><th>' + labels.gsm +
      '</th><th>' + labels.size + '</th><th>' + labels.qty + '</th><th>' + labels.available +
      '</th><th>' + labels.loaded + '</th></tr></thead><tbody>' + rows.join('') +
      '</tbody><tfoot><tr><th colspan="4">' + labels.totalQty + '</th><th>' + number(totalQty, 0) +
      '</th><th>' + number(totalAvailable, 0) + '</th><th>' + number(totalLoaded, 0) + '</th></tr></tfoot></table>' +
      '<div class="resv-multi-signatures">' + labels.signatures.map((x) => '<div>' + x + '<span></span></div>').join('') + '</div>';
    global.document.body.appendChild(report);
    const cleanup = () => { if (report.parentNode) report.remove(); global.removeEventListener('afterprint', cleanup); };
    global.addEventListener('afterprint', cleanup, { once: true });
    global.print();
    global.setTimeout(cleanup, 60000);
  }

  function decorateView() {
    const app = global.App;
    const view = global.document.getElementById('view');
    if (!app || !view) return;
    const route = typeof app.currentRoute === 'function' ? app.currentRoute() : '';
    if (route !== 'reservations' && route !== 'reservation-details') return;
    const head = view.querySelector('.page-head');
    if (!head) return;
    const actions = head.querySelector('.head-actions');
    if (!actions) return;
    const labels = ar() ? LABELS.ar : LABELS.en;

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
      button.addEventListener('click', () => global.print());
      actions.appendChild(button);
    }
    if (!view.querySelector('.resv-print-heading')) {
      const title = global.document.createElement('div');
      title.className = 'resv-print-heading';
      title.style.display = 'none';
      const isDetail = route === 'reservation-details';
      const heading = head.querySelector('h2');
      title.innerHTML = '<div class="resv-print-company">' + labels.company + '</div>' +
        '<div class="resv-print-title">' + esc(heading ? heading.textContent : (isDetail ? labels.report : labels.report)) + '</div>' +
        '<div class="resv-print-date">' + labels.date + ': ' + dateText() + '</div>';
      view.insertBefore(title, view.firstChild);
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
})(window);
