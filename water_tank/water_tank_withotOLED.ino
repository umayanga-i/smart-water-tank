// ESP32-C3 Mini — Water Tank Level Monitor (no-OLED build)
// AJ-SR04M (distance) + Relay (motor) + Buzzer + 2× Status LEDs
// Talks to the Cloudflare Worker's real API:
//   POST /api/update        periodic telemetry
//   POST /api/motor-event   fired on every relay ON/OFF transition
//   GET  /api/settings      pulled each cycle (calibration, thresholds, toggles)
//   POST /api/settings      used only to clear reboot_requested / motor_command
//
// ECHO pin needs a voltage divider (5V -> 3.3V) before connecting to ESP32-C3!
// e.g. 1kΩ (ECHO to GPIO) + 2kΩ (GPIO to GND) resistor divider
//
// Status LEDs:
//   GPIO 7 — WiFi LED  : HIGH when connected to WiFi
//   GPIO 6 — Motor LED : HIGH when motor/relay is ON
//
// Libraries needed (Library Manager):
//   ArduinoJson

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <time.h>
#include "config.h"   // WIFI_SSID, WIFI_PASSWORD, WORKER_URL, API_KEY — gitignored

// ---------------- PINS ----------------

#define TRIG_PIN    4
#define ECHO_PIN    5
#define RELAY_PIN   3
#define BUZZER_PIN  2
#define LED_WIFI    7   // HIGH = WiFi connected
#define LED_MOTOR   6   // HIGH = motor running

// ---------------- DEFAULT SETTINGS (overwritten by GET /api/settings) -------
// Field names match the Worker's DEFAULT_SETTINGS exactly.

float tankHeightCm       = 100.0;
float fullDistanceCm     = 10.0;
float lowThresholdPct    = 20.0;
float fullThresholdPct   = 95.0;
bool  autoModeEnabled    = true;
bool  buzzerEnabled      = true;
unsigned long reportIntervalMs = 10000;
int   maxRunDurationMin  = 60;     // 0 = disabled
int   tzOffsetMin        = 330;    // Asia/Colombo default
bool  rebootRequested    = false;
char  firmwareVersion[16] = "v1.0.0";  // updated from GET /api/settings
char  motorCommand[8]     = "none";    // "none" | "on" | "off" — one-shot from dashboard

// ---------------- TIMING ----------------

const unsigned long MEASURE_INTERVAL_MS = 2000;   // sensor read every 2 s
const unsigned long SETTINGS_POLL_MS    = 15000;  // GET /api/settings every 15 s

// ---------------- STATE ----------------

bool motorOn = false;
unsigned long motorOnAtMs = 0;          // millis() when motor turned on
unsigned long runTimeTodaySec = 0;      // resets at local midnight
int lastDayOfYear = -1;
bool ntpSynced = false;

float lastLevelPercent = -1;
float lastDistanceCm = -1;

unsigned long lastMeasureMs = 0;
unsigned long lastReportMs = 0;
unsigned long lastSettingsPollMs = 0;

// ================================================================
// SETUP
// ================================================================

void setup() {
  Serial.begin(115200);

  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  digitalWrite(TRIG_PIN, LOW);

  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, LOW);

  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);

  // Status LEDs — start both off
  pinMode(LED_WIFI,  OUTPUT);
  pinMode(LED_MOTOR, OUTPUT);
  digitalWrite(LED_WIFI,  LOW);
  digitalWrite(LED_MOTOR, LOW);

  connectWiFi();
  fetchSettings();     // get real calibration before first reading
  setupTimeSync();
}

// ================================================================
// MAIN LOOP
// ================================================================

void loop() {
  unsigned long now = millis();

  // Update WiFi LED every cycle (handles reconnects)
  digitalWrite(LED_WIFI, WiFi.status() == WL_CONNECTED ? HIGH : LOW);

  if (now - lastMeasureMs >= MEASURE_INTERVAL_MS) {
    lastMeasureMs = now;

    lastDistanceCm = measureDistanceCM();
    if (lastDistanceCm > 0) {
      lastLevelPercent = distanceToPercent(lastDistanceCm);
      applyMotorControl(lastLevelPercent);
    }
    accumulateRunTime();
  }

  if (now - lastSettingsPollMs >= SETTINGS_POLL_MS) {
    lastSettingsPollMs = now;
    fetchSettings();
    if (rebootRequested) {
      Serial.println("Reboot requested by server — restarting...");
      clearRebootFlag();
      delay(300);
      ESP.restart();
    }
  }

  if (now - lastReportMs >= reportIntervalMs) {
    lastReportMs = now;
    reportTelemetry();
  }
}

