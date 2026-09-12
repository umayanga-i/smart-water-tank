# ESP32 Water Tank Monitor

ESP32-C3 water tank level monitor with ultrasonic sensing, automatic pump
control, and live status reporting to a Cloudflare Worker.

## Hardware
- ESP32-C3 mini
- AJ-SR04M ultrasonic sensor (TRIG -> GPIO4, ECHO -> GPIO5 via voltage divider)
- 128x32 SSD1306 OLED (SDA -> GPIO8, SCL -> GPIO9)
- Relay module -> motor (GPIO6)
- Buzzer (GPIO7)

## Setup

### 1. Firmware
1. Open `water_tank.ino` in Arduino IDE.
2. Install libraries: `Adafruit GFX`, `Adafruit SSD1306`, `ArduinoJson`.
3. Copy `config.example.h` to `config.h` and fill in your WiFi credentials,
   Worker URL, and API key. **`config.h` is gitignored — never commit it.**
4. Adjust `TANK_HEIGHT_CM`, `FULL_DISTANCE_CM`, and the motor thresholds for
   your tank.
5. Upload.

### 2. Cloudflare Worker
```bash
cd worker
npx wrangler kv namespace create TANK_KV
# paste the returned id into wrangler.toml

npx wrangler secret put API_KEY
# paste the SAME value you put in config.h

npx wrangler deploy
```

## Security notes
- `config.h` (WiFi password, Worker URL, API key) is gitignored — only
  `config.example.h` with placeholder values is committed.
- The Worker's `/update` endpoint requires an `X-API-KEY` header matching a
  Worker **secret** (set via `wrangler secret put`, never stored in the repo
  or `wrangler.toml`), so random requests can't overwrite your data.
- If you ever push a real secret by accident: rotate it immediately (change
  the WiFi password / generate a new API key) — removing it from a later
  commit does not remove it from git history.
- GitHub's secret scanning / push protection is on by default for public
  repos and will block some known secret patterns, but it's not a substitute
  for keeping secrets out of commits in the first place.


