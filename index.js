// בוט משפחתי לוואטסאפ עם Gemini AI
// ====================================

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  downloadMediaMessage,
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
const FAMILY_GROUP_KEYWORD = "המהממת"; // מילה ייחודית לקבוצה המשפחתית "משפחת שטווי המהממת!"
const MORNING_BRIEFING_HOUR = 6;
const MORNING_BRIEFING_MINUTE = 30;
const EVENING_SUMMARY_HOUR = 21;
const EVENING_SUMMARY_MINUTE = 0;
const DOG_WALK_HOURS = [13, 16]; // שעות תזכורת הורדת מקס
const NOON_CHAT_HOUR = 12; // שעת השיחה היומית הקלילה
const NOON_CHAT_MINUTE = 0;
const WEEKLY_SUMMARY_DAY = 5; // יום שישי (0=ראשון, 5=שישי)
const WEEKLY_SUMMARY_HOUR = 14;
const WEEKLY_SUMMARY_MINUTE = 0;

// מיפוי מספרי טלפון (בפורמט בינלאומי, בלי +, למשל "972501234567") לשם בן המשפחה
// משמש בעיקר לצ'אטים פרטיים. בקבוצה, וואטסאפ לפעמים מסתיר את המספר האמיתי (LID),
// אז יש גם זיהוי גיבוי לפי שם הפרופיל - ראה FAMILY_NAME_VARIANTS למטה.
const FAMILY_PHONE_MAP = {
  "972536833336": "אסף",
  "972503867199": "שירן",
  "972534303473": "ענבר",
  "972522916665": "איתמר",
  "972512897618": "שלו",
};

