# AcroGym Brand Assets

## Files in this folder

| File | Purpose |
|------|---------|
| `brand.json` | Central brand config (colors, fonts, logo paths). Loaded by all reporting agents. |
| `logo.svg` | Main logo, vector. Use for PDF/HTML reports. |
| `logo.png` | Main logo, raster (transparent background). Use for chart watermarks, PPTX. |
| `logo-white.png` | White logo for dark backgrounds. |
| `logo-avatar-orange.jpg` | Square logo on orange background — for social media avatars / chat profile pic. |
| `logo-avatar-blue.jpg` | Square logo on blue background — alternative for social. |

## Colors (use HEX from brand.json)

- 🔵 **#28347F** — Primary Blue (reliability, trust)
- 🟠 **#F37021** — Primary Orange (energy, movement)
- ⚪ **#FFFFFF** — White

## Fonts

- **Montserrat** — used for both body and headings (Black weight for headings)
- Original brandbook specifies Gerhaus for headings, but it's paid; Montserrat Black is a clean free substitute.
- Install: `npm install @fontsource/montserrat` (already loaded via Google Fonts CDN for HTML reports)

## Usage in code

```javascript
const brand = require('./config/brand/brand.json');

// Chart colors
chart.options.colors = brand.chart_palette.series;

// Logo path for PPTX
const logoPath = brand.logo.png_color;
```

## DO NOT

- Don't change logo colors (only brand colors allowed)
- Don't rotate the logo
- Don't separate the icon from the wordmark in main version
- Don't add shadows/effects to the logo
