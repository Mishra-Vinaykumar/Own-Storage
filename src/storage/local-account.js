import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

export class LocalAccount {
  constructor(config) {
    this.id = config.id;
    this.directory = config.directory;
    this.capacityBytes = config.capacityBytes;
  }

  async init() {
    await fsp.mkdir(this.directory, { recursive: true });
  }

  async put(remoteId, buffer) {
    await this.init();
    await fsp.writeFile(path.join(this.directory, remoteId), buffer, {
      flag: "wx",
    });
    return remoteId;
  }

  async putStream(remoteId, stream) {
    await this.init();
    const destination = path.join(this.directory, remoteId);
    try {
      await pipeline(stream, fs.createWriteStream(destination, { flags: "wx" }));
      return remoteId;
    } catch (error) {
      await fsp.rm(destination, { force: true }).catch(() => {});
      throw error;
    }
  }

  async get(remoteId) {
    return fsp.readFile(path.join(this.directory, remoteId));
  }

  async getStream(remoteId) {
    await fsp.access(path.join(this.directory, remoteId));
    return fs.createReadStream(path.join(this.directory, remoteId));
  }

  async remove(remoteId) {
    await fsp.unlink(path.join(this.directory, remoteId));
  }

  async usage() {
    await this.init();
    let used = 0;
    for (const name of await fsp.readdir(this.directory)) {
      try {
        const stats = await fsp.stat(path.join(this.directory, name));
        if (stats.isFile()) used += stats.size;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    return { used, total: this.capacityBytes };
  }
}
