// 点开一个小面板：电脑上是贴着按钮的浮层（Popover），手机上从下面出来、整屏宽（Sheet）。上面一行标题，可带一句说明
import type { ReactNode } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useSidebar } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

/** trigger 是按钮本身（自己会开关，不用另写 onClick）；className 给电脑上的浮层（宽、最大高度） */
export function Popsheet({ trigger, title, description, side, align, open, onOpenChange, className, children }: {
	trigger: ReactNode;
	title: string;
	description?: string;
	side?: "top" | "right" | "bottom" | "left";
	align?: "start" | "center" | "end";
	open?: boolean;
	onOpenChange?: (o: boolean) => void;
	className?: string;
	children: ReactNode;
}) {
	// 和侧栏用同一个判断（已经算好了，不会先画成浮层再换）
	const { isMobile } = useSidebar();
	if (isMobile)
		return (
			<Sheet open={open} onOpenChange={onOpenChange}>
				<SheetTrigger asChild>{trigger}</SheetTrigger>
				<SheetContent side="bottom" className="max-h-[85svh] gap-0 pb-[max(1rem,env(safe-area-inset-bottom))]" {...(description ? {} : { "aria-describedby": undefined })}>
					<SheetHeader>
						<SheetTitle>{title}</SheetTitle>
						{description && <SheetDescription>{description}</SheetDescription>}
					</SheetHeader>
					<div className="overflow-y-auto px-4">{children}</div>
				</SheetContent>
			</Sheet>
		);
	return (
		<Popover open={open} onOpenChange={onOpenChange}>
			<PopoverTrigger asChild>{trigger}</PopoverTrigger>
			<PopoverContent side={side} align={align} className={cn("overflow-y-auto p-3", className)}>
				<div className="flex flex-col gap-0.5 pb-1">
					<span className="text-sm font-medium">{title}</span>
					{description && <span className="text-xs text-muted-foreground">{description}</span>}
				</div>
				{children}
			</PopoverContent>
		</Popover>
	);
}
