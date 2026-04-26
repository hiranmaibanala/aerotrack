// ── CONFIG ───────────────────────────────────────────────────────
const REFRESH_MS      = 20000;
const PREDICTION_TIME = 300;
const SIDEBAR_PAGE    = 200;

// Overpass API called DIRECTLY from browser — no Flask proxy needed
// This is the key fix: browser can reach overpass-api.de, Flask server may not
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

// ── STATE ────────────────────────────────────────────────────────
let allAircraft      = [];
let filteredAircraft = [];
let markers          = {};
let trailLayers      = {};
let zoneLayers       = [];
let trajectoryLayer  = null;
let hospitalMarkers  = [];
let selectedAC       = null;
let lastZoneData     = null;
let lastHospitals    = [];
let lastWeather      = null;
let followMode       = false;
let trailVisible     = true;
let filterMode       = 'all';
let countdownVal     = REFRESH_MS / 1000;
let countdownTimer   = null;
let posHistory       = {};
let altChart         = null;
let spdChart         = null;
const markerSet      = new Set();

// ── MAP ──────────────────────────────────────────────────────────
const map = L.map('map', {
    center: [20, 10], zoom: 3,
    preferCanvas: true,
    renderer: L.canvas({ padding: 0.5 })
});
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap', keepBuffer: 2, updateWhenIdle: true
}).addTo(map);

