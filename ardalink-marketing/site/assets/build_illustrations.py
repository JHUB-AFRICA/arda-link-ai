#!/usr/bin/env python3
"""Generate real, finished on-brand SVG illustrations for the ArdaLink site.

Replaces build_placeholders.py's output — that script drew literal
"PLACEHOLDER — replace before launch" camera-icon cards, which meant
every visual on the live site announced itself as unfinished. These are
original, abstract/iconographic compositions (satellite beams, phone
silhouettes, chat bubbles) using the exact same brand tokens as
style.css — not photography (this repo has no access to real photos of
Isiolo herders or livestock, and fabricating stock-photo-style raster
images is out of scope), but not "under construction" placeholders
either. Team headshots remain a distinct, tasteful abstract-avatar style
(initials + geometric mark) since real photos of real people can't be
fabricated at all.

Generated into ardalink-marketing/site/assets/img/.
"""
from __future__ import annotations
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "assets" / "img"
OUT.mkdir(parents=True, exist_ok=True)

BG = "#0B0B12"
SURFACE = "#15151F"
SURFACE2 = "#1C1C28"
BORDER = "#2A2A38"
MUTED = "#A8A29E"
DIM = "#71717A"
FG = "#F5F5F4"
PRIMARY = "#F59E0B"
ACCENT = "#FF3C00"
OK = "#84CC16"
INFO = "#38BDF8"
DANGER = "#DC2626"
WHATSAPP = "#25D366"  # WhatsApp-evocative green — original bubble motif, not the Meta logo mark


def write(name: str, content: str) -> None:
    path = OUT / name
    path.write_text(content, encoding="utf-8")
    print(f"  {name}  ({len(content):,} bytes)")


def _card_bg(w: int, h: int) -> str:
    return f'''<defs>
    <linearGradient id="bg-{w}x{h}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="{SURFACE2}"/>
      <stop offset="1" stop-color="{BG}"/>
    </linearGradient>
  </defs>
  <rect width="{w}" height="{h}" fill="url(#bg-{w}x{h})"/>'''


# ── Hero: satellite beam over a savanna horizon, landing on a phone ─────────

