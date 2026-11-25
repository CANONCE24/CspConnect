'use strict';
(() => {
  const link = document.querySelector('[data-notification-link]');
  if (!link) return;
  let busy = false, stopped = false;
  const refresh = async () => {
    if (busy || stopped || document.hidden) return;
    busy = true;
    try {
      const response = await fetch('/api/notifications/unread', { headers: { Accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store' });
      if (response.status === 401 || response.status === 403) { stopped = true; return; }
      if (!response.ok) return;
      const { unreadCount } = await response.json();
      if (!Number.isSafeInteger(unreadCount) || unreadCount < 0) return;
      document.querySelectorAll('[data-notification-count]').forEach(badge => {
        badge.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
        badge.hidden = unreadCount === 0;
        badge.setAttribute('aria-label', `${unreadCount} unread notifications`);
      });
      document.querySelectorAll('[data-notification-dot]').forEach(dot => { dot.hidden = unreadCount === 0; });
    } catch { /* Keep the last saved count when the connection is unavailable. */ }
    finally { busy = false; }
  };
  document.addEventListener('visibilitychange', refresh);
  document.querySelector('[data-account-menu]')?.addEventListener('toggle', event => { if (event.target.open) void refresh(); });
  let timer = setInterval(refresh, 30000);
  window.addEventListener('pageshow', event => {
    if (event.persisted) { clearInterval(timer); timer = setInterval(refresh, 30000); void refresh(); }
  });
  window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
})();
