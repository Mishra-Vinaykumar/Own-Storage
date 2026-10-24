import { timingSafeEqual, randomUUID } from "node:crypto";
import path from "node:path";
import express from "express";
import helmet from "helmet";
import session from "express-session";
import rateLimit from "express-rate-limit";
import { pipeline } from "node:stream/promises";
import { StoragePoolError } from "./storage/storage-pool.js";
import { UserStoreError } from "./user-store.js";

const ALLOWED_EXTENSIONS = new Set([
  ".pdf", ".png", ".jpg", ".jpeg", ".txt", ".doc", ".docx", ".xlsx", ".csv",
]);

function equal(left, right) {
  const first = Buffer.from(String(left || ""));
  const second = Buffer.from(String(right || ""));
  return first.length === second.length && timingSafeEqual(first, second);
}

function apiOwner(req, apiKeys) {
  const authorization = req.get("authorization") || "";
  if (!authorization.startsWith("Bearer ")) return undefined;
  const candidate = authorization.slice(7);
  return apiKeys.find(({ key }) => equal(candidate, key))?.owner;
}

function requestedFolder(value) {
  const folderId = String(value || "").trim();
  return folderId || null;
}

function safeFolderName(value) {
  const name = String(value || "").trim();
  if (!name || name.length > 80 || /[\\/\0]/.test(name)) return null;
  return name;
}

function safeUploadName(value) {
  let decoded;
  try { decoded = decodeURIComponent(String(value || "")); }
  catch { return null; }
  const name = path.basename(decoded).trim().slice(0, 160);
  if (!name || !ALLOWED_EXTENSIONS.has(path.extname(name).toLowerCase())) return null;
  return name;
}

function uploadSize(value) {
  const size = Number(value);
  return Number.isSafeInteger(size) && size > 0 ? size : null;
}