def hero_savanna() -> str:
    w, h = 1600, 900
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0B0B12"/>
      <stop offset="0.55" stop-color="#1C1220"/>
      <stop offset="1" stop-color="{BG}"/>
    </linearGradient>
    <linearGradient id="ground" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#221A14"/>
      <stop offset="1" stop-color="#120D0A"/>
    </linearGradient>
    <linearGradient id="beam" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="{PRIMARY}" stop-opacity="0.55"/>
      <stop offset="1" stop-color="{PRIMARY}" stop-opacity="0"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="{PRIMARY}" stop-opacity="0.9"/>
      <stop offset="1" stop-color="{PRIMARY}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="{w}" height="{h}" fill="url(#sky)"/>
  <!-- stars -->
  <g fill="{FG}" opacity="0.5">
    <circle cx="120" cy="90" r="1.6"/><circle cx="260" cy="150" r="1.2"/>
    <circle cx="1400" cy="80" r="1.6"/><circle cx="1500" cy="180" r="1.2"/>
    <circle cx="900" cy="60" r="1.4"/><circle cx="700" cy="120" r="1.2"/>
    <circle cx="1200" cy="140" r="1.4"/><circle cx="60" cy="220" r="1.2"/>
  </g>
  <!-- satellite -->
  <g transform="translate(1180,150) rotate(18)">
    <rect x="-14" y="-6" width="28" height="12" rx="2" fill="{FG}"/>
    <rect x="-46" y="-3" width="28" height="18" rx="1.5" fill="{INFO}" opacity="0.85"/>
    <rect x="18" y="-3" width="28" height="18" rx="1.5" fill="{INFO}" opacity="0.85"/>
    <circle cx="0" cy="0" r="5" fill="{PRIMARY}"/>
  </g>
  <!-- signal beam from satellite down to phone -->
  <path d="M 1180 165 L 760 640 L 1000 640 L 1180 165 Z" fill="url(#beam)"/>
  <!-- rolling ground silhouette -->
  <path d="M 0 620 Q 250 560 480 610 T 900 600 T 1300 630 T 1600 600 L 1600 900 L 0 900 Z"
        fill="url(#ground)"/>
  <path d="M 0 660 Q 300 610 620 655 T 1100 650 T 1600 660 L 1600 900 L 0 900 Z"
        fill="{BG}" opacity="0.55"/>
  <!-- acacia silhouettes -->
  <g fill="#1A130E">
    <path d="M 220 660 L 224 600 L 216 600 Z"/>
    <ellipse cx="220" cy="592" rx="46" ry="14"/>
    <path d="M 1360 680 L 1364 610 L 1356 610 Z"/>
    <ellipse cx="1360" cy="602" rx="56" ry="16"/>
    <path d="M 1460 700 L 1463 650 L 1457 650 Z"/>
    <ellipse cx="1460" cy="645" rx="34" ry="10"/>
  </g>
  <!-- phone catching the signal -->
  <g transform="translate(880,650)">
    <rect x="-46" y="-90" width="92" height="180" rx="16" fill="{SURFACE}" stroke="{BORDER}" stroke-width="3"/>
    <rect x="-36" y="-76" width="72" height="140" rx="6" fill="{BG}"/>
    <circle r="70" fill="url(#glow)"/>
    <path d="M -18 -6 Q 0 -30 18 -6" stroke="{PRIMARY}" stroke-width="4" fill="none" stroke-linecap="round"/>
    <path d="M -28 4 Q 0 -40 28 4" stroke="{PRIMARY}" stroke-width="3" fill="none" stroke-linecap="round" opacity="0.6"/>
    <circle cy="10" r="6" fill="{PRIMARY}"/>
  </g>
</svg>'''


# ── Channel icons — phone silhouette + channel-specific motif ───────────────

def _phone_shell(w: int, h: int, accent: str) -> str:
    cx, cy = w / 2, h / 2 - 20
    return f'''{_card_bg(w, h)}
  <rect x="6" y="6" width="{w-12}" height="{h-12}" rx="18" fill="none" stroke="{BORDER}" stroke-width="1.4"/>
  <g transform="translate({cx},{cy})">
    <rect x="-110" y="-190" width="220" height="380" rx="30" fill="{SURFACE}" stroke="{BORDER}" stroke-width="3"/>
    <rect x="-92" y="-166" width="184" height="290" rx="10" fill="{BG}"/>
    <rect x="-24" y="-182" width="48" height="6" rx="3" fill="{BORDER}"/>
  </g>'''


def channel_voice() -> str:
    w, h = 800, 1000
    body = _phone_shell(w, h, ACCENT)
    cx, cy = w / 2, h / 2 - 20
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}">
  {body}
  <g transform="translate({cx},{cy})">
    <!-- waveform -->
    <g stroke="{ACCENT}" stroke-width="7" stroke-linecap="round">
      <line x1="-64" y1="-10" x2="-64" y2="10"/>
      <line x1="-40" y1="-30" x2="-40" y2="30"/>
      <line x1="-16" y1="-46" x2="-16" y2="46"/>
      <line x1="8" y1="-30" x2="8" y2="30"/>
      <line x1="32" y1="-52" x2="32" y2="52"/>
      <line x1="56" y1="-18" x2="56" y2="18"/>
    </g>
    <!-- handset glyph -->
    <g transform="translate(0,100)" stroke="{FG}" stroke-width="6" fill="none" stroke-linecap="round" stroke-linejoin="round">
      <path d="M -30 -14 C -30 -30 -14 -34 -6 -20 C -2 -13 -4 -8 -10 -4 C -6 8 2 16 14 20 C 18 14 23 12 30 16 C 44 24 40 40 24 40 C -4 40 -30 14 -30 -14 Z" fill="{ACCENT}" stroke="none"/>
    </g>
  </g>
  <text x="{w/2}" y="{h-40}" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="20" font-weight="700" fill="{FG}">Voice call</text>
</svg>'''


def channel_ussd() -> str:
    w, h = 800, 1000
    body = _phone_shell(w, h, INFO)
    cx, cy = w / 2, h / 2 - 20
    lines = ["1. Bula Pesa", "2. Malisho", "3. Ongea na AI", "4. Toka"]
    ty = cy - 70
    rows = ""
    for i, line in enumerate(lines):
        rows += (f'<text x="{cx-70}" y="{ty + i*34}" font-family="ui-monospace, SFMono-Regular, monospace" '
                  f'font-size="17" fill="{FG if i else INFO}">{line}</text>')
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}">
  {body}
  <text x="{cx-70}" y="{cy-110}" font-family="ui-monospace, SFMono-Regular, monospace" font-size="15" fill="{MUTED}">*123*8#</text>
  <line x1="{cx-70}" y1="{cy-96}" x2="{cx+70}" y2="{cy-96}" stroke="{BORDER}" stroke-width="1.5"/>
  {rows}
  <text x="{w/2}" y="{h-40}" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="20" font-weight="700" fill="{FG}">USSD *123*8#</text>
