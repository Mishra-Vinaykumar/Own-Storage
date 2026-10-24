import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { StoragePool, StoragePoolError } from "../src/storage/storage-pool.js";

test("least-used strategy balances files and records their account", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "storage-pool-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const records = [];
  const accounts = ["vinay", "ankita"].map((id) => ({
    id,
    driver: "local",
    directory: path.join(root, id),
    capacityBytes: 1000,
  }));
  const pool = new StoragePool({
    accounts,
    strategy: "least-used",
    records: () => records,
  });

  const first = await pool.put(Buffer.from("12345"));
  records.push({ ...first, size: 5 });
  const second = await pool.put(Buffer.from("123"));
  records.push({ ...second, size: 3 });
  const third = await pool.put(Buffer.from("1"));

  assert.equal(first.storageAccount, "vinay");
  assert.equal(second.storageAccount, "ankita");
  assert.equal(third.storageAccount, "ankita");
  assert.deepEqual(await pool.get(first), Buffer.from("12345"));
  await pool.remove(first);
  await assert.rejects(pool.get(first), { code: "ENOENT" });
});

test("streaming storage rejects a body that does not match its declared size", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "storage-stream-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "vinay");
  const pool = new StoragePool({
    accounts: [{ id: "vinay", driver: "local", directory, capacityBytes: 1000 }],
    strategy: "least-used",
    records: () => [],
  });

  await assert.rejects(pool.putStream(Readable.from([Buffer.from("short")]), 10), StoragePoolError);
  assert.deepEqual(await fs.readdir(directory), []);
});
