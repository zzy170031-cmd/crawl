import { readFile } from "node:fs/promises";
import { Tasks } from "../app/tasks.mjs";
import { SideBridge } from "../app/side-bridge.mjs";
const db = new Tasks(),
  bridge = new SideBridge(db);
try {
  const [action, id, path] = process.argv.slice(2);
  if (action === "pending")
    console.log(JSON.stringify(bridge.status(), null, 2));
  else if (action === "begin-delivery" && id)
    console.log(JSON.stringify(bridge.beginDelivery(id), null, 2));
  else if (action === "get" && id)
    console.log(JSON.stringify(bridge.public(bridge.get(id)), null, 2));
  else if (action === "reconcile-delivery" && id && path)
    console.log(
      JSON.stringify(
        bridge.reconcileDelivery(id, JSON.parse(await readFile(path, "utf8"))),
        null,
        2,
      ),
    );
  else if (action === "fulfill" && id && path)
    console.log(
      JSON.stringify(
        bridge.public(
          bridge.fulfill(id, JSON.parse(await readFile(path, "utf8"))),
        ),
        null,
        2,
      ),
    );
  else
    throw Error(
      "Usage: bridge.mjs pending | get ID | begin-delivery ID | fulfill ID result.json | reconcile-delivery ID receipt.json",
    );
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  db.close();
}
