const express = require("express");

const app = express();
app.use(express.json());

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const FOUR_HOURS = 4 * 60 * 60 * 1000;
const THIRTY_MIN = 30 * 60 * 1000;

let state = {
  done: false,
  nextAsk: Date.now()
};

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
  const msg = req.body.message?.text?.toLowerCase();

  if (msg === "sí" || msg === "si") {
    state.done = true;
    state.nextAsk = Date.now() + 24 * 60 * 60 * 1000;
    await sendTelegram("Perfecto. Mañana te vuelvo a preguntar.");
  } else if (msg === "no") {
    state.done = false;
    state.nextAsk = Date.now() + FOUR_HOURS;
    await sendTelegram("Vale. Te lo vuelvo a preguntar en 4 horas.");
  }

  res.sendStatus(200);
});

app.get("/tick", async (req, res) => {
  const now = Date.now();

  if (!state.done && now >= state.nextAsk) {
    await sendTelegram("¿Has subido la foto?");
    state.nextAsk = now + THIRTY_MIN;
  }

  res.json({ ok: true });
});

app.get("/", (req, res) => res.send("Telegram bot activo"));

app.listen(process.env.PORT || 3000);
