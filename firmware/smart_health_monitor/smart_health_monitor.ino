// =====================================================================
//  Smart Health Monitor – wearable firmware (ESP32 DevKit 30-pin)
//  Reads MAX30102, DHT11, MPU6050, Neo-6M GPS and an SOS button,
//  beeps the buzzer on SOS / fall, shows readings on an OLED and sends everything to Blynk IoT.
//
//  Wiring:
//    MAX30102  SDA -> D21   SCL -> D22   VIN -> 3V3   GND -> GND
//    OLED      SDA -> D21   SCL -> D22   VCC -> 3V3   GND -> GND   (shares the bus with the MAX30102)
//    MPU6050   SDA -> D32   SCL -> D33   VCC -> VIN   GND -> GND
//    DHT11     DATA -> D4                VCC -> 3V3   GND -> GND
//    Neo-6M    TX -> RX2 (16)  RX -> TX2 (17)  VCC -> VIN  GND -> GND
//    SOS button  one leg -> D27, other leg -> GND
//    Buzzer      + -> D25, - -> GND
//
//  Libraries (Library Manager): Blynk, SparkFun MAX3010x, DHT sensor library, TinyGPSPlus,
//  Adafruit SSD1306, Adafruit GFX
//
//  Blynk datastreams (must match the dashboard):
//    V0 status   V1 heart rate   V2 SpO2   V3 temperature   V4 humidity
//    V5 fall     V6 SOS          V9 heartbeat counter   V10 help dispatched (from dashboard)
//    V11 latitude   V12 "lat,lng" (String)   V13 satellites   V14 connected sensors
// =====================================================================

// ---------- 1) Wi-Fi + Blynk settings live in secrets.h (copy secrets.example.h) ----------
#include "secrets.h"
const char WIFI_SSID[] = WIFI_SSID_VALUE;
const char WIFI_PASS[] = WIFI_PASS_VALUE;

#define BLYNK_PRINT Serial
#define BLYNK_HEARTBEAT 10   // seconds (Blynk's minimum); Blynk marks the device offline sooner (default is 45)
#include <WiFi.h>
#include <BlynkSimpleEsp32.h>
#include <Wire.h>
#include <MAX30105.h>
#include <spo2_algorithm.h>
#include <DHT.h>
#include <TinyGPSPlus.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

// ---------- 2) Pins ----------
#define MAX_SDA 21
#define MAX_SCL 22
#define MPU_SDA 32
#define MPU_SCL 33
#define DHT_PIN 4
#define GPS_RX 16      // ESP32 receives here (Neo-6M TX)
#define GPS_TX 17      // ESP32 sends here (Neo-6M RX)
#define SOS_PIN 27
#define BUZZER_PIN 25

// ---------- 3) Settings ----------
const char *USER = "W01";
const unsigned long SEND_MS = 2000;      // how often readings go to Blynk
const uint32_t FINGER_IR = 50000;        // IR level that means a finger is on the MAX30102
const float FREE_FALL_G = 0.4;           // fall = free fall (below this) ...
const float IMPACT_G = 2.5;              // ... followed by an impact (above this)
const unsigned long FALL_WINDOW_MS = 800;
const unsigned long CANCEL_HOLD_MS = 3000; // hold the SOS button this long to cancel a false alarm

// Sensor bits for V14 – the dashboard shows readings only when all four are set (15)
enum { S_MAX = 1, S_DHT = 2, S_MPU = 4, S_GPS = 8 };

MAX30105 pulse;
DHT dht(DHT_PIN, DHT11);
TinyGPSPlus gps;
// 0.96" I2C OLED at 0x3C, no reset pin; keep the shared bus at 400 kHz for the MAX30102
Adafruit_SSD1306 oled(128, 64, &Wire, -1, 400000, 400000);
BlynkTimer timer;

bool maxOk = false, mpuOk = false, dhtOk = false, oledOk = false;
int heartRate = 0, spo2 = 0;
float temperature = 0, humidity = 0;
bool sosActive = false, fallActive = false;
String lastStatus;

// =====================================================================
// MAX30102: collect 100 samples (4 s at 25 Hz), then work out HR + SpO2.
// The window slides by 25 samples, so values update every second.
// =====================================================================
const int BUF = 100, STEP = 25;
uint32_t irBuf[BUF], redBuf[BUF];
int filled = 0, sinceCalc = 0;
unsigned long lastGoodPulse = 0;
uint32_t lastIr = 0;      // raw IR level, printed so finger contact can be checked
float lastG = 0;          // total acceleration in g, printed so the MPU6050 can be checked

