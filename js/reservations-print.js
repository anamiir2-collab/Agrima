/* =========================================================================
   reservations-print.js — طباعة حجوزات العملاء
   عرض وطباعة قائمة الحجوزات أو مستند حجز مستقل دون تغيير بيانات النظام.
   ========================================================================= */
(function (global) {
  'use strict';

  const LABELS = {
    ar: { print: 'طباعة', company: 'Agrima — إدارة المخزون والبكر', list: 'كشف حجوزات العملاء', detail: 'مستند حجز بكر عميل', signatures: ['إعداد المسؤول', 'أمين المخزن', 'العميل'] },
    en: { print: 'Print', company: 'Agrima — Inventory & Reel Management', list: 'Customer Reservations Report', detail: 'Customer Reel Reservation', signatures: ['Prepared by', 'Storekeeper', 'Customer'] },
  };

  function isArabic() {
    return !global.UI || typeof global.UI.getLang !== 'function' || global.UI.getLang() === 'ar';
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
    if (!actions || actions.querySelector('.resv-print-btn')) return;

    const ar = isArabic();
    const labels = ar ? LABELS.ar : LABELS.en;
    const button = global.document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-primary resv-print-btn';
    button.textContent = '▤ ' + labels.print;
    button.addEventListener('click', () => global.print());
    actions.appendChild(button);

    if (!view.querySelector('.resv-print-heading')) {
      const title = global.document.createElement('div');
      title.className = 'resv-print-heading';
      const isDetail = route === 'reservation-details';
      const heading = head.querySelector('h2');
      title.innerHTML = '<div class="resv-print-company">' + labels.company + '</div>' +
        '<div class="resv-print-title">' + (heading ? heading.textContent : (isDetail ? labels.detail : labels.list)) + '</div>' +
        '<div class="resv-print-date">' + (ar ? 'تاريخ الطباعة: ' : 'Printed: ') +
        new Intl.DateTimeFormat(ar ? 'ar-EG' : 'en-GB', { dateStyle: 'medium' }).format(new Date()) + '</div>';
      view.insertBefore(title, view.firstChild);
    }

    if (route === 'reservation-details' && !view.querySelector('.resv-print-signatures')) {
      const sign = global.document.createElement('div');
      sign.className = 'resv-print-signatures';
      sign.innerHTML = labels.signatures.map((name) => '<div class="resv-print-sign"><strong>' + name + '</strong><span></span></div>').join('');
      view.appendChild(sign);
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
