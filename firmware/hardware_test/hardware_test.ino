// =====================================================================
//  Hardware test – checks every part of the wearable and prints the result.
//  Open Serial Monitor at 115200 baud after uploading.
//
//  Wiring (ESP32 DevKit 30-pin):
//    MAX30102  SDA -> D21   SCL -> D22   VIN -> 3V3   GND -> GND
//    MPU6050   SDA -> D32   SCL -> D33   VCC -> VIN   GND -> GND
//    DHT11     DATA -> D4                VCC -> 3V3   GND -> GND
//    Neo-6M    TX -> RX2 (16)  RX -> TX2 (17)  VCC -> VIN  GND -> GND
//    SOS button  one leg -> D27, other leg -> GND
//    Buzzer      + -> D25, - -> GND
//
//  Needs the "DHT sensor library" by Adafruit.
// =====================================================================
#include <Wire.h>
#include <DHT.h>

#define MAX_SDA 21
#define MAX_SCL 22
#define MPU_SDA 32
#define MPU_SCL 33
#define DHT_PIN 4
#define GPS_RX 16   // ESP32 receives here (Neo-6M TX)
#define GPS_TX 17   // ESP32 sends here (Neo-6M RX)
#define SOS_PIN 27
#define BUZZER_PIN 25

DHT dht(DHT_PIN, DHT11);

bool found(TwoWire &bus, uint8_t addr) {
  bus.beginTransmission(addr);
  return bus.endTransmission() == 0;
}

void scan(TwoWire &bus, const char *name) {
  Serial.printf("  %s bus devices:", name);
  int n = 0;
  for (uint8_t a = 1; a < 127; a++) {
    if (found(bus, a)) { Serial.printf(" 0x%02X", a); n++; }
  }
  Serial.println(n ? "" : " none");
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Wire.begin(MAX_SDA, MAX_SCL);   // bus 0: MAX30102
  Wire1.begin(MPU_SDA, MPU_SCL);  // bus 1: MPU6050
  dht.begin();
  Serial2.begin(9600, SERIAL_8N1, GPS_RX, GPS_TX);
  pinMode(SOS_PIN, INPUT_PULLUP);
  pinMode(BUZZER_PIN, OUTPUT);
  tone(BUZZER_PIN, 2000, 300);    // short beep at start: the buzzer is wired correctly
  Serial.println("\n=== Wearable hardware test ===");
}

unsigned long gpsBytes = 0;
String gpsLine;
String lastNmea;

void loop() {
  // keep reading the GPS between reports so nothing is missed
  unsigned long until = millis() + 3000;
  bool pressedSinceReport = false;
  while (millis() < until) {
    // buzzer sounds while the SOS button is held
    if (digitalRead(SOS_PIN) == LOW) { tone(BUZZER_PIN, 2000); pressedSinceReport = true; }
    else noTone(BUZZER_PIN);
    while (Serial2.available()) {
      char c = Serial2.read();
      gpsBytes++;
      if (c == '\n') { if (gpsLine.startsWith("$GPGGA") || gpsLine.startsWith("$GPRMC")) lastNmea = gpsLine; gpsLine = ""; }
      else if (c != '\r' && gpsLine.length() < 120) gpsLine += c;
    }
  }

  Serial.println("\n----------------------------------------");
  scan(Wire, "MAX30102 (D21/D22)");
  scan(Wire1, "MPU6050  (D32/D33)");

  bool maxOk = found(Wire, 0x57);
  bool mpuOk = found(Wire1, 0x68) || found(Wire1, 0x69);
  Serial.printf("MAX30102 : %s\n", maxOk ? "OK (0x57)" : "NOT FOUND - check SDA->D21, SCL->D22, VIN->3V3, GND");
  Serial.printf("MPU6050  : %s\n", mpuOk ? "OK (0x68)" : "NOT FOUND - check SDA->D32, SCL->D33, VCC->VIN, GND");

  float t = dht.readTemperature(), h = dht.readHumidity();
  if (isnan(t) || isnan(h)) Serial.println("DHT11    : NOT READING - check DATA->D4, VCC->3V3, GND");
  else Serial.printf("DHT11    : OK  %.1f C, %.0f %%\n", t, h);

  if (gpsBytes == 0) Serial.println("Neo-6M   : NO DATA - check TX->RX2(16), RX->TX2(17), VCC->VIN, GND");
  else {
    Serial.printf("Neo-6M   : OK, receiving data (%lu bytes so far)\n", gpsBytes);
    if (lastNmea.length()) Serial.println("           " + lastNmea);
    Serial.println("           (a fix needs open sky; until then the numbers above stay empty)");
  }

  Serial.printf("SOS button: %s\n", pressedSinceReport ? "PRESSED (the buzzer should have beeped)" : "not pressed (hold it to test the buzzer)");
}
