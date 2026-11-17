"""Draws the Shelf app icon (an iridescent CD on a charcoal tile) as PNGs, no libraries needed.

Run from the repo root:  python3 tools/make_icons.py
"""
import colorsys, math, os, struct, zlib

OUT = os.path.join(os.path.dirname(__file__), "..", "icons")


def png(path, w, h, rgb_rows):
    raw = b"".join(b"\x00" + bytes(row) for row in rgb_rows)
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
    data += chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(data)


def mix(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


def colour(u, v):
    """Colour at a point in the unit square (0..1), as floats 0..1."""
    dx, dy = u - 0.5, v - 0.5
    r = math.hypot(dx, dy)
    # charcoal tile, a touch lighter in the middle
    bg = mix((0.20, 0.20, 0.22), (0.08, 0.08, 0.09), min(1, r / 0.72))

    R_OUT, R_CLEAR, R_HUB, R_HOLE = 0.355, 0.125, 0.085, 0.042
    if r > R_OUT or r < R_HOLE:
        return bg
    ang = math.atan2(dy, dx)
    if r < R_HUB:  # clear plastic hub
        return mix(bg, (0.82, 0.84, 0.87), 0.70)
    if r < R_CLEAR:  # transparent inner ring with a faint edge
        edge = 1 if (r - R_HUB) < 0.004 or (R_CLEAR - r) < 0.004 else 0
        return mix(mix(bg, (0.80, 0.82, 0.86), 0.42), (0.92, 0.93, 0.95), 0.5 * edge)
    # data surface: silver with a soft rainbow that repeats round the disc
    hue = ((ang / (2 * math.pi)) * 2 + 0.55) % 1
    rainbow = colorsys.hls_to_rgb(hue, 0.70, 0.55)
    silver = (0.80, 0.81, 0.84)
    base = mix(silver, rainbow, 0.55)
    # two bright light streaks, like a lamp reflecting off the disc
    streak = max(math.cos(ang - 0.9) ** 2, math.cos(ang - 0.9 + math.pi) ** 2) ** 14
    base = mix(base, (1, 1, 1), 0.75 * streak)
    # faint concentric grooves
    base = mix(base, (0.62, 0.64, 0.68), 0.06 * (0.5 + 0.5 * math.sin(r * 900)))
    # darker rim at the outer edge
    if R_OUT - r < 0.006:
        base = mix(base, (0.45, 0.46, 0.50), 0.6)
    return base


def render(size, ss=3):
    rows = []
    for y in range(size):
        row = []
        for x in range(size):
            acc = [0.0, 0.0, 0.0]
            for j in range(ss):
                for i in range(ss):
                    c = colour((x + (i + 0.5) / ss) / size, (y + (j + 0.5) / ss) / size)
                    acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]
            n = ss * ss
            row += [max(0, min(255, round(a / n * 255))) for a in acc]
        rows.append(row)
    return rows


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for name, size in [("icon-512.png", 512), ("icon-192.png", 192), ("apple-touch-icon.png", 180), ("favicon-32.png", 32)]:
        png(os.path.join(OUT, name), size, size, render(size, 2 if size >= 512 else 3))
        print("wrote", name)
