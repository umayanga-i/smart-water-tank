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
  motor_command: "none",      // "none" | "on" | "off" — one-shot manual override; ESP clears after acting
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
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
<title>Water Tank Monitor — HydroFlow</title>
<meta name="description" content="Smart water tank monitoring dashboard with real-time level tracking, motor control, and usage analytics.">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --primary:#006194;--primary-container:#007bb9;--on-primary:#fff;--on-primary-container:#fdfcff;
  --secondary:#006591;--secondary-container:#39b8fd;--on-secondary:#fff;
  --tertiary:#006947;--tertiary-container:#00855b;--on-tertiary:#fff;--tertiary-fixed:#6ffbbe;--on-tertiary-fixed:#002113;
  --error:#ba1a1a;--error-container:#ffdad6;--on-error-container:#93000a;
  --surface:#f8f9ff;--surface-container-lowest:#fff;--surface-container-low:#eff4ff;
  --surface-container:#e5eeff;--surface-container-high:#dce9ff;--surface-container-highest:#d3e4fe;
  --on-surface:#0b1c30;--on-surface-variant:#3f4850;--outline:#707881;--outline-variant:#bfc7d2;
  --inverse-surface:#213145;--inverse-on-surface:#eaf1ff;--primary-fixed:#cce5ff;--primary-fixed-dim:#93ccff;
  --secondary-fixed:#c9e6ff;--tertiary-fixed-dim:#4edea3;
  --shadow-sm:0 1px 3px 0 rgba(15,23,42,0.04),0 1px 2px -1px rgba(15,23,42,0.03);
  --shadow-md:0 4px 6px -1px rgba(15,23,42,0.05),0 2px 4px -2px rgba(15,23,42,0.03);
}
html{-webkit-text-size-adjust:100%}
body{font-family:'Inter',system-ui,sans-serif;background:var(--surface);color:var(--on-surface);
  overscroll-behavior:none;-webkit-tap-highlight-color:transparent;min-height:100dvh;line-height:1.5;font-size:14px}
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--outline-variant);border-radius:99px}
.material-symbols-outlined{font-variation-settings:'FILL' 0,'wght' 400;vertical-align:middle}

/* Layout */
.app{display:flex;min-height:100dvh}
.sidebar{display:none}
.main-area{flex:1;min-width:0;padding-bottom:5rem}
.top-bar{position:sticky;top:0;z-index:40;background:rgba(255,255,255,0.88);backdrop-filter:blur(16px);
  border-bottom:1px solid rgba(191,199,210,0.4);padding:0 1rem;height:3.5rem;display:flex;align-items:center;justify-content:space-between}
.page{display:none;padding:1rem;max-width:1440px;margin:0 auto}
.page.active{display:block}
.bottom-nav{position:fixed;bottom:0;left:0;right:0;z-index:50;background:rgba(255,255,255,0.88);
  backdrop-filter:blur(16px);border-top:1px solid rgba(191,199,210,0.4);display:flex;height:4rem;
  padding-bottom:env(safe-area-inset-bottom,0)}
.bottom-nav a{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;
  text-decoration:none;color:var(--on-surface-variant);font-size:11px;font-weight:600;letter-spacing:0.06em;
  transition:color 0.15s}
.bottom-nav a.active{color:var(--primary)}
.bottom-nav a .material-symbols-outlined{font-size:22px}

/* Cards */
.card{background:var(--surface-container-lowest);border-radius:1rem;padding:1.25rem;
  box-shadow:var(--shadow-sm);border:1px solid rgba(191,199,210,0.25)}
.card-sm{border-radius:0.75rem;padding:1rem}

/* Typography */
.display-lg{font-size:44px;font-weight:700;line-height:52px;letter-spacing:-0.03em}
.display-metric{font-size:36px;font-weight:600;line-height:40px;letter-spacing:-0.02em}
.headline-lg{font-size:28px;font-weight:600;line-height:36px;letter-spacing:-0.02em}
.headline-sm{font-size:20px;font-weight:600;line-height:28px;letter-spacing:-0.01em}
.body-lg{font-size:16px;font-weight:400;line-height:24px}
.body-md{font-size:14px;font-weight:400;line-height:20px}
.body-sm{font-size:12px;font-weight:400;line-height:16px}
.label-md{font-size:13px;font-weight:500;line-height:18px;letter-spacing:0.01em}
.label-caps{font-size:11px;font-weight:600;line-height:14px;letter-spacing:0.06em;text-transform:uppercase}
.font-mono{font-family:'SF Mono','Fira Code',monospace}
.text-primary{color:var(--primary)}.text-tertiary{color:var(--tertiary)}.text-error{color:var(--error)}
.text-muted{color:var(--on-surface-variant)}.text-outline{color:var(--outline)}

/* Badges */
.badge{display:inline-flex;align-items:center;gap:4px;padding:2px 10px;border-radius:9999px;font-size:11px;font-weight:600;letter-spacing:0.06em}
.badge-online{background:#ecfdf5;color:#059669;border:1px solid rgba(16,185,129,0.2)}
.badge-offline{background:#fef2f2;color:#dc2626;border:1px solid rgba(239,68,68,0.2)}
.badge-primary{background:var(--primary-fixed);color:var(--primary)}
.badge-tertiary{background:var(--tertiary-fixed);color:var(--on-tertiary-fixed)}

/* Toggle */
.toggle{position:relative;width:52px;height:30px;border-radius:9999px;border:none;cursor:pointer;
  padding:3px;transition:background 0.2s;display:flex;align-items:center}
.toggle.on{background:var(--primary)}.toggle.off{background:var(--outline-variant)}
.toggle .knob{width:24px;height:24px;border-radius:50%;background:var(--surface-container-lowest);
  box-shadow:0 2px 4px rgba(0,0,0,0.15);transition:transform 0.2s;display:flex;align-items:center;justify-content:center}
.toggle.on .knob{transform:translateX(22px)}.toggle.off .knob{transform:translateX(0)}
.toggle .knob .material-symbols-outlined{font-size:14px;color:var(--primary);opacity:0;transition:opacity 0.15s}
.toggle.on .knob .material-symbols-outlined{opacity:1}

/* Button */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:10px 20px;
  border-radius:0.5rem;font-size:13px;font-weight:600;border:none;cursor:pointer;transition:all 0.15s;
  letter-spacing:0.01em}
.btn:active{transform:scale(0.98)}
.btn-primary{background:var(--primary);color:var(--on-primary)}.btn-primary:hover{background:var(--primary-container)}
.btn-secondary{background:var(--surface-container);color:var(--primary);border:1px solid var(--outline-variant)}
.btn-secondary:hover{background:var(--primary-fixed)}
.btn-error{background:var(--error-container);color:var(--on-error-container)}

/* Segment control */
.segment{display:flex;padding:4px;background:var(--surface-container-low);border-radius:0.75rem;gap:4px}
.segment button{flex:1;padding:8px 12px;border:none;border-radius:0.5rem;font-size:13px;font-weight:500;
  cursor:pointer;background:transparent;color:var(--on-surface-variant);transition:all 0.15s;display:flex;
  align-items:center;justify-content:center;gap:6px}
.segment button.active{background:var(--surface-container-lowest);color:var(--primary);font-weight:600;
  box-shadow:var(--shadow-sm)}

/* Stat tile */
.stat-tile{background:var(--surface-container-low);padding:0.75rem;border-radius:0.75rem}
.stat-tile .stat-label{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--on-surface-variant)}
.stat-tile .stat-value{font-size:16px;font-weight:700;color:var(--on-surface);margin-top:4px}
.stat-tile .stat-sub{font-size:10px;color:var(--on-surface-variant);margin-top:2px}

/* Toggle row */
.toggle-row{display:flex;align-items:center;justify-content:space-between;padding:0.75rem 0}
.toggle-row+.toggle-row{border-top:1px solid var(--surface-container)}

/* Settings row */
.settings-row{display:flex;align-items:center;justify-content:space-between;padding:1rem;
  transition:background 0.1s;cursor:pointer;border-bottom:1px solid var(--surface-container)}
.settings-row:last-child{border-bottom:none}
.settings-row:active{background:var(--surface-container-low)}

/* Waves */
@keyframes waveMotion{0%{transform:translateX(0)}50%{transform:translateX(-25%)}100%{transform:translateX(0)}}
.wave-animated{animation:waveMotion 6s ease-in-out infinite}
@keyframes pulse-dot{0%,100%{opacity:1}50%{opacity:0.4}}
.pulse-dot{animation:pulse-dot 2s ease-in-out infinite}

/* Modal overlay */
.modal-overlay{position:fixed;inset:0;background:rgba(11,28,48,0.5);backdrop-filter:blur(4px);
  z-index:100;display:flex;align-items:center;justify-content:center;padding:1rem}
.modal{background:var(--surface-container-lowest);border-radius:1.5rem;padding:2rem;max-width:400px;
  width:100%;box-shadow:0 20px 25px -5px rgba(15,23,42,0.1)}
.modal input[type=text],.modal input[type=password]{width:100%;height:44px;border:1px solid var(--outline-variant);
  border-radius:0.5rem;padding:0 12px;font-size:14px;font-family:inherit;outline:none;background:var(--surface-container-lowest);
  transition:border-color 0.15s}
