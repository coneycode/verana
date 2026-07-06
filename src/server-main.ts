import { resolve } from "node:path";
import { buildServer } from "./server.js";

const rootDir = resolve(process.env.VERANA_ROOT ?? process.cwd());
const port = Number(process.env.PORT ?? 3317);
const app = await buildServer({ rootDir });

// 兜底:未捕获异常不崩进程(删项目等操作可能触发 SSE 竞态)
process.on("unhandledRejection", (err) => { console.error("[unhandledRejection]", (err as Error)?.message ?? err); });
process.on("uncaughtException", (err) => { console.error("[uncaughtException]", (err as Error)?.message ?? err); });

await app.listen({ host: "127.0.0.1", port });
console.log(`verana server listening on http://127.0.0.1:${port}`);
console.log(`root: ${rootDir}`);
