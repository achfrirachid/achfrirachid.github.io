// نسخة مستقلة لبيانات الطلبة — Cloudflare Workers KV
// لا يحتوي هذا الملف على أي مفاتيح سرية. يعتمد على فحص PROXY_KEY الموجود في worker.js.

const MAX_BACKUP_BYTES = 900_000;
const BACKUP_KEY = "students/latest";

function backupJson(data, status, origin, corsHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(origin) },
  });
}

function cleanBackup(input) {
  if (!input || typeof input !== "object") throw new Error("invalid_payload");
  if (!Array.isArray(input.students)) throw new Error("students_array_required");

  return {
    __app: "تتبع_الطلبة",
    version: 1,
    savedAt: new Date().toISOString(),
    deviceId: String(input.deviceId || "").slice(0, 120),
    students: input.students,
  };
}

export async function handleStudentBackup(request, env, origin, corsHeaders) {
  const store = env.STUDENT_BACKUP_KV;
  if (!store) return backupJson({ error: "missing_student_backup_kv_binding" }, 500, origin, corsHeaders);

  if (request.method === "GET") {
    const saved = await store.get(BACKUP_KEY, "json");
    if (!saved) return backupJson({ ok: true, backup: null }, 200, origin, corsHeaders);
    return backupJson({ ok: true, backup: saved }, 200, origin, corsHeaders);
  }

  if (request.method === "POST") {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BACKUP_BYTES) {
      return backupJson({ error: "backup_too_large", maxBytes: MAX_BACKUP_BYTES }, 413, origin, corsHeaders);
    }

    let payload;
    try { payload = cleanBackup(JSON.parse(raw)); }
    catch (error) { return backupJson({ error: error.message || "invalid_payload" }, 400, origin, corsHeaders); }

    await store.put(BACKUP_KEY, JSON.stringify(payload));
    return backupJson({ ok: true, savedAt: payload.savedAt, count: payload.students.length }, 200, origin, corsHeaders);
  }

  if (request.method === "DELETE") {
    await store.delete(BACKUP_KEY);
    return backupJson({ ok: true }, 200, origin, corsHeaders);
  }

  return backupJson({ error: "method_not_allowed" }, 405, origin, corsHeaders);
}
