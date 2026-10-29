/* Transportbegleitung Wiedemann – Offline-App.
 * Berichte liegen im localStorage des Tablets und werden bei jeder Eingabe automatisch gespeichert.
 * "Senden" erzeugt das PDF im Gerät und schickt es direkt per E-Mail über unseren Server (Cloudflare
 * Worker + Resend) – ohne Mail-App auf dem Tablet. Ohne Internet bleibt der Bericht in einer
 * Warteschlange und wird automatisch nachgesendet, sobald wieder Netz da ist. */
(function () {
  "use strict";

  const CONFIG = {
    title: "Transportbegleitung Wiedemann",
    apiUrl: "https://transportbegleitung-mail.david-groeschl.workers.dev/send",
    apiToken: "f_4ZMiozdqpckuokDPbCFPrHtK4OqEDlMU9uguG7A08",
    version: "3.1",
  };
  const KEY = "bb:report:";
  const REQUIRED = {
    firma: "Firma / Auftraggeber",
    lkw_kennzeichen: "LKW-Kennzeichen",
    von_datum: "Datum",
    unterschrift_begleitfahrer: "Unterschrift Begleitfahrer",
  };
  const PLATE_PREFIX = "SHA-WT";
  const KM_COLS = [["lkw", "LKW"], ["bf2", "BF2"], ["bf3", "BF3"], ["bf4", "BF4"]];
  const KM_ROWS = [["anfang", "Anfang"], ["ende", "Ende"], ["gesamt", "Gesamt-km"]];

  // ------------------------------------------------------------------ Formular-Beschreibung
  // w = Breite auf dem Tablet (von 12), n = Breite auf schmalen Displays
  const f = (name, label, o) => Object.assign({ name, label, type: "text", w: 6, n: 12, cap: "words" }, o);

  const SECTIONS = [
    {
      fields: [
        f("firma", "Firma / Auftraggeber", { w: 12 }),
        f("lkw_kennzeichen", "LKW mit amtl. Kennzeichen-Nr.", { w: 12, cap: "characters" }),
      ],
    },
    {
      title: "Begleitfahrzeuge · amtl. Kennzeichen-Nr.",
      fields: [1, 2, 3].map((i) =>
        f(`begleit_kennzeichen_${i}`, `Begleitfahrzeug ${i}`, { w: 4, n: 12, type: "plated", prefix: PLATE_PREFIX, cap: "characters" })
      ),
    },
    { title: "Art der Begleitung", checks: [["transportbegleitung", "Transportbegleitung"], ["schilderdienst", "Schilderdienst"]] },
    {
      title: "Strecke",
      groups: [
        { sub: "Von", fields: [
          f("von_ort", "Von", { w: 12 }),
          f("von_datum", "Datum", { type: "date" }),
          f("von_uhrzeit", "Uhrzeit", { type: "time" }),
        ] },
        { sub: "Nach", fields: [
          f("nach_ort", "Nach", { w: 12 }),
          f("nach_datum", "Datum", { type: "date" }),
          f("nach_uhrzeit", "Uhrzeit", { type: "time" }),
        ] },
      ],
    },
    { title: "Begleit-Kilometer", table: true },
    {
      title: "Bemerkung & Auftragsnr.",
      fields: [
        f("bemerkung", "Bemerkung", { w: 12, type: "textarea", cap: "sentences" }),
        f("auftragsnr", "Auftragsnr.", { w: 6, cap: "none" }),
      ],
    },
    {
      title: "Unterschriften",
      fields: [
        f("unterschrift_begleitfahrer", "Unterschrift Begleitfahrer (Name)"),
        f("unterschrift_transportfahrer", "Unterschrift Transport-Fahrer (Name)"),
      ],
    },
  ];
  const MAX_REMARK = 1500;

  // ------------------------------------------------------------------ Hilfsfunktionen
  const $ = (sel, root) => (root || document).querySelector(sel);
  const app = $("#app");
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const clean = (v) => String(v == null ? "" : v).trim();
  const two = (n) => String(n).padStart(2, "0");
  const fmtDate = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(iso || "") ? iso.split("-").reverse().join(".") : clean(iso));
  const fmtTime = (ts) => { const d = new Date(ts); return `${two(d.getHours())}:${two(d.getMinutes())}`; };
  const fmtDateTime = (ts) => { const d = new Date(ts); return `${two(d.getDate())}.${two(d.getMonth() + 1)}. ${fmtTime(ts)}`; };
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`; };
  const num = (v) => { const n = parseFloat(String(v).replace(/\s/g, "").replace(",", ".")); return isNaN(n) ? null : n; };

  function toast(msg, ms) {
    const t = $("#toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => (t.hidden = true), ms || 4000);
  }

  // ------------------------------------------------------------------ Speicher
  let storageOk = true;
  function loadAll() {
    const out = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(KEY)) {
          try { out.push(JSON.parse(localStorage.getItem(k))); } catch (e) { /* defekten Eintrag überspringen */ }
        }
      }
    } catch (e) { storageOk = false; }
    return out.filter((r) => r && r.id).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  function loadOne(id) {
    try { return JSON.parse(localStorage.getItem(KEY + id)); } catch (e) { return null; }
  }
  function saveReport(r, touch) {
    if (touch !== false) r.updatedAt = Date.now();
    try {
      localStorage.setItem(KEY + r.id, JSON.stringify(r));
      storageOk = true;
    } catch (e) { storageOk = false; }
    return storageOk;
  }
  function newReport() {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const r = { id, createdAt: Date.now(), updatedAt: Date.now(), sentAt: null, pendingSend: false, data: { von_datum: today() } };
    saveReport(r);
    return r;
  }
  function statusOf(r) {
    const sentAt = r.sentAt || r.sharedAt || null; // r.sharedAt: Altlast aus Vorversion, falls noch vorhanden
    if (r.pendingSend) return { key: "pending", text: "Wartet auf Versand" };
    if (!sentAt) return { key: "draft", text: "Entwurf" };
    if (r.updatedAt > sentAt + 1000) return { key: "changed", text: "Geändert nach Senden" };
    return { key: "sent", text: "Gesendet" };
  }

  // ------------------------------------------------------------------ Liste
  let installPrompt = null;

  function showList() {
    current = null;
    const reports = loadAll();
    const rows = reports.map((r) => {
      const d = r.data || {};
      const st = statusOf(r);
      const title = clean(d.auftragsnr) ? `Auftrag ${esc(d.auftragsnr)}` : (clean(d.firma) ? esc(d.firma) : "Ohne Auftragsnr.");
      const sub = [fmtDate(d.von_datum), clean(d.lkw_kennzeichen), clean(d.von_ort)].filter(Boolean).map(esc).join(" · ");
      const sentAt = r.sentAt || r.sharedAt || null;
      const when = st.key === "pending" ? `wartet auf Versand · zuletzt bearbeitet ${fmtDateTime(r.updatedAt)}`
        : st.key === "draft" ? `bearbeitet ${fmtDateTime(r.updatedAt)}`
        : `gesendet ${fmtDateTime(sentAt)}`;
      return `<a class="item" href="#/r/${r.id}"><span class="item-main"><b>${title}</b><span>${sub || "&nbsp;"}</span><small>${when}</small></span><span class="chip ${st.key}">${st.text}</span></a>`;
    }).join("");

    app.innerHTML = `
      <section class="list">
        ${storageOk ? "" : `<div class="banner error">Speichern auf diesem Gerät ist nicht möglich. Berichte gehen beim Schließen verloren!</div>`}
        <button class="btn primary big" id="new">+ Neuer Bericht</button>
        ${installPrompt ? `<button class="btn" id="install">App auf dem Startbildschirm installieren</button>` : ""}
        <h2>Meine Berichte</h2>
        ${rows || `<p class="empty">Noch keine Berichte. Tippe auf „Neuer Bericht“.</p>`}
        <p class="note">Berichte werden automatisch auf diesem Tablet gespeichert und bleiben erhalten, bis du sie löschst.
        „Gesendet“ heißt: die E-Mail wurde über unseren Server verschickt. Ohne Internet bleibt ein Bericht auf
        „Wartet auf Versand“ und wird automatisch nachgesendet, sobald wieder Netz da ist.</p>
      </section>`;
    $("#new").onclick = () => { const r = newReport(); location.hash = "#/r/" + r.id; };
    const inst = $("#install");
    if (inst) inst.onclick = async () => { installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; showList(); };
  }

  // ------------------------------------------------------------------ Formular
  let current = null;
  let saveTimer = null;

  function fieldHtml(fd, data) {
    const v = data[fd.name] == null ? "" : data[fd.name];
    const style = `style="--w:${fd.w};--n:${fd.n}"`;
    let input;
    if (fd.type === "textarea") {
      input = `<textarea name="${fd.name}" rows="5" maxlength="${MAX_REMARK}" autocapitalize="${fd.cap}">${esc(v)}</textarea><span class="count" id="count"></span>`;
    } else if (fd.type === "plated") {
      input = `<div class="platewrap"><span class="plate">${esc(fd.prefix)}</span><input type="text" name="${fd.name}" value="${esc(v)}" autocomplete="off" spellcheck="false" autocapitalize="${fd.cap}"></div>`;
    } else {
      input = `<input type="${fd.type}" name="${fd.name}" value="${esc(v)}" autocomplete="off" spellcheck="false" autocapitalize="${fd.cap || "off"}"${fd.mode ? ` inputmode="${fd.mode}"` : ""}>`;
    }
    return `<label class="field" ${style}><span class="lbl">${esc(fd.label)}</span>${input}</label>`;
  }

  function kmTableHtml(data) {
    const cell = (row, col, readonly) => {
      const name = `km_${row}_${col}`;
      const v = data[name] == null ? "" : data[name];
      return `<td><input type="text" inputmode="numeric" autocomplete="off" name="${name}" value="${esc(v)}"${readonly ? " readonly tabindex=\"-1\" class=\"computed\"" : ""}></td>`;
    };
    const head = KM_COLS.map(([key, lab]) => {
      if (key === "lkw") return `<th>${esc(lab)}</th>`;
      const name = `${key}_fahrzeug`;
      const v = data[name] || "";
      const opts = ["", "1", "2", "3"].map((o) => `<option value="${o}"${v === o ? " selected" : ""}>${o || "–"}</option>`).join("");
      return `<th><span class="kmhead">${esc(lab)}<select name="${name}" class="kmselect" aria-label="Fahrzeug-Nr. für ${esc(lab)}">${opts}</select></span></th>`;
    }).join("");
    const rows = KM_ROWS.map(([rk, rlab]) =>
      `<tr><th class="rowlab">${esc(rlab)}</th>${KM_COLS.map(([ck]) => cell(rk, ck, rk === "gesamt")).join("")}</tr>`
    ).join("");
    return `<div class="kmtable"><table><thead><tr><th></th>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  function showForm(id) {
    const r = loadOne(id);
    if (!r) { location.hash = "#/"; return; }
    current = r;
    r.data = r.data || {};

    const body = SECTIONS.map((s) => {
      let inner = "";
      if (s.fields) inner = `<div class="grid">${s.fields.map((fd) => fieldHtml(fd, r.data)).join("")}</div>`;
      if (s.checks) {
        const oneCheck = s.checks.length === 1;
        inner = `<div class="checks${oneCheck ? " checks-1" : ""}">${s.checks.map(([k, label]) =>
          `<label class="check"><input type="checkbox" name="begleitart_${k}"${r.data["begleitart_" + k] ? " checked" : ""}><span>${esc(label)}</span></label>`).join("")}</div>`;
      }
      if (s.groups) {
        inner = s.groups.map((g) => `<h4>${esc(g.sub)}</h4><div class="grid">${g.fields.map((fd) => fieldHtml(fd, r.data)).join("")}</div>`).join("");
      }
      if (s.table) inner = kmTableHtml(r.data);
      return `<section class="card">${s.title ? `<h3>${esc(s.title)}</h3>` : ""}${inner}</section>`;
    }).join("");

    app.innerHTML = `
      <form id="form" class="form" autocomplete="off" onsubmit="return false">
        ${storageOk ? "" : `<div class="banner error">Speichern auf diesem Gerät ist nicht möglich!</div>`}
        ${body}
        <div class="card danger-zone"><button type="button" class="link danger" id="delete">Bericht löschen</button></div>
      </form>
      <div class="bar">
        <a class="btn back" href="#/">‹ Liste</a>
        <span class="status" id="status"></span>
        <button class="btn" id="save-pdf" type="button">PDF speichern</button>
        <button class="btn primary" id="send" type="button">Senden</button>
      </div>`;

    updateStatus(true);
    updateCount();
    const form = $("#form");
    form.addEventListener("input", onInput);
    $("#send").onclick = send;
    $("#save-pdf").onclick = savePdf;
    $("#delete").onclick = deleteReport;
  }

  function onInput(e) {
    const el = e.target;
    if (!el.name) return;
    current.data[el.name] = el.type === "checkbox" ? el.checked : el.value;

    const m = el.name.match(/^km_(anfang|ende)_(\w+)$/);
    if (m) {
      const col = m[2];
      const a = num(current.data[`km_anfang_${col}`]), b = num(current.data[`km_ende_${col}`]);
      const total = a !== null && b !== null ? String(Math.round((b - a) * 10) / 10).replace(".", ",") : "";
      current.data[`km_gesamt_${col}`] = total;
      const out = $(`[name="km_gesamt_${col}"]`);
      if (out) out.value = total;
    }
    if (el.name === "bemerkung") updateCount();
    scheduleSave();
  }

  function updateCount() {
    const c = $("#count"), t = $('[name="bemerkung"]');
    if (!c || !t) return;
    const n = t.value.length;
    c.textContent = n > MAX_REMARK * 0.8 ? `${n} / ${MAX_REMARK} Zeichen` : "";
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    updateStatus(false);
    saveTimer = setTimeout(doSave, 300);
  }
  function doSave() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!current) return;
    saveReport(current);
    updateStatus(true);
  }
  function flushSave() { if (saveTimer) doSave(); }

  function updateStatus(saved) {
    const el = $("#status");
    if (!el || !current) return;
    if (!storageOk) { el.textContent = "Nicht gespeichert!"; el.className = "status bad"; return; }
    const st = statusOf(current);
    el.className = "status";
    el.textContent = saved ? `✓ Gespeichert ${fmtTime(current.updatedAt)} · ${st.text}` : "Speichert …";
  }

  // ------------------------------------------------------------------ PDF
  let templateBytes = null;
  async function buildPdfFile(data) {
    if (!templateBytes) {
      const res = await fetch("template.pdf");
      if (!res.ok) throw new Error("Vorlage nicht gefunden (template.pdf)");
      templateBytes = await res.arrayBuffer();
    }
    const d = Object.assign({}, data);
    d.von_datum = fmtDate(d.von_datum);
    d.nach_datum = fmtDate(d.nach_datum);
    const bytes = await WBPdf.buildPdf(PDFLib, templateBytes, d);
    const safe = (s) => clean(s).replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
    const name = ["Transportbegleitung", safe(data.auftragsnr), safe(fmtDate(data.von_datum))].filter(Boolean).join("_") + ".pdf";
    return new File([bytes], name, { type: "application/pdf" });
  }

  function mailPartsFor(d) {
    const subject = CONFIG.title + (clean(d.auftragsnr) ? " - " + clean(d.auftragsnr) : "");
    const lines = [
      ["Firma / Auftraggeber", d.firma], ["LKW-Kennzeichen", d.lkw_kennzeichen],
      ["Von", [d.von_ort, fmtDate(d.von_datum), d.von_uhrzeit].filter(clean).join(", ")],
      ["Nach", [d.nach_ort, fmtDate(d.nach_datum), d.nach_uhrzeit].filter(clean).join(", ")],
      ["Auftragsnr.", d.auftragsnr], ["Bemerkung", d.bemerkung],
    ].filter(([, v]) => clean(v)).map(([k, v]) => `${k}: ${clean(v)}`);
    return { subject, body: lines.join("\n") + "\n\n(Das ausgefüllte Formular ist als PDF angehängt.)" };
  }

  function setBusy(busy, label) {
    ["send", "save-pdf"].forEach((id) => { const b = document.getElementById(id); if (b) b.disabled = busy; });
    const s = $("#send");
    if (s) s.textContent = busy ? (label || "Bitte warten …") : "Senden";
  }

  function download(file) {
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url; a.download = file.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  function pdfError(e) {
    console.error(e);
    alert("Das PDF konnte nicht erstellt werden.\n\n" + (e && e.message ? e.message : e) + "\n\nDer Bericht ist trotzdem gespeichert.");
  }

  // ------------------------------------------------------------------ Senden (direkt per Server)
  async function sendViaApi(file, subject, text) {
    if (!CONFIG.apiUrl) throw new Error("not_configured");
    const fd = new FormData();
    fd.append("pdf", file, file.name);
    fd.append("subject", subject);
    fd.append("text", text);
    fd.append("filename", file.name);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    let res;
    try {
      res = await fetch(CONFIG.apiUrl, {
        method: "POST",
        headers: { "Authorization": `Bearer ${CONFIG.apiToken}` },
        body: fd,
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new Error(e && e.name === "AbortError" ? "timeout" : "network");
    } finally {
      clearTimeout(timer);
    }
    let data = null;
    try { data = await res.json(); } catch (e) { /* ignorieren */ }
    if (!res.ok || !data || !data.ok) throw new Error((data && data.error) || `http_${res.status}`);
  }

  async function savePdf() {
    flushSave();
    setBusy(true, "Erstelle PDF …");
    try {
      const file = await buildPdfFile(current.data);
      download(file);
      toast("PDF gespeichert (Ordner „Downloads“).");
    } catch (e) { pdfError(e); } finally { setBusy(false); }
  }

  async function send() {
    flushSave();
    const missing = Object.keys(REQUIRED).filter((k) => !clean(current.data[k])).map((k) => REQUIRED[k]);
    if (missing.length) {
      alert("Bitte zuerst ausfüllen, dann senden:\n• " + missing.join("\n• "));
      return;
    }

    setBusy(true, "Erstelle PDF …");
    let file;
    try {
      file = await buildPdfFile(current.data);
    } catch (e) { pdfError(e); setBusy(false); return; }

    setBusy(true, "Sende …");
    const { subject, body } = mailPartsFor(current.data);
    try {
      await sendViaApi(file, subject, body);
      current.pendingSend = false;
      current.sentAt = Date.now();
      current.lastError = null;
      current.updatedAt = current.sentAt;
      saveReport(current, false);
      updateStatus(true);
      toast("Gesendet.");
    } catch (e) {
      console.warn("Senden fehlgeschlagen, wird automatisch erneut versucht:", e);
      current.pendingSend = true;
      current.lastError = (e && e.message) || "Fehler";
      saveReport(current);
      updateStatus(true);
      toast(navigator.onLine ? "Senden hat nicht geklappt. Wird automatisch erneut versucht." : "Kein Internet. Wird automatisch gesendet, sobald wieder Netz da ist.", 6000);
    } finally {
      setBusy(false);
    }
  }

  // Automatischer Nachversand für Berichte, die noch in der Warteschlange stehen.
  let retrying = false;
  async function retryPending() {
    if (retrying || !navigator.onLine || !CONFIG.apiUrl) return;
    retrying = true;
    try {
      const pending = loadAll().filter((r) => r.pendingSend);
      for (const r of pending) {
        const saved = loadOne(r.id); // neuester Stand, falls der Bericht zwischenzeitlich bearbeitet wurde
        if (!saved || !saved.pendingSend) continue;
        try {
          const file = await buildPdfFile(saved.data);
          const { subject, body } = mailPartsFor(saved.data);
          await sendViaApi(file, subject, body);
          saved.pendingSend = false;
          saved.sentAt = Date.now();
          saved.lastError = null;
          saved.updatedAt = saved.sentAt;
          saveReport(saved, false);
          if (current && current.id === saved.id) { current = saved; updateStatus(true); }
          if (!location.hash || location.hash === "#/") showList();
        } catch (e) {
          console.warn("Automatischer Versand fehlgeschlagen für", r.id, e);
          // bleibt in der Warteschlange, nächster Versuch beim nächsten Online-Ereignis
        }
      }
    } finally {
      retrying = false;
    }
  }

  function deleteReport() {
    const unsent = statusOf(current).key !== "sent";
    const msg = (unsent ? "ACHTUNG: Dieser Bericht wurde noch nicht gesendet!\n\n" : "") + "Bericht wirklich löschen? Das kann nicht rückgängig gemacht werden.";
    if (!confirm(msg)) return;
    try { localStorage.removeItem(KEY + current.id); } catch (e) { /* ignorieren */ }
    current = null;
    location.hash = "#/";
  }

  // ------------------------------------------------------------------ Start
  function route() {
    flushSave();
    const m = location.hash.match(/^#\/r\/([\w-]+)$/);
    if (m) showForm(m[1]); else showList();
    window.scrollTo(0, 0);
  }

  function updateOnline() {
    $("#offline").hidden = navigator.onLine;
    if (navigator.onLine) retryPending();
  }

  window.addEventListener("hashchange", route);
  window.addEventListener("pagehide", flushSave);
  document.addEventListener("visibilitychange", () => { if (document.hidden) flushSave(); });
  window.addEventListener("online", updateOnline);
  window.addEventListener("offline", updateOnline);
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installPrompt = e; if (!current) showList(); });
  window.addEventListener("appinstalled", () => { installPrompt = null; if (!current) showList(); });
  setInterval(() => { if (navigator.onLine) retryPending(); }, 120000); // Sicherheitsnetz, falls ein Versuch leise durchrutscht

  $("#version").textContent = "v" + CONFIG.version;
  updateOnline();
  route();

  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch((e) => console.warn("Service Worker:", e));
})();
