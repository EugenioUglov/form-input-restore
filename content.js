(() => {
  const STORAGE_KEY = "__form_saver_pages_v1__";
  const SAVE_DEBOUNCE_MS = 400;

  // delete old pages until we are <= this ratio of QUOTA_BYTES
  const TARGET_RATIO = 0.90;

  let saveTimer = null;
  let restoring = false;

  // only store changes made by the user since last save
  const changedMap = new Map(); // stableKey -> { id, tag, type, value }

  function pageKey() {
    return location.origin + location.pathname + location.search; // per exact page
  }

  function isUsableControl(el) {
    if (!el || el.disabled) return false;
    const tag = el.tagName;
    if (tag === "INPUT") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (["submit", "button", "image", "reset", "file"].includes(type)) return false;
      return true;
    }
    return tag === "TEXTAREA" || tag === "SELECT";
  }

  function getStableId(el) {
    if (el.id) return { kind: "id", value: el.id };
    if (el.name) return { kind: "name", value: el.name, tag: el.tagName };
    return { kind: "path", value: cssPath(el) };
  }

  function stableKey(stable) {
    if (!stable) return "unknown";
    if (stable.kind === "id") return `id:${stable.value}`;
    if (stable.kind === "name") return `name:${stable.tag || ""}:${stable.value}`;
    if (stable.kind === "path") return `path:${stable.value}`;
    return "unknown";
  }

  function cssPath(el) {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body && cur !== document.documentElement) {
      const tag = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      if (!parent) break;

      const siblings = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
      const idx = siblings.indexOf(cur) + 1;
      parts.unshift(`${tag}:nth-of-type(${idx})`);
      cur = parent;
    }
    return parts.join(" > ");
  }

  function readControlValue(el) {
    const tag = el.tagName;
    if (tag === "INPUT") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox") return { t: "checkbox", checked: !!el.checked };
      if (type === "radio") return { t: "radio", checked: !!el.checked, value: el.value };
      return { t: "input", value: el.value };
    }
    if (tag === "TEXTAREA") return { t: "textarea", value: el.value };
    if (tag === "SELECT") {
      if (el.multiple) {
        const selected = Array.from(el.options)
          .map((opt, i) => (opt.selected ? i : -1))
          .filter(i => i !== -1);
        return { t: "select-multiple", selectedIndexes: selected, values: selected.map(i => el.options[i]?.value) };
      }
      return { t: "select", selectedIndex: el.selectedIndex, value: el.value };
    }
    return null;
  }

  function writeControlValue(el, data) {
    if (!data) return;

    const tag = el.tagName;
    if (tag === "INPUT") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox" && data.t === "checkbox") { el.checked = !!data.checked; return; }
      if (type === "radio" && data.t === "radio") { el.checked = !!data.checked; return; }
      if (data.t === "input") { el.value = data.value ?? ""; return; }
    }
    if (tag === "TEXTAREA" && data.t === "textarea") { el.value = data.value ?? ""; return; }
    if (tag === "SELECT") {
      if (el.multiple && data.t === "select-multiple") {
        const idxSet = new Set(data.selectedIndexes || []);
        Array.from(el.options).forEach((opt, i) => { opt.selected = idxSet.has(i); });
        return;
      }
      if (!el.multiple && data.t === "select") {
        if (typeof data.value === "string") el.value = data.value;
        else if (typeof data.selectedIndex === "number") el.selectedIndex = data.selectedIndex;
        return;
      }
    }
  }

  async function loadAllPages() {
    const obj = await chrome.storage.local.get(STORAGE_KEY);
    return obj[STORAGE_KEY] || {};
  }

  async function saveAllPages(pages) {
    await chrome.storage.local.set({ [STORAGE_KEY]: pages });
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveCurrentPage, SAVE_DEBOUNCE_MS);
  }

  async function getBytesUsed() {
    // bytes used by the whole extension local storage
    return await chrome.storage.local.getBytesInUse(null);
  }

  async function cleanupIfNeeded() {
    const quota = chrome.storage?.local?.QUOTA_BYTES; // usually ~10MB, may be undefined
    if (typeof quota !== "number" || quota <= 0) return;

    let used = await getBytesUsed();
    const target = Math.floor(quota * TARGET_RATIO);

    if (used <= target) return;

    let pages = await loadAllPages();

    // Sort by oldest first
    const keys = Object.keys(pages).sort((a, b) => (pages[a]?.updatedAt || 0) - (pages[b]?.updatedAt || 0));

    // Remove oldest entries until under target (or nothing left)
    for (const k of keys) {
      if (used <= target) break;
      delete pages[k];
      await saveAllPages(pages);
      used = await getBytesUsed();
    }
  }

  async function saveCurrentPage() {
    // Only save if user changed something
    if (changedMap.size === 0) return;

    try {
      const key = pageKey();
      const pages = await loadAllPages();
      const existing = pages[key]?.data;

      // Merge previous user-changed values for this page + new changes
      const merged = new Map();
      if (Array.isArray(existing)) {
        for (const item of existing) merged.set(stableKey(item?.id), item);
      }
      for (const [k, v] of changedMap.entries()) merged.set(k, v);

      pages[key] = {
        updatedAt: Date.now(),
        url: location.href,
        data: Array.from(merged.values())
      };

      await saveAllPages(pages);

      // Clear "changed since last save"
      changedMap.clear();

      // If storage > 90%, delete old pages until <= 90%
      await cleanupIfNeeded();
    } catch {
      // ignore
    }
  }

  function findElementByStableId(stable) {
    if (!stable) return null;
    if (stable.kind === "id") return document.getElementById(stable.value);
    if (stable.kind === "name") return document.querySelector(`${stable.tag.toLowerCase()}[name="${CSS.escape(stable.value)}"]`);
    if (stable.kind === "path") return document.querySelector(stable.value);
    return null;
  }

  async function restoreCurrentPage() {
    const key = pageKey();
    const pages = await loadAllPages();
    const entry = pages[key];
    if (!entry || !Array.isArray(entry.data)) return { ok: false, reason: "No saved data for this page." };

    restoring = true;
    try {
      for (const item of entry.data) {
        const stable = item.id;

        if (stable?.kind === "name" && stable.value && stable.tag) {
          const all = Array.from(
            document.querySelectorAll(`${stable.tag.toLowerCase()}[name="${CSS.escape(stable.value)}"]`)
          ).filter(isUsableControl);

          for (const el of all) {
            if (el.tagName === "INPUT" && (el.type || "").toLowerCase() === "radio" && item.value?.t === "radio") {
              if (el.value === item.value.value) {
                writeControlValue(el, item.value);
                el.dispatchEvent(new Event("input", { bubbles: true }));
                el.dispatchEvent(new Event("change", { bubbles: true }));
              }
            } else {
              writeControlValue(el, item.value);
              el.dispatchEvent(new Event("input", { bubbles: true }));
              el.dispatchEvent(new Event("change", { bubbles: true }));
            }
          }
          continue;
        }

        const el = findElementByStableId(stable);
        if (!el || !isUsableControl(el)) continue;

        writeControlValue(el, item.value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }

      return { ok: true };
    } finally {
      restoring = false;
    }
  }

  function recordChange(el) {
    const id = getStableId(el);
    changedMap.set(stableKey(id), {
      id,
      tag: el.tagName,
      type: (el.getAttribute && el.getAttribute("type")) || null,
      value: readControlValue(el)
    });
  }

  // Save only when user actually changes something (typing/paste/click)
  document.addEventListener("input", (e) => {
    if (restoring) return;
    if (!e.isTrusted) return;
    if (!isUsableControl(e.target)) return;
    recordChange(e.target);
    scheduleSave();
  }, true);

  document.addEventListener("change", (e) => {
    if (restoring) return;
    if (!e.isTrusted) return;
    if (!isUsableControl(e.target)) return;
    recordChange(e.target);
    scheduleSave();
  }, true);

  // Messages from popup
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      if (msg?.type === "FORM_SAVER_RESTORE") {
        sendResponse(await restoreCurrentPage());
        return;
      }
      if (msg?.type === "FORM_SAVER_PING") {
        sendResponse({ ok: true, page: pageKey() });
        return;
      }
      sendResponse({ ok: false });
    })();
    return true;
  });
})();
