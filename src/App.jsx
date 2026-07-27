import React, { useEffect, useId, useMemo, useRef, useState } from "react";

/**
 * Rubberbands & More — hold the coin, collect the dollar. Solana edition.
 * The drawer accumulates SOL (creator fees). Every 5 minutes it hands $1 of
 * SOL to every holder — biggest bags first — until it runs out. Live over
 * WebSocket (rubberbands-sol-back); demo offline.
 */

// placeholder URL: patched to the real Railway domain once the backend deploys
const WS_URL = import.meta.env.VITE_WS_URL || "wss://rubberbands-sol-back-production.up.railway.app";
const STATIC_CA = import.meta.env.VITE_CA || "";
const BUY_BASE = (import.meta.env.VITE_BUY_URL || "https://pump.fun").replace(/\/$/, "");
const EXPLORER = (import.meta.env.VITE_EXPLORER || "https://solscan.io").replace(/\/$/, "");
const TICKER = (import.meta.env.VITE_TICKER || "RBM").toUpperCase();
// base58-looking placeholder mint for demo mode (cleared when the real socket opens)
const DEMO_CA = "RBMDemoDrawer" + "1".repeat(31);
const ARTICLE_URL = "https://robinhood.com/us/en/learn/articles/7ga0kbX9jN3blenJmOPPQ/what-is-a-stock-dividend/";

