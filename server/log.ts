// 日志：一行一条，前面带时间（launchd 的日志在 ~/Library/Logs/mixer.log）
export const say = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

/** 带 HTTP 状态码的错：接口里抛出去，main.ts 照 status 回（没有 status 的算 500、记日志） */
export const httpError = (status: number, msg: string) => Object.assign(new Error(msg), { status });
