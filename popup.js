const STORAGE_KEY = "__form_saver_pages_v1__";

function formatBytes(bytes) {
  if (typeof bytes !== "number" || Number.isNaN(bytes)) return "n/a";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendToTab(tabId, msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (resp) => resolve(resp));
  });
}

function summarizeValue(item) {
  const stable = item?.id;
  const target =
    stable?.kind === "id" ? `#${stable.value}` :
    stable?.kind === "name" ? `${(stable.tag || "").toLowerCase()}[name="${stable.value}"]` :
    stable?.kind === "path" ? stable.value :
    "(unknown)";

  const v = item?.value || {};
  if (v.t === "checkbox") return `${target}  =>  checkbox: ${v.checked ? "checked" : "unchecked"}`;
  if (v.t === "radio") return `${target}  =>  radio(${escapeHtml(v.value ?? "")}): ${v.checked ? "checked" : "unchecked"}`;
  if (v.t === "input") return `${target}  =>  input: ${escapeHtml(v.value ?? "")}`;
  if (v.t === "textarea") return `${target}  =>  textarea: ${escapeHtml(v.value ?? "")}`;
  if (v.t === "select") return `${target}  =>  select: ${escapeHtml(v.value ?? "")}`;
  if (v.t === "select-multiple") return `${target}  =>  select-multiple: [${(v.values || []).map(x => escapeHtml(x)).join(", ")}]`;
  return `${target}  =>  (unknown)`;
}

function renderSavedData(pages) {
  const container = document.getElementById("savedList");
  const keys = Object.keys(pages || {}).sort((a, b) => (pages[b]?.updatedAt || 0) - (pages[a]?.updatedAt || 0));

  if (keys.length === 0) {
    container.innerHTML = `<div class="meta">No saved data yet.</div>`;
    return;
  }

  const html = keys.map((k) => {
    const entry = pages[k];
    const url = entry?.url || k;
    const updatedAt = entry?.updatedAt ? new Date(entry.updatedAt).toLocaleString() : "n/a";
    const items = Array.isArray(entry?.data) ? entry.data : [];
    const body = items
      .slice(0, 2000) // safety (avoid popup freezing on massive pages)
      .map(it => `<div class="kv small mono">${escapeHtml(summarizeValue(it))}</div><div style="height:8px;"></div>`)
      .join("");

    return `
      <details style="margin:8px 0;">
        <summary>
          <span class="pill">${items.length} fields</span>
          <span class="mono">${escapeHtml(url)}</span>
          <div class="meta">Updated: ${escapeHtml(updatedAt)}</div>
        </summary>
        <div style="margin-top:8px;">${body || `<div class="meta">No fields saved.</div>`}</div>
      </details>
    `;
  }).join("");

  container.innerHTML = html;
}

async function updateUI() {
  const pageKeyEl = document.getElementById("pageKey");
  const storageLineEl = document.getElementById("storageLine");
  const pagesCountEl = document.getElementById("pagesCount");
  const statusEl = document.getElementById("status");

  statusEl.textContent = "";

  const tab = await getActiveTab();
  if (!tab?.id) {
    pageKeyEl.textContent = "No active tab";
    return;
  }

  const ping = await sendToTab(tab.id, { type: "FORM_SAVER_PING" });
  pageKeyEl.textContent = ping?.page || "(content script not available on this page)";

  const bytesUsed = await chrome.storage.local.getBytesInUse(null);
  const quota = chrome.storage?.local?.QUOTA_BYTES; // may be undefined
  const maxText = typeof quota === "number" ? formatBytes(quota) : "unlimited/varies";
  storageLineEl.textContent = `Used: ${formatBytes(bytesUsed)} | Max: ${maxText}`;

  const obj = await chrome.storage.local.get(STORAGE_KEY);
  const pages = obj[STORAGE_KEY] || {};
  pagesCountEl.textContent = `Saved pages: ${Object.keys(pages).length}`;

  // If panel is open, refresh it
  const panel = document.getElementById("savedPanel");
  if (panel.style.display !== "none") {
    renderSavedData(pages);
  }
}

document.getElementById("restore").addEventListener("click", async () => {
  const statusEl = document.getElementById("status");
  const tab = await getActiveTab();
  if (!tab?.id) return;

  const resp = await sendToTab(tab.id, { type: "FORM_SAVER_RESTORE" });
  if (resp?.ok) {
    statusEl.textContent = "Restored.";
    statusEl.className = "meta ok";
  } else {
    statusEl.textContent = resp?.reason || "Nothing to restore for this page.";
    statusEl.className = "meta bad";
  }
  updateUI();
});

document.getElementById("view").addEventListener("click", async () => {
  const panel = document.getElementById("savedPanel");
  const obj = await chrome.storage.local.get(STORAGE_KEY);
  const pages = obj[STORAGE_KEY] || {};

  const isHidden = panel.style.display === "none";
  panel.style.display = isHidden ? "block" : "none";

  if (isHidden) renderSavedData(pages);
});

document.getElementById("clear").addEventListener("click", async () => {
  const statusEl = document.getElementById("status");
  await chrome.storage.local.remove(STORAGE_KEY);
  statusEl.textContent = "All saved data removed.";
  statusEl.className = "meta ok";

  document.getElementById("savedPanel").style.display = "none";
  updateUI();
});

updateUI();
