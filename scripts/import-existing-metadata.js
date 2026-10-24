import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const environment = dotenv.parse(await fs.readFile(path.join(root, ".env")));
const driver = environment.STORAGE_DRIVER || "local";
const target = path.join(root, "data", "files.json");
const sources = [
  {
    account: "vinay",
    root: path.join(root, "..", "private-file-portal"),
  },
  {
    account: "ankita",
    root: path.join(root, "..", "private-file-portal2"),
  },
];

await fs.mkdir(path.dirname(target), { recursive: true });
let records = [];
try {
  records = JSON.parse(await fs.readFile(target, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const knownIds = new Set(records.map(({ id }) => id));
let imported = 0;
let skipped = 0;

for (const source of sources) {
  let sourceRecords = [];
  try {
    sourceRecords = JSON.parse(
      await fs.readFile(path.join(source.root, "data", "files.json"), "utf8"),
    );
  } catch (error) {
    if (error.code === "ENOENT") continue;
    throw error;
  }

  for (const record of sourceRecords) {
    if (knownIds.has(record.id)) continue;
    const sourceFile = path.join(source.root, "storage", record.remoteId);
    let isLocal = false;
    try {
      isLocal = (await fs.stat(sourceFile)).isFile();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    if ((driver === "local") !== isLocal) {
      skipped += 1;
      continue;
    }

    if (isLocal) {
      const destinationDirectory = path.join(root, "storage", source.account);
      await fs.mkdir(destinationDirectory, { recursive: true });
      await fs.copyFile(
        sourceFile,
        path.join(destinationDirectory, record.remoteId),
        fs.constants.COPYFILE_EXCL,
      );
    }

    records.push({ ...record, storageAccount: source.account });
    knownIds.add(record.id);
    imported += 1;
  }
}

const temporary = `${target}.tmp`;
await fs.writeFile(temporary, JSON.stringify(records, null, 2));
await fs.rename(temporary, target);
console.log(`Imported ${imported} compatible record(s); skipped ${skipped}.`);
if (skipped) {
  console.log(
    "Skipped records used a different driver (local versus MEGA) and were not moved automatically.",
  );
}
