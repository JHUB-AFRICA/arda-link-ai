#!/usr/bin/env python3
"""Generate the ArdaLink A0 and Letter posters as SVG + PDF.

Brand tokens match ardalink-web/dashboard/src/index.css.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path
from xml.sax.saxutils import escape

import qrcode
from qrcode.image.svg import SvgPathImage

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "poster"
OUT.mkdir(parents=True, exist_ok=True)

# ── Brand tokens ────────────────────────────────────────────────────────────
BG = "#0B0B12"
SURFACE = "#15151F"
SURFACE_2 = "#1C1C28"
BORDER = "#2A2A38"
FG = "#F5F5F4"
MUTED = "#A8A29E"
DIM = "#71717A"
PRIMARY = "#F59E0B"
ACCENT = "#FF3C00"
OK = "#84CC16"
INFO = "#38BDF8"
DANGER = "#DC2626"

REPO_URL = "https://github.com/JHUB-AFRICA/arda-link-ai"
HERO_TAGLINE = "Pastoralist intelligence for Isiolo's drylands."
HERO_KICKER = "SATELLITE → AI → HERDER'S PHONE  ·  VOICE · USSD · SMS"


def qr_path_data(url: str) -> tuple[str, float]:
    img = qrcode.make(url, image_factory=SvgPathImage, box_size=10, border=0)
    s = img.to_string(encoding="unicode") if hasattr(img, "to_string") else str(img)
    d = (re.search(r'd="([^"]+)"', s) or [None, ""]).group(1)
    vb = (re.search(r'viewBox="([^"]+)"', s) or [None, "0 0 100 100"]).group(1)
    _, _, qw, _ = (float(x) for x in vb.split())
    return d, qw


# ── Primitives ───────────────────────────────────────────────────────────────

def text(x, y, body, *, size=12, weight=400, fill=FG, anchor="start",
         letter_spacing=0, family="Inter, system-ui, sans-serif"):
    ls = f' letter-spacing="{letter_spacing}"' if letter_spacing else ""
    return (
        f'<text x="{x}" y="{y}" text-anchor="{anchor}" '
        f'font-family="{family}" font-size="{size}" font-weight="{weight}" '
        f'fill="{fill}"{ls}>{escape(body)}</text>'
    )


def rect(x, y, w, h, *, fill=BG, stroke=None, sw=0.6, rx=0):
    s = (f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" '
         f'ry="{rx}" fill="{fill}"')
    if stroke:
        s += f' stroke="{stroke}" stroke-width="{sw}"'
    return s + "/>"


def wrap(body, x, y, *, size, width, fill=FG, weight=400, line_h=None):
    if line_h is None:
        line_h = size * 1.4
    chars = max(8, int(width / (size * 0.52)))
    words = body.split()
    lines, cur = [], ""
    for w in words:
        cand = (cur + " " + w).strip()
        if len(cand) > chars and cur:
            lines.append(cur)
            cur = w
        else:
            cur = cand
    if cur:
        lines.append(cur)
    return "\n".join(
        text(x, y + i * line_h, ln, size=size, weight=weight, fill=fill)
        for i, ln in enumerate(lines)
    )


def logo(x, y, size=64):
    return (
        f'<g transform="translate({x},{y})">'
        + rect(0, 0, size, size, fill=ACCENT, rx=size * 0.22)
        + f'<path d="M {size*0.25} {size*0.78} L {size*0.5} {size*0.18} '
          f'L {size*0.75} {size*0.78} L {size*0.64} {size*0.78} '
          f'L {size*0.5} {size*0.45} L {size*0.36} {size*0.78} Z" '
          f'fill="{FG}"/>'
        + f'<circle cx="{size*0.5}" cy="{size*0.14}" r="{size*0.055}" '
          f'fill="{PRIMARY}"/>'
        + "</g>"
    )


def arrow(x, y, *, length=14, color=PRIMARY, w=2):
    """Tiny right-pointing arrow (line + chevron)."""
    return (
        f'<g transform="translate({x},{y})">'
        f'<line x1="0" y1="0" x2="{length-4}" y2="0" stroke="{color}" '
        f'stroke-width="{w}" stroke-linecap="round"/>'
        f'<path d="M {length-4} 0 L {length-9} -4 M {length-4} 0 '
        f'L {length-9} 4" stroke="{color}" stroke-width="{w}" '
        f'fill="none" stroke-linecap="round" stroke-linejoin="round"/>'
        f'</g>'
    )


# ────────────────────────────────────────────────────────────────────────────
# A0 PORTRAIT POSTER  (841 x 1189 mm)
# ────────────────────────────────────────────────────────────────────────────

def poster_a0() -> str:
    W, H = 841, 1189
    margin = 32
    inner_w = W - margin * 2

    qr_d, qr_w = qr_path_data(REPO_URL)

    out = []
    out.append(
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'viewBox="0 0 {W} {H}" width="{W}mm" height="{H}mm">'
    )
    out.append(
        '<defs>'
        '<linearGradient id="heroBg" x1="0" y1="0" x2="1" y2="1">'
        f'<stop offset="0" stop-color="{BG}"/>'
        f'<stop offset="1" stop-color="#1A0F05"/>'
        '</linearGradient>'
        '<linearGradient id="amberGrad" x1="0" y1="0" x2="1" y2="0">'
        f'<stop offset="0" stop-color="{PRIMARY}"/>'
        f'<stop offset="1" stop-color="{ACCENT}"/>'
        '</linearGradient>'
        '</defs>'
    )
    out.append(rect(0, 0, W, H, fill=BG))

    # ── HERO (140mm) ─────────────────────────────────────────────────────────
    hero_h = 140
    out.append(rect(0, 0, W, hero_h, fill="url(#heroBg)"))
    out.append(rect(0, hero_h - 3, W, 3, fill="url(#amberGrad)"))

    out.append(logo(margin, margin - 4, size=58))
    out.append(text(margin + 76, margin + 22, "ArdaLink", size=30,
                    weight=800, fill=FG, letter_spacing=-0.5))
    out.append(text(margin + 76, margin + 42,
                    "PASTORALIST INTELLIGENCE PLATFORM",
                    size=11, weight=700, fill=MUTED, letter_spacing=2))
    # JHUB tag
    out.append(rect(W - margin - 160, margin + 4, 160, 32,
                    fill=SURFACE, stroke=BORDER, rx=16))
    out.append(text(W - margin - 80, margin + 24, "JHUB AFRICA  ·  2026",
                    size=11, weight=700, fill=FG, letter_spacing=2,
                    anchor="middle"))
    # Tagline
    out.append(text(margin, margin + 84, HERO_TAGLINE, size=30,
                    weight=800, fill=FG))
    out.append(text(margin, margin + 110, HERO_KICKER, size=12,
                    weight=700, fill=PRIMARY, letter_spacing=3))

    y = hero_h + 22

    # ── PROBLEM (180mm) ──────────────────────────────────────────────────────
    out.append(text(margin, y, "THE PROBLEM", size=10, weight=800,
                    fill=PRIMARY, letter_spacing=3))
    y += 22
    out.append(text(margin, y, "A herder loses KES 200,000 of livestock",
                    size=20, weight=800, fill=FG))
    y += 24
    out.append(text(margin, y, "in a bad drought cycle.",
                    size=20, weight=800, fill=FG))
    y += 26
    out.append(wrap(
        "Drought is the single largest cause of household poverty in "
        "northern Kenya. Satellites see the vegetation stress two to "
        "three weeks before a herder does — but the signal never "
        "reaches the phone.",
        margin, y, size=12, width=inner_w - 330, fill=FG,
    ))
    # Stats card (right)
    sx, sy, sw, sh = W - margin - 310, hero_h + 38, 310, 130
    out.append(rect(sx, sy, sw, sh, fill=SURFACE_2, rx=10))
    out.append(text(sx + 16, sy + 22, "BY THE NUMBERS", size=10, weight=800,
                    fill=PRIMARY, letter_spacing=3))
    out.append(text(sx + 16, sy + 60, "KES 200K", size=30, weight=800,
                    fill=ACCENT))
    out.append(text(sx + 170, sy + 56, "lost per herder", size=12,
                    weight=600, fill=FG))
    out.append(text(sx + 170, sy + 70, "in a bad cycle", size=12,
                    weight=500, fill=MUTED))
    out.append(
        f'<line x1="{sx + 16}" y1="{sy + 86}" x2="{sx + sw - 16}" '
        f'y2="{sy + 86}" stroke="{BORDER}" stroke-width="0.6"/>'
    )
    out.append(text(sx + 16, sy + 116, "2–3 wks", size=22, weight=800,
                    fill=PRIMARY))
    out.append(text(sx + 130, sy + 113, "satellite lead vs.", size=11,
                    weight=600, fill=FG))
    out.append(text(sx + 130, sy + 124, "herder's eye", size=11,
                    weight=500, fill=MUTED))
    y = sy + sh + 24

    # ── SOLUTION + CHANNELS (170mm) ──────────────────────────────────────────
    out.append(text(margin, y, "THE SOLUTION", size=10, weight=800,
                    fill=PRIMARY, letter_spacing=3))
    y += 22
    out.append(text(margin, y,
                    "A voice-first intelligence layer that lives on a 2G phone.",
                    size=20, weight=800, fill=FG))
    y += 30
    out.append(wrap(
        "Every five days, the satellite reads every patch of the ward. "
        "When the pasture starts to fail, the platform calls the herder "
        "in Swahili, English, or Borana to ask what she sees on the "
        "ground.",
        margin, y, size=12, width=inner_w, fill=FG,
    ))
    y += 84
    channels = [
        ("VOICE", "Outbound + inbound call",     ACCENT),
        ("USSD",  "*123*8# menu, no data plan",  INFO),
        ("SMS",   "BULA · MALISHO · ONGEA",      PRIMARY),
    ]
    pill_w = (inner_w - 20) / 3
    for i, (label, sub, col) in enumerate(channels):
        cx = margin + i * (pill_w + 10)
        out.append(rect(cx, y, pill_w, 60, fill=SURFACE, rx=8))
        out.append(rect(cx, y, 5, 60, fill=col, rx=2.5))
        out.append(text(cx + 18, y + 26, label, size=18, weight=800,
                        fill=FG, letter_spacing=1.2))
        out.append(text(cx + 18, y + 46, sub, size=11, weight=500, fill=MUTED))
    y += 86

    # ── ARCHITECTURE (260mm) ─────────────────────────────────────────────────
    out.append(text(margin, y, "ARCHITECTURE", size=10, weight=800,
                    fill=PRIMARY, letter_spacing=3))
    y += 22
    out.append(text(margin, y,
                    "Three small services. One secure database. That's the whole platform.",
                    size=18, weight=800, fill=FG))
    y += 32
    arch_y = y
    arch_h = 200
    cols = [
        ("HERDER", "2G/3G phone", PRIMARY, [
            "Voice call", "(Swahili / English)",
            "USSD *123*8#", "SMS keyword",
            "(BULA · MALISHO)",
        ]),
        ("AFRICA'S TALKING", "Voice · SMS · USSD", ACCENT, [
            "Outbound voice API", "2-way SMS gateway",
            "USSD gateway", "DID pool",
            "+254 20 5XX XXXX",
        ]),
        ("ARDALINK CORE", "3 services", OK, [
            "The watcher", "satellite + weather",
            "The brain", "composes the brief",
            "The voice", "calls her in Swahili",
            "The dashboard", "what operators see",
        ]),
        ("DATA + AI", "satellite · language · store", INFO, [
            "Satellite reads the ward", "every 5 days",
            "AI spots trouble early", "in her language",
            "Her answers are saved", "to the database",
        ]),
    ]
    col_w = (inner_w - 30) / 4
    for i, (title, sub, accent_color, items) in enumerate(cols):
        cx = margin + i * (col_w + 10)
        out.append(rect(cx, arch_y, col_w, arch_h, fill=SURFACE, rx=8))
        out.append(
            f'<rect x="{cx}" y="{arch_y}" width="{col_w}" height="5" '
            f'rx="2.5" fill="{accent_color}"/>'
        )
        out.append(text(cx + 14, arch_y + 26, title, size=12, weight=800,
                        fill=accent_color, letter_spacing=1.5))
        out.append(text(cx + 14, arch_y + 42, sub, size=10, weight=500,
                        fill=MUTED))
        out.append(
            f'<line x1="{cx + 14}" y1="{arch_y + 52}" '
            f'x2="{cx + col_w - 14}" y2="{arch_y + 52}" '
            f'stroke="{BORDER}" stroke-width="0.6"/>'
        )
        for j, it in enumerate(items):
            out.append(text(cx + 14, arch_y + 70 + j * 18, "· " + it,
                            size=10.5, weight=500, fill=FG))
    # arrows between columns
    for i in range(3):
        ax = margin + (i + 1) * col_w + i * 10 + 6
        out.append(arrow(ax, arch_y + arch_h + 22, length=18))
    out.append(text(W / 2, arch_y + arch_h + 36,
                    "EVERY 5 DAYS  ·  satellite reads the ward  →  AI writes the brief  →  we call her  →  she decides",
                    size=11, weight=700, fill=DIM, anchor="middle"))
    y = arch_y + arch_h + 50

    # ── HERDER JOURNEY (130mm) ───────────────────────────────────────────────
    out.append(text(margin, y, "THE HERDER JOURNEY", size=10, weight=800,
                    fill=PRIMARY, letter_spacing=3))
    y += 22
    out.append(text(margin, y,
                    "From dial-tone to ground-truth report in five steps.",
                    size=18, weight=800, fill=FG))
    y += 26
    steps = [
        ("1", "DIAL",   PRIMARY, ["Herder dials", "*123*8#"]),
        ("2", "PICK",   INFO,    ["1 = Bula Pesa", "2 = Malisho", "3 = Ongea"]),
        ("3", "REPLY",  OK,      ["ArdaLink replies", "in Swahili", "or English"]),
        ("4", "CALL",   ACCENT,  ["Outbound voice", "call: AI brief", "in her dialect"]),
        ("5", "REPORT", PRIMARY, ["Herder answers.", "Indicators saved", "to ground truth"]),
    ]
    n = len(steps)
    col_w = (inner_w - (n - 1) * 6) / n
    step_h = 78
    for i, (num, label, col, body) in enumerate(steps):
        cx = margin + i * (col_w + 6)
        out.append(rect(cx, y, col_w, step_h, fill=SURFACE, rx=8))
        out.append(f'<circle cx="{cx + 20}" cy="{y + 20}" r="12" fill="{col}"/>')
        out.append(text(cx + 20, y + 24, num, size=12, weight=800,
                        fill=BG, anchor="middle"))
        out.append(text(cx + 40, y + 25, label, size=11, weight=800,
                        fill=col, letter_spacing=1.5))
        for j, line in enumerate(body):
            out.append(text(cx + 12, y + 46 + j * 15, line,
                            size=10.5, weight=500, fill=FG))
        if i < n - 1:
            ax = cx + col_w + 1
            out.append(
                f'<path d="M {ax} {y + step_h/2} l 4 -3 l 0 6 z" '
                f'fill="{DIM}"/>'
            )
    y += step_h + 24

    # ── IMPACT KPI row (compact) ─────────────────────────────────────────────
    out.append(text(margin, y, "WHAT'S BUILT  ·  WHAT'S NEXT",
                    size=10, weight=800, fill=PRIMARY, letter_spacing=3))
    y += 18
    kpis = [
        ("5",      "Isiolo wards",                   PRIMARY,
         "wabera · bula-pesa · ngare-mara · burat · oldonyiro"),
        ("134",    "tests pass",                     OK,
         "api + web + engine"),
        ("$0.12",  "per herder / month",             ACCENT,
         "at 50K-household scale"),
        ("6 wks",  "to first call",                  INFO,
         "after green light"),
        ("4",      "AT webhooks",                    PRIMARY,
         "voice · USSD · SMS · events"),
    ]
    kpi_w = (inner_w - 40) / 5
    kpi_h = 64
    for i, (val, lab, col, sub) in enumerate(kpis):
        cx = margin + i * (kpi_w + 10)
        out.append(rect(cx, y, kpi_w, kpi_h, fill=SURFACE, rx=8))
        out.append(text(cx + kpi_w / 2, y + 26, val, size=22, weight=800,
                        fill=col, anchor="middle"))
        out.append(text(cx + kpi_w / 2, y + 42, lab, size=10.5, weight=600,
                        fill=FG, anchor="middle"))
        out.append(text(cx + kpi_w / 2, y + 56, sub, size=8.5, weight=500,
                        fill=MUTED, anchor="middle"))
    y += kpi_h + 8

    # ── NEXT (single row, inline) ───────────────────────────────────────────
    out.append(text(margin, y, "NEXT  ·  ", size=10, weight=800,
                    fill=PRIMARY, letter_spacing=3))
    next_items = [
        ("Africa's Talking production key + DID pool",     PRIMARY),
        ("AI voice stack (real-time speech)",              INFO),
        ("Earth Engine satellite account",                 OK),
        ("Recording voices in 4 local dialects",           ACCENT),
    ]
    nx = margin + 60
    for i, (it, col) in enumerate(next_items):
        out.append(f'<circle cx="{nx + 4}" cy="{y - 4}" r="3" fill="{col}"/>')
        out.append(text(nx + 12, y, it, size=10, weight=500, fill=FG))
        nx += 175
    y += 18

    # ── FOOTER (76mm) ────────────────────────────────────────────────────────
    foot_h = 76
    foot_y = H - foot_h
    out.append(rect(0, foot_y, W, foot_h, fill=SURFACE))
    out.append(rect(0, foot_y, W, 2, fill="url(#amberGrad)"))

    qr_size = 50
    qr_x = margin
    qr_y = foot_y + (foot_h - qr_size) / 2
    out.append(rect(qr_x - 3, qr_y - 3, qr_size + 6, qr_size + 6,
                    fill=FG, rx=5))
    scale = qr_size / qr_w
    out.append(
        f'<g transform="translate({qr_x},{qr_y}) scale({scale})">'
        f'<path d="{qr_d}" fill="{BG}"/></g>'
    )
    out.append(text(qr_x + qr_size + 16, foot_y + 30,
                    "github.com/JHUB-AFRICA/arda-link-ai",
                    size=14, weight=800, fill=FG))
    out.append(wrap(
        "Source of truth · architecture · sandbox workflow. "
        "This poster is generated from the same repo.",
        qr_x + qr_size + 16, foot_y + 46, size=10.5, width=380, fill=MUTED,
    ))
    out.append(text(W - margin, foot_y + 28, "THE TEAM",
                    size=11, weight=700, letter_spacing=2, fill=PRIMARY,
                    anchor="end"))
    out.append(text(W - margin, foot_y + 46,
                    "Founder · Ops · Domain · Software developer",
                    size=12, weight=600, fill=FG, anchor="end"))
    out.append(text(W - margin, foot_y + 62,
                    "JHUB Africa  ·  Isiolo County",
                    size=10, weight=500, fill=MUTED, anchor="end"))

    out.append("</svg>")
    return "\n".join(out)


# ────────────────────────────────────────────────────────────────────────────
# LETTER LANDSCAPE POSTER  (11 x 17 in = 279.4 x 431.8 mm)
# ────────────────────────────────────────────────────────────────────────────

def poster_letter() -> str:
    W, H = 279.4, 431.8
    margin = 10
    inner_w = W - margin * 2

    qr_d, qr_w = qr_path_data(REPO_URL)

    out = []
    out.append(
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'viewBox="0 0 {W} {H}" width="{W}mm" height="{H}mm">'
    )
    out.append(
        '<defs>'
        '<linearGradient id="heroBg2" x1="0" y1="0" x2="1" y2="1">'
        f'<stop offset="0" stop-color="{BG}"/>'
        f'<stop offset="1" stop-color="#1A0F05"/>'
        '</linearGradient>'
        '<linearGradient id="amberGrad2" x1="0" y1="0" x2="1" y2="0">'
        f'<stop offset="0" stop-color="{PRIMARY}"/>'
        f'<stop offset="1" stop-color="{ACCENT}"/>'
        '</linearGradient>'
        '</defs>'
    )
    out.append(rect(0, 0, W, H, fill=BG))

    # ── HEADER (28mm) ────────────────────────────────────────────────────────
    hh = 28
    out.append(rect(0, 0, W, hh, fill="url(#heroBg2)"))
    out.append(rect(0, hh - 1, W, 1, fill="url(#amberGrad2)"))
    out.append(logo(margin, 4, size=20))
    out.append(text(margin + 26, 15, "ArdaLink", size=12, weight=800, fill=FG))
    out.append(text(margin + 26, 24, "PASTORALIST INTELLIGENCE",
                    size=5.5, weight=700, fill=MUTED, letter_spacing=1.2))
    out.append(text(W - margin, 15,
                    "JHUB AFRICA  ·  github.com/JHUB-AFRICA/arda-link-ai",
                    size=6, weight=800, fill=PRIMARY, anchor="end",
                    letter_spacing=0.3))
    out.append(text(W - margin, 23, "v0.2  ·  2026-06  ·  sandbox-verified",
                    size=5, fill=MUTED, anchor="end"))

    y = hh + 6

    # ── TAGLINE (12mm) ───────────────────────────────────────────────────────
    out.append(text(margin, y + 9, HERO_TAGLINE, size=11.5, weight=800,
                    fill=FG))
    out.append(text(margin, y + 18, HERO_KICKER, size=6, weight=700,
                    fill=PRIMARY, letter_spacing=1.5))
    y += 24

    # ── PROBLEM + SOLUTION side-by-side (50mm) ──────────────────────────────
    col_w = (inner_w - 6) / 2
    col_h = 50
    out.append(rect(margin, y, col_w, col_h, fill=SURFACE, rx=6))
    out.append(text(margin + 8, y + 11, "THE PROBLEM", size=6.5, weight=800,
                    fill=PRIMARY, letter_spacing=2.5))
    out.append(text(margin + 8, y + 25, "A herder loses KES 200K",
                    size=9, weight=800, fill=FG))
    out.append(text(margin + 8, y + 36, "in a bad drought cycle.",
                    size=9, weight=800, fill=FG))
    out.append(wrap(
        "Satellites see it 2–3 wks before the herder does.",
        margin + 8, y + 46, size=6.5, width=col_w - 16, fill=MUTED,
    ))
    sx = margin + col_w + 6
    out.append(rect(sx, y, col_w, col_h, fill=SURFACE, rx=6))
    out.append(text(sx + 8, y + 11, "THE SOLUTION", size=6.5, weight=800,
                    fill=PRIMARY, letter_spacing=2.5))
    out.append(text(sx + 8, y + 25, "Voice-first intelligence",
                    size=9, weight=800, fill=FG))
    out.append(text(sx + 8, y + 36, "on a 2G phone.", size=9, weight=800,
                    fill=FG))
    out.append(wrap(
        "Every 5 days · pasture check · outbound call.",
        sx + 8, y + 46, size=6.5, width=col_w - 16, fill=MUTED,
    ))
    y += col_h + 6

    # ── CHANNELS row (22mm) ──────────────────────────────────────────────────
    channels = [
        ("VOICE", "call",     ACCENT),
        ("USSD",  "*123*8#",  INFO),
        ("SMS",   "BULA",     PRIMARY),
    ]
    pill_w = (inner_w - 8) / 3
    for i, (label, sub, col) in enumerate(channels):
        cx = margin + i * (pill_w + 4)
        out.append(rect(cx, y, pill_w, 22, fill=SURFACE, rx=5))
        out.append(rect(cx, y, 3, 22, fill=col, rx=1.5))
        out.append(text(cx + 10, y + 10, label, size=9, weight=800, fill=FG,
                        letter_spacing=1))
        out.append(text(cx + 10, y + 18, sub, size=6.5, weight=500,
                        fill=MUTED))
    y += 28

    # ── ARCHITECTURE (78mm) ──────────────────────────────────────────────────
    out.append(text(margin, y, "ARCHITECTURE  ·  3 services  ·  multi-tenant",
                    size=6.5, weight=800, fill=PRIMARY, letter_spacing=2.5))
    y += 10
    arch_h = 64
    out.append(rect(margin, y, inner_w, arch_h, fill=SURFACE, rx=6))
    cols = [
        ("HERDER",     PRIMARY, "2G/3G", "Voice\nUSSD *123*8#\nSMS keywords"),
        ("AT",         ACCENT,  "telco", "Voice/SMS APIs\nUSSD gateway\nDID pool"),
        ("ARDALINK",   OK,      "3 svcs","api · engine · web\nAPI · Biophysical · UI\nPostgres · multi-tenant"),
        ("DATA + AI",  INFO,    "sat/LLM",  "Sat reads the ward\nAI writes the brief\nAnswers are saved"),
    ]
    ccw = (inner_w - 16) / 4
    for i, (title, col, sub, body) in enumerate(cols):
        cx = margin + 8 + i * ccw
        out.append(rect(cx, y + 4, ccw - 6, 2, fill=col, rx=1))
        out.append(text(cx, y + 16, title, size=8, weight=800, fill=col,
                        letter_spacing=1))
        out.append(text(cx, y + 24, sub, size=5.5, weight=600, fill=MUTED))
        for j, line in enumerate(body.split("\n")):
            out.append(text(cx, y + 35 + j * 9, "· " + line,
                            size=6.5, weight=500, fill=FG))
    # arrows
    for i in range(3):
        ax = margin + 8 + (i + 1) * ccw - 6
        out.append(arrow(ax, y + arch_h / 2, length=6, w=1.2))
    y += arch_h + 6

    # ── HERDER JOURNEY (68mm) ────────────────────────────────────────────────
    out.append(text(margin, y, "THE HERDER JOURNEY", size=6.5, weight=800,
                    fill=PRIMARY, letter_spacing=2.5))
    y += 10
    steps = [
        ("1", "DIAL",   PRIMARY, ["Herder dials", "*123*8#"]),
        ("2", "PICK",   INFO,    ["1 = Bula Pesa", "2 = Malisho", "3 = Ongea"]),
        ("3", "REPLY",  OK,      ["ArdaLink replies", "Swahili / English"]),
        ("4", "CALL",   ACCENT,  ["Outbound voice", "AI brief in dialect"]),
        ("5", "REPORT", PRIMARY, ["Herder answers", "Indicators saved"]),
    ]
    n = len(steps)
    col_w = (inner_w - (n - 1) * 4) / n
    step_h = 52
    for i, (num, label, col, body) in enumerate(steps):
        cx = margin + i * (col_w + 4)
        out.append(rect(cx, y, col_w, step_h, fill=SURFACE, rx=6))
        out.append(f'<circle cx="{cx + 12}" cy="{y + 11}" r="7" fill="{col}"/>')
        out.append(text(cx + 12, y + 14, num, size=7, weight=800,
                        fill=BG, anchor="middle"))
        out.append(text(cx + 24, y + 14, label, size=7.5, weight=800,
                        fill=col, letter_spacing=1.2))
        # wrap each body line to fit column width (inner padding 8mm)
        body_x = cx + 6
        body_y = y + 26
        body_w = col_w - 8
        chars_per_line = max(8, int(body_w / (7 * 0.52)))
        for line in body:
            # word-wrap this single line
            words = line.split()
            cur = ""
            rendered = []
            for w in words:
                cand = (cur + " " + w).strip()
                if len(cand) > chars_per_line and cur:
                    rendered.append(cur)
                    cur = w
                else:
                    cur = cand
            if cur:
                rendered.append(cur)
            for ln in rendered:
                out.append(text(body_x, body_y, ln, size=7, weight=500,
                                fill=FG))
                body_y += 8
        if i < n - 1:
            out.append(
                f'<path d="M {cx + col_w + 0.5} {y + step_h/2} l 2.5 -2 '
                f'l 0 4 z" fill="{DIM}"/>'
            )
    y += step_h + 6

    # ── KPI ROW (40mm) ───────────────────────────────────────────────────────
    out.append(text(margin, y, "WHAT'S BUILT  ·  WHAT'S NEXT",
                    size=6.5, weight=800, fill=PRIMARY, letter_spacing=2.5))
    y += 10
    kpis = [
        ("3",      "demo wards",      PRIMARY),
        ("134",    "tests pass",      OK),
        ("$0.12",  "per herder/mo",   ACCENT),
        ("6 wks",  "to first call",   INFO),
        ("4",      "AT webhooks",     PRIMARY),
    ]
    kpi_w = (inner_w - 12) / 5
    kpi_h = 28
    for i, (val, lab, col) in enumerate(kpis):
        cx = margin + i * (kpi_w + 3)
        out.append(rect(cx, y, kpi_w, kpi_h, fill=SURFACE, rx=5))
        out.append(text(cx + kpi_w / 2, y + 14, val, size=12, weight=800,
                        fill=col, anchor="middle"))
        out.append(text(cx + kpi_w / 2, y + 23, lab, size=5.5,
                        fill=MUTED, anchor="middle"))
    y += kpi_h + 6

    # ── NEXT (compact, 2 columns) ────────────────────────────────────────────
    out.append(text(margin, y, "NEXT", size=6.5, weight=800,
                    fill=PRIMARY, letter_spacing=2.5))
    y += 9
    next_items = [
        ("AT production key + DID pool",  PRIMARY),
        ("AI voice stack",                INFO),
        ("Earth Engine account",          OK),
        ("4 local dialects",              ACCENT),
    ]
    ncw = (inner_w - 6) / 2
    for i, (it, col) in enumerate(next_items):
        col_i = i % 2
        row_i = i // 2
        rx = margin + col_i * (ncw + 6)
        ry = y + row_i * 8
        out.append(f'<circle cx="{rx + 3}" cy="{ry - 2.5}" r="2.2" '
                   f'fill="{col}"/>')
        out.append(text(rx + 8, ry, it, size=6.5, weight=500, fill=FG))
    y += 22

    # ── FOOTER (16mm) ────────────────────────────────────────────────────────
    foot_h = 14
    foot_y = H - foot_h
    out.append(rect(0, foot_y, W, foot_h, fill=SURFACE))
    out.append(rect(0, foot_y, W, 0.7, fill="url(#amberGrad2)"))
    qr_size = 10
    qr_x = margin
    qr_y = foot_y + (foot_h - qr_size) / 2
    out.append(rect(qr_x - 1, qr_y - 1, qr_size + 2, qr_size + 2,
                    fill=FG, rx=1.2))
    scale = qr_size / qr_w
    out.append(
        f'<g transform="translate({qr_x},{qr_y}) scale({scale})">'
        f'<path d="{qr_d}" fill="{BG}"/></g>'
    )
    out.append(text(qr_x + qr_size + 5, foot_y + 6,
                    "github.com/JHUB-AFRICA/arda-link-ai",
                    size=6, weight=800, fill=FG))
    out.append(text(qr_x + qr_size + 5, foot_y + 11,
                    "Source of truth · architecture · sandbox workflow",
                    size=5, fill=MUTED))
    out.append(text(W - margin, foot_y + 6, "THE TEAM",
                    size=5, weight=800, fill=PRIMARY, anchor="end",
                    letter_spacing=1))
    out.append(text(W - margin, foot_y + 11,
                    "JHUB Africa  ·  Isiolo County",
                    size=5.5, weight=600, fill=FG, anchor="end"))

    out.append("</svg>")
    return "\n".join(out)


# ────────────────────────────────────────────────────────────────────────────

def main() -> int:
    a0 = poster_a0()
    (OUT / "poster-A0.svg").write_text(a0, encoding="utf-8")
    print(f"  ✓ poster-A0.svg  ({len(a0):,} bytes)")
    lt = poster_letter()
    (OUT / "poster-letter.svg").write_text(lt, encoding="utf-8")
    print(f"  ✓ poster-letter.svg  ({len(lt):,} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
