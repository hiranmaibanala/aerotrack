import math

def calculate_search_radius(speed, time):
    """Legacy fallback: simple circular radius."""
    distance = speed * time
    error_margin = distance * 0.2
    return distance + error_margin


def predict_ellipse(speed, heading_deg, time_seconds=300):
    """
    Returns elliptical search zone parameters using dead reckoning.
    speed       : m/s
    heading_deg : degrees (0 = North, clockwise)
    time_seconds: how far ahead to predict
    Returns dict with semi_major, semi_minor (metres), rotation (degrees)
    """
    distance = speed * time_seconds  # metres along heading

    # Uncertainty grows perpendicular to travel (less certain sideways)
    semi_major = distance + distance * 0.25   # along heading direction
    semi_minor = distance * 0.35              # perpendicular uncertainty

    # Minimum search zones
    semi_major = max(semi_major, 5000)
    semi_minor = max(semi_minor, 2000)

    return {
        "semi_major": round(semi_major),
        "semi_minor": round(semi_minor),
        "rotation": round(heading_deg, 2)
    }


def detect_emergency(vertical_rate, speed, altitude, prev_speed=None):
    """
    Returns alert level and reasons based on flight parameters.
    """
    alerts = []
    level = "normal"

    if vertical_rate is not None and vertical_rate < -15:
        alerts.append("Rapid descent detected")
        level = "danger"

    if altitude is not None and 0 < altitude < 500:
        alerts.append("Critically low altitude")
        level = "danger"

    if prev_speed is not None and prev_speed > 50:
        drop_pct = (prev_speed - speed) / prev_speed * 100
        if drop_pct > 40:
            alerts.append(f"Sudden speed drop ({drop_pct:.0f}%)")
            level = "danger"

    if vertical_rate is not None and vertical_rate < -8 and level == "normal":
        alerts.append("Descending rapidly")
        level = "warning"

    return {"level": level, "alerts": alerts}