void setupPulse() {
  maxOk = pulse.begin(Wire, I2C_SPEED_FAST);
  if (!maxOk) { Serial.println("MAX30102 not found"); return; }
  // brightness 60, average 4, red+IR, 100 Hz, 411 us pulse, 4096 range -> 25 samples/s
  pulse.setup(60, 4, 2, 100, 411, 4096);
}

void readPulse() {
  if (!maxOk) return;
  pulse.check();
  while (pulse.available()) {
    uint32_t red = pulse.getFIFORed(), ir = pulse.getFIFOIR();
    lastIr = ir;
    pulse.nextSample();

    if (ir < FINGER_IR) {                 // no finger: reset and report 0
      filled = sinceCalc = 0;
      heartRate = spo2 = 0;
      continue;
    }
    if (filled < BUF) { irBuf[filled] = ir; redBuf[filled] = red; filled++; }
    else {
      memmove(irBuf, irBuf + 1, (BUF - 1) * sizeof(uint32_t));
      memmove(redBuf, redBuf + 1, (BUF - 1) * sizeof(uint32_t));
      irBuf[BUF - 1] = ir; redBuf[BUF - 1] = red;
    }
    if (filled == BUF && ++sinceCalc >= STEP) {
      sinceCalc = 0;
      int32_t s, hr; int8_t sValid, hrValid;
      maxim_heart_rate_and_oxygen_saturation(irBuf, BUF, redBuf, &s, &sValid, &hr, &hrValid);
      // keep only believable values; otherwise hold the last good ones for a moment
      if (hrValid && hr >= 40 && hr <= 180) { heartRate = hr; lastGoodPulse = millis(); }
      if (sValid && s >= 80 && s <= 100) spo2 = s;
    }
  }
  if (millis() - lastGoodPulse > 10000) heartRate = spo2 = 0;   // nothing valid for 10 s
}

// =====================================================================
// MPU6050: fall = free fall followed quickly by an impact
// =====================================================================
// Registers are read directly (no Adafruit library) because many MPU6050 clone boards report a
// different chip ID (WHO_AM_I) and the library then refuses them, even though they work fine.
unsigned long freeFallAt = 0;
uint8_t mpuAddr = 0x68;

void mpuWrite(uint8_t reg, uint8_t val) {
  Wire1.beginTransmission(mpuAddr); Wire1.write(reg); Wire1.write(val); Wire1.endTransmission();
}

void setupMotion() {
  for (uint8_t addr : {0x68, 0x69}) {
    Wire1.beginTransmission(addr);
    if (Wire1.endTransmission() == 0) { mpuAddr = addr; mpuOk = true; break; }
  }
  if (!mpuOk) { Serial.println("MPU6050 not found"); return; }
  Wire1.beginTransmission(mpuAddr); Wire1.write(0x75); Wire1.endTransmission(false);
  Wire1.requestFrom(mpuAddr, (uint8_t)1);
  Serial.printf("MPU6050 at 0x%02X, chip ID 0x%02X\n", mpuAddr, Wire1.available() ? Wire1.read() : 0);
  mpuWrite(0x6B, 0x00);   // wake up
  mpuWrite(0x1C, 0x10);   // accelerometer range +-8 g
  mpuWrite(0x1A, 0x04);   // ~21 Hz low-pass filter
}

void readMotion() {
  static unsigned long last = 0;
  if (!mpuOk || millis() - last < 20) return;   // 50 times a second
  last = millis();
  Wire1.beginTransmission(mpuAddr); Wire1.write(0x3B);   // ACCEL_XOUT_H
  if (Wire1.endTransmission(false) != 0 || Wire1.requestFrom(mpuAddr, (uint8_t)6) != 6) return;
  float ax = (int16_t)(Wire1.read() << 8 | Wire1.read()) / 4096.0;   // 4096 LSB per g at +-8 g
  float ay = (int16_t)(Wire1.read() << 8 | Wire1.read()) / 4096.0;
  float az = (int16_t)(Wire1.read() << 8 | Wire1.read()) / 4096.0;
  float total = sqrt(ax * ax + ay * ay + az * az);   // in g
  lastG = total;
  if (total < FREE_FALL_G) freeFallAt = millis();
  else if (total > IMPACT_G && freeFallAt && millis() - freeFallAt < FALL_WINDOW_MS) {
    freeFallAt = 0;
    if (!fallActive) { fallActive = true; Serial.println("FALL DETECTED"); sendNow(); }
  }
}

