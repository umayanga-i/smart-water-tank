// config.example.h
// Copy this file to "config.h" and fill in your real values.
// config.h is gitignored — it will NEVER be committed to the repo.

#ifndef CONFIG_H
#define CONFIG_H

// WiFi credentials
#define WIFI_SSID     "1"
#define WIFI_PASSWORD "47426077"

// Cloudflare Worker endpoint
#define WORKER_URL "https://water-tank.ixu.workers.dev/update"

// Shared secret — must match the API_KEY secret set on the Worker
// (see README: `npx wrangler secret put API_KEY`)
#define API_KEY "sdgfdt345476fdgbfdcb"

#endif
