"""Draws the Shelf app icon (a bold brand-red ring on white) as PNGs, no libraries needed.

Run from the repo root:  python3 tools/make_icons.py
"""
import math, os, struct, zlib

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


# Brand red (the app's accent colour, #fa2d48)
RED = (0xFA / 255, 0x2D / 255, 0x48 / 255)
WHITE = (1.0, 1.0, 1.0)
RING_RADIUS = 0.24   # centre line of the ring, as a share of the icon width
RING_WIDTH = 0.14    # thick stroke: the hole is about half the ring's outer size


def colour(u, v):
    """Colour at a point in the unit square (0..1): a bold red ring on white."""
    r = math.hypot(u - 0.5, v - 0.5)
    return RED if abs(r - RING_RADIUS) <= RING_WIDTH / 2 else WHITE


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
        png(os.path.join(OUT, name), size, size, render(size, 3 if size >= 512 else 4))
        print("wrote", name)
