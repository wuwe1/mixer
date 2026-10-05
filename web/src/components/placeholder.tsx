// 面板里还没选东西、没有内容时的空状态：和首页一样用 Empty，一个图标、一句话（可以加标题、下面放按钮）。
// 画的时候出错了也用它（Boundary）：不白屏，写明错在哪，给一个刷新。
import { type LucideIcon, TriangleAlert } from "lucide-react";
import { Component, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { cn } from "@/lib/utils";

export function Placeholder({ icon: I, title, text, children }: { icon: LucideIcon; title?: string; text: string; children?: ReactNode }) {
	return (
		<Empty className="m-auto">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<I />
				</EmptyMedia>
				{title && <EmptyTitle>{title}</EmptyTitle>}
				<EmptyDescription>{text}</EmptyDescription>
			</EmptyHeader>
			{children && <EmptyContent>{children}</EmptyContent>}
		</Empty>
	);
}

/** 里面画的时候抛了错：换成「出错了」和刷新。className 给出错时外面那一层（整页的要撑满） */
export class Boundary extends Component<{ children: ReactNode; className?: string }, { error: Error | null }> {
	state = { error: null as Error | null };
	static getDerivedStateFromError(error: unknown) {
		return { error: error instanceof Error ? error : new Error(String(error)) };
	}
	render() {
		const { error } = this.state;
		if (!error) return this.props.children;
		return (
			<div className={cn("flex min-h-0 flex-1", this.props.className)}>
				<Placeholder icon={TriangleAlert} title="出错了" text={error.message || String(error)}>
					<Button variant="outline" size="sm" onClick={() => location.reload()}>刷新</Button>
				</Placeholder>
			</div>
		);
	}
}
