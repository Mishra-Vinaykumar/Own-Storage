const $ = (selector) => document.querySelector(selector);
let current = null;
let currentFolder = null;
let folderTrail = [];
let noticeTimeout;

function notify(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.remove("hidden");
  clearTimeout(noticeTimeout);
  noticeTimeout = setTimeout(() => toast.classList.add("hidden"), 4500);
}

async function api(url, options = {}) {
  const response = await fetch(url, { credentials: "same-origin", ...options });
  let data;
  try { data = await response.json(); } catch { data = {}; }
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function niceSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(1)} GB`;
}

async function loadStorage() {
  const widget = $("#storageWidget");
  widget.classList.remove("hidden");
  try {
    const storage = await api("/api/storage");
    const percent = storage.total > 0 ? Math.min((storage.used / storage.total) * 100, 100) : 0;
    $("#storageLabel").textContent = `${niceSize(storage.used)} / ${niceSize(storage.total)}`;
    $("#storagePercent").textContent = `${percent.toFixed(1)}%`;
    const fill = $("#storageUsed");
    fill.style.width = `${percent}%`;
    fill.classList.remove("warn", "danger");
    if (percent >= 90) fill.classList.add("danger"); else if (percent >= 70) fill.classList.add("warn");
  } catch {
    $("#storageLabel").textContent = "Storage unavailable";
    $("#storagePercent").textContent = "—";
    $("#storageUsed").style.width = "0%";
  }
}

function switchAuth(mode) {
  const login = mode === "login";
  $("#loginPane").classList.toggle("hidden", !login);
  $("#registerPane").classList.toggle("hidden", login);
  $("#loginTab").classList.toggle("active", login);
  $("#registerTab").classList.toggle("active", !login);
  $("#authMessage").classList.add("hidden");
}

function show() {
  const signedIn = Boolean(current);
  $("#dashboard").classList.toggle("hidden", !signedIn);
  $("#authView").classList.toggle("hidden", signedIn);
  $("#logout").classList.toggle("hidden", !signedIn);
  $("#storageWidget").classList.toggle("hidden", !signedIn);
  $("#userLabel").textContent = signedIn ? `Signed in as ${current}` : "";
  if (signedIn) { loadItems(); loadStorage(); }
}

$("#loginTab").onclick = () => switchAuth("login");
$("#registerTab").onclick = () => switchAuth("register");

$("#registerForm").onsubmit = async (event) => {
  event.preventDefault();
  try {
    const result = await api("/api/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: $("#newUsername").value, password: $("#newPassword").value }),
    });
    $("#registerForm").reset();
    const message = $("#authMessage");
    message.textContent = result.message;
    message.classList.remove("hidden");
  } catch (error) { notify(error.message); }
};

$("#loginForm").onsubmit = async (event) => {
  event.preventDefault();
  try {
    const result = await api("/api/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: $("#username").value, password: $("#password").value }),
    });
    $("#password").value = "";
    if (result.role === "admin") {
      window.location.href = "/admin.html";
      return;
    }
    current = result.username;
    show();
  } catch (error) { notify(error.message); }
};

$("#logout").onclick = async () => {
  try {
    await api("/api/logout", { method: "POST" });
    current = null;
    currentFolder = null;
    folderTrail = [];
    show();
  } catch (error) { notify(error.message); }
};

function updatePath() {
  $("#folderPath").textContent = ["My files", ...folderTrail.map((folder) => folder.name)].join(" / ");
  $("#backFolder").disabled = folderTrail.length === 0;
}

function folderRow(folder) {
  const row = document.createElement("div");
  row.className = "file folder-row";
  const icon = document.createElement("div");
  icon.className = "ficon folder-icon";
  icon.textContent = "▰";
  const info = document.createElement("div");
  info.className = "fileInfo";
  const name = document.createElement("strong");
  name.textContent = folder.name;
  const detail = document.createElement("small");
  detail.textContent = `Folder · ${new Date(folder.createdAt).toLocaleDateString()}`;
  info.append(name, detail);
  const actions = document.createElement("div");
  actions.className = "actions";
  const open = document.createElement("button");
  open.textContent = "Open";
  open.onclick = () => {
    folderTrail.push(folder);
    currentFolder = folder.id;
    updatePath();
    loadItems();
  };
  const remove = document.createElement("button");
  remove.className = "danger";
  remove.textContent = "Delete";
  remove.onclick = async () => {
    if (!confirm(`Delete empty folder "${folder.name}"?`)) return;
    try { await api(`/api/folders/${encodeURIComponent(folder.id)}`, { method: "DELETE" }); loadItems(); }
    catch (error) { notify(error.message); }
  };
  actions.append(open, remove);
  row.append(icon, info, actions);
  return row;
}

function fileRow(file) {
  const row = document.createElement("div");
  row.className = "file";
  const icon = document.createElement("div");
  icon.className = "ficon";
  icon.textContent = (file.name.split(".").pop() || "FILE").toUpperCase().slice(0, 5);
  const info = document.createElement("div");
  info.className = "fileInfo";
  const name = document.createElement("strong");
  name.textContent = file.name;
  const detail = document.createElement("small");
  detail.textContent = `${niceSize(file.size)} · ${new Date(file.createdAt).toLocaleDateString()}`;
  info.append(name, detail);
  const actions = document.createElement("div");
  actions.className = "actions";
  const preview = document.createElement("button");
  preview.textContent = "View";
  preview.onclick = () => window.open(`/api/files/${encodeURIComponent(file.id)}/content?preview=1`, "_blank", "noopener");
  const download = document.createElement("button");
  download.textContent = "Download";
  download.onclick = () => { window.location.href = `/api/files/${encodeURIComponent(file.id)}/content`; };
  const remove = document.createElement("button");
  remove.className = "danger";
  remove.textContent = "Delete";
  remove.onclick = async () => {
    if (!confirm(`Permanently delete "${file.name}"?`)) return;
    try { await api(`/api/files/${encodeURIComponent(file.id)}`, { method: "DELETE" }); notify("Document deleted"); loadItems(); loadStorage(); }
    catch (error) { notify(error.message); }
  };
  actions.append(preview, download, remove);
  row.append(icon, info, actions);
  return row;
}

async function loadItems() {
  try {
    const id = encodeURIComponent(currentFolder || "");
    const [folders, files] = await Promise.all([
      api(`/api/folders?parentId=${id}`), api(`/api/files?folderId=${id}`),
    ]);
    const list = $("#items");
    list.replaceChildren();
    $("#itemCount").textContent = folders.length + files.length;
    if (!folders.length && !files.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "This folder is empty.";
      list.append(empty);
      return;
    }
    folders.forEach((folder) => list.append(folderRow(folder)));
    files.forEach((file) => list.append(fileRow(file)));
  } catch (error) { notify(error.message); }
}

$("#backFolder").onclick = () => {
  folderTrail.pop();
  currentFolder = folderTrail.at(-1)?.id || null;
  updatePath();
  loadItems();
};

$("#folderForm").onsubmit = async (event) => {
  event.preventDefault();
  try {
    await api("/api/folders", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: $("#folderName").value, parentId: currentFolder }),
    });
    $("#folderForm").reset();
    notify("Folder created");
    loadItems();
  } catch (error) { notify(error.message); }
};

$("#fileInput").onchange = () => {
  $("#selected").textContent = $("#fileInput").files[0]?.name || "PDF, images, text, Word and Excel · Up to 10 MB";
};
const drop = $("#drop");
drop.ondragover = (event) => { event.preventDefault(); drop.classList.add("drag"); };
drop.ondragleave = () => drop.classList.remove("drag");
drop.ondrop = (event) => {
  event.preventDefault(); drop.classList.remove("drag");
  if (event.dataTransfer.files.length) {
    $("#fileInput").files = event.dataTransfer.files;
    $("#fileInput").dispatchEvent(new Event("change"));
  }
};

$("#uploadForm").onsubmit = async (event) => {
  event.preventDefault();
  const file = $("#fileInput").files[0];
  if (!file) return notify("Select a document first");
  if (file.size > 10 * 1024 * 1024) return notify("Maximum file size is 10 MB");
  const button = $("#uploadBtn");
  button.disabled = true;
  button.textContent = "Uploading…";
  try {
    const data = new FormData();
    data.append("file", file);
    if (currentFolder) data.append("folderId", currentFolder);
    await api("/api/files", { method: "POST", body: data });
    $("#fileInput").value = "";
    $("#selected").textContent = "PDF, images, text, Word and Excel · Up to 10 MB";
    notify("Document uploaded successfully");
    loadItems();
    loadStorage();
  } catch (error) { notify(error.message); }
  finally { button.disabled = false; button.textContent = "Upload document →"; }
};

$("#refresh").onclick = () => { loadItems(); loadStorage(); };
updatePath();
api("/api/me").then((user) => {
  if (user.username && user.role === "admin" && user.status === "approved") {
    window.location.href = "/admin.html";
    return;
  }
  current = user.status === "approved" ? user.username : null;
  show();
}).catch(() => show());
