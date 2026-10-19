// Start from a stable supervisor directory; resolve app resources at the project.
import { fileURLToPath } from "node:url";
process.chdir(fileURLToPath(new URL("../", import.meta.url)));
await import("./server.mjs");
