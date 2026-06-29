#!/usr/bin/env python3
"""Generate photo-placeholder SVGs for the ArdaLink site.

Each placeholder is a clean gray card with:
  - a small camera icon
  - a label describing what photo to drop in
  - a faint aspect-ratio indicator

Generated into ardalink-marketing/site/assets/img/.
"""
from __future__ import annotations
from pathlib import Path
from xml.sax.saxutils import escape

OUT = Path(__file__).resolve().parents[1] / "assets" / "img"
OUT.mkdir(parents=True, exist_ok=True)

BG = "#15151F"
SURFACE = "#1C1C28"
BORDER = "#2A2A38"
MUTED = "#A8A29E"
DIM = "#71717A"
FG = "#F5F5F4"
PRIMARY = "#F59E0B"
ACCENT = "#FF3C00"


def placeholder(w: int, h: int, label: str, sub: str | None = None,
                accent: str = PRIMARY) -> str:
    """A clean placeholder card with a camera glyph + caption."""
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" \
preserveAspectRatio="xMidYMid slice">
  <defs>
    <linearGradient id="phbg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="{SURFACE}"/>
      <stop offset="1" stop-color="{BG}"/>
    </linearGradient>
    <pattern id="phgrid" width="20" height="20" patternUnits="userSpaceOnUse">
      <path d="M 20 0 L 0 0 0 20" fill="none" stroke="{BORDER}" stroke-width="0.6"/>
    </pattern>
  </defs>
  <rect width="{w}" height="{h}" fill="url(#phgrid)"/>
  <rect width="{w}" height="{h}" fill="url(#phbg)" opacity="0.7"/>
  <rect x="6" y="6" width="{w - 12}" height="{h - 12}" rx="10" \
fill="none" stroke="{BORDER}" stroke-width="1.4" stroke-dasharray="6 5"/>
  <!-- camera glyph -->
  <g transform="translate({w/2 - 30}, {h/2 - 50})" fill="none" \
stroke="{MUTED}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
    <path d="M 12 14 L 18 8 L 42 8 L 48 14 L 60 14 \
A 4 4 0 0 1 64 18 L 64 50 \
A 4 4 0 0 1 60 54 L 4 54 \
A 4 4 0 0 1 0 50 L 0 18 \
A 4 4 0 0 1 4 14 Z"/>
    <circle cx="32" cy="34" r="11"/>
    <circle cx="32" cy="34" r="5" fill="{accent}" stroke="none"/>
  </g>
  <!-- label -->
  <text x="{w/2}" y="{h/2 + 24}" text-anchor="middle" \
font-family="Inter, system-ui, sans-serif" font-size="14" font-weight="700" \
fill="{FG}">{escape(label)}</text>
  {f'<text x="{w/2}" y="{h/2 + 46}" text-anchor="middle" '
   f'font-family="Inter, system-ui, sans-serif" font-size="11" '
   f'fill="{MUTED}">{escape(sub)}</text>' if sub else ''}
  <!-- corner tag -->
  <g transform="translate({w - 100}, 14)">
    <rect x="0" y="0" width="86" height="22" rx="11" \
fill="{SURFACE}" stroke="{BORDER}"/>
    <text x="43" y="15" text-anchor="middle" \
font-family="Inter, system-ui, sans-serif" font-size="10" font-weight="700" \
letter-spacing="1.5" fill="{DIM}">PLACEHOLDER</text>
  </g>
  <!-- aspect tag -->
  <text x="14" y="{h - 14}" \
font-family="Inter, system-ui, sans-serif" font-size="10" \
fill="{DIM}" letter-spacing="1">{w} × {h}</text>
</svg>'''


def write(name: str, content: str) -> None:
    path = OUT / name
    path.write_text(content, encoding="utf-8")
    print(f"  ✓ {name}  ({len(content):,} bytes)")


def main() -> None:
    print(f"Writing placeholders to {OUT.relative_to(Path.cwd())}/\n")

    # Hero scene — herder + landscape
    write("hero-savanna.svg", placeholder(
        1600, 900,
        "Photo: herders on a Bula Pesa ridge at dusk",
        "replace with real photo before launch",
        accent=PRIMARY,
    ))

    # Three channel visuals — phone screens
    write("channel-voice.svg", placeholder(
        800, 1000,
        "Visual: a phone receiving an ArdaLink voice call",
        "in Swahili, with a small speech waveform",
        accent=ACCENT,
    ))
    write("channel-ussd.svg", placeholder(
        800, 1000,
        "Visual: a USSD menu (*123*8#) on a feature phone",
        "Bula Pesa · Malisho · Ongea",
        accent=INFO if (INFO := "#38BDF8") else PRIMARY,
    ))
    write("channel-sms.svg", placeholder(
        800, 1000,
        "Visual: an SMS conversation with ArdaLink",
        "BULA → brief reply, single segment",
        accent=PRIMARY,
    ))

    # Problem visuals
    write("drought-landscape.svg", placeholder(
        1200, 700,
        "Photo: cracked earth, dry riverbed, Isiolo County",
        "aerial or ground level",
        accent=ACCENT,
    ))
    write("lost-livestock.svg", placeholder(
        800, 800,
        "Photo: a thin cow at the edge of a dry pasture",
        "the cost of drought, told in one frame",
        accent=ACCENT,
    ))

    # Business model visuals
    write("phase1-trust.svg", placeholder(
        1000, 700,
        "Visual: a herder trusting ArdaLink — first call",
        "free brief, free call, free data",
        accent=OK if (OK := "#84CC16") else PRIMARY,
    ))
    write("phase2-marketplace.svg", placeholder(
        1000, 700,
        "Visual: a herder finding a buyer or feed seller",
        "ArdaLink matches; small commission on the deal",
        accent=ACCENT,
    ))

    # Team headshots (4 placeholders, named TBD)
    for i, role in enumerate([
        "founder", "operations", "domain", "developer",
    ], 1):
        write(f"team-{role}.svg", placeholder(
            600, 700,
            f"Headshot #{i}",
            "replace with real photo + name before launch",
            accent=PRIMARY,
        ))

    # How-it-works loop visual (single composite placeholder)
    write("how-it-works-loop.svg", placeholder(
        1600, 600,
        "Diagram: satellite → AI → phone → herder",
        "the whole product in one picture",
        accent=PRIMARY,
    ))

    # Demo-flow icons — small phones for the 5 steps
    for i in range(1, 6):
        write(f"step-{i}.svg", placeholder(
            400, 400,
            f"Icon: step {i}",
            "small phone/screen glyph",
            accent=PRIMARY,
        ))

    print(f"\n  {len(list(OUT.glob('*.svg')))} files generated.")


if __name__ == "__main__":
    main()