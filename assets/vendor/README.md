# Vendored third-party assets

Bundled locally so the app works offline and makes no third-party requests at
launch (see the CSP in `src/renderer/index.html`). All licenses permit
redistribution bundled with this application; the license texts below ship in
the packaged app (`build.files` includes `assets/**`).

| Component | Version | License | Text |
|---|---|---|---|
| Leaflet | 1.9.4 | BSD-2-Clause | `leaflet/LICENSE.txt` |
| iro.js (color picker) | 5.5.2 | MPL-2.0 | `LICENSE-iro.txt` |
| Noto Sans | Google Fonts (2026-06) | SIL OFL 1.1 | `fonts/OFL-NotoSans.txt` |
| Noto Sans Mono | Google Fonts (2026-06) | SIL OFL 1.1 | `fonts/OFL-NotoSansMono.txt` |
| Material Symbols Outlined | Google Fonts (2026-06) | Apache-2.0 | `fonts/LICENSE-MaterialSymbols.txt` |

Notes:
- `fonts/fonts.css` is generated from Google Fonts' css2 output with URLs
  rewritten to the local `.woff2` files alongside it.
- OFL fonts may not be sold standalone but may be bundled with software,
  including commercial software, as done here.
- To update a component: replace the files, keep (or refresh) its license
  text, and update this table.
