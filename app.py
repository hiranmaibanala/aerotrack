from flask import Flask, jsonify, render_template, request
import os, requests, time, logging, math

app = Flask(__name__)
logging.basicConfig(level=logging.INFO)

# ── Cache & State ─────────────────────────────────────────────────
LAST_DATA   = []
CACHE       = {"data": None, "ts": 0}
CACHE_TTL   = 15
PREV_SPEEDS = {}
HISTORY     = {}
MAX_HISTORY = 60

OPENSKY_URL = "https://opensky-network.org/api/states/all"
OPENSKY_USERNAME = os.environ.get("OPENSKY_USERNAME", "hiranmaibanala")
OPENSKY_PASSWORD = os.environ.get("OPENSKY_PASSWORD", "RishiJunnia@3")
WEATHER_URL = "https://api.open-meteo.com/v1/forecast"


# ── Unit helpers ──────────────────────────────────────────────────
def heading_to_compass(deg):
    dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE",
            "S","SSW","SW","WSW","W","WNW","NW","NNW"]
    return dirs[round(deg / 22.5) % 16]

def speed_to_kmh(ms):   return round(ms * 3.6, 1)
def speed_to_knots(ms): return round(ms * 1.94384, 1)
def alt_to_ft(m):       return round(m * 3.28084)


# ── Flight phase ──────────────────────────────────────────────────
def flight_phase(alt, vr, on_ground):
    if on_ground:                      return "Ground"
    if alt is None or alt <= 0:       return "Ground"
    if alt < 1000:
        if vr is not None and vr >  2: return "Takeoff"
        if vr is not None and vr < -2: return "Landing"
        return "Low Alt"
    if vr is not None and vr >  3:    return "Climbing"
    if vr is not None and vr < -3:    return "Descending"
    return "Cruise"


# ── Emergency detection ───────────────────────────────────────────
def detect_emergency(vr, speed, alt, on_ground, prev_speed=None):
    """Strict guards — only flag genuine in-air anomalies."""
    if on_ground:
        return {"level": "normal", "alerts": []}

    alerts, level = [], "normal"

    # Rapid descent — only airborne aircraft above 1000 m
    if (vr is not None and vr != 0 and vr < -20
            and alt is not None and alt > 1000):
        alerts.append("Rapid descent detected")
        level = "danger"

    # Critically low altitude — narrow window, exclude ground
    if alt is not None and 50 < alt < 300 and not on_ground:
        alerts.append("Critically low altitude")
        level = "danger"

    # Sudden speed drop — only from cruise speeds
    if (prev_speed is not None and prev_speed > 100
            and speed is not None and prev_speed > 0):
        drop = (prev_speed - speed) / prev_speed * 100
        if drop > 50:
            alerts.append(f"Sudden speed drop ({drop:.0f}%)")
            level = "danger"

    # Fast descent warning
    if (vr is not None and vr != 0 and -20 <= vr < -12
            and alt is not None and alt > 1000
            and level == "normal"):
        alerts.append("Descending fast")
        level = "warning"

    return {"level": level, "alerts": alerts}


# ── Risk score (0–100) ────────────────────────────────────────────
def compute_risk_score(vr, speed, alt, on_ground, emergency_level):
    if on_ground: return 0
    score = 0
    if emergency_level == "danger":   score += 80
    elif emergency_level == "warning": score += 40
    if vr is not None and vr < 0:
        score += min(abs(vr) / 30 * 15, 15)
    if alt is not None and 0 < alt < 1000:
        score += (1000 - alt) / 1000 * 15
    if speed is not None and speed > 0:
        score += min(abs(speed - 230) / 230 * 10, 10)
    return round(min(score, 100), 1)


# ── Haversine ─────────────────────────────────────────────────────
def haversine_offset(lat, lon, heading_deg, distance_m):
    R  = 6371000
    hr = math.radians(heading_deg)
    dlat = (distance_m * math.cos(hr)) / R
    dlon = (distance_m * math.sin(hr)) / (R * math.cos(math.radians(lat)))
    return round(lat + math.degrees(dlat), 6), round(lon + math.degrees(dlon), 6)


# ── 3 SAR zones ───────────────────────────────────────────────────
def predict_three_zones(speed, heading_deg, t=300):
    dist_5  = speed * min(t, 300)
    dist_10 = speed * min(t * 2, 600)
    dist_20 = speed * min(t * 4, 1200)
    r1 = max(dist_5  * 0.20, 3000)
    r2 = max(dist_10 * 0.25, 6000)
    r3 = max(dist_20 * 0.35, 12000)
    return {
        "heading": round(heading_deg, 2),
        "zones": [
            {"zone":1,"label":"Zone 1 — High Probability","color":"#ff3b3b",
             "radius_m":round(r1),"dist_m":round(dist_5),"probability":"65–80%","time_min":5},
            {"zone":2,"label":"Zone 2 — Medium Probability","color":"#ffaa00",
             "radius_m":round(r2),"dist_m":round(dist_10),"probability":"15–25%","time_min":10},
            {"zone":3,"label":"Zone 3 — Low Probability","color":"#00b4ff",
             "radius_m":round(r3),"dist_m":round(dist_20),"probability":"5–10%","time_min":20},
        ]
    }


