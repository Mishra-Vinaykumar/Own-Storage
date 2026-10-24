const $ = (selector) => document.querySelector(selector);
let noticeTimeout;

function notify(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.remove("hidden");
  clearTimeout(noticeTimeout);
  noticeTimeout = setTimeout(() => toast.classList.add("hidden"), 4000);
}

async function api(url, options = {}) {
  const response = await fetch(url, { credentials: "same-origin", ...options });
  let data;
  try { data = await response.json(); } catch { data = {}; }
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function statusBadge(status) {
  const badge = document.createElement("span");
  badge.className = `status-badge ${status}`;
  badge.textContent = status[0].toUpperCase() + status.slice(1);
  return badge;
}

function actionButton(label, status, username, className = "") {
  const button = document.createElement("button");
  button.textContent = label;
  button.className = className;
  button.onclick = async () => {
    button.disabled = true;
    try {
      await api(`/api/admin/users/${encodeURIComponent(username)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      notify(`${username} is now ${status}`);
      await loadDashboard();
    } catch (error) { notify(error.message); button.disabled = false; }
  };
  return button;
}

function userRow(user) {
  const row = document.createElement("tr");
  const nameCell = document.createElement("td");
  const avatar = document.createElement("span");
  avatar.className = "user-avatar";
  avatar.textContent = user.username[0].toUpperCase();
  const name = document.createElement("strong");
  name.textContent = user.username;
  nameCell.append(avatar, name);
  const created = document.createElement("td");
  created.textContent = new Date(user.createdAt).toLocaleDateString();
  const status = document.createElement("td");
  status.append(statusBadge(user.status));
  const actions = document.createElement("td");
  actions.className = "table-actions";
  if (user.status === "pending") {
    actions.append(actionButton("Approve", "approved", user.username, "approve"));
    actions.append(actionButton("Block", "blocked", user.username, "block"));
  } else if (user.status === "approved") {
    actions.append(actionButton("Block", "blocked", user.username, "block"));
  } else {
    actions.append(actionButton("Unblock", "approved", user.username, "approve"));
  }
  row.append(nameCell, created, status, actions);
  return row;
}

async function loadDashboard() {
  try {
    const [stats, users] = await Promise.all([api("/api/admin/stats"), api("/api/admin/users")]);
    $("#totalUsers").textContent = stats.users;
    $("#pendingUsers").textContent = stats.pending;
    $("#approvedUsers").textContent = stats.approved;
    $("#blockedUsers").textContent = stats.blocked;
    $("#fileTotal").textContent = `${stats.files} file${stats.files === 1 ? "" : "s"}`;
    $("#folderTotal").textContent = `${stats.folders} folder${stats.folders === 1 ? "" : "s"}`;
    const body = $("#userRows");
    body.replaceChildren(...users.map(userRow));
    $("#noUsers").classList.toggle("hidden", users.length > 0);
    $(".user-table").classList.toggle("hidden", users.length === 0);
  } catch (error) { notify(error.message); }
}

$("#adminRefresh").onclick = loadDashboard;
$("#adminLogout").onclick = async () => {
  try { await api("/api/logout", { method: "POST" }); } catch {}
  window.location.href = "/";
};

api("/api/me").then((user) => {
  if (!user.username || user.role !== "admin" || user.status !== "approved") {
    window.location.href = "/";
    return;
  }
  $("#adminLabel").textContent = user.username;
  $("#adminDashboard").classList.remove("hidden");
  loadDashboard();
}).catch(() => { window.location.href = "/"; });