</svg>'''


def channel_sms() -> str:
    w, h = 800, 1000
    body = _phone_shell(w, h, PRIMARY)
    cx, cy = w / 2, h / 2 - 20
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}">
  {body}
  <!-- outgoing bubble -->
  <rect x="{cx-30}" y="{cy-110}" width="90" height="42" rx="14" fill="{PRIMARY}"/>
  <text x="{cx+15}" y="{cy-84}" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, monospace" font-size="18" font-weight="700" fill="{BG}">BULA</text>
  <!-- reply bubble -->
  <rect x="{cx-78}" y="{cy-50}" width="156" height="90" rx="14" fill="{SURFACE2}" stroke="{BORDER}" stroke-width="1.5"/>
  <text x="{cx}" y="{cy-24}" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="13" fill="{FG}">Bula Pesa: pasture</text>
  <text x="{cx}" y="{cy-4}" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="13" fill="{FG}">-38% vs normal.</text>
  <text x="{cx}" y="{cy+16}" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="13" fill="{PRIMARY}">Hatari: high.</text>
  <text x="{w/2}" y="{h-40}" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="20" font-weight="700" fill="{FG}">SMS keyword</text>
</svg>'''


def channel_whatsapp() -> str:
    w, h = 800, 1000
    body = _phone_shell(w, h, WHATSAPP)
    cx, cy = w / 2, h / 2 - 20
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}">
  {body}
  <!-- incoming bubble (herder) -->
  <rect x="{cx-84}" y="{cy-120}" width="150" height="46" rx="16" fill="{SURFACE2}" stroke="{BORDER}" stroke-width="1.5"/>
  <text x="{cx-9}" y="{cy-91}" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="14" fill="{FG}">Niko na ng'ombe</text>
  <!-- outgoing bubble (ArdaLink, WhatsApp-green) -->
  <rect x="{cx-56}" y="{cy-62}" width="150" height="72" rx="16" fill="{WHATSAPP}"/>
  <text x="{cx+19}" y="{cy-38}" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="13" font-weight="600" fill="#06210F">Tuma pin ya eneo</text>
  <text x="{cx+19}" y="{cy-20}" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="13" font-weight="600" fill="#06210F">lako 📍</text>
  <!-- location pin chip -->
  <g transform="translate({cx-20},{cy+40})">
    <circle r="16" fill="{WHATSAPP}" opacity="0.18"/>
    <path d="M0 -10 C 8 -10 13 -4 13 3 C 13 11 0 20 0 20 C 0 20 -13 11 -13 3 C -13 -4 -8 -10 0 -10 Z" fill="{WHATSAPP}"/>
    <circle r="4" fill="{BG}"/>
  </g>
  <text x="{w/2}" y="{h-40}" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="20" font-weight="700" fill="{FG}">WhatsApp</text>
