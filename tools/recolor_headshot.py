"""Recolour the headshot's backdrop circle and cut away the white surround.

The source is a 1080x1080 JPEG: a flat teal disc on a white square. Two
problems on the page — the white corners show outside the disc, and the teal
(#489082) does not match the deep brand green used by the quote band, the
buttons and the nav (#014235).

Both are baked into the pixels, so they are fixed here rather than in CSS.

The backdrop is found by flood fill from seeds around the inside rim, not by a
colour test over the whole frame: the paisley jacket carries its own teals and
greens, and a plain "is this pixel teal" test would repaint them too. The fill
only reaches the one connected region behind her.

Edge pixels are a blend of backdrop and hair, so they are shifted by the
fraction of backdrop they contain (w) instead of being repainted flat. For a
pixel P = w*teal + (1-w)*hair, P + w*(green-teal) is exactly the same blend
against the new colour — which is what keeps a pale halo from appearing around
her hair once the backdrop goes dark.
"""

import math
import sys
from collections import deque
from PIL import Image

# The original teal-backdrop headshot. It is no longer what is checked in
# under this name — that file is now the recoloured og:image — so to re-run
# this, recover the original first:
#
#   git show e73f2b1:assets/img/headshot.jpg > /tmp/headshot-teal.jpg
#   python3 tools/recolor_headshot.py /tmp/headshot-teal.jpg
#
# Running it against its own output is refused below rather than silently
# producing a mess, since the flood would find no teal to walk.
SRC = "assets/img/headshot.jpg"
OUT_WEBP = "assets/img/headshot.webp"
OUT_JPG = "assets/img/headshot.jpg"

TEAL = (72, 144, 130)     # the backdrop as shot
GREEN = (1, 66, 53)       # --ft-green / --green-deep, #014235

CX, CY, R = 538.5, 537.2, 527.5   # disc fitted from white/non-white crossings

FILL_TOL = 110      # L1 slack for "this is still the backdrop"
BLEND_SPAN = 300    # L1 distance from teal to her hair, i.e. the w=0 point
DILATE = 4          # px of fringe around the backdrop to soften
# Backdrop also shows through gaps in her hair, and those islands are not
# connected to the region the flood walks. They are picked up by colour alone,
# which is why the tolerance here is tight rather than the fill's: L1 counts a
# hue change the same as a lightness change, so a loose figure catches the
# mid-grey pixels in her eyebrows and lip line (L1 ~88 from the backdrop) and
# darkens her face by ~50 levels. The islands are flat backdrop to within a
# level or two, so 40 reaches them and nothing else.
ISLAND_TOL = 40

# The source was itself cut out and laid onto the teal with a light matte, so
# the loose hair at her outline carries a pale grey fringe up to ~40px wide.
# Against the old teal it barely showed; against a backdrop this dark it reads
# as a glow, so a second pass absorbs it into the backdrop.
#
# Growing outwards from the backdrop does NOT work: her skin carries
# near-neutral specular highlights, so the grow finds a way in through a bright
# patch on her cheek and then spreads across her whole face. What separates
# fringe from face is not colour but surroundings — a wisp sits in open
# backdrop, her face does not. So a pale pixel is absorbed only when most of
# its neighbourhood is already backdrop, re-measured over several passes so a
# wide wisp erodes inwards a layer at a time.
#
# The fringe is neutral (channel spread <= 35 measured); her skin and the
# jacket's gold sit at spread 97-118 and her hair at luma 11, so those are out.
HALO_SPREAD = 45
HALO_LUMA = 130
HALO_WIN = 10       # half-width of the neighbourhood window
HALO_FRAC = 0.45    # backdrop share of that window needed to absorb
HALO_PASSES = 5

# Backdrop also shows through two gaps in her hair, and those are neither flat
# backdrop nor reachable by the fringe pass: the bad matte has blown them out
# to a pale green (luma ~175), and being ringed by hair their neighbourhood is
# nowhere near backdrop. They are picked up as enclosed pale regions instead.
#
# Her eye catchlights are enclosed pale regions too — identical on every
# measure tried, including how dark the ring around them is — so region shape
# and colour cannot tell them apart. Anything overlapping her face is skipped
# by position, which covers her teeth on the same grounds.
ENCLOSED_MIN = 25
FACE_PROTECT = (440, 150, 710, 470)