// זיהוי גיבוי לפי מילות מפתח שעשויות להופיע בשם הפרופיל/איש הקשר של כל אחד בקבוצה
const FAMILY_NAME_VARIANTS = {
  אסף: ["אסף", "assaf"],
  שירן: ["שירן", "חיים שלי", "shiran"],
  ענבר: ["ענבר", "inbar"],
  איתמר: ["איתמר", "itamar"],
  שלו: ["שלו", "shelo", "shalev"],
};

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
    if (!data.dailyLog) data.dailyLog = [];
    if (!data.scheduledReminders) data.scheduledReminders = [];
    if (!data.weeklyLog) data.weeklyLog = [];
    if (!data.events) data.events = [];
    return data;
  } catch {
    return {
      shoppingList: [], reminders: [], memories: [], history: [],
      dailyLog: [], scheduledReminders: [], weeklyLog: [], events: [],
    };
  }
}
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// מזהה מי שלח את ההודעה
function getSenderName(msg, isGroup) {
  // אם ההודעה נשלחה מהמכשיר עצמו (fromMe) - זה תמיד אסף, כי הבוט מחובר לטלפון שלו
  if (msg.key.fromMe) return "אסף";

  const senderJid = isGroup
    ? msg.key.participant || msg.key.remoteJid
    : msg.key.remoteJid;

  // ניסיון ראשון: מספר טלפון נקי (בעיקר בצ'אט פרטי)
  const phone = senderJid?.split("@")[0]?.split(":")[0];
  if (phone && FAMILY_PHONE_MAP[phone]) {
    return FAMILY_PHONE_MAP[phone];
  }

  // ניסיון שני: שם הפרופיל בוואטסאפ (pushName)
  if (msg.pushName) {
    for (const [name, variants] of Object.entries(FAMILY_NAME_VARIANTS)) {
      if (variants.some((v) => msg.pushName.includes(v))) {
        return name;
      }
    }
    return msg.pushName;
  }

  return "לא ידוע";
}
async function askGemini(userMessage, context, senderName) {
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

יש לך גישה לחיפוש בגוגל בזמן אמת - אם נשאלת על משהו עדכני (תוצאות משחקים, מחירים, חדשות, תאריכים של אירועים), תחפש ותביא תשובה מדויקת ועדכנית, ולא תגיד שאתה "לא יכול לדעת".

== בני המשפחה שאתה מדבר איתם ==
- אסף - אבא, ראש המשפחה
- שירן - אמא, "המלכה של הבית" - תמיד תתייחס אליה בכבוד ובחמימות מיוחדת, כמי שמנהלת את הבית
- ענבר - בת 17 - דבר אליה כמו למתבגרת בוגרת: ישיר, רציני יותר, בלי "מתחנף", אפשר הומור עדכני
- איתמר - בן 15 - דבר אליו כמו למתבגר: קליל, ענייני, לא "ילדותי" אבל גם לא יותר מדי רשמי
- שלו - בן 11 - דבר אליו בפשטות, בחיוך, במשפטים קצרים וברורים, אפשר טון משחקי יותר

כשאתה לא יודע מי כותב, תענה בטון נייטרלי וחם שמתאים לכולם. אם מישהו מזדהה בשמו או שאתה יכול להבין מהתוכן מי כותב (למשל שאלת שיעורי בית = כנראה אחד הילדים), התאם את הטון בהתאם.

== מי כותב את ההודעה הזו ==
ההודעה הנוכחית נשלחה על ידי: ${senderName}
זהו מידע ודאי ומדויק (לא ניחוש) - המערכת מזהה אותו לפי מספר הטלפון. תמיד תתאים את הטון בדיוק לפי האדם הזה. אם נשאלת "האם אתה יודע מי כתב לך" או שאלה דומה על היכולת שלך לזהות - תענה בביטחון "כן" ותציין את השם (${senderName}), כי זה באמת ידוע לך בכל הודעה.

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

אם המשתמש מבקש תזכורת בשעה ספציפית (למשל "תזכיר לי ב-17:00 לאסוף את שלו"):
[REMIND: 17:00 | לאסוף את שלו]
(תמיד בפורמט HH:MM ואחרי | את תוכן התזכורת. אם לא צוינה שעה מפורשת, שאל מה השעה הרצויה)

אם המשתמש מספר על אירוע קרוב או מבקש להוסיף אירוע לשבוע (למשל "יש לנו אסיפת הורים ביום שלישי", "רובי תוסיף שיש לאיתמר מבחן בחמישי"):
[EVENT: היום/התאריך | תיאור האירוע]
לדוגמה: [EVENT: יום שלישי | אסיפת הורים בבית ספר של שלו]

תמיד תכתוב את הפקודות הרלוונטיות (אם יש), ואז המשך עם תשובה רגילה וטבעית בעברית.`;

  const result = await model.generateContent({
    contents: [
      { role: "user", parts: [{ text: systemPrompt }] },
      { role: "user", parts: [{ text: `הודעה מהמשפחה: ${userMessage}` }] },
    ],
    tools: [{ googleSearch: {} }],
  });
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

  // תזכורות מתוזמנות - פורמט: [REMIND: HH:MM | תוכן התזכורת]
  const remindMatches = [...text.matchAll(/\[REMIND:\s*(\d{1,2}:\d{2})\s*\|\s*([^\]]+)\]/g)];
  for (const m of remindMatches) {
    const time = m[1].trim();
    const content = m[2].trim();
    const [hStr, minStr] = time.split(":");
    const reminder = {
      hour: parseInt(hStr),
      minute: parseInt(minStr),
      content,
      date: new Date().toDateString(), // תקף ליום הזה בלבד
      id: Date.now() + Math.random(),
    };
    if (!data.scheduledReminders) data.scheduledReminders = [];
    data.scheduledReminders.push(reminder);
    console.log(`⏰ תזכורת נשמרה: ${time} - ${content}`);
    cleanText = cleanText.replace(m[0], "");
  }

  // אירועים שבועיים - פורמט: [EVENT: יום | תיאור]
  const eventMatches = [...text.matchAll(/\[EVENT:\s*([^|]+)\|\s*([^\]]+)\]/g)];
  for (const m of eventMatches) {
    const day = m[1].trim();
    const desc = m[2].trim();
    if (!data.events) data.events = [];
    data.events.push({ day, desc, addedAt: new Date().toDateString() });
    console.log(`📅 אירוע נשמר: ${day} - ${desc}`);
    cleanText = cleanText.replace(m[0], "");
  }

  return cleanText.trim();
}

// ====== תמלול הודעה קולית עם Gemini ======
async function transcribeVoiceMessage(msg) {
  try {
    const buffer = await downloadMediaMessage(msg, "buffer", {});
    const base64Audio = buffer.toString("base64");
    const result = await model.generateContent({
      contents: [
        {
          role: "user",
          parts: [
            {
              inlineData: {
                mimeType: "audio/ogg; codecs=opus",
                data: base64Audio,
              },
            },
            { text: "תמלל את ההודעה הקולית הזו בעברית. כתוב רק את הטקסט המתומלל, בלי הסברים נוספים." },
          ],
        },
      ],
    });
    return result.response.text().trim();
  } catch (err) {
    console.error("שגיאה בתמלול הודעה קולית:", err);
    return null;
  }
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
    markOnlineOnConnect: false, // כדי שתמשיך לקבל צלילי התראה רגילים בטלפון
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
      findFamilyGroupId();
    }
  });

  sock.ev.on("creds.update", saveCreds);

  // עוקב אחרי הודעות ששלח הבוט עצמו, כדי לא להגיב לעצמו (ולמנוע לופ אינסופי)
  const botSentMessageIds = new Set();

  // ====== תדריך בוקר יומי לקבוצה המשפחתית ======
  let familyGroupId = null;
  let lastBriefingDate = null;

  async function findFamilyGroupId() {
    try {
      const groups = await sock.groupFetchAllParticipating();
      for (const id in groups) {
        if (groups[id].subject.includes(FAMILY_GROUP_KEYWORD)) {
          familyGroupId = id;
          console.log(`👨‍👩‍👧‍👦 נמצאה הקבוצה המשפחתית: ${groups[id].subject}`);
          return;
        }
      }
      console.log("⚠️ לא נמצאה קבוצה משפחתית עם המילה:", FAMILY_GROUP_KEYWORD);
    } catch (e) {
      console.error("שגיאה באיתור הקבוצה המשפחתית:", e);
    }
  }

  async function sendMorningBriefing() {
    if (!familyGroupId) {
      console.log("⚠️ לא ניתן לשלוח תדריך בוקר - הקבוצה המשפחתית לא נמצאה");
      return;
    }
    try {
      const data = loadData();
      const prompt = `כתוב תדריך בוקר קצר וחם למשפחה, שיישלח כהודעה אחת בקבוצת הוואטסאפ המשפחתית. כלול:
1) פתיחה חמה של "בוקר טוב" עם תאריך היום.
2) משפט מוטיבציה קצר אחד שמתאים אישית לכל אחד מבני המשפחה (אסף, שירן, ענבר, איתמר, שלו) בהתאם לאופי שמתואר לך.
3) הצעה אחת קטנה וקונקרטית לפעילות משפחתית נחמדה לעשות היום או בקרוב (משהו קליל, לא יקר, מתאים לכולם).
תשובה קצרה וחמה, מקסימום 10-12 שורות בסך הכל, בעברית.`;

      const reply = await askGemini(prompt, data, "המערכת (תדריך בוקר אוטומטי)");
      const cleanReply = processCommands(reply, data);
      saveData(data);

      const sent = await sock.sendMessage(familyGroupId, { text: cleanReply });
      if (sent?.key?.id) {
        botSentMessageIds.add(sent.key.id);
        if (botSentMessageIds.size > 50) {
          const first = botSentMessageIds.values().next().value;
          botSentMessageIds.delete(first);
        }
      }
      console.log("☀️ תדריך בוקר נשלח לקבוצה המשפחתית");
    } catch (err) {
      console.error("שגיאה בשליחת תדריך בוקר:", err);
    }
  }

  async function sendEveningSummary() {
    if (!familyGroupId) return;
    try {
      const data = loadData();
      if (data.dailyLog.length === 0) {
        console.log("📋 אין פעילות לסיכום ערב");
        return;
      }

      const logText = data.dailyLog
        .map((e) => `${e.sender}: ${e.text}`)
        .join("\n");

      const prompt = `הנה כל מה שקרה היום בקבוצת המשפחה:

