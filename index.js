// בוט משפחתי לוואטסאפ עם Gemini AI
// ====================================

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
} = require("@whiskeysockets/baileys");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const qrcode = require("qrcode-terminal");
const QRCode = require("qrcode");
const express = require("express");
const pino = require("pino");
const fs = require("fs");

// ====== הגדרות ======
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const BOT_NAME = process.env.BOT_NAME || "רובי";
const PORT = process.env.PORT || 3000;

if (!GEMINI_API_KEY) {
  console.error("❌ חסר GEMINI_API_KEY במשתני הסביבה!");
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// ====== שרת קטן להצגת קוד QR ======
const app = express();
let lastQR = null;
let connectionStatus = "מתחבר...";

app.get("/", async (req, res) => {
  if (lastQR) {
    const qrImage = await QRCode.toDataURL(lastQR);
    res.send(`
      <html dir="rtl">
        <head><meta charset="utf-8"><title>${BOT_NAME}</title></head>
        <body style="text-align:center; font-family:sans-serif; padding:40px;">
          <h1>📱 סרוק כדי לחבר את ${BOT_NAME}</h1>
          <p>פתח וואטסאפ → הגדרות → מכשירים מקושרים → קישור מכשיר</p>
          <img src="${qrImage}" style="width:300px;" />
          <p>הדף מתעדכן אוטומטית כל 20 שניות</p>
          <script>setTimeout(()=>location.reload(), 20000)</script>
        </body>
      </html>
    `);
  } else {
    res.send(`
      <html dir="rtl">
        <body style="text-align:center; font-family:sans-serif; padding:40px;">
          <h1>${BOT_NAME}</h1>
          <p>סטטוס: ${connectionStatus}</p>
          <script>setTimeout(()=>location.reload(), 5000)</script>
        </body>
      </html>
    `);
  }
});

app.listen(PORT, () => {
  console.log(`🌐 שרת רץ על פורט ${PORT}`);
});

// ====== זיכרון (רשימת קניות + עובדות קבועות + היסטוריית שיחה) ======
const DATA_FILE = "./data.json";
const MAX_HISTORY = 20; // כמה הודעות אחרונות לשמור בזיכרון השיחה

function loadData() {
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
    if (!data.memories) data.memories = [];
    if (!data.history) data.history = [];
    return data;
  } catch {
    return { shoppingList: [], reminders: [], memories: [], history: [] };
  }
}
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ====== פנייה ל-Gemini ======
async function askGemini(userMessage, context) {
  const recentHistory = context.history
    .map((h) => `${h.role === "user" ? "משתמש" : BOT_NAME}: ${h.text}`)
    .join("\n");

  const memoriesText =
    context.memories.length > 0
      ? context.memories.map((m) => `- ${m}`).join("\n")
      : "אין עדיין עובדות שמורות";

  const systemPrompt = `אתה "${BOT_NAME}" - עוזר AI משפחתי בקבוצת וואטסאפ.
אתה עוזר בניהול משק בית: רשימות קניות, תזכורות, שאלות כלליות, עזרה לילדים בשיעורים, רעיונות לארוחות ועוד.
דבר בעברית, בצורה חמה, קצרה וברורה. אל תהיה מסורבל.

== בני המשפחה שאתה מדבר איתם ==
- אסף - אבא, ראש המשפחה
- שירן - אמא, "המלכה של הבית" - תמיד תתייחס אליה בכבוד ובחמימות מיוחדת, כמי שמנהלת את הבית
- ענבר - בת 17 - דבר אליה כמו למתבגרת בוגרת: ישיר, רציני יותר, בלי "מתחנף", אפשר הומור עדכני
- איתמר - בן 15 - דבר אליו כמו למתבגר: קליל, ענייני, לא "ילדותי" אבל גם לא יותר מדי רשמי
- שלו - בן 11 - דבר אליו בפשטות, בחיוך, במשפטים קצרים וברורים, אפשר טון משחקי יותר

כשאתה לא יודע מי כותב, תענה בטון נייטרלי וחם שמתאים לכולם. אם מישהו מזדהה בשמו או שאתה יכול להבין מהתוכן מי כותב (למשל שאלת שיעורי בית = כנראה אחד הילדים), התאם את הטון בהתאם.

מצב נוכחי - רשימת קניות: ${context.shoppingList.join(", ") || "ריקה"}

== עובדות קבועות שנתבקשת לזכור בעבר ==
${memoriesText}

== השיחה האחרונה (להקשר בלבד, אל תחזור עליה מילה במילה) ==
${recentHistory || "(זו ההודעה הראשונה בשיחה)"}

== פקודות שאתה יכול לכתוב בתשובה שלך ==
אם המשתמש מבקש להוסיף/להוריד פריט מרשימת הקניות:
[ADD: שם הפריט] - להוספה
[REMOVE: שם הפריט] - להסרה

אם המשתמש מבקש ממך באופן מפורש לזכור משהו לטווח ארוך (למשל "רובי תזכור ש...", "זכור לי ש..."):
[REMEMBER: העובדה שצריך לזכור]

אם המשתמש מבקש ממך לשכוח/למחוק עובדה ששמרת:
[FORGET: העובדה למחיקה]

תמיד תכתוב את הפקודות הרלוונטיות (אם יש), ואז המשך עם תשובה רגילה וטבעית בעברית.`;

  const result = await model.generateContent([
    { text: systemPrompt },
    { text: `הודעה מהמשפחה: ${userMessage}` },
  ]);
  return result.response.text();
}