RIM = 4             # px inside the disc edge that are backdrop for certain
SS = 4              # supersampling for the disc's alpha edge


def l1(a, b):
    return abs(a[0] - b[0]) + abs(a[1] - b[1]) + abs(a[2] - b[2])


def flood_backdrop(px, W, H):
    """The one connected teal region behind her, from seeds around the rim."""
    bg = bytearray(W * H)
    q = deque()
    for i in range(720):
        t = i * math.pi / 360.0
        sx = int(CX + (R - 10) * math.cos(t))
        sy = int(CY + (R - 10) * math.sin(t))
        if not (0 <= sx < W and 0 <= sy < H):
            continue
        k = sy * W + sx
        if not bg[k] and l1(px[sx, sy], TEAL) <= FILL_TOL:
            bg[k] = 1
            q.append((sx, sy))

    while q:
        x, y = q.popleft()
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nx < W and 0 <= ny < H:
                k = ny * W + nx
                if not bg[k] and l1(px[nx, ny], TEAL) <= FILL_TOL:
                    bg[k] = 1
                    q.append((nx, ny))
    return bg


def is_pale(c):
    return max(c) - min(c) <= HALO_SPREAD and (
        .299 * c[0] + .587 * c[1] + .114 * c[2]) >= HALO_LUMA


def fill_enclosed_gaps(px, bg, W, H):
    """Backdrop visible through gaps in her hair. See notes above."""
    def candidate(c):
        return is_pale(c) or l1(c, TEAL) <= 60

    fx0, fy0, fx1, fy1 = FACE_PROTECT
    seen = bytearray(W * H)
    filled = 0
    for sy in range(H):
        for sx in range(W):
            k0 = sy * W + sx
            if seen[k0] or bg[k0] or not candidate(px[sx, sy]):
                continue
            comp = []
            touches_bg = False
            seen[k0] = 1
            dq = deque([(sx, sy)])
            while dq:
                x, y = dq.popleft()
                comp.append((x, y))
                for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                    if not (0 <= nx < W and 0 <= ny < H):
                        continue
                    j = ny * W + nx
                    if bg[j]:
                        touches_bg = True
                    elif not seen[j] and candidate(px[nx, ny]):
                        seen[j] = 1
                        dq.append((nx, ny))
            if touches_bg or len(comp) < ENCLOSED_MIN:
                continue
            xs = [p[0] for p in comp]
            ys = [p[1] for p in comp]
            if (min(xs) <= fx1 and max(xs) >= fx0
                    and min(ys) <= fy1 and max(ys) >= fy0):
                continue        # her eyes / teeth
            for x, y in comp:
                bg[y * W + x] = 1
            filled += len(comp)
    return filled


