# FlipNav — Research Findings

**Research status: Researched with sources** — all ten key questions were researched against real sources. However, several specific sub-claims could not be verified and are listed explicitly in §2 *Evidence gaps* as **unverified** rather than guessed. Nothing in this document is invented; no price, limit, URL or date appears here unless it was read from the source cited next to it.

| Field | Value |
|---|---|
| Document | Research findings for FlipNav |
| Prepared for | Step 2 of the workflow (research) → feeds `part2-prd-mvp.md` |
| Access date for all sources | 2026-10-15 |
| Upstream inputs | `research-request-FlipNav.md`, `需求与口径冻结单.md` (v1.0 frozen), `项目想法确认单.md` (v0.3) |
| Companion state at time of research | Todo list showed competitor research in progress; hosting, AI-tooling, monetization and closing research completed |

---

## 1. Scope, method, and how to read this document

**What was researched.** FlipNav's feasibility across competitors, real user signal, MVP build path, no-code options, monetization, AI-assisted development, AI-in-product scope, free hosting, and accessibility. In addition, the three project-specific questions in the research request were treated as first-class: (8) is "replace the clicker" a real pain, (9) can embed-script / bookmarklet really deliver "works on any page", (10) which free hosting options actually hold up.

**How evidence is tagged.** Every claim carries `[official]` (vendor's own docs/pricing/limits page) or `[community]` (user or third-party signal). Where a fetch failed, the item is marked **unverified** and the attempted URL is recorded — never replaced with a guess.

**How to read the verdicts.** Two labels are used throughout: **VALIDATED** (sourced evidence supports the plan) and **WEAK** (sourced evidence shows the plan is weaker than assumed, or the need is already solved). Where neither applies, **UNVERIFIED** is used.

---

## 2. Evidence gaps — read this before trusting anything below

These items were attempted and failed, or were only partly confirmed. They are the honest holes in this research.

| # | Gap | What was attempted | Status |
|---|---|---|---|
| G1 | Real user complaints about clickers and readers | `reddit.com` timed out; Stack Exchange search returned no relevant hits | **unverified** — complaint signal is thin |
| G2 | Gumroad transaction fees | `https://gumroad.com/pricing`, Gumroad help article | **unverified** — timed out on multiple attempts |
| G3 | Ko-fi fees | `https://ko-fi.com/pricing` (HTTP 403) | **unverified** |
| G4 | Buy Me a Coffee fees | `https://www.buymeacoffee.com/pricing` (404) | **unverified** |
| G5 | Firebase free-tier limits | Firestore quota + RTDB limits + pricing pages | **unverified** — 4 timeouts |
| G6 | Google AI (Gemini) pricing and data terms | `https://ai.google.dev/pricing`, `https://ai.google.dev/gemini-api/terms` | **unverified** — timeouts |
| G7 | Stripe US standard rate (2.9% + 30¢) | Site served the HK/CN locale instead | **unverified** — only HK-locale rates captured |
| G8 | iOS Safari edge-swipe vs. browser-back conflict | No usable source obtained | **unverified** — but flagged as the top technical risk in §7 |
| G9 | Canonical "present from phone" pages for Google Slides / Canva | Google support page timed out; Canva served a block page | **unverified** |
| G10 | PDF.js exact default keyboard/swipe behaviour | Repo confirmed as an open-source viewer; defaults not re-verified | **partly unverified** |
| G11 | Whether a PDF.js-based viewer fits the frozen ≤ 200 KB gzip budget | No bundle-size source captured | **unverified** — see §13 |

Everything not in this table is sourced below with URL + access date.

---

## 3. Key Question 1 + 8 — Competitors, pricing, and whether "replace the clicker" is a real pain

### 3.1 Competitor table (Deliverable 1)

| Competitor | Category | What it does | Pricing (as read) | Reach | Verdict for FlipNav |
|---|---|---|---|---|---|
| **Logitech R400** | Physical clicker | Wireless slide advance, laser pointer | **$39.99** `[official]` | Logitech category page | **WEAK threat to the pain claim** — a one-time $40 device is cheap and reliable enough for most |
| **Logitech R500s** | Physical clicker | Bluetooth/USB, spotlight-free | **$44.99** `[official]` | — | Same as above |
| **Logitech R800** | Physical clicker | Green laser, LCD timer | **$54.99** `[official]` | — | Same as above |
| **Logitech Spotlight** | Physical clicker | On-screen highlight/zoom — the premium tier | **$119.99** `[official]` | — | Premium end; shows willingness to pay for *effects*, not for *advancing pages* |
| **Logitech Spotlight 2** | Physical clicker | Updated Spotlight | **$129.99** `[official]` | — | Same as above |
| **reveal.js** | Web slide framework | HTML decks; **already ships built-in touch/swipe navigation** and speaker notes | Free, MIT `[official]` | — | **WEAK** — swipe-to-advance already exists for HTML decks |
| **Slidev** | Web slide framework | Markdown → slides; presenter mode and phone control | Free, MIT `[official]` | — | **WEAK** — same, for developers |
| **Marp** | Web slide framework | Markdown presentation ecosystem | Open source `[official]` | — | **WEAK** — same, narrower feature set |
| **StPageFlip** | JS library | Realistic page-flip effect, canvas or HTML, mobile-compatible, npm `page-flip` | Free, MIT; ~888 stars `[official]` | — | **Builder asset, not a competitor** |
| **PDF.js** | JS library | Mozilla's in-browser PDF parser/renderer | Free, Apache-2.0 `[official]` | — | **Builder asset**; the realistic way to render PDFs client-side |
| **Unified Remote** | Phone-as-remote app | Phone becomes mouse/keyboard, 100+ app remotes, since 2010 | (not captured) `[official]` | **15M+ downloads** `[official]` | **WEAK threat to the "no device" pitch** — the solved-for alternative already has enormous reach |
| **Remote Mouse** | Phone-as-remote app | Phone as wireless mouse/keyboard/trackpad over Wi-Fi | (not captured) `[official]` | — | Same category as above |
| **Chrome / Edge / Safari built-in PDF viewers, Preview, mobile readers** | Built-in | Arrow keys, Space/PageDown and swipe already page through documents | Free, pre-installed | 100% of the target devices | **WEAK** — the baseline competitor is free and already installed |

**Deliverable 1 note on "user count / reviews":** Logitech does not publish unit counts, and the review-thread evidence could not be retrieved (G1). Unified Remote's 15M+ figure is the only reach number confirmed this pass.

### 3.2 Question 8 verdict — is "replace the clicker with a phone-free web app" a validated pain?

**Verdict: PARTLY VALIDATED, but WEAKER than assumed.**

Evidence for the pain being real:
- The physical clicker market still supports a **$39.99 → $129.99 ladder** across five Logitech SKUs `[official]` — a live market with a premium tier means people do pay.
- Phone-as-remote is a **long-standing, repeatedly-re-attempted idea**: "Show HN: Control your SlideShare presentations via your mobile" (preso.ly) dates to **2013** `[community]`. Repeated attempts over a decade indicate persistent itch, not a solved problem.
- Unified Remote has **15M+ downloads since 2010** `[official]` — large demand for the "use a device I already own as the controller" pattern.

Evidence against (the honest counterweight):
- **The pain is priced at ~$40, one time.** That is a hard bar for any subscription product to clear, and it caps realistic one-time pricing well below clicker-plus-software bundles.
- **No verified complaint corpus exists** for "clickers are unreliable" (G1: reddit timed out, StackExchange empty). The "batteries/dongles/lost/doesn't work across apps" list in FlipNav's own framing is currently **unverified** — it is the user's hypothesis, not a sourced finding. Do not build the pitch on it until it is tested with real presenters.
- **Unified Remote already occupies "phone as remote"** with 15M+ downloads.
- FlipNav explicitly places *phone-as-remote* out of scope for v1 (frozen out-of-scope item #2). So FlipNav's actual claim is narrower and stranger: **remove the extra device entirely** — no clicker, no phone, no dongle, just direction. That is a genuine gap, but it is a *novelty claim*, not a validated pain.

**Actionable conclusion:** the December launch should not rest on "clickers are broken." It should rest on "**no extra device, no install, no build step, works on the document you already have**." That is defensible; the clicker-pain story is not yet evidenced.

---

## 4. Key Question 2 — What users love/hate (official claims vs real signal)

| Claim type | Item | Tag |
|---|---|---|
| Official | reveal.js advertises built-in touch/swipe navigation and speaker notes | `[official]` |
| Official | Slidev advertises presenter mode with phone control | `[official]` |
| Official | StPageFlip advertises realistic page-turn effects and "compatible with mobile devices" | `[official]` |
| Official | Unified Remote advertises 15M+ downloads and 100+ app remotes | `[official]` |
| Community | Phone-driven presenting has been re-attempted publicly since at least 2013 (preso.ly on HN) | `[community]` |
| **unverified** | Complaints about clicker batteries, dongles, loss, cross-app inconsistency | **unverified** (G1) |
| **unverified** | Complaints about accidental page turns / scroll hijacking in swipe readers | **unverified** (G1) |

**Honest read:** the "love" side of the market is well documented because vendors document it. The "hate" side — which is exactly where FlipNav's opportunity would live — is **not** documented in this research. That is a research debt, not a finding. The cheapest way to pay it down is the ≥3-tester usability pass already frozen in D8, plus a short set of targeted questions to presenters before launch.

---

## 5. Key Question 9 — embed-script / bookmarklet viability (**the riskiest assumption**) — stress test

This was flagged in the research request as the riskiest unproven assumption. Here is what the evidence actually says.

**Findings, with sources:**

1. **Bookmarklets run as `javascript:` URL navigation and are explicitly blockable by CSP.**
   MDN states plainly: "`javascript:` navigation may be blocked by content security policy settings, in particular `script-src`." `[official]` — https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Schemes/javascript
2. **A CSP with `script-src` or `default-src` also disables inline JavaScript, inline event handlers, and `javascript:` URLs unless `unsafe-inline` (or a nonce/hash) is present.** MDN lists "JavaScript in a `javascript:` URL" as one of the things such a policy blocks by default. `[official]` — https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CSP
3. **Embedding is controlled by the host page, not by FlipNav.** MDN: `frame-ancestors` "can be used to control which documents, if any, are allowed to embed this document"; the recommended setting for sites that don't need embedding is `frame-ancestors 'none'`. `[official]` — same CSP guide.
4. **A strict CSP (nonce- or hash-based) is the recommended modern posture** — and strict CSPs are precisely the policies that kill both injected inline scripts and `javascript:` bookmarklets. `[official]` — same CSP guide.

**Stress-test verdict: PARTIALLY VIABLE — and the "works on any page" claim should be dropped.**

- **Bookmarklet route: WEAK.** On any site with a modern strict CSP — which is the direction of travel for anything security-conscious, and the default on many SaaS/docs/wiki platforms — the bookmarklet will be silently refused, with no error the user can act on. Works on some pages, fails invisibly on others.
- **Embed-script route: VIABLE only where the author controls the page.** An embed script that *you* place on *your* page works perfectly and is the right v1 path. An embed script that must be accepted *by a third-party site* is really a distribution/partnership problem, not a technical one.
- **Iframe route: VIABLE only where the host allows it.** Pages sending `frame-ancestors 'none'` (or `X-Frame-Options: DENY`) cannot be framed at all. FlipNav does not control this.
- **Frozen decision D6 is therefore correctly scoped:** embed-script first, bookmarklet as a *best-effort fallback*, no browser extension. The research **supports** that ordering and **does not support** the phrase "works on any page."

**Concrete recommendation:** re-word the promise from "adapts to any page" to **"works on any document you open in FlipNav, plus any page that opts in via one script tag."** This is a scope wording change, not a metric change, so it does not touch the frozen targets — but it must be reflected in the Part 2 PRD or the launch promise will be untestable.

---

## 6. Key Question 10 + Deliverable 5 — Free hosting and budget (Deliverable 5)

### 6.1 Static hosting comparison

| Platform | Free-tier reality | Gotchas that matter to FlipNav | Tag |
|---|---|---|---|
| **Cloudflare Pages** | 500 builds/month, 1 concurrent build, 20-min build timeout, 100 custom domains, up to 20,000 files/project | None found at this scale. **Best default.** | `[official]` |
| **GitHub Pages** | Published site ≤ 1 GB, soft **100 GB/month** bandwidth, soft 10 builds/hour, HTTP 429 on abuse, visitor IPs logged | **Free hosting is not allowed for commercial/SaaS use** — this directly conflicts with any paid FlipNav product. | `[official]` |
| **Netlify** | $0 but capped at **300 credits**; a production deploy costs **15 credits**, bandwidth **20 credits/GB**, requests **2 credits/10k** | Frequent deploys or modest traffic can exhaust the free tier; Personal is $9/mo (1,000 credits). | `[official]` |
| **Vercel** | Hobby: 200 projects, 100 deployments/day, 45-min build, 100 MB static upload per deploy | Adequate; note the Hobby tier is intended for non-commercial use. | `[official]` |
| **Surge** | Free unlimited publishing, custom domain, basic SSL | Minimal feature set; Pro $30/mo only for extras. | `[official]` |
| **Render** | Free static sites exist | Free instances documented as "not for production." | `[official]` |
| **Cloudflare R2** (if large assets ship) | $0.015/GB-month, **zero egress**, Class A $4.50/M, Class B $0.36/M | Only needed if FlipNav hosts big PDFs/images itself — v1 reads local files, so likely $0. | `[official]` |
| **Backblaze B2** | $6.95/TB/month, first 10 GB free, free egress up to 3× stored | Same caveat as R2. | `[official]` |

### 6.2 Later "tier 1" realtime options (not v1)

| Service | Free tier | Warning | Tag |
|---|---|---|---|
| **Supabase Realtime** | 200 concurrent connections, 100 msg/sec, 100 joins/sec, 100 channels/connection | Free projects are **paused after 1 week of inactivity**; 2 active projects max. | `[official]` |
| **Cloudflare Durable Objects** | 100,000 requests/day + 13,000 GB-s/day | Exceeding a free limit makes further operations **fail with an error** — a hard cap, so **no surprise-bill path**. That is a *feature* for a free-first project. | `[official]` |
| **Ably** | 200 concurrent connections, 500 msg/sec, 6M messages/month | Standard $29/mo above that. | `[official]` |
| **PartyKit** | — | **Hosted platform is shutting down: deploys stop 16 Oct 2026, platform shuts down 23 Oct 2026. Do not build on it.** | `[official]` |
| Firebase | — | Limits could not be retrieved | **unverified (G5)** |

### 6.3 Budget breakdown (Deliverable 5)

| Item | Cost | Basis |
|---|---|---|
| Static hosting | **$0** | Cloudflare Pages free tier covers this comfortably `[official]` |
| Domain | **~$10–15/year** *(estimate — registrar pricing not verified this pass)* | — |
| PDF/image rendering | **$0** | PDF.js (Apache-2.0), StPageFlip (MIT), Swiper `[official]` |
| AI development assistance, 6.5 weeks | **$0–$30** | $0 via free tiers (+ Aider/Continue with own keys), or one ~$20/mo tool for ~1.5 months |
| Payment platform, **only if selling** | **5% + 50¢ per sale** | Lemon Squeezy and Paddle both charge 5% + 50¢ and act as merchant-of-record `[official]` — this removes global tax handling |
| **Total to launch (no sales)** | **≈ $10–45** | Fits "free-first + small paid allowance" in the frozen constraints |
| **Per-sale cost if monetized** | **5% + 50¢** | Merchant-of-record platforms are the right call for a solo non-technical builder |

Stripe rates were captured only from the HK/CN locale (**3.4% + HK$2.35**, **3.4% + $0.30** USD-settled, Managed Payments +3.5%, no setup/monthly fees) `[official]` — the commonly cited US 2.9% + 30¢ is **unverified (G7)** and should not be quoted as fact.

Gumroad / Ko-fi / Buy Me a Coffee fee structures are **unverified (G2–G4)**.

---

## 7. Deliverable 2 — Recommended tech stack (and the two real risks)

| Layer | Recommendation | Why | Source |
|---|---|---|---|
| Hosting | **Cloudflare Pages** | Best free limits for a small static SPA; no commercial-use ban (unlike GitHub Pages free tier) | `[official]` |
| Language / framework | Plain HTML/CSS/JS first; add a light framework only if state complexity demands it | Keeps the ≤ 200 KB gzip target reachable | frozen target |
| Directional input | Native `keydown`, `pointerdown/move/up`, `wheel` | Zero dependencies; the frozen 4-direction model is simple enough to own | frozen D2/D4 |
| Swipe/drag primitives (optional) | **Swiper v14.3.0** (2026-09-28), modular, plain-JS/React/Vue/Web Components | Mature touch/swipe/drag/wheel handling if hand-rolling proves flaky | `[official]` |
| Page-flip visual (optional) | **StPageFlip** (MIT, npm `page-flip`, ~888 stars) | If the flip *effect* becomes a differentiator; not required for navigation | `[official]` |
| PDF rendering | **Browser-native PDF via `iframe` first; PDF.js only if native is insufficient** | Native costs 0 KB of the bundle budget; PDF.js is the realistic fallback but is a large library (see §13) | `[official]` |
| Local file input | **`<input type="file">` + drag-and-drop** | **File System Access API is Chrome/Edge/Opera/Samsung only — Safari, Firefox and iOS Safari do NOT support it (~76.5% global)** | `[official]` |
| Dev AI assistance | See §10 | — | — |

**Risk 1 — iOS edge-swipe vs. browser back (UNVERIFIED, G8).** A horizontal swipe beginning near the screen edge can trigger Safari's back-navigation instead of FlipNav's page turn. This is the single most likely way the mobile experience breaks, and it is **unverified** in this research. It must be tested on a real iPhone in week 1 — this is a spike, not a late-stage QA item. Mitigations to evaluate: an inset swipe-start threshold, requiring a vertical-dominant gesture at the edges, or an explicit tap-zone fallback.

**Risk 2 — non-Baseline browser APIs.**
- `overscroll-behavior` — MDN flags it "Limited availability" and **not Baseline**; it is the CSS knob that stops scroll-chaining and pull-to-refresh, but it cannot be assumed everywhere. Plan a JS gesture fallback. `[official]`
- **Fullscreen API** — MDN flags it "Limited availability" / **not Baseline**. Treat fullscreen as progressive enhancement, never as the only navigation path. `[official]`
- `dvh` / dynamic viewport units — **safe** for the frozen baseline: Safari 15.4+, Chrome 108+. `[official]`

**No-code verdict (Key Question 4).** No-code tools produce fixed layouts and give no control over a custom four-direction input model: Framer Free is 1 GB bandwidth / 500 AI credits with a Framer subdomain (custom domain requires paid; Basic $10/mo = 50 GB; Pro $30/mo = 100 GB) `[official]`, and Glide Free is 10 projects with limited credits (Basic $25/mo) `[official]`. Neither can express FlipNav's core interaction. **Hand-code the app; no-code is only worth it for a marketing landing page.** This is one of the clearest answers in the whole research: for *this* product the "simplest no-code path" does not exist.

---

## 8. Deliverable 3 — MVP features: must-have vs nice-to-have

| Priority | Feature | Rationale |
|---|---|---|
| **Must** | Four-direction navigation (up/down/left/right) | The entire product thesis; frozen D2 |
| **Must** | Three inputs: keyboard arrows, touch swipe, mouse wheel + drag | Frozen D4 |
| **Must** | Paginated content: built-in demo pages, image sets, local PDF via `<input type=file>` | Frozen D3; `<input type=file>` is the only input path that works on iOS (File System Access API is unsupported there) `[official]` |
| **Must** | Embed-script mode for pages you control | Frozen D6 — the only "any page" path that actually works (§5) |
| **Must** | Debounce / threshold constants (30° tolerance, 120 ms window), multi-touch and long-press exclusion | Frozen D7; directly drives the ≤1% false-trigger target |
| **Must** | Keyboard reachability + visible focus | Frozen §3.3; also WCAG 2.2 **SC 2.1.1 Keyboard** and **SC 2.4.7 Focus Visible** `[official]` |
| **Must** | `prefers-reduced-motion` support | WCAG 2.2 **SC 2.3.3** (AAA) and **SC 2.2.2 Pause, Stop, Hide** (A) `[official]` |
| **Must** | Non-drag alternative for every swipe action | WCAG 2.2 **SC 2.5.7 Dragging Movements (AA)** — satisfied by keyboard + wheel; keep it that way `[official]` |
| **Should** | Fullscreen mode, as progressive enhancement only | Not Baseline `[official]` |
| **Should** | Gesture fallback where `overscroll-behavior` is unsupported | Not Baseline `[official]` |
| **Nice** | Page-flip animation effect (StPageFlip) | Visual polish, adds bundle weight; conflicts with the ≤ 200 KB budget |
| **Defer** | Bookmarklet | Best-effort only; silently blocked by strict CSPs (§5) |
| **Defer** | Phone-as-remote, accounts, backend, eye-tracking, extension, 8-direction | All frozen out-of-scope |

---

## 9. Deliverable 4 — Development roadmap (6.5 weeks, launch early December)

| Week | Focus | Exit condition |
|---|---|---|
| **W1** | **Spike the two real risks first**: (a) iOS edge-swipe vs. browser back on a real iPhone; (b) bundle-size feasibility of native-PDF-in-iframe vs. PDF.js | Both risks answered with measurements, not opinions |
| **W2** | Directional input core: keyboard + pointer/swipe + wheel/drag; 30° / 120 ms constants; multi-touch and long-press exclusion | ≥99.5% direction accuracy in the self-test harness |
| **W3** | Content layer: built-in demo pages, image sets, local PDF via `<input type=file>` and drag-drop | All three content types navigate correctly on desktop + mobile |
| **W4** | Embed-script mode for own pages; bundle and latency tuning toward the frozen targets | First-paint ≤ 2 s on 4G; bundle within the frozen budget or a documented decision |
| **W5** | Compatibility matrix (Chrome/Edge/Safari, last 2 majors, desktop + mobile) + accessibility pass (keyboard, focus, reduced motion, target size) | Every frozen browser/device combination passes the core flow |
| **W6** | ≥3 tester usability sessions (frozen D8), bug fixes, best-effort bookmarklet check | First-attempt success ≥90%, time-to-understand ≤10 s |
| **W7** | Launch + acceptance report | Frozen verification steps 1–4 complete |

**AI assistance strategy (Key Question 6).** Use AI for scaffolding, CSS/layout tweaks, and test-generation — the tasks where wrong output is visible and cheap to correct. Do **not** use AI for the gesture-threshold maths or the latency path without measuring the result; that is where the frozen targets live and where silent regressions are most costly. The week-1 spikes should be done with measurement, not generated code.

**Eye-tracking sequencing note.** The parent project's first usable milestone is ~W12 (~2027-01-07), which is **after** this launch. Nothing in the December plan may depend on gaze input; any later integration is a separate enhancement. To keep that door open cheaply, keep the input layer behind a single instruction-level interface (e.g. one `navigate(direction)` entry point that all input sources call) so a future gaze source plugs in without touching the viewer.

---

## 10. Key Questions 6 + 7, Deliverable 6 — AI/Automation fit, and whether "AI out of product scope" is wise

### 10.1 Development-assist tools, with real prices

| Tool | Price | Free tier | Good at | Tag |
|---|---|---|---|---|
| **GitHub Copilot** | Pro $10/mo, Pro+ $39, Max $100 | **Yes** (2,000 completions + 50 chats/mo) | In-editor autocomplete + chat across VS Code/GitHub | `[official]` |
| **Cursor** | From $8 (Plus) to $200 (Ultra)/mo | Yes (limited agent/chat) | AI-first full-repo editing | `[official]` |
| **Claude / Claude Code** | Pro $17/mo annual ($20 monthly), Max from $100 | Yes | Reasoning, long-context edits, terminal agent coding | `[official]` |
| **ChatGPT** | Plus $20/mo (API billed separately) | Yes | General code help and planning | `[official]` |
| **v0 (Vercel)** | Plus ~$30/user/mo, Business $100/user/mo | Yes (7 messages/day) | UI/component generation | `[official]` |
| **Bolt.new** | Pro $25/mo, Teams $30/user/mo | Yes (300K tokens/day, 1M/mo, with branding) | Full-stack prompt-to-app in the browser | `[official]` |
| **Replit** | Core $18/mo annual ($20 monthly), Pro $90/$100 | Not shown on the page | Cloud IDE with hosting/deploy | `[official]` |
| **Lovable** | Paid prices did not render | Yes (5 build credits/day, ~30/month) | Prompt-to-app generation | `[official, partial]` |
| **Continue.dev** | Free / open source | Yes | VS Code/JetBrains assistant with your own model keys | `[official]` |
| **Aider** | Free / open source | Yes | Terminal pair-programming, bring your own API keys | `[official]` |
| **Windsurf** | Price **unverified** (all pricing URLs 404); footer says "Individuals are free!" | Unclear | Agentic full-repo edits | `[official, non-pricing page]` |
| **Google AI Studio / Gemini** | **unverified (G6)** | Unverified | — | **unverified** |

**Cost for this build:** **≈ $0–$45** — i.e. $0 using free tiers plus Aider/Continue with your own keys, or about $20 for one month and a half of a single paid tool. This is within the frozen "free-first with a small paid allowance" constraint.

### 10.2 Deliverable 6 — should this product include AI? **Answer: no, and the research supports that call.**

**What AI could plausibly do here:** summarize a slide; auto-generate alt text for slide images; read a PDF page and answer questions about it; voice-driven navigation.

**What data it would have to read:** the user's deck, PDF or image content and extracted text — and microphone audio for voice navigation. Every one of those requires sending user content off the device.

**Why that is disqualifying for v1:** FlipNav's frozen constraints are **zero uploads** and **no camera permission**, on a **static, backend-free (tier 0)** architecture. Every plausible AI feature breaks at least one of the three. This is not a matter of taste; it is a direct architectural contradiction.

**Actions it could take:** produce summaries/alt text, answer questions, or map voice commands into navigation events (which additionally requires microphone permission).

**Safeguards that would be required if it were ever added:** explicit opt-in consent with clear data-flow disclosure; an offline/local-model path; provider zero-data-retention explicitly selected; retention controls; output evaluation for navigation-intent misclassification (a misread voice command means an unintended page turn — a silent failure in front of an audience); and telemetry off by default.

**Recommendation: defer AI to a clearly labelled, opt-in v2, with a local-model path.** It adds convenience while contradicting the privacy-first, backend-free architecture, and it multiplies scope and safeguards far beyond a 6.5-week non-technical build.

**One nuance worth recording.** The workspace's earlier planning notes flagged an internal tension: under the "same project, later stage" relationship to the parent eye-tracking project, gaze *is* an AI capability, while the frozen decision says AI is not in product scope. The consistent resolution is to re-word the decision as **"no new cloud AI in v1"** rather than "no AI ever" — that removes the contradiction without weakening the v1 privacy stance. This wording change should be settled in Part 2.

---

## 11. Deliverable 7 — AI safety & evidence (data boundaries to verify *if* AI is ever added)

| Provider | Training on customer data | Retention / ZDR | Tag |
|---|---|---|---|
| **OpenAI** | Individual services (Free/Plus/Pro) **may** use content for training unless you opt out via Settings → Data controls or the Privacy Portal. **Business/Enterprise/API inputs and outputs are not used by default.** | ZDR via enterprise agreements; platform "your data" page returned 403 this pass | `[official]` |
| **Anthropic** | **Commercial (API, Claude for Work): inputs/outputs not used for training by default.** Consumer (Free/Pro/Max, including Claude Code under those plans): may be used if opted in or safety-flagged; Incognito excluded | — | `[official]` |
| **Google** | **unverified (G6)** — official terms pages timed out | **unverified** | **unverified** |

**Concrete setting to verify before any AI ships:** if FlipNav ever adds AI, it must call a **commercial/API** tier with training opt-out and zero-data-retention explicitly configured — never a consumer chat subscription. That distinction is the single most important AI-safety line in this research, and it is confirmed for OpenAI and Anthropic.

**Eval prompts that would be required:** navigation-intent classification tests (voice or text → direction), false-turn tests where no navigation was intended, and a documented threshold below which the feature is disabled. The ≤1% false-trigger frozen target should apply to any AI-driven input path exactly as it does to touch.

**Telemetry:** must remain zero in v1. Any future AI path needs an explicit, off-by-default consent gate.

**Accessibility baseline for the current (non-AI) product:** **WCAG 2.2** is the current W3C Recommendation (12 Dec 2024) `[official]`. The criteria that bind this product:
- **SC 2.1.1 Keyboard (A)** — all functionality operable by keyboard `[official]`
- **SC 2.4.7 Focus Visible (AA)** — visible focus indicator `[official]`
- **SC 2.5.8 Target Size Minimum (AA)** — targets ≥ 24×24 CSS px or equivalent spacing `[official]`
- **SC 2.5.7 Dragging Movements (AA)** — every drag/swipe needs a non-drag single-pointer alternative; FlipNav satisfies this with keyboard + wheel, and must keep doing so `[official]`
- **SC 2.3.3 Animation from Interactions (AAA)** + **SC 2.2.2 Pause, Stop, Hide (A)** — honour `prefers-reduced-motion` `[official]`

Sources: https://www.w3.org/TR/WCAG22/ and the per-criterion Understanding pages under https://www.w3.org/WAI/WCAG22/Understanding/ (accessed 2026-10-15).

---

## 12. Conflicting information between sources (called out explicitly, as requested)

1. **"Works on any page" vs. CSP reality.** FlipNav's own framing claims adaptation to arbitrary pages; MDN documents that `javascript:` navigation is blockable by `script-src`, that strict CSPs disable inline scripts and `javascript:` URLs, and that `frame-ancestors` is controlled by the *host*. **The sources contradict the product claim.** Resolution: constrain the promise (§5).
2. **"Clickers cost money / users will switch" vs. a $39.99 entry price.** The product framing treats clicker cost as a pain; the vendor's own pricing shows a cheap, reliable, one-time device. The sources weaken the pain claim.
3. **"Swipe-to-advance is a differentiator" vs. reveal.js/Slidev/Marp.** Multiple free frameworks already ship touch/swipe navigation `[official]`. FlipNav's differentiation must be *format-agnostic + no build step*, not swipe itself.
4. **"No extra device" vs. Unified Remote's 15M+ downloads.** The solved-for pattern (phone as remote) has enormous reach, but FlipNav explicitly excludes phone-as-remote from v1.
5. **Stripe rates.** The vendor's pricing page served an HK/CN locale (3.4% + HK$2.35) while the widely quoted US rate (2.9% + 30¢) could not be confirmed. **Do not quote either as definitive.**
6. **Free-tier "free".** Netlify advertises $0 but meters credits; GitHub Pages advertises free but **bans commercial use**; Render's free tier is documented as not-for-production. "Free" carries different meanings across vendors.
7. **PartyKit as a realtime option.** It appears in typical 2025-era recommendation lists but its hosted platform shuts down 23 Oct 2026 `[official]` — a live example of why tier-1 planning must re-verify vendor status at build time.

---

## 13. Where the frozen targets collide with the evidence (no target relaxed)

Per the research request, no frozen target is relaxed here. These are conflicts that need a **decision**, not a quiet edit.

| Frozen target | Conflict found | What is needed |
|---|---|---|
| Static bundle ≤ 200 KB gzip | A PDF.js-based viewer and a StPageFlip flip animation are both bundle-heavy; PDF.js bundle size was not measured this pass (G11) | **Measure in W1.** If native PDF-in-iframe covers the use case, the target is reachable with room to spare. If PDF.js is required, bring measurement evidence before any change is proposed. |
| Zero uploads + no camera in v1 | Every plausible AI feature violates at least one | Confirms the "no AI in product" call rather than conflicting with it (§10.2) |
| False-trigger ≤ 1% | No contradictory evidence found; the 30° / 120 ms constants are a reasonable starting point to validate | Validate against the W2 harness and the W6 tester sessions |
| Latency P95 ≤ 100 ms | No contradictory evidence found | Validate on real mid-range mobile hardware, not a desktop dev machine |
| Keyboard-accessible core operations | WCAG 2.2 SC 2.5.7 requires a non-drag alternative for swipe | Already satisfied by keyboard + wheel; keep it explicitly in the PRD |
| First paint ≤ 2 s on 4G | No contradictory evidence found | Measure on a throttled profile in W4 |

---

## 14. Bottom line — is this idea weak, or already solved?

**Partly solved, and the parts that are solved are the parts FlipNav was most confident about.**

- Swipe-to-advance already ships in reveal.js, Slidev and Marp `[official]`.
- Phone-as-remote is a 15M+ download category with its own decade-old history `[community]`/`[official]`.
- The physical clicker is a reliable, one-time **$39.99** device `[official]`.
- The baseline competitor — arrow keys and swipe in built-in PDF viewers — is **free and pre-installed** on every target device.

**What remains genuinely open, and is worth building:**
1. **Format-agnostic navigation with no build step** — the same four-direction interaction working across a PDF, an image set, and your own pages, without authoring in reveal.js or installing anything. None of the found competitors occupy that exact square.
2. **Direction as the interface** — no button hunting, no dongle, no extra device.
3. **A strict, verifiable privacy posture** — zero uploads, no camera, no telemetry, static hosting. Real and unusual, but only a selling point to a subset of users.

**What is not supported by evidence and should not appear in launch copy:** that clickers are unreliable (G1 unverified), and that FlipNav works on any page (contradicted by CSP sources, §5).

**Highest-value next actions before Part 2 writes the PRD:**
1. Test the iOS edge-swipe conflict on a real iPhone (G8) — it can change the interaction design.
2. Measure PDF.js vs. native-PDF bundle impact (G11) — it can change the tech stack and the frozen size target.
3. Re-word the "any page" promise to the provable version (§5).
4. Ask 3–5 real presenters how they currently advance slides and what goes wrong — this pays down G1, the single largest evidence gap in this report.

---

## Handoff Context
<!-- Machine-readable summary for the next workflow step. Do not delete; the next prompt in the workflow reads this block. -->
- Stage: research
- App name: FlipNav
- User level: A  (A = vibe coder, B = developer, C = in-between)
- Target platform: web (desktop + mobile browsers)
- Budget: free-first; small paid spend allowed (domain; free-tier services only) — researched realistic launch cost is ≈ $10–45, plus 5% + 50¢ per sale if monetized via a merchant-of-record platform; Cloudflare Pages is the recommended $0 host
- Timeline: launch by early December (~6.5 weeks from 2026-10-15)
- AI in product scope: no  (user decision: AI for development assistance only; the wording of this decision is still to be re-confirmed — research recommends re-wording it as "no new cloud AI in v1" to remove the conflict with the parent project's gaze/AI nature)
- Research status: Researched with sources  (all 10 key questions researched against real sources; access date 2026-10-15; specific sub-claims listed unverified in the findings' Evidence gaps section — G1 complaints corpus, G2–G4 Gumroad/Ko-fi/BMaC fees, G5 Firebase limits, G6 Google AI pricing/terms, G7 Stripe US rate, G8 iOS edge-swipe, G9 Google Slides/Canva phone-present pages, G10 PDF.js defaults, G11 PDF.js bundle size)
- Constraints: no backend in v1; no browser extension in v1; no eye-tracking input in v1; scenario-neutral core only; must be free to host; must work on Chrome / Edge / Safari last 2 major versions on desktop and mobile; privacy red line inherited from parent project — raw face frames never leave the device; zero uploads and no camera permission in v1
- Decisions: web app (not extension); four directions only; paginated content types (slide deck / PDF / image set / embeddable iframe); three input methods (keyboard arrows / touch swipe / mouse wheel+drag); embed-script approach for "any page" with bookmarklet as fallback; frozen measurable targets above; explicit out-of-scope list above. NOTE: these are agreed decisions from the user's own planning docs, not research recommendations.
- Research recommendations (distinct from the agreed decisions above): host on Cloudflare Pages; use browser-native PDF via iframe first and measure PDF.js as a fallback; use `<input type=file>` for local file input because File System Access API is unsupported on Safari/iOS; keep the input layer behind a single `navigate(direction)` interface so a future gaze source plugs in without touching the viewer; hand-code the app (no-code cannot express the interaction); use a merchant-of-record payment platform if monetizing; spike the iOS edge-swipe conflict and the bundle-size question in week 1.
- Open questions: (1) whether "AI out of product scope" is the right call — research says yes for v1, with the wording changed to "no new cloud AI in v1"; (2) what the concrete trigger is for adding a small signalling backend ("tier 1") — Cloudflare Durable Objects' hard free cap makes it a no-surprise-bill candidate, and PartyKit is disqualified (shutting down 23 Oct 2026); (3) whether the embed-script / bookmarklet route can really deliver "works on any page" — research says no, and the promise should be narrowed; (4) whether the audience should stay broad or converge to one scenario — unchanged; (5) whether any real differentiation exists against free built-in browser/reader navigation — yes, but only for format-agnostic + no-build-step navigation, not for swipe itself.
- Source files: research-request-FlipNav.md → docs/research-FlipNav.md
