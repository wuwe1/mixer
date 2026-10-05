// 面板里还没选东西、没有内容时的空状态：和首页一样用 Empty，一个图标、一句话（可以加标题）
import type { LucideIcon } from "lucide-react";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";

export function Placeholder({ icon: I, title, text }: { icon: LucideIcon; title?: string; text: string }) {
	return (
		<Empty className="m-auto">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<I />
				</EmptyMedia>
				{title && <EmptyTitle>{title}</EmptyTitle>}
				<EmptyDescription>{text}</EmptyDescription>
			</EmptyHeader>
		</Empty>
	);
}
