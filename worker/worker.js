// Cloudflare Worker — Water Tank status receiver + display page
// Requires a KV namespace binding named TANK_KV (see wrangler.toml)
//
// POST /update   <- ESP32-C3 sends { level_percent, distance_cm, motor_on }
// GET  /         -> simple status page (raw values, online check, motor state)
// GET  /data     -> raw JSON of latest state (handy for debugging / other clients)

const ONLINE_TIMEOUT_MS = 30000; // consider device offline if no update in 30s

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/update") {
      return handleUpdate(request, env);
    }

    if (request.method === "GET" && url.pathname === "/data") {
      return handleData(env);
    }

    if (request.method === "GET" && url.pathname === "/") {
      return handleStatusPage(env);
    }

    return new Response("Not found", { status: 404 });
  },
};

async function handleUpdate(request, env) {
  const key = request.headers.get("X-API-KEY");
  if (!key || key !== env.API_KEY) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const body = await request.json();

    const record = {
      level_percent: body.level_percent,
      distance_cm: body.distance_cm,
      motor_on: !!body.motor_on,
      updated_at: Date.now(),
    };

    await env.TANK_KV.put("latest", JSON.stringify(record));

    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
}

async function getLatest(env) {
  const raw = await env.TANK_KV.get("latest");
  if (!raw) return null;
  return JSON.parse(raw);
}

async function handleData(env) {
  const record = await getLatest(env);
  if (!record) {
    return new Response(JSON.stringify({ online: false }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const online = Date.now() - record.updated_at < ONLINE_TIMEOUT_MS;
  return new Response(JSON.stringify({ ...record, online }), {
    headers: { "Content-Type": "application/json" },
  });
}

async function handleStatusPage(env) {
  const record = await getLatest(env);
  const online = record ? Date.now() - record.updated_at < ONLINE_TIMEOUT_MS : false;

  const level = record ? record.level_percent : "--";
  const distance = record ? record.distance_cm : "--";
  const motor = record ? (record.motor_on ? "ON" : "OFF") : "--";
  const lastUpdated = record ? new Date(record.updated_at).toISOString() : "never";

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Water Tank Status</title>
<style>
  body { font-family: sans-serif; background:#111; color:#eee; padding:2rem; }
  .card { max-width: 360px; margin: auto; background:#1c1c1c; border-radius: 12px; padding: 1.5rem; }
  .row { display:flex; justify-content:space-between; margin: 0.6rem 0; font-size: 1.1rem; }
  .label { color:#999; }
  .online { color:#4caf50; }
  .offline { color:#f44336; }
  h1 { font-size:1.2rem; text-align:center; }
</style>
</head>
<body>
  <div class="card">
    <h1>Water Tank Status</h1>
    <div class="row"><span class="label">Device</span><span class="${online ? "online" : "offline"}">${online ? "ONLINE" : "OFFLINE"}</span></div>
    <div class="row"><span class="label">Water Level</span><span>${level}%</span></div>
    <div class="row"><span class="label">Raw Distance</span><span>${distance} cm</span></div>
    <div class="row"><span class="label">Motor</span><span>${motor}</span></div>
    <div class="row"><span class="label">Last Updated</span><span>${lastUpdated}</span></div>
  </div>
</body>
</html>`;

  return new Response(html, { headers: { "Content-Type": "text/html" } });
}