export default function App() {
  const [wsStatus, setWsStatus] = useState("connecting");
  const [demo, setDemo] = useState(false);
  const wsRef = useRef(null);
  const reconnectRef = useRef({ tries: 0, timer: null });
  const demoTimerRef = useRef(null);

  const [mint, setMint] = useState(STATIC_CA);
  const [holders, setHolders] = useState([]);
  const [holderCount, setHolderCount] = useState(null);
  const [eligibleCount, setEligibleCount] = useState(null);
  const [cycle, setCycle] = useState(null); // cycle_state message from the dispenser
  const [payments, setPayments] = useState([]);
  const [copied, setCopied] = useState(false);
  const [lookup, setLookup] = useState("");
  const [toasts, setToasts] = useState([]);
  const nowTick = useNow(1000);
  const toastId = useRef(0);

  const connected = wsStatus === "connected";

  function pushToast(t) {
    const id = ++toastId.current;
    setToasts((p) => [...p, { id, ...t }].slice(-4));
    if (t.sound) playChaChing();
    const life = t.big ? 8000 : 5200;
    setTimeout(() => setToasts((p) => p.map((x) => (x.id === id ? { ...x, leaving: true } : x))), life - 380);
    setTimeout(() => setToasts((p) => p.filter((x) => x.id !== id)), life);
  }

  /* ------------------------------- sound -------------------------------- */
  const [soundOn, setSoundOn] = useState(() => {
    try { return localStorage.getItem("rbm-sound") !== "off"; } catch { return true; }
  });
  const soundOnRef = useRef(soundOn);
  soundOnRef.current = soundOn;
  const audioRef = useRef(null);
  function ensureAudio() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!audioRef.current) audioRef.current = new AC();
    if (audioRef.current.state === "suspended") audioRef.current.resume().catch(() => {});
    return audioRef.current;
  }
  // browsers keep audio locked until a user gesture — unlock on the first tap
  useEffect(() => {
    const unlock = () => {
      if (soundOnRef.current) ensureAudio();
      window.removeEventListener("pointerdown", unlock);
    };
    window.addEventListener("pointerdown", unlock);
    return () => window.removeEventListener("pointerdown", unlock);
  }, []);
  function toggleSound() {
    setSoundOn((v) => {
      const next = !v;
      try { localStorage.setItem("rbm-sound", next ? "on" : "off"); } catch {}
      if (next) ensureAudio();
      return next;
    });
  }
  // cash-register chime, synthesized: C6-E6-G6 triangle arpeggio, fast decay
  function playChaChing() {
    if (!soundOnRef.current) return;
    const ctx = ensureAudio();
    if (!ctx || ctx.state !== "running") return;
    const t0 = ctx.currentTime;
    for (const [freq, dt] of [[1046.5, 0], [1318.5, 0.09], [1568, 0.18]]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + dt);
      gain.gain.exponentialRampToValueAtTime(0.12, t0 + dt + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + dt);
      osc.stop(t0 + dt + 0.4);
    }
  }

  /* ------------------------------ websocket ----------------------------- */
  useEffect(() => {
    connectWS();
    demoTimerRef.current = setTimeout(() => {
      if (wsRef.current?.readyState !== WebSocket.OPEN) enterDemo();
    }, 1200);
    return () => {
      try {
        wsRef.current?.close(1000, "shutdown");
        clearTimeout(reconnectRef.current.timer);
        clearTimeout(demoTimerRef.current);
      } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function connectWS() {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) return;
    let sock;
    try {
      sock = new WebSocket(WS_URL);
    } catch {
      return scheduleReconnect();
    }
    wsRef.current = sock;
    sock.addEventListener("open", () => {
      setWsStatus("connected");
      setDemo(false);
      setMint((m) => (m === DEMO_CA ? STATIC_CA : m)); // drop the demo mint, real one arrives over WS
      reconnectRef.current.tries = 0;
    });
    sock.addEventListener("message", (ev) => {
      try {
        handleMessage(JSON.parse(ev.data));
      } catch {}
    });
    sock.addEventListener("close", () => {
      setWsStatus("disconnected");
      scheduleReconnect();
    });
    sock.addEventListener("error", () => {
      try {
        sock.close();
      } catch {}
    });
  }
  function scheduleReconnect() {
    const n = (reconnectRef.current.tries = (reconnectRef.current.tries || 0) + 1);
    reconnectRef.current.timer = setTimeout(connectWS, Math.min(1000 * 2 ** (n - 1), 10000));
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case "service_status":
        if (msg.ca && !STATIC_CA) setMint(msg.ca);
        return;
      case "holders_update": {
        setHolders(Array.isArray(msg.holders) ? msg.holders : []);
        if (Number.isFinite(msg.totalHolders)) setHolderCount(msg.totalHolders);
        if (Number.isFinite(msg.eligibleHolders)) setEligibleCount(msg.eligibleHolders);
        if (msg.mint && !STATIC_CA) setMint(msg.mint);
        return;
      }
      case "cycle_state":
        setCycle(msg);
        return;
      case "distribution_result":
        if (msg.count > 0)
          pushToast({
            big: msg.count >= 10,
            sound: true,
            title: `$${fmtNum(msg.totalUsd)} HANDED OUT`,
            body: `${msg.count} holder${msg.count === 1 ? "" : "s"} got their dollar${msg.ranOut ? ", then the drawer ran out" : ""}. Check your wallet.`,
          });
        return;
      case "payments_update":
        if (Array.isArray(msg.payments) && msg.payments.length)
          setPayments((prev) => [...prev, ...msg.payments].slice(-200));
        return;
      default:
        return;
    }
  }

  /* ------------------------------ demo mode ----------------------------- */
  const demoRef = useRef({ potSol: 0.104, solUsd: 180, nextPayTs: 0, paidUsd: 8214, payouts: 8214 });
  function demoState(d) {
    return {
      type: "cycle_state",
      potSol: d.potSol,
      potUsd: d.potSol * d.solUsd,
      solUsd: d.solUsd,
      payoutUsd: 1,
      payEveryMs: 300000,
      nextPayTs: d.nextPayTs,
      coverage: Math.floor(d.potSol * d.solUsd),
      eligibleHolders: 20,
      minEligiblePct: 0,
      paidUsdTotal: d.paidUsd,
      paidSolTotal: d.paidUsd / d.solUsd,
      payoutsTotal: d.payouts,
      mcapUsd: 92_500,
      running: true,
      dryRun: true,
      ts: Date.now(),
    };
  }
  function enterDemo() {
    setDemo(true);
    const d = demoRef.current;
    d.nextPayTs = Date.now() + 45_000;
    const hs = makeDemoHolders();
    setHolders(hs);
    setHolderCount(1187);
    setEligibleCount(hs.length);
    setMint((m) => m || DEMO_CA);
    setCycle(demoState(d));
    setPayments(
      hs.slice(0, 9).map((h, i) => ({
        to: h.owner,
        usd: 1,
        sol: 1 / d.solUsd,
        rank: h.rank,
        sig: `demo-${i}`,
        ts: Date.now() - i * 45000,
      }))
    );
  }
  useEffect(() => {
    if (!demo) return;
    const id = setInterval(() => {
      const d = demoRef.current;
      d.potSol += 0.0024 + Math.random() * 0.008; // fees trickling in
      if (Date.now() >= d.nextPayTs) {
        d.nextPayTs = Date.now() + 45_000; // fast cycle so the preview stays alive
        const hs = holdersRef.current;
        const count = Math.min(Math.floor(d.potSol * d.solUsd), hs.length);
        if (count > 0) {
          d.potSol -= count / d.solUsd;
          d.paidUsd += count;
          d.payouts += count;
          demoBurst(count);
          pushToast({
            sound: true,
            title: `$${count} HANDED OUT`,
            body: `${count} holders got their dollar${count < hs.length ? ", then the drawer ran out" : ""}.`,
          });
        }
      }
      setCycle(demoState(d));
    }, 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo]);
  const holdersRef = useRef([]);
  holdersRef.current = holders;
  function demoBurst(count) {
    const d = demoRef.current;
    const pays = holdersRef.current.slice(0, count).map((h) => ({
      to: h.owner,
      usd: 1,
      sol: 1 / d.solUsd,
      rank: h.rank,
      sig: `sim-${Date.now().toString(16)}-${h.owner.slice(0, 4)}`,
      ts: Date.now(),
    }));
    setHolders((prev) => prev.map((h) => (h.rank <= count ? { ...h, paidUsd: (h.paidUsd || 0) + 1 } : h)));
    setPayments((prev) => [...prev, ...pays].slice(-200));
  }

  /* ------------------------------- derived ------------------------------ */
  const displayCA = mint || "";
  const buyUrl = displayCA ? `${BUY_BASE}/coin/${displayCA}` : BUY_BASE;
  const live = Boolean(cycle?.running);
  const potSol = cycle?.potSol ?? null;
  const potUsd = cycle?.potUsd ?? null;
  const payoutUsd = cycle?.payoutUsd ?? 1;
  const coverage = cycle?.coverage ?? null;
  const paidUsd = cycle?.paidUsdTotal ?? 0;
  const payoutsTotal = cycle?.payoutsTotal ?? 0;
  const paySecs = cycle?.nextPayTs ? Math.max(0, Math.ceil((cycle.nextPayTs - nowTick) / 1000)) : null;
  const minPct = cycle?.minEligiblePct ?? 0;
  const paidAnim = useCountUp(paidUsd, 900);
  // "holders" the human way: eligible wallets (contracts and pools don't count)
  const holdersAnim = useCountUp(eligibleCount ?? 0, 900);
  const payoutsAnim = useCountUp(payoutsTotal, 900);
  const feed = useMemo(() => [...payments].slice(-40).reverse(), [payments]);
  // base58 addresses are case sensitive: compare exactly as typed, trim only
  const lookupResult = useMemo(() => {
    const q = lookup.trim();
    if (!q) return null;
    return holders.find((h) => h.owner === q) || null;
  }, [lookup, holders]);
  // the rendered line: filter as you type, cap the DOM, never hide the count
  const filteredLine = useMemo(() => {
    const q = lookup.trim();
    if (!q) return holders;
    return holders.filter((h) => h.owner.includes(q));
  }, [lookup, holders]);
  const visibleLine = filteredLine.slice(0, 300);
  const hiddenLine = filteredLine.length - visibleLine.length;

  const copyCA = async () => {
    if (!displayCA) return;
    try {
      await navigator.clipboard.writeText(displayCA);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  /* -------------------------------- render ------------------------------ */
  return (
    <div className="wrap">
      <FallingBits />
      {/* rolling office-tape ticker */}
      <div className="tape" aria-hidden="true">
        <div className="tape-track">
          {[0, 1].map((rep) => (
            <span key={rep} className="tape-group">
              {Array.from({ length: 6 }).map((_, i) => (
                <span key={i} className="tape-item">
                  HOLD ${TICKER}, GET $1 <BandLoop size={22} /> EVERY 5 MINUTES <BandLoop size={22} /> <span className="tape-sol">ON SOLANA ◎</span> <BandLoop size={22} /> BIGGEST BAGS FIRST <BandLoop size={22} /> NAMED BY ROBINHOOD <BandLoop size={22} /> NO CLAIMING <BandLoop size={22} />
                </span>
              ))}
            </span>
          ))}
        </div>
      </div>

      <header className="nav">
        <a className="brand" href="#top">
          <BandBall size={42} className="brand-ball" />
          <span className="brand-name">Rubberbands <em>&amp;</em> More</span>
        </a>
        <nav className="nav-r">
          <button className="sound-btn" onClick={toggleSound} aria-label={soundOn ? "Mute payout sound" : "Unmute payout sound"} title={soundOn ? "payout sound: on" : "payout sound: off"}>
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M4 9v6h4l5 4.5v-15L8 9H4Z" fill="currentColor" />
              {soundOn ? (
                <>
                  <path d="M16 9c1.3 1 1.3 5 0 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  <path d="M18.6 6.6c2.4 2.2 2.4 8.6 0 10.8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </>
              ) : (
                <path d="M16.5 9.5 21 14.5M21 9.5l-4.5 5" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" />
              )}
            </svg>
          </button>
          <a className="nav-link" href="#lore">The lore</a>
          <a className="nav-link" href="#how">How it works</a>
          <a className="nav-link" href="#paid">Paid</a>
          <a className="nav-link" href="#spot">Holders</a>
          <a className="btn chunky" href={buyUrl} target="_blank" rel="noreferrer">GET ${TICKER}</a>
        </nav>
      </header>

      <main className="page" id="top">
        {/* hero: split — pitch left, dispenser right */}
        <section className="hero">
          <span className="deco deco-pin1"><Pin color="#ffd21f" /></span>
          <span className="deco deco-pin2"><Pin color="var(--purple)" /></span>
          <span className="deco deco-band1"><BandLoop size={64} loose /></span>
          <span className="deco deco-band2"><BandLoop size={46} loose /></span>

          <div className="hero-l">
            <Reveal><span className="eyebrow">office supplies pay better than your job</span></Reveal>
            <Reveal delay={0.08}><h1 className="mega">
              <span className="mega-line">HOLD ${TICKER}.</span>
              <span className="mega-line hot">GET $1.</span>
              <span className="mega-line">EVERY 5 MIN.</span>
            </h1></Reveal>
            <Reveal delay={0.12}><span className="sol-badge">◎ now dispensing SOL</span></Reveal>
            <Reveal delay={0.16}><p className="hero-sub">
              <strong>Rubberbands &amp; More</strong> is stupid simple: creator fees pile up
              in the drawer. Every <strong>5 minutes</strong> we hand{" "}
              <strong>$1 in SOL</strong> to every holder, <strong>biggest bags
              first</strong>, until the drawer runs out. No staking. No claiming.
              Just a dollar, on the dot.
            </p></Reveal>
            <Reveal delay={0.24} className="hero-cta">
              <a className="btn chunky big" href={buyUrl} target="_blank" rel="noreferrer">GET ${TICKER} <BandBall size={24} bare /></a>
              <a className="btn hollow" href="#how">how it works</a>
            </Reveal>
            {displayCA && (
              <Reveal delay={0.3}><button className={`ca ${copied ? "copied" : ""}`} onClick={copyCA}>
                <span className="ca-tag">CA</span>
                <span className="ca-val">{displayCA}</span>
                <span className="ca-copy">{copied ? "copied!" : "copy"}</span>
              </button></Reveal>
            )}
            <Reveal delay={0.36}>
              <a className="factoid" href="#lore">
                <Pin color="var(--purple)" size={18} />
                <span><strong>Fun fact:</strong> Robinhood named this company. We just brought the rubberbands. <span className="factoid-more">see the receipt</span></span>
              </a>
            </Reveal>
          </div>

          <Reveal delay={0.15}>
          <aside className="drawer">
            <span className="drawer-pin"><Pin color="#e8501f" /></span>
            <div className="drawer-head">
              <span className="drawer-title">The Drawer</span>
              <span className={`led ${live ? "on" : ""}`}>{live ? "● PAYING OUT" : demo ? "● PREVIEW" : "○ RESTOCKING"}</span>
            </div>
            <div className="drawer-timer">
              <span className="dt-label">next dollar drop in</span>
              <span className={`dt-clock ${paySecs != null && paySecs <= 10 ? "soon" : ""}`}>{paySecs == null ? "--:--" : fmtClock(paySecs)}</span>
            </div>
            <div className="drawer-rows">
              <div className="dr">
                <span>In the drawer</span>
                <b>{potSol == null ? "—" : `${fmtQty(potSol)} SOL`}</b>
              </div>
              <div className="dr">
                <span>Drawer value</span>
                <b>{potUsd == null ? "—" : `$${fmtNum(potUsd)}`}</b>
              </div>
              <div className="dr">
                <span>Covers this round</span>
                <b>{coverage == null ? "—" : `${Math.min(coverage, eligibleCount ?? coverage).toLocaleString()} of ${(eligibleCount ?? 0).toLocaleString()} holders`}</b>
              </div>
              <div className="dr">
                <span>Payout</span>
                <b>${fmtNum(payoutUsd)} per holder</b>
              </div>
            </div>
            <p className="drawer-note">
              {live
                ? `Paid top-down by bag size. ${minPct > 0 ? `Hold ≥${minPct}% of $${TICKER} and you're in the line.` : `Any bag counts, every holder is in the line.`}`
                : `Payouts start the moment $${TICKER} trades. Get your spot in line.`}
            </p>
          </aside>
          </Reveal>
        </section>

        {/* stat strip */}
        <section className="stats">
          <Reveal><div className="stat"><b>{eligibleCount == null ? "—" : Math.round(holdersAnim).toLocaleString()}</b><span>holders</span><Smiley /></div></Reveal>
          <Reveal delay={0.07}><div className="stat"><b>{payoutsTotal ? Math.round(payoutsAnim).toLocaleString() : "—"}</b><span>holders paid</span><Smiley /></div></Reveal>
          <Reveal delay={0.14}><div className="stat"><b>{paidUsd ? `$${fmtNum(paidAnim)}` : "—"}</b><span>paid to holders</span><Smiley /></div></Reveal>
        </section>

        {/* the lore: Robinhood's dividend article invented us */}
        <section className="lore" id="lore">
          <Reveal><h2 className="h2">ROBINHOOD NAMED THIS COMPANY</h2></Reveal>
          <div className="lore-grid">
            <Reveal delay={0.08} className="lore-copy">
              <p>
                Robinhood Learn has an article called{" "}
                <a href={ARTICLE_URL} target="_blank" rel="noreferrer">"What is a stock dividend?"</a>.
                To explain how dividends work they needed an example company, so they invented one.
                They invented us.
              </p>
              <blockquote className="lore-quote">
                "Let's say <mark>the fictional company Rubberbands &amp; More</mark> declares
                a <mark>cash dividend of $1</mark> per share."
              </blockquote>
              <p>
                So we did the homework. The fictional company is real now, the shares are ${TICKER},
                and the $1 dividend pays every <strong>5 minutes</strong> instead of once a quarter.
                Robinhood wrote the tokenomics. We hit print.
              </p>
              <a className="btn hollow" href={ARTICLE_URL} target="_blank" rel="noreferrer">read the article ↗</a>
            </Reveal>
            <Reveal delay={0.16} className="lore-shot">
              <figure className="lore-fig">
                <span className="lore-pin"><Pin color="#ffd21f" /></span>
                <img
                  src="/dividends-article.jpg"
                  alt='Screenshot of Robinhood Learn, "Understanding stock dividends", with "the fictional company Rubberbands & More" and "cash dividend of $1" highlighted in yellow'
                  loading="lazy"
                  width="707"
                  height="322"
                />
                <figcaption>straight from Robinhood Learn</figcaption>
              </figure>
            </Reveal>
          </div>
        </section>

        {/* how it works — animated flow diagram */}
        <section className="how" id="how">
          <Reveal><h2 className="h2">HOW THE DOLLARS GET DROPPED</h2></Reveal>
          <Reveal delay={0.1} className="howfig-wrap"><HowDiagram ticker={TICKER} /></Reveal>
          <Reveal className="math" delay={0.15}>your spot = your rank by bag · payout = $1 flat · every 5 minutes · till the drawer runs out</Reveal>
        </section>

        {/* paid feed */}
        <section className="paid" id="paid">
          <Reveal className="paid-head">
            <h2 className="h2">PAID SO FAR</h2>
            <div className="paid-total">
              <span className="pt-num">${fmtNum(paidAnim)}</span>
              <span className="pt-l">{payoutsTotal > 0 ? `${payoutsTotal.toLocaleString()} dollars dropped and counting` : "the counter starts at launch"}</span>
            </div>
          </Reveal>
          <Reveal delay={0.1} className="feed">
            {feed.length ? feed.map((p, i) => (
              <div className="f-row" key={`${p.sig}-${i}`}>
                <BandBall size={20} bare className="f-ball" />
                <span className="f-tag">PAID</span>
                <span className="f-amt">${fmtNum(p.usd ?? 1)}</span>
                <span className="f-dim">→</span>
                <a className="f-to" href={`${EXPLORER}/account/${p.to}`} target="_blank" rel="noreferrer">
                  {shortAddr(p.to)}
                </a>
                {p.rank != null && <span className="f-rank">#{p.rank}</span>}
                <span className="f-sol">{fmtQty(p.sol)} SOL</span>
                <span className="f-time">{fmtTime(p.ts)}</span>
                {String(p.sig).startsWith("demo") || String(p.sig).startsWith("sim") || String(p.sig).startsWith("SIM-") || String(p.sig).startsWith("0xSIM") || String(p.sig).startsWith("sent-") ? (
                  <span className="f-tx">sim</span>
                ) : (
                  <a className="f-tx" href={`${EXPLORER}/tx/${encodeURIComponent(p.sig)}`} target="_blank" rel="noreferrer">tx ↗</a>
                )}
              </div>
            )) : (
              <div className="f-empty">{connected ? "First dollar drops after launch…" : "Opening the drawer…"}</div>
            )}
          </Reveal>
        </section>

        {/* the line: every holder ranked, scroll it, find yourself */}
        <section className="spot" id="spot">
          <Reveal>
          <h2 className="h2">THE LINE</h2>
          <p className="spot-sub">Every holder is in line, any bag counts. Sorted by bag size, paid top-down. Scroll the line or search your wallet.</p>
          <div className="checker">
            <input
              value={lookup}
              onChange={(e) => setLookup(e.target.value)}
              placeholder="YourWalletAddress…"
              spellCheck={false}
            />
            {lookup && (
              <button className="checker-x" onClick={() => setLookup("")} aria-label="Clear">×</button>
            )}
          </div>
          {lookup.trim() && (
            <SpotResult holder={lookupResult} query={lookup.trim()} coverage={coverage} payoutUsd={payoutUsd} minPct={minPct} />
          )}
          <div className="line-list">
            {visibleLine.length ? (
              <>
                {visibleLine.map((h) => (
                  <div className="l-row" key={h.owner}>
                    <span className={`l-rank ${coverage != null && h.rank <= coverage ? "in" : ""}`}>#{h.rank}</span>
                    <a className="l-addr" href={`${EXPLORER}/account/${h.owner}`} target="_blank" rel="noreferrer">{shortAddr(h.owner)}</a>
                    <span className="l-pct">{(h.percentage ?? 0).toFixed(2)}%</span>
                    <span className="l-paid">${fmtNum(h.paidUsd || 0)}</span>
                  </div>
                ))}
                {hiddenLine > 0 && <div className="l-more">+ {hiddenLine.toLocaleString()} more in line</div>}
              </>
            ) : (
              <div className="f-empty">
                {lookup.trim() ? "No wallet in the line matches that." : connected ? "The line forms as wallets pick up $" + TICKER + "…" : "Opening the drawer…"}
              </div>
            )}
          </div>
          <p className="line-legend">rank · wallet · % of supply · $ collected. Yellow rank = the drawer covers that spot this round.</p>
          </Reveal>
        </section>
      </main>

      <footer className="foot">
        <BandBall size={44} className="foot-ball" />
        <p>© 2026 Rubberbands &amp; More. Office supplies, not financial advice. Bands snap; the risk is yours.</p>
      </footer>

      {/* toasts */}
      <div className="toast-host" aria-live="polite">
        {toasts.map((t) => (
          <div className={`toast ${t.big ? "big" : ""} ${t.leaving ? "out" : ""}`} key={t.id}>
            <BandBall size={34} bare className="toast-ball" />
            <div>
              <div className="toast-t">{t.title}</div>
              <div className="toast-b">{t.body}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------ pieces --------------------------------- */
/* blur-fade reveal on scroll (Magic UI-style BlurFade, no deps) */
function Reveal({ className = "", delay = 0, children, ...rest }) {
  const ref = useRef(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setInView(true);
          io.disconnect();
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -36px 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref} className={`rev ${inView ? "in" : ""} ${className}`} style={{ transitionDelay: `${delay}s` }} {...rest}>
      {children}
    </div>
  );
}

/* the mascot — a ball of rubberbands with googly eyes */
function BandBall({ size = 32, bare = false, className = "" }) {
  const id = useId().replace(/[:]/g, "");
  return (
    <svg className={`ball ${className}`} width={size} height={size} viewBox="0 0 120 120" aria-hidden="true">
      <defs>
        <clipPath id={`bc-${id}`}><circle cx="60" cy="74" r="42" /></clipPath>
      </defs>
      <circle cx="60" cy="74" r="42" fill="#e2cb79" />
      <g clipPath={`url(#bc-${id})`} fill="none" strokeLinecap="round">
        <ellipse cx="60" cy="74" rx="41" ry="33" stroke="#efdf9b" strokeWidth="5" />
        <ellipse cx="60" cy="74" rx="41.5" ry="15.5" transform="rotate(-24 60 74)" stroke="#d8bc63" strokeWidth="5.5" />
        <ellipse cx="60" cy="74" rx="40.5" ry="24" transform="rotate(38 60 74)" stroke="#c7a94f" strokeWidth="5" />
        <ellipse cx="60" cy="74" rx="41.5" ry="9" transform="rotate(72 60 74)" stroke="#8e9d68" strokeWidth="4.6" />
        <ellipse cx="60" cy="74" rx="40.5" ry="28" transform="rotate(-58 60 74)" stroke="#cb854e" strokeWidth="5" />
        <ellipse cx="60" cy="74" rx="38" ry="20" transform="rotate(12 60 74)" stroke="#e5d48d" strokeWidth="4.6" />
        <ellipse cx="60" cy="74" rx="41" ry="30" transform="rotate(60 60 74)" stroke="#d9c06b" strokeWidth="4.2" />
        <ellipse cx="60" cy="74" rx="36" ry="12" transform="rotate(-40 60 74)" stroke="#b49f52" strokeWidth="4.2" />
        <path d="M28 55 Q35 40 50 36" stroke="#f7ecb6" strokeWidth="5" />
      </g>
      <circle cx="60" cy="74" r="42" fill="none" stroke="#b89a4e" strokeWidth="1.6" opacity="0.55" />
      {!bare && (
        <>
          <circle cx="44" cy="37" r="15" fill="#fff" />
          <circle cx="46.8" cy="39.8" r="7.1" fill="#141414" />
          <circle cx="77" cy="43" r="13.2" fill="#fff" />
          <circle cx="79" cy="45.8" r="6.3" fill="#141414" />
          <path d="M28 21 Q42 9 57 16" fill="none" stroke="#141414" strokeWidth="5.5" strokeLinecap="round" />
          <path d="M66 28 Q77 17 91 24" fill="none" stroke="#141414" strokeWidth="5" strokeLinecap="round" />
        </>
      )}
      {bare && (
        <>
          <circle cx="47" cy="60" r="9" fill="#fff" />
          <circle cx="48.6" cy="62" r="4.3" fill="#141414" />
          <circle cx="72" cy="63" r="8" fill="#fff" />
          <circle cx="73.2" cy="65" r="3.8" fill="#141414" />
        </>
      )}
    </svg>
  );
}

/* a loose rubberband — the ∞-ish squiggle from the banner */
function BandLoop({ size = 24, loose = false, className = "" }) {
  return (
    <svg className={`bandloop ${className}`} width={size} height={size * 0.5} viewBox="0 0 64 32" fill="none" aria-hidden="true">
      <path
        d="M6 16 C6 7 20 7 24 14 C28 21 36 21 40 14 C44 7 58 7 58 16 C58 25 44 25 40 18 C36 11 28 11 24 18 C20 25 6 25 6 16 Z"
        stroke={loose ? "#e2cb79" : "currentColor"}
        strokeWidth="4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* a pushpin, claymation style */
function Pin({ color = "#ffd21f", size = 26 }) {
  return (
    <svg width={size} height={size * 1.25} viewBox="0 0 26 33" fill="none" aria-hidden="true">
      <ellipse cx="13" cy="9" rx="9" ry="8" fill={color} />
      <ellipse cx="10" cy="6.4" rx="3.2" ry="2.6" fill="#fff" opacity="0.5" />
      <rect x="10.6" y="15" width="4.8" height="7" rx="2" fill={color} />
      <path d="M13 22 L13 31" stroke="#8b8b8b" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

/* slow office-supply rain behind everything, barely-there opacity */
function FallingBits() {
  // hand-placed so the spread looks organic but never busy
  const bits = [
    { k: "band", left: "4%", s: 44, d: 34, del: -3, o: 0.13 },
    { k: "pin", left: "11%", s: 20, d: 27, del: -14, o: 0.14, c: "#ffd21f" },
    { k: "clip", left: "18%", s: 26, d: 39, del: -22, o: 0.12 },
    { k: "bill", left: "26%", s: 34, d: 30, del: -8, o: 0.12 },
    { k: "band", left: "33%", s: 30, d: 25, del: -19, o: 0.12 },
    { k: "eraser", left: "40%", s: 30, d: 36, del: -5, o: 0.11 },
    { k: "pin", left: "47%", s: 17, d: 29, del: -25, o: 0.13, c: "#8f4bf2" },
    { k: "band", left: "54%", s: 52, d: 41, del: -11, o: 0.1 },
    { k: "clip", left: "61%", s: 22, d: 28, del: -2, o: 0.12 },
    { k: "bill", left: "68%", s: 28, d: 33, del: -17, o: 0.12 },
    { k: "pin", left: "74%", s: 21, d: 26, del: -9, o: 0.13, c: "#e8501f" },
    { k: "band", left: "81%", s: 36, d: 37, del: -27, o: 0.12 },
    { k: "eraser", left: "88%", s: 24, d: 31, del: -13, o: 0.11 },
    { k: "clip", left: "94%", s: 28, d: 35, del: -20, o: 0.12 },
    { k: "band", left: "97%", s: 26, d: 27, del: -6, o: 0.11 },
    { k: "pin", left: "58%", s: 16, d: 40, del: -31, o: 0.12, c: "#ffd21f" },
  ];
  return (
    <div className="rain" aria-hidden="true">
      {bits.map((b, i) => (
        <span
          key={i}
          className={`rain-bit ${i % 3 === 0 ? "rain-sway" : ""}`}
          style={{ left: b.left, opacity: b.o, animationDuration: `${b.d}s`, animationDelay: `${b.del}s` }}
        >
          {b.k === "band" && <BandLoop size={b.s} loose />}
          {b.k === "pin" && <Pin color={b.c} size={b.s} />}
          {b.k === "clip" && (
            <svg width={b.s} height={b.s * 1.6} viewBox="0 0 24 38" fill="none">
              <path d="M8 11 a4 4 0 0 1 8 0 v17 a6 6 0 0 1 -12 0 V13 a8.5 8.5 0 0 1 17 0 v16" stroke="#f4eec6" strokeWidth="3" strokeLinecap="round" />
            </svg>
          )}
          {b.k === "eraser" && (
            <svg width={b.s} height={b.s * 0.62} viewBox="0 0 30 19" fill="none">
              <rect x="1.5" y="7" width="27" height="10.5" rx="3" fill="#3b6fe0" />
              <rect x="4.5" y="1.5" width="21" height="9" rx="2.5" fill="#f4eec6" />
            </svg>
          )}
          {b.k === "bill" && (
            <svg width={b.s} height={b.s * 0.58} viewBox="0 0 46 27" fill="none">
              <rect x="1.5" y="1.5" width="43" height="24" rx="5" fill="#ffd21f" stroke="#0d5c50" strokeWidth="2" />
              <text x="23" y="19" textAnchor="middle" fontFamily="Titan One, sans-serif" fontSize="13" fill="#0d5c50">$1</text>
            </svg>
          )}
        </span>
      ))}
    </div>
  );
}

/* sticker rect with the hard teal offset, for the diagram */
function Sticker({ x, y, w, h, r = 12, fill = "var(--paper)", off = 4, dash = false, className = "" }) {
  return (
    <g className={className}>
      <rect x={x + off} y={y + off + 1} width={w} height={h} rx={r} fill="var(--teal-deep)" />
      <rect x={x} y={y} width={w} height={h} rx={r} fill={fill} stroke="var(--teal-deep)" strokeWidth="3" strokeDasharray={dash ? "7 5" : undefined} />
    </g>
  );
}

/* the whole mechanic as one looping animated scene, same claymation kit */
function HowDiagram({ ticker = "RBM" }) {
  const chips = [
    { y: 96, rank: 1, addr: "9WzD…AWWM", bar: 170, pct: "2.41%" },
    { y: 160, rank: 2, addr: "7xKX…gAsU", bar: 120, pct: "1.12%" },
    { y: 224, rank: 3, addr: "4Nd1…ZiTJ", bar: 78, pct: "0.43%" },
    { y: 288, rank: 4, addr: "GDfn…NnBo", bar: 44, pct: "0.19%" },
  ];
  const bills = [
    { cls: "fig-bill1", popCls: "fig-pop1", chip: chips[0] },
    { cls: "fig-bill2", popCls: "fig-pop2", chip: chips[1] },
    { cls: "fig-bill3", popCls: "fig-pop3", chip: chips[2] },
  ];
  return (
    <svg
      className="howfig"
      viewBox="0 0 960 400"
      role="img"
      aria-label={`Trades of $${ticker} send SOL fees into the drawer. Every 5 minutes the drawer is divided into $1 payouts and paid to holders, biggest bags first, until it runs out.`}
    >
      {/* zone tags */}
      <g>
        <Sticker x={30} y={22} w={216} h={34} r={10} />
        <rect x={38} y={27} width={26} height={24} rx={6} fill="var(--yellow)" stroke="var(--teal-deep)" strokeWidth="2.5" />
        <text className="fig-display" x={51} y={44} textAnchor="middle" fontSize="13" fill="var(--ink)">01</text>
        <text className="fig-display" x={72} y={45} fontSize="13.5" fill="var(--teal-deep)">FEES FILL THE DRAWER</text>
        <text className="fig-small" x={34} y={76} fontSize="11" fill="var(--paper)">every trade drips SOL in</text>

        <Sticker x={330} y={22} w={220} h={34} r={10} />
        <rect x={338} y={27} width={26} height={24} rx={6} fill="var(--purple)" stroke="var(--teal-deep)" strokeWidth="2.5" />
        <text className="fig-display" x={351} y={44} textAnchor="middle" fontSize="13" fill="#fff">02</text>
        <text className="fig-display" x={372} y={45} fontSize="13.5" fill="var(--teal-deep)">WE COUNT THE DRAWER</text>
        <text className="fig-small" x={334} y={76} fontSize="11" fill="var(--paper)">drawer ÷ $1 = payouts this round</text>

        <Sticker x={660} y={22} w={212} h={34} r={10} />
        <rect x={668} y={27} width={26} height={24} rx={6} fill="var(--red)" stroke="var(--teal-deep)" strokeWidth="2.5" />
        <text className="fig-display" x={681} y={44} textAnchor="middle" fontSize="13" fill="#fff">03</text>
        <text className="fig-display" x={702} y={45} fontSize="13.5" fill="var(--teal-deep)">$1 HITS YOUR WALLET</text>
        <text className="fig-small" x={664} y={76} fontSize="11" fill="var(--paper)">biggest bags first, till it's gone</text>
      </g>

      {/* dashed arteries */}
      <path className="fig-dash" d="M 186 196 C 226 206, 242 216, 268 226" fill="none" stroke="var(--paper)" strokeWidth="3" strokeLinecap="round" opacity="0.75" />
      <path className="fig-dash" d="M 458 236 C 530 250, 560 232, 606 200" fill="none" stroke="var(--paper)" strokeWidth="3" strokeLinecap="round" opacity="0.75" />

      {/* loose band squiggle for flavor */}
      <path d="M 560 330 C 560 318 578 318 583 327 C 588 336 598 336 603 327 C 608 318 626 318 626 330 C 626 342 608 342 603 333 C 598 324 588 324 583 333 C 578 342 560 342 560 330 Z" fill="none" stroke="var(--band)" strokeWidth="3.6" opacity="0.85" />

      {/* the trades chip */}
      <Sticker x={30} y={150} w={152} h={66} r={14} />
      <svg x={44} y={162} width={40} height={40} viewBox="0 0 120 120">
        <circle cx="60" cy="60" r="46" fill="#e2cb79" />
        <g fill="none" strokeLinecap="round">
          <ellipse cx="60" cy="60" rx="44" ry="18" transform="rotate(-24 60 60)" stroke="#d8bc63" strokeWidth="7" />
          <ellipse cx="60" cy="60" rx="43" ry="28" transform="rotate(42 60 60)" stroke="#c7a94f" strokeWidth="6.5" />
          <ellipse cx="60" cy="60" rx="44" ry="34" transform="rotate(-70 60 60)" stroke="#cb854e" strokeWidth="6.5" />
        </g>
        <circle cx="46" cy="44" r="13" fill="#fff" /><circle cx="48.5" cy="46.5" r="6.2" fill="#141414" />
        <circle cx="76" cy="48" r="11.5" fill="#fff" /><circle cx="78" cy="50.5" r="5.5" fill="#141414" />
      </svg>
      <text className="fig-display" x={92} y={192} fontSize="20" fill="var(--teal-deep)">${ticker}</text>
      <text className="fig-small" x={34} y={240} fontSize="11" fill="var(--paper)">creator fees (SOL)</text>

      {/* SOL coins dripping into the drawer */}
      {["fig-c1", "fig-c2", "fig-c3"].map((c) => (
        <g key={c} className={`fig-coin ${c}`} transform="translate(192,178)">
          <circle r="11" fill="var(--teal)" stroke="var(--teal-deep)" strokeWidth="2.5" />
          <text className="fig-mono" x="0" y="4.2" textAnchor="middle" fontSize="12" fontWeight="700" fill="var(--paper)">◎</text>
        </g>
      ))}

      {/* the drawer */}
      <Sticker x={272} y={168} w={180} h={126} r={16} />
      <rect x={286} y={182} width={152} height={62} rx={8} fill="#e6dda1" stroke="var(--teal-deep)" strokeWidth="2" />
      <g className="fig-fill">
        <rect x={290} y={186} width={144} height={54} rx={5} fill="var(--yellow)" />
        <line x1={298} y1={200} x2={330} y2={200} stroke="var(--yellow-deep)" strokeWidth="2.5" strokeLinecap="round" />
        <line x1={340} y1={212} x2={372} y2={212} stroke="var(--yellow-deep)" strokeWidth="2.5" strokeLinecap="round" />
      </g>
      <rect x={332} y={254} width={60} height={11} rx={5.5} fill="var(--teal)" stroke="var(--teal-deep)" strokeWidth="2" />
      <path d="M330 271 Q338 265 346 269" fill="none" stroke="var(--ink)" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M362 272 Q370 266 377 270" fill="none" stroke="var(--ink)" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx={339} cy={280} r={7.2} fill="#fff" /><circle cx={340.5} cy={281.5} r={3.4} fill="#141414" />
      <circle cx={369} cy={281} r={6.4} fill="#fff" /><circle cx={370} cy={282.5} r={3} fill="#141414" />
      <path d="M347 289 Q354 294 361 289" fill="none" stroke="var(--ink)" strokeWidth="2.4" strokeLinecap="round" />
      <text className="fig-display" x={362} y={320} textAnchor="middle" fontSize="13" fill="var(--paper)">THE DRAWER</text>

      {/* the 5-minute dial */}
      <circle cx={434} cy={116} r={31} fill="var(--teal-deep)" opacity="0.9" transform="translate(3,4)" />
      <circle cx={430} cy={112} r={31} fill="var(--paper)" stroke="var(--teal-deep)" strokeWidth="3" />
      {[0, 90, 180, 270].map((a) => (
        <line key={a} x1={430} y1={86} x2={430} y2={90} stroke="var(--teal)" strokeWidth="2.5" strokeLinecap="round" transform={`rotate(${a} 430 112)`} />
      ))}
      <g className="fig-hand">
        <line x1={430} y1={112} x2={430} y2={91} stroke="var(--red)" strokeWidth="3.5" strokeLinecap="round" />
      </g>
      <circle cx={430} cy={112} r={3.2} fill="var(--ink)" />
      <text className="fig-small" x={430} y={158} textAnchor="middle" fontSize="10.5" fill="var(--paper)">every 5 min</text>
      <g className="fig-count">
        <Sticker x={468} y={94} w={116} h={30} r={9} fill="var(--yellow)" off={3} />
        <text className="fig-mono" x={526} y={114} textAnchor="middle" fontSize="11.5" fontWeight="700" fill="var(--ink)">÷ $1 = 3 payouts</text>
      </g>

      {/* the line: holders ranked by bag */}
      {chips.map((c, i) => (
        <g key={c.rank} className={i < 3 ? `fig-chip fig-chipP${i + 1}` : "fig-chip4"}>
          <Sticker x={620} y={c.y} w={300} h={52} r={12} dash={i === 3} />
          <circle cx={646} cy={c.y + 26} r={13} fill={i === 0 ? "var(--yellow)" : "var(--paper2)"} stroke="var(--teal-deep)" strokeWidth="2.5" />
          <text className="fig-display" x={646} y={c.y + 31} textAnchor="middle" fontSize="13" fill={i === 0 ? "var(--ink)" : "var(--teal-deep)"}>{c.rank}</text>
          <text className="fig-mono" x={668} y={c.y + 22} fontSize="12" fill="var(--ink)">{c.addr}</text>
          <rect x={668} y={c.y + 30} width={c.bar} height={9} rx={4.5} fill="var(--teal)" opacity="0.85" />
          <text className="fig-mono" x={906} y={c.y + 31} textAnchor="end" fontSize="11.5" fontWeight="700" fill="var(--ink)">{c.pct}</text>
        </g>
      ))}
      <g className="fig-next">
        <Sticker x={796} y={266} w={122} h={26} r={8} fill="var(--paper2)" off={3} />
        <text className="fig-mono" x={857} y={283} textAnchor="middle" fontSize="11" fontWeight="700" fill="var(--teal-deep)">next round ↻</text>
      </g>

      {/* the flying dollars */}
      {bills.map((b) => (
        <g key={b.cls} className={`fig-bill ${b.cls}`} transform="translate(352,192)">
          <rect x={2.5} y={3.5} width={46} height={27} rx={6} fill="var(--teal-deep)" />
          <rect width={46} height={27} rx={6} fill="var(--yellow)" stroke="var(--teal-deep)" strokeWidth="2.5" />
          <text className="fig-display" x={23} y={19.5} textAnchor="middle" fontSize="14" fill="var(--teal-deep)">$1</text>
        </g>
      ))}
      {/* +$1.00 pops on landing */}
      {bills.map((b) => (
        <g key={b.popCls} className={`fig-pop ${b.popCls}`}>
          <Sticker x={836} y={b.chip.y - 12} w={76} h={24} r={8} fill="var(--yellow)" off={3} />
          <text className="fig-display" x={874} y={b.chip.y + 5} textAnchor="middle" fontSize="12" fill="var(--ink)">+$1.00</text>
        </g>
      ))}
    </svg>
  );
}

/* a tiny corner smiley, like the faces on the staplers */
function Smiley() {
  return (
    <svg className="smiley" width="18" height="10" viewBox="0 0 18 10" fill="none" aria-hidden="true">
      <circle cx="3" cy="2.4" r="1.9" fill="currentColor" />
      <circle cx="15" cy="2.4" r="1.9" fill="currentColor" />
      <path d="M5 6.2 Q9 10 13 6.2" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  );
}

function SpotResult({ holder, query, coverage, payoutUsd, minPct }) {
  if (!holder) {
    return (
      <div className="spot-res miss">
        <b>{query.length > 16 ? shortAddr(query) : query}</b> isn't in the line yet.{" "}
        {minPct > 0
          ? `It holds less than ${minPct}% of the supply. Top up and the drawer includes you automatically.`
          : `Any bag counts: grab some and the drawer includes you automatically.`}
      </div>
    );
  }
  const covered = coverage != null && holder.rank <= coverage;
  return (
    <div className="spot-res">
      <div className="spot-grid">
        <div>
          <span className="sg-l">spot in line</span>
          <span className="sg-v">#{holder.rank}</span>
        </div>
        <div>
          <span className="sg-l">holds</span>
          <span className="sg-v">{holder.percentage?.toFixed(2)}%</span>
        </div>
        <div>
          <span className="sg-l">next round</span>
          <span className={`sg-v ${covered ? "hi" : ""}`}>
            {coverage == null ? "—" : covered ? `$${fmtNum(payoutUsd)} incoming` : "drawer's short"}
          </span>
        </div>
        <div>
          <span className="sg-l">collected so far</span>
          <span className="sg-v hi">${fmtNum(holder.paidUsd || 0)}</span>
        </div>
      </div>
      {!covered && coverage != null && (
        <p className="spot-note">
          The drawer covers {coverage.toLocaleString()} spot{coverage === 1 ? "" : "s"} right now. About{" "}
          <b>${fmtNum((holder.rank - coverage) * payoutUsd)}</b> more in fees and the line reaches you.
        </p>
      )}
    </div>
  );
}

/* ------------------------------- hooks --------------------------------- */
function useNow(ms) {
  const [t, setT] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setT(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return t;
}
function useCountUp(target, duration = 800) {
  const [val, setVal] = useState(typeof target === "number" ? target : 0);
  const fromRef = useRef(typeof target === "number" ? target : 0);
  const rafRef = useRef(0);
  useEffect(() => {
    if (typeof target !== "number") return;
    const from = fromRef.current;
    const to = target;
    if (from === to) return;
    const start = performance.now();
    const tick = (now) => {
      const t = Math.max(0, Math.min(1, (now - start) / duration));
      const e = 1 - Math.pow(1 - t, 3);
      setVal(from + (to - from) * e);
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
      else fromRef.current = to;
    };
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target, duration]);
  return val;
}

/* ------------------------------- utils --------------------------------- */
function shortAddr(s) {
  return s && s.length > 12 ? `${s.slice(0, 5)}…${s.slice(-4)}` : s || "—";
}
function fmtNum(n) {
  const v = Number(n || 0);
  if (!isFinite(v)) return "0";
  if (Math.abs(v) >= 1000) return Math.round(v).toLocaleString();
  if (Math.abs(v) >= 10) return v.toFixed(0);
  return v.toFixed(2);
}
function fmtQty(n) {
  const v = Number(n || 0);
  if (!isFinite(v) || v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (a >= 1000) return Math.round(v).toLocaleString();
  if (a >= 1) return v.toFixed(2);
  if (a >= 0.01) return v.toFixed(3);
  return v.toFixed(5);
}
function fmtClock(t) {
  const s = Math.max(0, Math.floor(t));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${mm}:${String(ss).padStart(2, "0")}`;
}
function fmtTime(ts) {
  const d = ts ? new Date(ts) : new Date();
  const p = (x) => String(x).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}
function makeDemoHolders() {
  // base58-looking demo addresses (Solana alphabet, 32-44 chars)
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const addr = () =>
    Array.from({ length: 32 + Math.floor(Math.random() * 13) }, () => B58[Math.floor(Math.random() * B58.length)]).join("");
  const rows = [];
  const N = 20;
  for (let i = 0; i < N; i++) {
    const pct = Math.max(0.12, Number((8.5 * Math.pow(0.87, i) + Math.random() * 0.4).toFixed(2)));
    rows.push({ owner: addr(), percentage: pct });
  }
  rows.sort((a, b) => b.percentage - a.percentage);
  return rows.map((r, i) => ({ ...r, rank: i + 1, amount: r.percentage, paidUsd: Math.max(0, 400 - i * 21), paidCount: 0 }));
}
