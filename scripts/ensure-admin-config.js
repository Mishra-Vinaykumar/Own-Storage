import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const file = path.join(root, ".env");
let contents = await fs.readFile(file, "utf8");
const additions = [];
if (!/^ADMIN_USERNAME=/m.test(contents)) additions.push("ADMIN_USERNAME=admin");
if (!/^ADMIN_PASSWORD=/m.test(contents)) additions.push('ADMIN_PASSWORD="ChangeAdmin123!"');
if (additions.length) {
  if (!contents.endsWith("\n")) contents += "\n";
  await fs.writeFile(file, `${contents}${additions.join("\n")}\n`);
  console.log("Added administrator settings to .env.");
} else {
  console.log("Administrator settings already exist; no changes made.");
}
