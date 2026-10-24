import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./src/config.js";
import { RecordStore } from "./src/record-store.js";
import { UserStore } from "./src/user-store.js";
import { StoragePool } from "./src/storage/storage-pool.js";
import { createApp } from "./src/app.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const config = loadConfig(process.env, root);
const store = new RecordStore(config.metadataFile);
const folderStore = new RecordStore(config.folderMetadataFile);
const userStore = new UserStore(config.userMetadataFile);
await store.init();
await folderStore.init();
await userStore.init({ admin: config.admin, demoUsers: config.users });
const pool = new StoragePool({
  accounts: config.accounts,
  strategy: config.strategy,
  records: () => store.all(),
});
const app = createApp({ config, store, folderStore, userStore, pool });

const server = app.listen(config.port, () => {
  console.log(
    `Private Storage API listening at http://localhost:${config.port} ` +
      `[${config.driver}, ${config.accounts.length} accounts, ${config.strategy}]`,
  );
});
server.requestTimeout = config.uploadTimeout;