.modal input:focus{border-color:var(--primary);box-shadow:0 0 0 3px rgba(0,97,148,0.1)}

/* Toast */
.toast{position:fixed;bottom:5rem;left:50%;transform:translateX(-50%) translateY(20px);
  background:var(--inverse-surface);color:var(--inverse-on-surface);padding:0.75rem 1.25rem;
  border-radius:0.75rem;font-size:13px;font-weight:500;display:flex;align-items:center;gap:8px;
  opacity:0;transition:all 0.3s;pointer-events:none;z-index:60;white-space:nowrap;
  box-shadow:0 20px 25px -5px rgba(15,23,42,0.15)}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}

/* Timeline */
.timeline-dot{width:12px;height:12px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.timeline-dot span{width:6px;height:6px;border-radius:50%;background:#fff}
.timeline-line{width:2px;height:48px;background:var(--surface-container);margin:4px auto}

/* Skeleton loading */
.skeleton{background:linear-gradient(90deg,var(--surface-container-low) 25%,var(--surface-container) 50%,var(--surface-container-low) 75%);
  background-size:200% 100%;animation:shimmer 1.5s infinite;border-radius:0.5rem}
@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}

/* Responsive desktop */
@media(min-width:1024px){
  .sidebar{display:flex;flex-direction:column;justify-content:space-between;width:280px;
    background:var(--surface-container-lowest);border-right:1px solid rgba(191,199,210,0.3);
    position:fixed;top:0;left:0;height:100%;z-index:50;padding:1.5rem 0;box-shadow:var(--shadow-sm)}
  .main-area{margin-left:280px;padding-bottom:0}
  .bottom-nav{display:none}
  .page{padding:1.5rem 2rem}
  .top-bar{margin-left:0}
  .grid-desktop-12{display:grid;grid-template-columns:repeat(12,1fr);gap:1.5rem}
  .col-8{grid-column:span 8}.col-4{grid-column:span 4}
  .grid-desktop-2{display:grid;grid-template-columns:1fr 1fr;gap:1.5rem}
}
</style>
</head>
<body>

<!-- API Key Modal -->
<div class="modal-overlay" id="apiKeyModal" style="display:none">
<div class="modal">
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:1.25rem">
    <div style="width:44px;height:44px;border-radius:0.75rem;background:var(--primary);display:flex;align-items:center;justify-content:center">
      <span class="material-symbols-outlined" style="color:#fff;font-size:24px">water_drop</span>
    </div>
    <div>
      <div class="headline-sm" style="color:var(--on-surface)">HydroFlow Connect</div>
      <div class="body-sm text-muted">Enter your API key to connect</div>
    </div>
  </div>
  <div style="margin-bottom:1rem">
    <label class="label-caps text-muted" style="display:block;margin-bottom:6px">API Key</label>
    <input type="password" id="apiKeyInput" placeholder="Enter your X-API-KEY" autocomplete="off">
  </div>
  <button class="btn btn-primary" style="width:100%;height:48px;font-size:14px;border-radius:0.75rem" onclick="saveApiKey()">
    <span class="material-symbols-outlined" style="font-size:18px">lock_open</span>Connect to Node
  </button>
  <p class="body-sm text-muted" style="text-align:center;margin-top:0.75rem">Key is stored locally in your browser</p>
</div>
</div>

<!-- Toast Notification -->
<div class="toast" id="toast"><span class="material-symbols-outlined" style="font-size:18px;color:var(--tertiary-fixed-dim)">check_circle</span><span id="toastText"></span></div>

<div class="app">
<!-- Desktop Sidebar -->
<aside class="sidebar" id="sidebar">
  <div>
    <div style="display:flex;align-items:center;gap:0.75rem;padding:0 1.5rem;margin-bottom:1.5rem">
      <div style="width:40px;height:40px;border-radius:0.75rem;background:var(--primary);display:flex;align-items:center;justify-content:center;box-shadow:0 10px 15px -3px rgba(0,97,148,0.12)">
        <span class="material-symbols-outlined" style="color:#fff;font-size:22px">water_drop</span>
      </div>
      <div>
        <div class="headline-sm" style="line-height:1.2" id="sidebarTitle">Water Tank</div>
        <div class="label-caps text-muted" id="sidebarSub">ESP32-C3 Node</div>
      </div>
    </div>
    <nav style="display:flex;flex-direction:column;gap:4px;padding:0 1rem">
      <a href="#" class="nav-link active" data-page="dashboard" onclick="navigateTo('dashboard',event)" style="display:flex;align-items:center;gap:0.75rem;padding:0.65rem 1rem;border-radius:0.5rem;text-decoration:none;font-size:13px;font-weight:500;transition:all 0.15s;color:var(--on-surface-variant)">
        <span class="material-symbols-outlined" style="font-size:20px">dashboard</span>Dashboard</a>
      <a href="#" class="nav-link" data-page="history" onclick="navigateTo('history',event)" style="display:flex;align-items:center;gap:0.75rem;padding:0.65rem 1rem;border-radius:0.5rem;text-decoration:none;font-size:13px;font-weight:500;transition:all 0.15s;color:var(--on-surface-variant)">
        <span class="material-symbols-outlined" style="font-size:20px">timeline</span>History</a>
      <a href="#" class="nav-link" data-page="settings" onclick="navigateTo('settings',event)" style="display:flex;align-items:center;gap:0.75rem;padding:0.65rem 1rem;border-radius:0.5rem;text-decoration:none;font-size:13px;font-weight:500;transition:all 0.15s;color:var(--on-surface-variant)">
        <span class="material-symbols-outlined" style="font-size:20px">settings</span>Settings</a>
    </nav>
  </div>
  <div style="padding:0 1rem">
    <div style="background:var(--surface-container-low);border-radius:0.75rem;padding:1rem;box-shadow:var(--shadow-sm)">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <div style="display:flex;align-items:center;gap:6px">
          <span style="position:relative;display:flex;width:8px;height:8px" id="sidebarSyncDot">
            <span style="position:absolute;width:100%;height:100%;border-radius:50%;background:var(--tertiary-container);opacity:0.75;animation:pulse-dot 2s infinite"></span>
            <span style="position:relative;width:8px;height:8px;border-radius:50%;background:var(--tertiary-container)"></span>
          </span>
          <span class="label-caps" style="color:var(--tertiary)" id="sidebarSyncLabel">Live Sync</span>
        </div>
        <span class="label-caps text-muted" id="sidebarRssi">--</span>
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-top:6px">
        <div style="display:flex;align-items:center;gap:4px;color:var(--on-surface-variant)">
          <span class="material-symbols-outlined" style="font-size:14px">wifi</span>
          <span class="body-sm" id="sidebarOnline">--</span>
        </div>
      </div>
    </div>
  </div>
</aside>

<!-- Main Content -->
<div class="main-area">
  <!-- Top Bar -->
  <header class="top-bar">
    <div style="display:flex;align-items:center;gap:8px">
      <span class="material-symbols-outlined text-primary" style="font-size:18px">home_pin</span>
      <span class="label-md text-muted" id="topBarLocation">Water Tank Monitor</span>
      <div class="badge badge-online" id="topBarStatus" style="font-size:10px">
        <span style="width:6px;height:6px;border-radius:50%;background:#10b981" id="topBarStatusDot"></span>
        <span id="topBarStatusText">CONNECTING</span>
      </div>
    </div>
    <div style="display:flex;align-items:center;gap:8px">
      <button onclick="refreshData()" style="width:36px;height:36px;border-radius:0.5rem;border:none;background:transparent;cursor:pointer;display:flex;align-items:center;justify-content:center;color:var(--on-surface-variant);transition:background 0.15s" title="Refresh">
        <span class="material-symbols-outlined" style="font-size:20px" id="refreshIcon">refresh</span>
      </button>
      <button onclick="showKeyModal()" style="width:36px;height:36px;border-radius:0.5rem;border:none;background:transparent;cursor:pointer;display:flex;align-items:center;justify-content:center;color:var(--on-surface-variant)" title="API Key">
        <span class="material-symbols-outlined" style="font-size:20px">key</span>
      </button>
    </div>
  </header>

  <!-- ==================== DASHBOARD PAGE ==================== -->
  <div class="page active" id="page-dashboard">
    <!-- Device Status Bar -->
    <div class="card" style="margin-bottom:1rem;padding:0.875rem 1rem;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.75rem">
      <div style="display:flex;align-items:center;gap:0.75rem">
        <div style="width:40px;height:40px;border-radius:0.75rem;background:var(--surface-container-low);display:flex;align-items:center;justify-content:center">
          <span class="material-symbols-outlined text-primary" style="font-size:20px">developer_board</span>
        </div>
        <div>
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            <span class="label-md" style="font-weight:600;color:var(--on-surface)" id="dashDeviceName">ESP32-C3 Node</span>
            <span class="badge badge-primary" style="font-size:9px;padding:1px 8px" id="dashFw">--</span>
          </div>
          <div class="body-sm text-muted" style="display:flex;align-items:center;gap:4px;margin-top:2px">
            <span class="material-symbols-outlined" style="font-size:12px;color:var(--tertiary)">sync</span>
            <span id="dashSyncTime">Connecting...</span>
          </div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:6px;background:var(--surface-container-low);border:1px solid rgba(191,199,210,0.3);padding:6px 12px;border-radius:0.75rem">
        <span class="material-symbols-outlined" style="font-size:16px;color:var(--tertiary)">signal_cellular_alt</span>
        <div style="text-align:right">
          <div class="body-sm" style="font-weight:600;color:var(--on-surface);line-height:1" id="dashRssiLabel">--</div>
          <div style="font-size:10px;color:var(--on-surface-variant);margin-top:2px" id="dashRssiVal">--</div>
        </div>
      </div>
    </div>

    <div class="grid-desktop-12" style="display:flex;flex-direction:column;gap:1rem">
      <div class="col-8" style="display:flex;flex-direction:column;gap:1rem">
        <!-- Water Level Card -->
        <div class="card" id="waterLevelCard">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:0.75rem">
            <div>
              <span class="label-caps text-muted">Current Storage</span>
              <div style="display:flex;align-items:baseline;gap:8px;margin-top:4px">
                <span class="display-lg" id="dashLevel" style="color:var(--on-surface)">--%</span>
                <span class="label-md text-muted" id="dashVolume">-- L / -- L</span>
              </div>
            </div>
            <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px">
              <span class="badge badge-tertiary" id="dashLevelBadge" style="font-size:10px">
                <span style="width:6px;height:6px;border-radius:50%;background:var(--tertiary-container)"></span>--
              </span>
              <div style="display:flex;align-items:center;gap:4px;background:var(--primary-fixed);color:var(--primary);font-size:11px;font-weight:600;padding:3px 10px;border-radius:0.375rem">
                <span class="material-symbols-outlined" style="font-size:14px">straighten</span>
                <span id="dashDistance">-- cm</span>
              </div>
            </div>
          </div>

          <!-- Tank Visualization -->
          <div style="position:relative;width:100%;height:240px;background:var(--surface-container-low);border-radius:1rem;padding:8px;border:1px solid rgba(191,199,210,0.3);display:flex;gap:8px;overflow:hidden;box-shadow:inset 0 2px 4px rgba(15,23,42,0.04)">
            <!-- Calibration marks -->
            <div style="width:88px;height:100%;display:flex;flex-direction:column;justify-content:space-between;padding:8px 0;font-size:10px;font-weight:500;color:var(--on-surface-variant);user-select:none;z-index:2;padding-left:4px">
              <div style="display:flex;align-items:center;gap:4px;color:var(--on-surface);font-weight:600">
                <span class="material-symbols-outlined" style="font-size:12px;color:var(--tertiary)">arrow_right</span>
                <span id="calFull">-- cm (Full)</span>
              </div>
              <div style="display:flex;align-items:center;gap:4px;padding-left:12px;color:var(--outline)"><span style="width:8px;height:1px;background:var(--outline-variant)"></span>75%</div>
              <div style="display:flex;align-items:center;gap:4px;padding-left:12px;color:var(--outline)"><span style="width:8px;height:1px;background:var(--outline-variant)"></span>50%</div>
              <div style="display:flex;align-items:center;gap:4px;padding-left:12px;color:var(--outline)"><span style="width:8px;height:1px;background:var(--outline-variant)"></span>25%</div>
              <div style="display:flex;align-items:center;gap:4px;color:var(--on-surface);font-weight:600">
                <span class="material-symbols-outlined" style="font-size:12px;color:var(--error)">arrow_right</span>
                <span id="calEmpty">-- cm (Empty)</span>
              </div>
            </div>
            <!-- Tank body -->
            <div style="position:relative;flex:1;height:100%;background:rgba(191,199,210,0.2);border-radius:0.75rem;overflow:hidden;border:1px solid rgba(191,199,210,0.4);display:flex;flex-direction:column;justify-content:flex-end">
              <!-- Sensor beam -->
              <div style="position:absolute;top:0;left:0;right:0;height:48px;background:linear-gradient(to bottom,rgba(0,97,148,0.08),transparent);pointer-events:none"></div>
              <!-- Sensor label -->
              <div style="position:absolute;top:4px;left:50%;transform:translateX(-50%);z-index:3;display:flex;align-items:center;gap:4px;background:rgba(255,255,255,0.92);backdrop-filter:blur(8px);padding:2px 10px;border-radius:9999px;border:1px solid rgba(191,199,210,0.4);box-shadow:var(--shadow-sm)">
                <span class="material-symbols-outlined" style="font-size:12px;color:var(--tertiary)">sensors</span>
                <span style="font-size:9px;font-weight:600;color:var(--on-surface-variant);text-transform:uppercase;letter-spacing:0.05em">Ultrasonic</span>
              </div>
              <!-- Water fill -->
              <div id="tankWaterFill" style="position:relative;width:100%;border-radius:0 0 0.625rem 0.625rem;overflow:hidden;transition:height 0.7s ease;height:0%">
                <div style="position:absolute;inset:0;background:linear-gradient(to top,#006947,#007bb9,#39b8fd)"></div>
                <!-- Wave SVG -->
                <div class="wave-animated" style="position:absolute;top:0;left:0;width:200%;height:16px;transform:translateY(-8px);opacity:0.8">
                  <svg viewBox="0 0 1200 120" preserveAspectRatio="none" style="width:100%;height:100%;fill:#93ccff"><path d="M0,0 C150,90 350,-40 500,45 C650,130 900,-30 1200,30 L1200,120 L0,120 Z"/></svg>
                </div>
                <div class="wave-animated" style="position:absolute;top:0;left:0;width:180%;height:12px;transform:translateY(-5px);opacity:0.5;animation-duration:8s;animation-direction:reverse">
                  <svg viewBox="0 0 1200 120" preserveAspectRatio="none" style="width:100%;height:100%;fill:#fff"><path d="M0,20 C180,70 320,-20 600,40 C880,100 1020,-10 1200,20 L1200,120 L0,120 Z"/></svg>
                </div>
                <!-- Center label -->
                <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">
                  <div style="padding:4px 12px;border-radius:9999px;background:rgba(255,255,255,0.18);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,0.35);color:#fff;font-size:11px;font-weight:600;display:flex;align-items:center;gap:6px">
                    <span class="material-symbols-outlined" style="font-size:14px">waves</span>
                    <span id="tankWaterLabel">--</span>
                  </div>
                </div>
                <!-- Bubbles -->
                <div style="position:absolute;inset:0;display:flex;justify-content:space-around;align-items:flex-end;padding-bottom:12px;pointer-events:none;opacity:0.25">
                  <span style="width:8px;height:8px;border-radius:50%;background:#fff" class="pulse-dot"></span>
                  <span style="width:12px;height:12px;border-radius:50%;background:#fff;animation-delay:0.5s" class="pulse-dot"></span>
                  <span style="width:6px;height:6px;border-radius:50%;background:#fff;animation-delay:1s" class="pulse-dot"></span>
                  <span style="width:10px;height:10px;border-radius:50%;background:#fff;animation-delay:0.3s" class="pulse-dot"></span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Motor Control Card -->
        <div class="card" id="motorCard">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem">
            <div style="display:flex;align-items:center;gap:10px">
              <div style="width:40px;height:40px;border-radius:0.75rem;background:var(--tertiary-fixed);color:var(--on-tertiary-fixed);display:flex;align-items:center;justify-content:center">
                <span class="material-symbols-outlined" style="font-size:22px">water_pump</span>
              </div>
              <div>
                <div class="headline-sm" style="font-size:16px">Motor</div>
                <div style="display:flex;align-items:center;gap:6px;margin-top:2px" id="motorStatusContainer">
                  <span style="position:relative;display:flex;width:8px;height:8px" id="motorDot">
                    <span style="position:absolute;width:100%;height:100%;border-radius:50%;opacity:0.75" id="motorDotPing"></span>
                    <span style="position:relative;width:8px;height:8px;border-radius:50%" id="motorDotSolid"></span>
                  </span>
                  <span class="label-caps" id="motorStatusLabel" style="font-size:10px">--</span>
                </div>
              </div>
            </div>
            <button class="toggle off" id="motorToggle" onclick="toggleMotor()">
              <div class="knob"><span class="material-symbols-outlined">bolt</span></div>
            </button>
          </div>
          <!-- Mode Tabs -->
          <div class="segment" id="modeSegment">
            <button class="active" onclick="switchMode('auto',this)"><span class="material-symbols-outlined" style="font-size:15px">auto_mode</span>Auto</button>
            <button onclick="switchMode('manual',this)"><span class="material-symbols-outlined" style="font-size:15px">pan_tool</span>Manual</button>
          </div>
          <!-- Stats Grid -->
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:0.75rem">
            <div class="stat-tile"><span class="stat-label">Low Threshold</span><div class="stat-value" id="dashLowThresh">--%</div><div class="stat-sub">Auto Start</div></div>
            <div class="stat-tile"><span class="stat-label">Full Threshold</span><div class="stat-value" id="dashFullThresh" style="color:var(--tertiary)">--%</div><div class="stat-sub">Auto Stop</div></div>
            <div class="stat-tile"><span class="stat-label">Run Time Today</span><div class="stat-value" id="dashRunTime">-- min</div><div class="stat-sub" id="dashCycles">--</div></div>
            <div class="stat-tile"><span class="stat-label">Est. Full In</span><div class="stat-value" id="dashEstFull">--</div><div class="stat-sub" id="dashEstSub">When pumping</div></div>
          </div>
        </div>

        <!-- 24h Sparkline Card -->
        <div class="card" id="sparklineCard">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:0.5rem">
            <div><div class="label-md" style="font-weight:700;color:var(--on-surface)">24-Hour Water Level</div>
              <div class="body-sm text-muted">Daily usage trend</div></div>
            <span class="badge badge-primary" id="dashMinMax" style="font-size:10px;padding:4px 10px">--</span>
          </div>
          <div style="width:100%;height:140px;position:relative" id="sparklineContainer">
            <svg id="sparklineSvg" viewBox="0 0 320 120" preserveAspectRatio="none" style="width:100%;height:100%;overflow:visible">
              <defs><linearGradient id="areaGrad" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stop-color="#006194" stop-opacity="0.3"/><stop offset="100%" stop-color="#006194" stop-opacity="0"/></linearGradient></defs>
              <line x1="0" y1="20" x2="320" y2="20" stroke="var(--surface-container)" stroke-dasharray="3,3"/>
              <line x1="0" y1="60" x2="320" y2="60" stroke="var(--surface-container)" stroke-dasharray="3,3"/>
              <line x1="0" y1="100" x2="320" y2="100" stroke="var(--surface-container)"/>
              <path id="sparklineArea" d="" fill="url(#areaGrad)"/>
              <path id="sparklineLine" d="" fill="none" stroke="var(--primary)" stroke-width="2.5" stroke-linecap="round"/>
              <circle id="sparklineDot" cx="0" cy="0" r="4" fill="var(--tertiary)" stroke="#fff" stroke-width="2" style="display:none"/>
            </svg>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--on-surface-variant);font-weight:500;padding:4px 2px 0" id="sparklineXAxis">
            <span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span style="font-weight:700;color:var(--on-surface)">Now</span>
          </div>
        </div>
      </div>

      <!-- Right Column (desktop) -->
      <div class="col-4" style="display:flex;flex-direction:column;gap:1rem">
        <!-- Alerts Card -->
        <div class="card" id="alertsCard">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.75rem">
            <div class="label-md" style="font-weight:700">Alerts & Thresholds</div>
            <span class="badge badge-tertiary" style="font-size:9px" id="dashGuardBadge">--</span>
          </div>
          <div id="alertToggles">
            <div class="toggle-row">
              <div style="display:flex;align-items:center;gap:10px">
                <div style="width:32px;height:32px;border-radius:0.5rem;background:#fffbeb;color:#f59e0b;display:flex;align-items:center;justify-content:center"><span class="material-symbols-outlined" style="font-size:18px">warning</span></div>
                <div><div class="body-sm" style="font-weight:600;color:var(--on-surface)">Low Level Alert</div><div style="font-size:11px;color:var(--on-surface-variant)" id="alertLowDesc">Below --%</div></div>
              </div>
              <button class="toggle on" id="toggleLowAlert" onclick="toggleAlert('low_level_push_alert',this)"><div class="knob"><span class="material-symbols-outlined">done</span></div></button>
            </div>
            <div class="toggle-row">
              <div style="display:flex;align-items:center;gap:10px">
                <div style="width:32px;height:32px;border-radius:0.5rem;background:var(--primary-fixed);color:var(--primary);display:flex;align-items:center;justify-content:center"><span class="material-symbols-outlined" style="font-size:18px">power_settings_new</span></div>
                <div><div class="body-sm" style="font-weight:600;color:var(--on-surface)">Auto-Cutoff</div><div style="font-size:11px;color:var(--on-surface-variant)" id="alertFullDesc">At --%</div></div>
              </div>
              <button class="toggle on" id="toggleAutoCutoff" onclick="toggleAlert('auto_mode_enabled',this)"><div class="knob"><span class="material-symbols-outlined">done</span></div></button>
            </div>
            <div class="toggle-row">
              <div style="display:flex;align-items:center;gap:10px">
                <div style="width:32px;height:32px;border-radius:0.5rem;background:#eef2ff;color:#6366f1;display:flex;align-items:center;justify-content:center"><span class="material-symbols-outlined" style="font-size:18px">volume_up</span></div>
                <div><div class="body-sm" style="font-weight:600;color:var(--on-surface)">Buzzer Alerts</div><div style="font-size:11px;color:var(--on-surface-variant)">Audio on motor start/stop</div></div>
              </div>
              <button class="toggle on" id="toggleBuzzer" onclick="toggleAlert('buzzer_enabled',this)"><div class="knob"><span class="material-symbols-outlined">done</span></div></button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- ==================== HISTORY PAGE ==================== -->
  <div class="page" id="page-history">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.75rem">
      <div style="display:flex;align-items:center;gap:10px">
        <div style="width:36px;height:36px;border-radius:0.75rem;background:var(--surface-container);display:flex;align-items:center;justify-content:center">
          <span class="material-symbols-outlined text-primary" style="font-size:20px">history</span>
        </div>
        <div><div class="headline-sm" style="font-size:18px">Telemetry History</div>
          <div class="body-sm text-muted">ESP32-C3 • Ultrasonic Sensor Node</div></div>
      </div>
    </div>
    <!-- Range selector -->
    <div class="segment" style="margin-bottom:1rem" id="historyRangeSegment">
      <button class="active" onclick="switchRange('24h',this)">24H</button>
      <button onclick="switchRange('7d',this)">7D</button>
      <button onclick="switchRange('30d',this)">30D</button>
    </div>

    <!-- Main History Chart -->
    <div class="card" style="margin-bottom:1rem">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem">
        <div><span class="label-caps text-muted">Level Dynamics</span><div class="label-md" style="font-weight:700;color:var(--on-surface)">Water Level Trend</div></div>
        <div class="badge badge-tertiary" style="font-size:9px" id="histOptimalBadge"><span class="pulse-dot" style="width:6px;height:6px;border-radius:50%;background:var(--tertiary)"></span>Optimal: 40%–85%</div>
      </div>
      <div style="width:100%;height:200px;position:relative" id="histChartContainer">
        <svg id="histChartSvg" viewBox="0 0 340 180" preserveAspectRatio="none" style="width:100%;height:100%;overflow:visible">
          <defs>
            <linearGradient id="histAreaGrad" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stop-color="#39b8fd" stop-opacity="0.4"/><stop offset="65%" stop-color="#007bb9" stop-opacity="0.1"/><stop offset="100%" stop-color="#007bb9" stop-opacity="0"/></linearGradient>
          </defs>
          <rect x="25" y="27" width="315" height="81" rx="4" fill="#00855b" fill-opacity="0.04"/>
          <g fill="var(--on-surface-variant)" style="font-size:9px;font-weight:600" text-anchor="end">
            <text x="20" y="10">100%</text><line x1="25" x2="340" y1="8" y2="8" stroke="var(--outline-variant)" stroke-dasharray="2,3" stroke-opacity="0.35"/>
            <text x="20" y="52">75%</text><line x1="25" x2="340" y1="50" y2="50" stroke="var(--outline-variant)" stroke-dasharray="2,3" stroke-opacity="0.35"/>
            <text x="20" y="94">50%</text><line x1="25" x2="340" y1="92" y2="92" stroke="var(--outline-variant)" stroke-dasharray="2,3" stroke-opacity="0.35"/>
            <text x="20" y="136">25%</text><line x1="25" x2="340" y1="134" y2="134" stroke="var(--outline-variant)" stroke-dasharray="2,3" stroke-opacity="0.35"/>
            <text x="20" y="172">0%</text><line x1="25" x2="340" y1="170" y2="170" stroke="var(--outline-variant)" stroke-opacity="0.4"/>
          </g>
          <path id="histArea" d="" fill="url(#histAreaGrad)"/>
          <path id="histLine" d="" fill="none" stroke="#006194" stroke-width="2.5" stroke-linecap="round"/>
          <circle id="histDotEnd" cx="0" cy="0" r="4" fill="var(--tertiary)" style="display:none"/>
        </svg>
      </div>
      <div style="display:flex;justify-content:space-between;padding:6px 24px 0;font-size:10px;color:var(--on-surface-variant);font-weight:600" id="histXAxis"></div>
      <!-- Summary stats -->
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:1rem">
        <div style="text-align:center;padding:10px;background:var(--surface-container-low);border-radius:0.5rem">
          <div style="display:flex;align-items:center;justify-content:center;gap:4px"><span class="material-symbols-outlined text-primary" style="font-size:15px">water</span><span class="label-caps text-muted">Avg Level</span></div>
          <div class="headline-sm" style="font-size:18px;margin-top:4px" id="histAvg">--%</div>
        </div>
        <div style="text-align:center;padding:10px;background:var(--surface-container-low);border-radius:0.5rem">
          <div style="display:flex;align-items:center;justify-content:center;gap:4px"><span class="material-symbols-outlined text-error" style="font-size:15px">vertical_align_bottom</span><span class="label-caps text-muted">Min</span></div>
          <div class="headline-sm" style="font-size:18px;margin-top:4px" id="histMin">--%</div>
        </div>
        <div style="text-align:center;padding:10px;background:var(--surface-container-low);border-radius:0.5rem">
          <div style="display:flex;align-items:center;justify-content:center;gap:4px"><span class="material-symbols-outlined text-primary" style="font-size:15px">vertical_align_top</span><span class="label-caps text-muted">Max</span></div>
          <div class="headline-sm" style="font-size:18px;margin-top:4px" id="histMax">--%</div>
        </div>
      </div>
    </div>

    <!-- Motor Relay Log -->
    <div class="card" style="margin-bottom:1rem">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.75rem">
        <div style="display:flex;align-items:center;gap:8px">
          <div style="width:32px;height:32px;border-radius:0.5rem;background:var(--primary-fixed);display:flex;align-items:center;justify-content:center"><span class="material-symbols-outlined text-primary" style="font-size:18px">electric_bolt</span></div>
          <div><div class="label-md" style="font-weight:700">Motor Relay Log</div><div class="body-sm text-muted">Relay State Events</div></div>
        </div>
        <span class="badge" style="background:var(--surface-container);color:var(--on-surface-variant);font-size:9px" id="motorRelayBadge">--</span>
      </div>
      <div id="motorEventsContainer" style="display:flex;flex-direction:column;gap:4px">
        <div class="body-sm text-muted" style="text-align:center;padding:2rem 0">Loading events...</div>
      </div>
    </div>

    <!-- Daily Usage Bars -->
    <div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem">
        <div><div class="label-md" style="font-weight:700">Daily Inflow vs Usage</div><div class="body-sm text-muted">Estimated consumption (Liters)</div></div>
      </div>
      <div style="display:flex;align-items:center;gap:1rem;margin:0.5rem 0;font-size:11px;color:var(--on-surface-variant);font-weight:600">
        <div style="display:flex;align-items:center;gap:4px"><span style="width:10px;height:10px;border-radius:2px;background:var(--primary)"></span>Inflow</div>
        <div style="display:flex;align-items:center;gap:4px"><span style="width:10px;height:10px;border-radius:2px;background:var(--surface-container-highest)"></span>Consumed</div>
      </div>
      <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:6px;height:120px;padding:8px 0" id="dailyBarsContainer">
        <div class="body-sm text-muted" style="text-align:center;width:100%;padding:2rem 0">Loading...</div>
      </div>
    </div>
  </div>

  <!-- ==================== SETTINGS PAGE ==================== -->
  <div class="page" id="page-settings">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem">
      <div style="display:flex;align-items:center;gap:10px">
        <div style="width:40px;height:40px;border-radius:50%;background:var(--primary-fixed);display:flex;align-items:center;justify-content:center">
          <span class="material-symbols-outlined text-primary" style="font-size:22px">tune</span>
        </div>
        <div><div class="headline-sm" style="font-size:18px">Node Configuration</div>
          <div style="display:flex;align-items:center;gap:6px;margin-top:2px">
            <span class="pulse-dot" style="width:8px;height:8px;border-radius:50%;background:var(--tertiary-fixed-dim)"></span>
            <span class="label-caps text-muted" id="settingsNodeInfo">ESP32-C3 Node</span>
          </div>
        </div>
      </div>
      <span class="badge badge-tertiary" style="font-size:9px" id="settingsCalBadge">
        <span class="material-symbols-outlined" style="font-size:12px">sensors</span>Calibrated
      </span>
    </div>

    <div class="grid-desktop-12" style="display:flex;flex-direction:column;gap:1rem">
      <div class="col-8" style="display:flex;flex-direction:column;gap:1rem">
        <!-- Tank Calibration -->
        <div class="card">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:1rem">
            <span class="material-symbols-outlined text-primary" style="font-size:20px">straighten</span>
            <div><div class="label-md" style="font-weight:700">Tank Calibration</div><div class="body-sm text-muted">Ultrasonic acoustic offset & geometry</div></div>
          </div>
          <!-- Usable column preview -->
          <div style="background:var(--surface-container-low);border-radius:0.75rem;padding:1rem;margin-bottom:1rem;display:flex;align-items:center;justify-content:space-between;gap:1rem">
            <div style="display:flex;align-items:center;gap:1rem">
              <div style="width:48px;height:48px;border-radius:0.75rem;background:var(--surface-container);display:flex;align-items:center;justify-content:center">
                <span class="material-symbols-outlined text-primary" style="font-size:24px">water</span>
              </div>
              <div><span class="label-caps text-muted">Usable Dynamic Column</span>
                <div style="display:flex;align-items:baseline;gap:6px"><span class="display-metric" id="settUsableCol">--</span><span class="label-md text-muted">cm usable height</span></div>
                <span class="body-sm text-primary" style="font-weight:500" id="settCurrentLevel">--</span>
              </div>
            </div>
            <div style="width:120px;height:12px;background:var(--surface-container-highest);border-radius:9999px;overflow:hidden">
              <div style="height:100%;background:var(--primary-container);border-radius:9999px;transition:width 0.7s" id="settLevelBar"></div>
            </div>
          </div>
          <!-- Param rows -->
          <div class="settings-row" onclick="editSetting('tank_height_cm','Tank Height (cm)')">
            <div style="display:flex;align-items:center;gap:10px">
              <div style="width:28px;height:28px;border-radius:0.375rem;background:var(--surface-container);display:flex;align-items:center;justify-content:center"><span class="material-symbols-outlined text-muted" style="font-size:16px">arrow_downward</span></div>
              <div><span class="label-md" style="font-weight:600">Tank Height (Empty Distance)</span><div class="body-sm text-muted">Sensor to tank bottom</div></div>
            </div>
            <div style="display:flex;align-items:center;gap:6px"><span class="headline-sm" style="font-size:16px" id="settTankHeight">--</span><span class="label-caps text-muted">cm</span><span class="material-symbols-outlined text-muted" style="font-size:18px">chevron_right</span></div>
          </div>
          <div class="settings-row" onclick="editSetting('full_distance_cm','Full Water Distance (cm)')">
            <div style="display:flex;align-items:center;gap:10px">
              <div style="width:28px;height:28px;border-radius:0.375rem;background:var(--surface-container);display:flex;align-items:center;justify-content:center"><span class="material-symbols-outlined text-muted" style="font-size:16px">vertical_align_top</span></div>
              <div><span class="label-md" style="font-weight:600">Full Water Distance</span><div class="body-sm text-muted">Dead-zone margin to max surface</div></div>
            </div>
            <div style="display:flex;align-items:center;gap:6px"><span class="headline-sm" style="font-size:16px" id="settFullDist">--</span><span class="label-caps text-muted">cm</span><span class="material-symbols-outlined text-muted" style="font-size:18px">chevron_right</span></div>
          </div>
          <div class="settings-row" onclick="editSetting('capacity_liters','Tank Capacity (Liters)')">
            <div style="display:flex;align-items:center;gap:10px">
              <div style="width:28px;height:28px;border-radius:0.375rem;background:var(--surface-container);display:flex;align-items:center;justify-content:center"><span class="material-symbols-outlined text-muted" style="font-size:16px">local_drink</span></div>
              <div><span class="label-md" style="font-weight:600">Tank Capacity</span><div class="body-sm text-muted">Volume factor for consumption logs</div></div>
            </div>
            <div style="display:flex;align-items:center;gap:6px"><span class="headline-sm" style="font-size:16px" id="settCapacity">--</span><span class="label-caps text-muted">L</span><span class="material-symbols-outlined text-muted" style="font-size:18px">chevron_right</span></div>
          </div>
        </div>

        <!-- Motor & Thresholds -->
        <div class="card">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1rem">
            <div style="display:flex;align-items:center;gap:8px">
              <span class="material-symbols-outlined text-primary" style="font-size:20px">power_settings_new</span>
              <div><div class="label-md" style="font-weight:700">Motor & Thresholds</div><div class="body-sm text-muted">Automated pumping triggers & safety</div></div>
            </div>
            <span class="badge badge-tertiary" style="font-size:9px" id="settRelayBadge"><span class="pulse-dot" style="width:6px;height:6px;border-radius:50%;background:var(--tertiary)"></span>RELAY ARMED</span>
          </div>
          <!-- Auto mode toggle -->
          <div style="display:flex;align-items:center;justify-content:space-between;padding:1rem;background:rgba(204,229,255,0.25);border-radius:0.75rem;margin-bottom:1rem">
            <div style="padding-right:1rem"><div style="display:flex;align-items:center;gap:6px"><span class="label-md" style="font-weight:600">Auto Mode</span></div>
              <div class="body-sm text-muted" style="margin-top:4px">Automated relay control via threshold triggers</div></div>
            <button class="toggle on" id="settAutoToggle" onclick="toggleSetting('auto_mode_enabled',this)"><div class="knob"><span class="material-symbols-outlined">done</span></div></button>
          </div>
          <!-- Threshold rows -->
          <div class="settings-row" onclick="editSetting('low_threshold_percent','Low Level Threshold (%)')">
            <div style="display:flex;align-items:center;gap:10px">
              <div style="width:28px;height:28px;border-radius:0.375rem;background:var(--surface-container);display:flex;align-items:center;justify-content:center"><span class="material-symbols-outlined text-primary" style="font-size:16px">arrow_circle_down</span></div>
              <div><span class="label-md" style="font-weight:600">Low Level Threshold</span><div class="body-sm text-muted">Auto-start motor below this</div></div>
            </div>
            <div style="display:flex;align-items:center;gap:6px"><span class="headline-sm" style="font-size:16px" id="settLowThresh">--%</span><span class="material-symbols-outlined text-muted" style="font-size:18px">chevron_right</span></div>
          </div>
          <div class="settings-row" onclick="editSetting('full_threshold_percent','Full Level Threshold (%)')">
            <div style="display:flex;align-items:center;gap:10px">
              <div style="width:28px;height:28px;border-radius:0.375rem;background:var(--surface-container);display:flex;align-items:center;justify-content:center"><span class="material-symbols-outlined text-tertiary" style="font-size:16px">arrow_circle_up</span></div>
              <div><span class="label-md" style="font-weight:600">Full Level Threshold</span><div class="body-sm text-muted">Auto-stop cutoff at full</div></div>
            </div>
            <div style="display:flex;align-items:center;gap:6px"><span class="headline-sm" style="font-size:16px" id="settFullThresh">--%</span><span class="material-symbols-outlined text-muted" style="font-size:18px">chevron_right</span></div>
          </div>
          <div class="settings-row" onclick="editSetting('max_run_duration_min','Max Run Duration (min)')">
            <div style="display:flex;align-items:center;gap:10px">
              <div style="width:28px;height:28px;border-radius:0.375rem;background:var(--error-container);display:flex;align-items:center;justify-content:center"><span class="material-symbols-outlined text-error" style="font-size:16px">timer_off</span></div>
              <div><span class="label-md" style="font-weight:600">Max Run Duration</span><div class="body-sm text-muted">Emergency safety shutoff timer</div></div>
            </div>
            <div style="display:flex;align-items:center;gap:6px"><span class="headline-sm" style="font-size:16px" id="settMaxRun">-- min</span><span class="material-symbols-outlined text-muted" style="font-size:18px">chevron_right</span></div>
          </div>
        </div>
      </div>

      <div class="col-4" style="display:flex;flex-direction:column;gap:1rem">
        <!-- Alerts & Buzzer -->
        <div class="card">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:0.75rem">
            <span class="material-symbols-outlined" style="font-size:20px;color:var(--tertiary)">notifications_active</span>
            <div><div class="label-md" style="font-weight:700">Alerts & Buzzer</div><div class="body-sm text-muted">Push notifications and audio</div></div>
          </div>
          <div class="toggle-row">
            <div><div class="body-sm" style="font-weight:600">Low Water Push Alert</div><div style="font-size:11px;color:var(--on-surface-variant)">Notify below threshold</div></div>
            <button class="toggle on" id="settAlertLow" onclick="toggleSetting('low_level_push_alert',this)"><div class="knob"><span class="material-symbols-outlined">done</span></div></button>
          </div>
          <div class="toggle-row">
            <div><div class="body-sm" style="font-weight:600">Motor Buzzer</div><div style="font-size:11px;color:var(--on-surface-variant)">Audio chime on start/stop</div></div>
            <button class="toggle on" id="settAlertBuzzer" onclick="toggleSetting('buzzer_enabled',this)"><div class="knob"><span class="material-symbols-outlined">done</span></div></button>
          </div>
          <div class="toggle-row">
            <div><div class="body-sm" style="font-weight:600">Device Offline Alert</div><div style="font-size:11px;color:var(--on-surface-variant)">If heartbeat missed > 30s</div></div>
            <button class="toggle on" id="settAlertOffline" onclick="toggleSetting('device_offline_alert',this)"><div class="knob"><span class="material-symbols-outlined">done</span></div></button>
          </div>
        </div>

        <!-- Device & Hardware -->
        <div class="card">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.75rem">
            <div style="display:flex;align-items:center;gap:8px">
              <span class="material-symbols-outlined text-primary" style="font-size:20px">memory</span>
              <div class="label-md" style="font-weight:700">Device & Hardware</div>
            </div>
            <span class="badge badge-tertiary" style="font-size:9px" id="settFwBadge">--</span>
          </div>
          <div style="display:flex;flex-direction:column;gap:2px">
            <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--surface-container)"><span class="body-sm text-muted">Device Name</span><span class="label-md" id="settDevName">--</span></div>
            <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--surface-container)"><span class="body-sm text-muted">Firmware</span><span class="label-md" id="settFirmware">--</span></div>
            <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--surface-container)"><span class="body-sm text-muted">RSSI</span><span class="label-md" id="settRssi" style="color:var(--tertiary)">--</span></div>
            <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--surface-container)"><span class="body-sm text-muted">Report Interval</span><span class="label-md" id="settInterval">--</span></div>
            <div style="display:flex;justify-content:space-between;padding:8px 0"><span class="body-sm text-muted">Pump Flow Rate</span><span class="label-md" id="settFlowRate">--</span></div>
          </div>
        </div>

        <!-- Restart -->
        <button class="btn btn-error" style="width:100%;height:48px;border-radius:0.75rem;font-size:14px" id="restartBtn" onclick="restartDevice()">
          <span class="material-symbols-outlined" style="font-size:20px">restart_alt</span>Restart ESP32 Controller
        </button>
      </div>
    </div>
  </div>

