// Temporary entry point so you can test the scan tool by hand.
// Usage:
//   npm run scan -- ~/Library            (pretty table)
//   npm run scan -- ~/Library 20         (top 20 items)
//   npm run scan -- ~/Library 10 --json  (exactly what the model will see)

import { scan } from "./tools/scan";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const [path = "~", topArg = "10"] = args.filter((a) => a !== "--json");

try {
  const result = await scan(path, Number(topArg));

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\n${result.root}  (total: ${result.total})\n`);
    for (const item of result.items) {
      const icon = item.type === "dir" ? "📁" : "📄";
      console.log(`${item.size.padStart(10)}  ${icon} ${item.name}`);
    }
    if (result.hidden > 0) console.log(`\n…and ${result.hidden} smaller items`);
    if (result.unreadable > 0) {
      console.log(`\n⚠️  ${result.unreadable} paths couldn't be read (permissions).`);
    }
    console.log();
  }
} catch (err) {
  console.error(`Scan failed: ${(err as Error).message}`);
  process.exit(1);
}
