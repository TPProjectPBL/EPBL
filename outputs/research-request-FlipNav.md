## Deep Research Request: FlipNav

<context>
I'm a non-technical founder building **FlipNav** — a browser-based web app that replaces "next / previous page" buttons (and physical presenter clickers / slide remotes) with simple directional input: **up / down / left / right**.

The user opens or loads a paginated document — a slide deck, a PDF, or a set of images — and navigates it in a clean full-screen viewer using arrow keys, touch swipes, or mouse wheel/drag. There is no page-turn button to hunt for; direction is the interface.

I am deliberately NOT committing to a single audience yet. One neutral core is meant to serve three groups:

1. **Presenters / teachers** — clickers cost money, get lost, run out of battery, and don't work consistently across apps.
2. **Readers of ebooks / manga** — existing readers already have decent swipe and flip, so this is the hardest group to differentiate against.
3. **Accessibility / large-screen users** — people who find a mouse or keyboard awkward, or who stand far from a big screen.

I need beginner-friendly research with actionable insights.

### Hard constraints I have already decided (do not design around these being optional)

- **Platform:** web app (browser). Must be usable on **desktop AND mobile browsers**.
- **Backend:** **none for v1** — static hosting only, all state in the browser ("tier 0"). A tiny signalling service is a possible later tier, not now.
- **Budget:** **free-first**, with a small paid allowance (a domain, and possibly a free-tier service later).
- **Timeline:** launch by **early December** (roughly **6.5 weeks** starting mid-October).
- **AI:** **not part of the product**. AI is only used to accelerate my own development. (This framing is still to be re-confirmed — treat it as an open question.)
- I am **not** building a browser extension for v1, and I am **not** promising to take over arbitrary third-party websites.
- **Scenario-neutral:** no presenter view, no manga continuous-scroll, no accessibility-specific hotzones in v1.

### Context that is NOT in this chat (important — please read)

This app is the **downstream application layer** of a separate, larger project: an **on-device gaze / eye-tracking system** (mobile, iOS/Android, 16-week schedule, first usable milestone roughly 12 weeks out from mid-October).

- Eye tracking will **NOT** be available for the December launch. It is planned as a **later enhancement only**.
- That parent project's privacy red line: **raw face frames never leave the device**. Any design that ships video or face data to a server would violate it.

So for v1, the only inputs are keyboard, touch, and mouse — treat eye/gaze input as out of scope, but flag anything that would make a later gaze-input integration easier or harder.
</context>

<instructions>
### Key Questions to Answer:

1. **What similar apps exist and what features do they have?** Cover presentation controllers and clicker apps, web-based slide viewers, PDF/image viewers, page-flip readers, remote-control apps, and accessibility navigation tools.
2. **What do users love/hate about existing solutions?** Use app-store reviews, Reddit, Hacker News, and forum threads. Separate official claims from real user complaints.
3. **What's the simplest way to build an MVP?** Assume a static web app with no backend.
4. **What no-code / low-code tools are best for this?** And where is hand-coding actually simpler than a no-code stack?
5. **How do similar apps monetize and what can I realistically charge?** Include free, one-time, and subscription models with real price points.
6. **What AI tools or APIs can accelerate development?** (Development assistance only — not product features.)
7. **AI is currently OUT of product scope. Confirm whether that is wise**, and if AI were added later, what data it could read, what actions it could take, and what approval / eval safeguards would be required.

### Additional questions specific to this project:

8. **Is "replace the physical clicker with a phone-free web app" a real, validated pain**, or is the clicker market already solved well enough that users won't switch? Find evidence either way.
9. **The embed-script / bookmarklet approach** — is it actually viable for "works on any page"? What are the hard limits, and what breaks? **This is the riskiest unproven assumption in the plan** — stress-test it.
10. **Free static hosting options** for a small web app (and optional free-tier realtime service if a later tier needs one) — compare limits, cold starts, and gotchas.

### Research Focus:

- Simple, actionable insights with examples
- Current tool recommendations (prioritize newest / best)
- Step-by-step implementation guidance
- Cost estimates with free / paid options
- Examples of similar successful projects
- Honest signal on where this idea is weak or already solved

