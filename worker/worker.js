// Cloudflare Worker — Water Tank Monitor API
// Requires a Durable Object binding named TANK_STATE (see wrangler.toml)
// Requires a secret named API_KEY (npx wrangler secret put API_KEY)
//
// State (latest reading, settings, history, motor events) lives in a single
// Durable Object instance rather than KV. KV is only *eventually* consistent
// (writes can take up to ~60s to show up globally), which made the dashboard
// look stale right after the device reported. A Durable Object gives instant,
// strongly-consistent reads instead, at no cost for a project this size.
//
// Device endpoints (called by the ESP32-C3, auth: X-API-KEY header):
//   POST /api/update        periodic telemetry: level, distance, motor, rssi, runtime
//   POST /api/motor-event   fired once on every relay ON/OFF transition
//   GET  /api/settings      device pulls calibration/thresholds at boot + each cycle
//   POST /api/settings      device clears reboot_requested after acting on it
//
// App / dashboard endpoints (auth: X-API-KEY header):
//   GET  /api/dashboard     everything the Dashboard page needs, precomputed
//   GET  /api/history       everything the History page needs (?range=24h|7d|30d)
//   POST /api/settings      app edits calibration/thresholds/toggles/reboot
//
// Legacy (kept for compatibility with the original simple version):
//   GET  /                  plain-text status page
//   GET  /data               raw JSON of latest state

const ONLINE_TIMEOUT_MS = 30000;       // no update in 30s -> device considered offline
const HISTORY_SAMPLE_MS = 5 * 60 * 1000; // keep one history point every 5 min
const HISTORY_MAX_POINTS = 8640;         // ~30 days at 5-min resolution
const MOTOR_EVENTS_MAX = 300;

const DEFAULT_SETTINGS = {
  device_name: "Water Tank Monitor",
  tank_height_cm: 100,        // distance sensor-to-bottom (empty)
  full_distance_cm: 10,       // distance sensor-to-water when full
  capacity_liters: 2000,
  low_threshold_percent: 20,
  full_threshold_percent: 95,
  auto_mode_enabled: true,
  report_interval_s: 10,
  low_level_push_alert: true,
  buzzer_enabled: true,
  device_offline_alert: true,
  max_run_duration_min: 60,   // dry-run / safety cutoff
  pump_flow_lpm: 15,          // used to estimate inflow volume from runtime
  tz_offset_min: 330,         // default Asia/Colombo (UTC+5:30)
  firmware_version: "v1.0.0",
  reboot_requested: false,
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-API-KEY",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    try {
      if (request.method === "POST" && url.pathname === "/api/update") {
        const authErr = await requireAuth(request, env);
        return withCors(authErr || (await handleUpdate(request, env)));
      }
      if (request.method === "POST" && url.pathname === "/api/motor-event") {
        const authErr = await requireAuth(request, env);
        return withCors(authErr || (await handleMotorEvent(request, env)));
      }
      if (request.method === "GET" && url.pathname === "/api/settings") {
        const authErr = await requireAuth(request, env);
        return withCors(authErr || (await handleGetSettings(env)));
      }
      if (request.method === "POST" && url.pathname === "/api/settings") {
        const authErr = await requireAuth(request, env);
        return withCors(authErr || (await handlePostSettings(request, env)));
      }
      if (request.method === "GET" && url.pathname === "/api/dashboard") {
        const authErr = await requireAuth(request, env);
        return withCors(authErr || (await handleDashboard(env)));
      }
      if (request.method === "GET" && url.pathname === "/api/history") {
        const authErr = await requireAuth(request, env);
        return withCors(authErr || (await handleHistory(url, env)));
      }

      // Legacy plain endpoints
      if (request.method === "GET" && url.pathname === "/data") {
        return withCors(await handleData(env));
      }
      if (request.method === "GET" && url.pathname === "/") {
        return handleStatusPage(env); // no CORS needed, browser page
      }

      return withCors(json({ ok: false, error: "not found" }, 404));
    } catch (err) {
      return withCors(json({ ok: false, error: String(err) }, 500));
    }
  },
};

// ---------------- helpers ----------------

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function withCors(response) {
  const r = new Response(response.body, response);
  for (const [k, v] of Object.entries(CORS_HEADERS)) r.headers.set(k, v);
  return r;
}

// Returns a Response if unauthorized, or null if OK to proceed.
async function requireAuth(request, env) {
  const key = request.headers.get("X-API-KEY");
  if (!key || key !== env.API_KEY) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }
  return null;
}

// ---------------- Durable Object storage helpers ----------------
// There's only ever one tank, so we always talk to the same DO instance
// ("singleton"). doGet/doPut proxy plain key/value reads and writes to it.