// ── ICONS ────────────────────────────────────────────────────────
function makeIcon(color, size = 24) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${size}" height="${size}">
      <path d="M16 1 L21 13 L31 15.5 L21 18 L19 29 L16 23 L13 29 L11 18 L1 15.5 L11 13 Z"
            fill="${color}" stroke="rgba(0,0,0,0.5)" stroke-width="1"/>
    </svg>`;
    return L.divIcon({ html: svg, className: '', iconSize: [size, size], iconAnchor: [size/2, size/2] });
}

const ICON = {
    normal:   makeIcon('#00ffc8', 24),
    warning:  makeIcon('#ffaa00', 26),
    danger:   makeIcon('#ff3b3b', 28),
    selected: makeIcon('#00b4ff', 30),
    ground:   makeIcon('#4a6578', 20),
};

const hospitalIcon = L.divIcon({
    html: `<div style="background:#e53935;color:#fff;border-radius:50%;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:bold;border:2px solid #fff;box-shadow:0 0 6px rgba(0,0,0,0.5)">H</div>`,
    className: '', iconSize: [24, 24], iconAnchor: [12, 12]
});

function getIcon(ac, isSelected = false) {
    if (isSelected)   return ICON.selected;
    if (ac.on_ground) return ICON.ground;
    const lvl = (ac.emergency && ac.emergency.level) || 'normal';
    return ICON[lvl] || ICON.normal;
}

// ── RISK GAUGE ────────────────────────────────────────────────────
function drawRiskGauge(score) {
    const canvas = document.getElementById('riskGauge');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const cx = w/2, cy = h - 4, r = h - 8;
    ctx.beginPath(); ctx.arc(cx, cy, r, Math.PI, 0);
    ctx.strokeStyle = 'rgba(0,180,255,0.15)'; ctx.lineWidth = 5; ctx.stroke();
    const color = score >= 70 ? '#ff3b3b' : score >= 35 ? '#ffaa00' : '#00ffc8';
    const angle = Math.PI + (score / 100) * Math.PI;
    ctx.beginPath(); ctx.arc(cx, cy, r, Math.PI, angle);
    ctx.strokeStyle = color; ctx.lineWidth = 5; ctx.stroke();
    ctx.beginPath(); ctx.arc(cx + r * Math.cos(angle), cy + r * Math.sin(angle), 3, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();
    el('riskScoreVal').textContent = score;
    el('riskScoreVal').style.color = color;
}

// ── CHARTS ───────────────────────────────────────────────────────
function makeChart(id, label, color) {
    const ctx = document.getElementById(id).getContext('2d');
    return new Chart(ctx, {
        type: 'line',
        data: { labels: [], datasets: [{ label, data: [], borderColor: color,
            backgroundColor: color + '18', borderWidth: 1.5, pointRadius: 0,
            tension: 0.35, fill: true }] },
        options: {
            animation: false, responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { ticks: { color:'#3a5568', font:{size:8, family:'Share Tech Mono'}, maxTicksLimit:4 }, grid:{color:'rgba(0,180,255,0.05)'} },
                y: { ticks: { color:'#3a5568', font:{size:8, family:'Share Tech Mono'}, maxTicksLimit:4 }, grid:{color:'rgba(0,180,255,0.05)'} }
            }
        }
    });
}

function initCharts() {
    altChart = makeChart('altChart', 'Altitude (m)', '#00b4ff');
    spdChart = makeChart('spdChart', 'Speed (m/s)',  '#00ffc8');
}

// ── COUNTDOWN ────────────────────────────────────────────────────
function startCountdown() {
    clearInterval(countdownTimer);
    countdownVal = REFRESH_MS / 1000;
    countdownTimer = setInterval(() => {
        countdownVal--;
        el('countdown').textContent = countdownVal + 's';
        if (countdownVal <= 0) countdownVal = REFRESH_MS / 1000;
    }, 1000);
}

// ── STATUS ───────────────────────────────────────────────────────
function setStatus(state, msg = '') {
    const dot = el('statusDot');
    dot.className = 'status-dot' + (state==='online'?' online':state==='error'?' error':'');
    el('statusText').textContent = state==='online' ? 'Live' : msg || 'Loading...';
}

// ── LOAD ALL AIRCRAFT ─────────────────────────────────────────────
async function loadAircraft() {
    setStatus('loading');
    try {
        const res  = await fetch('/get_aircraft');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!Array.isArray(data) || data.length === 0) { setStatus('error','No data'); return; }

        allAircraft = data;
        const now   = Date.now();

        data.forEach(ac => {
            if (!posHistory[ac.icao24]) posHistory[ac.icao24] = [];
            posHistory[ac.icao24].push({
                lat: ac.latitude, lon: ac.longitude,
                alt: ac.altitude, spd: ac.velocity, ts: now
            });
            if (posHistory[ac.icao24].length > 60) posHistory[ac.icao24].shift();
        });

        applyFilterAndRender();
        updateTopBar(data);
        setStatus('online');
        el('lastUpdate').textContent = 'Updated ' + new Date().toLocaleTimeString();

        if (selectedAC) {
            const updated = data.find(a => a.icao24 === selectedAC.icao24);
            if (updated) showAircraft(updated, false);
        }

        setTimeout(loadStats, 800);
    } catch (e) { console.error(e); setStatus('error', 'API error'); }
}

async function loadStats() {
    try { renderRightPanel(await (await fetch('/stats')).json()); } catch(e) {}
}

// ── TOP BAR ──────────────────────────────────────────────────────
function updateTopBar(data) {
    el('totalCount').textContent = data.length.toLocaleString();
    el('inAirCount').textContent = data.filter(a => !a.on_ground).length.toLocaleString();
    const danger = data.filter(a => a.emergency?.level === 'danger').length;
    el('alertPill').style.display = danger > 0 ? 'flex' : 'none';
    el('alertCount').textContent  = danger;
}

// ── FILTER ───────────────────────────────────────────────────────
function applyFilterAndRender() {
    const q = el('searchInput').value.toLowerCase().trim();
    filteredAircraft = allAircraft.filter(ac => {
        const ms = !q
            || ac.callsign.toLowerCase().includes(q)
            || ac.origin_country.toLowerCase().includes(q)
            || ac.icao24.toLowerCase().includes(q);
        const mf =
            filterMode === 'all'    ? true :
            filterMode === 'danger' ? ac.emergency?.level === 'danger' :
            filterMode === 'air'    ? !ac.on_ground :
            filterMode === 'high'   ? ac.altitude > 9000 : true;
        return ms && mf;
    });
    renderSidebar(filteredAircraft);
    renderMarkersChunked(filteredAircraft);
}

// ── SIDEBAR ───────────────────────────────────────────────────────
function renderSidebar(list) {
    const ul   = el('aircraftList');
    const frag = document.createDocumentFragment();
    ul.innerHTML = '';

    list.slice(0, SIDEBAR_PAGE).forEach(ac => {
        const lvl = (ac.emergency && ac.emergency.level) || 'normal';
        const li  = document.createElement('li');
        li.className = 'aircraft-item'
            + (lvl === 'danger'  ? ' danger'  : '')
            + (lvl === 'warning' ? ' warning' : '')
            + (selectedAC?.icao24 === ac.icao24 ? ' selected' : '');
        li.innerHTML = `
            <div class="ac-dot"></div>
            <div class="ac-info">
                <div class="ac-callsign">${ac.callsign}</div>
                <div class="ac-detail">${ac.origin_country} · ${ac.velocity_kmh} km/h</div>
            </div>
            <div class="ac-alt">${ac.on_ground ? 'GND' : (Math.round(ac.altitude / 100) / 10) + 'km'}</div>`;
        li.onclick = () => showAircraft(ac, true);
        frag.appendChild(li);
    });

    ul.appendChild(frag);

    const note = document.createElement('li');
    note.style.cssText = 'padding:7px 10px;font-family:var(--mono);font-size:9px;color:var(--txt3);text-align:center;border-top:1px solid var(--border);margin-top:4px';
    note.textContent = list.length > SIDEBAR_PAGE
        ? `Showing ${SIDEBAR_PAGE} of ${list.length.toLocaleString()} — search to filter`
        : `${list.length.toLocaleString()} aircraft`;
    ul.appendChild(note);
}

// ── MARKERS — chunked for all flights ────────────────────────────
function renderMarkersChunked(list) {
    const CHUNK   = 500;
    const listSet = new Set(list.map(a => a.icao24));

    for (const icao of [...markerSet]) {
        if (!listSet.has(icao)) {
            if (markers[icao]) { map.removeLayer(markers[icao]); delete markers[icao]; }
            markerSet.delete(icao);
        }
    }

    let offset = 0;
    function processChunk() {
        list.slice(offset, offset + CHUNK).forEach(ac => {
            const isSel = selectedAC?.icao24 === ac.icao24;
            const icon  = getIcon(ac, isSel);
            if (markerSet.has(ac.icao24)) {
                markers[ac.icao24].setLatLng([ac.latitude, ac.longitude]);
                markers[ac.icao24].setIcon(icon);
            } else {
                const m = L.marker([ac.latitude, ac.longitude], {
                    icon, rotationAngle: ac.heading || 0, rotationOrigin: 'center center'
                }).addTo(map);
                m.bindPopup(
                    `<b style="color:#00b4ff;letter-spacing:1px">${ac.callsign}</b>` +
                    `<br/>${ac.altitude_ft.toLocaleString()} ft &middot; ${ac.velocity_kmh} km/h &middot; ${ac.heading_compass}` +
                    `<br/><span style="color:#6a8fa8;font-size:10px">${ac.origin_country} &middot; ${ac.flight_phase} &middot; Risk: ${ac.risk_score}/100</span>`,
                    { autoPan: false, maxWidth: 220 }
                );
                m.on('click', () => showAircraft(ac, true));
                markers[ac.icao24] = m;
                markerSet.add(ac.icao24);
            }
        });
        offset += CHUNK;
        if (offset < list.length) {
            requestAnimationFrame(processChunk);
        } else {
            if (trailVisible) requestAnimationFrame(() => renderTrails(list));
        }
    }
    requestAnimationFrame(processChunk);
}

// ── TRAILS ────────────────────────────────────────────────────────
function renderTrails(list) {
    const listSet = new Set(list.map(a => a.icao24));
    Object.keys(trailLayers).forEach(icao => {
        if (!listSet.has(icao)) { map.removeLayer(trailLayers[icao]); delete trailLayers[icao]; }
    });
    list.forEach(ac => {
        const hist = posHistory[ac.icao24];
        if (!hist || hist.length < 2) return;
        const color = ac.emergency?.level === 'danger' ? '#ff3b3b' : '#00b4ff';
        if (trailLayers[ac.icao24]) {
            trailLayers[ac.icao24].setLatLngs(hist.map(p => [p.lat, p.lon]));
        } else {
            trailLayers[ac.icao24] = L.polyline(
                hist.map(p => [p.lat, p.lon]),
                { color, weight: 1.5, opacity: 0.4, dashArray: '4 5' }
            ).addTo(map);
        }
    });
}

// ── SHOW AIRCRAFT ─────────────────────────────────────────────────
function showAircraft(ac, centerMap = true) {
    selectedAC = ac;
    if (centerMap) map.setView([ac.latitude, ac.longitude], 7);

    filteredAircraft.forEach(a => {
        if (markers[a.icao24]) markers[a.icao24].setIcon(getIcon(a, a.icao24 === ac.icao24));
    });

    el('panelPlaceholder').style.display = 'none';
    el('panelContent').style.display     = 'block';

    el('callsign').textContent       = ac.callsign;
    el('country').textContent        = ac.origin_country;
    el('flightPhase').textContent    = ac.flight_phase;
    el('squawk').textContent         = 'SQWK ' + (ac.squawk || '--');
    el('speed').textContent          = ac.velocity + ' m/s';
    el('speedKmh').textContent       = ac.velocity_kmh;
    el('speedKnots').textContent     = ac.velocity_knots;
    el('altitude').textContent       = ac.altitude + ' m';
    el('altFt').textContent          = ac.altitude_ft.toLocaleString();
    el('geoAlt').textContent         = ac.geo_altitude;
    el('mach').textContent           = 'M' + ac.mach;
    el('heading').textContent        = ac.heading;
    el('headingCompass').textContent = ac.heading_compass;
    el('vertRate').textContent       = (ac.vertical_rate >= 0 ? '▲ ' : '▼ ') + Math.abs(ac.vertical_rate) + ' m/s';
    el('latitude').textContent       = ac.latitude;
    el('longitude').textContent      = ac.longitude;
    el('icao').textContent           = ac.icao24.toUpperCase();
    el('groundStatus').textContent   = ac.on_ground ? '🟡 On Ground' : '🟢 Airborne';

    const lvl   = (ac.emergency && ac.emergency.level) || 'normal';
    const badge = el('riskBadge');
    badge.className   = 'info-badge' + (lvl === 'danger' ? ' danger' : lvl === 'warning' ? ' warn' : ' ok');
    badge.textContent = lvl.toUpperCase();
    drawRiskGauge(ac.risk_score || 0);

    const alertBox = el('alertBox');
    if (ac.emergency?.alerts?.length) {
        alertBox.style.display = 'block';
        alertBox.innerHTML = ac.emergency.alerts.map(a => '⚠ ' + a).join('<br/>');
        el('infoPanel').classList.add('danger-mode');
    } else {
        alertBox.style.display = 'none';
        el('infoPanel').classList.remove('danger-mode');
    }

    // Reset weather + hospitals when switching aircraft
    el('weatherBox').innerHTML   = '<div class="hosp-placeholder">Click "Fetch Weather" to get conditions</div>';
    el('weatherBtn').disabled    = false;
    el('weatherBtn').textContent = 'Fetch Weather';
    clearHospitals();
    lastHospitals = [];
    el('hospitalList').innerHTML = '<div class="hosp-placeholder">Click "Load Hospitals" to find nearest hospitals</div>';
    el('hospBtn').disabled       = false;
    el('hospBtn').textContent    = 'Load Hospitals';

    predictZones(ac);
    updateCharts(ac.icao24);

    document.querySelectorAll('.aircraft-item').forEach(li => li.classList.remove('selected'));
    const idx   = filteredAircraft.slice(0, SIDEBAR_PAGE).findIndex(a => a.icao24 === ac.icao24);
    const items = document.querySelectorAll('.aircraft-item');
    if (items[idx]) items[idx].classList.add('selected');
}

const el = id => document.getElementById(id);

// ── 3 SAR ZONES ──────────────────────────────────────────────────
async function predictZones(ac) {
    try {
        clearZones();
        const url  = `/predict_zone?speed=${ac.velocity}&heading=${ac.heading}&time=${PREDICTION_TIME}&lat=${ac.latitude}&lon=${ac.longitude}`;
        const data = await (await fetch(url)).json();
        lastZoneData = data;
        drawTrajectory(ac);

        const styles = [
            { color:'#00b4ff', fillOpacity:0.05, weight:1.5, dashArray:'8 5' },
            { color:'#ffaa00', fillOpacity:0.08, weight:2,   dashArray:'6 4' },
            { color:'#ff3b3b', fillOpacity:0.12, weight:2,   dashArray:null  },
        ];

        [2, 1, 0].forEach(i => {
            const z = data.zones[i], s = styles[i];
            const c = L.circle([z.center_lat, z.center_lon], {
                radius: z.radius_m, color: s.color, weight: s.weight,
                fillColor: s.color, fillOpacity: s.fillOpacity, dashArray: s.dashArray
            }).addTo(map);
            c.bindTooltip(`${z.label}<br/>Radius: ${(z.radius_m/1000).toFixed(1)} km  ${z.probability}`, { sticky: true });
            zoneLayers.push(c);
        });

        data.zones.forEach((z, i) => {
            const n = i + 1;
            el(`z${n}prob`).textContent   = z.probability;
            el(`z${n}radius`).textContent = (z.radius_m/1000).toFixed(1) + ' km';
            el(`z${n}dist`).textContent   = (z.dist_m/1000).toFixed(1)   + ' km';
            el(`z${n}time`).textContent   = z.time_min + ' min';
        });
    } catch(e) { console.warn('Zone error:', e); }
}

function clearZones() {
    zoneLayers.forEach(l => map.removeLayer(l)); zoneLayers = [];
    if (trajectoryLayer) { map.removeLayer(trajectoryLayer); trajectoryLayer = null; }
}

function drawTrajectory(ac) {
    const hr   = ac.heading * Math.PI / 180;
    const dist = ac.velocity * PREDICTION_TIME * 4;
    const dLat = (dist * Math.cos(hr)) / 111320;
    const dLon = (dist * Math.sin(hr)) / (111320 * Math.cos(ac.latitude * Math.PI / 180));
    trajectoryLayer = L.polyline(
        [[ac.latitude, ac.longitude], [ac.latitude + dLat, ac.longitude + dLon]],
        { color:'#ffaa00', weight:1.5, dashArray:'8 5', opacity:0.75 }
    ).addTo(map);
}

// ── WEATHER ───────────────────────────────────────────────────────
async function loadWeather() {
    if (!lastZoneData) { alert('Select an aircraft first.'); return; }
    const btn = el('weatherBtn');
    btn.disabled = true; btn.textContent = 'Fetching...';
    const zone1 = lastZoneData.zones[0];
    try {
        const data = await (await fetch(`/weather?lat=${zone1.center_lat}&lon=${zone1.center_lon}`)).json();
        lastWeather = data;
        if (data.error) {
            el('weatherBox').innerHTML = `<div class="hosp-placeholder">Weather unavailable</div>`;
            btn.textContent = 'Retry'; btn.disabled = false; return;
        }
        const ic = data.sar_impact || 'GOOD';
        const nt = data.sar_notes?.length ? `<div class="wx-notes">${data.sar_notes.join(' · ')}</div>` : '';
        el('weatherBox').innerHTML = `
            <div class="wx-grid">
                <div class="wx-cell"><div class="wx-label">TEMPERATURE</div><div class="wx-val">${data.temperature}°C</div></div>
                <div class="wx-cell"><div class="wx-label">WIND</div><div class="wx-val">${data.wind_speed_ms} m/s ${data.wind_dir_compass}</div></div>
                <div class="wx-cell"><div class="wx-label">VISIBILITY</div><div class="wx-val">${data.visibility_m >= 10000 ? '>10 km' : (data.visibility_m/1000).toFixed(1)+' km'}</div></div>
                <div class="wx-cell"><div class="wx-label">CONDITIONS</div><div class="wx-val" style="font-size:9px">${data.description}</div></div>
            </div>
            <div class="wx-impact ${ic}"><span class="wx-impact-label">SAR: ${ic}</span>${nt}</div>`;
        btn.textContent = 'Refresh'; btn.disabled = false;
    } catch(e) {
        el('weatherBox').innerHTML = '<div class="hosp-placeholder">Failed to fetch weather</div>';
        btn.textContent = 'Retry'; btn.disabled = false;
    }
}

// ── HOSPITALS — fetched DIRECTLY from browser to Overpass API ─────
// WHY: Flask server may not have internet access to Overpass.
// The browser (running on user's machine) CAN reach overpass-api.de directly.
// We try 3 radius levels: 30km → 80km → 150km
async function loadHospitals() {
    if (!selectedAC) return;
    const btn = el('hospBtn');
    btn.disabled = true;
    btn.textContent = 'Searching...';
    el('hospitalList').innerHTML = '<div class="hosp-placeholder">Searching OpenStreetMap for nearby hospitals...</div>';

    clearHospitals();
    lastHospitals = [];

    const lat = selectedAC.latitude;
    const lon = selectedAC.longitude;

    // Try increasing radii until we find results
    const radii = [30000, 80000, 150000];

    for (const radius of radii) {
        btn.textContent = `Searching ${radius/1000}km...`;

        // Overpass QL query — searches hospitals, clinics, health centres
        const query = `
