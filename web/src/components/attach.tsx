// 消息里带图片：选图（或粘贴），点缩略图打开批注，画箭头、随手画线。发送时把批注画进图里，缩到长边 2000px 以内再发。
// 批注按原图的像素坐标存，显示、导出都从同一张 canvas 来，手机上看到什么发出去就是什么。
import { ImagePlus, MoveUpRight, Pencil, Undo2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

type Pt = [number, number];
/** 箭头：起点到终点；画笔：手指划过的点 */
type Shape = { kind: "arrow"; a: Pt; b: Pt } | { kind: "pen"; pts: Pt[] };
export type Shot = { id: string; url: string; media: string; shapes: Shape[] };

/** 发出去的图最长边 */
const MAX = 2000;

export function toShots(files: Iterable<File>): Shot[] {
	return [...files].filter((f) => f.type.startsWith("image/")).map((f) => ({ id: crypto.randomUUID(), url: URL.createObjectURL(f), media: f.type, shapes: [] }));
}

const load = (url: string) =>
	new Promise<HTMLImageElement>((ok, fail) => {
		const img = new Image();
		img.onload = () => ok(img);
		img.onerror = fail;
		img.src = url;
	});

/** 批注的颜色：和「出错」同一个红，图上最显眼 */
const ink = () => getComputedStyle(document.documentElement).getPropertyValue("--destructive").trim() || "red";

/** 把图和批注画到 canvas 上；canvas 的大小 = 原图缩到 MAX 以内，批注坐标按原图像素 */
function draw(c: HTMLCanvasElement, img: HTMLImageElement, shapes: Shape[]) {
	const k = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
	c.width = Math.round(img.naturalWidth * k);
	c.height = Math.round(img.naturalHeight * k);
	const g = c.getContext("2d") as CanvasRenderingContext2D;
	g.drawImage(img, 0, 0, c.width, c.height);
	const w = Math.max(3, Math.max(c.width, c.height) / 250);
	g.strokeStyle = g.fillStyle = ink();
	g.lineWidth = w;
	g.lineCap = g.lineJoin = "round";
	for (const s of shapes) {
		if (s.kind === "pen") {
			// 相邻两点的中点连成二次曲线，手指的折线就顺了
			const ps = s.pts.map(([x, y]) => [x * k, y * k] as Pt);
			g.beginPath();
			g.moveTo(...ps[0]);
			for (let i = 1; i < ps.length - 1; i++) g.quadraticCurveTo(ps[i][0], ps[i][1], (ps[i][0] + ps[i + 1][0]) / 2, (ps[i][1] + ps[i + 1][1]) / 2);
			g.lineTo(...ps[ps.length - 1]);
			g.stroke();
			continue;
		}
		const [x1, y1] = [s.a[0] * k, s.a[1] * k];
		const [x2, y2] = [s.b[0] * k, s.b[1] * k];
		g.beginPath();
		g.moveTo(x1, y1);
		g.lineTo(x2, y2);
		g.stroke();
		{
			const t = Math.atan2(y2 - y1, x2 - x1);
			const h = w * 4.5;
			g.beginPath();
			g.moveTo(x2, y2);
			g.lineTo(x2 - h * Math.cos(t - 0.45), y2 - h * Math.sin(t - 0.45));
			g.lineTo(x2 - h * Math.cos(t + 0.45), y2 - h * Math.sin(t + 0.45));
			g.closePath();
			g.fill();
		}
	}
	return k;
}

/** 发送用：画好批注、缩好尺寸的 base64。没批注、不用缩的原样发 */
export async function encode(s: Shot): Promise<{ media: string; data: string }> {
	const img = await load(s.url);
	const c = document.createElement("canvas");
	const k = draw(c, img, s.shapes);
	const raw = !s.shapes.length && k === 1 && ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(s.media);
	const blob = raw
		? await (await fetch(s.url)).blob()
		: await new Promise<Blob>((ok) => c.toBlob((b) => ok(b as Blob), s.media === "image/png" ? "image/png" : "image/jpeg", 0.9));
	const data = await new Promise<string>((ok) => {
		const r = new FileReader();
		r.onload = () => ok(String(r.result).split(",")[1] ?? "");
		r.readAsDataURL(blob);
	});
	return { media: blob.type || s.media, data };
}

/** 选图的按钮 */
export function AttachButton({ onAdd }: { onAdd: (s: Shot[]) => void }) {
	const file = useRef<HTMLInputElement>(null);
	return (
		<>
			<Button variant="ghost" size="icon-sm" className="text-muted-foreground" onClick={() => file.current?.click()} aria-label="加图片" title="加图片">
				<ImagePlus className="size-4" />
			</Button>
			<input
				ref={file}
				type="file"
				accept="image/*"
				multiple
				hidden
				onChange={(e) => {
					if (e.target.files) onAdd(toShots(e.target.files));
					e.target.value = "";
				}}
			/>
		</>
	);
}

/** 输入框上方的缩略图：点开批注，× 去掉 */
export function AttachStrip({ shots, onChange }: { shots: Shot[]; onChange: (s: Shot[]) => void }) {
	const [editing, setEditing] = useState<Shot | null>(null);
	if (!shots.length) return null;
	return (
		<div className="flex gap-2 overflow-x-auto px-1 pt-1">
			{shots.map((s) => (
				<div key={s.id} className="relative shrink-0">
					<button type="button" onClick={() => setEditing(s)} className="block overflow-hidden rounded-md border" title="点开画箭头、画线">
						<Thumb shot={s} />
					</button>
					{s.shapes.length > 0 && <Pencil className="absolute bottom-1 left-1 size-3 rounded-sm bg-background/80 text-muted-foreground" aria-label="有批注" />}
					<Button
						variant="secondary"
						size="icon-xs"
						className="absolute -top-1.5 -right-1.5 rounded-full border"
						onClick={() => { URL.revokeObjectURL(s.url); onChange(shots.filter((x) => x.id !== s.id)); }}
						aria-label="去掉这张图"
					>
						<X className="size-3" />
					</Button>
				</div>
			))}
			<Annotator shot={editing} onClose={() => setEditing(null)} onSave={(shapes) => editing && onChange(shots.map((x) => (x.id === editing.id ? { ...x, shapes } : x)))} />
		</div>
	);
}

/** 缩略图也带着批注画 */
function Thumb({ shot }: { shot: Shot }) {
	const c = useRef<HTMLCanvasElement>(null);
	useEffect(() => {
		load(shot.url).then((img) => c.current && draw(c.current, img, shot.shapes), () => {});
	}, [shot]);
	return <canvas ref={c} className="size-16 object-cover" />;
}

function Annotator({ shot, onClose, onSave }: { shot: Shot | null; onClose: () => void; onSave: (s: Shape[]) => void }) {
	const c = useRef<HTMLCanvasElement>(null);
	const [img, setImg] = useState<HTMLImageElement | null>(null);
	const [shapes, setShapes] = useState<Shape[]>([]);
	const [tool, setTool] = useState<Shape["kind"]>("arrow");
	const [draft, setDraft] = useState<Shape | null>(null);
	useEffect(() => {
		if (!shot) return setImg(null);
		setShapes(shot.shapes);
		load(shot.url).then(setImg, () => {});
	}, [shot]);
	useEffect(() => {
		if (img && c.current) draw(c.current, img, draft ? [...shapes, draft] : shapes);
	}, [img, shapes, draft]);

	/** 手指 / 鼠标在 canvas 上的位置 → 原图像素 */
	const at = (e: React.PointerEvent): Pt => {
		const r = (c.current as HTMLCanvasElement).getBoundingClientRect();
		const nw = img?.naturalWidth ?? 1;
		const nh = img?.naturalHeight ?? 1;
		return [((e.clientX - r.left) / r.width) * nw, ((e.clientY - r.top) / r.height) * nh];
	};
	/** 原图的长边：判断「动了多少」按它的比例算 */
	const size = () => Math.max(img?.naturalWidth ?? 0, img?.naturalHeight ?? 0);
	const done = () => {
		onSave(shapes);
		onClose();
	};
	return (
		<Dialog open={!!shot} onOpenChange={(o) => !o && done()}>
			<DialogContent className="flex h-[100svh] max-w-none flex-col gap-3 rounded-none p-3 sm:h-[90svh] sm:max-w-4xl sm:rounded-xl" showCloseButton={false}>
				<DialogTitle className="sr-only">批注图片</DialogTitle>
				<DialogDescription className="sr-only">在图上拖动画箭头，或者随手画线</DialogDescription>
				<div className="flex items-center gap-1.5">
					<ToggleGroup type="single" variant="outline" size="sm" value={tool} onValueChange={(v) => v && setTool(v as Shape["kind"])}>
						<ToggleGroupItem value="arrow" aria-label="箭头" className="gap-1 px-2.5">
							<MoveUpRight className="size-4" />
							箭头
						</ToggleGroupItem>
						<ToggleGroupItem value="pen" aria-label="画笔" className="gap-1 px-2.5">
							<Pencil className="size-4" />
							画笔
						</ToggleGroupItem>
					</ToggleGroup>
					<Button variant="ghost" size="icon-sm" onClick={() => setShapes((s) => s.slice(0, -1))} disabled={!shapes.length} aria-label="撤销" title="撤销">
						<Undo2 className="size-4" />
					</Button>
					<Button variant="ghost" size="sm" onClick={() => setShapes([])} disabled={!shapes.length}>清空</Button>
					<Button size="sm" className="ml-auto" onClick={done}>完成</Button>
				</div>
				<div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg bg-muted/40">
					<canvas
						ref={c}
						className="max-h-full max-w-full touch-none select-none"
						onPointerDown={(e) => {
							e.currentTarget.setPointerCapture(e.pointerId);
							const p = at(e);
							setDraft(tool === "arrow" ? { kind: "arrow", a: p, b: p } : { kind: "pen", pts: [p] });
						}}
						onPointerMove={(e) => {
							if (!draft) return;
							const p = at(e);
							if (draft.kind === "arrow") return setDraft({ ...draft, b: p });
							// 离上一个点太近的不记，点少了曲线更顺
							const [lx, ly] = draft.pts[draft.pts.length - 1];
							if (Math.hypot(p[0] - lx, p[1] - ly) > size() / 400) setDraft({ ...draft, pts: [...draft.pts, p] });
						}}
						onPointerUp={() => {
							// 点一下没怎么拖动的不算（按原图大小的 1% 算，大图上手指抖一下也不会画出一个点）
							const ps = draft ? (draft.kind === "arrow" ? [draft.a, draft.b] : draft.pts) : [];
							const span = Math.max(0, ...ps.map((p) => Math.hypot(p[0] - ps[0][0], p[1] - ps[0][1])));
							if (draft && span > size() / 100) setShapes((s) => [...s, draft]);
							setDraft(null);
						}}
						onPointerCancel={() => setDraft(null)}
					/>
				</div>
			</DialogContent>
		</Dialog>
	);
}