def absorb_matte_fringe(px, bg, W, H):
    """Fold the source's pale cutout fringe into the backdrop. See notes above."""
    pale = bytearray(W * H)
    for y in range(H):
        for x in range(W):
            if is_pale(px[x, y]):
                pale[y * W + x] = 1

    absorbed = 0
    for _ in range(HALO_PASSES):
        # summed-area table over the current backdrop, so the neighbourhood
        # share below is O(1) per pixel rather than O(window).
        sat = [0] * ((W + 1) * (H + 1))
        for y in range(H):
            row = (y + 1) * (W + 1)
            prev = y * (W + 1)
            run = 0
            for x in range(W):
                run += bg[y * W + x]
                sat[row + x + 1] = sat[prev + x + 1] + run

        k = HALO_WIN
        hits = []
        for y in range(H):
            y0, y1 = max(0, y - k), min(H, y + k + 1)
            r0, r1 = y0 * (W + 1), y1 * (W + 1)
            for x in range(W):
                i = y * W + x
                if bg[i] or not pale[i]:
                    continue
                x0, x1 = max(0, x - k), min(W, x + k + 1)
                total = (sat[r1 + x1] - sat[r0 + x1]
                         - sat[r1 + x0] + sat[r0 + x0])
                if total >= HALO_FRAC * (y1 - y0) * (x1 - x0):
                    hits.append(i)
        if not hits:
            break
        for i in hits:
            bg[i] = 1
        absorbed += len(hits)
    return absorbed


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else SRC
    im = Image.open(src).convert("RGB")
    W, H = im.size
    px = im.load()

    probe = px[60, 540]
    if l1(probe, TEAL) > FILL_TOL:
        sys.exit(f"{src}: backdrop is {probe}, not the original teal {TEAL} "
                 f"— see the note by SRC for how to recover the source.")

    bg = flood_backdrop(px, W, H)
    filled = sum(bg)

    # Gaps first, and only then the loose islands: a gap's own core is flat
    # backdrop, so adding islands up front would make every gap read as
    # touching the backdrop and be skipped as outline fringe instead.
    gaps = fill_enclosed_gaps(px, bg, W, H)

    islands = 0
    for y in range(H):
        for x in range(W):
            k = y * W + x
            if not bg[k] and l1(px[x, y], TEAL) <= ISLAND_TOL:
                bg[k] = 1
                islands += 1

    absorbed = absorb_matte_fringe(px, bg, W, H)

    # --- dilate, to reach the antialiased fringe the fill stopped short of --
    near = bytearray(bg)
    frontier = [i for i in range(W * H) if bg[i]]
    for _ in range(DILATE):
        nxt = []
        for k in frontier:
            y, x = divmod(k, W)
            for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                if 0 <= nx < W and 0 <= ny < H:
                    j = ny * W + nx
                    if not near[j]:
                        near[j] = 1
                        nxt.append(j)
        frontier = nxt

    # --- compose: new backdrop, preserved subject, antialiased disc alpha ---
    out = Image.new("RGBA", (W, H))
    op = out.load()
    r_in2 = (R - 1.5) ** 2
    r_out2 = (R + 1.5) ** 2
    rim2 = (R - RIM) ** 2
    dg = (GREEN[0] - TEAL[0], GREEN[1] - TEAL[1], GREEN[2] - TEAL[2])

    for y in range(H):
        dy = y + 0.5 - CY
        for x in range(W):
            dx = x + 0.5 - CX
            d2 = dx * dx + dy * dy

            if d2 >= r_out2:
                op[x, y] = (GREEN[0], GREEN[1], GREEN[2], 0)
                continue

            if d2 <= r_in2:
                alpha = 255
            else:
                hits = 0
                for sy in range(SS):
                    fy = y + (sy + 0.5) / SS - CY
                    for sx in range(SS):
                        fx = x + (sx + 0.5) / SS - CX
                        if fx * fx + fy * fy <= R * R:
                            hits += 1
                alpha = round(255 * hits / (SS * SS))

            k = y * W + x
            if d2 >= rim2 or bg[k]:
                # outer rim and the backdrop proper are solid new green
                op[x, y] = (GREEN[0], GREEN[1], GREEN[2], alpha)
                continue

            c = px[x, y]
            dist = l1(c, TEAL)
            if near[k] and dist < BLEND_SPAN:
                w = min(1.0, 1.0 - dist / BLEND_SPAN)
                op[x, y] = (
                    min(255, max(0, round(c[0] + w * dg[0]))),
                    min(255, max(0, round(c[1] + w * dg[1]))),
                    min(255, max(0, round(c[2] + w * dg[2]))),
                    alpha,
                )
            else:
                op[x, y] = (c[0], c[1], c[2], alpha)

    out.save(OUT_WEBP, quality=90, method=6)

    # og:image stays a JPEG on white — social clients render it against
    # backgrounds we do not control, so it keeps the square rather than alpha.
    flat = Image.new("RGB", (W, H), (255, 255, 255))
    flat.paste(out, (0, 0), out)
    flat.save(OUT_JPG, quality=88, optimize=True, progressive=True)

    print(f"backdrop pixels flooded: {filled}")
    print(f"backdrop islands:        {islands}")
    print(f"hair gaps filled:        {gaps}")
    print(f"matte fringe absorbed:   {absorbed}")
    print(f"wrote {OUT_WEBP} and {OUT_JPG}")


main()
