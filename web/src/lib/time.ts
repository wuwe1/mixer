export function ago(iso: string): string {
	const s = (Date.now() - new Date(iso).getTime()) / 1000;
	if (s < 60) return "刚刚";
	if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
	if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
	if (s < 86400 * 7) return `${Math.floor(s / 86400)} 天前`;
	return new Date(iso).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}
export const clock = (iso: string) => new Date(iso).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
export const bytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
/** 侧栏用的短写法：刚刚、5 分、3 时、2 天、10/3 */
export function since(iso: string): string {
	const s = (Date.now() - new Date(iso).getTime()) / 1000;
	if (s < 60) return "刚刚";
	if (s < 3600) return `${Math.floor(s / 60)} 分`;
	if (s < 86400) return `${Math.floor(s / 3600)} 时`;
	if (s < 86400 * 7) return `${Math.floor(s / 86400)} 天`;
	return new Date(iso).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}
