// 选 skill：输入框里打「/」或点「/」按钮（按钮在 composer.tsx），弹出这个项目能用的 skill，选了在消息开头插入「/名字 」。
// 第一次打开时才加载（lazy.tsx）。每次打开都重新拉一遍：会话里刚建的 skill 也在。最近用过的排在前面（存在这台设备上）。
import { History } from "lucide-react";
import { useEffect, useState } from "react";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { api, enc } from "@/lib/api";

type Skill = { name: string; desc: string | null };

const RECENT_KEY = "mixer.skills";
const recent = (): string[] => {
	try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]"); } catch { return []; }
};
function remember(name: string) {
	try { localStorage.setItem(RECENT_KEY, JSON.stringify([name, ...recent().filter((n) => n !== name)].slice(0, 5))); } catch {}
}

export function SkillPicker({ project, open, onOpenChange, onPick }: { project: string; open: boolean; onOpenChange: (o: boolean) => void; onPick: (name: string) => void }) {
	const [skills, setSkills] = useState<Skill[] | null>(null);
	useEffect(() => {
		if (!open) return;
		api<Skill[]>(`/api/skills/${enc(project)}`).then(setSkills, () => setSkills([]));
	}, [open, project]);
	const pick = (name: string) => {
		remember(name);
		onOpenChange(false);
		onPick(name);
	};
	const r = recent().filter((n) => skills?.some((s) => s.name === n));
	const item = (s: Skill, key: string) => (
		<CommandItem key={key} value={`${key} ${s.name} ${s.desc ?? ""}`} onSelect={() => pick(s.name)} className="flex-col items-start gap-0.5">
			<span className="flex items-center gap-1.5 font-mono text-md">
				{key.startsWith("recent") && <History className="size-3.5 text-muted-foreground" />}/{s.name}
			</span>
			{s.desc && <span className="line-clamp-2 text-xs text-muted-foreground">{s.desc}</span>}
		</CommandItem>
	);
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			{/* 手机上不自动聚焦筛选框：键盘一弹就把列表盖住了，划不到；要筛选自己点 */}
			<DialogContent
				className="top-[8svh] translate-y-0 overflow-hidden p-0 sm:top-1/4"
				showCloseButton={false}
				onOpenAutoFocus={(e) => { if (matchMedia("(pointer: coarse)").matches) e.preventDefault(); }}
			>
				<DialogTitle className="sr-only">选 skill</DialogTitle>
				<DialogDescription className="sr-only">选了在消息开头插入 /名字</DialogDescription>
				<Command>
					<CommandInput placeholder="筛选 skill" />
					<CommandList className="max-h-[60svh] touch-pan-y overscroll-contain sm:max-h-96">
						{!skills ? (
							<div className="flex justify-center py-6"><Spinner className="text-muted-foreground" /></div>
						) : (
							<>
								<CommandEmpty className="py-5 text-center text-md text-muted-foreground">没有匹配的 skill</CommandEmpty>
								{r.length > 0 && (
									<CommandGroup heading="最近用过">
										{r.map((n) => item(skills.find((s) => s.name === n) as Skill, `recent ${n}`))}
									</CommandGroup>
								)}
								<CommandGroup heading="全部">{skills.map((s) => item(s, s.name))}</CommandGroup>
							</>
						)}
					</CommandList>
				</Command>
			</DialogContent>
		</Dialog>
	);
}
