const express = require("express");

const app = express();
app.use(express.json());

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CRON_SECRET = process.env.CRON_SECRET || "123456";

const FOUR_HOURS = 4 * 60 * 60 * 1000;
const THIRTY_MIN = 30 * 60 * 1000;
const TZ = "Europe/Madrid";

let state = {
  done: false,
  nextAsk: Date.now()
};

function nowMadridParts() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(new Date());

  const get = (type) => parts.find((p) => p.type === type)?.value;

  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    second: Number(get("second"))
  };
}

function isInWindow() {
  const { hour } = nowMadridParts();
  return hour >= 8 && hour <= 23;
}

function nextTomorrowAt8Madrid() {
  const now = new Date();
  let probe = new Date(now.getTime());

  for (let i = 0; i < 60 * 48; i++) {
    probe = new Date(probe.getTime() + 60 * 1000);

    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).formatToParts(probe);

    const get = (type) => parts.find((p) => p.type === type)?.value;
    const hour = Number(get("hour"));
    const minute = Number(get("minute"));

    if (hour === 8 && minute === 0) {
      return probe.getTime();
    }
  }

  return now.getTime() + 24 * 60 * 60 * 1000;
}

function clampToWindow(timestamp) {
  const testDate = new Date(timestamp);

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(testDate);

  const get = (type) => parts.find((p) => p.type === type)?.value;
  const hour = Number(get("hour"));

  if (hour >= 8 && hour <= 23) {
    return timestamp;
  }

  return nextTomorrowAt8Madrid();
}

async function sendTelegram(text) {
  await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text
    })
  });
}

app.post("/telegram", async (req, res) => {
  const msg = req.body.message?.text?.toLowerCase()?.trim();

  if (msg === "sí" || msg === "si") {
    state.done = true;
    state.nextAsk = nextTomorrowAt8Madrid();
    await sendTelegram("Perfecto. Mañana a las 08:00 te vuelvo a preguntar.");
  } else if (msg === "no") {
    state.done = false;
    state.nextAsk = clampToWindow(Date.now() + FOUR_HOURS);
    await sendTelegram("Vale. Te lo vuelvo a preguntar en 4 horas.");
  }

  res.sendStatus(200);
});

app.get("/tick", async (req, res) => {
  const secret = req.query.secret;

  if (secret !== CRON_SECRET) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const now = Date.now();

  if (!isInWindow()) {
    return res.json({ ok: true, sent: 0, window: "closed" });
  }

  if (!state.done && now >= state.nextAsk) {
    await sendTelegram("¿Has subido la foto?");
    state.nextAsk = now + THIRTY_MIN;
    return res.json({ ok: true, sent: 1 });
  }

  res.json({ ok: true, sent: 0 });
});

app.get("/", (req, res) => res.send("Telegram bot activo"));

app.listen(process.env.PORT || 3000);
