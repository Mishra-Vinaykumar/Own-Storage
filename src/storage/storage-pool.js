import { randomUUID } from "node:crypto";
import { Transform } from "node:stream";
import { LocalAccount } from "./local-account.js";
import { MegaAccount } from "./mega-account.js";

export class StoragePoolError extends Error {
  constructor(message, failures = []) {
    super(message);
    this.name = "StoragePoolError";
    this.failures = failures;
  }
}

function exactSizeStream(source, expectedSize) {
  let received = 0;
  const guard = new Transform({
    transform(chunk, encoding, callback) {
      received += chunk.length;
      if (received > expectedSize) return callback(new Error("Upload exceeded X-File-Size"));
      callback(null, chunk);
    },
    flush(callback) {
      callback(received === expectedSize
        ? undefined
        : new Error(`Upload size mismatch: expected ${expectedSize}, received ${received}`));
    },
  });
  const sourceError = (error) => guard.destroy(error);
  const sourceAborted = () => guard.destroy(new Error("Upload was interrupted"));
  const preventEarlyUnhandledError = () => {};
  guard.on("error", preventEarlyUnhandledError);
  source.once("error", sourceError);
  source.once("aborted", sourceAborted);
  source.pipe(guard);
  return {
    stream: guard,
    cleanup() {
      source.off("error", sourceError);
      source.off("aborted", sourceAborted);
      source.unpipe(guard);
      guard.off("error", preventEarlyUnhandledError);
    },
  };
}

export class StoragePool {
  #accounts;
  #strategy;
  #records;
  #cursor = 0;

  constructor({ accounts, strategy, records }) {
    this.#accounts = new Map(
      accounts.map((config) => [
        config.id,
        config.driver === "mega"
          ? new MegaAccount(config)
          : new LocalAccount(config),
      ]),
    );
    this.#strategy = strategy;
    this.#records = records;
  }

  accountCount() {
    return this.#accounts.size;
  }

  #orderedAccounts() {
    const accounts = [...this.#accounts.values()];
    if (this.#strategy === "round-robin") {
      const start = this.#cursor++ % accounts.length;
      return [...accounts.slice(start), ...accounts.slice(0, start)];
    }

    const used = new Map([...this.#accounts.keys()].map((id) => [id, 0]));
    for (const record of this.#records()) {
      if (used.has(record.storageAccount)) {
        used.set(
          record.storageAccount,
          used.get(record.storageAccount) + Number(record.size || 0),
        );
      }
    }
    return accounts.sort((a, b) => used.get(a.id) - used.get(b.id));
  }

  async put(buffer) {
    const failures = [];
    for (const account of this.#orderedAccounts()) {
      try {
        const remoteId = await account.put(randomUUID(), buffer);
        return { storageAccount: account.id, remoteId };
      } catch (error) {
        failures.push({ account: account.id, message: error.message });
      }
    }
    throw new StoragePoolError("Every storage account rejected the upload", failures);
  }

  async putStream(stream, size) {
    const failures = [];
    for (const account of this.#orderedAccounts()) {
      let usage;
      try {
        usage = await account.usage();
      } catch (error) {
        failures.push({ account: account.id, message: error.message });
        continue;
      }
      if (usage.total - usage.used < size) {
        failures.push({ account: account.id, message: "Not enough available space" });
        continue;
      }

      const guarded = exactSizeStream(stream, size);
      try {
        const remoteId = await account.putStream(randomUUID(), guarded.stream, size);
        return { storageAccount: account.id, remoteId };
      } catch (error) {
        failures.push({ account: account.id, message: error.message });
        break;
      } finally {
        guarded.cleanup();
      }
    }
    throw new StoragePoolError("Every storage account rejected the upload", failures);
  }

  #accountFor(record) {
    const account = this.#accounts.get(record.storageAccount);
    if (!account) {
      throw new StoragePoolError(
        `Storage account ${record.storageAccount} is not configured`,
      );
    }
    return account;
  }

  get(record) {
    return this.#accountFor(record).get(record.remoteId);
  }

  getStream(record) {
    return this.#accountFor(record).getStream(record.remoteId);
  }

  remove(record) {
    return this.#accountFor(record).remove(record.remoteId);
  }

  async usage() {
    const results = await Promise.allSettled(
      [...this.#accounts.values()].map((account) => account.usage()),
    );
    let used = 0;
    let total = 0;
    let availableAccounts = 0;
    for (const result of results) {
      if (result.status === "fulfilled") {
        used += result.value.used;
        total += result.value.total;
        availableAccounts += 1;
      }
    }
    if (!availableAccounts) {
      throw new StoragePoolError("No storage account is currently available");
    }
    return {
      used,
      total,
      accounts: this.#accounts.size,
      availableAccounts,
    };
  }
}