function getStub(env) {
  const id = env.TANK_STATE.idFromName("singleton");
  return env.TANK_STATE.get(id);
}

async function doGet(env, key) {
  const stub = getStub(env);
  const res = await stub.fetch(`https://do/state?key=${key}`);
  return res.json();
}

async function doPut(env, key, value) {
  const stub = getStub(env);
  await stub.fetch(`https://do/state?key=${key}`, {
    method: "PUT",
    body: JSON.stringify(value),
  });
}

async function getSettings(env) {
  const raw = await doGet(env, "settings");
  return raw ? { ...DEFAULT_SETTINGS, ...raw } : { ...DEFAULT_SETTINGS };
}

async function getLatest(env) {
  return doGet(env, "latest"); // null if never reported
}

async function getHistory(env) {
  return (await doGet(env, "history")) || [];
}

async function getMotorEvents(env) {
  return (await doGet(env, "motor_events")) || [];
}

// Durable Object class — a thin, generic key/value store scoped to this one
// tank. Cloudflare routes every request for the same idFromName to the same
// instance, so reads always see the latest write immediately (no propagation
// delay like KV).
export class TankState {
  constructor(ctx) {
    this.ctx = ctx;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const key = url.searchParams.get("key");
    if (!key) return new Response("missing key", { status: 400 });

    if (request.method === "GET") {
      const value = (await this.ctx.storage.get(key)) ?? null;
      return new Response(JSON.stringify(value));
    }
    if (request.method === "PUT") {
      const value = await request.json();
      await this.ctx.storage.put(key, value);
      return new Response("ok");
    }
    return new Response("method not allowed", { status: 405 });
  }
}

function isOnline(record) {
  return !!record && Date.now() - record.updated_at < ONLINE_TIMEOUT_MS;
}

function startOfLocalDay(tsMs, tzOffsetMin) {
  const shifted = new Date(tsMs + tzOffsetMin * 60000);
  shifted.setUTCHours(0, 0, 0, 0);
  return shifted.getTime() - tzOffsetMin * 60000;
}

// ---------------- device: telemetry ----------------

async function handleUpdate(request, env) {
  const body = await request.json();
  const prev = await getLatest(env);

  const now = Date.now();
  let rate_percent_per_min = 0;
  if (prev && body.motor_on && prev.motor_on) {
    const dtMin = (now - prev.updated_at) / 60000;
    if (dtMin > 0) rate_percent_per_min = (body.level_percent - prev.level_percent) / dtMin;
  }

  const record = {
    level_percent: body.level_percent,
    distance_cm: body.distance_cm,
    motor_on: !!body.motor_on,
    rssi: body.rssi ?? null,
    run_time_today_min: body.run_time_today_min ?? 0,
    uptime_s: body.uptime_s ?? null,
    rate_percent_per_min,
    updated_at: now,
  };

  await doPut(env, "latest", record);

  // Append a coarse history point every HISTORY_SAMPLE_MS
  const history = await getHistory(env);
  const last = history[history.length - 1];
  if (!last || now - last.t >= HISTORY_SAMPLE_MS) {
    history.push({
      t: now,
      level: record.level_percent,
      distance: record.distance_cm,
      motor: record.motor_on,
    });
    while (history.length > HISTORY_MAX_POINTS) history.shift();
    await doPut(env, "history", history);
  }

  return json({ ok: true });
}

async function handleMotorEvent(request, env) {
  const body = await request.json(); // { action: "on"|"off", trigger, duration_min? }
  const events = await getMotorEvents(env);

  events.push({
    t: Date.now(),
    action: body.action,
    trigger: body.trigger || "unknown",
    duration_min: body.duration_min ?? null,
  });
  while (events.length > MOTOR_EVENTS_MAX) events.shift();

  await doPut(env, "motor_events", events);
  return json({ ok: true });
}

// ---------------- settings ----------------

async function handleGetSettings(env) {
  const settings = await getSettings(env);
  return json(settings);
}

async function handlePostSettings(request, env) {
  const body = await request.json();
  const current = await getSettings(env);
  const updated = { ...current, ...body };
  await doPut(env, "settings", updated);
  return json({ ok: true, settings: updated });
}

// ---------------- dashboard ----------------