# ── Fetch with retry ──────────────────────────────────────────────
def fetch_with_retry(url, params=None, retries=3, timeout=15, auth=None):
    for attempt in range(retries):
        try:
            r = requests.get(url, params=params, timeout=timeout, auth=auth)
            if r.status_code == 200:
                return r.json()
        except Exception as e:
            logging.warning(f"Attempt {attempt+1} failed: {e}")
            time.sleep(2 ** attempt)
    return None


# ── Fetch ALL aircraft — no cap ───────────────────────────────────
def fetch_all_aircraft():
    global LAST_DATA, CACHE
    now = time.time()
    if CACHE["data"] and (now - CACHE["ts"]) < CACHE_TTL:
        return CACHE["data"]

    auth = (OPENSKY_USERNAME, OPENSKY_PASSWORD) if (OPENSKY_USERNAME and OPENSKY_PASSWORD) else None
    raw = fetch_with_retry(OPENSKY_URL, auth=auth)
    if not raw or not raw.get("states"):
        logging.warning("OpenSky returned no data — serving stale cache")
        return LAST_DATA

    aircraft_list = []
    for s in raw["states"]:
        if s[6] is None or s[5] is None:
            continue

        icao     = (s[0] or "").strip() or "unknown"
        speed    = s[9]  if s[9]  is not None else 0
        heading  = s[10] if s[10] is not None else 0
        alt      = s[7]  if s[7]  is not None else 0
        geo_alt  = s[13] if s[13] is not None else alt
        vr       = s[11]
        squawk   = s[14] or "—"
        on_gnd   = bool(s[8])
        last_ct  = s[4] or 0
        callsign = (s[1] or "").strip() or icao.upper()

        prev      = PREV_SPEEDS.get(icao)
        PREV_SPEEDS[icao] = speed

        emergency  = detect_emergency(vr, speed, alt, on_gnd, prev)
        risk_score = compute_risk_score(vr, speed, alt, on_gnd, emergency["level"])

        if icao not in HISTORY: HISTORY[icao] = []
        HISTORY[icao].append({
            "lat": s[6], "lon": s[5], "alt": alt, "spd": speed, "ts": now
        })
        if len(HISTORY[icao]) > MAX_HISTORY:
            HISTORY[icao] = HISTORY[icao][-MAX_HISTORY:]

        aircraft_list.append({
            "icao24":          icao,
            "callsign":        callsign,
            "latitude":        round(s[6], 4),
            "longitude":       round(s[5], 4),
            "velocity":        round(speed, 2),
            "velocity_kmh":    speed_to_kmh(speed),
            "velocity_knots":  speed_to_knots(speed),
            "altitude":        round(alt, 1),
            "altitude_ft":     alt_to_ft(alt),
            "geo_altitude":    round(geo_alt, 1),
            "heading":         round(heading, 2),
            "heading_compass": heading_to_compass(heading),
            "vertical_rate":   round(vr, 2) if vr is not None else 0,
            "origin_country":  s[2] or "Unknown",
            "squawk":          squawk,
            "on_ground":       on_gnd,
            "last_contact":    last_ct,
            "flight_phase":    flight_phase(alt, vr, on_gnd),
            "emergency":       emergency,
            "risk_score":      risk_score,
            "mach":            round(speed / 340.29, 3),
        })

    logging.info(
        f"Fetched {len(aircraft_list)} aircraft | "
        f"Danger: {sum(1 for a in aircraft_list if a['emergency']['level']=='danger')} | "
        f"Warning: {sum(1 for a in aircraft_list if a['emergency']['level']=='warning')}"
    )

    if aircraft_list:
        LAST_DATA = aircraft_list
        CACHE = {"data": aircraft_list, "ts": now}
    return aircraft_list


# ── Routes ────────────────────────────────────────────────────────
@app.route('/')
def home():
    return render_template("index.html")


@app.route('/get_aircraft')
def get_aircraft():
    return jsonify(fetch_all_aircraft())


