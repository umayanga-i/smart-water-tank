// config.example.h
// Copy this file to "config.h" and fill in your real values.
// config.h is gitignored — it will NEVER be committed to the repo.

#ifndef CONFIG_H
#define CONFIG_H

// WiFi credentials
#define WIFI_SSID     "YOUR_WIFI_SSID"
#define WIFI_PASSWORD "YOUR_WIFI_PASSWORD"

// Cloudflare Worker BASE URL — no trailing slash, no /update suffix.
// The firmware appends paths itself, e.g. WORKER_URL + "/api/update"
#define WORKER_URL "https://your-worker.your-subdomain.workers.dev"

// Shared secret — must match the API_KEY secret set on the Worker
// (see README: `npx wrangler secret put API_KEY`)
#define API_KEY "CHANGE_ME_TO_A_LONG_RANDOM_STRING"

#endif
