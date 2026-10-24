import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const target = path.join(root, ".env");
const sources = [
  {
    id: "vinay",
    file: path.join(root, "..", "private-file-portal", ".env"),
  },
  {
    id: "ankita",
    file: path.join(root, "..", "private-file-portal2", ".env"),
  },
];

try {
  await fs.access(target);
  throw new Error(".env already exists; refusing to overwrite it");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const existing = [];
for (const source of sources) {
  existing.push({
    ...source,
    values: dotenv.parse(await fs.readFile(source.file)),
  });
}

for (const source of existing) {
  if (!source.values.MEGA_EMAIL || !source.values.MEGA_PASSWORD) {
    throw new Error(`Missing MEGA credentials in ${source.file}`);
  }
}

const quote = (value) => JSON.stringify(String(value ?? ""));
const first = existing[0].values;
const lines = [
  `PORT=${quote(first.PORT || 3000)}`,
  "STORAGE_DRIVER=mega",
  `STORAGE_ACCOUNTS=${existing.map(({ id }) => id).join(",")}`,
  "STORAGE_STRATEGY=least-used",
  `SESSION_SECRET=${quote(first.SESSION_SECRET)}`,
  `DEMO_USERS=${quote(first.DEMO_USERS || "")}`,
  `API_KEYS=${quote(`default:${randomBytes(32).toString("hex")}`)}`,
  "TRUST_PROXY=false",
  "MAX_FILE_SIZE_MB=10",
];

for (const source of existing) {
  const prefix = source.id.toUpperCase();
  lines.push(
    `MEGA_${prefix}_EMAIL=${quote(source.values.MEGA_EMAIL)}`,
    `MEGA_${prefix}_PASSWORD=${quote(source.values.MEGA_PASSWORD)}`,
    `MEGA_${prefix}_FOLDER=${quote(source.values.MEGA_FOLDER || "Private-Storage-API")}`,
  );
}

await fs.writeFile(target, `${lines.join("\n")}\n`, { flag: "wx" });
console.log("Created private-storage-api/.env from both existing portals.");
console.log("A new API key was generated under API_KEYS; keep this file private.");