</div><!-- main-area -->
</div><!-- app -->

<!-- Bottom Navigation (Mobile) -->
<nav class="bottom-nav" id="bottomNav">
  <a href="#" class="active" data-page="dashboard" onclick="navigateTo('dashboard',event)">
    <span class="material-symbols-outlined">dashboard</span><span>Dashboard</span></a>
  <a href="#" data-page="history" onclick="navigateTo('history',event)">
    <span class="material-symbols-outlined">history</span><span>History</span></a>
  <a href="#" data-page="settings" onclick="navigateTo('settings',event)">
    <span class="material-symbols-outlined">settings</span><span>Settings</span></a>
</nav>

<script>
// ============ STATE ============
let API_KEY = localStorage.getItem('hydroflow_api_key') || '';
let currentPage = 'dashboard';
let dashboardData = null;
let settingsData = null;
let historyData = null;
let historyRange = '24h';
let refreshTimer = null;

// ============ INIT ============
(function init() {
  if (!API_KEY) { document.getElementById('apiKeyModal').style.display = 'flex'; }
  else { startApp(); }
})();

function saveApiKey() {
  const v = document.getElementById('apiKeyInput').value.trim();
  if (!v) return;
  API_KEY = v;
  localStorage.setItem('hydroflow_api_key', v);
  document.getElementById('apiKeyModal').style.display = 'none';
  startApp();
}
function showKeyModal() { document.getElementById('apiKeyModal').style.display = 'flex'; document.getElementById('apiKeyInput').value = API_KEY; }

