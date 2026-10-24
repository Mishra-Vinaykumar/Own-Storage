import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { loadConfig } from "../src/config.js";
import { RecordStore } from "../src/record-store.js";
import { UserStore } from "../src/user-store.js";
import { StoragePool } from "../src/storage/storage-pool.js";
import { createApp } from "../src/app.js";

async function testService(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "private-api-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = loadConfig({
    STORAGE_DRIVER: "local",
    STORAGE_ACCOUNTS: "vinay,ankita",
    STORAGE_STRATEGY: "least-used",
    SESSION_SECRET: "a-test-secret-that-is-at-least-32-characters",
    API_KEYS: "client-one:test-key-one;client-two:test-key-two",
    LOCAL_ACCOUNT_CAPACITY_GB: "1",
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: "test-admin-password",
  }, root);
  const store = new RecordStore(config.metadataFile);
  const folderStore = new RecordStore(config.folderMetadataFile);
  const userStore = new UserStore(config.userMetadataFile);
  await Promise.all([store.init(), folderStore.init()]);
  await userStore.init({ admin: config.admin, demoUsers: config.users });
  const pool = new StoragePool({
    accounts: config.accounts,
    strategy: config.strategy,
    records: () => store.all(),
  });
  const server = createApp({ config, store, folderStore, userStore, pool }).listen(0);
  await once(server, "listening");
  t.after(() => server.close());
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    store,
    folderStore,
  };
}

function cookie(response) {
  return response.headers.get("set-cookie")?.split(";")[0];
}

test("Bearer clients can use one API across the storage pool", async (t) => {
  const { base, store } = await testService(t);
  const headers = { Authorization: "Bearer test-key-one" };

  for (const [name, contents] of [["one.txt", "12345"], ["two.txt", "123"]]) {
    const response = await fetch(`${base}/api/files`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "text/plain",
        "X-File-Name": encodeURIComponent(name),
        "X-File-Size": String(Buffer.byteLength(contents)),
      },
      body: contents,
    });
    assert.equal(response.status, 201);
  }

  assert.deepEqual(store.all().map(({ storageAccount }) => storageAccount), ["vinay", "ankita"]);
  const listed = await fetch(`${base}/api/files`, { headers });
  const files = await listed.json();
  assert.equal(files.length, 2);

  const downloaded = await fetch(`${base}/api/files/${files[1].id}/content`, { headers });
  assert.equal(await downloaded.text(), "12345");
  const forbidden = await fetch(`${base}/api/files/${files[1].id}/content`, {
    headers: { Authorization: "Bearer test-key-two" },
  });
  assert.equal(forbidden.status, 404);
  const removed = await fetch(`${base}/api/files/${files[1].id}`, { method: "DELETE", headers });
  assert.equal(removed.status, 200);
  assert.equal(store.all().length, 1);
});

test("streaming uploads enforce the configured 4.5 GB limit before reading the body", async (t) => {
  const { base } = await testService(t);
  const response = await fetch(`${base}/api/files`, {
    method: "POST",
    headers: {
      Authorization: "Bearer test-key-one",
      "Content-Type": "application/pdf",
      "X-File-Name": "large.pdf",
      "X-File-Size": String(4608 * 1024 * 1024 + 1),
    },
    body: "x",
  });
  assert.equal(response.status, 413);
  assert.match((await response.json()).error, /4\.5 GB/);
});

test("admin approval, blocking and folder access are enforced immediately", async (t) => {
  const { base, folderStore } = await testService(t);
  const json = { "Content-Type": "application/json" };

  const registration = await fetch(`${base}/api/register`, {
    method: "POST", headers: json,
    body: JSON.stringify({ username: "new-user", password: "secure-password" }),
  });
  assert.equal(registration.status, 201);
  assert.equal((await registration.json()).status, "pending");

  const pendingLogin = await fetch(`${base}/api/login`, {
    method: "POST", headers: json,
    body: JSON.stringify({ username: "new-user", password: "secure-password" }),
  });
  assert.equal(pendingLogin.status, 403);

  const adminLogin = await fetch(`${base}/api/login`, {
    method: "POST", headers: json,
    body: JSON.stringify({ username: "admin", password: "test-admin-password" }),
  });
  assert.equal(adminLogin.status, 200);
  const adminCookie = cookie(adminLogin);
  const approve = await fetch(`${base}/api/admin/users/new-user`, {
    method: "PATCH", headers: { ...json, Cookie: adminCookie },
    body: JSON.stringify({ status: "approved" }),
  });
  assert.equal(approve.status, 200);

  const userLogin = await fetch(`${base}/api/login`, {
    method: "POST", headers: json,
    body: JSON.stringify({ username: "new-user", password: "secure-password" }),
  });
  assert.equal(userLogin.status, 200);
  const userCookie = cookie(userLogin);
  const folder = await fetch(`${base}/api/folders`, {
    method: "POST", headers: { ...json, Cookie: userCookie },
    body: JSON.stringify({ name: "Projects", parentId: null }),
  });
  assert.equal(folder.status, 201);
  assert.equal(folderStore.all().length, 1);

  const block = await fetch(`${base}/api/admin/users/new-user`, {
    method: "PATCH", headers: { ...json, Cookie: adminCookie },
    body: JSON.stringify({ status: "blocked" }),
  });
  assert.equal(block.status, 200);
  const blockedRequest = await fetch(`${base}/api/files`, { headers: { Cookie: userCookie } });
  assert.equal(blockedRequest.status, 403);

  const unblock = await fetch(`${base}/api/admin/users/new-user`, {
    method: "PATCH", headers: { ...json, Cookie: adminCookie },
    body: JSON.stringify({ status: "approved" }),
  });
  assert.equal(unblock.status, 200);
  const restored = await fetch(`${base}/api/folders`, { headers: { Cookie: userCookie } });
  assert.equal(restored.status, 200);
  assert.equal((await restored.json()).length, 1);
});