</svg>'''


# ── How-it-works loop: satellite -> AI -> phone -> herder, one row ──────────

def how_it_works_loop() -> str:
    w, h = 1600, 600
    cy = h / 2 - 10
    xs = [220, 660, 1100, 1500]
    labels = ["Satellite", "ArdaLink AI", "Voice · USSD · SMS · WhatsApp", "Herder decides"]
    colors = [INFO, PRIMARY, ACCENT, OK]
    nodes = ""
    for x, label, c in zip(xs, labels, colors):
        nodes += f'''
  <circle cx="{x}" cy="{cy}" r="64" fill="{SURFACE2}" stroke="{c}" stroke-width="3"/>
  <text x="{x}" y="{cy+120}" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="19" font-weight="700" fill="{FG}">{label}</text>'''
    glyphs = f'''
  <!-- satellite glyph -->
  <g transform="translate({xs[0]},{cy})" fill="none" stroke="{INFO}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">
    <rect x="-8" y="-4" width="16" height="8" rx="1.5" fill="{FG}" stroke="none"/>
    <rect x="-30" y="-2" width="16" height="12" rx="1.5"/>
    <rect x="14" y="-2" width="16" height="12" rx="1.5"/>
  </g>
  <!-- AI / brief glyph -->
  <g transform="translate({xs[1]},{cy})" fill="none" stroke="{PRIMARY}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">
    <rect x="-26" y="-30" width="52" height="60" rx="8"/>
    <line x1="-14" y1="-10" x2="14" y2="-10"/>
    <line x1="-14" y1="2" x2="14" y2="2"/>
    <line x1="-14" y1="14" x2="4" y2="14"/>
  </g>
  <!-- phone/channels glyph -->
  <g transform="translate({xs[2]},{cy})" fill="none" stroke="{ACCENT}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">
    <rect x="-18" y="-32" width="36" height="64" rx="8"/>
    <line x1="-8" y1="24" x2="8" y2="24"/>
  </g>
  <!-- herder glyph -->
  <g transform="translate({xs[3]},{cy})" fill="none" stroke="{OK}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="0" cy="-18" r="12"/>
    <path d="M -20 30 C -20 6 20 6 20 30"/>
  </g>'''
    arrows = ""
    for a, b in zip(xs, xs[1:]):
        arrows += f'<path d="M {a+72} {cy} L {b-72} {cy}" stroke="{BORDER}" stroke-width="3" marker-end="url(#arrow)"/>'
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}">
  <defs>
    <marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto">
      <path d="M0,0 L10,5 L0,10 Z" fill="{BORDER}"/>
    </marker>
  </defs>
  <rect width="{w}" height="{h}" fill="{BG}"/>
  {arrows}
  {nodes}
  {glyphs}
</svg>'''


# ── Problem section: cracked earth + pasture-stress overlay ────────────────

def drought_landscape() -> str:
    w, h = 1200, 700
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}">
  {_card_bg(w, h)}
  <path d="M 0 420 Q 300 380 600 410 T 1200 400 L 1200 700 L 0 700 Z" fill="#2A1E12"/>
  <g stroke="#1A1208" stroke-width="3" fill="none" opacity="0.8">
    <path d="M 120 470 L 180 520 L 150 580"/>
    <path d="M 400 450 L 460 510 L 420 560 L 470 600"/>
    <path d="M 700 480 L 640 530 L 690 590"/>
    <path d="M 950 460 L 1010 520 L 970 570"/>
  </g>
  <!-- pasture-health stress readout, top-right -->
  <g transform="translate({w-260},60)">
    <rect width="220" height="120" rx="12" fill="{SURFACE}" stroke="{BORDER}"/>
    <text x="16" y="34" font-family="Inter, sans-serif" font-size="13" fill="{MUTED}">Pasture vs normal</text>
    <text x="16" y="76" font-family="Inter, sans-serif" font-size="34" font-weight="800" fill="{DANGER}">-38%</text>
    <text x="16" y="100" font-family="Inter, sans-serif" font-size="12" fill="{DANGER}">Severity: high</text>
  </g>
  <text x="40" y="{h-40}" font-family="Inter, sans-serif" font-size="16" fill="{MUTED}">Isiolo County, dry season</text>
