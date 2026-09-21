/* Begleitbericht Wiedemann – Offline-App.
 * Berichte liegen im localStorage des Tablets und werden bei jeder Eingabe automatisch gespeichert.
 * "Senden" erzeugt das PDF im Gerät und übergibt es über das Android-Teilen-Menü (z. B. an Gmail). */
(function () {
  "use strict";

  const CONFIG = {
    title: "Begleitbericht Wiedemann",
    recipient: "david.groeschl@gmail.com", // nur für den Fallback (mailto:), Teilen-Menü kann keinen Empfänger vorgeben
    version: "1.0",
  };
  const KEY = "bb:report:";
  const REQUIRED = { best_nr: "Best. Nr.", transportdatum: "Transportdatum", fahrer_unterschrift_name: "Name des LKW-Fahrers" };

  // ------------------------------------------------------------------ Formular-Beschreibung
  // w = Breite auf dem Tablet (von 12), n = Breite auf schmalen Displays
  const f = (name, label, o) => Object.assign({ name, label, type: "text", w: 6, n: 12, cap: "words" }, o);
  const address = (p) => [
    f(p + "_firma", "Firma", { w: 12 }),
    f(p + "_strasse", "Straße", { w: 6 }),
    f(p + "_plz", "PLZ", { w: 2, n: 5, cap: "none", mode: "numeric" }),
    f(p + "_ort", "Ort", { w: 4, n: 7 }),
  ];
  const vehicles = [1, 2, 3].flatMap((i) => [
    f("kennzeichen_" + i, `Fahrzeug ${i} – Kennzeichen`, { cap: "characters" }),
    f("fahrer_" + i, `Fahrzeug ${i} – Fahrer`),
  ]);

  const SECTIONS = [
    { fields: [f("best_nr", "Best. Nr.", { cap: "none" }), f("transportdatum", "Transportdatum", { type: "date" })] },
    { title: "Fahrzeuge & Fahrer", fields: vehicles },
    {
      title: "Begleitart",
      checks: [["hipo", "HIPO"], ["bf4", "BF4"], ["bf3", "BF-3"], ["pausch", "pausch"], ["zus_bf", "zusätzl. BF"], ["beifahrer", "Beifahrer"]],
    },
    { title: "Auftraggeber", fields: address("ag") },
    { title: "Auftragsdaten", groups: [{ sub: "Übernahmeort", fields: address("uo") }, { sub: "Zielort", fields: address("zo") }] },
    {
      title: "Ladung & Fahrzeuge",
      fields: [
        f("ladegut", "Ladegut", { w: 12 }),
        f("lkw_1", "LKW-Nr. – 1. Fahrzeug", { cap: "characters" }),
        f("auflieger_1", "Auflieger-Nr. – 1. Fahrzeug", { cap: "characters" }),
        f("lkw_2", "LKW-Nr. – 2. Fahrzeug", { cap: "characters" }),
        f("auflieger_2", "Auflieger-Nr. – 2. Fahrzeug", { cap: "characters" }),
        f("genehm_nr", "Genehm.-Nr.", { cap: "none" }),
      ],
    },
    {
      title: "Abrechnungsdaten",
      fields: [
        f("km_anfang", "km-Stand Anfang", { w: 4, n: 6, cap: "none", mode: "numeric" }),
        f("km_ende", "km-Stand Ende", { w: 4, n: 6, cap: "none", mode: "numeric" }),
        f("km_gesamt", "km gesamt (automatisch)", { w: 4, n: 12, type: "computed" }),
        f("sonderfahrten", "Sonderfahrten (km)", { cap: "none", mode: "numeric", n: 6 }),
        f("hoehe", "Festgestellte Höhe (m)", { cap: "none", mode: "decimal", n: 6 }),
      ],
    },
    {
      title: "Bemerkung & Unterschrift",
      fields: [
        f("bemerkung", "Bemerkung", { w: 12, type: "textarea", cap: "sentences" }),
        f("fahrer_unterschrift_name", "Unterschrift LKW-Fahrer – Name in Druckbuchstaben", { w: 12 }),
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
    const r = { id, createdAt: Date.now(), updatedAt: Date.now(), sharedAt: null, data: { transportdatum: today() } };
    saveReport(r);
    return r;
  }
  function statusOf(r) {
    if (!r.sharedAt) return { key: "draft", text: "Entwurf" };
    if (r.updatedAt > r.sharedAt + 1000) return { key: "changed", text: "Geändert nach Senden" };
    return { key: "shared", text: "Geteilt" };
  }

  // ------------------------------------------------------------------ Liste
  let installPrompt = null;

  function showList() {
    current = null;
    const reports = loadAll();
    const rows = reports.map((r) => {
      const d = r.data || {};
      const st = statusOf(r);
      const title = clean(d.best_nr) ? `Best. Nr. ${esc(d.best_nr)}` : "Ohne Best. Nr.";
      const sub = [fmtDate(d.transportdatum), clean(d.fahrer_1), clean(d.kennzeichen_1)].filter(Boolean).map(esc).join(" · ");
      const when = st.key === "draft" ? `bearbeitet ${fmtDateTime(r.updatedAt)}` : `geteilt ${fmtDateTime(r.sharedAt)}`;
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
        „Geteilt“ heißt: an Gmail übergeben. Ob die Mail versendet wurde, siehst du in Gmail (Postausgang/Gesendet).</p>
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
      input = `<textarea name="${fd.name}" rows="6" maxlength="${MAX_REMARK}" autocapitalize="${fd.cap}">${esc(v)}</textarea><span class="count" id="count"></span>`;
    } else if (fd.type === "computed") {
      input = `<input name="${fd.name}" value="${esc(v)}" readonly tabindex="-1">`;
    } else {
      input = `<input type="${fd.type}" name="${fd.name}" value="${esc(v)}" autocomplete="off" spellcheck="false" autocapitalize="${fd.cap}"${fd.mode ? ` inputmode="${fd.mode}"` : ""}>`;
    }
    return `<label class="field${fd.type === "computed" ? " computed" : ""}" ${style}><span class="lbl">${esc(fd.label)}</span>${input}</label>`;
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
        inner = `<div class="checks">${s.checks.map(([k, label]) =>
          `<label class="check"><input type="checkbox" name="begleitart_${k}"${r.data["begleitart_" + k] ? " checked" : ""}><span>${esc(label)}</span></label>`).join("")}</div>`;
      }
      if (s.groups) {
        inner = s.groups.map((g) => `<h4>${esc(g.sub)}</h4><div class="grid">${g.fields.map((fd) => fieldHtml(fd, r.data)).join("")}</div>`).join("");
      }
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
    if (el.name === "km_anfang" || el.name === "km_ende") {
      const a = num(current.data.km_anfang), b = num(current.data.km_ende);
      const total = a !== null && b !== null ? String(Math.round((b - a) * 10) / 10).replace(".", ",") : "";
      current.data.km_gesamt = total;
      const out = $('[name="km_gesamt"]');
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

  // ------------------------------------------------------------------ PDF / Senden
  let templateBytes = null;
  async function makePdf() {
    if (!templateBytes) {
      const res = await fetch("template.pdf");
      if (!res.ok) throw new Error("Vorlage nicht gefunden (template.pdf)");
      templateBytes = await res.arrayBuffer();
    }
    const d = Object.assign({}, current.data);
    d.transportdatum = fmtDate(d.transportdatum);
    const bytes = await WBPdf.buildPdf(PDFLib, templateBytes, d);
    const safe = (s) => clean(s).replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
    const name = ["Begleitbericht", safe(current.data.best_nr), safe(fmtDate(current.data.transportdatum))].filter(Boolean).join("_") + ".pdf";
    return new File([bytes], name, { type: "application/pdf" });
  }

  function mailParts() {
    const d = current.data;
    const subject = CONFIG.title + (clean(d.best_nr) ? " - " + clean(d.best_nr) : "");
    const begleit = SECTIONS[2].checks.filter(([k]) => d["begleitart_" + k]).map(([, l]) => l).join(", ");
    const lines = [
      ["Best. Nr.", d.best_nr], ["Transportdatum", fmtDate(d.transportdatum)], ["Fahrer", d.fahrer_1],
      ["Kennzeichen", d.kennzeichen_1], ["Begleitart", begleit], ["Bemerkung", d.bemerkung],
    ].filter(([, v]) => clean(v)).map(([k, v]) => `${k}: ${clean(v)}`);
    return { subject, body: lines.join("\n") + "\n\n(Das ausgefüllte Formular ist als PDF angehängt.)" };
  }

  function setBusy(busy) {
    ["send", "save-pdf"].forEach((id) => { const b = document.getElementById(id); if (b) b.disabled = busy; });
    const s = $("#send");
    if (s) s.textContent = busy ? "Erstelle PDF …" : "Senden";
  }

  function download(file) {
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url; a.download = file.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  async function savePdf() {
    flushSave();
    setBusy(true);
    try {
      const file = await makePdf();
      download(file);
      toast("PDF gespeichert (Ordner „Downloads“).");
    } catch (e) { pdfError(e); } finally { setBusy(false); }
  }

  async function send() {
    flushSave();
    const missing = Object.keys(REQUIRED).filter((k) => !clean(current.data[k])).map((k) => REQUIRED[k]);
    if (missing.length && !confirm("Es fehlen noch Angaben:\n• " + missing.join("\n• ") + "\n\nTrotzdem senden?")) return;
    setBusy(true);
    try {
      const file = await makePdf();
      const { subject, body } = mailParts();
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: subject, text: body });
          current.sharedAt = Date.now();
          current.updatedAt = current.sharedAt;
          saveReport(current, false);
          updateStatus(true);
          toast("An Gmail übergeben. Bitte dort noch „Senden“ tippen.", 6000);
        } catch (e) {
          if (e && e.name === "AbortError") toast("Abgebrochen. Der Bericht bleibt gespeichert.");
          else throw e;
        }
      } else {
        // Fallback (z. B. Desktop): PDF speichern und E-Mail-Entwurf öffnen, PDF muss angehängt werden
        download(file);
        toast("PDF gespeichert. Bitte in der E-Mail anhängen.", 7000);
        setTimeout(() => {
          location.href = `mailto:${CONFIG.recipient}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
        }, 800);
      }
    } catch (e) { pdfError(e); } finally { setBusy(false); }
  }

  function pdfError(e) {
    console.error(e);
    alert("Das PDF konnte nicht erstellt werden.\n\n" + (e && e.message ? e.message : e) + "\n\nDer Bericht ist trotzdem gespeichert.");
  }

  function deleteReport() {
    const unsent = statusOf(current).key !== "shared";
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

  function updateOnline() { $("#offline").hidden = navigator.onLine; }

  window.addEventListener("hashchange", route);
  window.addEventListener("pagehide", flushSave);
  document.addEventListener("visibilitychange", () => { if (document.hidden) flushSave(); });
  window.addEventListener("online", updateOnline);
  window.addEventListener("offline", updateOnline);
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installPrompt = e; if (!current) showList(); });
  window.addEventListener("appinstalled", () => { installPrompt = null; if (!current) showList(); });

  $("#version").textContent = "v" + CONFIG.version;
  updateOnline();
  route();

  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch((e) => console.warn("Service Worker:", e));
})();
