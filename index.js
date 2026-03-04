const express = require("express");
const twilio = require("twilio");
const { Redis } = require("@upstash/redis");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const TZ = "Europe/Madrid";
const FOUR_HOURS = 4 * 60 * 60 * 1000;
const THIRTY_MIN = 30 * 60 * 1000;

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Redis keys
const USERS_SET_KEY = "users:set";
const userKey = (phone) => `user:${phone}`; // phone = "whatsapp:+34..."

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
  return hh >= 8 && hh <= 23; // 08:00 a 23:59
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

function parseAnswer(text) {
  const t = (text || "").trim().toLowerCase();

  // sí / hecho / foto subida
  if (
    t === "si" ||
    t === "sí" ||
    t.includes("subid") ||
    t.includes("hecho") ||
    t.includes("listo") ||
    t === "ok"
  ) return "yes";

  // no / aún no
  if (
    t === "no" ||
    t.includes("aun no") ||
    t.includes("aún no") ||
    t.includes("todavia no") ||
    t.includes("todavía no")
  ) return "no";

  return "unknown";
}

async function getUser(phone) {
  const raw = await redis.get(userKey(phone));
  return raw || null;
}

async function setUser(phone, state) {
  await redis.set(userKey(phone), state);
}

async function ensureUser(phone) {
  const today = madridDay();
  const now = new Date();

  let state = await getUser(phone);

  if (!state || state.day !== today) {
    const nextAsk = inWindow(now) ? Date.now() : Date.now() + msUntilNext08(now);
    state = { day: today, done: false, awaiting: false, nextAsk };
    await setUser(phone, state);
  }

  // asegúrate de que el usuario está en el set global
  await redis.sadd(USERS_SET_KEY, phone);

  return state;
}

// Twilio -> tu servidor (cuando tú escribes)
app.post("/whatsapp/incoming", async (req, res) => {
  const from = req.body.From; // whatsapp:+34...
  const body = req.body.Body;

  let state = await ensureUser(from);

  const ans = parseAnswer(body);
  const twiml = new twilio.twiml.MessagingResponse();

  if (ans === "yes") {
    state.done = true;
    state.awaiting = false;
    state.nextAsk = Date.now() + msUntilTomorrow08(new Date()); // mañana 08:00
    await setUser(from, state);
    twiml.message("Perfecto. Mañana a las 08:00 te vuelvo a preguntar.");
  } else if (ans === "no") {
    state.done = false;
    state.awaiting = false;
    state.nextAsk = clampToWindow(Date.now() + FOUR_HOURS);
    await setUser(from, state);
    twiml.message("Vale. Te lo vuelvo a preguntar en 4 horas.");
  } else {
    twiml.message("Respóndeme 'sí' o 'no'.");
  }

  res.type("text/xml").send(twiml.toString());
});

// Cron -> /tick
async function runTick(req, res) {
  const secret = req.query.secret || req.headers["x-cron-secret"];
  if (secret !== process.env.CRON_SECRET) return res.status(401).send("unauthorized");

  if (!inWindow(new Date())) {
    return res.json({ ok: true, window: "closed" });
  }

  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  const now = Date.now();

  const users = (await redis.smembers(USERS_SET_KEY)) || [];
  let sent = 0;

  for (const phone of users) {
    let state = await ensureUser(phone); // también resetea si cambia de día

    if (state.done) continue;
    if (now < state.nextAsk) continue;

    await client.messages.create({
      from: process.env.TWILIO_WHATSAPP_FROM, // whatsapp:+14155238886
      to: phone,
      body: "¿Has subido la foto?",
    });

    state.awaiting = true;
    state.nextAsk = now + THIRTY_MIN; // insiste cada 30 min si no respondes
    await setUser(phone, state);
    sent++;
  }

  res.json({ ok: true, users: users.length, sent });
}

app.get("/tick", runTick);
app.post("/tick", runTick);

app.get("/", (req, res) => res.send("Bot activo"));

app.listen(process.env.PORT || 3000);
