// repo.ts 的 inside()：路径只许在仓库里面
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inside } from "../server/repo.ts";

// macOS 的临时目录本身就经过软链接（/var → /private/var），仓库路径不一定是真实路径
const tmp = mkdtempSync(join(tmpdir(), "mixer-repo-"));
const root = join(tmp, "repo");
const outside = join(tmp, "outside");
mkdirSync(join(root, "src"), { recursive: true });
mkdirSync(outside);
writeFileSync(join(root, "src", "a.ts"), "");
writeFileSync(join(outside, "secret"), "");
symlinkSync(outside, join(root, "out"));
symlinkSync(join(outside, "secret"), join(root, "secret"));
symlinkSync(join(root, "src", "a.ts"), join(root, "alias.ts"));
symlinkSync(root, join(tmp, "link-to-repo"));

const denied = (r: string, rel: string) => assert.throws(() => inside(r, rel), (e: Error & { status?: number }) => e.status === 403, rel);

test("仓库里的路径：原样给回来", () => {
	assert.equal(inside(root, "src/a.ts"), join(root, "src", "a.ts"));
	assert.equal(inside(root, "./src/../src/a.ts"), join(root, "src", "a.ts"));
	assert.equal(inside(root, ""), root);
	// 软链接指向仓库里面的：可以
	assert.equal(inside(root, "alias.ts"), join(root, "alias.ts"));
});

test("../ 跑出去：拒绝", () => {
	denied(root, "../outside/secret");
	denied(root, "src/../../outside");
	denied(root, "..");
	denied(root, "/etc/passwd/../../..");
});

test("软链接跑出去：拒绝", () => {
	denied(root, "secret");
	denied(root, "out");
	denied(root, "out/secret");
});

test("还不存在的文件（比如删掉了的，看它的改动）：在仓库里就行", () => {
	assert.equal(inside(root, "src/gone.ts"), join(root, "src", "gone.ts"));
	assert.equal(inside(root, "new/dir/file.ts"), join(root, "new", "dir", "file.ts"));
	denied(root, "../gone");
	// 经过跑出去的软链接，后面的文件不存在：也拒绝
	denied(root, "out/gone");
});

test("仓库路径本身经过软链接：一样认", () => {
	const r = join(tmp, "link-to-repo");
	assert.equal(inside(r, "src/a.ts"), join(r, "src", "a.ts"));
	assert.equal(inside(r, "src/gone.ts"), join(r, "src", "gone.ts"));
	denied(r, "out/secret");
	denied(r, "../outside/secret");
});

test("不是 git 仓库的文件列表：读不了的文件夹跳过（不整个出错），隐藏的文件夹、node_modules 不走，隐藏的文件照列", async () => {
	const { files } = await import("../server/repo.ts");
	const plain = join(tmp, "plain");
	mkdirSync(join(plain, "a"), { recursive: true });
	mkdirSync(join(plain, ".cache"));
	mkdirSync(join(plain, "node_modules"));
	mkdirSync(join(plain, "locked"));
	writeFileSync(join(plain, "a", "x.txt"), "");
	writeFileSync(join(plain, ".env"), "");
	writeFileSync(join(plain, ".cache", "c"), "");
	writeFileSync(join(plain, "node_modules", "m.js"), "");
	writeFileSync(join(plain, "locked", "l.txt"), "");
	chmodSync(join(plain, "locked"), 0o000);
	try {
		assert.deepEqual(await files(plain), [".env", "a/x.txt"]);
	} finally {
		chmodSync(join(plain, "locked"), 0o755);
	}
});
