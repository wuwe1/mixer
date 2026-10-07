// 能选的模型长什么样：服务端（server/models.ts）和网页共用，不引别的文件

/**
 * 能选的一个模型（服务端给的，第一项是默认，id ""）。resolved：现在实际是哪个型号；efforts：支持的思考强度；
 * latest：别名，出了新版自动跟上；isNew：7 天内第一次见到
 */
export type ModelInfo = { id: string; label: string; resolved: string | null; efforts: string[]; latest: boolean; isNew: boolean };

/** 思考强度的叫法；认不出的照原样 */
const EFFORTS: Record<string, string> = { none: "不思考", minimal: "最少", low: "低", medium: "中", high: "高", xhigh: "很高", max: "最高", ultra: "极限" };
export const effortLabel = (e: string) => EFFORTS[e] ?? e;
