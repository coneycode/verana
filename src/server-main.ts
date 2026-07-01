import { resolve } from "node:path";

import { buildServer } from "./server.js";

const rootDir = resolve(process.env.VERANA_ROOT ?? process.cwd());
const port = Number(process.env.PORT ?? 3317);
const app = await buildServer({ rootDir });

await app.listen({ host: "127.0.0.1", port });
console.log(`verana server listening on http://127.0.0.1:${port}`);
console.log(`root: ${rootDir}`);
