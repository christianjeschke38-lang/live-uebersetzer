import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import OpenAI from "openai";

if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");

const app = express();
const upload = multer({ dest: "uploads/" });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(express.static("public"));

function safeUnlink(p) {
  try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch {}
}
function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}
function trimContext(s, maxChars) {
  if (!s) return "";
  if (s.length <= maxChars) return s;
  return s.slice(s.length - maxChars);
}

// Kontext getrennt pro Richtung (ok für 1 Nutzer lokal)
let ctx_tn2de_src = "";
let ctx_tn2de_tgt = "";
let ctx_de2tn_src = "";
let ctx_de2tn_tgt = "";

// Filter: wenn Whisper aus “Geräusch” Unsinn macht
function looksLikeHallucination(transcript) {
  const t = (transcript || "").trim();
  if (!t) return true;

  // extrem lange outputs sind oft Müll bei Noise
  if (t.length > 260) return true;

  // häufige “Werbe”-Phrasen
  const lower = t.toLowerCase();
  const blacklist = [
    "abonniert den kanal", "abonniere den kanal", "subscribe",
    "like und abonnieren", "lasst ein like da", "folgt mir", "folgt uns",
    "klingel aktivieren"
  ];
  if (blacklist.some(b => lower.includes(b))) return true;

  return false;
}

app.post("/audio", upload.single("audio"), async (req, res) => {
  let fixedPath = null;

  try {
    const direction = (req.body?.direction || "tn2de").toString(); // tn2de | de2tn
    if (!["tn2de", "de2tn"].includes(direction)) {
      safeUnlink(req.file?.path);
      return res.status(400).json({ error: "Ungültige direction" });
    }

    // Wir erwarten WAV (vom Browser)
    const originalPath = req.file.path;
    fixedPath = `${originalPath}.wav`;
    fs.renameSync(originalPath, fixedPath);

    console.log("📥 Datei:", fixedPath, req.file.size, "mime:", req.file.mimetype, "dir:", direction);

    const sttLanguage = direction === "tn2de" ? "ar" : "de";
    const sttPrompt =
      direction === "tn2de"
        ? "Tunesisch-Arabisch (Darija/Tounsi). Wenn nur Geräusch/Knacken/Hall oder unverständlich: gib leer zurück."
        : "Deutsch (Umgangssprache). Wenn nur Geräusch/Knacken/Hall oder unverständlich: gib leer zurück.";

    const stt = await openai.audio.transcriptions.create({
      file: fs.createReadStream(fixedPath),
      model: "whisper-1",
      language: sttLanguage,
      prompt: sttPrompt
    });

    safeUnlink(fixedPath);

    const transcript = (stt.text || "").trim();
    console.log("📝 STT:", transcript);

    if (looksLikeHallucination(transcript) || transcript.length < 2) {
      return res.json({
        direction,
        ignored: true,
        source_text: "",
        source_latin: "",
        target_de: "",
        target_arabic: "",
        target_latin: ""
      });
    }

    // Kontext wählen
    let ctxSrc = direction === "tn2de" ? ctx_tn2de_src : ctx_de2tn_src;
    let ctxTgt = direction === "tn2de" ? ctx_tn2de_tgt : ctx_de2tn_tgt;

    const userPrompt =
      direction === "tn2de"
        ? `
Aufgabe: Live-Übersetzung Tunesisch-Arabisch (Darija/Tounsi) -> Deutsch.

Gib Output als reines JSON (ohne Markdown) mit keys:
- source_latin  (Romanisierung der QUELLE)
- target_de     (deutsche Übersetzung)
- target_arabic ("" lassen)
- target_latin  ("" lassen)

Regeln:
- Wenn der Text unklar/fragwürdig ist: alle Felder = "".
- source_latin: gut lesbare Tounsi-Umschrift (z.B. chnowa, aalech, mouch, barcha).
- target_de: kurz, natürlich, nutze Kontext.

Kontext (Quelle, vorher):
${ctxSrc}

Kontext (Ziel, vorher):
${ctxTgt}

Neuer Text:
${transcript}
`.trim()
        : `
Aufgabe: Live-Übersetzung Deutsch -> Tunesische Darija (Tounsi).

Gib Output als reines JSON (ohne Markdown) mit keys:
- source_latin  ("" lassen)
- target_arabic (Darija in arabischer Schrift, wenn möglich)
- target_latin  (Romanisierung/Tounsi-Umschrift)
- target_de     ("" lassen)

Regeln:
- Wenn der Text unklar/fragwürdig ist: alle Felder = "".
- Natürlich, Alltagssprache in Tunesien.
- Keine langen Erklärungen.

Kontext (Quelle, vorher):
${ctxSrc}

Kontext (Ziel, vorher):
${ctxTgt}

Neuer Text:
${transcript}
`.trim();

    const r = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            direction === "tn2de"
              ? "Du bist ein präziser Live-Übersetzer für tunesische Darija ins Deutsche."
              : "Du bist ein präziser Live-Übersetzer von Deutsch nach tunesischer Darija."
        },
        { role: "user", content: userPrompt }
      ]
    });

    const raw = (r.choices?.[0]?.message?.content || "").trim();
    const parsed = safeJsonParse(raw) || {};

    const source_latin = (parsed.source_latin || "").toString().trim();
    const target_de = (parsed.target_de || "").toString().trim();
    const target_arabic = (parsed.target_arabic || "").toString().trim();
    const target_latin = (parsed.target_latin || "").toString().trim();

    // Safety: wenn Model Quatsch liefert -> ignorieren
    if (![source_latin, target_de, target_arabic, target_latin].join("").trim()) {
      return res.json({
        direction,
        ignored: true,
        source_text: "",
        source_latin: "",
        target_de: "",
        target_arabic: "",
        target_latin: ""
      });
    }

    // Kontext updaten
    if (direction === "tn2de") {
      ctx_tn2de_src = trimContext((ctx_tn2de_src + "\n" + transcript).trim(), 1200);
      if (target_de) ctx_tn2de_tgt = trimContext((ctx_tn2de_tgt + "\n" + target_de).trim(), 1200);
    } else {
      ctx_de2tn_src = trimContext((ctx_de2tn_src + "\n" + transcript).trim(), 1200);
      const combined = [target_arabic, target_latin].filter(Boolean).join(" / ");
      if (combined) ctx_de2tn_tgt = trimContext((ctx_de2tn_tgt + "\n" + combined).trim(), 1200);
    }

    return res.json({
      direction,
      ignored: false,
      source_text: transcript,
      source_latin,
      target_de,
      target_arabic,
      target_latin
    });

  } catch (e) {
    console.error("❌ Server Fehler:", e);
    safeUnlink(fixedPath);
    return res.status(500).json({ error: "Fehler beim Verarbeiten" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("✅ Server läuft auf Port", PORT));