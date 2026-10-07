/** cmdk 的 filter：按子串筛（开头对上的排前面），不用它默认的模糊匹配：打 repos 不该匹配到别的。新会话的文件夹、浏览会话、选 skill 都用它 */
export const match = (value: string, search: string) => {
	const v = value.toLowerCase();
	const q = search.toLowerCase().trim();
	return v.startsWith(q) ? 1 : v.includes(q) ? 0.5 : 0;
};
