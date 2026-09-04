/**
 * gmail-backup.js
 * ملف مستقل تماما — بلا Firebase Functions، بلا Cloudflare Worker، بلا deploy.
 * كيرسل نسخة احتياطية من بيانات التطبيق مباشرة لجيميل عبر خدمة EmailJS.
 *
 * طريقة التركيب فـ index.html:
 * 1) زيد هاد السطر فـ <head> أو قبل نهاية <body>، قبل ما تستدعي هاد الملف:
 *      <script src="https://cdn.jsdelivr.net/npm/@emailjs/browser@4/dist/email.min.js"></script>
 * 2) زيد بعدو:
 *      <script src="gmail-backup.js"></script>
 * 3) ملي تكون البيانات ديال التطبيق جاهزة للحفظ، غير نادي:
 *      GmailBackup.send(JSON.stringify(appData));
 *    (أو صيفط أي نص/JSON بغيتي تخزنو)
 */

(function () {
  "use strict";

  // ==== الإعدادات ديال EmailJS (خاصة بحسابك) ====
  const EMAILJS_PUBLIC_KEY = "sv6od351jhUWbeQSD";
  const EMAILJS_SERVICE_ID = "service_65i6oo";
  const EMAILJS_TEMPLATE_ID = "template_v2gcetm";

  // مفتاح localStorage لتتبع آخر نسخة تم إرسالها (باش ما نعاودوش نرسلو نفس البيانات مرتين)
  const LAST_HASH_KEY = "gmailBackup_lastHash_v1";
  const LAST_TIME_KEY = "gmailBackup_lastTime_v1";

  let initialized = false;

  function ensureInit() {
    if (initialized) return;
    if (typeof emailjs === "undefined") {
      console.error(
        "[gmail-backup] مكتبة emailjs ماتحملاتش. تأكد من إضافة سكريبت EmailJS قبل هاد الملف."
      );
      return;
    }
    emailjs.init({ publicKey: EMAILJS_PUBLIC_KEY });
    initialized = true;
  }

  // hash بسيط باش نعرفو واش البيانات تبدلات ولا لا (بلا ما نحتاجو مكتبة خارجية)
  function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash |= 0;
    }
    return String(hash);
  }

  /**
   * كيرسل نسخة احتياطية لجيميل.
   * @param {string} dataString - النص/JSON اللي بغيتي تحفظ
   * @param {object} [options]
   * @param {boolean} [options.force] - صيفط حتى لو البيانات ماتبدلاتش
   * @param {function} [options.onSuccess] - كولباك ملي ينجح الإرسال (مثلا باش تبان رسالة "تم الحفظ ✅")
   * @param {function} [options.onError] - كولباك ملي يفشل الإرسال
   * @param {function} [options.onSkipped] - كولباك ملي يتصيفط بلا تغيير (skipped)
   */
  function send(dataString, options) {
    options = options || {};
    ensureInit();
    if (!initialized) {
      if (options.onError) options.onError(new Error("EmailJS not initialized"));
      return Promise.reject(new Error("EmailJS not initialized"));
    }

    const currentHash = simpleHash(dataString || "");
    const lastHash = localStorage.getItem(LAST_HASH_KEY);

    if (!options.force && currentHash === lastHash) {
      // البيانات ماتبدلاتش من آخر حفظ — ماخصناش نصيفطو ونهرسو من الحد الشهري (200/شهر)
      if (options.onSkipped) options.onSkipped();
      return Promise.resolve({ skipped: true });
    }

    const now = new Date().toLocaleString("ar-MA");

    return emailjs
      .send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, {
        name: "تتبع الطلبة",
        time: now,
        message: dataString,
      })
      .then(function (response) {
        localStorage.setItem(LAST_HASH_KEY, currentHash);
        localStorage.setItem(LAST_TIME_KEY, now);
        if (options.onSuccess) options.onSuccess(response, now);
        return response;
      })
      .catch(function (error) {
        console.error("[gmail-backup] فشل الإرسال:", error);
        if (options.onError) options.onError(error);
        throw error;
      });
  }

  function getLastBackupTime() {
    return localStorage.getItem(LAST_TIME_KEY) || null;
  }

  // كنعرضو الدوال للاستعمال من index.html
  window.GmailBackup = {
    send: send,
    getLastBackupTime: getLastBackupTime,
  };
})();
