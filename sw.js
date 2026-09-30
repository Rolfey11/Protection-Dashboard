/* Service worker for the installed app. It deliberately caches nothing:
   every launch loads the latest index.html from the site, so an update is
   live for everyone as soon as it's published. Its only job is handling
   clicks on call-reminder notifications. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const leadId = event.notification.data && event.notification.data.leadId;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find(w => w.url.startsWith(self.registration.scope)) || wins[0];
    if (win) {
      await win.focus();
      if (leadId) win.postMessage({ type: 'openLead', leadId });
      return;
    }
    await self.clients.openWindow(self.registration.scope + (leadId ? '?lead=' + encodeURIComponent(leadId) : ''));
  })());
});
