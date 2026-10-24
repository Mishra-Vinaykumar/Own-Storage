import { Storage } from "megajs";
import { pipeline } from "node:stream/promises";

export class MegaAccount {
  #config;
  #storagePromise;
  #folderPromise;

  constructor(config) {
    this.id = config.id;
    this.#config = config;
  }

  async #storage() {
    if (!this.#storagePromise) {
      this.#storagePromise = new Storage({
        email: this.#config.email,
        password: this.#config.password,
        keepalive: true,
      }).ready.catch((error) => {
        this.#storagePromise = undefined;
        throw error;
      });
    }
    return this.#storagePromise;
  }

  async #folder() {
    if (!this.#folderPromise) {
      this.#folderPromise = this.#storage()
        .then(
          (storage) =>
            storage.root.children.find(
              (item) =>
                item.directory && item.name === this.#config.folder,
            ) || storage.root.mkdir(this.#config.folder),
        )
        .catch((error) => {
          this.#folderPromise = undefined;
          throw error;
        });
    }
    return this.#folderPromise;
  }

  async put(remoteId, buffer) {
    const folder = await this.#folder();
    const uploaded = await folder.upload(
      { name: remoteId, size: buffer.length },
      buffer,
    ).complete;
    return uploaded.nodeId;
  }

  async putStream(remoteId, stream, size) {
    const folder = await this.#folder();
    const upload = folder.upload({ name: remoteId, size });
    const [, uploaded] = await Promise.all([
      pipeline(stream, upload),
      upload.complete,
    ]);
    return uploaded.nodeId;
  }

  async get(remoteId) {
    const storage = await this.#storage();
    const file = storage.files[remoteId];
    if (!file || file.directory) throw new Error("Remote file not found");
    return file.downloadBuffer();
  }

  async getStream(remoteId) {
    const storage = await this.#storage();
    const file = storage.files[remoteId];
    if (!file || file.directory) throw new Error("Remote file not found");
    return file.download();
  }

  async remove(remoteId) {
    const storage = await this.#storage();
    const file = storage.files[remoteId];
    if (!file || file.directory) throw new Error("Remote file not found");
    await file.delete(true);
  }

  async usage() {
    const storage = await this.#storage();
    const account = await storage.getAccountInfo();
    return {
      used: Number(account.spaceUsed || 0),
      total: Number(account.spaceTotal || 0),
    };
  }
}