async function handleDashboard(env) {
  const [settings, latest] = await Promise.all([getSettings(env), getLatest(env)]);
  const online = isOnline(latest);

  const level = latest?.level_percent ?? null;
  const volume_liters = level != null ? Math.round((level / 100) * settings.capacity_liters) : null;
  const remaining_liters = volume_liters != null ? settings.capacity_liters - volume_liters : null;

  let est_full_in_min = null;
  if (latest?.motor_on && latest.rate_percent_per_min > 0 && level != null) {
    est_full_in_min = Math.round((settings.full_threshold_percent - level) / latest.rate_percent_per_min);
    if (est_full_in_min < 0) est_full_in_min = 0;
  }

  return json({
    device: {
      name: settings.device_name,
      online,
      last_sync: latest ? new Date(latest.updated_at).toISOString() : null,
      rssi: latest?.rssi ?? null,
      firmware_version: settings.firmware_version,
    },
    tank: {
      level_percent: level,
      volume_liters,
      capacity_liters: settings.capacity_liters,
      remaining_liters,
      distance_cm: latest?.distance_cm ?? null,
      tank_height_cm: settings.tank_height_cm,
      full_distance_cm: settings.full_distance_cm,
    },
    estimate: { est_full_in_min },
    motor: {
      running: latest?.motor_on ?? false,
      mode: settings.auto_mode_enabled ? "auto" : "manual",
      run_time_today_min: latest?.run_time_today_min ?? 0,
      low_threshold_percent: settings.low_threshold_percent,
      full_threshold_percent: settings.full_threshold_percent,
    },
    safety: {
      dry_run_protection_active: settings.max_run_duration_min > 0,
      overflow_safeguard_armed: settings.auto_mode_enabled,
      low_level_alert_percent: settings.low_threshold_percent,
      low_level_alert_enabled: settings.low_level_push_alert,
    },
  });
}

// ---------------- history ----------------

async function handleHistory(url, env) {
  const range = url.searchParams.get("range") || "24h";
  const rangeMs = { "24h": 86400000, "7d": 7 * 86400000, "30d": 30 * 86400000 }[range] || 86400000;

  const [settings, history, events] = await Promise.all([
    getSettings(env), getHistory(env), getMotorEvents(env),
  ]);

  const since = Date.now() - rangeMs;
  const series = history.filter((p) => p.t >= since);
  const filteredEvents = events.filter((e) => e.t >= since);

  const levels = series.map((p) => p.level).filter((v) => v != null);
  const summary = levels.length
    ? {
      avg: Math.round(levels.reduce((a, b) => a + b, 0) / levels.length),
      min: Math.min(...levels),
      max: Math.max(...levels),
    }
    : { avg: null, min: null, max: null };

  // Daily inflow (from motor "off" events' duration x pump flow rate) and
  // a rough "consumed" estimate = inflow - net level change that day, in liters.
  // NOTE: without a flow sensor on the outlet this is an approximation, not a
  // direct measurement.
  const dayBuckets = {};
  for (const e of filteredEvents) {
    if (e.action === "off" && e.duration_min) {
      const dayKey = startOfLocalDay(e.t, settings.tz_offset_min);
      const liters = e.duration_min * settings.pump_flow_lpm;
      dayBuckets[dayKey] = dayBuckets[dayKey] || { inflow: 0 };
      dayBuckets[dayKey].inflow += liters;
    }
  }
  const byDay = {};
  for (const p of series) {
    const dayKey = startOfLocalDay(p.t, settings.tz_offset_min);
    if (!byDay[dayKey]) byDay[dayKey] = { first: p, last: p };
    byDay[dayKey].last = p;
  }
  const daily_usage = Object.keys({ ...dayBuckets, ...byDay })
    .sort((a, b) => a - b)
    .map((dayKey) => {
      const inflow = Math.round(dayBuckets[dayKey]?.inflow || 0);
      const dayData = byDay[dayKey];
      let consumed = null;
      if (dayData) {
        const deltaPercent = dayData.last.level - dayData.first.level;
        const deltaLiters = (deltaPercent / 100) * settings.capacity_liters;
        consumed = Math.max(0, Math.round(inflow - deltaLiters));
      }
      return {
        date: new Date(Number(dayKey)).toISOString().slice(0, 10),
        inflow_liters: inflow,
        consumed_liters: consumed,
      };
    });

  return json({
    range,
    series: series.map((p) => ({ t: p.t, level: p.level })),
    summary,
    motor_events: filteredEvents,
    daily_usage,
  });
}

// ---------------- legacy plain endpoints ----------------

async function handleData(env) {
  const record = await getLatest(env);
  if (!record) return json({ online: false });
  return json({ ...record, online: isOnline(record) });
}

async function handleStatusPage(env) {
  const record = await getLatest(env);
  const online = isOnline(record);

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
    <p style="text-align:center; margin-top:1rem;"><a href="/api/dashboard" style="color:#4dabf7;">View full API →</a></p>
  </div>
</body>
</html>`;

  return new Response(html, { headers: { "Content-Type": "text/html" } });
}