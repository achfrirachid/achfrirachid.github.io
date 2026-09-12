// ============================================================
// Worker وسيط — كيخبي جميع التوكنات، لا التطبيق ولا ملف الهاتف فيهم حتى توكن
// ============================================================

const ALLOWED_ORIGINS = ["https://achfrirachid.github.io"]; // حيدو لـ "*" كان بدلتي الدومين ديالك

function corsHeaders(origin) {
  // ⭐ 2026-09-12: الأمان الحقيقي هو فحص X-Proxy-Key فداخل الطلب نفسه (تحت)،
  // ماشي فمصدر الطلب (Origin). فهاذشي، خلينا CORS مفتوح لأي مصدر (بما فيه
  // صفحات محلية مفتوحة من التحميلات، كنستعملوها كأدوات مساعدة مؤقتة)، بلا
  // ما نخسرو الحماية الحقيقية.
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Proxy-Key",
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

// ============================================================
// TTS بصوت رجل/امرأة عبر Microsoft Edge (Neural voices) — بلا API key.
// ⭐ هادشي بروتوكول غير رسمي (reverse-engineered) مستعمل بزاف من الناس
// (edge-tts)، فإلا مايكروسوفت بدلات شي حاجة فالمستقبل ممكن يتوقف — لهاد
// السبب /tts فيها fallback أوتوماتيكي لـ Google Translate TTS (صوت وحيد
// ثابت) إلا فشل هادشي.
// ============================================================
const EDGE_TTS_TRUSTED_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const EDGE_TTS_VOICES = { male: "ar-MA-JamalNeural", female: "ar-MA-MounaNeural" };

async function edgeTtsSecMsGec() {
  const WIN_EPOCH = 11644473600; // ثواني بين 1601-01-01 و 1970-01-01
  let ticks = Date.now() / 1000 + WIN_EPOCH;
  ticks -= ticks % 300; // تقريب لأقرب 5 دقايق (متطلب فالبروتوكول)
  ticks *= 1e7; // تحويل لوحدة 100-نانوثانية (Windows FILETIME)
  const str = `${Math.round(ticks)}${EDGE_TTS_TRUSTED_TOKEN}`;
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

async function edgeTtsSynthesize(text, voiceName) {
  const secMsGec = await edgeTtsSecMsGec();
  const connectionId = crypto.randomUUID().replace(/-/g, "");
  const wsUrl = `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${EDGE_TTS_TRUSTED_TOKEN}&Sec-MS-GEC=${secMsGec}&Sec-MS-GEC-Version=1-131.0.2903.99&ConnectionId=${connectionId}`;

  const resp = await fetch(wsUrl, { headers: { Upgrade: "websocket" } });
  const ws = resp.webSocket;
  if (!ws) throw new Error("edge_tts_ws_upgrade_failed");
  ws.accept();

  const audioChunks = [];
  let settled = false;

  const finished = new Promise((resolve, reject) => {
    ws.addEventListener("message", (event) => {
      const data = event.data;
      if (typeof data === "string") {
        if (data.includes("Path:turn.end")) { settled = true; resolve(); }
      } else {
        // رسالة binary: أول 2 بايت = طول الهيدر (big-endian)، من بعد الهيدر نص، من بعد بايتات الصوت
        const buf = data instanceof ArrayBuffer ? data : data.buffer;
        const view = new DataView(buf);
        const headerLen = view.getUint16(0, false);
        audioChunks.push(new Uint8Array(buf, 2 + headerLen));
      }
    });
    ws.addEventListener("close", () => { if (!settled) resolve(); });
    ws.addEventListener("error", () => { if (!settled) reject(new Error("edge_tts_ws_error")); });
  });

  const timestamp = new Date().toISOString();
  const requestId = crypto.randomUUID().replace(/-/g, "");
  const configMsg = `X-Timestamp:${timestamp}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
    JSON.stringify({ context: { synthesis: { audio: { metadataoptions: { sentenceBoundaryEnabled: "false", wordBoundaryEnabled: "false" }, outputFormat: "audio-24khz-48kbitrate-mono-mp3" } } } });
  const escapedText = String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='ar-MA'><voice name='${voiceName}'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>${escapedText}</prosody></voice></speak>`;
  const ssmlMsg = `X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${timestamp}Z\r\nPath:ssml\r\n\r\n${ssml}`;

  ws.send(configMsg);
  ws.send(ssmlMsg);

  await Promise.race([
    finished,
    new Promise((_, reject) => setTimeout(() => reject(new Error("edge_tts_timeout")), 15000)),
  ]);
  try { ws.close(); } catch (e) {}

  if (!audioChunks.length) throw new Error("edge_tts_no_audio");
  let totalLen = 0;
  for (const c of audioChunks) totalLen += c.length;
  const merged = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of audioChunks) { merged.set(c, offset); offset += c.length; }
  return merged.buffer;
}

// 🔒 قفل تلقائي: محاولات غالطة كثار => بلوكاج دقيقة وحدة لنفس الـ IP
// ⭐ رفعنا العتبة من 5 لـ 25: التطبيق نفسو كيدير "مزامنة دورية" كتبعت لحد 9 طلبات
// متوازية (Supabase/Firebase/Gmail/Telegram x2/WhatsApp/GitHub/Appwrite/سجل البطاقات)
// كل 2 دقايق — إلا كان PROXY_KEY قديم فجهاز واحد (كاش قديم مثلا)، 5 كانت كتبان
// سريعة بزاف وكتبلوكي التطبيق راسو من الاستعمال العادي، بلا ما يكون شي هجوم حقيقي.
const MAX_FAILED_ATTEMPTS = 25;
const BLOCK_SECONDS = 60; // دقيقة وحدة (تصحيح: القيمة الحقيقية ديما كانت 60 ثانية، ماشي 10 دقائق)
const FAIL_WINDOW_SECONDS = 120; // النافذة اللي كيتعدو فيها المحاولات

function rlKey(kind, ip) {
  return new Request(`https://ratelimit.internal/${kind}/${encodeURIComponent(ip)}`);
}

async function isBlocked(ip) {
  const cache = caches.default;
  const hit = await cache.match(rlKey("block", ip));
  return !!hit;
}

async function recordFailure(ip) {
  const cache = caches.default;
  const countReq = rlKey("count", ip);
  let count = 0;
  const cached = await cache.match(countReq);
  if (cached) count = parseInt(await cached.text(), 10) || 0;
  count++;

  await cache.put(countReq, new Response(String(count), {
    headers: { "Cache-Control": `max-age=${FAIL_WINDOW_SECONDS}` },
  }));

  if (count >= MAX_FAILED_ATTEMPTS) {
    await cache.put(rlKey("block", ip), new Response("blocked", {
      headers: { "Cache-Control": `max-age=${BLOCK_SECONDS}` },
    }));
  }
}

// ============================================================
// FCM (Firebase Cloud Messaging) — Push حقيقي يوصل حتى التطبيق مسكر
// كيحتاج 3 أسرار فـ Cloudflare env vars، مأخوذين من Service Account JSON
// (Firebase Console → Project Settings → Service Accounts → Generate new private key):
//   FCM_PROJECT_ID    → "project_id" فالملف
//   FCM_CLIENT_EMAIL  → "client_email" فالملف
//   FCM_PRIVATE_KEY   → "private_key" فالملف (كاملة، بما فيها BEGIN/END PRIVATE KEY)
// ============================================================
function _b64url(bytes) {
  let bin = typeof bytes === "string" ? bytes : String.fromCharCode(...new Uint8Array(bytes));
  return btoa(bin).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function getFcmAccessToken(env) {
  const cache = caches.default;
  const cacheReq = rlKey("fcm-token", "shared");
  const cached = await cache.match(cacheReq);
  if (cached) {
    const j = await cached.json();
    if (j.token) return j.token;
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: env.FCM_CLIENT_EMAIL,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const unsigned = _b64url(JSON.stringify(header)) + "." + _b64url(JSON.stringify(claim));

  const pem = String(env.FCM_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  const pemBody = pem.replace(/-----BEGIN PRIVATE KEY-----/, "").replace(/-----END PRIVATE KEY-----/, "").replace(/\s/g, "");
  const der = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8", der.buffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const jwt = unsigned + "." + _b64url(sig);

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") + "&assertion=" + encodeURIComponent(jwt),
  });
  const tokenJ = await tokenRes.json();
  if (!tokenRes.ok || !tokenJ.access_token) {
    throw new Error("fcm_oauth_failed: " + JSON.stringify(tokenJ));
  }

  const ttl = Math.max(60, (tokenJ.expires_in || 3600) - 120); // نسالف 2 دقايق قبل الانتهاء الحقيقي
  await cache.put(cacheReq, new Response(JSON.stringify({ token: tokenJ.access_token }), {
    headers: { "Cache-Control": `max-age=${ttl}` },
  }));
  return tokenJ.access_token;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    // ⭐ إصلاح جذري: كل شي (بما فيه فحص الحظر والمفتاح السري) دابا داخل نفس
    // try/catch الكبير، باش أي كراش (حتى ولو جا من caches.default نفسها)
    // يرجع دايما جواب JSON فيه CORS headers، وماشي صفحة خطأ Cloudflare
    // العامة اللي كانت كتبان فالمتصفح بحال "Failed to fetch" (بلا علاقة بالشبكة)
    try {
      // 🔒 إلا كان محظور بسبب محاولات فاشلة سابقة
      let blocked = false;
      try { blocked = await isBlocked(ip); } catch (e) { console.error("isBlocked error", e); }
      if (blocked) return json({ error: "blocked_try_later" }, 429, origin);

      // 🔒 حماية: كل طلب خاصو المفتاح السري فالـ header، غير كذلك كيترفض
      // ⭐ استثناء: /dropbox-init محمي بطبعو (خاصو code صحيح وطازة من Dropbox
      // نفسه، صالح دقائق قليلة وغير مرة وحدة) — كنستثنيوه باش يتحل مباشرة
      // من المتصفح (address bar) بلا ما يحتاج header، حيت المتصفح ما يقدرش
      // يزيد headers مخصصة لرابط كيتحل عادي.
      const isPublicDropboxInit = (url.pathname === "/dropbox-init" && request.method === "GET")
        || (url.pathname === "/box-whoami" && request.method === "GET");
      const key = request.headers.get("X-Proxy-Key") || "";
      // ⭐ تشخيص أدق: إلا PROXY_KEY ماشي معمر أصلا فـ Cloudflare (env var ناقصة)،
      // نرجعو سبب واضح بدل "unauthorized" العام — هادشي كان كيبان بحال مشكل فـ
      // GitHub بينما الحقيقة كانت PROXY_KEY ناقصة أو ماكتطابقش مع اللي فالتطبيق.
      if (!isPublicDropboxInit) {
      if (!env.PROXY_KEY) {
        try { await recordFailure(ip); } catch (e) { console.error("recordFailure error", e); }
        return json({ error: "missing_proxy_key_env" }, 500, origin);
      }
      if (key !== env.PROXY_KEY) {
        try { await recordFailure(ip); } catch (e) { console.error("recordFailure error", e); }
        return json({ error: "unauthorized", hint: "proxy_key_mismatch" }, 401, origin);
      }
      }

      // ---- WhatsApp (green-api) ----
      if (url.pathname === "/wa" && request.method === "POST") {
        const { text, target } = await request.json();
        const chatId = target === "teacher" ? env.WA_TEACHER_CHAT_ID : env.WA_CHAT_ID;
        if (!chatId) return json({ error: "missing_chat_id_for_target" }, 400, origin);
        const r = await fetch(
          `https://api.green-api.com/waInstance${env.WA_INSTANCE_ID}/sendMessage/${env.WA_TOKEN}`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId, message: text }) }
        );
        const j = await r.json();
        return json(j, r.ok ? 200 : 502, origin);
      }

      // ---- WhatsApp: إرسال صورة (وصل/بطاقة) نيشان لرقم محدد عبر Green API ----
      // ⭐ كل واحد (رشيد ولا عائشة) عندو حساب Green API خاص بيه (رقم واتساب ديالو)،
      // "sender" كيحدد شكون كيصيفط: "teacher" = من رقم عائشة، غير كذلك = من رقم رشيد.
      if (url.pathname === "/wa-send-image" && request.method === "POST") {
        const { phone, filename, caption, imageBase64, sender } = await request.json();
        if (!phone || !imageBase64) return json({ error: "missing_params" }, 400, origin);
        const digits = String(phone).replace(/\D/g, "");
        if (!digits) return json({ error: "invalid_phone" }, 400, origin);
        const chatId = `${digits}@c.us`;
        const useTeacher = sender === "teacher";
        const instanceId = useTeacher ? (env.WA_TEACHER_INSTANCE_ID || env.WA_INSTANCE_ID) : env.WA_INSTANCE_ID;
        const token = useTeacher ? (env.WA_TEACHER_TOKEN || env.WA_TOKEN) : env.WA_TOKEN;
        if (!instanceId || !token) return json({ error: "wa_sender_not_configured" }, 500, origin);
        let bytes;
        try {
          const b64 = imageBase64.includes(",") ? imageBase64.split(",").pop() : imageBase64;
          bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        } catch (e) {
          return json({ error: "bad_image_data" }, 400, origin);
        }
        const form = new FormData();
        form.append("chatId", chatId);
        form.append("caption", caption || "");
        form.append("file", new Blob([bytes], { type: "image/png" }), filename || "image.png");
        const r = await fetch(
          `https://api.green-api.com/waInstance${instanceId}/sendFileByUpload/${token}`,
          { method: "POST", body: form }
        );
        const j = await r.json().catch(() => ({}));
        return json(j, r.ok ? 200 : 502, origin);
      }

      // ---- WhatsApp: تنظيف تقارير التطبيق — يبقى تقرير واحد فقط ----
      if (url.pathname === "/wa-cleanup" && request.method === "POST") {
        const { keepId, target } = await request.json();
        const chatId = target === "teacher" ? env.WA_TEACHER_CHAT_ID : env.WA_CHAT_ID;
        if (!chatId) return json({ error: "missing_chat_id_for_target" }, 400, origin);
        const historyRes = await fetch(
          `https://api.green-api.com/waInstance${env.WA_INSTANCE_ID}/getChatHistory/${env.WA_TOKEN}`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId, count: 300 }) }
        );
        const history = await historyRes.json().catch(() => []);
        if (!historyRes.ok || !Array.isArray(history)) return json({ error: "history_failed" }, 502, origin);
        const reports = history.filter((m) => {
          if (!m || m.type !== "outgoing" || m.isDeleted) return false;
          const body = String(m.body || m.textMessage || m.caption || "");
          const fileName = String(m.fileName || "");
          return body.includes("تقرير إضافة طلبة من ملف الهاتف")
            || /^تقرير_(?:الطلبة(?:_[0-9]{4}-[0-9]{2}-[0-9]{2})?|المعلمة)\.(?:png|doc)$/.test(fileName);
        }).sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
        const keep = new Set();
        if (keepId) keep.add(String(keepId));
        let deleted = 0;
        for (const report of reports) {
          if (keep.has(String(report.idMessage))) continue;
          const del = await fetch(
            `https://api.green-api.com/waInstance${env.WA_INSTANCE_ID}/deleteMessage/${env.WA_TOKEN}`,
            { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId, idMessage: report.idMessage }) }
          );
          if (del.ok) deleted++;
        }
        return json({ ok: true, kept: keep.size, deleted }, 200, origin);
      }

      // ---- WhatsApp: حذف رسالة قديمة (باش نبقاو على رسالة واحدة بدل ما نكثرو) ----
      if (url.pathname === "/wa-delete" && request.method === "POST") {
        const { idMessage, target } = await request.json();
        if (!idMessage) return json({ error: "missing_idMessage" }, 400, origin);
        const chatId = target === "teacher" ? env.WA_TEACHER_CHAT_ID : env.WA_CHAT_ID;
        if (!chatId) return json({ error: "missing_chat_id_for_target" }, 400, origin);
        const r = await fetch(
          `https://api.green-api.com/waInstance${env.WA_INSTANCE_ID}/deleteMessage/${env.WA_TOKEN}`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId, idMessage }) }
        );
        const j = await r.json().catch(() => ({}));
        return json(j, r.ok ? 200 : 502, origin);
      }

      // ---- WhatsApp: فحص وجود تقرير محفوظ قبل التخطي ----
      if (url.pathname === "/wa-message-exists" && request.method === "POST") {
        const { idMessage, target } = await request.json();
        if (!idMessage) return json({ error: "missing_idMessage" }, 400, origin);
        const chatId = target === "teacher" ? env.WA_TEACHER_CHAT_ID : env.WA_CHAT_ID;
        if (!chatId) return json({ error: "missing_chat_id_for_target" }, 400, origin);
        const r = await fetch(
          `https://api.green-api.com/waInstance${env.WA_INSTANCE_ID}/getMessage/${env.WA_TOKEN}`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId, idMessage }) }
        );
        const j = await r.json().catch(() => null);
        return json({ ok: true, exists: !!(r.ok && j && !j.isDeleted) }, 200, origin);
      }

      // ---- WhatsApp: تفعيل التقارير التلقائية برقم صاحب الحساب — كود عبر واتساب، بلا أي توكن فالتطبيق ----
      // الكود كيتخزن هنا فالسيرفر فقط (Cache API، 5 دقايق)، ماشي فالمتصفح، وماشي فالتطبيق.
      if (url.pathname === "/wa-otp-send" && request.method === "POST") {
        const { target } = await request.json();
        if (target !== "admin" && target !== "teacher") return json({ error: "invalid_target" }, 400, origin);
        const chatId = target === "teacher" ? env.WA_TEACHER_CHAT_ID : env.WA_CHAT_ID;
        if (!chatId || !env.WA_INSTANCE_ID || !env.WA_TOKEN) return json({ error: "wa_not_configured" }, 500, origin);
        const code = String(Math.floor(1000 + Math.random() * 9000));
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code));
        const hashHex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
        const cache = caches.default;
        await cache.put(
          rlKey("wa-otp-" + target, "hash"),
          new Response(JSON.stringify({ hash: hashHex, attempts: 0, chatId }), { headers: { "Cache-Control": "max-age=300" } })
        );
        const label = target === "admin" ? "رشيد" : "عائشة";
        const message = `🔐 رمز تفعيل تقارير واتساب\n\nالحساب: ${label}\nالرمز: ${code}\n\nصالح لمدة 5 دقائق، ولا تشاركه مع أي شخص.`;
        const r = await fetch(
          `https://api.green-api.com/waInstance${env.WA_INSTANCE_ID}/sendMessage/${env.WA_TOKEN}`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId, message }) }
        );
        const j = await r.json().catch(() => null);
        if (!r.ok || !j || !j.idMessage) return json({ error: "send_failed" }, 502, origin);
        return json({ ok: true }, 200, origin);
      }

      // ---- WhatsApp: تأكيد كود التفعيل — المقارنة كتصير هنا فالسيرفر، الكود ماكيوصلش للمتصفح ----
      if (url.pathname === "/wa-otp-verify" && request.method === "POST") {
        const { target, code } = await request.json();
        if (target !== "admin" && target !== "teacher") return json({ error: "invalid_target" }, 400, origin);
        const cache = caches.default;
        const cached = await cache.match(rlKey("wa-otp-" + target, "hash"));
        if (!cached) return json({ ok: false, error: "expired" }, 200, origin);
        const pending = await cached.json();
        if ((pending.attempts || 0) >= 5) {
          await cache.delete(rlKey("wa-otp-" + target, "hash"));
          return json({ ok: false, error: "too_many_attempts" }, 200, origin);
        }
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(code || "").trim()));
        const hashHex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
        if (hashHex !== pending.hash) {
          pending.attempts = (pending.attempts || 0) + 1;
          await cache.put(rlKey("wa-otp-" + target, "hash"), new Response(JSON.stringify(pending), { headers: { "Cache-Control": "max-age=300" } }));
          return json({ ok: false, error: "wrong_code" }, 200, origin);
        }
        await cache.delete(rlKey("wa-otp-" + target, "hash"));
        return json({ ok: true, chatId: pending.chatId }, 200, origin);
      }

      // ---- WhatsApp: تمرير عام (Relay) لأي عملية Green API — بلا ما يوصل التوكن للتطبيق أبدا ----
      // ⭐ كل واحد (رشيد ولا عائشة) عندو حساب Green API خاص بيه — "sender" كيحدد
      // شكون كيصيفط (نفس منطق /wa-send-image)، بفولباك لحساب رشيد إلا ماكانش حساب عائشة معمر بعد.
      if (url.pathname === "/wa-relay" && request.method === "POST") {
        const { endpoint, params, httpMethod, pathSuffix, sender } = await request.json();
        const allowedEndpoints = ["sendMessage", "deleteMessage", "getChatHistory", "getMessage", "getStateInstance", "receiveNotification", "deleteNotification"];
        if (!allowedEndpoints.includes(endpoint)) return json({ error: "endpoint_not_allowed" }, 400, origin);
        const useTeacher = sender === "teacher";
        const instanceId = useTeacher ? (env.WA_TEACHER_INSTANCE_ID || env.WA_INSTANCE_ID) : env.WA_INSTANCE_ID;
        const token = useTeacher ? (env.WA_TEACHER_TOKEN || env.WA_TOKEN) : env.WA_TOKEN;
        if (!instanceId || !token) return json({ error: "wa_sender_not_configured" }, 500, origin);
        let apiUrl = `https://api.green-api.com/waInstance${instanceId}/${endpoint}/${token}`;
        if (pathSuffix) apiUrl += `/${encodeURIComponent(pathSuffix)}`;
        const method = httpMethod || "POST";
        if ((method === "GET" || method === "DELETE") && params) apiUrl += "?" + new URLSearchParams(params).toString();
        const r = await fetch(apiUrl, method === "GET" ? undefined : method === "DELETE" ? { method: "DELETE" } : {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params || {}),
        });
        const j = await r.json().catch(() => null);
        return json(j, r.ok ? 200 : 502, origin);
      }

      // ---- WhatsApp: تمرير رفع ملف (FormData) — بديل عام لـ sendFileByUpload بلا توكن فالتطبيق ----
      // ⭐ نفس منطق /wa-relay: "sender" (حقل formData) كيحدد حساب Green API المستعمل، بفولباك لرشيد.
      if (url.pathname === "/wa-file-relay" && request.method === "POST") {
        const incoming = await request.formData();
        const chatId = incoming.get("chatId");
        const file = incoming.get("file");
        const caption = incoming.get("caption") || "";
        const sender = incoming.get("sender");
        if (!chatId || !file) return json({ error: "missing_params" }, 400, origin);
        const useTeacher = sender === "teacher";
        const instanceId = useTeacher ? (env.WA_TEACHER_INSTANCE_ID || env.WA_INSTANCE_ID) : env.WA_INSTANCE_ID;
        const token = useTeacher ? (env.WA_TEACHER_TOKEN || env.WA_TOKEN) : env.WA_TOKEN;
        if (!instanceId || !token) return json({ error: "wa_sender_not_configured" }, 500, origin);
        const form = new FormData();
        form.append("chatId", chatId);
        form.append("caption", caption);
        form.append("file", file, file.name || "file.png");
        const r = await fetch(
          `https://api.green-api.com/waInstance${instanceId}/sendFileByUpload/${token}`,
          { method: "POST", body: form }
        );
        const j = await r.json().catch(() => ({}));
        return json(j, r.ok ? 200 : 502, origin);
      }

      // ---- Telegram ----
      // ⭐ بوتين: achfri (TG_TOKEN، النسخ الاحتياطية) و achfri1 (TG_TOKEN2، التقارير).
      // بارامتر "bot" فالطلب: 'report' → achfri1 | بلا تحديد أو 'backup' → achfri (فولباك للتوافق مع القديم)
      if (url.pathname === "/tg" && request.method === "POST") {
        const { text, bot, chat_id } = await request.json();
        const token = bot === "report" ? (env.TG_TOKEN2 || env.TG_TOKEN) : env.TG_TOKEN;
        if (!token) return json({ error: "tg_bot_not_configured" }, 500, origin);
        const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chat_id || env.TG_CHAT_ID, text }),
        });
        const j = await r.json();
        return json(j, r.ok ? 200 : 502, origin);
      }

      // ---- Telegram: تعديل رسالة موجودة فمكانها (بلا حذف ولا رسالة جديدة) ----
      if (url.pathname === "/tg-edit" && request.method === "POST") {
        const { message_id, text, bot, chat_id } = await request.json();
        if (!message_id || !text) return json({ error: "missing_params" }, 400, origin);
        const token = bot === "report" ? (env.TG_TOKEN2 || env.TG_TOKEN) : env.TG_TOKEN;
        if (!token) return json({ error: "tg_bot_not_configured" }, 500, origin);
        const r = await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chat_id || env.TG_CHAT_ID, message_id, text }),
        });
        const j = await r.json().catch(() => ({}));
        return json(j, r.ok ? 200 : 502, origin);
      }

      // ---- GitHub upload/update (Contents API) ----
      if (url.pathname === "/gh-upload" && request.method === "POST") {
        // ⭐ تحقق مبكر: إلا كان GH_TOKEN أو GH_REPO ماشي معمرين فـ Cloudflare،
        // نرجعو خطأ واضح بدل ما نخليو GitHub يرجع 401 غامضة (وهاد المشكل هو
        // السبب الأكثر احتمالا فـ "فشل الرفع" لي كتبان فالتطبيق)
        if (!env.GH_TOKEN || !env.GH_REPO) {
          return json({ error: "missing_gh_env", message: "GH_TOKEN أو GH_REPO ماشي معمرين فـ Cloudflare Worker env vars" }, 500, origin);
        }
        const { filename, contentBase64 } = await request.json();
        // الفاصل "/" فالمسار خاصو يبقى حرفي (folder/file.json)، ماشي مشفر %2F،
        // GitHub Contents API كيقبل غير المسار الحرفي بالـ "/" الحقيقي
        const encodedPath = filename.split("/").map(encodeURIComponent).join("/");
        const apiUrl = `https://api.github.com/repos/${env.GH_REPO}/contents/${encodedPath}`;
        const ghHeaders = { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "student-tracker-worker" };
        let sha;
        const getRes = await fetch(apiUrl, { headers: ghHeaders });
        if (getRes.ok) sha = (await getRes.json()).sha;
        else if (getRes.status !== 404) {
          // مشكل فالتوكن ولا الريبو ولا الصلاحيات — نرجعو التفاصيل الحقيقية
          const errJ = await getRes.json().catch(() => ({}));
          return json({ error: "gh_get_failed", status: getRes.status, message: errJ.message || "" }, 502, origin);
        }
        const putRes = await fetch(apiUrl, {
          method: "PUT",
          headers: { ...ghHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ message: "backup update", content: contentBase64, sha }),
        });
        const j = await putRes.json();
        if (!putRes.ok) return json({ error: "gh_put_failed", status: putRes.status, message: j.message || "" }, 502, origin);
        return json(j, 200, origin);
      }

      // ---- GitHub download ----
      if (url.pathname === "/gh-download" && request.method === "GET") {
        if (!env.GH_TOKEN || !env.GH_REPO) {
          return json({ error: "missing_gh_env", message: "GH_TOKEN أو GH_REPO ماشي معمرين فـ Cloudflare Worker env vars" }, 500, origin);
        }
        const filename = url.searchParams.get("filename");
        const encodedPath = filename.split("/").map(encodeURIComponent).join("/");
        const apiUrl = `https://api.github.com/repos/${env.GH_REPO}/contents/${encodedPath}`;
        const r = await fetch(apiUrl, { headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "student-tracker-worker" } });
        if (!r.ok) {
          const errJ = await r.json().catch(() => ({}));
          return json({ error: "not_found", status: r.status, message: errJ.message || "" }, 404, origin);
        }
        const j = await r.json();
        const content = atob(j.content.replace(/\n/g, ""));
        return json({ content }, 200, origin);
      }

      // ---- TTS: تحويل نص لصوت — كيستعملو التطبيق باش يقول "خالص" وتأكيد الدفوعات ----
      if (url.pathname === "/tts" && request.method === "GET") {
        const text = (url.searchParams.get("text") || "").slice(0, 200);
        const lang = url.searchParams.get("lang") || "ar";
        const gender = (url.searchParams.get("gender") || url.searchParams.get("voice") || "").toLowerCase();
        if (!text) return json({ error: "missing_text" }, 400, origin);

        // ⭐ صوت رجل (رشيد) / صوت امرأة (عائشة) عبر Microsoft Edge Neural voices.
        // إلا فشل هادشي (تغيير فبروتوكول مايكروسوفت مثلا) كنكملو تحت لـ Google
        // Translate TTS (صوت وحيد ثابت) كباكاب باش الصوت يبقى خدام فكل الحالات.
        if (EDGE_TTS_VOICES[gender]) {
          try {
            const buf = await edgeTtsSynthesize(text, EDGE_TTS_VOICES[gender]);
            return new Response(buf, {
              status: 200,
              headers: { "Content-Type": "audio/mpeg", "Cache-Control": "public, max-age=604800", ...corsHeaders(origin) },
            });
          } catch (e) {
            // نكملو للباكاب تحت
          }
        }

        const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=${encodeURIComponent(lang)}&client=tw-ob`;
        const r = await fetch(ttsUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Referer": "https://translate.google.com/",
          },
        });
        if (!r.ok) return json({ error: "tts_failed" }, 502, origin);
        const buf = await r.arrayBuffer();
        return new Response(buf, {
          status: 200,
          headers: {
            "Content-Type": "audio/mpeg",
            "Cache-Control": "public, max-age=604800",
            ...corsHeaders(origin),
          },
        });
      }

      // ---- Firebase: قراءة مسار ----
      if (url.pathname === "/fb-read" && request.method === "GET") {
        const path = url.searchParams.get("path"); // مثال: users/xxx/students.json
        if (!/^users\/[A-Za-z0-9_\-]+\/students\.json$/.test(path || "")) {
          return json({ error: "invalid_path" }, 400, origin);
        }
        const authR = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${env.FB_API_KEY}`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ returnSecureToken: true }),
        });
        const authJ = await authR.json();
        if (!authR.ok || !authJ.idToken) return json({ error: "auth_failed" }, 502, origin);
        const r = await fetch(`${env.FB_DATABASE_URL}/${path}?auth=${authJ.idToken}`);
        const j = await r.json().catch(() => null);
        return json({ data: j }, r.ok ? 200 : 502, origin);
      }

      // ---- Firebase: كتابة ----
      if (url.pathname === "/fb-write" && request.method === "POST") {
        const body = await request.json(); // { path, data, method }
        if (!/^users\/[A-Za-z0-9_\-]+\/students\.json$/.test(body.path || "")) {
          return json({ error: "invalid_path" }, 400, origin);
        }
        if (!Array.isArray(body.data)) {
          return json({ error: "invalid_data" }, 400, origin);
        }
        const authR = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${env.FB_API_KEY}`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ returnSecureToken: true }),
        });
        const authJ = await authR.json();
        if (!authR.ok || !authJ.idToken) return json({ error: "auth_failed" }, 502, origin);
        const dbUrl = `${env.FB_DATABASE_URL}/${body.path}?auth=${authJ.idToken}`;
        const r = await fetch(dbUrl, { method: body.method || "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body.data) });
        const j = await r.json().catch(() => ({}));
        return json(j, r.ok ? 200 : 502, origin);
      }

      // ---- Cloudflare KV: قراءة ----
      // ⭐ ماكاينش توكن ولا مفتاح خارجي هنا — STUDENTS_KV هو الـ binding ديال KV
      // معرف مباشرة فـ wrangler.toml، Cloudflare كيربطو تلقائيا بـ env.STUDENTS_KV.
      if (url.pathname === "/kv-read" && request.method === "GET") {
        if (!env.STUDENTS_KV) {
          return json({ error: "missing_kv_binding", message: "STUDENTS_KV KV binding ماشي معمر فـ wrangler.toml" }, 500, origin);
        }
        const path = url.searchParams.get("path");
        if (!/^users\/[A-Za-z0-9_\-]+\/students\.json$/.test(path || "")) {
          return json({ error: "invalid_path" }, 400, origin);
        }
        const raw = await env.STUDENTS_KV.get(path);
        const data = raw ? JSON.parse(raw) : null;
        return json({ data }, 200, origin);
      }

      // ---- Cloudflare KV: كتابة ----
      if (url.pathname === "/kv-write" && request.method === "POST") {
        if (!env.STUDENTS_KV) {
          return json({ error: "missing_kv_binding", message: "STUDENTS_KV KV binding ماشي معمر فـ wrangler.toml" }, 500, origin);
        }
        const body = await request.json();
        if (!/^users\/[A-Za-z0-9_\-]+\/students\.json$/.test(body.path || "")) {
          return json({ error: "invalid_path" }, 400, origin);
        }
        if (!Array.isArray(body.data)) {
          return json({ error: "invalid_data" }, 400, origin);
        }
        await env.STUDENTS_KV.put(body.path, JSON.stringify(body.data));
        return json({ ok: true }, 200, origin);
      }

      // ============================================================
      // Dropbox — تخزين خفيف إضافي عبر Dropbox API v2 (من 2008). من 2021
      // التوكن العادي كيموت من بعد 4 سوايع، فلهذا كنستعملو "refresh token"
      // باش الـ Worker يجدد التوكن وحدو فكل طلب، ونخزنو التوكن المؤقت فـ
      // cache (بحال بالضبط اللي دايرين مع FCM) باش ما نطلبوش تجديد فكل مرة.
      // خاصها 3 secrets فـ env: DROPBOX_APP_KEY, DROPBOX_APP_SECRET,
      // DROPBOX_REFRESH_TOKEN.
      // ============================================================
      async function getDropboxAccessToken() {
        const cache = caches.default;
        const cacheReq = rlKey("dropbox-token", "shared");
        const cached = await cache.match(cacheReq);
        if (cached) {
          const j = await cached.json();
          if (j.token) return j.token;
        }
        const basicAuth = btoa(`${env.DROPBOX_APP_KEY}:${env.DROPBOX_APP_SECRET}`);
        const r = await fetch("https://api.dropboxapi.com/oauth2/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basicAuth}` },
          body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(env.DROPBOX_REFRESH_TOKEN)}`,
        });
        const j = await r.json();
        if (!r.ok || !j.access_token) throw new Error("dropbox_token_failed_" + JSON.stringify(j));
        await cache.put(cacheReq, new Response(JSON.stringify({ token: j.access_token }), {
          headers: { "Cache-Control": `max-age=${Math.max(60, (j.expires_in || 14400) - 120)}` },
        }));
        return j.access_token;
      }

      // ⭐ خطوة بناء لمرة وحدة فقط — كتحول "authorization code" (اللي كتعطيك
      // Dropbox من بعد ما تضغط Allow) إلى refresh_token دائم. من بعد ما تجيب
      // الـ refresh_token وتزيدو فـ DROPBOX_REFRESH_TOKEN، ماعادش محتاج هاد
      // الـ endpoint. خاصها DROPBOX_APP_KEY و DROPBOX_APP_SECRET معمرين قبل.
      if (url.pathname === "/dropbox-init" && request.method === "GET") {
        if (!env.DROPBOX_APP_KEY || !env.DROPBOX_APP_SECRET) {
          return json({ error: "missing_dropbox_config", message: "زيد DROPBOX_APP_KEY و DROPBOX_APP_SECRET أولا فـ env vars" }, 500, origin);
        }
        const code = url.searchParams.get("code");
        if (!code) return json({ error: "missing_code", message: "زيد ?code=... فالرابط" }, 400, origin);
        const basicAuth = btoa(`${env.DROPBOX_APP_KEY}:${env.DROPBOX_APP_SECRET}`);
        const r = await fetch("https://api.dropboxapi.com/oauth2/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basicAuth}` },
          body: `grant_type=authorization_code&code=${encodeURIComponent(code)}`,
        });
        const j = await r.json().catch(() => ({}));
        return json(j, r.ok ? 200 : 500, origin);
      }

      if (url.pathname === "/dropbox-write" && request.method === "POST") {
        if (!env.DROPBOX_APP_KEY || !env.DROPBOX_APP_SECRET || !env.DROPBOX_REFRESH_TOKEN) {
          return json({ error: "missing_dropbox_config", message: "خاصك DROPBOX_APP_KEY / DROPBOX_APP_SECRET / DROPBOX_REFRESH_TOKEN فـ env vars" }, 500, origin);
        }
        const body = await request.json();
        if (!/^users\/[A-Za-z0-9_\-]+\/students\.json$/.test(body.path || "")) return json({ error: "invalid_path" }, 400, origin);
        if (!Array.isArray(body.data)) return json({ error: "invalid_data" }, 400, origin);
        try {
          const token = await getDropboxAccessToken();
          const r = await fetch("https://content.dropboxapi.com/2/files/upload", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Dropbox-API-Arg": JSON.stringify({ path: "/" + body.path, mode: "overwrite", mute: true }),
              "Content-Type": "application/octet-stream",
            },
            body: JSON.stringify(body.data),
          });
          if (!r.ok) { const t = await r.text().catch(() => ""); return json({ ok: false, error: "dropbox_upload_failed_" + r.status, detail: t }, 500, origin); }
          return json({ ok: true }, 200, origin);
        } catch (e) { return json({ ok: false, error: String(e) }, 500, origin); }
      }

      if (url.pathname === "/dropbox-read" && request.method === "GET") {
        if (!env.DROPBOX_APP_KEY || !env.DROPBOX_APP_SECRET || !env.DROPBOX_REFRESH_TOKEN) {
          return json({ error: "missing_dropbox_config", message: "خاصك DROPBOX_APP_KEY / DROPBOX_APP_SECRET / DROPBOX_REFRESH_TOKEN فـ env vars" }, 500, origin);
        }
        const path = url.searchParams.get("path");
        if (!/^users\/[A-Za-z0-9_\-]+\/students\.json$/.test(path || "")) return json({ error: "invalid_path" }, 400, origin);
        try {
          const token = await getDropboxAccessToken();
          const r = await fetch("https://content.dropboxapi.com/2/files/download", {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Dropbox-API-Arg": JSON.stringify({ path: "/" + path }) },
          });
          if (r.status === 409) return json({ ok: true, data: null }, 200, origin); // الملف ماكاينش بعد
          if (!r.ok) { const t = await r.text().catch(() => ""); return json({ ok: false, error: "dropbox_download_failed_" + r.status, detail: t }, 500, origin); }
          const data = await r.json();
          return json({ ok: true, data }, 200, origin);
        } catch (e) { return json({ ok: false, error: String(e) }, 500, origin); }
      }

      // ============================================================
      // Box — تخزين خفيف إضافي عبر Box API (Client Credentials Grant).
      // من 2005، مؤسساتية وموثقة بزاف. حساب Developer مجاني كيعطي Enterprise
      // ID تلقائي (10GB تخزين). خاصها 3 secrets فـ env: BOX_CLIENT_ID,
      // BOX_CLIENT_SECRET, BOX_ENTERPRISE_ID.
      // ============================================================

      // ⭐ مؤقت (2026-09-12): endpoint إعداد فقط باش نجيبو Enterprise ID
      // بسهولة عبر Developer Token مؤقت (صالح ساعة وحدة فقط) بدل ما نقلبو
      // عليه يدويا فواجهة Box. آمن حيت محمي بطبعو (خاصو token صحيح وطازة
      // من Box نفسه). يتحذف من بعد ما تخدم.
      if (url.pathname === "/box-whoami" && request.method === "GET") {
        const devToken = url.searchParams.get("token");
        if (!devToken) return json({ error: "missing_token" }, 400, origin);
        try {
          const r = await fetch("https://api.box.com/2.0/users/me?fields=enterprise,login,name", {
            headers: { Authorization: `Bearer ${devToken}` },
          });
          const j = await r.json().catch(() => ({}));
          return json(j, r.status, origin);
        } catch (e) {
          return json({ ok: false, error: String(e) }, 500, origin);
        }
      }

      function boxFileName(p) { return p.replace(/\//g, "__"); }

      async function getBoxAccessToken() {
        const cache = caches.default;
        const cacheReq = rlKey("box-token", "shared");
        const cached = await cache.match(cacheReq);
        if (cached) {
          const j = await cached.json();
          if (j.token) return j.token;
        }
        const r = await fetch("https://api.box.com/oauth2/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: `grant_type=client_credentials&client_id=${encodeURIComponent(env.BOX_CLIENT_ID)}&client_secret=${encodeURIComponent(env.BOX_CLIENT_SECRET)}&box_subject_type=enterprise&box_subject_id=${encodeURIComponent(env.BOX_ENTERPRISE_ID)}`,
        });
        const j = await r.json();
        if (!r.ok || !j.access_token) throw new Error("box_token_failed_" + JSON.stringify(j));
        await cache.put(cacheReq, new Response(JSON.stringify({ token: j.access_token }), {
          headers: { "Cache-Control": `max-age=${Math.max(60, (j.expires_in || 3600) - 120)}` },
        }));
        return j.access_token;
      }

      async function boxFindFileId(token, filename) {
        const r = await fetch(`https://api.box.com/2.0/search?query=${encodeURIComponent(filename)}&type=file&content_types=name&limit=10`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !Array.isArray(j.entries)) return null;
        const hit = j.entries.find((e) => e.name === filename);
        return hit ? hit.id : null;
      }

      async function boxUploadFile(fileId, filename, content, isNew) {
        const token = await getBoxAccessToken();
        const form = new FormData();
        form.append("attributes", JSON.stringify(isNew ? { name: filename, parent: { id: "0" } } : { name: filename }));
        form.append("file", new Blob([content], { type: "application/json" }), filename);
        const endpoint = isNew ? "https://upload.box.com/api/2.0/files/content" : `https://upload.box.com/api/2.0/files/${fileId}/content`;
        const r = await fetch(endpoint, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
        return r;
      }

      if (url.pathname === "/box-write" && request.method === "POST") {
        if (!env.BOX_CLIENT_ID || !env.BOX_CLIENT_SECRET || !env.BOX_ENTERPRISE_ID) {
          return json({ error: "missing_box_config", message: "خاصك BOX_CLIENT_ID / BOX_CLIENT_SECRET / BOX_ENTERPRISE_ID فـ env vars" }, 500, origin);
        }
        const body = await request.json();
        if (!/^users\/[A-Za-z0-9_\-]+\/students\.json$/.test(body.path || "")) return json({ error: "invalid_path" }, 400, origin);
        if (!Array.isArray(body.data)) return json({ error: "invalid_data" }, 400, origin);
        try {
          const token = await getBoxAccessToken();
          const filename = boxFileName(body.path);
          const content = JSON.stringify(body.data);
          const existingId = await boxFindFileId(token, filename);
          let r = await boxUploadFile(existingId, filename, content, !existingId);
          if (r.status === 409) {
            const j = await r.json().catch(() => ({}));
            const conflictId = j?.context_info?.conflicts?.id || (Array.isArray(j?.context_info?.conflicts) && j.context_info.conflicts[0]?.id);
            if (conflictId) r = await boxUploadFile(conflictId, filename, content, false);
          }
          if (!r.ok) { const t = await r.text().catch(() => ""); return json({ ok: false, error: "box_upload_failed_" + r.status, detail: t }, 500, origin); }
          return json({ ok: true }, 200, origin);
        } catch (e) { return json({ ok: false, error: String(e) }, 500, origin); }
      }

      if (url.pathname === "/box-read" && request.method === "GET") {
        if (!env.BOX_CLIENT_ID || !env.BOX_CLIENT_SECRET || !env.BOX_ENTERPRISE_ID) {
          return json({ error: "missing_box_config", message: "خاصك BOX_CLIENT_ID / BOX_CLIENT_SECRET / BOX_ENTERPRISE_ID فـ env vars" }, 500, origin);
        }
        const path = url.searchParams.get("path");
        if (!/^users\/[A-Za-z0-9_\-]+\/students\.json$/.test(path || "")) return json({ error: "invalid_path" }, 400, origin);
        try {
          const token = await getBoxAccessToken();
          const filename = boxFileName(path);
          const id = await boxFindFileId(token, filename);
          if (!id) return json({ ok: true, data: null }, 200, origin);
          const r = await fetch(`https://api.box.com/2.0/files/${id}/content`, { headers: { Authorization: `Bearer ${token}` } });
          if (!r.ok) { const t = await r.text().catch(() => ""); return json({ ok: false, error: "box_download_failed_" + r.status, detail: t }, 500, origin); }
          const data = JSON.parse(await r.text());
          return json({ ok: true, data }, 200, origin);
        } catch (e) { return json({ ok: false, error: String(e) }, 500, origin); }
      }

      // ---- FCM: إرسال إشعار Push حقيقي (كيوصل حتى التطبيق مسكر) ----
      if (url.pathname === "/fcm-send" && request.method === "POST") {
        if (!env.FCM_PROJECT_ID || !env.FCM_CLIENT_EMAIL || !env.FCM_PRIVATE_KEY) {
          return json({ error: "fcm_not_configured", message: "خاصك تزيد FCM_PROJECT_ID / FCM_CLIENT_EMAIL / FCM_PRIVATE_KEY فـ Cloudflare Worker env vars" }, 500, origin);
        }
        const { tokens, title, body: msgBody, data } = await request.json();
        const list = Array.isArray(tokens) ? tokens.filter(Boolean) : (tokens ? [tokens] : []);
        if (!list.length) return json({ error: "missing_tokens" }, 400, origin);

        let accessToken;
        try {
          accessToken = await getFcmAccessToken(env);
        } catch (e) {
          return json({ error: "fcm_auth_failed", message: String(e) }, 502, origin);
        }

        const dataStr = {};
        if (data && typeof data === "object") {
          for (const k of Object.keys(data)) dataStr[k] = String(data[k]);
        }

        const results = [];
        for (const token of list) {
          try {
            const r = await fetch(
              `https://fcm.googleapis.com/v1/projects/${env.FCM_PROJECT_ID}/messages:send`,
              {
                method: "POST",
                headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                  message: {
                    token,
                    // ⭐ ما كنبعتوش "notification" فالمستوى الأعلى — كنبعتو data-only
                    // باش onBackgroundMessage فـ firebase-messaging-sw.js يخدم بشكل
                    // مضمون فالحالتين (تطبيق مسكر أو فالخلفية)، ونتحكموا فالضغطة
                    // على الإشعار (تفتح مباشرة خانة الدفع).
                    data: {
                      ...dataStr,
                      title: title || "💰 عملية دفع",
                      body: msgBody || "",
                    },
                    android: { priority: "high" },
                    webpush: {
                      headers: { Urgency: "high" },
                      fcm_options: { link: (data && data.url) || "./" },
                    },
                  },
                }),
              }
            );
            const j = await r.json().catch(() => ({}));
            results.push({ token, ok: r.ok, response: j });
          } catch (e) {
            results.push({ token, ok: false, error: String(e) });
          }
        }
        const anyOk = results.some((x) => x.ok);
        return json({ ok: anyOk, results }, anyOk ? 200 : 502, origin);
      }

      return json({ error: "not_found" }, 404, origin);
    } catch (e) {
      return json({ error: String(e) }, 500, origin);
    }
  },
};