</svg>'''


def lost_livestock() -> str:
    w, h = 800, 800
    cx, cy = w / 2, h / 2 + 20
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}">
  {_card_bg(w, h)}
  <path d="M 0 560 Q 200 520 400 550 T 800 540 L 800 800 L 0 800 Z" fill="#241A10"/>
  <g transform="translate({cx},{cy})" fill="none" stroke="{MUTED}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
    <ellipse cx="0" cy="10" rx="90" ry="46"/>
    <path d="M -70 -10 C -90 -30 -80 -60 -55 -55 C -40 -70 -10 -68 5 -50"/>
    <circle cx="-70" cy="-40" r="18"/>
    <line x1="-55" y1="34" x2="-55" y2="70"/>
    <line x1="-10" y1="40" x2="-10" y2="78"/>
    <line x1="40" y1="38" x2="42" y2="76"/>
    <line x1="75" y1="24" x2="80" y2="60"/>
  </g>
  <g fill="{DANGER}" opacity="0.85">
    <circle cx="{cx-88}" cy="{cy-52}" r="4"/>
    <text x="{cx-70}" y="{cy-90}" font-family="Inter, sans-serif" font-size="14" fill="{DANGER}">Body condition: thin</text>
  </g>
  <text x="40" y="{h-40}" font-family="Inter, sans-serif" font-size="16" fill="{MUTED}">The cost of a missed signal</text>
</svg>'''


# ── Business-model visuals ───────────────────────────────────────────────────

def phase1_trust() -> str:
    w, h = 1000, 700
    cx, cy = w / 2, h / 2 - 10
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}">
  {_card_bg(w, h)}
  <text x="60" y="70" font-family="Inter, sans-serif" font-size="15" font-weight="700" letter-spacing="2" fill="{OK}">PHASE 1</text>
  <text x="60" y="104" font-family="Inter, sans-serif" font-size="26" font-weight="800" fill="{FG}">Earn trust — free brief, free call, free data</text>
  <g transform="translate({cx},{cy+60})">
    <circle r="90" fill="none" stroke="{OK}" stroke-width="4" stroke-dasharray="4 8"/>
    <g fill="none" stroke="{OK}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="0" cy="-30" r="16"/>
      <path d="M -26 40 C -26 8 26 8 26 40"/>
    </g>
    <path d="M 60 -30 L 110 -30" stroke="{BORDER}" stroke-width="3" marker-end="url(#arrow1)"/>
  </g>
  <defs><marker id="arrow1" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M0,0 L10,5 L0,10 Z" fill="{BORDER}"/></marker></defs>
  <g transform="translate({cx+210},{cy+30})">
    <rect x="-70" y="-40" width="140" height="90" rx="12" fill="{SURFACE}" stroke="{BORDER}"/>
    <text x="0" y="-12" text-anchor="middle" font-family="Inter, sans-serif" font-size="13" fill="{MUTED}">Cost to herder</text>
    <text x="0" y="24" text-anchor="middle" font-family="Inter, sans-serif" font-size="30" font-weight="800" fill="{OK}">KES 0</text>
  </g>
</svg>'''


def phase2_marketplace() -> str:
    w, h = 1000, 700
    cx, cy = w / 2, h / 2 - 10
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}">
  {_card_bg(w, h)}
  <text x="60" y="70" font-family="Inter, sans-serif" font-size="15" font-weight="700" letter-spacing="2" fill="{ACCENT}">PHASE 2</text>
  <text x="60" y="104" font-family="Inter, sans-serif" font-size="26" font-weight="800" fill="{FG}">Marketplace — match a buyer or feed seller</text>
  <g transform="translate({cx-150},{cy+60})" fill="none" stroke="{ACCENT}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="0" cy="-30" r="16"/>
    <path d="M -26 40 C -26 8 26 8 26 40"/>
  </g>
  <path d="M {cx-90} {cy+30} L {cx+90} {cy+30}" stroke="{BORDER}" stroke-width="3" marker-end="url(#arrow2)" marker-start="url(#arrow2r)"/>
  <defs>
    <marker id="arrow2" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M0,0 L10,5 L0,10 Z" fill="{BORDER}"/></marker>
    <marker id="arrow2r" markerWidth="10" markerHeight="10" refX="2" refY="5" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 Z" fill="{BORDER}"/></marker>
  </defs>
  <g transform="translate({cx+150},{cy+60})" fill="none" stroke="{PRIMARY}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
    <rect x="-24" y="-24" width="48" height="48" rx="8"/>
    <path d="M -10 0 L -2 10 L 12 -10"/>
  </g>
  <g transform="translate({cx},{cy+150})">
    <rect x="-90" y="-26" width="180" height="52" rx="26" fill="{SURFACE}" stroke="{BORDER}"/>
    <text x="0" y="6" text-anchor="middle" font-family="Inter, sans-serif" font-size="14" fill="{MUTED}">Small commission on the deal</text>
  </g>
</svg>'''


