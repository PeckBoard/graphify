// The path diagram renderer, as Python source.
//
// `graphify_path` answers with a hop chain; this draws that chain as a PNG so
// the chat shows the route instead of a wall of JSON. It is inlined into
// `PYTHON_DRIVER` (driver.ts) and loaded on its own by the unit tests, so it
// imports nothing from the driver and nothing from outside the standard
// library: zlib writes the IDAT stream and everything above it — antialiased
// lines, radial glows, a 5x7 bitmap font — is arithmetic on a byte buffer.
// Rendering with matplotlib was the obvious alternative and is the wrong one:
// it is only ever in the plugin's venv by accident, as a graspologic
// dependency, and a diagram the agent sometimes gets is worse than none.
//
// The look is a constellation: the path is a lit polyline zig-zagging across a
// dim field of the graph it was pulled out of. That field is decorative — it is
// laid out by a seeded LCG, not from real neighbours — so the picture stays
// deterministic for a given query while still reading as "part of a graph".

export const PATH_IMAGE_PY = `"""Render a graphify_path result as a PNG, using only the standard library."""
import base64
import math
import struct
import zlib

# 5x7 glyphs for ASCII 32..126: five columns a character, one hex byte a
# column, bit N of a column = row N counting from the top. The classic
# fixed-width console font, with 'g' redrawn -- its bowl collapses into its
# tail at this size, and identifiers are full of it. Anything outside the
# range is drawn as '?'.
FONT_5X7 = (
    "0000000000" "00005f0000" "0007000700" "147f147f14" "242a7f2a12"  # sp ! " # $
    "2313086462" "3649552250" "0005030000" "001c224100" "0041221c00"  # % & ' ( )
    "14083e0814" "08083e0808" "0050300000" "0808080808" "0060600000"  # * + , - .
    "2010080402" "3e5149453e" "00427f4000" "4261514946" "2141454b31"  # / 0 1 2 3
    "1814127f10" "2745454539" "3c4a494930" "0171090503" "3649494936"  # 4 5 6 7 8
    "064949291e" "0036360000" "0056360000" "0008142241" "1414141414"  # 9 : ; < =
    "4122140800" "0201510906" "324979413e" "7e1111117e" "7f49494936"  # > ? @ A B
    "3e41414122" "7f4141221c" "7f49494941" "7f09090101" "3e41415132"  # C D E F G
    "7f0808087f" "00417f4100" "2040413f01" "7f08142241" "7f40404040"  # H I J K L
    "7f0204027f" "7f0408107f" "3e4141413e" "7f09090906" "3e4151215e"  # M N O P Q
    "7f09192946" "4649494931" "01017f0101" "3f4040403f" "1f2040201f"  # R S T U V
    "7f2018207f" "6314081463" "0304780403" "6151494543" "00007f4141"  # W X Y Z [
    "0204081020" "41417f0000" "0402010204" "4040404040" "0001020400"  # \\ ] ^ _ \`
    "2054545478" "7f48444438" "3844444420" "384444487f" "3854545418"  # a b c d e
    "087e090102" "485454543c" "7f08040478" "00447d4000" "2040443d00"  # f g h i j
    "007f102844" "00417f4000" "7c04180478" "7c08040478" "3844444438"  # k l m n o
    "7c14141408" "081414187c" "7c08040408" "4854545420" "043f444020"  # p q r s t
    "3c4040207c" "1c2040201c" "3c4030403c" "4428102844" "0c5050503c"  # u v w x y
    "4464544c44" "0008364100" "00007f0000" "0041360800" "08082a1c08"  # z { | } ~
)

GLYPH_W = 5
GLYPH_H = 7
CELL_W = 6  # one blank column of tracking after each glyph

# ── Layout ───────────────────────────────────────────────────────────────────
# Width never changes; height grows a row at a time. Within a row the chain
# zig-zags between an upper and a lower band, and rows run in serpentine order
# (left to right, then right to left) so the polyline stays continuous.
WIDTH = 1050
MARGIN_X = 128
ROW_TOP = 96
ROW_H = 250
UP_DY = 30
DOWN_DY = 175
BOTTOM_PAD = 112
PER_ROW = 5
# A path longer than this is drawn to the cap and the rest is stated in the
# footer -- max_hops goes to 32, and nobody reads a 20-row constellation.
MAX_NODES_DRAWN = 14

# ── Ink ──────────────────────────────────────────────────────────────────────
SURFACE = 0x0A1411      # near-black green, the card
CARD_EDGE = 0x16302A    # 1px border
FIELD_LINE = 0x1B2C27   # the decorative graph behind the path
FIELD_DOT = 0x2C3D37
ACCENT = 0x5FD6A4       # the path itself
ACCENT_CORE = 0xAFF3D6  # lit centre of a path node
LABEL = 0xE8F5F0
RELATION = 0x86C4AE
FOOTER = 0x3C5B51

# Reserved status inks for the three confidence levels, each drawn beside its
# own written label so the level is never carried by colour alone.
CONFIDENCE_INK = {
    "EXTRACTED": 0x4ADE9B,  # stated in the source
    "INFERRED": 0xF0B45C,   # deduced by the cross-file pass
    "AMBIGUOUS": 0xF07070,  # uncertain
}


def _rgb(value):
    return ((value >> 16) & 255, (value >> 8) & 255, value & 255)


def _png_bytes(width, height, raw):
    """Wrap filtered scanlines as a truecolor 8-bit PNG."""
    def chunk(tag, body):
        head = tag + body
        return (struct.pack(">I", len(body)) + head
                + struct.pack(">I", zlib.crc32(head) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (b"\\x89PNG\\r\\n\\x1a\\n"
            + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b""))


def _seed(text):
    """FNV-1a. Python's own hash() is salted per process, so it cannot seed
    anything that has to render the same twice."""
    h = 2166136261
    for ch in text:
        h = ((h ^ ord(ch)) * 16777619) & 0xFFFFFFFF
    return h or 1


class Rng(object):
    """A tiny LCG. The decorative field must be stable for a given query, and
    'stable' has to mean across processes and Python versions."""

    def __init__(self, seed):
        self.state = seed & 0x7FFFFFFF

    def next(self):
        self.state = (1103515245 * self.state + 12345) & 0x7FFFFFFF
        return self.state / 0x7FFFFFFF

    def between(self, lo, hi):
        return lo + (hi - lo) * self.next()


class Canvas(object):
    """A flat RGB buffer with alpha-blended primitives."""

    def __init__(self, width, height, background):
        self.w = width
        self.h = height
        self.buf = bytearray(bytes(_rgb(background)) * (width * height))

    def blend(self, x, y, rgb, alpha):
        if alpha <= 0 or x < 0 or y < 0 or x >= self.w or y >= self.h:
            return
        if alpha > 1:
            alpha = 1.0
        i = (y * self.w + x) * 3
        buf = self.buf
        buf[i] = int(buf[i] + (rgb[0] - buf[i]) * alpha)
        buf[i + 1] = int(buf[i + 1] + (rgb[1] - buf[i + 1]) * alpha)
        buf[i + 2] = int(buf[i + 2] + (rgb[2] - buf[i + 2]) * alpha)

    def rect(self, x, y, w, h, color, alpha=1.0):
        rgb = _rgb(color)
        for yy in range(int(y), int(y + h)):
            for xx in range(int(x), int(x + w)):
                self.blend(xx, yy, rgb, alpha)

    def dot(self, cx, cy, radius, color, alpha=1.0):
        """An antialiased filled circle: coverage is the pixel's distance
        past the edge, so the rim fades instead of stepping."""
        rgb = _rgb(color)
        for yy in range(int(cy - radius - 1), int(cy + radius + 2)):
            dy = yy - cy
            for xx in range(int(cx - radius - 1), int(cx + radius + 2)):
                dx = xx - cx
                cover = radius + 0.5 - math.sqrt(dx * dx + dy * dy)
                if cover > 0:
                    self.blend(xx, yy, rgb, min(1.0, cover) * alpha)

    def glow(self, cx, cy, radius, color, alpha):
        """A radial halo, falling off quadratically to nothing at radius."""
        rgb = _rgb(color)
        for yy in range(int(cy - radius), int(cy + radius + 1)):
            dy = yy - cy
            for xx in range(int(cx - radius), int(cx + radius + 1)):
                dx = xx - cx
                d = math.sqrt(dx * dx + dy * dy)
                if d < radius:
                    t = 1.0 - d / radius
                    self.blend(xx, yy, rgb, alpha * t * t)

    def line(self, x0, y0, x1, y1, color, width=2.0, alpha=1.0):
        """Stamp antialiased discs along the segment. Cheaper than a coverage
        pass over the bounding box, and it round-caps the ends for free."""
        dx, dy = x1 - x0, y1 - y0
        length = math.sqrt(dx * dx + dy * dy)
        if length < 0.5:
            return
        steps = int(length) + 1
        radius = width / 2.0
        for i in range(steps + 1):
            t = i / steps
            self.dot(x0 + dx * t, y0 + dy * t, radius, color, alpha)

    def text(self, x, y, s, color, scale=1, alpha=1.0, bold=False, italic=False):
        """Draw ASCII text with its top-left at (x, y). Returns the end x.

        'bold' doubles each lit pixel horizontally and 'italic' shears the
        glyph by row -- the two weights the diagram distinguishes (a node's
        name, a relation) without a second font table."""
        rgb = _rgb(color)
        for ch in s:
            code = ord(ch)
            if code < 32 or code > 126:
                code = 63  # '?'
            glyph = FONT_5X7[(code - 32) * 10:(code - 32) * 10 + 10]
            for col in range(GLYPH_W):
                bits = int(glyph[col * 2:col * 2 + 2], 16)
                for row in range(GLYPH_H):
                    if not bits & (1 << row):
                        continue
                    lean = int((GLYPH_H - 1 - row) * scale * 0.4) if italic else 0
                    px = int(x + col * scale) + lean
                    py = int(y + row * scale)
                    for sy in range(scale):
                        for sx in range(scale + (1 if bold else 0)):
                            self.blend(px + sx, py + sy, rgb, alpha)
            x += CELL_W * scale
        return x

    def text_centered(self, cx, y, s, color, scale=1, alpha=1.0, bold=False, italic=False):
        """Centre on 'cx', but never let a long label run off the card."""
        width = _text_w(s, scale)
        x = min(max(cx - width / 2.0, 18), WIDTH - 18 - width)
        return self.text(x, y, s, color, scale, alpha, bold, italic)

    def png(self):
        stride = self.w * 3
        raw = bytearray()
        for yy in range(self.h):
            raw.append(0)  # filter type 0 (None)
            raw += self.buf[yy * stride:(yy + 1) * stride]
        return _png_bytes(self.w, self.h, bytes(raw))


def _text_w(s, scale):
    return len(s) * CELL_W * scale


def _fit(s, scale, width):
    """Trim text to what fits in \`width\` pixels, marking the cut."""
    s = " ".join(str(s or "").split())
    limit = max(1, int(width) // (CELL_W * scale))
    if len(s) <= limit:
        return s
    return s[:max(1, limit - 3)] + "..."


def _nodes_from(steps):
    """The hop chain as node labels: each step's target, behind the first
    step's source."""
    labels = [str(steps[0].get("from", ""))]
    for step in steps:
        labels.append(str(step.get("to", "")))
    return labels


def _hits(boxes, box):
    """Does this label box overlap anything already placed?"""
    for other in boxes:
        if (box[0] < other[2] and box[2] > other[0]
                and box[1] < other[3] and box[3] > other[1]):
            return True
    return False


def _positions(count):
    """Where each node sits. Rows run in serpentine order and every row
    zig-zags between the two bands, so the polyline never doubles back."""
    points = []
    rows = (count + PER_ROW - 1) // PER_ROW
    for index in range(count):
        row = index // PER_ROW
        col = index % PER_ROW
        cols = min(PER_ROW, count - row * PER_ROW)
        frac = 0.0 if cols == 1 else col / float(cols - 1)
        if row % 2 == 1:
            frac = 1.0 - frac
        x = MARGIN_X + frac * (WIDTH - 2 * MARGIN_X)
        # The band follows the column, not the running index: with an odd
        # PER_ROW every row then starts AND ends on the lower band, so the
        # jump to the next row is a clean vertical drop between two nodes
        # whose labels sit a row apart instead of on top of each other.
        y = ROW_TOP + row * ROW_H + (UP_DY if col % 2 else DOWN_DY)
        points.append((x, y))
    return points, rows


def _draw_field(canvas, rng, height, avoid):
    """The dim graph the path was pulled out of. Decorative: positions come
    from the seeded LCG, and anything landing on a path node is dropped so the
    lit chain stays clean."""
    dots = []
    for _ in range(54):
        x = rng.between(24, WIDTH - 24)
        y = rng.between(24, height - 24)
        if any((x - ax) ** 2 + (y - ay) ** 2 < 5200 for ax, ay in avoid):
            continue
        dots.append((x, y))

    # Join each dot to its two nearest neighbours -- enough structure to read
    # as a graph, sparse enough to stay background.
    for i, (x, y) in enumerate(dots):
        ranked = sorted(
            ((x - ox) ** 2 + (y - oy) ** 2, j) for j, (ox, oy) in enumerate(dots) if j != i
        )
        for _dist, j in ranked[:2]:
            if j > i:
                canvas.line(x, y, dots[j][0], dots[j][1], FIELD_LINE, 1.1, 0.85)
    for x, y in dots:
        canvas.dot(x, y, 2.6, FIELD_DOT, 0.9)


def _draw_card(canvas, height):
    """Round the corners and rim the card, so the image reads as a panel
    rather than a screenshot with a dark background."""
    radius = 14
    for corner_x, corner_y, sx, sy in (
        (radius, radius, -1, -1),
        (WIDTH - radius - 1, radius, 1, -1),
        (radius, height - radius - 1, -1, 1),
        (WIDTH - radius - 1, height - radius - 1, 1, 1),
    ):
        for dy in range(radius + 1):
            for dx in range(radius + 1):
                if math.sqrt(dx * dx + dy * dy) > radius:
                    canvas.blend(int(corner_x + sx * dx), int(corner_y + sy * dy),
                                 (0, 0, 0), 1.0)
    edge = _rgb(CARD_EDGE)
    for x in range(radius, WIDTH - radius):
        canvas.blend(x, 0, edge, 1.0)
        canvas.blend(x, height - 1, edge, 1.0)
    for y in range(radius, height - radius):
        canvas.blend(0, y, edge, 1.0)
        canvas.blend(WIDTH - 1, y, edge, 1.0)


def render_path_png(payload):
    """Draw a found graphify_path result. Returns PNG bytes, or None if the
    payload has no hops to draw."""
    steps = payload.get("steps") or []
    if not steps:
        return None

    labels = _nodes_from(steps)
    hidden = 0
    if len(labels) > MAX_NODES_DRAWN:
        hidden = len(labels) - MAX_NODES_DRAWN
        labels = labels[:MAX_NODES_DRAWN]
        steps = steps[:MAX_NODES_DRAWN - 1]

    points, rows = _positions(len(labels))
    height = ROW_TOP + (rows - 1) * ROW_H + DOWN_DY + BOTTOM_PAD
    canvas = Canvas(WIDTH, height, SURFACE)

    seed = _seed(str(payload.get("repo", ".")) + "|" + str(payload.get("source", ""))
                 + "|" + str(payload.get("target", "")))
    _draw_field(canvas, Rng(seed), height, points)

    # The chain: a wide dim pass under a narrow bright one reads as light
    # coming off the line rather than a stroke with a border.
    for i in range(len(points) - 1):
        x0, y0 = points[i]
        x1, y1 = points[i + 1]
        canvas.line(x0, y0, x1, y1, ACCENT, 9.0, 0.10)
        canvas.line(x0, y0, x1, y1, ACCENT, 2.4, 1.0)

    for x, y in points:
        canvas.glow(x, y, 26, ACCENT, 0.30)
        canvas.dot(x, y, 6.5, ACCENT, 1.0)
        canvas.dot(x, y, 3.0, ACCENT_CORE, 1.0)

    # Node labels sit on the outer side of their band. Their boxes are kept so
    # the edge labels can steer around them.
    gap = (WIDTH - 2 * MARGIN_X) / max(1, min(PER_ROW, len(labels)) - 1 or 1)
    taken = []
    for i, label in enumerate(labels):
        x, y = points[i]
        up = (i % PER_ROW) % 2 == 1
        # A label wider than its column would run into its neighbour's.
        text = _fit(label, 2, gap + 8)
        top = y - 48 if up else y + 28
        width = _text_w(text, 2)
        # The two nodes either side of a row change are stacked on one x, with
        # the vertical connector running between them -- centring their labels
        # would draw the line straight through the words. Push those inward.
        seam = len(labels) > PER_ROW and (
            (i % PER_ROW == 0 and i > 0)
            or (i % PER_ROW == PER_ROW - 1 and i < len(labels) - 1)
        )
        cx = x + (1 if x < WIDTH / 2 else -1) * (width / 2.0 + 22) if seam else x
        canvas.text_centered(cx, top, text, LABEL, 2, 1.0, True)
        taken.append((cx - width / 2.0 - 6, top - 4, cx + width / 2.0 + 6, top + 18))

    # Edge labels ride the segment's midpoint, pushed off it along the
    # perpendicular -- straight up would drop them on the line itself wherever
    # a segment runs steeply, and the row-to-row drops run vertically. Each one
    # takes the first offset that lands clear of everything already placed.
    for i, step in enumerate(steps):
        x0, y0 = points[i]
        x1, y1 = points[i + 1]
        mx, my = (x0 + x1) / 2.0, (y0 + y1) / 2.0
        length = math.sqrt((x1 - x0) ** 2 + (y1 - y0) ** 2) or 1.0
        nx, ny = -(y1 - y0) / length, (x1 - x0) / length
        if ny > 0:  # always the side away from the line's downhill
            nx, ny = -nx, -ny

        relation = _fit(step.get("relation") or "related to", 2, gap * 0.85)
        level = str(step.get("confidence") or "").upper()
        chip = _fit(level, 1, gap) if level else ""
        width = max(_text_w(relation, 2), _text_w(chip, 1) + 12)

        cx, cy = mx + nx * 40, my + ny * 40
        for dist in (40, -40, 70, -70, 104, -104):
            tx, ty = mx + nx * dist, my + ny * dist
            box = (tx - width / 2.0 - 6, ty - 18, tx + width / 2.0 + 6, ty + 16)
            if not _hits(taken, box):
                cx, cy = tx, ty
                taken.append(box)
                break

        canvas.text_centered(cx, cy - 16, relation, RELATION, 2, 1.0, False, True)
        if chip:
            ink = CONFIDENCE_INK.get(level, RELATION)
            chip_w = _text_w(chip, 1) + 12
            canvas.dot(cx - chip_w / 2.0 + 3, cy + 5, 2.6, ink, 1.0)
            canvas.text(cx - chip_w / 2.0 + 12, cy + 2, chip, ink, 1, 0.85)

    hops = payload.get("hops")
    if not isinstance(hops, int):
        hops = len(steps)
    footer = (str(hops) + (" hop" if hops == 1 else " hops") + "  |  graphify path  |  repo "
              + str(payload.get("repo", ".")))
    if hidden:
        footer += "  |  + " + str(hidden) + " node(s) not drawn"
    canvas.text(MARGIN_X - 24, height - 34, _fit(footer, 1, WIDTH - 2 * MARGIN_X + 48), FOOTER, 1)

    _draw_card(canvas, height)
    return canvas.png()


def render_path_base64(payload):
    """render_path_png as base64 text, ready to hand back through JSON."""
    png = render_path_png(payload)
    if not png:
        return None
    return base64.b64encode(png).decode("ascii")
`;