function startApp() {
  refreshData();
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(refreshData, 10000);
}

// ============ API ============
async function apiFetch(path, method, body) {
  const opts = { method: method || 'GET', headers: { 'X-API-KEY': API_KEY, 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  if (res.status === 401) { showToast('Unauthorized — check API key'); document.getElementById('apiKeyModal').style.display = 'flex'; throw new Error('401'); }
  return res.json();
}

async function refreshData() {
  const icon = document.getElementById('refreshIcon');
  icon.style.animation = 'spin 0.6s linear';
  setTimeout(() => icon.style.animation = '', 700);
  try {
    const [d, s] = await Promise.all([apiFetch('/api/dashboard'), apiFetch('/api/settings')]);
    dashboardData = d; settingsData = s;
    renderDashboard(); renderSettings();
    updateStatusIndicators(d.device.online);
    if (currentPage === 'history') { await loadHistory(); }
  } catch(e) { console.error(e); }
}

async function loadHistory() {
  try {
    historyData = await apiFetch('/api/history?range=' + historyRange);
    renderHistory();
  } catch(e) { console.error(e); }
}

// ============ NAVIGATION ============
function navigateTo(page, e) {
  if (e) e.preventDefault();
  currentPage = page;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + page).classList.add('active');
  // Update nav highlights
  document.querySelectorAll('.nav-link').forEach(a => {
    a.style.background = '';a.style.color = 'var(--on-surface-variant)';a.style.fontWeight = '500';a.style.boxShadow = '';
  });
  const activeNav = document.querySelector('.nav-link[data-page="'+page+'"]');
  if (activeNav) { activeNav.style.background = 'var(--primary-container)'; activeNav.style.color = 'var(--on-primary-container)'; activeNav.style.fontWeight = '600'; activeNav.style.boxShadow = 'var(--shadow-sm)'; }
  document.querySelectorAll('.bottom-nav a').forEach(a => a.classList.remove('active'));
  const activeBn = document.querySelector('.bottom-nav a[data-page="'+page+'"]');
  if (activeBn) activeBn.classList.add('active');
  if (page === 'history' && !historyData) loadHistory();
  if (page === 'settings' && settingsData) renderSettings();
}
// Init sidebar active state
setTimeout(() => navigateTo('dashboard'), 0);

// ============ RENDER DASHBOARD ============
function renderDashboard() {
  const d = dashboardData; const s = settingsData; if (!d) return;
  // Device bar
  el('dashDeviceName', d.device.name || 'Water Tank');
  el('dashFw', s?.firmware_version || '--');
  el('dashSyncTime', d.device.last_sync ? timeAgo(d.device.last_sync) : 'Never');
  const rssi = d.device.rssi;
  el('dashRssiLabel', rssiLabel(rssi));
  el('dashRssiVal', rssi != null ? rssi + ' dBm' : '--');
  // Water level
  const lvl = d.tank.level_percent;
  el('dashLevel', lvl != null ? Math.round(lvl) + '%' : '--%');
  el('dashVolume', (d.tank.volume_liters != null ? d.tank.volume_liters.toLocaleString() : '--') + ' L / ' + (d.tank.capacity_liters?.toLocaleString() || '--') + ' L');
  el('dashDistance', (d.tank.distance_cm != null ? d.tank.distance_cm : '--') + ' cm');
  // Level badge
  const badge = document.getElementById('dashLevelBadge');
  if (lvl != null) {
    if (lvl >= 40 && lvl <= 85) { badge.innerHTML = '<span style="width:6px;height:6px;border-radius:50%;background:var(--tertiary-container)"></span>Optimal'; badge.className = 'badge badge-tertiary'; badge.style.fontSize = '10px'; }
    else if (lvl < 25) { badge.innerHTML = '<span style="width:6px;height:6px;border-radius:50%;background:#dc2626"></span>Low'; badge.className = 'badge badge-offline'; badge.style.fontSize = '10px'; }
    else { badge.innerHTML = '<span style="width:6px;height:6px;border-radius:50%;background:var(--primary)"></span>Normal'; badge.className = 'badge badge-primary'; badge.style.fontSize = '10px'; }
  }
  // Tank fill
  const fill = document.getElementById('tankWaterFill');
  fill.style.height = (lvl != null ? Math.max(2, Math.min(98, lvl)) : 0) + '%';
  el('tankWaterLabel', lvl != null ? 'Water Level: ' + Math.round(lvl) + '%' : '--');
  // Calibration marks
  el('calFull', (s?.full_distance_cm || '--') + ' cm (Full)');
  el('calEmpty', (s?.tank_height_cm || '--') + ' cm (Empty)');
  // Motor
  const motorOn = d.motor.running;
  const mt = document.getElementById('motorToggle');
  mt.className = 'toggle ' + (motorOn ? 'on' : 'off');
  const dp = document.getElementById('motorDotPing');
  const ds = document.getElementById('motorDotSolid');
  const ml = document.getElementById('motorStatusLabel');
  if (motorOn) { dp.style.background = '#10b981'; dp.style.animation = 'pulse-dot 2s infinite'; ds.style.background = '#10b981'; ml.textContent = 'RUNNING'; ml.style.color = '#059669'; }
  else { dp.style.background = 'var(--outline-variant)'; dp.style.animation = 'none'; ds.style.background = 'var(--outline-variant)'; ml.textContent = 'STANDBY'; ml.style.color = 'var(--on-surface-variant)'; }
  // Mode segment
  const segs = document.querySelectorAll('#modeSegment button');
  segs.forEach(b => b.classList.remove('active'));
  segs[d.motor.mode === 'auto' ? 0 : 1].classList.add('active');
  // Stats
  el('dashLowThresh', d.motor.low_threshold_percent + '%');
  el('dashFullThresh', d.motor.full_threshold_percent + '%');
  el('dashRunTime', Math.round(d.motor.run_time_today_min) + ' min');
  if (d.estimate.est_full_in_min != null) { el('dashEstFull', d.estimate.est_full_in_min + ' min'); el('dashEstSub', 'Until full'); }
  else { el('dashEstFull', '--'); el('dashEstSub', 'When pumping'); }
  // Guard badge
  el('dashGuardBadge', d.safety.overflow_safeguard_armed ? 'ARMED' : 'DISARMED');
  el('alertLowDesc', 'Below ' + d.motor.low_threshold_percent + '%');
  el('alertFullDesc', 'At ' + d.motor.full_threshold_percent + '%');
  // Alert toggles
  setToggle('toggleLowAlert', s?.low_level_push_alert);
  setToggle('toggleAutoCutoff', s?.auto_mode_enabled);
  setToggle('toggleBuzzer', s?.buzzer_enabled);
  // Sparkline (use last 24h from history if available, otherwise skip)
  if (historyData) renderSparkline(historyData);
  else apiFetch('/api/history?range=24h').then(h => { historyData = h; renderSparkline(h); }).catch(() => {});
}

function renderSparkline(h) {
  if (!h || !h.series || h.series.length < 2) return;
  const pts = h.series;
  const svgW = 320, svgH = 120;
  const xMin = pts[0].t, xMax = pts[pts.length - 1].t;
  const xRange = xMax - xMin || 1;
  const coords = pts.map(p => ({ x: ((p.t - xMin) / xRange) * svgW, y: svgH - (p.level / 100) * svgH }));
  const lineD = coords.map((c, i) => (i === 0 ? 'M' : 'L') + ' ' + c.x.toFixed(1) + ' ' + c.y.toFixed(1)).join(' ');
  const areaD = lineD + ' L ' + svgW + ' ' + svgH + ' L 0 ' + svgH + ' Z';
  document.getElementById('sparklineArea').setAttribute('d', areaD);
  document.getElementById('sparklineLine').setAttribute('d', lineD);
  const last = coords[coords.length - 1];
  const dot = document.getElementById('sparklineDot');
  dot.setAttribute('cx', last.x); dot.setAttribute('cy', last.y); dot.style.display = '';
  el('dashMinMax', 'Min ' + (h.summary.min ?? '--') + '% · Max ' + (h.summary.max ?? '--') + '%');
}

// ============ RENDER HISTORY ============
function renderHistory() {
  const h = historyData; if (!h) return;
  el('histAvg', (h.summary.avg ?? '--') + '%');
  el('histMin', (h.summary.min ?? '--') + '%');
  el('histMax', (h.summary.max ?? '--') + '%');
  // Main chart
  if (h.series && h.series.length >= 2) {
    const pts = h.series;
    const xMin = pts[0].t, xMax = pts[pts.length - 1].t, xRange = xMax - xMin || 1;
    const chartW = 315, chartH = 162, oX = 25, oY = 8;
    const coords = pts.map(p => ({ x: oX + ((p.t - xMin) / xRange) * chartW, y: oY + chartH - (p.level / 100) * chartH }));
    const lineD = coords.map((c, i) => (i === 0 ? 'M' : 'L') + ' ' + c.x.toFixed(1) + ' ' + c.y.toFixed(1)).join(' ');
    const areaD = lineD + ' L ' + (oX + chartW) + ' 170 L ' + oX + ' 170 Z';
    document.getElementById('histArea').setAttribute('d', areaD);
    document.getElementById('histLine').setAttribute('d', lineD);
    const last = coords[coords.length - 1];
    const dot = document.getElementById('histDotEnd');
    dot.setAttribute('cx', last.x); dot.setAttribute('cy', last.y); dot.style.display = '';
    // X-axis labels
    const xAxis = document.getElementById('histXAxis');
    const rangeMs = { '24h': 86400000, '7d': 7 * 86400000, '30d': 30 * 86400000 }[historyRange] || 86400000;
    const nLabels = 6;
    let labelsHtml = '';
    for (let i = 0; i <= nLabels; i++) {
      const t = new Date(xMin + (xRange * i / nLabels));
      const label = i === nLabels ? 'Now' : t.getHours().toString().padStart(2, '0') + ':' + t.getMinutes().toString().padStart(2, '0');
      labelsHtml += '<span' + (i === nLabels ? ' style="font-weight:700;color:var(--tertiary)"' : '') + '>' + label + '</span>';
    }
    xAxis.innerHTML = labelsHtml;
  }
  // Motor events
  const evContainer = document.getElementById('motorEventsContainer');
  const events = h.motor_events || [];
  if (events.length === 0) {
    evContainer.innerHTML = '<div class="body-sm text-muted" style="text-align:center;padding:1.5rem 0">No motor events in this period</div>';
  } else {
    let evHtml = '';
    const recent = events.slice(-10).reverse();
    recent.forEach((ev, i) => {
      const t = new Date(ev.t);
      const time = t.getHours().toString().padStart(2, '0') + ':' + t.getMinutes().toString().padStart(2, '0');
      const isOn = ev.action === 'on';
      const color = isOn ? 'var(--tertiary)' : 'var(--primary)';
      const label = isOn ? 'Motor ON' : 'Motor OFF';
      const trigger = ev.trigger || '';
      const dur = ev.duration_min ? ' · ' + Math.round(ev.duration_min) + ' min' : '';
      evHtml += '<div style="display:flex;align-items:flex-start;gap:10px;padding:8px 4px;border-radius:0.5rem;transition:background 0.1s">' +
        '<div style="display:flex;flex-direction:column;align-items:center;margin-top:4px"><div class="timeline-dot" style="background:' + color + '"><span></span></div>' +
        (i < recent.length - 1 ? '<div class="timeline-line"></div>' : '') + '</div>' +
        '<div style="flex:1"><div style="display:flex;align-items:center;justify-content:space-between">' +
        '<span class="label-md" style="font-weight:600">' + label + '</span>' +
        '<span class="label-caps text-muted">' + time + '</span></div>' +
        '<div class="body-sm text-muted" style="margin-top:2px">' + trigger + dur + '</div></div></div>';
    });
    evContainer.innerHTML = evHtml;
    el('motorRelayBadge', events.filter(e => e.action === 'on').length + ' cycles');
  }
  // Daily usage bars
  const barsContainer = document.getElementById('dailyBarsContainer');
  const daily = h.daily_usage || [];
  if (daily.length === 0) {
    barsContainer.innerHTML = '<div class="body-sm text-muted" style="text-align:center;width:100%;padding:1.5rem 0">No usage data</div>';
  } else {
    const maxVal = Math.max(...daily.map(d => Math.max(d.inflow_liters || 0, d.consumed_liters || 0)), 1);
    let barsHtml = '';
    daily.slice(-7).forEach(d => {
      const dObj = new Date(d.date + 'T00:00:00');
      const dayName = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dObj.getDay()];
      const inflowH = Math.max(4, ((d.inflow_liters || 0) / maxVal) * 100);
      const consumH = Math.max(4, ((d.consumed_liters || 0) / maxVal) * 100);
      barsHtml += '<div style="display:flex;flex-direction:column;align-items:center;gap:6px;flex:1;height:100%;justify-content:flex-end">' +
        '<div style="display:flex;align-items:flex-end;gap:3px;width:100%;justify-content:center;height:90%">' +
        '<div style="width:8px;background:var(--primary);border-radius:2px 2px 0 0;height:' + inflowH + '%" title="Inflow: ' + (d.inflow_liters || 0) + 'L"></div>' +
        '<div style="width:8px;background:var(--surface-container-highest);border-radius:2px 2px 0 0;height:' + consumH + '%" title="Consumed: ' + (d.consumed_liters || 0) + 'L"></div></div>' +
        '<span style="font-size:10px;font-weight:600;color:var(--on-surface-variant)">' + dayName + '</span></div>';
    });
    barsContainer.innerHTML = barsHtml;
  }
}

