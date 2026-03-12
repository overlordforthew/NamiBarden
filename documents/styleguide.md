# NamiBarden — Styleguide

## Visual Identity
Elegant, mindful luxury coaching brand. Warm earth tones, serif typography, bilingual (JP/EN). The aesthetic communicates spiritual depth and calm authority — not clinical, not corporate, not trendy.

## Color Palette

| Role | Name | Hex |
|------|------|-----|
| Page background | Cream | `#FAF7F2` |
| Section background (alt) | Cream Dark | `#F0EAE0` |
| Section background (deep) | Cream Darker | `#E8DFD3` |
| Borders / subtle highlights | Warm Beige | `#D4C5B2` |
| Primary accent / interactive | Gold | `#C4A882` |
| Gold hover state | Gold Dark | `#A8895E` |
| Primary text | Text Dark | `#2C2419` |
| Secondary text | Text Medium | `#5C4F3D` |
| Muted text | Text Light | `#8B7E6E` |
| Barely visible text | Text Muted | `#A99E8F` |
| Cards / overlays | White | `#FFFFFF` |
| Nature accent | Sage | `#B8C4A8` |
| Sage (light) | Sage Light | `#D4DDCA` |
| Dark section backgrounds | Brown Deep | `#2A1C10` |

Overlay: `rgba(44, 36, 25, 0.6)` for dark overlays on hero images.

**Never** use flat grays, neon colors, or cool blues — they break the warmth of the brand.

## Typography

### Fonts
- **Display / Headings (EN):** Playfair Display (serif) — weight 500–600
- **Body (EN):** Cormorant Garamond — weight 400–500
- **UI labels (EN):** Raleway — weight 300–400, light
- **Headings (JP):** Noto Serif JP
- **Body/UI (JP):** Noto Sans JP

### Sizes
- H1: `clamp(2.2rem, 5vw, 3.5rem)`
- H2: `clamp(1.8rem, 3.5vw, 2.8rem)`
- H3: `clamp(1.2rem, 2vw, 1.5rem)`
- Body (EN): 16px / 1.05rem
- Body (JP): 15px
- Labels: 0.75–0.85rem, uppercase, letter-spacing 0.15–0.25em, weight 500–600

### Rules
- Line height: 1.5–1.9 (generous — never cramped)
- Headings always Playfair Display in English
- Labels are always uppercase with generous letter spacing
- Avoid bold weights above 600 — it feels harsh against the brand

## Spacing

- Section vertical padding: 100px
- Container max width: 1200px
- Container horizontal padding: 40px
- Card padding: 24–48px (varies by card size)
- Button padding: 14px vertical × 36px horizontal

## Components

### Buttons
- Default style: transparent background, 1.5px solid border (`Text Dark` color), 0.88rem font
- Primary filled: Gold (`#C4A882`) background, white text, Gold Dark on hover
- Animation: sliding background fill from left, 0.4s `cubic-bezier(0.25, 0.46, 0.45, 0.94)` — smooth, never snappy
- Text: uppercase, letter-spacing 0.15em

### Cards
- Background: White `#FFFFFF`
- Border radius: 12px (stat cards) / 16px (login)
- Shadow: `0 2px 12px rgba(0,0,0,0.04)` — very subtle
- Border: 1px solid `#e8e4de` (bottom only in most cases)
- Padding: 24px body, 20px header

### Forms
- Input padding: 10px
- Border: 1px solid `#e8e4de`
- Border radius: 8px
- Focus: border-color → Gold `#C4A882`
- Font: 0.9rem

### Navigation
- Backdrop: `blur(20px)` — frosted glass effect
- Never opaque white — always semi-transparent against the cream background

## Animation
- Standard easing: `cubic-bezier(0.25, 0.46, 0.45, 0.94)`
- Standard duration: 0.4s
- Transitions feel graceful and meditative — never jumpy or bouncy
- Decorative gradients: radial, `rgba` with ~0.08 opacity max

## Bilingual Rules
- Language toggle in nav, stored in localStorage
- JP layout may require slightly different font sizes and spacing (15px body vs 16px)
- Serif (Noto Serif JP) for headings, sans-serif (Noto Sans JP) for UI elements in JP
- Never use Playfair Display or Cormorant Garamond for Japanese text

## What to Avoid
- Cool/gray backgrounds — keep everything in the warm cream/beige range
- Heavy drop shadows — max `rgba(0,0,0,0.06)` opacity
- Angular/sharp design — minimum 4px border radius everywhere
- Bright or saturated colors — gold is the only accent, sage for nature touches
- Sans-serif headings in English — always serif for display text
