// Service Worker：只管推送通知（server/push.ts 推来的），不拦网络请求（页面、接口照常直连，Cloudflare Access 也不受影响）。
// 推来的：{ title, body, tag, project, session, badge }。同一个会话的 tag 一样，新的盖掉旧的；badge 是主屏幕图标上的数。
// 点通知：有开着的页面就切过去、让它打开那个会话（postMessage），没有就开一个新窗口到那个会话。
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
	let d = {};
	try { d = e.data ? e.data.json() : {}; } catch {}
	const shown = self.registration.showNotification(d.title || "mixer", {
		body: d.body || "",
		tag: d.tag,
		renotify: true,
		data: { project: d.project, session: d.session },
	});
	const badge = typeof d.badge === "number" && "setAppBadge" in navigator ? (d.badge > 0 ? navigator.setAppBadge(d.badge) : navigator.clearAppBadge()) : null;
	e.waitUntil(Promise.all([shown, badge]).catch(() => {}));
});

self.addEventListener("notificationclick", (e) => {
	e.notification.close();
	const { project, session } = e.notification.data || {};
	const url = project && session ? `/p/${encodeURIComponent(project)}/s/${encodeURIComponent(session)}` : "/";
	e.waitUntil((async () => {
		const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
		const page = all.find((c) => "focus" in c);
		if (!page) return self.clients.openWindow(url);
		await page.focus();
		if (project && session) page.postMessage({ type: "open", project, session });
	})());
});
