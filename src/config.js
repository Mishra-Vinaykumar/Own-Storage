import path from "node:path";

function list(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function pairs(value, label) {
  return String(value || "")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const separator = item.indexOf(":");
      if (separator < 1 || separator === item.length - 1) {
        throw new Error(`${label} entries must use name:value`);
      }
      return [item.slice(0, separator), item.slice(separator + 1)];
    });
}

function envPrefix(accountId) {
  return accountId.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

function positiveNumber(value, fallback, label) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  return parsed;
}

export function loadConfig(env = process.env, root = process.cwd()) {
  const driver = env.STORAGE_DRIVER || "local";
  if (!new Set(["local", "mega"]).has(driver)) {
    throw new Error("STORAGE_DRIVER must be local or mega");
  }

  const accountIds = list(env.STORAGE_ACCOUNTS);
  if (!accountIds.length) {
    throw new Error("STORAGE_ACCOUNTS must contain at least one account id");
  }
  if (new Set(accountIds).size !== accountIds.length) {
    throw new Error("STORAGE_ACCOUNTS cannot contain duplicate account ids");
  }

  const strategy = env.STORAGE_STRATEGY || "least-used";
  if (!new Set(["least-used", "round-robin"]).has(strategy)) {
    throw new Error("STORAGE_STRATEGY must be least-used or round-robin");
  }

  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
    throw new Error("SESSION_SECRET must contain at least 32 characters");
  }

  const accounts = accountIds.map((id) => {
    const prefix = envPrefix(id);
    if (driver === "local") {
      return {
        id,
        driver,
        directory: path.join(root, "storage", id),
        capacityBytes:
          positiveNumber(
            env.LOCAL_ACCOUNT_CAPACITY_GB,
            20,
            "LOCAL_ACCOUNT_CAPACITY_GB",
          ) *
          1024 *
          1024 *
          1024,
      };
    }

    const email = env[`MEGA_${prefix}_EMAIL`];
    const password = env[`MEGA_${prefix}_PASSWORD`];
    if (!email || !password) {
      throw new Error(
        `Missing MEGA_${prefix}_EMAIL or MEGA_${prefix}_PASSWORD for account ${id}`,
      );
    }
    return {
      id,
      driver,
      email,
      password,
      folder: env[`MEGA_${prefix}_FOLDER`] || "Private-Storage-API",
    };
  });

  return {
    root,
    port: Number(env.PORT || 3000),
    driver,
    strategy,
    accounts,
    sessionSecret: env.SESSION_SECRET,
    trustProxy: env.TRUST_PROXY === "true",
    maxFileSize:
      positiveNumber(env.MAX_FILE_SIZE_MB, 4608, "MAX_FILE_SIZE_MB") *
      1024 *
      1024,
    uploadTimeout:
      positiveNumber(env.UPLOAD_TIMEOUT_HOURS, 12, "UPLOAD_TIMEOUT_HOURS") *
      60 *
      60 *
      1000,
    metadataFile: path.join(root, "data", "files.json"),
    folderMetadataFile: path.join(root, "data", "folders.json"),
    userMetadataFile: path.join(root, "data", "users.json"),
    admin: {
      username: (env.ADMIN_USERNAME || "admin").trim().toLowerCase(),
      password: env.ADMIN_PASSWORD || "ChangeAdmin123!",
    },
    users: new Map(pairs(env.DEMO_USERS, "DEMO_USERS")),
    apiKeys: pairs(env.API_KEYS, "API_KEYS").map(([owner, key]) => ({
      owner,
      key,
    })),
  };
}
