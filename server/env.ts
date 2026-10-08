// 环境变量定的东西：数据放哪、听哪个端口。测试、另起一个实例时靠它们指到别处
import { dirname, join } from "node:path";

/** mixer 自己的数据（access.json、state.json、push.json）放哪：MIXER_DATA，默认仓库里的 data/（测试、另起一个实例时指到临时目录） */
export const DATA = process.env.MIXER_DATA || join(dirname(new URL(import.meta.url).pathname), "..", "data");
/** 服务的端口：MIXER_PORT，默认 4848 */
export const PORT = Number(process.env.MIXER_PORT ?? 4848);
