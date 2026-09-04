// ESP32-C3 Mini — Water Tank Level Monitor
// AJ-SR04M (distance) + 128x32 OLED + Relay (motor) + Buzzer + Cloudflare Worker reporting
//
// ECHO pin needs a voltage divider (5V -> 3.3V) before connecting to ESP32-C3!
// e.g. 1kΩ (ECHO to GPIO) + 2kΩ (GPIO to GND) resistor divider
//
// Libraries needed (Library Manager): Adafruit_GFX, Adafruit_SSD1306, ArduinoJson

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include "config.h"   // WIFI_SSID, WIFI_PASSWORD, WORKER_URL, API_KEY — NOT committed to git

// ---------------- USER CONFIG ----------------
// WiFi, Worker URL, and API_KEY now live in config.h (copy config.example.h -> config.h)

// Tank calibration (measured from the sensor face, straight down)
// Distance when tank is EMPTY (sensor to tank bottom / max distance)
const float TANK_HEIGHT_CM = 100.0;
// Distance when tank is FULL (sensor to water surface at max fill)
const float FULL_DISTANCE_CM = 10.0;

// Motor control thresholds (percentage of water level)
const float LOW_LEVEL_PERCENT  = 20.0;  // motor turns ON at/below this
const float FULL_LEVEL_PERCENT = 95.0;  // motor turns OFF at/above this

// Reporting interval to Cloudflare Worker (ms)
const unsigned long REPORT_INTERVAL_MS = 10000;

// ---------------- PINS ----------------

#define TRIG_PIN  4   // AJ-SR04M TRIG
#define ECHO_PIN  5   // AJ-SR04M ECHO (through voltage divider)
#define SDA_PIN   8
#define SCL_PIN   9
#define RELAY_PIN 6   // Relay -> Motor
#define BUZZER_PIN 7  // Buzzer

// ---------------- OLED ----------------

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 32
#define OLED_RESET -1
#define SCREEN_ADDRESS 0x3C

Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);

// ---------------- STATE ----------------

bool motorOn = false;
unsigned long lastReportMs = 0;

// ---------------- SETUP ----------------

void setup() {
  Serial.begin(115200);

  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  digitalWrite(TRIG_PIN, LOW);

  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, LOW); // motor off at boot

  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);

  Wire.begin(SDA_PIN, SCL_PIN);
  if (!display.begin(SSD1306_SWITCHCAPVCC, SCREEN_ADDRESS)) {
    Serial.println("SSD1306 allocation failed");
    while (true) delay(10);
  }
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.println("Connecting WiFi...");
  display.display();

  connectWiFi();
}

// ---------------- MAIN LOOP ----------------

void loop() {
  float distance_cm = measureDistanceCM();
  float level_percent = -1;

  if (distance_cm > 0) {
    level_percent = distanceToPercent(distance_cm);
    handleMotorControl(level_percent);
  }

  updateOLED(distance_cm, level_percent);

  if (millis() - lastReportMs >= REPORT_INTERVAL_MS) {
    lastReportMs = millis();
    reportToCloud(level_percent, distance_cm);
  }

  delay(500);
}

// ---------------- DISTANCE / LEVEL ----------------

float measureDistanceCM() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);

  long duration = pulseIn(ECHO_PIN, HIGH, 30000); // ~30ms timeout, ~5m range
  if (duration == 0) return -1;

  return (duration * 0.0343) / 2.0; // speed of sound / 2 (round trip)
}

float distanceToPercent(float distance_cm) {
  float percent = ((TANK_HEIGHT_CM - distance_cm) / (TANK_HEIGHT_CM - FULL_DISTANCE_CM)) * 100.0;
  if (percent < 0) percent = 0;
  if (percent > 100) percent = 100;
  return percent;
}

// ---------------- MOTOR + BUZZER ----------------

void handleMotorControl(float level_percent) {
  if (!motorOn && level_percent <= LOW_LEVEL_PERCENT) {
    motorOn = true;
    digitalWrite(RELAY_PIN, HIGH);
    beep(3);
    Serial.println("Motor ON");
  } else if (motorOn && level_percent >= FULL_LEVEL_PERCENT) {
    motorOn = false;
    digitalWrite(RELAY_PIN, LOW);
    beep(1);
    Serial.println("Motor OFF");
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

// ---------------- OLED ----------------

void updateOLED(float distance_cm, float level_percent) {
  display.clearDisplay();
  display.setTextSize(1);
  display.setCursor(0, 0);

  if (level_percent >= 0) {
    display.print("Level: ");
    display.print(level_percent, 0);
    display.println(" %");
  } else {
    display.println("Sensor error");
  }

  display.setCursor(0, 10);
  display.print("Motor: ");
  display.println(motorOn ? "ON" : "OFF");

  display.setCursor(0, 20);
  display.print("WiFi: ");
  display.println(WiFi.status() == WL_CONNECTED ? "OK" : "DOWN");

  display.display();
}

// ---------------- WIFI ----------------

void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
    delay(300);
    Serial.print(".");
  }
  Serial.println();
  Serial.println(WiFi.status() == WL_CONNECTED ? "WiFi connected" : "WiFi connect failed");
}

// ---------------- CLOUD REPORTING ----------------

void reportToCloud(float level_percent, float distance_cm) {
  if (WiFi.status() != WL_CONNECTED) {
    connectWiFi();
    if (WiFi.status() != WL_CONNECTED) return;
  }

  HTTPClient http;
  http.begin(WORKER_URL);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-API-KEY", API_KEY);

  StaticJsonDocument<256> doc;
  doc["level_percent"] = level_percent;
  doc["distance_cm"] = distance_cm;
  doc["motor_on"] = motorOn;

  String payload;
  serializeJson(doc, payload);

  int httpCode = http.POST(payload);
  Serial.print("Report POST status: ");
  Serial.println(httpCode);

  http.end();
}