${logText}

כתוב סיכום ערב קצר ומצחיק לקבוצה המשפחתית. 
- התייחס לכל מי שהשתתף היום בשם (אסף, שירן, ענבר, איתמר, שלו) עם תגובה הומוריסטית קלילה על מה שהם אמרו/ביקשו
- אם מישהו לא דיבר היום - ציין את זה בשנינות (למשל "ענבר שמרה על שקט מסתורי היום")
- חפש בגוגל את תחזית מזג האוויר למחר באזור השרון/פתח תקווה ישראל והוסף שורה אחת קצרה עם מה לצפות מחר
- סיים עם משפט ערב טוב חם לכל המשפחה
- מקסימום 14 שורות, עברית, טון קליל ומשפחתי`;

      const reply = await askGemini(prompt, data, "המערכת (סיכום ערב אוטומטי)");
      const cleanReply = processCommands(reply, data);

      // איפוס יומן היומי לאחר שליחת הסיכום
      data.dailyLog = [];
      saveData(data);

      const sent = await sock.sendMessage(familyGroupId, { text: cleanReply });
      if (sent?.key?.id) {
        botSentMessageIds.add(sent.key.id);
        if (botSentMessageIds.size > 50) {
          const first = botSentMessageIds.values().next().value;
          botSentMessageIds.delete(first);
        }
      }
      console.log("🌙 סיכום ערב נשלח לקבוצה המשפחתית");
    } catch (err) {
      console.error("שגיאה בשליחת סיכום ערב:", err);
    }
  }

  // תזכורות הורדת מקס הכלב - בשעות קבועות
  const dogWalkMessages = [
    "🐕 היי חבר'ה! מקס כבר מסתכל עליכם עם עיניים של 'מתי יוצאים?!' תורו של מישהו להוריד אותו! 🦮",
    "🐶 עדכון דחוף מהמרפסת: מקס החזיק יש לו פגישה דחופה עם עמוד החשמל בחוץ. מישהו יכול לעזור לו? 😂🐾",
  ];
  let dogWalkSentToday = {};

  async function sendDogWalkReminder(hour) {
    if (!familyGroupId) return;
    const todayStr = new Date().toDateString();
    if (dogWalkSentToday[hour] === todayStr) return;
    dogWalkSentToday[hour] = todayStr;

    try {
      const msgIndex = DOG_WALK_HOURS.indexOf(hour);
      const text = dogWalkMessages[msgIndex] || dogWalkMessages[0];
      const sent = await sock.sendMessage(familyGroupId, { text });
      if (sent?.key?.id) {
        botSentMessageIds.add(sent.key.id);
        if (botSentMessageIds.size > 50) {
          const first = botSentMessageIds.values().next().value;
          botSentMessageIds.delete(first);
        }
      }
      console.log(`🐕 תזכורת מקס נשלחה בשעה ${hour}:00`);
    } catch (err) {
      console.error("שגיאה בשליחת תזכורת מקס:", err);
    }
  }

  // ====== שיחה יומית קלילה בצהריים ======
  async function sendNoonChat() {
    if (!familyGroupId) return;
    try {
      const data = loadData();
      const prompt = `כתוב הודעה קצרה, קלילה ומשעשעת לקבוצת המשפחה בצהריים. 
