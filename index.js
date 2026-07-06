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
    if (!data.weeklyReminders) data.weeklyReminders = [];
    if (!data.weeklyLog) data.weeklyLog = [];
    if (!data.events) data.events = [];
    if (!data.trip) data.trip = [];
    if (!data.allowances) data.allowances = {};
    if (!data.points) data.points = {};
    if (!data.birthdays) data.birthdays = [];
    if (!data.recipes) data.recipes = [];
    if (!data.activePoll) data.activePoll = null;
    return data;
  } catch {
    return {
      shoppingList: [], reminders: [], memories: [], history: [],
      dailyLog: [], scheduledReminders: [], weeklyReminders: [], weeklyLog: [], events: [],
      trip: [], allowances: {}, points: {}, birthdays: [], recipes: [], activePoll: null,
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

== מידע על טיול תאילנד המשפחתי ==
${context.trip.length > 0 ? context.trip.map((t) => `- ${t}`).join("\n") : "עדיין לא נשמרו פרטי טיול"}
(אם נשאלת על הטיול - השתמש במידע הזה. להמרות מטבע שקל-באט השתמש בחיפוש בגוגל לשער עדכני)

== דמי כיס של הילדים ==
${Object.keys(context.allowances).length > 0 ? Object.entries(context.allowances).map(([n, a]) => `- ${n}: ${a} ש"ח`).join("\n") : "לא מנוהלים עדיין דמי כיס"}

== טבלת נקודות משפחתית (מטלות) ==
${Object.keys(context.points).length > 0 ? Object.entries(context.points).map(([n, p]) => `- ${n}: ${p} נקודות`).join("\n") : "אין עדיין נקודות"}

== ימי הולדת שמורים ==
${context.birthdays.length > 0 ? context.birthdays.map((b) => `- ${b.name}: ${b.date}`).join("\n") : "לא נשמרו ימי הולדת"}

== מתכונים מוצלחים ששמרנו ==
${context.recipes.length > 0 ? context.recipes.map((r) => `- ${r}`).join("\n") : "אין עדיין מתכונים שמורים"}
(אם שואלים "מה מכינים היום" - הצע רעיון לפי רשימת הקניות והמתכונים השמורים)

== סקר פעיל ==
${context.activePoll ? `שאלה: ${context.activePoll.question}\nאפשרויות: ${context.activePoll.options.join(", ")}\nהצביעו עד כה: ${Object.entries(context.activePoll.votes).map(([voter, choice]) => `${voter} → ${choice}`).join(", ") || "אף אחד עדיין"}` : "אין סקר פעיל כרגע"}

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

תזכורת להיום בשעה ספציפית (למשל "תזכיר לי ב-17:00 לאסוף את שלו"):
[REMIND: 17:00 | לאסוף את שלו]

תזכורת לתאריך עתידי (למשל "תזכיר לי ב-15/7 בשעה 10:00 תור לרופא"):
[REMIND_DATE: 15/7 | 10:00 | תור לרופא]
(פורמט: יום/חודש | שעה | תוכן)

תזכורת שבועית חוזרת (למשל "תזכיר כל יום רביעי ב-16:00 חוג כדורגל של שלו"):
[REMIND_WEEKLY: רביעי | 16:00 | חוג כדורגל של שלו]
(שם היום בעברית: ראשון/שני/שלישי/רביעי/חמישי/שישי/שבת)

אם המשתמש מספר על אירוע קרוב (למשל "יש לנו אסיפת הורים ביום שלישי"):
[EVENT: יום שלישי | אסיפת הורים בבית ספר של שלו]

לשמור פרט על טיול תאילנד ("רובי תשמור שהטיסה ב-2/9 בשעה 23:50"):
[TRIP: טיסה ב-2/9 בשעה 23:50]

לעדכן דמי כיס ("רובי, שלו קיבל 50 שח" / "איתמר הוציא 20 שח"):
[ALLOWANCE: שלו | +50] או [ALLOWANCE: איתמר | -20]

לתת נקודות על מטלות ("רובי, שלו הוריד את מקס"):
[POINTS: שלו | +10]
(ברירת מחדל: מטלה רגילה +10, מטלה גדולה +20. אפשר גם להוריד נקודות עם מינוס)

לשמור יום הולדת ("רובי תשמור שיום ההולדת של סבתא רחל ב-12/8"):
[BIRTHDAY: סבתא רחל | 12/8]

לשמור מתכון מוצלח ("רובי תשמור את המתכון של הפסטה שאהבנו"):
[RECIPE: פסטה ברוטב עגבניות ושמנת - התיאור]

להתחיל סקר ("רובי תעשה הצבעה: פיצה או סושי?"):
[POLL: מה אוכלים הערב? | פיצה, סושי]
(פורמט: שאלה | אפשרות1, אפשרות2, ...)

כשמישהו מצביע בסקר פעיל (למשל כותב "רובי אני בוחר פיצה"):
[VOTE: פיצה]

לסיים סקר ולהכריז תוצאות ("רובי כמה הצביעו?" / "רובי תסגור את הסקר"):
[POLL_END]

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
function processCommands(text, data, senderName) {
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

  // תזכורת לתאריך עתידי - [REMIND_DATE: DD/MM | HH:MM | תוכן]
  const remindDateMatches = [...text.matchAll(/\[REMIND_DATE:\s*(\d{1,2})\/(\d{1,2})\s*\|\s*(\d{1,2}):(\d{2})\s*\|\s*([^\]]+)\]/g)];
  for (const m of remindDateMatches) {
    const reminder = {
      day: parseInt(m[1]),
      month: parseInt(m[2]),
      hour: parseInt(m[3]),
      minute: parseInt(m[4]),
      content: m[5].trim(),
      type: "date",
      id: Date.now() + Math.random(),
    };
    data.scheduledReminders.push(reminder);
    console.log(`📆 תזכורת לתאריך נשמרה: ${m[1]}/${m[2]} ${m[3]}:${m[4]} - ${reminder.content}`);
    cleanText = cleanText.replace(m[0], "");
  }

  // תזכורת שבועית חוזרת - [REMIND_WEEKLY: יום | HH:MM | תוכן]
  const hebrewDays = { "ראשון": 0, "שני": 1, "שלישי": 2, "רביעי": 3, "חמישי": 4, "שישי": 5, "שבת": 6 };
  const remindWeeklyMatches = [...text.matchAll(/\[REMIND_WEEKLY:\s*([^|]+)\|\s*(\d{1,2}):(\d{2})\s*\|\s*([^\]]+)\]/g)];
  for (const m of remindWeeklyMatches) {
    const dayName = m[1].trim().replace("יום ", "");
    const dayOfWeek = hebrewDays[dayName];
    if (dayOfWeek === undefined) continue;
    const reminder = {
      dayOfWeek,
      dayName,
      hour: parseInt(m[2]),
      minute: parseInt(m[3]),
      content: m[4].trim(),
      id: Date.now() + Math.random(),
    };
    data.weeklyReminders.push(reminder);
    console.log(`🔁 תזכורת שבועית נשמרה: כל יום ${dayName} ${m[2]}:${m[3]} - ${reminder.content}`);
    cleanText = cleanText.replace(m[0], "");
  }

  // פרטי טיול - [TRIP: פרט]
  const tripMatches = [...text.matchAll(/\[TRIP:\s*([^\]]+)\]/g)];
  for (const m of tripMatches) {
    const info = m[1].trim();
    if (!data.trip.includes(info)) data.trip.push(info);
    console.log(`✈️ פרט טיול נשמר: ${info}`);
    cleanText = cleanText.replace(m[0], "");
  }

  // דמי כיס - [ALLOWANCE: שם | +50 / -20]
  const allowanceMatches = [...text.matchAll(/\[ALLOWANCE:\s*([^|]+)\|\s*([+-]?\d+)\]/g)];
  for (const m of allowanceMatches) {
    const name = m[1].trim();
    const amount = parseInt(m[2]);
    if (!data.allowances[name]) data.allowances[name] = 0;
    data.allowances[name] += amount;
    console.log(`💰 דמי כיס עודכנו: ${name} ${amount > 0 ? "+" : ""}${amount} (סה"כ: ${data.allowances[name]})`);
    cleanText = cleanText.replace(m[0], "");
  }

  // נקודות מטלות - [POINTS: שם | +10]
  const pointsMatches = [...text.matchAll(/\[POINTS:\s*([^|]+)\|\s*([+-]?\d+)\]/g)];
  for (const m of pointsMatches) {
    const name = m[1].trim();
    const pts = parseInt(m[2]);
    if (!data.points[name]) data.points[name] = 0;
    data.points[name] += pts;
    console.log(`🏆 נקודות עודכנו: ${name} ${pts > 0 ? "+" : ""}${pts} (סה"כ: ${data.points[name]})`);
    cleanText = cleanText.replace(m[0], "");
  }

  // ימי הולדת - [BIRTHDAY: שם | DD/MM]
  const birthdayMatches = [...text.matchAll(/\[BIRTHDAY:\s*([^|]+)\|\s*(\d{1,2}\/\d{1,2})\]/g)];
  for (const m of birthdayMatches) {
    const name = m[1].trim();
    const date = m[2].trim();
    if (!data.birthdays.some((b) => b.name === name)) {
      data.birthdays.push({ name, date });
      console.log(`🎂 יום הולדת נשמר: ${name} - ${date}`);
    }
    cleanText = cleanText.replace(m[0], "");
  }

  // מתכונים - [RECIPE: תיאור]
  const recipeMatches = [...text.matchAll(/\[RECIPE:\s*([^\]]+)\]/g)];
  for (const m of recipeMatches) {
    const recipe = m[1].trim();
    if (!data.recipes.includes(recipe)) data.recipes.push(recipe);
    console.log(`🍽️ מתכון נשמר: ${recipe}`);
    cleanText = cleanText.replace(m[0], "");
  }

  // התחלת סקר - [POLL: שאלה | אופציה1, אופציה2]
  const pollMatches = [...text.matchAll(/\[POLL:\s*([^|]+)\|\s*([^\]]+)\]/g)];
  for (const m of pollMatches) {
    const question = m[1].trim();
    const options = m[2].split(",").map((o) => o.trim()).filter(Boolean);
    data.activePoll = { question, options, votes: {} };
    console.log(`📊 סקר התחיל: ${question} (${options.join(" / ")})`);
    cleanText = cleanText.replace(m[0], "");
  }

  // הצבעה - [VOTE: אופציה]
  const voteMatches = [...text.matchAll(/\[VOTE:\s*([^\]]+)\]/g)];
  for (const m of voteMatches) {
    const choice = m[1].trim();
    if (data.activePoll) {
      data.activePoll.votes[senderName || "לא ידוע"] = choice;
      console.log(`🗳️ ${senderName} הצביע: ${choice}`);
    }
    cleanText = cleanText.replace(m[0], "");
  }

  // סיום סקר והכרזת תוצאות - [POLL_END]
  if (/\[POLL_END\]/.test(text)) {
    cleanText = cleanText.replace(/\[POLL_END\]/g, "");
    if (data.activePoll) {
      const tally = {};
      for (const choice of Object.values(data.activePoll.votes)) {
        tally[choice] = (tally[choice] || 0) + 1;
      }
      const results = Object.entries(tally)
        .sort((a, b) => b[1] - a[1])
        .map(([opt, count]) => `${opt}: ${count} קולות`)
        .join("\n");
      const winner = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
      cleanText += `\n\n📊 תוצאות הסקר "${data.activePoll.question}":\n${results || "אף אחד לא הצביע 😅"}`;
      if (winner) cleanText += `\n\n🏆 המנצח: ${winner[0]}!`;
      data.activePoll = null;
      console.log("📊 סקר הסתיים");
    }
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

  async function findFamilyGroupId(retriesLeft = 5) {
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
      console.error("שגיאה באיתור הקבוצה המשפחתית:", e?.data || e?.message || e);
      // אם נכשל (למשל 429 - עומס), ננסה שוב אחרי המתנה
      if (retriesLeft > 0) {
        const waitSec = 15;
        console.log(`🔄 ננסה למצוא את הקבוצה שוב בעוד ${waitSec} שניות (${retriesLeft} ניסיונות נותרו)`);
        setTimeout(() => findFamilyGroupId(retriesLeft - 1), waitSec * 1000);
      } else {
        console.error("❌ לא הצלחתי למצוא את הקבוצה המשפחתית אחרי כמה ניסיונות");
      }
    }
  }

  async function sendMorningBriefing() {
    if (!familyGroupId) {
      console.log("⚠️ לא ניתן לשלוח תדריך בוקר - הקבוצה המשפחתית לא נמצאה");
      return;
    }
    try {
      const data = loadData();
      const now = new Date();
      const hebrewDayNames = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
      const realDate = `יום ${hebrewDayNames[now.getDay()]}, ${now.getDate()}/${now.getMonth() + 1}/${now.getFullYear()}`;
      const prompt = `היום הוא: ${realDate} (זהו התאריך האמיתי והמדויק - השתמש בו, אל תנחש תאריך אחר!)

כתוב תדריך בוקר קצר וחם למשפחה, שיישלח כהודעה אחת בקבוצת הוואטסאפ המשפחתית. כלול:
1) פתיחה חמה של "בוקר טוב" עם היום והתאריך שצוינו למעלה.
2) משפט מוטיבציה קצר אחד שמתאים אישית לכל אחד מבני המשפחה (אסף, שירן, ענבר, איתמר, שלו) בהתאם לאופי שמתואר לך.
3) הצעה אחת קטנה וקונקרטית לפעילות משפחתית נחמדה לעשות היום או בקרוב (משהו קליל, לא יקר, מתאים לכולם).
תשובה קצרה וחמה, מקסימום 10-12 שורות בסך הכל, בעברית.`;

      const reply = await askGemini(prompt, data, "המערכת (תדריך בוקר אוטומטי)");
      const cleanReply = processCommands(reply, data, "המערכת");
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
      const hasActivity = data.dailyLog.length > 0;

      const logText = hasActivity
        ? data.dailyLog.map((e) => `${e.sender}: ${e.text}`).join("\n")
        : "(היום היה שקט בקבוצה - אף אחד לא כתב)";

      const prompt = `הנה כל מה שקרה היום בקבוצת המשפחה:

${logText}

כתוב סיכום ערב קצר ומצחיק לקבוצה המשפחתית. 
- אם הייתה פעילות: התייחס לכל מי שהשתתף היום בשם (אסף, שירן, ענבר, איתמר, שלו) עם תגובה הומוריסטית קלילה על מה שהם אמרו/ביקשו, ואם מישהו לא דיבר - ציין בשנינות
- אם היום היה שקט לגמרי: כתוב סיכום קצר ומשעשע על השקט (למשל "יום שקט להפליא... חשוד 🤨"), בלי להמציא דברים שלא קרו
- חפש בגוגל את תחזית מזג האוויר למחר באזור חדרה ישראל והוסף שורה אחת קצרה עם מה לצפות מחר
- סיים עם משפט ערב טוב חם לכל המשפחה
- מקסימום 12 שורות, עברית, טון קליל ומשפחתי`;

      const reply = await askGemini(prompt, data, "המערכת (סיכום ערב אוטומטי)");
      const cleanReply = processCommands(reply, data, "המערכת");

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
      const cleanReply = processCommands(reply, data, "המערכת");
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

      const pointsText = Object.keys(data.points || {}).length > 0
        ? Object.entries(data.points).map(([n, p]) => `${n}: ${p} נקודות`).join("\n")
        : "אין נקודות השבוע";

      const prompt = `הנה פעילות המשפחה מהשבוע האחרון:

== הודעות השבוע ==
${logText}

== אירועים שנרשמו ==
${eventsText}

== טבלת הנקודות (מטלות) ==
${pointsText}

כתוב סיכום שבועי הומוריסטי וחם לקבוצת המשפחה. 
- סקור בקצרה ובהומור מה קרה השבוע ומי היה הכי פעיל
- הכרז על אלוף/ת השבוע לפי טבלת הנקודות (אם יש נקודות) עם חגיגיות
- תן "פרס" מצחיק לכל אחד מבני המשפחה על משהו (למשל "פרס הכי הרבה בקשות קניות")
- הזכר אירועים חשובים שמתקרבים
- אחל שבת שלום וסוף שבוע נעים
- מקסימום 15 שורות, עברית, טון קליל ומשפחתי`;

      const reply = await askGemini(prompt, data, "המערכת (סיכום שבועי אוטומטי)");
      const cleanReply = processCommands(reply, data, "המערכת");

      // איפוס יומן שבועי, אירועים ישנים ונקודות לאחר הסיכום (תחרות חדשה כל שבוע)
      data.weeklyLog = [];
      data.events = [];
      data.points = {};
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
        let changed = false;
        const sendReminder = async (content, prefix = "⏰ תזכורת!") => {
          const sent = await sock.sendMessage(familyGroupId, { text: `${prefix}\n\n${content}` });
          if (sent?.key?.id) {
            botSentMessageIds.add(sent.key.id);
            if (botSentMessageIds.size > 50) {
              const first = botSentMessageIds.values().next().value;
              botSentMessageIds.delete(first);
            }
          }
          console.log(`⏰ תזכורת נשלחה: ${content}`);
        };

        // 1. תזכורות של "היום" (הפורמט הישן)
        const pending = data.scheduledReminders || [];
        const toFire = pending.filter(
          (r) => !r.type && r.date === todayStr && r.hour === h && r.minute === m
        );
        for (const r of toFire) await sendReminder(r.content);

        // 2. תזכורות לתאריך עתידי (DD/MM)
        const dateToFire = pending.filter(
          (r) => r.type === "date" && r.day === now.getDate() && r.month === now.getMonth() + 1 && r.hour === h && r.minute === m
        );
        for (const r of dateToFire) await sendReminder(r.content, "📆 תזכורת!");

        if (toFire.length > 0 || dateToFire.length > 0) {
          data.scheduledReminders = pending.filter(
            (r) => !toFire.includes(r) && !dateToFire.includes(r)
          );
          changed = true;
        }

        // 3. תזכורות שבועיות חוזרות (לא נמחקות אחרי שליחה)
        const weekly = (data.weeklyReminders || []).filter(
          (r) => r.dayOfWeek === now.getDay() && r.hour === h && r.minute === m
        );
        for (const r of weekly) await sendReminder(r.content, "🔁 תזכורת שבועית!");

        // 4. בדיקת ימי הולדת - פעם ביום ב-08:00
        if (h === 8 && m === 0) {
          const todayDM = `${now.getDate()}/${now.getMonth() + 1}`;
          const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
          const tomorrowDM = `${tomorrow.getDate()}/${tomorrow.getMonth() + 1}`;
          for (const b of data.birthdays || []) {
            const normalized = b.date.replace(/^0/, "").replace(/\/0/, "/");
            if (normalized === todayDM) {
              await sendReminder(`היום יום ההולדת של ${b.name}! 🥳 אל תשכחו לאחל מזל טוב!`, "🎂 יום הולדת!");
            } else if (normalized === tomorrowDM) {
              await sendReminder(`מחר יום ההולדת של ${b.name}! אולי כדאי להכין משהו? 😉`, "🎂 תזכורת מראש!");
            }
          }
        }

        if (changed) saveData(data);
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
      // גיבוי: אם עדיין לא זיהינו את הקבוצה בהתחברות, נתפוס אותה מכאן
      if (!familyGroupId) {
        familyGroupId = chatId;
        console.log(`👨‍👩‍👧‍👦 הקבוצה המשפחתית זוהתה מהודעה נכנסת: ${groupMetadata.subject}`);
      }
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
          const cleanReply = processCommands(reply, data, senderName);
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
      const cleanReply = processCommands(reply, data, senderName);

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