// עיבוד פקודות מהתשובה של Gemini (הוספה/הסרה מרשימה, זכירה/שכיחה של עובדות)
function processCommands(text, data) {
  let cleanText = text;

  const addMatches = [...text.matchAll(/\[ADD:\s*([^\]]+)\]/g)];
  for (const m of addMatches) {
    const item = m[1].trim();
    if (!data.shoppingList.includes(item)) data.shoppingList.push(item);
    cleanText = cleanText.replace(m[0], "");
  }

  const removeMatches = [...text.matchAll(/\[REMOVE:\s*([^\]]+)\]/g)];
  for (const m of removeMatches) {
    const item = m[1].trim();
    data.shoppingList = data.shoppingList.filter((i) => i !== item);
    cleanText = cleanText.replace(m[0], "");
  }

  const rememberMatches = [...text.matchAll(/\[REMEMBER:\s*([^\]]+)\]/g)];
  for (const m of rememberMatches) {
    const fact = m[1].trim();
    if (!data.memories.includes(fact)) data.memories.push(fact);
    cleanText = cleanText.replace(m[0], "");
  }

  const forgetMatches = [...text.matchAll(/\[FORGET:\s*([^\]]+)\]/g)];
  for (const m of forgetMatches) {
    const fact = m[1].trim();
    data.memories = data.memories.filter((f) => f !== fact);
    cleanText = cleanText.replace(m[0], "");
  }

  return cleanText.trim();
}

// ====== חיבור לוואטסאפ ======
async function startBot() {
  console.log("🔄 מתחיל להתחבר לוואטסאפ...");
  const { state, saveCreds } = await useMultiFileAuthState("./auth_info");
  console.log("📂 מידע התחברות נטען, יוצר חיבור...");

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: "info" }),
    printQRInTerminal: false,
  });
  console.log("🔌 סוקט נוצר, מחכה לאירועים...");

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      lastQR = qr;
      qrcode.generate(qr, { small: true });
      console.log("📱 קוד QR חדש נוצר - היכנס לכתובת השרת כדי לסרוק");
    }

    if (connection === "close") {
      connectionStatus = "התחברות נסגרה, מתחבר מחדש...";
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        startBot();
      } else {
        console.log("❌ נותקת מוואטסאפ. צריך לסרוק QR מחדש.");
      }
    } else if (connection === "open") {
      lastQR = null;
      connectionStatus = "✅ מחובר!";
      console.log("✅ הבוט מחובר לוואטסאפ בהצלחה!");
    }
  });

  sock.ev.on("creds.update", saveCreds);

  // עוקב אחרי הודעות ששלח הבוט עצמו, כדי לא להגיב לעצמו (ולמנוע לופ אינסופי)
  const botSentMessageIds = new Set();

  // ====== טיפול בהודעות נכנסות ======
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message) return;

    // אם זו הודעה שהבוט עצמו שלח (תשובה או שגיאה) - מתעלמים, כדי למנוע לופ אינסופי.
    // אם זו הודעה שאתה כתבת בעצמך מהטלפון (גם היא fromMe, כי הבוט מחובר למספר שלך) - עונים כרגיל.
    if (msg.key.fromMe && botSentMessageIds.has(msg.key.id)) return;

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      "";

    if (!text) return;

    const chatId = msg.key.remoteJid;
    const isGroup = chatId.endsWith("@g.us");

    // הבוט מגיב רק בקבוצה המשפחתית - מתעלם לחלוטין מצ'אטים פרטיים
    if (!isGroup) return;

    // בודקים ששם הקבוצה הוא הקבוצה המשפחתית הנכונה (מכיל "שטווי")
    const FAMILY_GROUP_KEYWORD = "שטווי";
    try {
      const groupMetadata = await sock.groupMetadata(chatId);
      if (!groupMetadata.subject.includes(FAMILY_GROUP_KEYWORD)) return;
    } catch (e) {
      console.error("לא ניתן לאמת את שם הקבוצה:", e);
      return;
    }

    // בקבוצה - מגיב רק אם פנו אליו בשם או עם "בוט"
    const triggerWords = [BOT_NAME, "רובי"];
    const wasMentioned = triggerWords.some((w) => text.includes(w));

    if (!wasMentioned) return;

    console.log(`📩 הודעה התקבלה: ${text}`);

    try {
      const data = loadData();
      const reply = await askGemini(text, data);
      const cleanReply = processCommands(reply, data);

      // עדכון זיכרון השיחה (ההודעה של המשתמש + התשובה של הבוט)
      data.history.push({ role: "user", text });
      data.history.push({ role: "bot", text: cleanReply });
      if (data.history.length > MAX_HISTORY) {
        data.history = data.history.slice(-MAX_HISTORY);
      }

      saveData(data);

      const sent = await sock.sendMessage(chatId, { text: cleanReply });
      if (sent?.key?.id) {
        botSentMessageIds.add(sent.key.id);
        // ניקוי הרשימה כדי שלא תתמלא לנצח (שומר רק 50 אחרונים)
        if (botSentMessageIds.size > 50) {
          const first = botSentMessageIds.values().next().value;
          botSentMessageIds.delete(first);
        }
      }
      console.log(`📤 תשובה נשלחה`);
    } catch (err) {
      console.error("שגיאה:", err);
      const sentError = await sock.sendMessage(chatId, {
        text: "מצטער, הייתה תקלה. נסה שוב 🙏",
      });
      if (sentError?.key?.id) {
        botSentMessageIds.add(sentError.key.id);
        if (botSentMessageIds.size > 50) {
          const first = botSentMessageIds.values().next().value;
          botSentMessageIds.delete(first);
        }
      }
    }
  });
}

startBot().catch((err) => {
  console.error("❌ שגיאה קריטית בהפעלת הבוט:", err);
});