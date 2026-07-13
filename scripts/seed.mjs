import path from "node:path";
import { fileURLToPath } from "node:url";
import { MathHiveStore } from "../server/store.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const store = await new MathHiveStore({ rootDir }).init();
const data = await store.reset();

console.log(`Seeded ${data.spaces.length} spaces, ${data.results.length} results, and ${data.edges.length} graph edges.`);