// ================================================================
// DISTANCE / LEVEL
// ================================================================

float measureDistanceCM() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);

  long duration = pulseIn(ECHO_PIN, HIGH, 30000); // ~30ms timeout, ~5m range
  if (duration == 0) return -1;

  return (duration * 0.0343) / 2.0;
}

float distanceToPercent(float distance_cm) {
  float percent = ((tankHeightCm - distance_cm) / (tankHeightCm - fullDistanceCm)) * 100.0;
  if (percent < 0) percent = 0;
  if (percent > 100) percent = 100;
  return percent;
}

// ================================================================
// MOTOR + BUZZER + RUNTIME TRACKING
// ================================================================

void setMotor(bool on, const char* trigger) {
  if (on == motorOn) return; // no change, no event

  motorOn = on;
  digitalWrite(RELAY_PIN, motorOn ? HIGH : LOW);
  digitalWrite(LED_MOTOR, motorOn ? HIGH : LOW);  // motor LED mirrors relay

  if (buzzerEnabled) beep(motorOn ? 3 : 1);

  if (motorOn) {
    motorOnAtMs = millis();
    reportMotorEvent("on", trigger, -1);
    Serial.printf("Motor ON (%s)\n", trigger);
  } else {
    float duration_min = (millis() - motorOnAtMs) / 60000.0;
    reportMotorEvent("off", trigger, duration_min);
    Serial.printf("Motor OFF (%s) after %.1f min\n", trigger, duration_min);
  }
}

void applyMotorControl(float level_percent) {
  // Safety cutoff: motor has been running too long — force off regardless of mode
  if (motorOn && maxRunDurationMin > 0) {
    float runMin = (millis() - motorOnAtMs) / 60000.0;
    if (runMin >= maxRunDurationMin) {
      setMotor(false, "safety_cutoff");
      return;
    }
  }

  if (!autoModeEnabled) return; // manual mode: leave relay as-is

  if (!motorOn && level_percent <= lowThresholdPct) {
    setMotor(true, "auto");
  } else if (motorOn && level_percent >= fullThresholdPct) {
    setMotor(false, "auto");
  }
}

void accumulateRunTime() {
  static unsigned long lastTick = 0;
  unsigned long now = millis();
  if (lastTick == 0) lastTick = now;

  if (motorOn) {
    runTimeTodaySec += (now - lastTick) / 1000;
  }
  lastTick = now;

  // Reset the counter at local midnight, once NTP time is available
  if (ntpSynced) {
    time_t nowT = time(nullptr);
    struct tm t;
    localtime_r(&nowT, &t);
    if (lastDayOfYear != -1 && t.tm_yday != lastDayOfYear) {
      runTimeTodaySec = 0;
    }
    lastDayOfYear = t.tm_yday;
  }
}

void beep(int times) {
  for (int i = 0; i < times; i++) {
    digitalWrite(BUZZER_PIN, HIGH);
    delay(150);
    digitalWrite(BUZZER_PIN, LOW);
    delay(150);
  }
}

// ================================================================
// WIFI + TIME
// ================================================================

void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
    delay(300);
    Serial.print(".");
  }
  Serial.println();
  bool connected = WiFi.status() == WL_CONNECTED;
  Serial.println(connected ? "WiFi connected" : "WiFi connect failed");
  digitalWrite(LED_WIFI, connected ? HIGH : LOW);
}

bool ensureWiFi() {
  if (WiFi.status() == WL_CONNECTED) return true;
  connectWiFi();
  return WiFi.status() == WL_CONNECTED;
}

void setupTimeSync() {
  configTime(tzOffsetMin * 60, 0, "pool.ntp.org", "time.nist.gov");
  time_t nowT = time(nullptr);
  int attempts = 0;
  while (nowT < 100000 && attempts < 20) {
    delay(300);
    nowT = time(nullptr);
    attempts++;
  }
  ntpSynced = (nowT > 100000);
  Serial.println(ntpSynced ? "NTP time synced" : "NTP sync failed (runtime-today may be inaccurate)");
}

// ================================================================
// API: POST /api/update  (telemetry)
// ================================================================

void reportTelemetry() {
  if (!ensureWiFi()) return;

  HTTPClient http;
  http.begin(String(WORKER_URL) + "/api/update");
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-API-KEY", API_KEY);

  StaticJsonDocument<320> doc;
  doc["level_percent"]      = lastLevelPercent;
  doc["distance_cm"]        = lastDistanceCm;
  doc["motor_on"]           = motorOn;
  doc["rssi"]               = WiFi.RSSI();
  doc["run_time_today_min"] = runTimeTodaySec / 60.0;
  doc["uptime_s"]           = (unsigned long)(millis() / 1000);
  doc["firmware_version"]   = firmwareVersion;

  String payload;
  serializeJson(doc, payload);

  int httpCode = http.POST(payload);
  Serial.print("POST /api/update -> ");
  Serial.println(httpCode);

  http.end();
}