המטרה: לעורר קצת שיחה ולהזכיר למשפחה שאתה (רובי) כאן וזמין. 
אפשרויות (בחר אחת באקראי כל פעם): שאלה קלילה ליום ("מה אכלתם לצהריים?"), טיפ קטן, עובדה מעניינת, או הצעה קטנה. 
תהיה חם, קליל ולא מעיק. מקסימום 3-4 שורות, עברית. אל תשתמש בפורמט של רשימה.`;

      const reply = await askGemini(prompt, data, "המערכת (שיחת צהריים אוטומטית)");
      const cleanReply = processCommands(reply, data);
      saveData(data);

      const sent = await sock.sendMessage(familyGroupId, { text: cleanReply });
      if (sent?.key?.id) {
        botSentMessageIds.add(sent.key.id);
        if (botSentMessageIds.size > 50) {
          const first = botSentMessageIds.values().next().value;
          botSentMessageIds.delete(first);
        }
      }
      console.log("☀️ שיחת צהריים נשלחה");
    } catch (err) {
      console.error("שגיאה בשליחת שיחת צהריים:", err);
    }
  }

  // ====== סיכום שבועי בשישי ======
  async function sendWeeklySummary() {
    if (!familyGroupId) return;
    try {
      const data = loadData();
      const weekLog = data.weeklyLog || [];
      const events = data.events || [];

      const logText = weekLog.length > 0
        ? weekLog.map((e) => `${e.sender}: ${e.text}`).join("\n")
        : "לא נרשמה פעילות מיוחדת השבוע";

      const eventsText = events.length > 0
        ? events.map((e) => `${e.day}: ${e.desc}`).join("\n")
        : "לא נרשמו אירועים";

      const prompt = `הנה פעילות המשפחה מהשבוע האחרון:

== הודעות השבוע ==
${logText}

== אירועים שנרשמו ==
${eventsText}

כתוב סיכום שבועי הומוריסטי וחם לקבוצת המשפחה. 
- סקור בקצרה ובהומור מה קרה השבוע ומי היה הכי פעיל
- תן "פרס" מצחיק לכל אחד מבני המשפחה על משהו (למשל "פרס הכי הרבה בקשות קניות")
- הזכר אירועים חשובים שמתקרבים
- אחל שבת שלום וסוף שבוע נעים
- מקסימום 15 שורות, עברית, טון קליל ומשפחתי`;

      const reply = await askGemini(prompt, data, "המערכת (סיכום שבועי אוטומטי)");
      const cleanReply = processCommands(reply, data);

      // איפוס יומן שבועי ואירועים ישנים לאחר הסיכום
      data.weeklyLog = [];
      data.events = [];
      saveData(data);

      const sent = await sock.sendMessage(familyGroupId, { text: cleanReply });
      if (sent?.key?.id) {
        botSentMessageIds.add(sent.key.id);
        if (botSentMessageIds.size > 50) {
          const first = botSentMessageIds.values().next().value;
          botSentMessageIds.delete(first);
        }
      }
      console.log("📅 סיכום שבועי נשלח");
    } catch (err) {
      console.error("שגיאה בשליחת סיכום שבועי:", err);
    }
  }

  // ====== חידון משפחתי ======
  let activeQuiz = null; // { question, answer, askedAt }

  async function startQuiz(chatId) {
    try {
      const result = await model.generateContent({
        contents: [{
          role: "user",
          parts: [{ text: `צור חידה או שאלת טריוויה אחת בעברית, מתאימה למשפחה (גילאים 11-50). 
