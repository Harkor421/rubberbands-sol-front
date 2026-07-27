# Rubberbands & More, frontend (Solana)

Hold **$RBM**. Get **$1**. Every 5 minutes. Single-page React 19 / Vite 7
site for the Rubberbands & More dispenser on Solana
(`rubberbands-sol-back`): centered hero, the drawer strip (live drawer +
next-drop countdown in one wide band), lore section (Robinhood's
dividend article invented the company), stat strip, animated
how-it-works diagram, and "the books": the paid feed side by side with
"The line", the full ranked holder list (scrollable, search-as-you-type
wallet filter + exact-match spot card), all over the backend's
WebSocket, with an offline demo mode. Eligibility is open (min 0%), so
the stat strip shows holders / holders paid / $ paid, no "in line"
stat.

> **For the next agent:** no framework beyond React, no UI deps, no
> state library. One component file, one stylesheet. Read "Wiring" and
> "File map" and you know the whole app.

## Deployed state

| Thing | Where |
|---|---|
| Production | TBD |
| Deploy | TBD |
| Backend | TBD (Railway); until the domain exists the code carries the placeholder `wss://rubberbands-sol-back-production.up.railway.app`, patch it in `src/App.jsx` or via `VITE_WS_URL` |

## Wiring (the pinned WS contract)

`src/App.jsx` opens one WebSocket to the backend and consumes five
message types. Field names are the contract, character for character.
The ETH-era names (`potEth`, `ethUsd`, `paidEthTotal`, `payment.eth`)
are gone; the Solana backend emits `potSol`, `solUsd`, `paidSolTotal`,
`payment.sol`.

- `service_status`: `{type, running, ca, ts}`
- `holders_update`: `{type, holders: [{owner (base58 string), rank,
  amount, percentage, rawBalance (string), paidUsd, paidCount}],
  totalHolders, eligibleHolders, totalSupply, mint, minEligiblePct, ts}`
- `cycle_state`: `{type, potSol, potUsd, solUsd, payoutUsd, payEveryMs,
  nextPayTs, budgetPct, coverage, eligibleHolders, paidUsdTotal,
  paidSolTotal, payoutsTotal, mcapUsd (may be null), running, dryRun,
  minEligiblePct, ts}`
- `payments_update`: `{type, payments: [{to, usd, sol, rank, sig, ts}]}`
- `distribution_result`: `{type, count, totalUsd, totalSol, eligible,
  coveredThrough, ranOut, ts}`

Addresses are base58 and **case sensitive**: the wallet lookup and the
line filter compare exactly as typed (trim only, no lowercasing).

If the socket doesn't connect within 1.2s the site enters **demo
mode**: fake base58 holders, a placeholder mint, a self-refilling pot,
a $1 burst every 45s, so the page always looks alive. Reconnects with
backoff; demo exits (and drops the placeholder mint) the moment the
real socket opens.

Env overrides (all optional, Vite-style):

| Var | Default | |
|---|---|---|
| `VITE_WS_URL` | `wss://rubberbands-sol-back-production.up.railway.app` | placeholder, patch after the Railway domain exists |
| `VITE_CA` | (unset) | pin the mint CA (else it arrives over WS) |
| `VITE_BUY_URL` | `https://pump.fun` | GET $RBM button target; with a CA the link is `/coin/{CA}` |
| `VITE_EXPLORER` | `https://solscan.io` | `/account/{addr}` and `/tx/{sig}` links |
| `VITE_TICKER` | `RBM` | display ticker |

## Design system (the whole aesthetic in one place)

Chroma-green claymation office supplies, from the brand art:

- Palette: CSS vars at the top of `src/index.css`. `--green #3ec504`
  backdrop, `--paper #f4eec6` cards, `--teal/#17786a` +
  `--teal-deep/#0d5c50` ink and 3D extrusion, `--yellow #ffd21f` money,
  pin accents `--blue`/`--red`, `--band #e2cb79` rubber tan.
- Solana accent: `--purple #8f4bf2` / `--purple-deep #6d2fd0`, a
  claymation take on Solana's #9945FF. Used sparingly: a couple of
  pushpins (hero deco, factoid, one rain pin), the diagram's step-02
  badge, the lavender "ON SOLANA" item in the tape, and the middle stat
  card (`.stat-pop`, purple paper with cream ink). The old purple hero
  sticker is gone; the tape carries the Solana callout now. The yellow stays the money color; the purple is the
  partner accent, not a takeover.
- Type: **Titan One** display (class `.ext`/`.h2`/`.mega-line` adds the
  6-step teal extrusion text-shadow), **Nunito** body, **JetBrains
  Mono** numbers. Loaded in `index.html`.