export function createApp({ config, store, folderStore, userStore, pool }) {
  const app = express();
  if (config.trustProxy) app.set("trust proxy", 1);

  app.use(helmet({
    contentSecurityPolicy: { directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"],
      imgSrc: ["'self'", "data:"], connectSrc: ["'self'"],
      objectSrc: ["'none'"], frameAncestors: ["'none'"],
    } },
  }));
  app.use(express.json({ limit: "20kb" }));
  app.use(session({
    name: "storage.sid", secret: config.sessionSecret, resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax", secure: config.trustProxy, maxAge: 8 * 60 * 60 * 1000 },
  }));
  app.use(express.static(path.join(config.root, "public")));

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: "draft-7", legacyHeaders: false,
  });
  const uploadLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, limit: 100, standardHeaders: "draft-7", legacyHeaders: false,
  });

  const identify = (req, res, next) => {
    const keyOwner = apiOwner(req, config.apiKeys);
    if (keyOwner) {
      req.owner = keyOwner;
      req.authRole = "api";
      return next();
    }
    if (!req.session.user) {
      return res.status(401).json({ error: "Sign in or provide a valid API key" });
    }
    const user = userStore.find(req.session.user);
    if (!user) {
      return req.session.destroy(() => res.status(401).json({ error: "Account no longer exists" }));
    }
    if (user.status === "blocked") {
      return res.status(403).json({ error: "Your account has been blocked by an administrator" });
    }
    if (user.status !== "approved") {
      return res.status(403).json({ error: "Your account is waiting for administrator approval" });
    }
    req.owner = user.username;
    req.authRole = user.role;
    req.currentUser = user;
    next();
  };

  const adminOnly = (req, res, next) => {
    if (req.authRole !== "admin") return res.status(403).json({ error: "Administrator access required" });
    next();
  };
  const userOnly = (req, res, next) => {
    if (req.authRole === "admin") return res.status(403).json({ error: "Use the administrator dashboard" });
    next();
  };
  const ensureFolder = (owner, folderId) => !folderId || Boolean(folderStore.find(folderId, owner));

  app.get("/api/health", (req, res) => res.json({ ok: true, storageAccounts: pool.accountCount() }));

  app.post("/api/register", authLimiter, async (req, res, next) => {
    try {
      const user = await userStore.register(req.body?.username, req.body?.password);
      res.status(201).json({
        username: user.username, status: user.status,
        message: "Registration received. An administrator must approve your account.",
      });
    } catch (error) { next(error); }
  });

  app.post("/api/login", authLimiter, async (req, res, next) => {
    try {
      const { username, password } = req.body || {};
      if (typeof username !== "string" || typeof password !== "string") {
        return res.status(401).json({ error: "Invalid credentials" });
      }
      const user = await userStore.authenticate(username, password);
      if (!user) return res.status(401).json({ error: "Invalid credentials" });
      if (user.status === "pending") {
        return res.status(403).json({ error: "Your account is waiting for administrator approval" });
      }
      if (user.status === "blocked") {
        return res.status(403).json({ error: "Your account has been blocked by an administrator" });
      }
      req.session.regenerate((error) => {
        if (error) return next(error);
        req.session.user = user.username;
        res.json({ username: user.username, role: user.role, status: user.status });
      });
    } catch (error) { next(error); }
  });

  app.post("/api/logout", (req, res) => req.session.destroy(() => {
    res.clearCookie("storage.sid");
    res.json({ ok: true });
  }));

  app.get("/api/me", (req, res) => {
    if (!req.session.user) return res.json({ username: null });
    const user = userStore.find(req.session.user);
    if (!user) return res.json({ username: null });
    res.json({ username: user.username, role: user.role, status: user.status });
  });

  app.get("/api/admin/users", identify, adminOnly, (req, res) => {
    res.json(userStore.list().filter((user) => user.role !== "admin")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  });

  app.get("/api/admin/stats", identify, adminOnly, (req, res) => {
    const users = userStore.list().filter((user) => user.role !== "admin");
    const count = (status) => users.filter((user) => user.status === status).length;
    res.json({
      users: users.length, pending: count("pending"), approved: count("approved"),
      blocked: count("blocked"), files: store.all().length, folders: folderStore.all().length,
    });
  });

  app.patch("/api/admin/users/:username", identify, adminOnly, async (req, res, next) => {
    try { res.json(await userStore.setStatus(req.params.username, req.body?.status)); }
    catch (error) { next(error); }
  });

  app.get("/api/files", identify, userOnly, (req, res) => {
    const folderId = requestedFolder(req.query.folderId);
    if (!ensureFolder(req.owner, folderId)) return res.status(404).json({ error: "Folder not found" });
    res.json(store.all()
      .filter((record) => record.owner === req.owner && requestedFolder(record.folderId) === folderId)
      .map(({ id, name, size, type, createdAt, folderId: parent }) => ({
        id, name, size, type, createdAt, folderId: requestedFolder(parent),
      })).reverse());
  });

  app.get("/api/folders", identify, userOnly, (req, res) => {
    const parentId = requestedFolder(req.query.parentId);
    if (!ensureFolder(req.owner, parentId)) return res.status(404).json({ error: "Folder not found" });
    res.json(folderStore.all()
      .filter((folder) => folder.owner === req.owner && requestedFolder(folder.parentId) === parentId)
      .map(({ id, name, parentId: parent, createdAt }) => ({
        id, name, parentId: requestedFolder(parent), createdAt,
      })).sort((a, b) => a.name.localeCompare(b.name)));
  });

  app.post("/api/folders", identify, userOnly, async (req, res, next) => {
    try {
      const name = safeFolderName(req.body?.name);
      const parentId = requestedFolder(req.body?.parentId);
      if (!name) return res.status(400).json({ error: "Enter a valid folder name" });
      if (!ensureFolder(req.owner, parentId)) return res.status(404).json({ error: "Parent folder not found" });
      const duplicate = folderStore.all().some((folder) =>
        folder.owner === req.owner && requestedFolder(folder.parentId) === parentId &&
        folder.name.toLowerCase() === name.toLowerCase());
      if (duplicate) return res.status(409).json({ error: "A folder with that name already exists here" });
      const folder = { id: randomUUID(), owner: req.owner, name, parentId, createdAt: new Date().toISOString() };
      await folderStore.add(folder);
      res.status(201).json(folder);
    } catch (error) { next(error); }
  });

  app.delete("/api/folders/:id", identify, userOnly, async (req, res, next) => {
    try {
      const folder = folderStore.find(req.params.id, req.owner);
      if (!folder) return res.status(404).json({ error: "Folder not found" });
      const hasFiles = store.all().some((record) => record.owner === req.owner && record.folderId === folder.id);
      const hasFolders = folderStore.all().some((item) => item.owner === req.owner && item.parentId === folder.id);
      if (hasFiles || hasFolders) return res.status(409).json({ error: "The folder must be empty before deletion" });
      await folderStore.delete(folder.id);
      res.json({ ok: true });
    } catch (error) { next(error); }
  });

  app.get("/api/storage", identify, async (req, res, next) => {
    try { res.json({ ...(await pool.usage()), driver: "pooled" }); }
    catch (error) { next(error); }
  });

  app.post("/api/files", identify, userOnly, uploadLimiter, async (req, res, next) => {
    if ((req.get("content-type") || "").toLowerCase().startsWith("multipart/form-data")) {
      return res.status(415).json({
        error: "Send the file as the raw request body with X-File-Name and X-File-Size headers",
      });
    }
    const name = safeUploadName(req.get("x-file-name"));
    if (!name) return res.status(400).json({
      error: "Invalid or missing file name. Allowed: PDF, images, text and office documents.",
    });
    const size = uploadSize(req.get("x-file-size"));
    if (!size) return res.status(411).json({ error: "X-File-Size must contain the file size in bytes" });
    if (size > config.maxFileSize) {
      return res.status(413).json({ error: `Maximum file size is ${config.maxFileSize / 1024 / 1024 / 1024} GB` });
    }
    const contentLength = uploadSize(req.get("content-length"));
    if (contentLength && contentLength !== size) {
      return res.status(400).json({ error: "X-File-Size does not match Content-Length" });
    }
    const folderId = requestedFolder(req.get("x-folder-id"));
    if (!ensureFolder(req.owner, folderId)) return res.status(404).json({ error: "Folder not found" });
    let location;
    try {
      location = await pool.putStream(req, size);
      const record = {
        id: randomUUID(), ...location, owner: req.owner, folderId,
        name, size,
        type: (req.get("content-type") || "application/octet-stream").split(";")[0].trim().slice(0, 100),
        createdAt: new Date().toISOString(),
      };
      await store.add(record);
      res.status(201).json({
        id: record.id, name: record.name, size: record.size, type: record.type,
        createdAt: record.createdAt, folderId: record.folderId,
      });
    } catch (error) {
      if (location) { try { await pool.remove(location); } catch {} }
      next(error);
    }
  });

  const owned = (req, res, next) => {
    const record = store.find(req.params.id, req.owner);
    if (!record) return res.status(404).json({ error: "File not found" });
    req.fileRecord = record;
    next();
  };

  app.get("/api/files/:id/content", identify, userOnly, owned, async (req, res, next) => {
    try {
      const record = req.fileRecord;
      const stream = await pool.getStream(record);
      const preview = req.query.preview === "1" &&
        new Set(["application/pdf", "image/jpeg", "image/png", "text/plain"]).has(record.type);
      res.set({
        "Content-Type": record.type || "application/octet-stream",
        "Content-Length": String(record.size),
        "Content-Disposition": `${preview ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(record.name)}`,
        "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
      });
      await pipeline(stream, res);
    } catch (error) { next(error); }
  });

  app.delete("/api/files/:id", identify, userOnly, owned, async (req, res, next) => {
    try {
      await pool.remove(req.fileRecord);
      await store.delete(req.fileRecord.id);
      res.json({ ok: true });
    } catch (error) { next(error); }
  });

  app.use((error, req, res, next) => {
    console.error(error);
    if (res.headersSent) return next(error);
    if (error instanceof UserStoreError) {
      const status = error.code === "USERNAME_EXISTS" ? 409 : error.code === "NOT_FOUND" ? 404 : 400;
      return res.status(status).json({ error: error.message });
    }
    if (error instanceof StoragePoolError) return res.status(503).json({ error: "Storage is temporarily unavailable" });
    res.status(500).json({ error: "Unable to complete request. Check server configuration and logs." });
  });

  return app;
}
