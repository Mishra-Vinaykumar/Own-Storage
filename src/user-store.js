import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);

export class UserStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "UserStoreError";
    this.code = code;
  }
}

function normalizeUsername(username) {
  return String(username || "").trim().toLowerCase();
}

function validateUsername(username) {
  return /^[a-z0-9][a-z0-9_.-]{2,31}$/.test(username);
}

async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = await scryptAsync(password, salt, 64);
  return `scrypt:${salt}:${Buffer.from(hash).toString("hex")}`;
}

async function verifyPassword(password, encoded) {
  const [algorithm, salt, expectedHex] = String(encoded || "").split(":");
  if (algorithm !== "scrypt" || !salt || !expectedHex) return false;
  const expected = Buffer.from(expectedHex, "hex");
  const actual = Buffer.from(await scryptAsync(password, salt, expected.length));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function publicUser(user) {
  const { passwordHash, ...safe } = user;
  return safe;
}

export class UserStore {
  #file;
  #users = [];
  #queue = Promise.resolve();

  constructor(file) {
    this.#file = file;
  }

  async init({ admin, demoUsers = new Map() }) {
    await fs.mkdir(path.dirname(this.#file), { recursive: true });
    try {
      const value = JSON.parse(await fs.readFile(this.#file, "utf8"));
      if (!Array.isArray(value)) throw new Error("Users metadata must be an array");
      this.#users = value;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    const seeds = [
      {
        username: normalizeUsername(admin.username),
        password: admin.password,
        role: "admin",
      },
      ...[...demoUsers.entries()].map(([username, password]) => ({
        username: normalizeUsername(username),
        password,
        role: "user",
      })),
    ];

    for (const seed of seeds) {
      const existing = this.#users.find((user) => user.username === seed.username);
      if (!existing) {
        await this.#add({
          username: seed.username,
          passwordHash: await hashPassword(seed.password),
          role: seed.role,
          status: "approved",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      } else if (
        seed.role === "admin" &&
        (existing.role !== "admin" ||
          existing.status !== "approved" ||
          !(await verifyPassword(seed.password, existing.passwordHash)))
      ) {
        const passwordHash = await hashPassword(seed.password);
        await this.#mutate((users) => {
          const user = users.find((item) => item.username === seed.username);
          user.passwordHash = passwordHash;
          user.role = "admin";
          user.status = "approved";
          user.updatedAt = new Date().toISOString();
        });
      }
    }
  }

  find(username) {
    const normalized = normalizeUsername(username);
    const user = this.#users.find((item) => item.username === normalized);
    return user ? publicUser(user) : undefined;
  }

  list() {
    return this.#users.map(publicUser);
  }

  async authenticate(username, password) {
    const normalized = normalizeUsername(username);
    const user = this.#users.find((item) => item.username === normalized);
    if (!user || !(await verifyPassword(password, user.passwordHash))) return null;
    return publicUser(user);
  }

  async register(username, password) {
    const normalized = normalizeUsername(username);
    if (!validateUsername(normalized)) {
      throw new UserStoreError(
        "INVALID_USERNAME",
        "Username must be 3-32 characters using letters, numbers, dot, dash or underscore",
      );
    }
    if (typeof password !== "string" || password.length < 8 || password.length > 128) {
      throw new UserStoreError(
        "INVALID_PASSWORD",
        "Password must contain between 8 and 128 characters",
      );
    }
    if (this.#users.some((user) => user.username === normalized)) {
      throw new UserStoreError("USERNAME_EXISTS", "That username is already registered");
    }
    const now = new Date().toISOString();
    const user = {
      username: normalized,
      passwordHash: await hashPassword(password),
      role: "user",
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    await this.#add(user);
    return publicUser(user);
  }

  async setStatus(username, status) {
    if (!new Set(["pending", "approved", "blocked"]).has(status)) {
      throw new UserStoreError("INVALID_STATUS", "Invalid account status");
    }
    const normalized = normalizeUsername(username);
    const existing = this.#users.find((user) => user.username === normalized);
    if (!existing) throw new UserStoreError("NOT_FOUND", "User not found");
    if (existing.role === "admin") {
      throw new UserStoreError("ADMIN_PROTECTED", "The administrator cannot be blocked");
    }
    await this.#mutate((users) => {
      const user = users.find((item) => item.username === normalized);
      user.status = status;
      user.updatedAt = new Date().toISOString();
    });
    return this.find(normalized);
  }

  #add(user) {
    return this.#mutate((users) => users.push(user));
  }

  #mutate(change) {
    const task = this.#queue.then(async () => {
      const copy = structuredClone(this.#users);
      const result = await change(copy);
      const temporary = `${this.#file}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(copy, null, 2));
      await fs.rename(temporary, this.#file);
      this.#users = copy;
      return result;
    });
    this.#queue = task.catch(() => {});
    return task;
  }
}