// =====================================================================
// DHT11 (it can only be read every 2 s)
// =====================================================================
void readClimate() {
  float t = dht.readTemperature(), h = dht.readHumidity();
  dhtOk = !isnan(t) && !isnan(h);
  if (dhtOk) { temperature = t; humidity = h; }
  else temperature = humidity = 0;
}

// =====================================================================
// SOS button + buzzer
// =====================================================================
void readButton() {
  // A press while all is clear raises SOS. A NEW press held 3 s while an alarm is on cancels it,
  // so holding the button in a panic never cancels the SOS it just sent.
  static bool wasDown = false, alarmAtPress = false, done = false;
  static unsigned long downAt = 0;
  bool down = digitalRead(SOS_PIN) == LOW;
  if (down && !wasDown) { downAt = millis(); alarmAtPress = sosActive || fallActive; done = false; }
  if (down && !done) {
    if (!alarmAtPress && millis() - downAt > 50) {   // 50 ms debounce
      sosActive = true;
      done = true;
      Serial.println("SOS PRESSED");
      sendNow();
    } else if (alarmAtPress && millis() - downAt > CANCEL_HOLD_MS) {
      clearAlerts("cancelled on the wearable");
      done = true;
    }
  }
  wasDown = down;
}

void driveBuzzer() {
  if (sosActive || fallActive) {
    bool on = (millis() % 1000) < 300;   // beep 0.3 s every second
    if (on) tone(BUZZER_PIN, 2000); else noTone(BUZZER_PIN);
  } else {
    noTone(BUZZER_PIN);
  }
}

void clearAlerts(const char *why) {
  sosActive = fallActive = false;
  noTone(BUZZER_PIN);
  Serial.printf("Alerts cleared (%s)\n", why);
  tone(BUZZER_PIN, 3000, 150);   // short confirmation chirp
  sendNow();
}

// Dashboard pressed "Dispatch help": V10 = 1 (it also writes V5/V6 = 0)
BLYNK_WRITE(V10) { if (param.asInt() == 1) clearAlerts("help dispatched"); }

// =====================================================================
// GPS
// =====================================================================
void readGps() {
  while (Serial2.available()) gps.encode(Serial2.read());
}
// The Neo-6M counts as connected while its data keeps arriving (it talks even without a fix)
bool gpsRecent() {
  static uint32_t lastChars = 0; static unsigned long lastChange = 0;
  if (gps.charsProcessed() != lastChars) { lastChars = gps.charsProcessed(); lastChange = millis(); }
  return lastChars > 0 && millis() - lastChange < 5000;   // bytes arrived in the last 5 s
}

// =====================================================================
// OLED: redrawn once a second
// =====================================================================
void setupOled() {
  oledOk = oled.begin(SSD1306_SWITCHCAPVCC, 0x3C, true, false);   // Wire is already started
  if (!oledOk) { Serial.println("OLED not found"); return; }
  oled.setTextColor(SSD1306_WHITE);
  oled.clearDisplay();
  oled.setTextSize(1);
  oled.setCursor(0, 24);
  oled.println("Smart Health Monitor");
  oled.println("Starting...");
  oled.display();
}

void drawOled() {
  if (!oledOk) return;
  oled.clearDisplay();
  oled.setTextSize(1);

  // top line: user + connection
  oled.setCursor(0, 0);
  oled.print(USER);
  const char *link = Blynk.connected() ? "Blynk OK" : WiFi.status() == WL_CONNECTED ? "Blynk..." : "No WiFi";
  oled.setCursor(128 - 6 * strlen(link), 0);
  oled.print(link);
  oled.drawFastHLine(0, 10, 128, SSD1306_WHITE);

  if (sosActive || fallActive) {   // alert screen: big inverted text
    oled.fillRect(0, 14, 128, 50, SSD1306_WHITE);
    oled.setTextColor(SSD1306_BLACK);
    oled.setTextSize(2);
    const char *what = sosActive ? "SOS!" : "FALL!";
    oled.setCursor((128 - 12 * strlen(what)) / 2, 22);
    oled.print(what);
    oled.setTextSize(1);
    oled.setCursor(10, 46);
    oled.print("Hold btn 3s=cancel");
    oled.setTextColor(SSD1306_WHITE);
    oled.display();
    return;
  }

  // heart rate + SpO2
  oled.setCursor(0, 14);  oled.print("Heart bpm");
  oled.setCursor(70, 14); oled.print("SpO2 %");
  oled.setTextSize(2);
  oled.setCursor(0, 25);  heartRate ? oled.print(heartRate) : oled.print("--");
  oled.setCursor(70, 25); spo2 ? oled.print(spo2) : oled.print("--");
  oled.setTextSize(1);

  // climate, then finger hint or GPS
  oled.setCursor(0, 44);
  if (dhtOk) oled.printf("%.1f C   %.0f %% RH", temperature, humidity);
  else oled.print("Temp: --");
  oled.setCursor(0, 55);
  if (maxOk && lastIr < FINGER_IR) oled.print("Put finger on sensor");
  else if (gps.location.isValid() && gps.location.age() < 5000) oled.printf("GPS fix, %d sats", (int)gps.satellites.value());
  else oled.print(gpsRecent() ? "GPS: searching..." : "GPS: not connected");
  oled.display();
}

