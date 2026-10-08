// 选 skill：输入框里打「/」或点「+」里的 skill（输入框在 prompt.tsx），弹出这个项目能用的 skill，选了在消息开头插入「/名字 」。
// 筛选按子串（lib/match）。第一次打开时才加载（lazy.tsx）。每次打开都重新拉一遍：会话里刚建的 skill 也在。最近用过的排在前面（存在这台设备上）。
import { History } from "lucide-react";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { enc } from "@shared/api";
import { match } from "@/lib/match";
import { useApi } from "@/lib/use-api";
import { Loading } from "./placeholder";

type Skill = { name: string; desc: string | null };

const RECENT_KEY = "mixer.skills";
const recent = (): string[] => {
	try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]"); } catch { return []; }
};
function remember(name: string) {
	try { localStorage.setItem(RECENT_KEY, JSON.stringify([name, ...recent().filter((n) => n !== name)].slice(0, 5))); } catch {}
}

/** cwd：新会话的文件夹（可能还没开过会话，服务端不认得这个项目） */
export function SkillPicker({ project, cwd, open, onOpenChange, onPick }: { project: string; cwd?: string; open: boolean; onOpenChange: (o: boolean) => void; onPick: (name: string) => void }) {
	const got = useApi<Skill[]>(open ? `/api/skills/${enc(project)}${cwd ? `?cwd=${enc(cwd)}` : ""}` : null);
	const skills = got.data ?? (got.error ? [] : null);
	const pick = (name: string) => {
		remember(name);
		onOpenChange(false);
		onPick(name);
	};
	const r = recent().filter((n) => skills?.some((s) => s.name === n));
	// value 以名字开头（按名字开头的排前面）；「最近用过」里的那份末尾多一个零宽空格，和「全部」里的那份区分开（cmdk 按 value 认是哪一项）
	const item = (s: Skill, key: string) => (
		<CommandItem key={key} value={`${s.name} ${s.desc ?? ""}${key.startsWith("recent") ? "\u200b" : ""}`} onSelect={() => pick(s.name)} className="flex-col items-start gap-0.5">
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
				<Command filter={match}>
					<CommandInput placeholder="筛选 skill" />
					<CommandList className="max-h-[60svh] touch-pan-y overscroll-contain sm:max-h-96">
						{!skills ? (
							<Loading className="py-6" />
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