// ============ RENDER SETTINGS ============
function renderSettings() {
  const s = settingsData; if (!s) return;
  el('settingsNodeInfo', (s.device_name || 'ESP32') + ' · ' + (s.firmware_version || '--'));
  const usable = (s.tank_height_cm || 0) - (s.full_distance_cm || 0);
  el('settUsableCol', usable > 0 ? usable : '--');
  el('settCurrentLevel', dashboardData ? 'Current: ' + Math.round(dashboardData.tank.level_percent || 0) + '% (' + (dashboardData.tank.volume_liters || 0).toLocaleString() + ' L)' : '--');
  const bar = document.getElementById('settLevelBar');
  bar.style.width = dashboardData ? Math.round(dashboardData.tank.level_percent || 0) + '%' : '0%';
  el('settTankHeight', s.tank_height_cm);
  el('settFullDist', s.full_distance_cm);
  el('settCapacity', s.capacity_liters?.toLocaleString() || '--');
  el('settLowThresh', s.low_threshold_percent + '%');
  el('settFullThresh', s.full_threshold_percent + '%');
  el('settMaxRun', s.max_run_duration_min + ' min');
  setToggle('settAutoToggle', s.auto_mode_enabled);
  setToggle('settAlertLow', s.low_level_push_alert);
  setToggle('settAlertBuzzer', s.buzzer_enabled);
  setToggle('settAlertOffline', s.device_offline_alert);
  el('settDevName', s.device_name || '--');
  el('settFirmware', s.firmware_version || '--');
  el('settFwBadge', s.firmware_version || '--');
  el('settRssi', dashboardData?.device?.rssi != null ? dashboardData.device.rssi + ' dBm (' + rssiLabel(dashboardData.device.rssi) + ')' : '--');
  el('settInterval', s.report_interval_s + 's');
  el('settFlowRate', s.pump_flow_lpm + ' L/min');
  el('settRelayBadge', s.auto_mode_enabled ? '<span class="pulse-dot" style="width:6px;height:6px;border-radius:50%;background:var(--tertiary)"></span>RELAY ARMED' : 'MANUAL');
  el('sidebarTitle', s.device_name || 'Water Tank');
}

