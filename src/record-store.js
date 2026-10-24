import fs from "node:fs/promises";
import path from "node:path";

export class RecordStore {
  #file;
  #records = [];
  #queue = Promise.resolve();

  constructor(file) {
    this.#file = file;
  }

  async init() {
    await fs.mkdir(path.dirname(this.#file), { recursive: true });
    try {
      const value = JSON.parse(await fs.readFile(this.#file, "utf8"));
      if (!Array.isArray(value)) throw new Error("Metadata must be an array");
      this.#records = value;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  all() {
    return this.#records;
  }

  find(id, owner) {
    return this.#records.find(
      (record) => record.id === id && record.owner === owner,
    );
  }

  async add(record) {
    return this.#mutate((records) => records.push(record));
  }

  async delete(id) {
    return this.#mutate((records) => {
      const index = records.findIndex((record) => record.id === id);
      if (index >= 0) records.splice(index, 1);
    });
  }

  #mutate(change) {
    const task = this.#queue.then(async () => {
      const copy = structuredClone(this.#records);
      const result = await change(copy);
      const temporary = `${this.#file}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(copy, null, 2));
      await fs.rename(temporary, this.#file);
      this.#records = copy;
      return result;
    });
    this.#queue = task.catch(() => {});
    return task;
  }
}