החזר בדיוק בפורמט JSON הזה בלבד, בלי שום טקסט נוסף:
{"question": "השאלה כאן", "answer": "התשובה הקצרה כאן"}` }],
        }],
      });
      let raw = result.response.text().replace(/```json|```/g, "").trim();
      const quiz = JSON.parse(raw);
      activeQuiz = { question: quiz.question, answer: quiz.answer.toLowerCase(), askedAt: Date.now() };

      const text = `🎮 חידון משפחתי!\n\n❓ ${quiz.question}\n\nמי יודע? כתבו את התשובה! (רמז: כתבו "רובי" עם התשובה)`;
      const sent = await sock.sendMessage(chatId, { text });
      if (sent?.key?.id) {
        botSentMessageIds.add(sent.key.id);
      }
      console.log(`🎮 חידון התחיל: ${quiz.question}`);
    } catch (err) {
      console.error("שגיאה בהתחלת חידון:", err);
      await sock.sendMessage(chatId, { text: "אופס, לא הצלחתי ליצור חידה כרגע 😅 נסו שוב!" });
    }
  }

  // בודק אם הודעה היא תשובה נכונה לחידון פעיל
  async function checkQuizAnswer(text, senderName, chatId) {
    if (!activeQuiz) return false;
    const cleaned = text.toLowerCase();
    if (cleaned.includes(activeQuiz.answer)) {
      const winMsg = `🎉 כל הכבוד ${senderName}! תשובה נכונה: "${activeQuiz.answer}"! 🏆`;
      const sent = await sock.sendMessage(chatId, { text: winMsg });
      if (sent?.key?.id) botSentMessageIds.add(sent.key.id);
      console.log(`🏆 ${senderName} ענה נכון בחידון`);
      activeQuiz = null;
      return true;
    }
    return false;
  }

  // בודק כל דקה אם הגיע הזמן לשלוח תדריך בוקר, סיכום ערב, תזכורת מקס, או תזכורת מתוזמנת
  let lastSummaryDate = null;
  let lastNoonChatDate = null;
  let lastWeeklySummaryDate = null;
  setInterval(async () => {
    const now = new Date();
    const todayStr = now.toDateString();
    const h = now.getHours();
    const m = now.getMinutes();

    if (h === MORNING_BRIEFING_HOUR && m === MORNING_BRIEFING_MINUTE && lastBriefingDate !== todayStr) {
      lastBriefingDate = todayStr;
      sendMorningBriefing();
    }

    if (h === EVENING_SUMMARY_HOUR && m === EVENING_SUMMARY_MINUTE && lastSummaryDate !== todayStr) {
      lastSummaryDate = todayStr;
      sendEveningSummary();
    }

    // תזכורות מקס ב-13:00 וב-16:00
    if (m === 0 && DOG_WALK_HOURS.includes(h)) {
      sendDogWalkReminder(h);
    }

    // שיחת צהריים קלילה
    if (h === NOON_CHAT_HOUR && m === NOON_CHAT_MINUTE && lastNoonChatDate !== todayStr) {
      lastNoonChatDate = todayStr;
      sendNoonChat();
    }

    // סיכום שבועי בשישי ב-14:00
    if (
      now.getDay() === WEEKLY_SUMMARY_DAY &&
      h === WEEKLY_SUMMARY_HOUR &&
      m === WEEKLY_SUMMARY_MINUTE &&
      lastWeeklySummaryDate !== todayStr
    ) {
      lastWeeklySummaryDate = todayStr;
      sendWeeklySummary();
    }

    // בדיקת תזכורות מתוזמנות שהמשפחה ביקשה
    if (familyGroupId) {
      try {
        const data = loadData();
        const pending = data.scheduledReminders || [];
        const toFire = pending.filter(
          (r) => r.date === todayStr && r.hour === h && r.minute === m
        );
        if (toFire.length > 0) {
          for (const r of toFire) {
            const reminderText = `⏰ תזכורת!\n\n${r.content}`;
            const sent = await sock.sendMessage(familyGroupId, { text: reminderText });
            if (sent?.key?.id) {
              botSentMessageIds.add(sent.key.id);
              if (botSentMessageIds.size > 50) {
                const first = botSentMessageIds.values().next().value;
                botSentMessageIds.delete(first);
              }
            }
            console.log(`⏰ תזכורת נשלחה: ${r.content}`);
          }
          // מחיקת התזכורות ששוגרו
          data.scheduledReminders = pending.filter(
            (r) => !(r.date === todayStr && r.hour === h && r.minute === m)
          );
          saveData(data);
        }
      } catch (e) {
        console.error("שגיאה בבדיקת תזכורות:", e);
      }
    }
  }, 60 * 1000);

  // ====== טיפול בהודעות נכנסות ======
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message) return;

    // אם זו הודעה שהבוט עצמו שלח (תשובה או שגיאה) - מתעלמים, כדי למנוע לופ אינסופי.
    // אם זו הודעה שאתה כתבת בעצמך מהטלפון (גם היא fromMe, כי הבוט מחובר למספר שלך) - עונים כרגיל.
    if (msg.key.fromMe && botSentMessageIds.has(msg.key.id)) return;

    // זיהוי סוג ההודעה - טקסט או קולית
    const isVoice = !!(msg.message.audioMessage && msg.message.audioMessage.ptt);
    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      "";

    if (!text && !isVoice) return;

    const chatId = msg.key.remoteJid;
    const isGroup = chatId.endsWith("@g.us");

    // הבוט מגיב רק בקבוצה המשפחתית - מתעלם לחלוטין מצ'אטים פרטיים
    if (!isGroup) return;

    // בודקים ששם הקבוצה הוא הקבוצה המשפחתית הנכונה
    try {
      const groupMetadata = await sock.groupMetadata(chatId);
      if (!groupMetadata.subject.includes(FAMILY_GROUP_KEYWORD)) return;
    } catch (e) {
      console.error("לא ניתן לאמת את שם הקבוצה:", e);
      return;
    }

    const senderName = getSenderName(msg, isGroup);
    console.log(`🔍 DEBUG - pushName: ${msg.pushName} | זוהה כ: ${senderName}`);

    // ====== טיפול בהודעה קולית ======
    if (isVoice) {
      console.log(`🎤 הודעה קולית התקבלה מ-${senderName}`);
      try {
        const transcribed = await transcribeVoiceMessage(msg);
        if (!transcribed) return;
        console.log(`📝 תמלול: ${transcribed}`);

        // שמירה ביומן היומי
        const data = loadData();
        data.dailyLog.push({ sender: senderName, text: `[קולית] ${transcribed}` });
        saveData(data);

        // אם ההודעה הקולית מכילה "רובי" - הבוט יענה עליה
        const mentionsBot = [BOT_NAME, "רובי"].some((w) => transcribed.includes(w));
        if (mentionsBot) {
          const reply = await askGemini(transcribed, data, senderName);
          const cleanReply = processCommands(reply, data);
          data.history.push({ role: "user", text: `${senderName}: ${transcribed}` });
          data.history.push({ role: "bot", text: cleanReply });
          if (data.history.length > MAX_HISTORY) data.history = data.history.slice(-MAX_HISTORY);
          saveData(data);

          const sent = await sock.sendMessage(chatId, { text: `🎤 שמעתי: "${transcribed}"\n\n${cleanReply}` });
          if (sent?.key?.id) {
            botSentMessageIds.add(sent.key.id);
            if (botSentMessageIds.size > 50) {
              const first = botSentMessageIds.values().next().value;
              botSentMessageIds.delete(first);
            }
          }
        }
      } catch (err) {
        console.error("שגיאה בטיפול בהודעה קולית:", err);
      }
      return;
    }

    // ====== טיפול בהודעת טקסט ======

    // שמירה ביומן היומי והשבועי (כל הודעה בקבוצה, לא רק מי שפונה לרובי)
    try {
      const dataForLog = loadData();
      dataForLog.dailyLog.push({ sender: senderName, text });
      if (dataForLog.dailyLog.length > 100) dataForLog.dailyLog = dataForLog.dailyLog.slice(-100);
      dataForLog.weeklyLog.push({ sender: senderName, text });
      if (dataForLog.weeklyLog.length > 300) dataForLog.weeklyLog = dataForLog.weeklyLog.slice(-300);
      saveData(dataForLog);
    } catch (e) {
      console.error("שגיאה בשמירת יומן:", e);
    }

    // בקבוצה - מגיב רק אם פנו אליו בשם
    const triggerWords = [BOT_NAME, "רובי"];
    const wasMentioned = triggerWords.some((w) => text.includes(w));
    if (!wasMentioned) return;

    console.log(`📩 הודעה לרובי מ-${senderName}: ${text}`);

    // אם יש חידון פעיל - בודקים אם זו תשובה נכונה
    if (activeQuiz) {
      const answered = await checkQuizAnswer(text, senderName, chatId);
      if (answered) return;
    }

    // בקשה להתחיל חידון
    if (/חידון|חידה|בוא.?נשחק|משחק/.test(text)) {
      await startQuiz(chatId);
      return;
    }

    try {
      const data = loadData();
      const reply = await askGemini(text, data, senderName);
      const cleanReply = processCommands(reply, data);

      // עדכון זיכרון השיחה (ההודעה של המשתמש + התשובה של הבוט)
      data.history.push({ role: "user", text: `${senderName}: ${text}` });
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
