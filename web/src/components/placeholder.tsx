// 一律用这里的：空状态（Placeholder，Empty：一个图标、一句话，可以加标题、下面放按钮）、加载中（Loading，居中的 Spinner）、展开收起的 ›（Chevron）。
// 画的时候出错了也用它（Boundary）：不白屏，写明错在哪，给一个刷新。
import { ChevronRight, type LucideIcon, TriangleAlert } from "lucide-react";
import { Component, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

export function Placeholder({ icon: I, title, text, className, children }: { icon?: LucideIcon; title?: string; text: string; className?: string; children?: ReactNode }) {
	return (
		<Empty className={cn("m-auto", className)}>
			<EmptyHeader>
				{I && (
					<EmptyMedia variant="icon">
						<I />
					</EmptyMedia>
				)}
				{title && <EmptyTitle>{title}</EmptyTitle>}
				<EmptyDescription>{text}</EmptyDescription>
			</EmptyHeader>
			{children && <EmptyContent>{children}</EmptyContent>}
		</Empty>
	);
}

/** 加载中：撑满外面那一层、居中一个 Spinner。className 给那一层（定高的写 h-80 之类） */
export const Loading = ({ className }: { className?: string }) => (
	<div className={cn("flex min-h-0 flex-1", className)}>
		<Spinner className="m-auto text-muted-foreground" />
	</div>
);

/**
 * 展开收起：左边一个 ›，展开时转 90°。open 不给：跟着 Radix Collapsible 的 data-state 转（不受控的 Collapsible），
 * 离它最近的 Collapsible 或 CollapsibleTrigger 上加 CHEVRON。同一个 CHEVRON 别套在另一个里面：外面的开着，里面的也会转
 */
export const CHEVRON = "group/chevron";
export const Chevron = ({ open, className }: { open?: boolean; className?: string }) => (
	<ChevronRight className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open === undefined ? "group-data-[state=open]/chevron:rotate-90" : open && "rotate-90", className)} />
);

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