// ============ STATUS INDICATORS ============
function updateStatusIndicators(online) {
  const dot = document.getElementById('topBarStatusDot');
  const text = document.getElementById('topBarStatusText');
  const badge = document.getElementById('topBarStatus');
  if (online) { dot.style.background = '#10b981'; text.textContent = 'ONLINE'; badge.className = 'badge badge-online'; badge.style.fontSize = '10px'; }
  else { dot.style.background = '#ef4444'; text.textContent = 'OFFLINE'; badge.className = 'badge badge-offline'; badge.style.fontSize = '10px'; }
  el('sidebarOnline', online ? 'Online' : 'Offline');
  el('sidebarRssi', dashboardData?.device?.rssi != null ? dashboardData.device.rssi + ' dBm' : '--');
}

// ============ ACTIONS ============
async function toggleMotor() {
  if (!settingsData) return;
  // In auto mode, switch to manual first so the command isn't overridden immediately
  const currentlyOn = dashboardData?.motor?.running ?? false;
  const cmd = currentlyOn ? 'off' : 'on';
  try {
    // If currently in auto mode, disable it so the ESP respects the manual command
    const body = { motor_command: cmd };
    if (settingsData.auto_mode_enabled) body.auto_mode_enabled = false;
    await apiFetch('/api/settings', 'POST', body);
    if (body.auto_mode_enabled === false) {
      settingsData.auto_mode_enabled = false;
      // Update mode segment to Manual
      const segs = document.querySelectorAll('#modeSegment button');
      segs.forEach(b => b.classList.remove('active'));
      segs[1].classList.add('active');
    }
    showToast('Motor ' + cmd.toUpperCase() + ' command sent — ESP will act within 15 s');
    setTimeout(refreshData, 16000); // refresh after ESP has had time to pick it up
  } catch(e) { showToast('Failed to send motor command'); }
}

