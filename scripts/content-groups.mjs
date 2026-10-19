import { Tasks } from "../app/tasks.mjs";
import { ContentGroups } from "../app/content-groups.mjs";
const db = new Tasks(),
  groups = new ContentGroups(db);
try {
  const [action, ...args] = process.argv.slice(2);
  if (action === "list") console.log(JSON.stringify(groups.list(), null, 2));
  else if (action === "set") {
    const i = args.indexOf("--reason");
    if (i < 0 || !args[i + 1])
      throw Error(
        'Usage: content-groups.mjs set --reason "用户确认依据" ID1 ID2',
      );
    const reason = args[i + 1];
    args.splice(i, 2);
    console.log(JSON.stringify(groups.set(args, reason), null, 2));
  } else
    throw Error(
      'Usage: content-groups.mjs list | set --reason "用户确认依据" ID1 ID2',
    );
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  db.close();
}
