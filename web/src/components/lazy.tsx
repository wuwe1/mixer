// 首屏用不着的几块按需加载，主包小一点，手机上打开快：浏览会话、新会话、选 skill 的对话框，项目页，文件、改动面板。
// 对话框第一次打开时才加载，之后一直挂着（关的时候有动画）；页面、面板加载时显示 Spinner。
// 重新打包之后旧的那几块就没了：main.tsx 里拿不到时刷新
import { type ComponentType, lazy, type ReactNode, Suspense, useState } from "react";
import { Spinner } from "@/components/ui/spinner";

const Loading = () => (
	<div className="flex min-h-0 flex-1">
		<Spinner className="m-auto text-muted-foreground" />
	</div>
);

function later<P extends object>(load: () => Promise<ComponentType<P>>, fallback: ReactNode) {
	const C = lazy(() => load().then((c) => ({ default: c })));
	return (p: P) => (
		<Suspense fallback={fallback}>
			<C {...p} />
		</Suspense>
	);
}

function dialog<P extends { open: boolean }>(load: () => Promise<ComponentType<P>>) {
	const C = later(load, null);
	return function Dialog(p: P) {
		const [seen, setSeen] = useState(p.open);
		if (p.open && !seen) setSeen(true);
		return seen || p.open ? <C {...p} /> : null;
	};
}

export const Browse = dialog(() => import("./browse").then((m) => m.Browse));
export const NewSession = dialog(() => import("./new-session").then((m) => m.NewSession));
export const SkillPicker = dialog(() => import("./skills").then((m) => m.SkillPicker));
export const ProjectHome = later(() => import("./project").then((m) => m.ProjectHome), <Loading />);
export const Files = later(() => import("./files").then((m) => m.Files), <Loading />);
export const Changes = later(() => import("./changes").then((m) => m.Changes), <Loading />);