- Kit: cream sticker cards with 3px teal border + hard offset shadow
  (`--hard`), slight rotations, pushpins on cards, dashed dividers,
  ruled legal-pad background on the feed, googly eyes on everything.
- Backdrop stack (bottom-up): compacted dot grid that slow-breathes
  (`body::before`, two offset 18px grids, `dots-breathe` 7s
  opacity+scale pulse), studio-light vignette (`body::after`), then the
  office-supply rain. Static at 0.7 opacity under reduced-motion.
- Copy rule: **no em dashes in visible text** (owner preference); use
  commas or periods.
- Distribution toasts slide in and out; each one plays a synthesized
  cash-register chime (Web Audio triangle arpeggio, no audio assets).
  Mute toggle in the nav persists to localStorage key `rbm-sound`;
  audio unlocks on the first tap per browser autoplay policy.

## File map

```
index.html        fonts, meta, favicon (public/logo.svg)
src/main.jsx      React root
src/index.css     all styling: tokens -> sections -> diagram (.fig-*) -> rain -> responsive
src/App.jsx       everything else:
  App             ws + demo mode + derived state + page layout
  FallingBits     low-opacity office-supply rain (fixed layer, z0)
  HowDiagram      the animated mechanic scene (SVG; timings live in CSS @keyframes fig-*)
  Sticker         SVG rect with the hard-offset sticker look
  BandBall        mascot (googly-eyed rubberband ball; bare = no face)
  BandLoop / Pin / Smiley   small props
  SpotResult      the your-spot-in-line card (shown on exact wallet match)
  Reveal          IntersectionObserver blur-fade (Magic UI style, no deps)
  useNow / useCountUp / fmt* helpers
public/logo.svg   favicon + og mark (swap for rendered art if provided)
public/dividends-article.jpg   Robinhood Learn screenshot for the #lore
                  section (source of the name; highlights baked into the
                  image)
```

### Page order (top to bottom)

1. Tape ticker (the "ON SOLANA" lavender item lives here).
2. Nav: sound toggle, The lore -> `#lore`, How it works -> `#how`,
   The books -> `#books`, GET $RBM.
3. Hero: one centered column, ~720px (`.hero` is flex-column now, no
   `.hero-l`): eyebrow, mega headline, sub copy, CTA row, CA button,
   factoid, all center-aligned.
4. The drawer strip (`.drawer-strip` > `.drawer.drawer-wide`): the
   pinned paper card stretched full width. `.drawer-flex` puts the
   countdown huge on the left (clock up to ~80px) and the four drawer
   rows as compact stat cells (`.dr` restyled) on the right. Under
   900px it folds back into the classic vertical drawer card.
5. The lore (`#lore`).
6. Stat strip: three cards, 28px mono numbers, alternating tilts, the
   middle card is `.stat-pop` (purple, cream text).
7. How it works (`#how`): the animated diagram.
8. The books (`#books`, `.books-grid`): paid feed (PAID SO FAR + total)
   left, THE LINE (search, list, legend) right. Under 900px they stack
   in that order. The columns keep ids `#paid` / `#spot` for old links.
9. Footer: mascot, wallet-agnostic tagline, three BandLoop squiggles,
   copyright.

### The lore section (`#lore`)

The name and the $1 mechanic come from Robinhood Learn's "What is a
stock dividend?" article (`ARTICLE_URL` in `App.jsx`), which uses "the
fictional company Rubberbands & More" declaring "a cash dividend of $1
per share" as its example. The section quotes that line (`<mark>`
highlights matching the screenshot) next to the pinned screenshot, and
the hero factoid + "The lore" nav link both anchor to it. The lore is
about the name, not the chain; it stays on Solana.

### The animated diagram (`HowDiagram` + `.fig-*` CSS)

One 9s master loop, all in CSS keyframes so React never re-renders for
it: ◎ coins drip into the drawer (3s stream), the cash level rises, the
5-min dial sweeps, "÷ $1 = N payouts" pops, three $1 bills fly to the
ranked chips (biggest bag first) with "+$1.00" pops, and the dashed #4
chip gets "next round ↻" when the drawer runs dry. Bill flight
coordinates are absolute viewBox translates in `fig-bill1..3`; if you
move chips in the JSX, update those keyframes. Diagram scrolls
horizontally under 780px; reduced-motion gets a static story frame.

### The rain (`FallingBits` + `.rain-*`)

16 hand-placed sprites (bands, pins, clips, erasers, $1 bills) falling
at 10-14% opacity, transform-only, negative delays so it's mid-flight
on load. Thinned to half under 560px, `display:none` under
reduced-motion.

## Dev

```bash
npm i
npm run dev      # local; without a reachable backend it runs demo mode
npm run build    # dist/
```

Point `VITE_WS_URL` at `ws://localhost:8080` to develop against a local
`DRY_RUN=true` backend.
