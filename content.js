(() => {
  const STORAGE_KEY = "__form_saver_pages_v1__";
  const SAVE_DEBOUNCE_MS = 400;

  // delete old pages until we are <= this ratio of QUOTA_BYTES
  const TARGET_RATIO = 0.90;

  // how long to keep retrying restores while the page is still rendering (SPA / late DOM)
  const RESTORE_RETRY_MS = 4500;

  let saveTimer = null;
  let restoring = false;

  // only store changes made by the user since last save
  // stableKey -> { id, tag, type, value, fingerprint }
  const changedMap = new Map();

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

      const siblings = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
      const idx = siblings.indexOf(cur) + 1;
      parts.unshift(`${tag}:nth-of-type(${idx})`);
      cur = parent;
    }
    return parts.join(" > ");
  }

  function normalizeText(s) {
    return (s || "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 160);
  }

  function getLabelText(el) {
    // <label for="...">
    if (el && el.id) {
      try {
        const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lab && lab.innerText) return normalizeText(lab.innerText);
      } catch {
        // ignore
      }
    }

    // <label><input ...> ...</label>
    const wrapping = el ? el.closest("label") : null;
    if (wrapping && wrapping.innerText) return normalizeText(wrapping.innerText);

    // try aria-labelledby (may break if ids change, but sometimes still works)
    const labelledBy = el ? el.getAttribute("aria-labelledby") : null;
    if (labelledBy) {
      const ids = labelledBy.split(/\s+/).filter(Boolean);
      const texts = [];
      for (const id of ids) {
        const node = document.getElementById(id);
        if (node && node.innerText) texts.push(node.innerText);
      }
      if (texts.length) return normalizeText(texts.join(" "));
    }

    return "";
  }

  function getFingerprint(el) {
    const tag = el.tagName;
    const type = (el.getAttribute("type") || "").toLowerCase();
    const form = el.form;

    return {
      tag,
      type,
      name: el.getAttribute("name") || "",
      autocomplete: el.getAttribute("autocomplete") || "",
      placeholder: el.getAttribute("placeholder") || "",
      ariaLabel: el.getAttribute("aria-label") || "",
      ariaLabelledBy: el.getAttribute("aria-labelledby") || "",
      labelText: getLabelText(el),
      testid: el.getAttribute("data-testid") || el.getAttribute("data-qa") || el.getAttribute("data-cy") || "",
      formAction: (form && (form.getAttribute("action") || "")) || location.pathname
    };
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
          .filter((i) => i !== -1);
        return { t: "select-multiple", selectedIndexes: selected, values: selected.map((i) => el.options[i]?.value) };
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
      if (type === "checkbox" && data.t === "checkbox") {
        el.checked = !!data.checked;
        return;
      }
      if (type === "radio" && data.t === "radio") {
        el.checked = !!data.checked;
        return;
      }
      if (data.t === "input") {
        el.value = data.value ?? "";
        return;
      }
    }
    if (tag === "TEXTAREA" && data.t === "textarea") {
      el.value = data.value ?? "";
      return;
    }
    if (tag === "SELECT") {
      if (el.multiple && data.t === "select-multiple") {
        const idxSet = new Set(data.selectedIndexes || []);
        Array.from(el.options).forEach((opt, i) => {
          opt.selected = idxSet.has(i);
        });
        return;
      }
      if (!el.multiple && data.t === "select") {
        if (typeof data.value === "string") el.value = data.value;
        else if (typeof data.selectedIndex === "number") el.selectedIndex = data.selectedIndex;
        return;
      }
    }
  }

  function dispatchInputChange(el) {
    try {
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } catch {
      // ignore
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
    if (stable.kind === "name") {
      try {
        return document.querySelector(`${stable.tag.toLowerCase()}[name="${CSS.escape(stable.value)}"]`);
      } catch {
        return null;
      }
    }
    if (stable.kind === "path") {
      try {
        return document.querySelector(stable.value);
      } catch {
        return null;
      }
    }
    return null;
  }

  function scoreMatch(fp, el) {
    if (!fp || !el) return 0;

    let s = 0;

    if (el.tagName === fp.tag) s += 3;
    const type = (el.getAttribute("type") || "").toLowerCase();
    if ((type || "") === (fp.type || "")) s += 3;

    const formAction = (el.form && (el.form.getAttribute("action") || "")) || location.pathname;
    if (fp.formAction && formAction === fp.formAction) s += 2;

    const name = el.getAttribute("name") || "";
    if (fp.name && name === fp.name) s += 10;

    const testid = el.getAttribute("data-testid") || el.getAttribute("data-qa") || el.getAttribute("data-cy") || "";
    if (fp.testid && testid === fp.testid) s += 12;

    const placeholder = el.getAttribute("placeholder") || "";
    if (fp.placeholder && placeholder === fp.placeholder) s += 5;

    const autocomplete = el.getAttribute("autocomplete") || "";
    if (fp.autocomplete && autocomplete === fp.autocomplete) s += 3;

    const aria = el.getAttribute("aria-label") || "";
    if (fp.ariaLabel && aria === fp.ariaLabel) s += 6;

    const label = getLabelText(el);
    if (fp.labelText && label && label === normalizeText(fp.labelText)) s += 10;

    return s;
  }

  function findBestByFingerprint(fp) {
    if (!fp) return null;
    const all = Array.from(document.querySelectorAll("input,textarea,select")).filter(isUsableControl);

    let best = null;
    let bestScore = 0;

    for (const el of all) {
      const sc = scoreMatch(fp, el);
      if (sc > bestScore) {
        bestScore = sc;
        best = el;
      }
    }

    // threshold to avoid filling wrong fields
    return bestScore >= 12 ? best : null;
  }

  function applyToElement(el, item) {
    if (!el || !isUsableControl(el)) return false;

    // radios: only check the matching value
    if (el.tagName === "INPUT" && (el.type || "").toLowerCase() === "radio" && item.value?.t === "radio") {
      if (el.value !== item.value.value) return false;
    }

    writeControlValue(el, item.value);
    dispatchInputChange(el);
    return true;
  }

  function tryRestoreItems(pending) {
    let changed = false;

    for (const [k, item] of pending.entries()) {
      const stable = item.id;

      // 1) radio groups and other name-based fields (may match multiple)
      if (stable?.kind === "name" && stable.value && stable.tag) {
        let any = false;
        try {
          const all = Array.from(
            document.querySelectorAll(`${stable.tag.toLowerCase()}[name="${CSS.escape(stable.value)}"]`)
          ).filter(isUsableControl);

          for (const el of all) {
            if (applyToElement(el, item)) any = true;
          }
        } catch {
          // ignore
        }
        if (any) {
          pending.delete(k);
          changed = true;
          continue;
        }
      }

      // 2) direct stable locator
      const el = findElementByStableId(stable);
      if (applyToElement(el, item)) {
        pending.delete(k);
        changed = true;
        continue;
      }

      // 3) best-match fingerprint (handles changing ids / shifting DOM)
      const byFp = findBestByFingerprint(item.fingerprint);
      if (applyToElement(byFp, item)) {
        pending.delete(k);
        changed = true;
        continue;
      }
    }

    return changed;
  }

  async function restoreWithRetries(entry, timeoutMs = RESTORE_RETRY_MS) {
    const pending = new Map();
    for (const item of entry.data) pending.set(stableKey(item?.id), item);

    // initial attempt
    tryRestoreItems(pending);
    if (pending.size === 0) return { ok: true };

    // retry while DOM is still changing (SPAs / delayed rendering)
    return await new Promise((resolve) => {
      const obs = new MutationObserver(() => {
        tryRestoreItems(pending);
        if (pending.size === 0) {
          obs.disconnect();
          resolve({ ok: true });
        }
      });

      try {
        obs.observe(document.documentElement, { childList: true, subtree: true });
      } catch {
        // if observe fails, just return current result
        resolve({ ok: pending.size === 0, missing: pending.size });
        return;
      }

      setTimeout(() => {
        obs.disconnect();
        resolve({ ok: pending.size === 0, missing: pending.size });
      }, timeoutMs);
    });
  }

  async function restoreCurrentPage() {
    const key = pageKey();
    const pages = await loadAllPages();
    const entry = pages[key];
    if (!entry || !Array.isArray(entry.data)) return { ok: false, reason: "No saved data for this page." };

    restoring = true;
    try {
      return await restoreWithRetries(entry);
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
      value: readControlValue(el),
      fingerprint: getFingerprint(el)
    });
  }

  // Save only when user actually changes something (typing/paste/click)
  document.addEventListener(
    "input",
    (e) => {
      if (restoring) return;
      if (!e.isTrusted) return;
      if (!isUsableControl(e.target)) return;
      recordChange(e.target);
      scheduleSave();
    },
    true
  );

  document.addEventListener(
    "change",
    (e) => {
      if (restoring) return;
      if (!e.isTrusted) return;
      if (!isUsableControl(e.target)) return;
      recordChange(e.target);
      scheduleSave();
    },
    true
  );

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