// ================================================================
// API: POST /api/motor-event
// ================================================================

void reportMotorEvent(const char* action, const char* trigger, float duration_min) {
  if (!ensureWiFi()) return;

  HTTPClient http;
  http.begin(String(WORKER_URL) + "/api/motor-event");
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-API-KEY", API_KEY);

  StaticJsonDocument<192> doc;
  doc["action"]  = action;       // "on" | "off"
  doc["trigger"] = trigger;      // "auto" | "manual" | "safety_cutoff"
  if (duration_min >= 0) doc["duration_min"] = duration_min;

  String payload;
  serializeJson(doc, payload);

  int httpCode = http.POST(payload);
  Serial.print("POST /api/motor-event -> ");
  Serial.println(httpCode);

  http.end();
}

// ================================================================
// API: GET /api/settings
// ================================================================

void fetchSettings() {
  if (!ensureWiFi()) return;

  HTTPClient http;
  http.begin(String(WORKER_URL) + "/api/settings");
  http.addHeader("X-API-KEY", API_KEY);

  int httpCode = http.GET();
  if (httpCode == 200) {
    String payload = http.getString();

    StaticJsonDocument<640> doc;
    DeserializationError err = deserializeJson(doc, payload);
    if (!err) {
      tankHeightCm      = doc["tank_height_cm"]         | tankHeightCm;
      fullDistanceCm    = doc["full_distance_cm"]       | fullDistanceCm;
      lowThresholdPct   = doc["low_threshold_percent"]  | lowThresholdPct;
      fullThresholdPct  = doc["full_threshold_percent"] | fullThresholdPct;
      autoModeEnabled   = doc["auto_mode_enabled"]      | autoModeEnabled;
      buzzerEnabled     = doc["buzzer_enabled"]         | buzzerEnabled;
      maxRunDurationMin = doc["max_run_duration_min"]   | maxRunDurationMin;
      tzOffsetMin       = doc["tz_offset_min"]          | tzOffsetMin;
      rebootRequested   = doc["reboot_requested"]       | false;

      // One-shot motor command from dashboard ("on" | "off" | "none")
      const char* mc = doc["motor_command"];
      if (mc) strlcpy(motorCommand, mc, sizeof(motorCommand));

      // Store firmware_version so it can be echoed back in telemetry
      const char* fwv = doc["firmware_version"];
      if (fwv) strlcpy(firmwareVersion, fwv, sizeof(firmwareVersion));

      long intervalS = doc["report_interval_s"] | (reportIntervalMs / 1000);
      reportIntervalMs = intervalS * 1000UL;
    } else {
      Serial.print("Settings JSON parse error: ");
      Serial.println(err.c_str());
    }
  } else {
    Serial.print("GET /api/settings -> ");
    Serial.println(httpCode);
  }

  http.end();

  // Act on a one-shot motor_command sent from the dashboard
  if (strcmp(motorCommand, "on") == 0 || strcmp(motorCommand, "off") == 0) {
    bool wantOn = strcmp(motorCommand, "on") == 0;
    Serial.printf("Motor command from dashboard: %s\n", motorCommand);
    setMotor(wantOn, "manual");       // act immediately
    strlcpy(motorCommand, "none", sizeof(motorCommand));
    clearMotorCommand();              // tell the worker we consumed it
  }
}

// Clears motor_command on the server so it doesn't re-fire on the next poll
void clearMotorCommand() {
  if (!ensureWiFi()) return;

  HTTPClient http;
  http.begin(String(WORKER_URL) + "/api/settings");
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-API-KEY", API_KEY);

  StaticJsonDocument<64> doc;
  doc["motor_command"] = "none";
  String payload;
  serializeJson(doc, payload);

  int httpCode = http.POST(payload);
  Serial.print("POST /api/settings (clearMotorCommand) -> ");
  Serial.println(httpCode);
  http.end();
}

// Clears reboot_requested on the server so it doesn't loop-restart forever
void clearRebootFlag() {
  if (!ensureWiFi()) return;

  HTTPClient http;
  http.begin(String(WORKER_URL) + "/api/settings");
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-API-KEY", API_KEY);

  StaticJsonDocument<64> doc;
  doc["reboot_requested"] = false;
  String payload;
  serializeJson(doc, payload);

  int httpCode = http.POST(payload);
  Serial.print("POST /api/settings (clearRebootFlag) -> ");
  Serial.println(httpCode);
  http.end();
}
