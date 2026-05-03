# ✈ AEROTRACK
### Real-Time Aircraft Search and Rescue Area Prediction System

> **Tracks 6,000+ live flights globally · Predicts SAR zones in under 50ms · Emergency detection · Weather · Hospitals · PDF Export**

---

## 🌐 Live Demo
🔗 **[aerotrack.onrender.com](https://aerotrack.onrender.com)**  
*(Free tier — may take 30 seconds to wake up on first visit)*

---

## 📌 What is AEROTRACK?

AEROTRACK is a real-time aviation monitoring and Search & Rescue (SAR) decision support system. It ingests live ADS-B telemetry from every aircraft flying globally, detects emergency flight conditions automatically, and generates three probabilistic SAR search zones within **50 milliseconds** of aircraft selection — reducing the traditional 15–30 minute manual zone calculation to under one second.

Built for academic demonstration and real-world SAR applicability using only free APIs, no paid services, and no database.

---

## 🖼 Screenshots

| Live Dashboard | SAR Zone Prediction |
|---|---|
| 6,000+ aircraft tracked globally on dark map | 3 circular zones — red, amber, blue |

| Aircraft Detail Panel | PDF SAR Report |
|---|---|
| Full telemetry + risk gauge | Formatted A4 briefing with zones + hospitals |

---

## ⚡ Key Features

### 🛩 Real-Time Aircraft Tracking
- Tracks **all live aircraft globally** (6,000–9,000 simultaneously) via OpenSky Network API
- 20-second refresh with 15-second server-side caching
- Exponential backoff retry — system never crashes on API failure
- Color-coded markers: 🟢 Normal · 🟡 Ground · 🟠 Warning · 🔴 Danger
- Flight trail rendering showing position history on the map
- Search and filter by callsign, country, ICAO code

### 🎯 3-Zone SAR Prediction
- **Zone 1 (Red)** — T+5 min projection · 65–80% probability
- **Zone 2 (Amber)** — T+10 min projection · 15–25% probability
- **Zone 3 (Blue)** — T+20 min projection · 5–10% probability
- Calculated using **Dead Reckoning + Haversine Formula**
- Trajectory line showing exact heading direction
- Results in under **50 milliseconds**

### 🚨 Emergency Detection
Automatically monitors every aircraft every refresh cycle:
| Condition | Threshold | Alert Level |
|---|---|---|
| Rapid Descent | Vertical rate < -20 m/s (above 1000m) | 🔴 DANGER |
| Critically Low Altitude | 50m < altitude < 300m (airborne) | 🔴 DANGER |
| Sudden Speed Drop | >50% drop from cruise speed (>100 m/s) | 🔴 DANGER |
| Fast Descent | Vertical rate -12 to -20 m/s | 🟠 WARNING |

*Ground aircraft are completely excluded — zero false positives from parked planes.*

### 📊 Risk Score (0–100)
Composite score per aircraft combining:
- Emergency level base (0 / 40 / 80)
- Vertical rate severity (up to 15 pts)
- Altitude floor proximity (up to 15 pts)
- Speed deviation from cruise (up to 10 pts)

Displayed as a live semicircular gauge — green → amber → red.

### 🌤 Weather at Crash Zone
- Live conditions at Zone 1 centre via Open-Meteo API (free, no key)
- Temperature · Wind speed/direction · Visibility · Precipitation
- **SAR Impact Rating**: GOOD / DIFFICULT / SEVERE
- Helicopter operation safety assessment

### 🏥 Nearest Hospitals
- Direct browser query to OpenStreetMap Overpass API
- Searches within 30km → 80km → 150km progressively
- Hospital markers placed on map
- Name · Distance · Coordinates · Phone number

### 📄 PDF SAR Report Export
One-click A4 briefing document containing:
- Aircraft identity + risk badge
- Complete flight parameters table
- Emergency status
- Weather at crash zone
- All 3 SAR zones with exact coordinates + probability
- Nearby hospital list with distances

### 📈 Analytics Dashboard (Right Panel)
- Global avg/max speed and altitude
- Top 5 highest-risk aircraft
- Flight phase breakdown (Cruise / Climbing / Descending / Takeoff / Landing / Ground)
- Top 5 countries by aircraft count
- Live altitude and speed charts for selected aircraft
- Top 5 fastest and highest aircraft

### 🗺 Map Features
- Dark aviation-themed Leaflet.js map
- Canvas renderer — handles 9,000+ markers without freezing
- Follow Mode — map auto-centers on selected aircraft every refresh
- Trail Toggle — show/hide flight path history
- Interactive popups on every marker

---

## 🧠 Algorithms Used

| # | Algorithm | Purpose |
|---|---|---|
| 1 | **Dead Reckoning** | Projects future position using speed × time |
| 2 | **Haversine Formula** | Converts distance to accurate lat/lon on curved Earth |
| 3 | **Threshold Anomaly Detection** | Flags emergency conditions with 4 parameter checks |
| 4 | **Exponential Backoff** | Reliable API retry — waits 1s, 2s, 4s between attempts |
| 5 | **Composite Risk Scoring** | Ranks all aircraft by danger level (0–100) |
| 6 | **Unit Conversions** | Speed in m/s · km/h · knots · Mach simultaneously |

---

## 🛠 Technology Stack

### Backend
| Technology | Purpose |
|---|---|
| Python 3 | Core backend language |
| Flask | REST API framework — 5 routes |
| requests | HTTP client with retry logic |

### Frontend
| Technology | Purpose |
|---|---|
| HTML + CSS + JavaScript | Core web stack (no React/Angular) |
| Leaflet.js | Interactive map engine with Canvas renderer |
| Chart.js | Live altitude and speed line charts |
| jsPDF | Client-side PDF report generation |
| leaflet-rotatedmarker | Heading-aligned aircraft icons |

### External APIs (all free, no API key required)
| API | Data Provided |
|---|---|
| OpenSky Network | Live ADS-B telemetry for all global flights |
| Open-Meteo | Real-time weather at crash zone coordinates |
| OpenStreetMap Overpass | Nearby hospital search |
| OSM Tile Server | Map background tiles |

---

## 📁 Project Structure

```
AEROTRACK/
│
├── app.py                 # Flask backend — all routes, API fetch, detection, scoring
├── prediction.py          # Algorithm functions — dead reckoning, Haversine, zones
├── requirements.txt       # Python dependencies
├── Procfile               # Deployment start command
│
├── templates/
│   └── index.html         # Dashboard layout — 3-panel structure
│
└── static/
    ├── style.css          # Dark aviation theme — CSS variables, all component styles
    └── script.js          # All frontend logic — map, markers, charts, hospitals, PDF
```

---

## 🚀 Run Locally

**Prerequisites:** Python 3.8+, pip, modern browser (Chrome / Firefox / Edge)

```bash
# 1. Clone the repository
git clone https://github.com/hiranmaibanala/aerotrack.git
cd aerotrack

# 2. Install dependencies
pip install flask requests

# 3. Start the server
python app.py

# 4. Open in browser
# Go to http://127.0.0.1:5000
```

The dashboard loads automatically and begins fetching live aircraft data. Internet connection required for OpenSky API, weather, map tiles, and hospital search.

---

## 🔌 API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/` | GET | Serves the main HTML dashboard |
| `/get_aircraft` | GET | Returns all live aircraft as JSON array |
| `/predict_zone` | GET | Computes 3 SAR zones for given speed/heading/lat/lon |
| `/weather` | GET | Fetches weather at given coordinates |
| `/trail/<icao24>` | GET | Returns position history for one aircraft |
| `/stats` | GET | Returns global fleet statistics |

---

## 📊 Performance

| Metric | Result |
|---|---|
| Aircraft tracked simultaneously | 6,000 – 9,000 |
| SAR zone calculation time | < 50 milliseconds |
| Emergency detection cycle | Every 20 seconds |
| API failure recovery | Transparent — serves cached data |
| PDF generation | < 1 second (client-side) |
| Map render for 9,000+ markers | Smooth via Canvas + chunked RAF |
| Manual method comparison | 15–30 min → under 1 second |

---

## 🔮 Future Scope

- **Kalman Filter** — smoother position estimation with measurement noise correction
- **ML Risk Classification** — trained on ASRS accident data for calibrated probability
- **WebSocket Push** — real-time updates replacing 20-second polling
- **Terrain Integration** — refine zones based on mountain/ocean/coastal terrain
- **Mobile Responsive** — tablet/phone layout for field SAR coordinators
- **SAROPS Export** — XML zone files for official international SAR systems
- **Historical Playback** — replay aircraft behaviour before an incident

---

## 👥 Team

| Name | Role |
|---|---|
| B. Hiranmai | Backend development, Algorithm design |
| C. Rishitha Reddy | Frontend development, UI/UX design |
| S. Jennifer Shalom | API integration, Testing |

**Guide:** N. Shiva Kumar  
**Department:** B.Tech Information Technology  
**Academic Year:** 2025–2026

---

## 📄 License

This project is developed for academic purposes.  
Free to use for educational and non-commercial applications.

---

## ⭐ If this project helped you, give it a star!

```
AEROTRACK — Because in search and rescue, every second counts.
```
