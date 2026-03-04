const express = require("express");
const twilio = require("twilio");

const app = express();
app.use(express.urlencoded({ extended: false }));

const users = {};
const FOUR_HOURS = 4 * 60 * 60 * 1000;

function parseAnswer(text) {
  const t = (text || "").toLowerCase();
  if (t.includes("si") || t.includes("sí")) return "yes";
  if (t.includes("no")) return "no";
  return "unknown";
}

app.post("/whatsapp/incoming", (req, res) => {

  const from = req.body.From;
  const body = req.body.Body;

  if (!users[from]) {
    users[from] = {
      done: false,
      nextAsk: Date.now()
    };
  }

  const answer = parseAnswer(body);

  const twiml = new twilio.twiml.MessagingResponse();

  if (answer === "yes") {
    users[from].done = true;
    twiml.message("Perfecto. Mañana te vuelvo a preguntar.");
  }

  else if (answer === "no") {
    users[from].done = false;
    users[from].nextAsk = Date.now() + FOUR_HOURS;
    twiml.message("Vale. Te lo volveré a preguntar en 4 horas.");
  }

  else {
    twiml.message("Respóndeme 'sí' o 'no'.");
  }

  res.type("text/xml");
  res.send(twiml.toString());

});

app.get("/", (req,res)=>{
  res.send("Bot activo");
});

app.listen(process.env.PORT || 3000);