// =====================================================================
// Sending to Blynk
// =====================================================================
void sendNow() {
  if (!Blynk.connected()) return;
  int sensors = (maxOk ? S_MAX : 0) | (dhtOk ? S_DHT : 0) | (mpuOk ? S_MPU : 0) | (gpsRecent() ? S_GPS : 0);
  bool fix = gps.location.isValid() && gps.location.age() < 5000;

  String status = sosActive ? String(USER) + " - SOS!" : fallActive ? String(USER) + " - fall detected" : String(USER) + " (online)";
  if (status != lastStatus) { Blynk.virtualWrite(V0, status); lastStatus = status; }
  Blynk.virtualWrite(V1, heartRate);
  Blynk.virtualWrite(V2, spo2);
  Blynk.virtualWrite(V3, temperature);
  Blynk.virtualWrite(V4, humidity);
  Blynk.virtualWrite(V5, fallActive ? 1 : 0);
  Blynk.virtualWrite(V6, sosActive ? 1 : 0);
  // sent as text with 6 decimals (~10 cm); a plain double would be rounded to 3 decimals (~100 m).
  // V12 carries "lat,lng" together because V11 is a whole-number datastream that drops the decimals.
  Blynk.virtualWrite(V11, fix ? String(gps.location.lat(), 6) : String("0"));
  Blynk.virtualWrite(V12, fix ? String(gps.location.lat(), 6) + "," + String(gps.location.lng(), 6) : String("0"));
  Blynk.virtualWrite(V13, gps.satellites.isValid() ? (int)gps.satellites.value() : 0);
  Blynk.virtualWrite(V14, sensors);
  static int beat = 0;                       // the dashboard shows "offline" once this stops changing
  Blynk.virtualWrite(V9, beat = (beat + 1) % 1000);
}

void report() {
  readClimate();
  sendNow();
  Serial.printf("HR %d  SpO2 %d  IR %lu (%s)  g %.2f  T %.1f  H %.0f  fall %d  sos %d  GPS %s sats %d  sensors %d%d%d%d  oled %d  %s\n",
    heartRate, spo2, (unsigned long)lastIr, lastIr >= FINGER_IR ? "finger" : "no finger", lastG,
    temperature, humidity, fallActive, sosActive,
    gps.location.isValid() ? "fix" : "no-fix", gps.satellites.isValid() ? (int)gps.satellites.value() : 0,
    maxOk, dhtOk, mpuOk, gpsRecent(), oledOk, Blynk.connected() ? "Blynk OK" : "Blynk offline");
}

// =====================================================================
void setup() {
  Serial.begin(115200);
  delay(500);
  pinMode(SOS_PIN, INPUT_PULLUP);
  pinMode(BUZZER_PIN, OUTPUT);

  Wire.begin(MAX_SDA, MAX_SCL);    // bus 0: MAX30102 + OLED
  Wire1.begin(MPU_SDA, MPU_SCL);   // bus 1: MPU6050
  setupOled();
  setupPulse();
  setupMotion();
  dht.begin();
  Serial2.begin(9600, SERIAL_8N1, GPS_RX, GPS_TX);

  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Blynk.config(BLYNK_AUTH_TOKEN, "blr1.blynk.cloud", 80);
  timer.setInterval(SEND_MS, report);
  timer.setInterval(1000, drawOled);

  tone(BUZZER_PIN, 2000, 200);     // start-up beep
  Serial.println("Smart Health Monitor started");
}

void loop() {
  // sensors keep running even while Wi-Fi / Blynk is down
  readPulse();
  readMotion();
  readButton();
  readGps();
  driveBuzzer();

  if (WiFi.status() == WL_CONNECTED) Blynk.run();
  timer.run();
}