# ── Demo-flow step glyphs ────────────────────────────────────────────────────

STEP_GLYPHS = {
    1: ("M -10 -26 L 10 -26 L 10 26 L -10 26 Z", "dial"),   # phone
    2: ("M -22 0 L -6 16 L 22 -16", "pick"),                 # checkmark
    3: ("M -22 -14 L 22 -14 L 22 10 L 0 10 L -8 20 L -8 10 L -22 10 Z", "reply"),  # chat bubble
    4: ("M -18 -14 C -18 -22 -10 -24 -4 -14 C 0 -8 -2 -4 -8 0 C -4 10 4 16 14 18 C 18 12 22 12 26 16 C 34 22 30 32 18 32 C -4 32 -22 8 -18 -14 Z", "call"),  # handset
    5: ("M -20 10 A 20 20 0 1 1 20 10", "remember"),         # loop arc
}


def step_icon(n: int) -> str:
    w = h = 400
    path, _ = STEP_GLYPHS[n]
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}">
  <circle cx="{w/2}" cy="{h/2}" r="140" fill="{SURFACE}" stroke="{PRIMARY}" stroke-width="3"/>
  <g transform="translate({w/2},{h/2})" fill="none" stroke="{PRIMARY}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round">
    <path d="{path}"/>
  </g>
</svg>'''


# ── Team avatars — abstract geometric mark + initial, not a photo ──────────

TEAM = {
    "founder": ("F", OK),
    "operations": ("O", INFO),
    "domain": ("D", ACCENT),
    "developer": ("Dv", PRIMARY),
}


def team_avatar(role: str) -> str:
    w, h = 600, 700
    initial, color = TEAM[role]
    cx, cy = w / 2, h / 2 - 20
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}">
  {_card_bg(w, h)}
  <circle cx="{cx}" cy="{cy}" r="120" fill="{SURFACE}" stroke="{color}" stroke-width="4"/>
  <text x="{cx}" y="{cy+45}" text-anchor="middle" font-family="Inter, sans-serif" font-size="90" font-weight="800" fill="{color}">{initial}</text>
  <text x="{w/2}" y="{h-50}" text-anchor="middle" font-family="Inter, sans-serif" font-size="14" fill="{DIM}" letter-spacing="1">PHOTO PENDING</text>
</svg>'''


def main() -> None:
    print(f"Writing illustrations to {OUT}\n")
    write("hero-savanna.svg", hero_savanna())
    write("channel-voice.svg", channel_voice())
    write("channel-ussd.svg", channel_ussd())
    write("channel-sms.svg", channel_sms())
    write("channel-whatsapp.svg", channel_whatsapp())
    write("how-it-works-loop.svg", how_it_works_loop())
    write("drought-landscape.svg", drought_landscape())
    write("lost-livestock.svg", lost_livestock())
    write("phase1-trust.svg", phase1_trust())
    write("phase2-marketplace.svg", phase2_marketplace())
    for n in range(1, 6):
        write(f"step-{n}.svg", step_icon(n))
    for role in TEAM:
        write(f"team-{role}.svg", team_avatar(role))
    print(f"\n{len(list(OUT.glob('*.svg')))} files in {OUT}")


if __name__ == "__main__":
    main()