@app.route('/predict_zone')
def predict_zone():
    try:
        speed   = float(request.args.get("speed", 0))
        heading = float(request.args.get("heading", 0))
        t       = int(request.args.get("time", 300))
        lat     = float(request.args.get("lat", 0))
        lon     = float(request.args.get("lon", 0))
        zones   = predict_three_zones(speed, heading, t)
        for z in zones["zones"]:
            clat, clon = haversine_offset(lat, lon, heading, z["dist_m"])
            z["center_lat"] = clat
            z["center_lon"] = clon
        return jsonify(zones)
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.route('/weather')
def weather():
    """Weather at crash zone via Open-Meteo (free, no key needed)."""
    try:
        lat = float(request.args.get("lat"))
        lon = float(request.args.get("lon"))
        params = {
            "latitude": lat, "longitude": lon,
            "current": "temperature_2m,wind_speed_10m,wind_direction_10m,visibility,weather_code,precipitation",
            "wind_speed_unit": "ms", "timezone": "auto",
        }
        data = fetch_with_retry(WEATHER_URL, params=params, timeout=10)
        if not data or "current" not in data:
            return jsonify({"error": "Weather unavailable"}), 503

        c     = data["current"]
        wcode = c.get("weather_code", 0)
        desc  = {
            0:"Clear sky",1:"Mainly clear",2:"Partly cloudy",3:"Overcast",
            45:"Foggy",48:"Icy fog",51:"Light drizzle",53:"Drizzle",
            61:"Light rain",63:"Rain",65:"Heavy rain",
            71:"Light snow",73:"Snow",75:"Heavy snow",
            80:"Rain showers",81:"Heavy showers",82:"Violent showers",
            95:"Thunderstorm",96:"Thunderstorm+hail",99:"Thunderstorm+heavy hail",
        }.get(wcode, f"Code {wcode}")

        wind_ms    = c.get("wind_speed_10m", 0) or 0
        visibility = c.get("visibility", 10000) or 10000
        sar_impact = "GOOD"
        sar_notes  = []
        if wind_ms > 25:   sar_impact = "SEVERE";    sar_notes.append(f"Extreme winds {wind_ms} m/s")
        elif wind_ms > 15: sar_impact = "DIFFICULT"; sar_notes.append(f"High winds {wind_ms} m/s")
        if visibility < 1000: sar_impact = "SEVERE"; sar_notes.append(f"Very low visibility {visibility}m")
        if wcode >= 95:    sar_impact = "SEVERE";    sar_notes.append("Thunderstorm in area")
        elif wcode in [45, 48]: sar_notes.append("Fog present")

        return jsonify({
            "temperature":      c.get("temperature_2m"),
            "wind_speed_ms":    round(wind_ms, 1),
            "wind_speed_kmh":   round(wind_ms * 3.6, 1),
            "wind_dir_deg":     c.get("wind_direction_10m"),
            "wind_dir_compass": heading_to_compass(c.get("wind_direction_10m", 0)),
            "visibility_m":     visibility,
            "precipitation":    c.get("precipitation", 0),
            "description":      desc,
            "sar_impact":       sar_impact,
            "sar_notes":        sar_notes,
        })
    except Exception as e:
        logging.error(f"Weather error: {e}")
        return jsonify({"error": str(e)}), 500


@app.route('/trail/<icao24>')
def trail(icao24):
    return jsonify({"trail": HISTORY.get(icao24.lower(), [])})


@app.route('/stats')
def stats():
    data = fetch_all_aircraft()
    if not data: return jsonify({})
    speeds    = [a["velocity"] for a in data if a["velocity"] > 0]
    altitudes = [a["altitude"] for a in data if a["altitude"] > 0]
    dangers   = [a for a in data if a["emergency"]["level"] == "danger"]
    countries = {}
    for a in data:
        countries[a["origin_country"]] = countries.get(a["origin_country"], 0) + 1
    top_countries = sorted(countries.items(), key=lambda x: -x[1])[:5]
    phases = {}
    for a in data:
        phases[a["flight_phase"]] = phases.get(a["flight_phase"], 0) + 1
    top_risk = sorted(
        [a for a in data if not a["on_ground"]],
        key=lambda x: x["risk_score"], reverse=True
    )[:5]
    return jsonify({
        "total":         len(data),
        "in_air":        sum(1 for a in data if not a["on_ground"]),
        "on_ground":     sum(1 for a in data if a["on_ground"]),
        "danger_count":  len(dangers),
        "avg_speed_ms":  round(sum(speeds)/len(speeds), 1) if speeds else 0,
        "avg_speed_kmh": round(sum(speeds)/len(speeds)*3.6, 1) if speeds else 0,
        "max_speed_ms":  round(max(speeds), 1) if speeds else 0,
        "max_speed_kmh": round(max(speeds)*3.6, 1) if speeds else 0,
        "avg_alt_m":     round(sum(altitudes)/len(altitudes), 0) if altitudes else 0,
        "max_alt_m":     round(max(altitudes), 0) if altitudes else 0,
        "max_alt_ft":    alt_to_ft(max(altitudes)) if altitudes else 0,
        "top_countries": top_countries,
        "phases":        phases,
        "top_risk":      [{"callsign": a["callsign"], "risk_score": a["risk_score"],
                           "country": a["origin_country"],
                           "alerts": a["emergency"]["alerts"]} for a in top_risk],
    })


if __name__ == '__main__':
    app.run(debug=True)
