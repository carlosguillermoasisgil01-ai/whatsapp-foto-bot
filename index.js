const express = require("express");
const twilio = require("twilio");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const TZ = "Europe/Madrid";
const FOUR_HOURS = 4 * 60 * 60 * 1000;
const THIRTY_MIN = 30 * 60 * 1000;

// Estado en memoria (MVP)
const users = {};
// users[user] = { day: "YYYY-MM-DD", done: bool, awaiting: bool, nextAsk: number }

function madridDay(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function madridHM(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const hh = Number(parts.find((p) => p.type === "hour").value);
  const mm = Number(parts.find((p) => p.type === "minute").value);
  return { hh, mm };
}

function inWindow(date = new Date()) {
  const { hh } = madridHM(date);
  // 08:00 a 23:59
  if (hh < 8) return false;
  if (hh > 23) return false;
  return true;
}

function msUntilNext08(now = new Date()) {
  const start = now.getTime();
  let t = new Date(start);

  for (let i = 0; i < 60 * 48; i++) {
    const { hh, mm } = madridHM(t);
    if (hh === 8 && mm === 0 && t.getTime() > start) return t.getTime() - start;
    t = new Date(t.getTime() + 60 * 1000);
  }
  return 24 * 60 * 60 * 1000;
}

function msUntilTomorrow08(now = new Date()) {
  const startDay = madridDay(now);
  const start = now.getTime();
  let t = new Date(start);

  for (let i = 0; i < 60 * 48; i++) {
    const { hh, mm } = madridHM(t);
    const d = madridDay(t);
    if (d !== startDay && hh === 8 && mm === 0) return t.getTime() - start;
    t = new Date(t.getTime() + 60 * 1000);
  }
  return 24 * 60 * 60 * 1000;
}

function clampToWindow(ts) {
  const d = new Date(ts);
  if (inWindow(d)) return ts;
  return Date.now() + msUntilNext08(new Date());
}

function ensureUser(user) {
  const today = madridDay();
  if (!users[user] || users[user].day !== today) {
    const now = new Date();
    const nextAsk = inWindow(now) ? Date.now() : Date.now() + msUntilNext08(now);
    users[user] = { day: today, done: false, awaiting: false, nextAsk };
  }
}

function parseAnswer(text) {
  const t = (text || "").trim().toLowerCase();

  // detectar respuestas positivas
  if (
    t.includes("si") ||
    t.includes("sí") ||
    t.includes("subid") ||
    t.includes("hecho") ||
    t.includes("listo") ||
    t.includes("ok")
  ) {
    return "yes";
  }

  // detectar respuestas negativas
  if (
    t.includes("no") ||
    t.includes("aun no") ||
    t.includes("aún no") ||
    t.includes("todavia no") ||
    t.includes("todavía no")
  ) {
    return "no";
  }

  return "unknown";
}

// Twilio -> tu servidor (cuando tú escribes)
app.post("/whatsapp/incoming", (req, res) => {
  const from = req.body.From; // whatsapp:+34...
  const body = req.body.Body;

  // te registras para recordatorios
  ensureUser(from);

  const ans = parseAnswer(body);
  const twiml = new twilio.twiml.MessagingResponse();

  if (ans === "yes") {
    users[from].done = true;
    users[from].awaiting = false;
    users[from].nextAsk = Date.now() + msUntilTomorrow08(new Date()); // mañana 08:00
    twiml.message("Perfecto. Mañana a las 08:00 te vuelvo a preguntar.");
  } else if (ans === "no") {
    users[from].done = false;
    users[from].awaiting = false;
    users[from].nextAsk = clampToWindow(Date.now() + FOUR_HOURS);
    twiml.message("Vale. Te lo vuelvo a preguntar en 4 horas.");
  } else {
    twiml.message("Respóndeme 'sí' o 'no'.");
  }

  res.type("text/xml").send(twiml.toString());
});

// Cron -> /tick (llamar cada pocos minutos)
async function runTick(req, res) {
  const secret = req.query.secret || req.headers["x-cron-secret"];
  if (secret !== process.env.CRON_SECRET) return res.status(401).send("unauthorized");

  if (!inWindow(new Date())) {
    return res.json({ ok: true, window: "closed" });
  }

  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  const now = Date.now();

  for (const user of Object.keys(users)) {
    ensureUser(user);

    if (users[user].done) continue;
    if (now < users[user].nextAsk) continue;

    await client.messages.create({
      from: process.env.TWILIO_WHATSAPP_FROM, // sandbox: whatsapp:+14155238886
      to: user,
      body: "¿Has subido la foto?",
    });

    // insiste cada 30 min si no respondes
    users[user].awaiting = true;
    users[user].nextAsk = now + THIRTY_MIN;
  }

  res.json({ ok: true, users: Object.keys(users).length });
}

app.get("/tick", runTick);
app.post("/tick", runTick);

app.get("/", (req, res) => res.send("Bot activo"));

app.listen(process.env.PORT || 3000);