[out:json][timeout:25];
(
  node["amenity"="hospital"](around:${radius},${lat},${lon});
  way["amenity"="hospital"](around:${radius},${lat},${lon});
  node["amenity"="clinic"](around:${radius},${lat},${lon});
  way["amenity"="clinic"](around:${radius},${lat},${lon});
  node["healthcare"="hospital"](around:${radius},${lat},${lon});
  way["healthcare"="hospital"](around:${radius},${lat},${lon});
);
out center 20;
`.trim();

        try {
            const resp = await fetch(OVERPASS_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: 'data=' + encodeURIComponent(query)
            });

            if (!resp.ok) {
                console.warn(`Overpass returned ${resp.status} at radius ${radius}`);
                continue;
            }

            const data = await resp.json();
            const elements = data.elements || [];

            if (elements.length === 0) {
                console.log(`No hospitals at ${radius/1000}km, trying wider...`);
                continue;
            }

            // Parse results — deduplicate by name
            const seen = new Set();
            const list = [];

            for (const e of elements) {
                const h_lat = e.lat || e.center?.lat;
                const h_lon = e.lon || e.center?.lon;
                if (!h_lat || !h_lon) continue;

                const tags = e.tags || {};
                const name = tags.name || tags['name:en'] || tags.operator || 'Hospital';
                if (seen.has(name)) continue;
                seen.add(name);

                // Haversine distance
                const dLat = (h_lat - lat) * Math.PI / 180;
                const dLon = (h_lon - lon) * Math.PI / 180;
                const a = Math.sin(dLat/2)**2
                    + Math.cos(lat * Math.PI/180) * Math.cos(h_lat * Math.PI/180)
                    * Math.sin(dLon/2)**2;
                const dist_km = Math.round(6371 * 2 * Math.asin(Math.sqrt(a)) * 10) / 10;

                list.push({
                    name,
                    lat: Math.round(h_lat * 100000) / 100000,
                    lon: Math.round(h_lon * 100000) / 100000,
                    dist_km,
                    phone: tags.phone || tags['contact:phone'] || '',
                    type:  tags.amenity || tags.healthcare || 'hospital',
                });
            }

            // Sort by distance, take top 15
            list.sort((a, b) => a.dist_km - b.dist_km);
            lastHospitals = list.slice(0, 15);

            if (lastHospitals.length === 0) {
                continue; // parsed 0 valid, try wider
            }

            // Place markers on map
            lastHospitals.forEach(h => {
                const m = L.marker([h.lat, h.lon], { icon: hospitalIcon }).addTo(map);
                m.bindPopup(
                    `<b style="color:#e53935;letter-spacing:1px">${h.name}</b>` +
                    `<br/>${h.dist_km} km from aircraft` +
                    (h.phone ? `<br/>Tel: ${h.phone}` : '') +
                    (h.type !== 'hospital' ? `<br/>Type: ${h.type}` : '')
                );
                hospitalMarkers.push(m);
            });

            // Render hospital list
            el('hospitalList').innerHTML =
                `<div class="hosp-placeholder" style="padding:3px 0 8px;font-size:8px">` +
                `${lastHospitals.length} hospitals within ${radius/1000} km of aircraft position</div>` +
                lastHospitals.map(h => `
                <div class="hosp-item">
                    <div style="display:flex;justify-content:space-between;align-items:center">
                        <div class="hosp-name" title="${h.name}">${h.name}</div>
                        <div class="hosp-dist">${h.dist_km} km</div>
                    </div>
                    <div class="hosp-meta">${h.lat.toFixed(3)}, ${h.lon.toFixed(3)}${h.phone ? ' · ' + h.phone : ''}${h.type !== 'hospital' ? ' · ' + h.type : ''}</div>
                </div>`).join('');

            btn.textContent = 'Refresh'; btn.disabled = false;
            return; // success — stop trying wider radii

        } catch(e) {
            console.error('Overpass fetch error:', e);
            // If network error, show it
            el('hospitalList').innerHTML = `<div class="hosp-placeholder">Network error: ${e.message}<br/>Check internet connection.</div>`;
            btn.textContent = 'Retry'; btn.disabled = false;
            return;
        }
    }

    // All radii tried — nothing found
    el('hospitalList').innerHTML = '<div class="hosp-placeholder">No hospitals found within 150 km — aircraft may be over ocean or very remote area</div>';
    btn.textContent = 'Retry'; btn.disabled = false;
}

function clearHospitals() {
    hospitalMarkers.forEach(m => map.removeLayer(m));
    hospitalMarkers = [];
}

// ── PDF EXPORT ────────────────────────────────────────────────────
function exportPDF() {
    if (!selectedAC) { alert('Please select an aircraft first.'); return; }
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit:'mm', format:'a4' });
    const ac  = selectedAC;
    const now = new Date().toLocaleString();
    const PW=210, ML=14, MR=196, CW=182;

    const C = {
        headerBg:[4,8,24], white:[255,255,255], blue:[0,120,200],
        bodyDark:[20,30,50], labelDark:[60,80,110], sectionBg:[230,235,245],
        rowEven:[245,247,252], rowOdd:[255,255,255],
        danger:[200,40,40], warning:[180,100,0], ok:[0,140,90],
        dangerBg:[255,235,235], warningBg:[255,248,220], okBg:[220,248,240],
    };
    const fill=(...c)=>doc.setFillColor(...c);
    const txt=(...c)=>doc.setTextColor(...c);
    const draw=(...c)=>doc.setDrawColor(...c);

    // Header
    fill(...C.headerBg); doc.rect(0,0,PW,30,'F');
    txt(...C.white); doc.setFont('helvetica','bold'); doc.setFontSize(20);
    doc.text('AEROTRACK', ML, 14);
    txt(120,180,220); doc.setFont('helvetica','normal'); doc.setFontSize(8);
    doc.text('Search & Rescue Intelligence System', ML, 20);
    txt(140,170,200); doc.setFontSize(7);
    doc.text('AIRCRAFT DETAIL REPORT  |  CONFIDENTIAL', ML, 26);
    doc.text(now, MR, 26, { align:'right' });
    fill(...C.blue); doc.rect(0,30,PW,1.5,'F');

    let y = 38;
    const lvl  = (ac.emergency && ac.emergency.level) || 'normal';
    const bClr = lvl==='danger' ? C.danger : lvl==='warning' ? [180,120,0] : C.ok;
    fill(...bClr); doc.roundedRect(ML, y-4, 28, 7, 1.5, 1.5, 'F');
    txt(...C.white); doc.setFont('helvetica','bold'); doc.setFontSize(7);
    doc.text(lvl.toUpperCase(), ML+14, y+0.5, { align:'center' });
    txt(...C.blue); doc.setFont('helvetica','bold'); doc.setFontSize(22);
    doc.text(ac.callsign, ML, y+13);
    txt(...C.labelDark); doc.setFont('helvetica','normal'); doc.setFontSize(9);
    doc.text(`${ac.origin_country}  |  ${ac.flight_phase}  |  ICAO: ${ac.icao24.toUpperCase()}  |  Risk: ${ac.risk_score}/100`, ML, y+20);
    y += 30;
    draw(200,210,230); doc.setLineWidth(0.3); doc.line(ML,y,MR,y); y += 6;

    const section = (title, sy) => {
        fill(...C.sectionBg); doc.rect(ML,sy,CW,7.5,'F');
        draw(200,210,230); doc.setLineWidth(0.3); doc.rect(ML,sy,CW,7.5,'S');
        txt(...C.blue); doc.setFont('helvetica','bold'); doc.setFontSize(8.5);
        doc.text(title, ML+3, sy+5.2);
        return sy+10;
    };

    let rowY=0, rowIdx=0;
    const startRows = sy => { rowY=sy; rowIdx=0; };
    const row = (label, value, col=0) => {
        const x=ML+col*(CW/2), w=CW/2;
        if(col===0){ fill(...(rowIdx%2===0?C.rowEven:C.rowOdd)); doc.rect(ML,rowY-3.5,CW,8,'F'); rowIdx++; }
        txt(...C.labelDark); doc.setFont('helvetica','normal'); doc.setFontSize(8);
        doc.text(label+':', x+2, rowY+1);
        txt(...C.bodyDark); doc.setFont('helvetica','bold'); doc.setFontSize(9);
        doc.text(String(value ?? '--'), x+w*0.48, rowY+1);
        if(col===1) rowY+=8;
    };

    y = section('FLIGHT PARAMETERS', y); startRows(y);
    row('Speed (m/s)',   `${ac.velocity} m/s`,                     0); row('Speed (km/h)',  `${ac.velocity_kmh} km/h`,              1);
    row('Speed (knots)',`${ac.velocity_knots} kts`,                 0); row('Mach',          `M ${ac.mach}`,                         1);
    row('Altitude (m)', `${ac.altitude} m`,                         0); row('Altitude (ft)', `${ac.altitude_ft.toLocaleString()} ft`,1);
    row('Geo Altitude', `${ac.geo_altitude} m`,                     0); row('Vertical Rate', `${ac.vertical_rate} m/s`,              1);
    row('Heading',      `${ac.heading}deg (${ac.heading_compass})`, 0); row('Flight Phase',  ac.flight_phase,                        1);
    row('Latitude',     `${ac.latitude}`,                           0); row('Longitude',     `${ac.longitude}`,                      1);
    row('ICAO24',       ac.icao24.toUpperCase(),                    0); row('Squawk',        ac.squawk,                              1);
    row('Status',       ac.on_ground?'On Ground':'Airborne',        0); row('Country',       ac.origin_country,                      1);
    row('Risk Score',   `${ac.risk_score}/100`,                     0); row('Last Contact',  ac.last_contact ? new Date(ac.last_contact*1000).toLocaleTimeString() : '--', 1);
    y = rowY + 8;

    y = section('EMERGENCY STATUS', y);
    if(ac.emergency?.alerts?.length){
        ac.emergency.alerts.forEach(alert => {
            fill(...C.dangerBg); doc.rect(ML,y-3,CW,7,'F');
            txt(...C.danger); doc.setFont('helvetica','bold'); doc.setFontSize(8.5);
            doc.text('WARNING: '+alert, ML+3, y+1); y+=8;
        });
    } else {
        fill(...C.okBg); doc.rect(ML,y-3,CW,7,'F');
        txt(...C.ok); doc.setFont('helvetica','bold'); doc.setFontSize(8.5);
        doc.text('No emergency conditions detected', ML+3, y+1); y+=8;
    }
    y+=6;

    if(lastWeather && !lastWeather.error && y < 235){
        y = section('WEATHER AT CRASH ZONE', y);
        fill(...C.rowEven); doc.rect(ML,y-3,CW,22,'F');
        txt(...C.bodyDark); doc.setFont('helvetica','normal'); doc.setFontSize(8.5);
        doc.text(`Conditions: ${lastWeather.description}`, ML+3, y+2);
        doc.text(`Temperature: ${lastWeather.temperature}C`, ML+3, y+9);
        doc.text(`Wind: ${lastWeather.wind_speed_ms} m/s from ${lastWeather.wind_dir_compass}`, ML+70, y+9);
        doc.text(`Visibility: ${lastWeather.visibility_m>=10000?'>10 km':(lastWeather.visibility_m/1000).toFixed(1)+' km'}`, ML+3, y+16);
        const sarClr = lastWeather.sar_impact==='SEVERE'?C.danger:lastWeather.sar_impact==='DIFFICULT'?C.warning:C.ok;
        txt(...sarClr); doc.setFont('helvetica','bold');
        doc.text(`SAR: ${lastWeather.sar_impact}${lastWeather.sar_notes?.length?' | '+lastWeather.sar_notes.join(', '):''}`, ML+90, y+16);
        y+=28;
    }

    if(lastZoneData?.zones){
        if(y>230){ doc.addPage(); y=20; }
        y = section('PREDICTED SAR SEARCH ZONES (Dead Reckoning + Haversine)', y);
        const zColors=[C.danger, C.warning, C.blue];
        const zBg=[C.dangerBg, C.warningBg, [220,235,255]];
        const zNames=['Zone 1 HIGH Probability','Zone 2 MEDIUM Probability','Zone 3 LOW Probability'];
        lastZoneData.zones.forEach((z,i) => {
            if(y>265){ doc.addPage(); y=20; }
            fill(...zBg[i]); doc.rect(ML,y-3,CW,22,'F');
            fill(...zColors[i]); doc.rect(ML,y-3,2.5,22,'F');
            txt(...zColors[i]); doc.setFont('helvetica','bold'); doc.setFontSize(9);
            doc.text(zNames[i], ML+6, y+2);
            txt(...C.bodyDark); doc.setFont('helvetica','normal'); doc.setFontSize(8);
            doc.text(`Probability: ${z.probability}`, ML+6, y+9);
            doc.text(`Radius: ${(z.radius_m/1000).toFixed(1)} km`, ML+65, y+9);
            doc.text(`Distance: ${(z.dist_m/1000).toFixed(1)} km`, ML+120, y+9);
            doc.text(`T+${z.time_min} min`, ML+170, y+9);
            doc.text(`Centre: Lat ${z.center_lat}  Lon ${z.center_lon}`, ML+6, y+16);
            y+=26;
        });
    }

    if(lastHospitals.length > 0){
        if(y>245){ doc.addPage(); y=20; }
        y = section('NEARBY HOSPITALS', y);
        lastHospitals.forEach((h,i) => {
            if(y>275){ doc.addPage(); y=20; }
            fill(...(i%2===0?[255,240,240]:C.rowOdd)); doc.rect(ML,y-3,CW,14,'F');
            fill(...C.danger); doc.circle(ML+4,y+3.5,3.5,'F');
            txt(...C.white); doc.setFont('helvetica','bold'); doc.setFontSize(7);
            doc.text('H', ML+4, y+4.5, { align:'center' });
            txt(...C.bodyDark); doc.setFont('helvetica','bold'); doc.setFontSize(9);
            doc.text(h.name, ML+11, y+2);
            txt(...C.labelDark); doc.setFont('helvetica','normal'); doc.setFontSize(7.5);
            doc.text(`Distance: ${h.dist_km} km`, ML+11, y+8);
            doc.text(`Coords: ${h.lat}, ${h.lon}`, ML+55, y+8);
            if(h.phone) doc.text(`Tel: ${h.phone}`, ML+115, y+8);
            y+=17;
        });
    }

    const pages = doc.internal.getNumberOfPages();
    for(let i=1; i<=pages; i++){
        doc.setPage(i);
        fill(...C.headerBg); doc.rect(0,287,PW,10,'F');
        txt(140,170,200); doc.setFont('helvetica','normal'); doc.setFontSize(7);
        doc.text('AEROTRACK — Search & Rescue Intelligence System  |  Confidential SAR Report', ML, 293);
        doc.text(`Page ${i} of ${pages}`, MR, 293, { align:'right' });
    }
    doc.save(`AEROTRACK_${ac.callsign.replace(/\s/g,'_')}_${Date.now()}.pdf`);
}

// ── CHARTS UPDATE ─────────────────────────────────────────────────
function updateCharts(icao24) {
    const hist = posHistory[icao24];
    if (!hist || hist.length === 0) return;
    const labels = hist.map(p => new Date(p.ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'}));
    altChart.data.labels = spdChart.data.labels = labels;
    altChart.data.datasets[0].data = hist.map(p => p.alt);
    spdChart.data.datasets[0].data = hist.map(p => p.spd);
    altChart.update('none');
    spdChart.update('none');
}

// ── RIGHT PANEL ───────────────────────────────────────────────────
function renderRightPanel(s) {
    if (!s || !s.total) return;
    el('gsAvgSpeed').textContent    = s.avg_speed_ms;
    el('gsAvgSpeedKmh').textContent = s.avg_speed_kmh + ' km/h';
    el('gsMaxSpeed').textContent    = s.max_speed_ms;
    el('gsMaxSpeedKmh').textContent = s.max_speed_kmh + ' km/h';
    el('gsAvgAlt').textContent      = (s.avg_alt_m/1000).toFixed(1) + 'km';
    el('gsMaxAlt').textContent      = 'max ' + (s.max_alt_m/1000).toFixed(1) + 'km';
    el('gsDanger').textContent      = s.danger_count;

    if(s.top_risk?.length){
        el('topRiskList').innerHTML = s.top_risk.map(a => {
            const clr = a.risk_score>=70?'#ff3b3b':a.risk_score>=35?'#ffaa00':'#00ffc8';
            return `<div class="mt-row">
                <span class="mt-callsign">${a.callsign}</span>
                <span class="mt-country">${a.country}</span>
                <span class="mt-risk" style="color:${clr};border:1px solid ${clr}22">${a.risk_score}</span>
            </div>`;
        }).join('');
    }

    const maxPh = Math.max(...Object.values(s.phases||{}), 1);
    const pC = {Cruise:'#00b4ff',Climbing:'#00ffc8',Descending:'#ffaa00',Takeoff:'#ff8800',Landing:'#ff3b3b',Ground:'#4a6578','Low Alt':'#888'};
    el('phaseList').innerHTML = Object.entries(s.phases||{}).sort((a,b)=>b[1]-a[1]).map(([ph,cnt]) =>
        `<div class="phase-row">
            <div class="phase-name">${ph}</div>
            <div class="phase-bar-bg"><div class="phase-bar" style="width:${(cnt/maxPh*100).toFixed(1)}%;background:${pC[ph]||'#00b4ff'}"></div></div>
            <div class="phase-count">${cnt}</div>
        </div>`).join('');

    const maxCt = s.top_countries.length ? s.top_countries[0][1] : 1;
    el('countryList').innerHTML = s.top_countries.map(([n,c]) =>
        `<div class="country-row">
            <div class="country-name">${n}</div>
            <div class="country-bar-bg"><div class="country-bar" style="width:${(c/maxCt*100).toFixed(1)}%"></div></div>
            <div class="country-count">${c}</div>
        </div>`).join('');

    el('fastestList').innerHTML = [...allAircraft].sort((a,b)=>b.velocity-a.velocity).slice(0,5).map(a =>
        `<div class="mt-row"><span class="mt-callsign">${a.callsign}</span><span class="mt-country">${a.origin_country}</span><span class="mt-val">${a.velocity_kmh} km/h</span></div>`).join('');

    el('highestList').innerHTML = [...allAircraft].sort((a,b)=>b.altitude-a.altitude).slice(0,5).map(a =>
        `<div class="mt-row"><span class="mt-callsign">${a.callsign}</span><span class="mt-country">${a.origin_country}</span><span class="mt-val">${a.altitude_ft.toLocaleString()} ft</span></div>`).join('');
}

// ── CONTROLS ──────────────────────────────────────────────────────
function toggleFollow() {
    followMode = !followMode;
    const btn = el('followBtn');
    btn.textContent = followMode ? '⏸ UNFOLLOW' : '▶ FOLLOW';
    btn.classList.toggle('active', followMode);
}
function toggleTrail() {
    trailVisible = !trailVisible;
    Object.values(trailLayers).forEach(l => trailVisible ? map.addLayer(l) : map.removeLayer(l));
    document.querySelector('.btn-trail').classList.toggle('active', trailVisible);
}
function setFilter(mode, btn) {
    filterMode = mode;
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    applyFilterAndRender();
}
function filterAircraft() { applyFilterAndRender(); }

// ── INIT ──────────────────────────────────────────────────────────
function init() {
    initCharts();
    loadAircraft();
    startCountdown();
    setInterval(() => {
        loadAircraft();
        startCountdown();
        if (followMode && selectedAC) {
            const u = allAircraft.find(a => a.icao24 === selectedAC.icao24);
            if (u) map.setView([u.latitude, u.longitude], map.getZoom());
        }
    }, REFRESH_MS);
}

init();