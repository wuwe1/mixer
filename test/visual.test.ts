// visual.ts：```ui 图解的解析（含正在写的半截）、逐个组件的校验、给 Claude 的说明
import assert from "node:assert/strict";
import { test } from "node:test";
import { check, checkNode, docs, KINDS, parse, prompt } from "../web/src/lib/visual.ts";

test("完整的 JSON 照常读，done", () => {
	assert.deepEqual(parse(' { "type": "Text", "text": "a" }\n'), { value: { type: "Text", text: "a" }, done: true });
});

test("半截的：没写完的字符串照已有的算，没写完的键、数字、true 丢掉，括号补上", () => {
	assert.deepEqual(parse('{ "type": "Steps", "items": [{ "title": "第一'), { value: { type: "Steps", items: [{ title: "第一" }] }, done: false });
	assert.deepEqual(parse('{ "type": "Stat", "label": "x", "val'), { value: { type: "Stat", label: "x" }, done: false });
	assert.deepEqual(parse('{ "a": 12'), { value: {}, done: false });
	assert.deepEqual(parse('{ "a": 12,'), { value: { a: 12 }, done: false });
	assert.deepEqual(parse('{ "a": tr'), { value: {}, done: false });
	assert.deepEqual(parse('[{ "a": 1 }, { "b": "x\\"y\\n'), { value: [{ a: 1 }, { b: 'x"y\n' }], done: false });
	assert.deepEqual(parse('{ "a": "\\u4e2'), { value: { a: "" }, done: false });
	assert.deepEqual(parse(""), { value: null, done: false });
});

test("逐个组件校验：坏的写明哪里不对，不认识的类型给个最像的", () => {
	assert.equal(checkNode({ type: "Graph", nodes: [{ id: "a", label: "A" }] }).ok, true);
	const bad = checkNode({ type: "Graph", nodes: [{ id: "a" }] });
	assert.equal(bad.ok, false);
	assert.match(!bad.ok ? bad.issues.join() : "", /nodes\.0\.label/);
	const typo = checkNode({ type: "graph", nodes: [] });
	assert.deepEqual(!typo.ok && typo.issues, ["没有 graph 这种组件，是不是 Graph"]);
	assert.equal(checkNode("x").ok, false);
	// Tree 的 root 是递归的，单独校验
	assert.equal(checkNode({ type: "Tree", root: { label: "a", children: [{ label: "b" }] } }).ok, true);
	assert.equal(checkNode({ type: "Tree", root: { label: "a", children: [{ note: "b" }] } }).ok, false);
});

test("整段校验往子组件里走，带路径", () => {
	const issues = check([
		{ type: "Callout", text: "ok" },
		{ type: "Tabs", tabs: [{ label: "甲", children: [{ type: "Text" }] }] },
	]);
	assert.equal(issues.length, 1);
	assert.match(issues[0], /^\[1\]\.tabs\.0\.children\[0\] Text: text/);
});

test("说明里有每一种组件，例子本身能过校验", () => {
	const p = prompt();
	for (const k of KINDS) assert.match(docs(), new RegExp(`^- ${k} \\{`, "m"));
	const example = /```ui\n([\s\S]*?)\n```/.exec(p)?.[1] ?? "";
	const { value, done } = parse(example);
	assert.equal(done, true);
	assert.deepEqual(check(value), []);
});
