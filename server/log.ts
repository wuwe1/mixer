// 日志：一行一条，前面带时间（launchd 的日志在 ~/Library/Logs/mixer.log）
export const say = (m: string) => console.log(`${new Date().toISOString()} ${m}`);
