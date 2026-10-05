export const clock = (iso: string) => new Date(iso).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
export const bytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
/** 用了多久（毫秒）：12 秒、2:13、1:02:13 */
export function took(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s} 秒`;
	const mm = `${Math.floor(s / 60) % 60}`;
	const ss = String(s % 60).padStart(2, "0");
	return s < 3600 ? `${mm}:${ss}` : `${Math.floor(s / 3600)}:${mm.padStart(2, "0")}:${ss}`;
}
/** 列表里的相对时间（侧栏、提交）：刚刚、5 分钟、3 小时、2 天、10/3 */
export function since(iso: string): string {
	const s = (Date.now() - new Date(iso).getTime()) / 1000;
	if (s < 60) return "刚刚";
	if (s < 3600) return `${Math.floor(s / 60)} 分钟`;
	if (s < 86400) return `${Math.floor(s / 3600)} 小时`;
	if (s < 86400 * 7) return `${Math.floor(s / 86400)} 天`;
	return new Date(iso).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}