function switchMode(mode, btn) {
  document.querySelectorAll('#modeSegment button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  apiFetch('/api/settings', 'POST', { auto_mode_enabled: mode === 'auto' })
    .then(() => { showToast(mode === 'auto' ? 'Auto mode enabled' : 'Manual mode enabled'); refreshData(); })
    .catch(() => {});
}

function switchRange(range, btn) {
  historyRange = range;
  document.querySelectorAll('#historyRangeSegment button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  loadHistory();
}

async function toggleAlert(key, btn) {
  const isOn = btn.classList.contains('on');
  const val = !isOn;
  const body = {}; body[key] = val;
  try {
    await apiFetch('/api/settings', 'POST', body);
    setToggle(btn.id, val);
    showToast(key.replace(/_/g, ' ') + (val ? ' enabled' : ' disabled'));
    settingsData[key] = val;
  } catch(e) {}
}

async function toggleSetting(key, btn) {
  const isOn = btn.classList.contains('on');
  const val = !isOn;
  const body = {}; body[key] = val;
  try {
    await apiFetch('/api/settings', 'POST', body);
    setToggle(btn.id, val);
    showToast(key.replace(/_/g, ' ') + (val ? ' enabled' : ' disabled'));
    settingsData[key] = val;
    renderSettings();
  } catch(e) {}
}

function editSetting(key, label) {
  const current = settingsData ? settingsData[key] : '';
  const val = prompt(label, current);
  if (val === null || val === '') return;
  const numVal = Number(val);
  if (isNaN(numVal)) { showToast('Invalid number'); return; }
  const body = {}; body[key] = numVal;
  apiFetch('/api/settings', 'POST', body)
    .then(() => { showToast(label + ' updated to ' + numVal); settingsData[key] = numVal; renderSettings(); })
    .catch(() => {});
}

async function restartDevice() {
  const btn = document.getElementById('restartBtn');
  btn.innerHTML = '<span class="material-symbols-outlined" style="font-size:20px;animation:spin 0.6s linear infinite">refresh</span>Sending Reboot...';
  btn.disabled = true;
  try {
    await apiFetch('/api/settings', 'POST', { reboot_requested: true });
    btn.innerHTML = '<span class="material-symbols-outlined" style="font-size:20px">check</span>Reboot Signal Sent';
    showToast('ESP32 reboot signal sent');
    setTimeout(() => { btn.innerHTML = '<span class="material-symbols-outlined" style="font-size:20px">restart_alt</span>Restart ESP32 Controller'; btn.disabled = false; }, 3000);
  } catch(e) { btn.innerHTML = '<span class="material-symbols-outlined" style="font-size:20px">restart_alt</span>Restart ESP32 Controller'; btn.disabled = false; }
}

// ============ HELPERS ============
function el(id, text) { const e = document.getElementById(id); if (e) e.innerHTML = text; }
function setToggle(id, val) { const b = document.getElementById(id); if (b) { b.className = 'toggle ' + (val ? 'on' : 'off'); } }
function rssiLabel(rssi) { if (rssi == null) return '--'; if (rssi > -50) return 'Excellent'; if (rssi > -60) return 'Good'; if (rssi > -70) return 'Fair'; return 'Weak'; }
function timeAgo(iso) { const ms = Date.now() - new Date(iso).getTime(); if (ms < 60000) return Math.round(ms/1000) + 's ago'; if (ms < 3600000) return Math.round(ms/60000) + 'm ago'; return Math.round(ms/3600000) + 'h ago'; }
function showToast(msg) { const t = document.getElementById('toast'); document.getElementById('toastText').textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 3000); }

// Spin keyframe
const style = document.createElement('style');
style.textContent = '@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}';
document.head.appendChild(style);
</script>
</body>
</html>`;

  return new Response(html, { headers: { "Content-Type": "text/html" } });
}