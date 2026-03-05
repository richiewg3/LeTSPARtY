# AGENTS.md

## Cursor Cloud specific instructions

This repository ("LeTSPARtY") is a collection of different ideas, apps, and silly projects.

### Palette Detective

The main project is `gb_studio_palette_detective_v_7_light→dark_palette_order_fix.html` — a single-file HTML/CSS/JS app (no build step, no dependencies).

- **Run**: Open the HTML file directly in a browser, or serve via any static HTTP server (e.g. `python3 -m http.server 8000`).
- **No build/lint/test commands.** The app is a single self-contained HTML file.
- **No package manager lockfiles exist.** No external dependencies are used.
- **Persistence**: Session data is stored in IndexedDB (`PaletteDetectiveDB`). Refresh Mode preference is in `localStorage` (`pd_refreshMode`).
