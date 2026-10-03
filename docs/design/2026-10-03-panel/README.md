# Side panel redesign (2026-10-03)

Hunter picked the **Quiet** direction, with Companion's bottom nav and its inline review card. The mark is **A · Sightline**: a ring with a blue dot up and to the right.

The files here are static mockups in the Design canvas format (`.dc.html`: HTML with inline styles, plus a small template wrapper). Read them for the look, the tokens and the layout. Don't copy them into the extension.

| File | What it shows |
|---|---|
| `QuietNav.dc.html` | The default Page view: links, review pill, context tray, suggestions switch, pill nav |
| `QuietReview.dc.html` | The Page view with a file review open (inline approval card) |
| `Logo.dc.html` | Mark options A, B and C, with A chosen; toolbar states (idle, watching, link count, file to review, paused) and the Mac menu-bar template icon |
| `Quiet.dc.html`, `Companion.dc.html` | The two parent directions, for reference |

## Tokens

- **Font:** Figtree. Bundle it locally (MV3 CSP forbids remote fonts); fall back to `system-ui`.
- **Colors:**

  | Role | Value |
  |---|---|
  | Ink | #1B1F24 |
  | Muted | #5E6772 (#4A535E where contrast needs it) |
  | Surface | #F2F5FA |
  | Line | #DCE2EA |
  | Accent | #1F5FCC |
  | Attention | #E8890C (dot), #A35D00 (text and badge) |
  | Ground | white |

- **Dark mode:** a matching dark set at AA contrast.
- **Radii:**

  | Element | Radius |
  |---|---|
  | Link card | 20 |
  | Review card | 24 |
  | Pill nav | 999 |
  | Tray | 24 |
  | Tray inner row | 16 |

- **Motion:** 150–200 ms, honouring `prefers-reduced-motion`.
