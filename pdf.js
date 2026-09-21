/* Befüllt die PDF-Vorlage (template.pdf) mit den Berichtsdaten – komplett offline, mit pdf-lib. */
(function (root) {
  "use strict";

  // Standard-Helvetica kann nur WinAnsi (Latin-1 + ein paar Zeichen). Alles andere wird
  // sinnvoll umgeschrieben (z. B. ł -> l, ğ -> g), damit nie ein Fehler beim Erzeugen auftritt.
  const WIN_ANSI_EXTRA = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
  const SPECIAL = { "ł": "l", "Ł": "L", "đ": "d", "Đ": "D", "ı": "i", "İ": "I" };

  function toWinAnsi(input) {
    let out = "";
    for (const ch of String(input == null ? "" : input)) {
      const cp = ch.codePointAt(0);
      if (ch === "\n") { out += "\n"; continue; }
      if (cp < 0x20) continue;
      if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) || WIN_ANSI_EXTRA.includes(ch)) {
        out += ch; continue;
      }
      if (SPECIAL[ch]) { out += SPECIAL[ch]; continue; }
      const base = ch.normalize("NFD").replace(/[̀-ͯ]/g, "");
      out += base !== ch && /^[\x20-\x7e\xa0-\xff]+$/.test(base) ? base : "?";
    }
    return out;
  }

  // Zeilenumbruch nach Wortgrenzen, zählt die benötigten Zeilen
  function countLines(font, text, size, width) {
    let lines = 0;
    for (const para of text.split("\n")) {
      let line = "";
      let n = 1;
      for (const word of para.split(" ")) {
        const test = line ? line + " " + word : word;
        if (font.widthOfTextAtSize(test, size) <= width || !line) line = test;
        else { n++; line = word; }
      }
      lines += n;
    }
    return lines;
  }

  async function buildPdf(PDFLib, templateBytes, data) {
    const { PDFDocument, PDFTextField, PDFCheckBox, StandardFonts } = PDFLib;
    const doc = await PDFDocument.load(templateBytes, { updateMetadata: false });
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const form = doc.getForm();

    for (const field of form.getFields()) {
      const name = field.getName();
      if (field instanceof PDFCheckBox) {
        if (data[name]) field.check();
        continue;
      }
      if (!(field instanceof PDFTextField)) continue;
      const text = toWinAnsi(data[name]).trim();
      if (!text) continue;

      const rect = field.acroField.getWidgets()[0].getRectangle();
      const width = rect.width - 8;
      let size = field.isMultiline() ? 10 : 9.5;
      if (field.isMultiline()) {
        // Schrift verkleinern, bis der Text ins Feld passt (Untergrenze 6,5 pt)
        while (size > 6.5 && countLines(font, text, size, width) * size * 1.2 > rect.height - 8) size -= 0.25;
      } else {
        while (size > 6 && font.widthOfTextAtSize(text, size) > width) size -= 0.25;
      }
      field.setFontSize(size);
      field.setText(text);
    }

    form.updateFieldAppearances(font);
    form.flatten();
    return doc.save();
  }

  root.WBPdf = { buildPdf, toWinAnsi };
})(typeof window !== "undefined" ? window : globalThis);