### Frozen measurable targets — do NOT propose relaxing these without evidence:

| Target | Threshold |
|---|---|
| Direction-decision accuracy | ≥ 99.5% |
| False-trigger rate (no input → no page turn) | ≤ 1% |
| End-to-end latency (input event → frame updated) | P95 ≤ 100 ms; target ≤ 50 ms |
| First interactive paint on 4G | ≤ 2 s |
| Static bundle size | ≤ 200 KB gzip |
| Uploaded user content / telemetry | zero |
| Camera permission requested in v1 | none |

### Explicitly out of scope for v1 (do not recommend adding):

Backend services, accounts, phone-as-remote for big screens, eye-tracking input, browser extensions, scenario-specific features, 8-direction navigation, and taking over arbitrary third-party sites' native scrolling.

### Required Deliverables:

1. **Competitor Table** — Features, pricing, user count, reviews
2. **Tech Stack** — Recommended tools for beginners
3. **MVP Features** — Must-have vs nice-to-have prioritization
4. **Development Roadmap** — With AI assistance strategy
5. **Budget Breakdown** — Tools, services, deployment costs
6. **AI/Automation Fit** — Whether this should include AI product features or automation
7. **AI Safety & Evidence** — Data boundaries, provider retention/training setting to verify, eval prompts, telemetry, and confirmation gates if AI is in scope
</instructions>

<output_format>
- Explain everything in plain English with examples
- **Include source URLs with access dates** for each major recommendation
- Use tables for comparisons
- Highlight any conflicting information between sources
- Separate official-doc facts from community/anecdotal signal
- Produce findings as `research-FlipNav.md` (final project path: `docs/research-FlipNav.md`), separate from this research request.
- Begin the findings with **Research status: Researched with sources / Partial research / Not researched — unverified hypotheses**, choosing the status that reflects work actually performed.
- If browsing is unavailable, say so. Offer clearly labeled hypotheses and unanswered questions; do not invent citations, access dates, current prices, or research results. Record any decisions still requiring sourced research.
- End the findings with this filled Handoff Context so Part 2 works in a fresh chat. Preserve user-provided constraints and distinguish agreed decisions from research recommendations.
- After the saved findings, outside the document, tell the user: "Save research-FlipNav.md. Next, paste the complete part2-prd-mvp.md prompt into a chat and attach these findings. You may use a new chat; no earlier conversation is required."

Use this Handoff Context at the end of the findings:

```
## Handoff Context
<!-- Machine-readable summary for the next workflow step. Do not delete; the next prompt in the workflow reads this block. -->
- Stage: research
- App name: FlipNav
- User level: A  (A = vibe coder, B = developer, C = in-between)
- Target platform: web (desktop + mobile browsers)
- Budget: free-first; small paid spend allowed (domain; free-tier services only)
- Timeline: launch by early December (~6.5 weeks from 2026-10-15)
- AI in product scope: no  (user decision: AI for development assistance only; the wording of this decision is still to be re-confirmed)
- Research status: [to be filled by the findings — do not pre-fill]
- Constraints: no backend in v1; no browser extension in v1; no eye-tracking input in v1; scenario-neutral core only; must be free to host; must work on Chrome / Edge / Safari last 2 major versions on desktop and mobile; privacy red line inherited from parent project — raw face frames never leave the device; zero uploads and no camera permission in v1
- Decisions: web app (not extension); four directions only; paginated content types (slide deck / PDF / image set / embeddable iframe); three input methods (keyboard arrows / touch swipe / mouse wheel+drag); embed-script approach for "any page" with bookmarklet as fallback; frozen measurable targets above; explicit out-of-scope list above. NOTE: these are agreed decisions from the user's own planning docs, not research recommendations.
- Open questions: (1) whether "AI out of product scope" is the right call; (2) what the concrete trigger is for adding a small signalling backend ("tier 1"); (3) whether the embed-script / bookmarklet route can really deliver "works on any page"; (4) whether the audience should stay broad or converge to one scenario; (5) whether any real differentiation exists against free built-in browser/reader navigation
- Source files: research-request-FlipNav.md → docs/research-FlipNav.md
```
</output_format>
