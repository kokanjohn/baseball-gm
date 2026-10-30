# Baseball GM — Rebuild Master Plan
> Living document. Updated throughout the planning process before any code is written.
> Version: 1.0 — planning complete, ready for Phase 0

---

## Table of Contents

1. [Core Design Principles](#1-core-design-principles)
2. [Tech Stack & Deployment](#2-tech-stack--deployment)
3. [File & Module Architecture](#3-file--module-architecture)
4. [Canonical Data Model](#4-canonical-data-model)
5. [State Machine — Season Phases](#5-state-machine--season-phases)
6. [Module Contracts](#6-module-contracts)
7. [Sim Engine Design](#7-sim-engine-design)
8. [Live Game Engine Design](#8-live-game-engine-design)
9. [Trade System Design](#9-trade-system-design)
10. [Card System Design](#10-card-system-design)
11. [Injury Card Redesign](#11-injury-card-redesign)
12. [Push Notification Architecture](#12-push-notification-architecture)
13. [Build Order](#13-build-order)
14. [Open Design Questions](#14-open-design-questions)
15. [Known Issues from v1 — Resolution Notes](#15-known-issues-from-v1--resolution-notes)

---

## 1. Core Design Principles

These are non-negotiable rules that apply to every module and every card. Any implementation decision that conflicts with these principles is wrong by definition.

### 1.1 Every Card Needs a Real Decision
Every inbox message must present the GM with a genuine tradeoff — not just information delivery. A card that has no meaningful choice either needs one added or should not be a card at all.

**Banned patterns:**
- "Got It" as the only action
- Yes/No where both options lead to the same meaningful outcome
- Information-only cards that could be a toast notification instead

**Valid decision categories:**
- **Immediate in-game decisions** — lineup changes, pitching moves, injury responses
- **Roster/transaction decisions** — IL moves, call-ups, DFA
- **Strategic decisions** — trades, extensions, free agent offers
- **Uncertainty decisions** — incomplete information where the GM must bet on an outcome
- **Resource tradeoffs** — budget, morale, atmosphere, OVR in tension with each other

### 1.2 Injuries Are Two-Act Events
Players injured during a live game produce two separate cards. This matches real-world GM experience and creates meaningful uncertainty as a mechanic.

**Act 1 — During the game (INGAME card)**
- Immediate, uncertain. "Left the game in the 3rd. Being evaluated."
- GM decision is immediate: burn a roster move now? Adjust lineup for the rest of this game?
- Diagnosis is NOT known yet.

**Act 2 — Post-game or next day (FOLLOWUP card)**
- The actual diagnosis arrives.
- GM decision is consequential: 10-day IL or 60-day IL? Who gets called up? Is this the moment to make a trade?
- Occasionally Act 2 is better or worse than Act 1 suggested (uncertainty mechanic).

Both acts must have a genuine decision. Neither can be a "Got It."

### 1.3 Trade Cash Direction Is Deterministic
Cash direction in trades is never ambiguous and never wrong.

**Rule:** If the incoming player's rating is LOWER than the outgoing player's rating, the user RECEIVES cash (the other team sweetens the deal). If the incoming player's rating is HIGHER, the user PAYS cash (the user is acquiring the better player).

**Formula (to be finalized in Section 9):**
- Rating differential drives cash amount
- Cash note in the card body must accurately describe direction: "They'll send $X" vs "You'll send $X"
- Card labels must reflect direction: "Accept (receive $X)" vs "Accept (send $X)"

### 1.4 The League Player Pool Is the Root Entity
Everything in the game is built on top of the player pool. No game mechanic should be designed without first asking: "What does this do to a player object?"

The `Player` object is the single source of truth for every person in the game. There is one canonical player object per player, referenced by roster, trade, IL, stats, and history systems — never copied or duplicated.

### 1.5 No Patch Fixes — Fix the Bone, Not the Symptom

When a bug is identified, the correct response is never to patch the symptom. Every fix must:

1. **Trace to root cause** — what fundamental assumption, data model flaw, or ownership violation caused this?
2. **Assess blast radius** — does that root cause affect anything else? Fix all of it, not just the reported symptom.
3. **Fix structurally** — the fix changes the underlying design, not the surface behavior.

A patch fix is defined as: any change that makes the symptom go away without addressing why it happened. Patch fixes are banned. They compound — each one makes the next bug harder to find and the codebase harder to reason about.

**In practice this means:**
- If a trade places the wrong player in the wrong slot, the question is not "how do we correct the slot" — it is "why does RosterEngine not own this placement exclusively?"
- If a card fires at the wrong time, the question is not "add a guard clause" — it is "is the phase state machine incomplete?"
- If a notification doesn't fire on Android, the question is not "retry the setTimeout" — it is "what is the correct architecture for background delivery?"

This principle also applies to planning. If something being designed feels like it requires a special case or an `if` branch to handle a known edge case, that is a signal the underlying model is wrong — not that we need the special case.

**Transparency rule:** If a suggestion made during planning or building looks like it's patching rather than fixing, flag it explicitly and trace back to the root before proceeding.

### 1.6 Constants Over Magic Numbers

Every mechanical value lives in `data/constants.js` as a named constant — never hardcoded inside engine logic. This rule enables: post-playtesting tuning without engine changes, accurate wiki documentation, and the difficulty preset system (Section 29).

If a number appears in engine code that isn't derived from state, it must be imported from constants. No exceptions.

### 1.7 Multiplayer-Informed Architecture

Multiplayer leagues are a known future implementation — not in scope for this rebuild, but the architecture must not prevent it. Every structural decision should be evaluated against the question: "Does this close the door on multiplayer later?"

**Architectural choices required by this principle:**

- **Pure game logic functions:** `SimEngine`, `RosterEngine`, `CardEngine`, `TradeEngine` take state as input and return new state as output. No DOM access, no direct storage writes, no side effects inside game logic. These functions must be able to run server-side without modification.
- **Globally unique UUIDs for all entities:** Players, teams, cards, save slots — all identified by UUID generated at creation. Never sequential integers. Two clients generating IDs independently must never collide.
- **Plain JSON-serializable state:** No `Map` objects, no `Set` objects, no circular references, no functions stored in state. Everything in state must survive `JSON.stringify()` / `JSON.parse()` round-trips. This enables network transmission, Firestore storage, and state diffing.
- **League simulation isolation:** `SeasonEngine` runs the league sim with no assumptions about whether it's running client-side or server-side. It receives state, returns updated state. Moving it server-side for multiplayer is a deployment change, not an architectural rewrite.

**What this principle does NOT require now:**
- No backend infrastructure
- No user authentication
- No real-time synchronization
- No shared state management

Those are built when multiplayer is the actual project. This principle only constrains *how* we build the single-player game so the door stays open.

### 1.9 Archetypes Are the Difficulty System

There is no separate difficulty setting. The archetype selection IS the difficulty selection — framed as an in-world franchise context rather than a meta-game toggle.

The challenge profile of each archetype:

| Archetype | Challenge type |
|---|---|
| Ember | Hard start — thin roster, tight finances, must build from nothing |
| Lab | Patient hard — efficient roster but slow payoff, process-dependent |
| Gambler | Chaotic hard — high variance, unpredictable ownership, boom-or-bust |
| Institution | Medium — reliable but inflexible, veteran dependency |
| Contender | Medium-hard — good roster but immediate playoff pressure |
| Empire | Pressure hard — elite roster but championship-or-bust every season |

All teams play the same mechanical game — same win probability formula, same injury rates, same card expiry windows. The difficulty comes entirely from roster quality, financial parameters, and ownership expectations, which are defined per archetype in Section 16.6. No separate constants, no preset system, no meta-game layer.

A user who wants an easy experience picks Empire and enjoys sustained excellence with a strong roster. A user who wants the hardest challenge picks Ember and grinds a full rebuild. The framing is always in-world.

### 1.10 No Spaghetti State

State is owned by exactly one module. No module reaches into another module's state directly — it calls a function or dispatches an event. This is the single rule that would have prevented most of v1's bugs.

### 1.11 Build Quality Standard — Correct Once, Correct Always

Every phase of this build is treated as permanent. Nothing moves forward on the assumption it will be "cleaned up later." This principle has four practical rules:

**Rule 1 — Retroactive correctness.** If a gap, incorrect assumption, or weak test is discovered in a completed phase, it is fixed immediately before the current phase continues — not noted for later. Later never comes. The fix is applied to the root cause, the gate test is strengthened to catch the same class of error in future, and the plan document is updated to reflect what was learned.

**Rule 2 — Structural gate tests.** Every phase gate test must verify structural correctness, not just syntax validity and export presence. This means: exact counts (roster sizes, array lengths, game counts), required fields on every generated object, value ranges (OVR within bounds, scores non-negative), and cross-system consistency (a constant defined in constants.js matches the count generated by a factory).

**Rule 3 — Pre-build audit.** Before building each phase, the builder explicitly states what assumptions are being carried forward from previous phases, verified against the actual built output — not against memory or the plan document. If an assumption can't be verified against the code, it is verified by running a test.

**Rule 4 — Decisions surfaced immediately.** Any decision that needs to be made during a build — a number that's TBD in the plan, a cross-system interaction that wasn't fully specified, an architectural choice between two valid approaches — is surfaced to the owner before code is written, not discovered after. If the builder can resolve it from the plan without ambiguity, they do so and note it. If not, they stop and ask.

**What this looks like in practice:**
- The roster count error in Phase 2 (BP_COUNT=7 instead of 5) would have been caught by a gate test asserting `starterCount + benchCount + spCount + bpCount + pbCount === 28`.
- The missing `_tickOffset` field would have been caught by a pre-build audit asking "what fields does GameEngine's tick() need on the game object that aren't there yet?"
- The farm/waiver rule clarification was correctly surfaced before Phase 3 — that is the right pattern.

This principle applies to the plan document itself. If the plan is discovered to be incomplete or incorrect, it is updated immediately. The plan is the source of truth, and it must stay accurate.

---

## 2. Tech Stack & Deployment

**Unchanged from v1 — deliberately chosen for simplicity and zero build tooling.**

| Concern | Solution |
|---|---|
| Language | Vanilla JavaScript (ES2020+, native modules) |
| Markup/Style | HTML5 + CSS3 with custom properties |
| Module system | Native ES modules (`type="module"`) — no bundler |
| Persistence | IndexedDB via thin wrapper |
| Theme preference | `localStorage` |
| Hosting | GitHub Pages (static, no server) |
| Offline | Service worker (cache-first for assets, network-first for HTML) |
| Push notifications | Firebase Cloud Messaging (FCM) + Cloudflare Worker |
| PWA | Web app manifest + service worker |

**What changes from v1:**
- Single 19,000-line HTML file → multiple focused JS modules imported via `<script type="module">`
- Inline `<script>` logic → all logic in external `.js` files
- Classic mode retired — live mode only (see Section 2.1)
- `setTimeout`-based notification scheduling (broken) → proper FCM push via Cloudflare Worker cron
- Ad-hoc state mutations → all state changes go through a single `StateManager`
- No simulate/advance button — games play out in real time only

### 2.1 Classic Mode Retirement (LOCKED)

Classic mode is retired entirely. The game is live mode only — games are scheduled at real-world timestamps and play out in real time. There is no simulate option and no manual advance button.

**Rationale:** Classic mode and live mode were two fundamentally different games sharing a UI. Every card pool, every injury model, every scheduling system needed a conditional branch for each mode. Retiring classic mode removes that entire layer of complexity from every system, allowing each feature to be built once and built correctly.

**The engagement gap classic mode solved** — something to do when you don't want to watch a full game — is addressed instead by:
- Around-the-league activity feed between games
- Targeted inbox cards that arrive between games
- Compose tab interactions with staff between games
- Pre-game build-up cards in the 30–90 minute window before first pitch

**What this means for schedule timing:** Every game must have a real-world timestamp assigned at schedule generation. The calendar pacing of games — how many per week, what time of day — is an open question that affects the entire engagement model (see OQ-27).

---

## 3. File & Module Architecture

### 3.1 Directory Structure

```
/baseball-gm/
│
├── index.html                  # App shell only — imports app.js, no logic
├── manifest.json
├── sw.js                       # Service worker — cache + push receipt only
├── icon-192.png
├── icon-512.png
│
├── app.js                      # Bootstrap: init engine, load state, mount UI
│
├── engine/
│   ├── GameEngine.js           # Orchestrator — owns game loop, milestone triggers
│   ├── SimEngine.js            # Win probability, score generation, PBP pre-gen
│   ├── SeasonEngine.js         # Schedule generation, standings, playoff bracket
│   ├── RosterEngine.js         # All roster mutations — single entry point for all teams
│   ├── TradeEngine.js          # Trade evaluation, execution, deferral, user proposals
│   ├── CardEngine.js           # Card selection, delivery, resolution, follow-ups
│   ├── InjuryEngine.js         # League-wide injury probability, processing, reports
│   ├── LeagueEngine.js         # CPU team behavior, game sim, waiver activity, feed
│   ├── WeatherEngine.js        # Weather buffer generation, game status transitions
│   └── NotificationEngine.js  # Push subscription, schedule sync to Cloudflare
│
├── store/
│   ├── StateManager.js         # Single source of truth — all state reads/writes
│   ├── DB.js                   # IndexedDB wrapper (thin, no logic)
│   └── schema.js               # State shape definition and migration versioning
│
├── ui/
│   ├── App.js                  # UI root — mounts tabs, handles navigation
│   ├── EventBus.js             # Pub/sub — decouples engine events from UI updates
│   ├── Renderer.js             # DOM update utilities
│   ├── screens/
│   │   ├── DashboardScreen.js
│   │   ├── RosterScreen.js
│   │   ├── ScheduleScreen.js
│   │   ├── LeagueScreen.js
│   │   ├── PlayersScreen.js
│   │   └── InboxScreen.js
│   └── components/
│       ├── LiveGameView.js     # Live game display (score, diamond, PBP, stats)
│       ├── BoxScoreModal.js
│       ├── PlayerCard.js
│       ├── TradeModal.js
│       ├── SettingsModal.js
│       └── [other modals]
│
├── data/
│   ├── player-names.js         # Name pools — ES module, 740 names, no separate farm pools
│   ├── cards-pool.js           # Card definitions — ES module, c3/i1 collision fixed
│   ├── constants.js            # All magic numbers, config values, enums
│   └── league.js               # RETIRED — functionality moved to engine/LeagueFactory.js
│
├── engine/
│   ├── PlayerFactory.js        # computeOVR(), createPlayer() — single source for all player creation
│   ├── LeagueFactory.js        # buildFullLeague(), buildUserRoster(), buildLeagueRosters()
│
└── workers/
    └── push-worker.js          # Cloudflare Worker — FCM cron scheduler
                                # Deployed separately to Cloudflare, not GitHub Pages
```

### 3.2 Module Ownership Rules

- `StateManager` owns all state. Nothing else writes to `state` directly.
- `GameEngine` owns the game loop. It calls other engines; they don't call each other.
- `CardEngine` owns the inbox. It calls `StateManager` to deliver effects; it doesn't touch roster directly.
- `RosterEngine` owns all roster mutations. Trades, IL, callups, depth checks — all go through here.
- `TradeEngine` evaluates and initiates trades. Execution calls `RosterEngine`.
- UI modules never mutate state. They dispatch events; engines respond.

---

## 4. Canonical Data Model

> Status: ACTIVE — sub-ratings and financial model locked. Season transition open questions in Section 14.

### 4.1 Sub-Ratings System (LOCKED)

Every player has 3 sub-ratings in addition to OVR. OVR is a weighted average of sub-ratings — it is always computed, never set directly.

#### Hitter Sub-Ratings

| Sub-rating | Range | What it drives |
|---|---|---|
| `contact` | 40–99 | Batting average, strikeout rate, hit type distribution |
| `power` | 40–99 | Home run probability, extra-base hit rate, RBI opportunities |
| `speed` | 40–99 | Stolen base attempts/success, infield hit probability, baserunning |

**OVR formula (hitters):** `round(contact * 0.40 + power * 0.35 + speed * 0.25)`

Speed weighted lowest because it is the least predictive of overall offensive value, but meaningful enough to affect the sim engine and generate distinct card events.

#### Pitcher Sub-Ratings

| Sub-rating | Range | What it drives |
|---|---|---|
| `stuff` | 40–99 | Strikeout rate, opponent batting average, swing-and-miss |
| `control` | 40–99 | Walk rate, pitch efficiency, innings per outing |
| `stamina` | 40–99 | SP innings length, BP recovery between appearances, fatigue |

**OVR formula (pitchers):** `round(stuff * 0.40 + control * 0.35 + stamina * 0.25)`

Stamina weighted lowest for the same reason as speed — meaningful but less predictive of pure output quality.

#### Sub-Rating Generation

At player creation, sub-ratings are generated around the target OVR with controlled variance:

```
// Base spread: ±12 from target OVR per sub-rating, clamped 40–99
// One sub-rating is biased high (the player's strength)
// One sub-rating is biased low (the player's weakness)
// This creates realistic player archetypes automatically:
//   High contact / low power → slap hitter
//   High power / low speed → slugger
//   High stuff / low control → wild ace
//   High control / low stamina → specialist
```

The strength/weakness designation is random at generation but persists throughout the player's career as the baseline their development curves are applied to.

#### Sub-Rating Display

- OVR shown everywhere in the UI (roster list, trade cards, player rows)
- Sub-ratings visible only in the player detail modal, shown as small labeled bars
- Cards reference sub-ratings in body text only (e.g. "His strikeout rate has dropped — stuff is down two points") — never in subject or preview lines

#### Sub-Ratings and the Card Pool

Sub-ratings unlock card specificity that wasn't possible with a single OVR:

- **Training cards** — "Approve an off-season power program for {player}" targets a specific sub-rating for improvement
- **Decline cards** — "Velocity is down on {sp_name} — stuff has dropped noticeably this season" references `stuff` directly
- **Scouting cards** — reports describe player archetypes: "elite contact, below-average power profile"
- **Injury follow-up cards** — "The hamstring affects his speed rating until full recovery" (temporary sub-rating penalty)
- **Trade evaluation** — trade value note describes the profile: "Elite stuff but control issues — high upside, real risk"

#### Sub-Rating Change Over Time

Sub-ratings change at the **season transition** (offseason processing), not during the season. Mid-season changes come only from specific card effects (injury, training program).

**Age-based development curves:**

| Age | General tendency |
|---|---|
| 21–24 | All sub-ratings can improve; speed declines slightly after 23 |
| 25–27 | Peak years — sub-ratings stable with small variance |
| 28–30 | Power and stuff begin gradual decline; contact and control more durable |
| 31–33 | Meaningful decline likely each offseason; stamina drops noticeably |
| 34+ | Steep decline; veterans may retain one elite sub-rating while others fall |

**Offseason change formula (per sub-rating) — LOCKED:**

Each sub-rating is evaluated independently using an age+type curve. Not all sub-ratings change at the same rate.

```
// Per-sub-rating age curves (baseChange value by age window):
//
//                 Growth   Peak    Prime   Decline  Steep
//                 (21-24)  (25-27) (28-30) (31-33)  (34+)
// contact/control: +1.5    +0.5    -0.5    -1.5     -3.0   (most durable)
// power/stuff:     +1.0    +0.5    -1.0    -2.0     -3.5   (peaks early, fades mid)
// speed/stamina:   +0.5    +0.0    -1.5    -2.5     -4.0   (fastest to decline)
//
// Speed declines slightly even at age 23 — fastest-aging sub-rating.
// Contact/control are most durable — veterans retain these longest.

baseChange = ageCurveValue(age, subRatingType)
// Returns float per table above

randomVariance = random(-2, +2)
// Small noise — players don't always develop on schedule

traitModifier = applyTrait(trait, subRatingType)
// 'youngGun': +1 to all sub-ratings under 28
// 'veteran': contact/control decline rate halved after 30
// 'consistent': variance reduced to (-1, +1)
// 'volatile': variance increased to (-4, +4)
// 'clubhouseLeader': no direct sub-rating effect (morale/culture only)

finalChange = clamp(baseChange + randomVariance + traitModifier, -5, +4)
// Hard cap: no player improves more than 4 points or declines more than 5 in one offseason
// OVR recomputed from new sub-ratings after all changes applied
```

**Implementation note (Phase 2 gap — FIXED in retroactive audit):**
GameEngine's `_applyAgeAndDevelopment()` currently applies a single delta to all sub-ratings. This must be updated to use the per-sub-rating curves above before Phase 6 (SimEngine) is built, since SimEngine reads sub-ratings directly for outcome generation.

**Injury recovery sub-rating penalty (temporary):**
- Some injuries apply a temporary sub-rating penalty that persists until the player returns from IL
- Example: hamstring → speed -5 until return game; elbow inflammation → stuff -4 until return game
- Penalty is stored as `injuryPenalty: { subRating, amount }` on the player object
- Removed when `ilReturnGame` is reached and player is restored to active roster
- OVR reflects the penalty while it is active

---

### 4.2 Financial Model (LOCKED)

> **Superseded by §78 (Session 8): one Club Funds account.** Payroll is actually paid (prorated, biweekly paydays), revenue is real income, the operating budget is gone, and the payroll cap becomes the owner's soft payroll target.

Four separate financial concepts. None of them is "budget" — that word is retired.

#### Payroll
The sum of all active player contract salaries on the user's roster. **Computed value — never set directly.**

```
payroll = sum(player.contractSalary for all players on active roster + IL)
```

- Updates automatically whenever a player is added, removed, or traded
- IL players count against payroll (they're still under contract)
- Pending departure players count until the game-day drain runs

#### Payroll Cap
Ownership-set ceiling on player payroll. Set at the start of each season. Going over it triggers owner pressure cards — it does not hard-block roster moves (GMs in baseball can exceed the cap, they just pay consequences).

- Initial value set at game creation based on difficulty/prestige settings
- Can increase or decrease between seasons via ownership cards
- Displayed as the primary financial bar in the UI: `payroll / payrollCap`

#### Operating Budget
Discretionary pool for non-payroll spending. Card misc costs, specialist fees, signing bonuses above the base contract, facility improvements, marketing spend. **Separate from payroll entirely.**

- Set by ownership at the start of each season
- Depleted by card decisions that have `_budgetCost` tokens
- Does NOT reset mid-season (spending decisions are permanent within a season)
- Resets to a new ownership-determined value each offseason
- Can be increased mid-season by revenue cards (see below)

#### Revenue
Income generated by sponsorship, broadcast deals, marketing decisions, attendance milestones. **Tracked separately from operating budget** — it is a display metric showing franchise financial health, not a spendable pool.

- Revenue cards that "generate income" increase the `revenue` metric
- Revenue does not convert directly to operating budget (that would make the GM feel like a CFO)
- Revenue feeds into the **ownership evaluation** at season end — high revenue = higher payroll cap and operating budget offered for next season
- Displayed on Dashboard as a secondary metric, not in the primary financial bar

#### Financial Objects in State

```javascript
// On userTeam object:
finances: {
  // Payroll (computed)
  payroll: Number,              // $M — recomputed on every roster change

  // Payroll cap
  payrollCap: Number,           // $M — set by ownership each season
  payrollCapHistory: Number[],  // Cap value per season (for franchise history)

  // Operating budget
  operatingBudget: Number,      // $M — set by ownership each season
  operatingSpent: Number,       // $M — depleted by card decisions
  // operatingRemaining = operatingBudget - operatingSpent (computed)

  // Revenue
  revenue: Number,              // $M — accumulated this season
  revenueHistory: Number[],     // Revenue per season (for franchise history)
}
```

#### Financial UI

| Element | Shows |
|---|---|
| Primary financial bar | `payroll` vs `payrollCap` with color progression |
| Operating budget indicator | `operatingRemaining` / `operatingBudget` — secondary, shown on Dashboard |
| Revenue metric | Cumulative `revenue` this season — Dashboard only |
| Card cost display | "Cost: $Xm from operating budget" — shown on cards with `_budgetCost` |

#### Ownership Evaluation (Season Transition)

At the end of each season, ownership sets next season's financial parameters based on:
- Win total vs target wins (set by ownership card at season start)
- Revenue generated vs prior season
- Payroll discipline (did you stay under cap?)
- Prestige tier

This produces an ownership card during the offseason that presents the new cap and budget offer — with a decision. A strong season = generous offer. A poor season = tighter constraints, potentially with a choice between a lower cap or reduced operating budget.

---

### 4.3 Player Object (LOCKED)

```javascript
{
  // Identity
  id: String,                   // UUID — generated at creation, never changes
  name: String,                 // Full name
  pos: String,                  // Current active position
  nativePos: String,            // Natural position (eligibility source of truth)
  group: String,                // 'sh'|'bh'|'sp'|'bp'|'pp'|'il'
  hand: String | null,          // 'R'|'L' — pitchers only
  dob: String,                  // ISO date 'YYYY-MM-DD'

  // Ratings — OVR is always computed from sub-ratings, never set directly
  ovr: Number,                  // 40–99 — computed: weighted average of sub-ratings
  subRatings: {
    // Hitters
    contact: Number,            // 40–99
    power: Number,              // 40–99
    speed: Number,              // 40–99
    // Pitchers (contact/power/speed will be null)
    stuff: Number,              // 40–99
    control: Number,            // 40–99
    stamina: Number,            // 40–99
  },
  // Only the 3 relevant sub-ratings are populated per player type.
  // The other 3 are null. This avoids two separate player shapes.

  injuryPenalty: {              // null when healthy
    subRating: String,          // Which sub-rating is penalized
    amount: Number,             // Points deducted (stored as positive number)
  } | null,

  // Individual GM relationship (0–100)
  // Distinct from team morale — this is the player's personal trust in their GM
  gmRelationship: Number,       // Starts at 50 for all new/acquired players
                                // Re-acquired players start at 45 (partial reset)
  _previouslyWithOrg: Boolean,  // True if player was previously traded away

  // Contract
  contractSalary: Number,       // $M per season
  contractYears: Number,        // Total years on original deal
  contractExpiry: Number,       // Season number when contract expires
  contractExtended: Boolean,    // Has this contract been extended mid-deal?

  // Trait
  trait: String | null,         // 'veteran'|'youngGun'|'clubhouseLeader'|'volatile'|'consistent'

  // Status flags
  isInjured: Boolean,
  isSuspended: Boolean,
  isResting: Boolean,
  isTraining: Boolean,
  onPersonalLeave: Boolean,
  _pendingDeparture: Boolean,   // Traded, awaiting game-day drain

  // IL tracking
  ilReturnGame: Number | null,  // Schedule index when player returns

  // Season stats — shape depends on player type (hitter vs pitcher)
  stats: {
    // ── HITTERS (pitchers: all null) ──────────────────────────────
    // Tracked fields (stored in state)
    g:       Number,   // games played
    ab:      Number,   // at-bats
    h:       Number,   // hits
    doubles: Number,   // doubles
    hr:      Number,   // home runs
    rbi:     Number,   // runs batted in
    r:       Number,   // runs scored
    bb:      Number,   // walks
    k:       Number,   // strikeouts
    sb:      Number,   // stolen bases
    cs:      Number,   // caught stealing
    hbp:     Number,   // hit by pitch
    tb:      Number,   // total bases
    // Computed on demand (not stored — derived from tracked fields above)
    // avg    = h / ab
    // obp    = (h + bb + hbp) / (ab + bb + hbp)
    // slg    = tb / ab
    // ops    = obp + slg
    // bb_pct = bb / (ab + bb + hbp)
    // k_pct  = k / ab
    // xbh    = doubles + hr
    // sb_pct = sb / (sb + cs)
    // babip  = (h - hr) / (ab - k - hr)

    // ── PITCHERS (hitters: all null) ──────────────────────────────
    // Tracked fields (stored in state)
    g:          Number,   // total appearances
    gs:         Number,   // games started
    ip:         Number,   // innings pitched
    w:          Number,   // wins
    l:          Number,   // losses
    sv:         Number,   // saves
    svo:        Number,   // save opportunities
    hld:        Number,   // holds
    bs:         Number,   // blown saves
    qs:         Number,   // quality starts
    h_allowed:  Number,   // hits allowed
    hr_allowed: Number,   // home runs allowed
    er:         Number,   // earned runs
    bb:         Number,   // walks
    k:          Number,   // strikeouts
    hbp:        Number,   // batters hit by pitch
    // Computed on demand (not stored)
    // era  = (er / ip) * 9
    // whip = (bb + h_allowed + hbp) / ip
    // k9   = (k / ip) * 9
    // bb9  = (bb / ip) * 9
    // h9   = (h_allowed / ip) * 9
    // hr9  = (hr_allowed / ip) * 9
    // k_bb = k / bb
    // sv_pct = sv / svo
  },

  // Spring training stats — same shape, tracked separately, never merge with season stats
  springStats: { /* same shape as stats */ },

  // Career stats — same tracked fields accumulated across all seasons
  careerStats: {
    // All tracked fields above, lifetime totals
    seasons:    Number,   // seasons played
    peakOvr:    Number,   // highest OVR achieved
    peakSeason: Number,   // season number of peak OVR
  },

  // Ownership
  teamId: String | null,        // Team ID of current owner
}
```

### 4.4 Team Object — User Team

```javascript
{
  id: String,                   // Fixed: 'user'

  // Identity
  city: String,
  nickname: String,
  abbr: String,
  icon: String,                 // Emoji
  bannerColor: String,          // Hex

  // Roster — player IDs only, looked up in state.players registry
  rosterIds: String[],

  // Record
  wins: Number,
  losses: Number,
  streak: Number,               // Positive = win streak, negative = loss streak

  // Soft metrics (0–100)
  morale: Number,
  atmosphere: Number,
  ownerTrust: Number,
  managerConfidence: Number,

  // Finances (see Section 4.2)
  finances: {
    payroll: Number,
    payrollCap: Number,
    payrollCapHistory: Number[],
    operatingBudget: Number,
    operatingSpent: Number,
    revenue: Number,
    revenueHistory: Number[],
  },

  // GM
  gmName: String,

  // Groundskeeper relationship (0–100) — field surface and weather
  groundskeeperRelationship: Number,

  // Facilities & Operations relationship (0–100) — ballpark infrastructure
  facilitiesRelationship: Number,

  // Ticket Office relationship (0–100) — sales, attendance, pricing
  ticketOfficeRelationship: Number,

  // Coaching staff
  coachingStaff: {
    manager:       { name, salary, contractExpiry, relationship, background },
    pitchingCoach: { name, salary, contractExpiry, relationship },
    hittingCoach:  { name, salary, contractExpiry, relationship },
    bullpenCoach:  { name, salary, contractExpiry, relationship },
    benchCoach:    { name, salary, contractExpiry, relationship },
  },

  // Pending transactions
  _pendingAcquisitions: Object[],  // Deferred incoming players on game day
}
```

### 4.5 League Team Object

```javascript
{
  id: String,                   // e.g. 'NYE'
  name: String,
  abbr: String,
  str: Number,                  // Base strength 0.45–0.57
  divisionId: String,           // 'A' | 'B'
  wins: Number,
  losses: Number,
  streak: Number,
  rosterIds: String[],          // IDs in state.players registry
  farmIds: String[],            // farm system player IDs
  gmRelationship: Number,       // 0–100 relationship with user GM
  rotation: {
    order:        String[],     // SP playerIds in rotation order
    currentIndex: Number,       // which slot starts the next game (0-based)
  },
}
```

### 4.6 Game Object

```javascript
{
  index: Number,                // Position in schedule array (0-based)
  opponent: String,             // Team name
  isHome: Boolean,
  date: String,                 // ISO date
  gameTime: Number,             // Unix ms timestamp of first pitch (live mode)

  weather: {
    label: String,              // 'Clear'|'Overcast'|'Hot'|'Cold'|'Rain'|'Storm'
    icon: String,
    scoringMod: Number,         // Multiplier on run totals
  },

  status: String,               // 'scheduled'|'postponed'|'live'|'final'|'makeup'

  // Live game — populated by SimEngine pre-game
  plays: Play[] | null,
  livePlayIndex: Number,

  // Post-game — populated at commit, pre-gen fields stripped
  result: String | null,        // 'W' | 'L'
  ourScore: Number | null,
  theirScore: Number | null,
  boxScore: Object | null,
  recap: Object | null,
}
```

### 4.7 Card Instance Object

```javascript
{
  // Definition reference
  defId: String,                // Card definition ID (e.g. 'i1', 't4')
  instanceId: String,           // UUID — unique per delivery

  // Display (resolved at delivery)
  type: String,                 // 'urgent'|'normal'|'good'
  tag: String,
  sender: String,
  avatar: String,
  subject: String,
  preview: String,
  body: String,
  yesLabel: String,
  noLabel: String,

  // Lifecycle
  deliveredAtGame: Number,
  expiresAtGame: Number,
  resolved: Boolean,
  resolvedChoice: String | null, // 'yes'|'no'|'expired'

  // Effects (copied from definition at delivery)
  yesEffect: Object,
  noEffect: Object,
  autoResolveTax: Object | null,

  // Linked entities (resolved at delivery — IDs only)
  linkedPlayerIds: {
    incoming: String | null,
    outgoing: String | null,
  },

  // Follow-up
  followup: Object | null,

  // Flags
  isInGame: Boolean,
  requiresHome: Boolean,
}
```

### 4.8 Save Slot Object

Each save slot is an independent, complete game state. The app stores a collection of save slots in IndexedDB — one per team. Loading a team makes its slot the active state. Slots do not share a calendar, league, or player pool — they are fully isolated.

```javascript
// Stored in IndexedDB as an array: 'saveSlots'
{
  slotId: String,               // UUID — identifies the save slot
  teamName: String,             // Display name: '{city} {nickname}'
  archetype: String,            // Archetype ID chosen at creation
  seasonNum: Number,            // For display in the team picker UI
  lastPlayed: Number,           // Unix ms — for sorting slots by recency
  state: GameStateObject,       // Full game state (see 4.9)
}
```

**Save slot rules:**
- Free tier: 1 save slot maximum
- Premium tier: unlimited save slots
- Switching teams = saving current slot, loading selected slot
- Active slot ID stored in `localStorage` (survives app close, not tied to game state)
- New Game always creates a new slot (never overwrites unless user explicitly deletes)
- Delete slot: confirmation modal, cannot be undone

### 4.9 Game State Object (per slot)

```javascript
{
  // Schema
  _version: String,             // e.g. '1.0.0' — for migration
  _savedAt: Number,             // Unix ms timestamp of last save

  // Season
  seasonNum: Number,            // 1-based
  phase: String,                // See Section 5

  // Archetype (set at creation, never changes)
  archetype: String,            // Archetype ID — shapes card weights, ownership behavior

  // Player registry — single source of truth for ALL players in this slot
  players: Object,              // { [playerId]: PlayerObject }

  // Teams
  userTeam: UserTeamObject,
  leagueTeams: LeagueTeamObject[],

  // Schedule
  schedule: GameObject[],
  leagueSchedule: Object,       // { dayMap: { [dateStr]: GameResult[] } }

  // Weather — persistent 48-hour time series buffer
  weatherBuffer: {
    generatedAt: Number,        // Unix ms
    hourlyFrames: Object[],     // 48 entries (free) or 168 entries (premium 7-day)
  },

  // Inbox
  inbox: CardInstanceObject[],

  // History
  metricHistory: Object[],      // { gameIndex, ovr, wins, losses } per game
  seasonHistory: Object[],      // Season summary per completed season

  // Notifications
  // NOTE: push subscription is per-device, not per-slot.
  // Notification schedule is rebuilt when switching active slots.
  push: {
    quietStart: String,         // 'HH:MM' — per-slot quiet hours
    quietEnd: String,
    enabled: Boolean,
  },

  // Settings (per-slot — each team has its own settings)
  settings: {
    theme: String,              // 'dark'|'light'|'auto'
    soundEnabled: Boolean,
    soundVolume: Number,
    hapticEnabled: Boolean,
    hapticIntensity: String,    // 'light'|'medium'|'strong'
  },
}
```

---

## 5. State Machine — Season Phases

> Status: ANCHORS LOCKED — full transition rules to be completed in Phase 4 planning.

```
SETUP
  ↓ (new game created, archetype selected, team configured)
SPRING_TRAINING             ← 20 games, stats tracked, roster competitions active
  ↓ (spring complete, opening day roster locked via competition cards)
REGULAR_SEASON
  ↓ (game 45–55: All-Star hosting announcement fires if threshold met)
  ↓ (game 66 reached)
ALL_STAR_BREAK              ← single event phase, All-Star cards fire for host team
  ↓ (break resolved)
REGULAR_SEASON              ← resumes
  ↓ (game 88 reached)
TRADE_DEADLINE              ← deadline window opens, trade pressure cards active
  ↓ (game 92: deadline closes)
REGULAR_SEASON              ← resumes, deadline trade cards blocked
  ↓ (game 132 complete)
PLAYOFF_BRACKET_BUILD       ← standings locked, bracket generated
  ↓
WILD_CARD               ← 1 game: 4th vs 5th per division
  ↓ (winner advances)
FIRST_ROUND             ← best of 3: 1st vs WC winner, 2nd vs 3rd
  ↓
DIVISION_SERIES         ← best of 5: first round winners
  ↓
WORLD_SERIES            ← best of 7: division champions
  ↓ (series complete)
SEASON_SUMMARY              ← summary card, prestige tier recalculated
                            ← Franchise Legend check: Tier 5 + championship → win condition
  ↓
OFFSEASON                   ← contracts, manager/staff renewals, ownership eval card
  ↓ (all mandatory decisions resolved)
SPRING_TRAINING             ← season N+1 begins
```

### Key Schedule Anchors (LOCKED)

| Anchor | Game / Timing |
|---|---|
| Spring training | 20 games (pre-season, stats tracked) |
| Regular season | 132 games |
| All-Star hosting announcement | Games 45–55 (if threshold met) |
| All-Star Break | After game 66 |
| Trade deadline opens | Game 88 |
| Trade deadline closes | Game 92 |
| Playoffs begin | After game 132 |

### Spring Training Rules (LOCKED)

Spring training is a fully playable phase — not a backdrop. Stats are tracked and matter.

**Roster sizes (LOCKED):**
- Regular season active roster: **28 players** — 9 starters + 5 bench hitters + 5 SP + 5 RP + 2 SP bench + 2 RP bench
- Spring training roster: **38 players** — 28 active + 10 invitees (5 hitters + 5 pitchers)
- Cuts before Opening Day: 10 players
- Cut path: invitees return to farm; any active roster player cut during spring goes to waivers

**What's tracked:**
- Full batting and pitching stats per player, stored as `player.springStats` (separate from `player.stats`)
- Team spring W/L record — displayed with "ST" badge on the schedule screen
- Spring stats reset each spring; they never carry to the regular season stat line

**What spring stats affect:**
- Contested roster spot decisions: spring stat lines are presented side by side in decision cards, informing the GM's choice
- Atmosphere: a strong spring record (above .550) generates a fan excitement card before opening day; a poor spring (below .300) generates a low-expectations ownership card
- Neither outcome is punishing — spring results are a tone-setter, not a high-stakes mechanic

**Spring training invitees (LOCKED):**
- 10 farm players invited to spring camp (5 hitters + 5 pitchers), selected as those genuinely competing for roster spots
- The 10 invitees are determined by RosterEngine at spring setup — highest-rated farm players at positions where bench spots are open
- The Opening Day cut (38→28) is a GM decision, not automatic — presented via a roster management screen/modal before Opening Day
- Auto-resolve penalty if the GM does not make cuts: lowest-rated invitees are sent to the farm automatically

**Contested roster spots:**
- 2–3 spots are flagged as open competitions at spring training start (set by archetype and roster state)
- Each competition has 2 candidates: one incumbent, one challenger (usually a prospect)
- Around spring game 12–15, a decision card fires per competition presenting the spring stats and manager's recommendation
- The GM makes the final call — the chosen player joins the opening day roster in that slot
- This is the primary spring-to-regular-season connection

**Other spring card types:**
- Manager observations on specific players (~2–3 cards)
- Player readiness cards for anyone returning from offseason injury
- sp11/sp11b/sp15 cards redesigned: reference real farm players by name only — no inline rating tokens

**Phase 9 task (card token cleanup — LOCKED):**
- All `{..._rating}` tokens must be removed from card body text in cards-pool.js
- Player ratings are visible on the Roster/League screen — cards reference players by name and position only
- Token resolver in CardEngine must not generate rating values for card text
- Affects: sp11, sp11b, sp15, all trade cards (t1–t9), injury cards (i1–i5), scouting cards (s1–s3h), and any card using `{acq_*_rating}`, `{active_*_rating}`, `{dfa_player_rating}`, `{farm_*_pos}` tokens

### Phase Rules

- `_requiresRegular` cards blocked during SPRING_TRAINING and OFFSEASON
- `_requiresSpring` cards blocked outside SPRING_TRAINING
- Trade cards can fire during OFFSEASON (offseason trades are realistic)
- IL moves always allowed regardless of phase
- Playoff phases use separate game objects from the regular season schedule array
- Trade deadline window: cards with `_requiresDeadline` only fire between games 88–92

---

## 6. Module Contracts

> Status: UPDATED — classic mode references removed, new engines added.

### 6.1 StateManager

**Owns:** The entire `state` object and the save slot registry. Nothing else writes state directly.

**Provides:**
- `get(path)` — read any state value
- `set(path, value)` — write with auto-save trigger
- `mutate(fn)` — batch mutation with single save
- `save()` — persist active slot to IndexedDB
- `load(slotId)` — restore slot from IndexedDB
- `listSlots()` — return all save slot metadata
- `createSlot(config)` — create new save slot
- `deleteSlot(slotId)` — delete a save slot
- `reset()` — wipe active slot and reinitialize

### 6.2 GameEngine

**Owns:** The game loop — what happens next and when.

**Provides:**
- `tick()` — check timestamp, reveal next play if due, check milestone triggers
- `commitGame(gameIndex)` — finalize a completed game, drain pending transactions
- `commitCPUGames(date)` — process all CPU games for a given date
- `getNextGame()` — returns the next unplayed user game object
- `checkMilestone(phase, gameIndex)` — returns milestone config if one should fire
- `buildCardContext(gameIndex)` — computes and returns the full situational card context object

**Does NOT:** Touch DOM. Touch roster. Evaluate cards directly.

### 6.3 RosterEngine

**Owns:** All roster mutations for user and CPU teams.

**Provides:**
- `placePlayer(playerId, group, slotIndex?)` — move player to group/slot
- `removePlayer(playerId)` — remove from active roster
- `injurePlayer(playerId, ilDays)` — move to IL, set return date
- `returnFromIL(playerId)` — flags player `_pendingILReturn: true`, adds to `state.ilReturnQueue`; never auto-activates — always surfaces a decision card (CardEngine Phase 9)
- `suspendPlayer(playerId, games)` — bench for N games
- `placeOnWaivers(playerId, teamId)` — moves player to waiverPool; this is the primary path for mid-season cuts, IL return decisions, and any removal outside spring training
- `sendToFarm(playerId, teamId)` — ONLY valid during spring training cuts (38→28) or position-aware farm overflow displacement; all other removals go through placeOnWaivers()
- `callUpFromFarm(playerId, teamId)` — promote farm player to active roster
- `checkDepth(teamId?)` — returns Type 1/Type 2 integrity issues (user team if omitted)
- `autoResolveDepth()` — promotes farm/bench players to fill critical gaps
- `markPendingDeparture(playerId)` — trade deferral lock
- `displaceFarmPlayer(teamId, group)` — position-aware overflow displacement

**Does NOT:** Generate cards. Evaluate trade fairness. Touch sim engine.

### 6.4 TradeEngine

**Owns:** Trade evaluation, cash direction, deferral logic.

**Provides:**
- `evaluateTrade(incoming, outgoing)` — returns `{ cashDirection, cashAmount, valueNote }`
- `executeTrade(incoming, outgoing, teamId)` — calls RosterEngine, updates league rosters
- `deferTrade(incoming, outgoing, teamId)` — game-day path, marks pending departure
- `drainPending(gameIndex)` — called at game commit, completes deferred trades
- `evaluateUserProposal(offer, teamId)` — CPU evaluates user-initiated trade offer
- `generateCounter(offer, teamId)` — CPU produces counter-offer terms

**Cash direction rule (LOCKED):**
- `incomingOVR < outgoingOVR` → user RECEIVES cash
- `incomingOVR > outgoingOVR` → user PAYS cash
- Equal OVR → no cash

### 6.5 CardEngine

**Owns:** Card selection, token resolution, delivery, expiry, follow-ups.

**Provides:**
- `checkAndDeliver(context)` — main loop: what cards fire now given this context?
- `resolve(instanceId, choice)` — apply effects, mark resolved, queue follow-up
- `expire(instanceId)` — auto-resolve with penalty
- `getInbox()` — returns sorted pending cards
- `applyPlayerRelationshipEffects(card, choice)` — updates gmRelationship on named players

**Does NOT:** Mutate roster directly. Simulate games.

### 6.6 NotificationEngine

**Owns:** Push subscription lifecycle and schedule sync.

**Provides:**
- `requestPermission()` — prompts user, subscribes via Web Push
- `syncSchedule(upcomingCards)` — sends schedule to Cloudflare Worker
- `cancelNotification(cardInstanceId)` — removes from Worker schedule
- `sendUrgent(payload)` — bypasses quiet hours, sends immediately
- `sendTestNotification()` — triggers immediate test push

### 6.7 InjuryEngine (NEW)

**Owns:** Injury probability and processing for all 10 teams.

**Provides:**
- `runDailyInjuryCheck(date)` — evaluates injury probability for all active roster players across all teams
- `injurePlayer(playerId, severity)` — determines IL duration, generates report text, calls RosterEngine
- `processILReturns(date)` — checks return dates, calls RosterEngine.returnFromIL for due players
- `getInjuryReport(playerId, requestingTeamId)` — returns filtered report based on GM relationship

**Does NOT:** Generate inbox cards directly — fires events that CardEngine listens for.

### 6.8 LeagueEngine (NEW)

**Owns:** CPU team behavior — game simulation, roster decisions, waiver activity.

**Provides:**
- `simulateCPUDay(date)` — generates all CPU game objects for the day, assigns timestamps
- `processWaiverClaims(date)` — evaluates pending waiver claims in priority order
- `processCPURosterDecisions(date)` — IL placements, farm callups, contract decisions
- `updateLeagueSchedule(date)` — commits CPU game results, updates standings, feeds activity log
- `getActivityFeed(since)` — returns feed entries from the last N hours
- `updateStandings()` — recalculates all standings from current records

### 6.9 WeatherEngine (NEW)

**Owns:** Weather time series generation and game status transitions.

**Provides:**
- `generateWeatherBuffer(fromDate)` — creates 48-hour hourly frame array
- `getFrameForTime(timestamp)` — returns the weather frame for a given moment
- `evaluateGameWeather(game)` — determines if a scheduled game should enter PRE_GAME_WATCH
- `transitionGameStatus(game, newStatus)` — updates game.status, triggers appropriate cards
- `getRadarFrames(fromTime, hours)` — returns pre-rendered radar frame data for the slider

---

## 7. Sim Engine Design

> Status: LOCKED — full base-state simulation. Finalized during Phase 6 pre-build audit.

### 7.1 Win Probability Formula (LOCKED)

```
winProb = 0.30                                        // SIM_BASE_WIN_PROB
        + (ourOvr - oppOvr) × 0.010                  // SIM_OVR_DIFF_WEIGHT
        + (morale - 50) × 0.001                       // moraleAdj: ±0.05 at extremes
        + (atmosphere - 50) × 0.0006                  // atmosAdj: ±0.03 at extremes
        + weatherAdj                                   // per condition (below)
        + 0.04 (if home game)                          // home field advantage
```

Clamped to [0.20, 0.80] — no team guaranteed to win or lose.

**Weather adjustments (LOCKED):**
| Condition | Adjustment |
|---|---|
| Clear | 0.0 |
| Overcast | −0.01 |
| Hot | +0.02 (offense up) |
| Cold | −0.02 |
| Rain | −0.03 |
| Storm | −0.05 |

**gmRelationship → outcome variance (LOCKED — implemented in Phase 6):**
- gmRelationship < 30: ±15% variance multiplier on that player's at-bat/pitch outcomes
- gmRelationship > 80: −15% variance (consistency bonus)
- Applied per player within `simulateAtBat()`, not at team level

**Team OVR calculation:**
- `ourOvr` = hitters avg OVR × 0.50 + SP avg OVR × 0.30 + BP avg OVR × 0.20
- Only healthy, non-suspended players count
- `oppOvr` = same formula from league team rosterIds

### 7.2 Full Base-State Simulation (LOCKED)

Full base-state tracking — not a simplified run distribution model.
Required for: correct RBI attribution, IMP accuracy, two-act injury timing, realistic stat lines.

**Base state per half-inning:**
```javascript
{ outs: 0|1|2, first: playerId|null, second: playerId|null, third: playerId|null, runs: Number }
```

**At-bat resolution sequence:**
1. Walk — `pitcher.control` + batter discipline
2. HBP — low flat prob, elevated for low-control pitchers
3. Strikeout — `pitcher.stuff` vs `batter.contact`
4. Hit type — contact → single/XBH split; power → HR/double/triple split
5. Baserunner advancement — `batter.speed` affects stretch decisions
6. Score runners who advance home; increment outs for out plays

**Individual sub-rating → outcome mappings (LOCKED):**

| Sub-rating | Formula |
|---|---|
| `contact` | Hit prob = `contact / 400`. K rate = `(100 − contact) / 300` |
| `power` | HR prob = `power / 1800`. XBH rate = `power / 600` |
| `speed` | SB attempt if `speed > 65`. Infield hit bonus = `speed / 2000` |
| `stuff` | K bonus = `(stuff − 50) / 200`. Hit quality penalty = `stuff / 300` |
| `control` | Walk prob = `(80 − control) / 400`. HBP elevated below 50 |
| `stamina` | Max IP = `4 + floor(stamina / 20)`. Fatigue flag after max IP |

**Baserunner advancement rules (LOCKED):**
| Hit type | Runner on 1st | Runner on 2nd | Runner on 3rd |
|---|---|---|---|
| Single | 2nd (3rd if speed > 70) | Scores | Scores |
| Double | Scores (if speed > 60) or 3rd | Scores | Scores |
| Triple | Scores | Scores | Scores |
| HR | Scores | Scores | Scores |
| Groundout | Force advance if < 2 outs | Holds | Scores if < 2 outs |
| Flyout | Holds (tags if speed > 75 + 3rd) | Holds | Tags and scores if < 2 outs |

### 7.3 SP Rotation (LOCKED)

- `state.userTeam.rotation: { order: String[], currentIndex: Number }` — manager-owned
- Same field on each league team object
- `order` = SP playerIds; set by manager at season/roster setup
- `currentIndex` advances each game, wraps at `order.length`
- Rotation changes via manager card only — GM never directly manipulates rotation
- SP IP = `SIM_SP_INNINGS_BASE + floor(stamina / 20) + _rng(-1, 1)`
- BP fills remaining innings in 1–2 inning stints using bullpen depth order

### 7.4 Pitcher Fatigue (LOCKED)

```
fatigueThreshold = stamina × 1.8  (batters faced before tiring)
_spFatigued flag fires → pitching change card eligible
Fatigued SP: hit quality +10%, K rate −15%, walk rate +10%
```

### 7.5 CPU Game Play Generation (LOCKED)

**Schedule structure** (matchups + dates) generated at season start — no outcomes, no plays.
**Simulation** runs on game day via `LeagueEngine.processCPUDay()` using current rosters.
This ensures CPU game outcomes always reflect the roster as it exists that day — injuries, trades, and callups are all factored in automatically.
Plays stripped at commit (keep only `boxScore` and `recap`).
At any moment, only current day's CPU plays exist in state (~70KB).
Same SimEngine pipeline as user games — Section 28.4 satisfied.

---

## 8. Live Game Engine Design

> Status: LOCKED — Play object shape and pre-generation rules defined during Phase 6 pre-build audit.

### 8.1 Pre-Generation (LOCKED)

All play-by-play generated before first pitch. Plays stored in `game.plays[]` array.
Stripped to `boxScore` + `recap` only at commit.

**Play Object Shape (LOCKED):**

```javascript
{
  // Identity
  playIndex:    Number,       // position in game.plays array
  _halfInning:  String,       // e.g. 'TOP_1', 'BOT_3', 'BOT_9'
  inning:       Number,       // 1-based
  half:         'TOP'|'BOT',

  // Players involved
  batterId:     String,       // playerId
  pitcherId:    String,       // playerId

  // Outcome
  type: String,               // 'walk'|'hbp'|'strikeout'|'groundout'|'flyout'|
                              //  'single'|'double'|'triple'|'hr'|'sb'|'cs'|
                              //  'pitching_change'|'inning_end'|'game_end'
  description:  String,       // Human-readable: "Rodriguez singles to left"
  rbi:          Number,       // runs batted in on this play
  isScoring:    Boolean,      // true if any run scored
  isBigPlay:    Boolean,      // HR, 3+ RBI play, game-tying/go-ahead — drives activity feed

  // Running state AFTER this play resolves
  outsAfter:    Number,       // 0 | 1 | 2 | 3 (3 = inning over)
  _basesAfter: {              // baserunner state after play
    first:  String | null,    // playerId or null
    second: String | null,
    third:  String | null,
  },
  cumOurScore:   Number,      // user team cumulative score after this play
  cumTheirScore: Number,      // opponent cumulative score after this play

  // Timing
  _timestamp:   Number,       // Unix ms — when tick() should reveal this play

  // Stat increments (applied by accumulateStats() at commit)
  _statDeltas: {
    [playerId]: { stat: String, delta: Number }[]
  },
}
```

**Timestamp distribution:**
- Game starts at `game.gameTime`
- Total game duration: ~3 hours (10,800,000 ms)
- Plays distributed evenly across duration with small random variance per play
- `_timestamp` = `gameTime + (playIndex / totalPlays × 10_800_000) + _rng(-15000, 15000)`
- Weather delay offsets applied via `game._tickOffset` (Section GameEngine.applyWeatherDelay)

### 8.2 Linescore Rules (LOCKED)

- Away team always top row, home team always bottom row
- Inning columns 1–9+ fill as half-innings complete
- Active half-inning cell shows runs scored so far in that half-inning (in-progress)
- R/H/E totals always reflect current cumulative totals
- Extra innings append new columns dynamically
- Empty future inning cells show `·` (middle dot)

### 8.3 Play Reveal Logic (LOCKED)

- `TICK_INTERVAL_MS` (5000ms) — defined in constants, interval owned by App.js
- Each tick: reveal all plays where `play._timestamp + game._tickOffset <= now`
- Multiple plays can reveal in one tick (catches up if app was backgrounded)
- INGAME cards fire on `play.outsAfter === 3` (half-inning end) — never mid-at-bat
- Auto-commit fires when `game.livePlayIndex >= game.plays.length`
- GameScreen listens for `EventBus.emit('game:tick', { play, game })` to update display

### 8.4 Tick Ownership (LOCKED)

`App.js` owns the tick interval. One `setInterval` for the entire app lifecycle — started on `init()`, never stopped. The tick is cheap (one state read, one index check) and harmless when no game is live.

```javascript
// App.js tick loop (pseudocode — actual wiring in App.js)
setInterval(() => {
  const play = GameEngine.tick();
  if (play) EventBus.emit('game:tick', { play, game });
  // Auto-commit when game reaches FINAL
  if (game?.status === GAME_STATUS.FINAL && !game._committed) {
    GameEngine.commitGame(gameIndex);
  }
}, TICK_INTERVAL_MS);
```

### 8.5 Resumption (LOCKED)

No special resumption logic. When the app opens mid-game:
1. `App.init()` loads state — game object already has `livePlayIndex`, score, status
2. Tick starts — immediately catches up by revealing all plays with timestamp ≤ now
3. GameScreen renders from `livePlayIndex` — all previously-revealed plays in PBP feed
4. If `status === FINAL` and not committed: `commitGame()` fires on first tick

The game object IS the resume state. No separate resume handler needed.

### 8.6 Weather Delay Handling (LOCKED)

- `tick()` returns `null` when `game.status` is `DELAYED`, `SUSPENDED`, or `POSTPONED` — no plays reveal
- `game._tickOffset` advances by the delay duration when delay clears — keeps timestamp anchoring correct
- Suspended game makeup: `game.livePlayIndex` already points to the first unrevealed play
- GameScreen observes `game.status` on every tick and switches display states accordingly

### 8.7 Live Game State — Schema Architecture (LOCKED)

There is no separate `state.liveGame` object. The game object in `state.schedule[currentGameIndex]` IS the live game state. This keeps the data model flat and makes resumption trivial.

**Game object live tracking fields** (present on all game objects, updated as game progresses):
```javascript
game.livePlayIndex  // Number — index of next play to reveal (0 = nothing shown yet)
game.ourScore       // Number — current user team score (updated per-play)
game.theirScore     // Number — current opponent score
game.currentInning  // Number — 1-based current inning
game.currentHalf    // 'TOP'|'BOT'
game.outs           // Number — 0, 1, or 2
game.bases          // { first: String|null, second: String|null, third: String|null }
game.status         // GAME_STATUS — single source of truth for all systems
game._tickOffset    // Number — ms added to all _timestamps (for delay handling)
```

### 8.8 GameScreen Display States (LOCKED)

| `game.status` | Dashboard | GameScreen |
|---|---|---|
| `SCHEDULED` | First-pitch countdown (fp-card) | Countdown + matchup info |
| `PRE_GAME_WATCH` | Countdown + weather warning | Countdown + weather banner + radar |
| `DELAYED` | "DELAYED" pill + duration | Rain overlay on diamond, delay countdown, radar |
| `LIVE` | Score updating automatically | Full PBP feed + linescore + diamond state |
| `SUSPENDED` | "SUSPENDED" pill | Frozen score/inning/outs/bases + next steps card |
| `POSTPONED` | "PPD" result pill | Rescheduled date shown |
| `FINAL` (pre-commit) | Score result | Final box score before commit |

### 8.8 Weather System (LOCKED)

Weather is a first-class game state and a persistent, browsable layer of the game world — not a card event bolted onto the game engine. Every system reads weather status from a shared source. One source of truth prevents the v1 divergence where the delay card fired but the live game kept running.

#### Weather Architecture — Persistent Time Series (LOCKED)

Weather is generated as a **continuous 48-hour time series** from the current real-world moment, not per-game. This buffer lives in state and is refreshed each time the app opens or when the leading edge of the buffer is within 2 hours of expiring.

```javascript
// state.weatherBuffer
{
  generatedAt: Number,        // Unix ms — when this buffer was generated
  hourlyFrames: WeatherFrame[], // 48 entries, one per hour
  // Each frame:
  // { timestamp, condition, intensity, windSpeed, windDir,
  //   precipChance, temp, fieldImpact, radarCellPosition }
}
```

Games that fall within the buffer window inherit their weather from the corresponding hourly frame — not from independent generation. This guarantees coherence: a storm system on Tuesday night affects both the Tuesday game and the Wednesday morning conditions report from the groundskeeper.

**Free vs Premium weather visibility (LOCKED):**
- Free tier: 48 hours visible
- Premium tier: 7-day forecast visible — knowing about a storm system 5 days out lets the user anticipate makeup game risk, prep the groundskeeper channel, and make strategic roster decisions before a key home stand

#### Weather Game States

A game progresses through weather states as conditions develop. Every state transition updates `game.status` and every system responds to that status.

```
SCHEDULED
    ↓ (threatening conditions in hourly frame)
PRE_GAME_WATCH          ← Warning window. Weather card fires. Expiry: 30 real minutes.
    ↓ (conditions don't improve)
DELAYED                 ← First pitch frozen. Delay card fires. Display shows delay screen.
    ↓ (conditions clear)         ↓ (conditions don't clear within window)
LIVE                    POSTPONED → Makeup game scheduled in calendar
    ↓ (conditions deteriorate mid-game)
SUSPENDED               ← Score/inning/outs/bases preserved exactly
    ↓ (conditions clear)         ↓ (can't resume same day)
RESUMED → LIVE → FINAL  POSTPONED (partial) → Makeup resumes from suspended state
```

#### Weather Card Timing and Expiry (LOCKED)

Weather cards are the only card category with real-world minute-based expiry.

| Card | Fires when | Expiry |
|---|---|---|
| Pre-game watch | 60–90 min before first pitch, threatening conditions | 30 real minutes |
| Delay notification | Game transitions to DELAYED | 45 real minutes |
| Delay extended | Delay exceeds 60 minutes | 20 real minutes |
| Postponement | Game officially postponed | 24 hours |
| Suspension | Game suspended mid-inning | Next day / makeup date |
| Weather anticipation | User has premium and checks 24h+ forecast | Standard card timing |

**No-action penalty (LOCKED):**
If a time-sensitive weather card expires without user action, the card auto-resolves on the conservative path with a small penalty:
- Pre-game watch ignored: morale -1, atmosphere -1
- Delay card ignored: morale -1
- Penalty is small — not punishing, but noticeable and realistic

**Urgent notification priority:** Weather cards with minute-based expiry bypass the user's quiet hours window. This is the one exception to quiet hours — a weather delay notice 20 minutes before first pitch is always delivered. Implemented as `priority: 'urgent'` in the Cloudflare Worker send logic.

#### Weather Radar Widget (LOCKED)

A persistent, browsable radar visualization available at all times — not just during delays. Accessible from the Dashboard and from the live game view.

**Display:**
- Circular radar sweep showing a stylized storm cell moving across a regional map
- Ballpark always centered regardless of zoom level
- Storm cell moves relative to the ballpark
- Color intensity: green (light) → yellow (moderate) → orange (heavy) → red (severe)
- Estimated clearing time shown below radar when cell is present

**Slider:** Scrubs through hourly frames from current time → +12 hours ahead, in 1-hour increments. 13 positions total. Pre-rendered SVG frames per hour — no real-time computation during scrubbing.

**Zoom levels (3 levels):**
- **Regional** (zoom out): Wide view, shows the weather system in context across the region. Useful for seeing where a storm is coming from.
- **City** (default): Shows the ballpark area and storm cell proximity. Standard operational view.
- **Local** (zoom in): Close view of the ballpark itself, field-level detail, groundskeeper relevance. Shows how directly the cell is tracking over the venue.

Zoom transitions are CSS scale transforms on the SVG viewBox — no new data needed, just a different window into the same coordinate system.

**Premium gating (LOCKED):**
- Free users: radar available, slider covers current → +12 hours, 3 zoom levels
- Premium users: slider extends to +48 hours on free tier data; with premium forecast, slider covers up to 7 days

#### Weather and the Live Display

Each weather status has a distinct display state:

| Status | Display |
|---|---|
| `PRE_GAME_WATCH` | Normal pre-game + weather warning banner + radar widget |
| `DELAYED` | Delay screen: "DELAYED" status pill, diamond grayed with rain overlay, countdown, radar |
| `SUSPENDED` | Score/inning/outs/bases frozen, "SUSPENDED" pill, next steps shown |
| `POSTPONED` | Rescheduled date shown, box score empty |
| `RESUMED` | Live view resumes, "RESUMED" entry at top of PBP feed |

Rain overlay: CSS animation of rain streaks layered over the base diamond SVG, triggered by `game.status === 'DELAYED'`.

#### Field Impact System

Weather affects the playing surface in ways that persist beyond the weather event. These field impacts are stored on the game object and fed to the sim engine as modifiers.

```javascript
game.fieldCondition: {
  infieldSoftness: Number,    // 0–1 — affects groundball hit rate, baserunning
  moundFirmness: Number,      // 0–1 — affects SP footing, pitch movement
  trackCondition: Number,     // 0–1 — affects outfield play
  temperature: Number,        // °F — affects bat speed (cold) and pitcher stamina (heat)
}
```

Heavy rain 48 hours ago → elevated `infieldSoftness` today. Heat wave → reduced `stamina` sub-rating effectiveness for pitchers. Cold snap → slight contact penalty for hitters. These are sim engine inputs, not visual-only.

The groundskeeper's field maintenance decisions (see Section 8.9) can improve field condition values before games.

#### Makeup Game Scheduling

When a game is postponed:
- A makeup game is inserted at the next available travel day within 10 games
- If no travel day exists, a doubleheader is scheduled
- Makeup games flagged `isMakeup: true` on the game object
- Suspended game makeups preserve: `resumeFromInning`, `resumeScore`, `resumePlays`

#### Weather Postponement Thresholds (LOCKED)

Postponement probability is computed from the weather frame at scheduled game time. Not binary — a 60% postponement chance means the game sometimes plays, which is realistic. The threshold is evaluated 2 hours before first pitch.

**Precipitation intensity thresholds:**

| Intensity | Delay probability | Postponement probability |
|---|---|---|
| Light (< 0.3) | 0% | 0% — play through it |
| Moderate (0.3–0.59) | 40% | 10% |
| Heavy (0.6–0.89) | 80% | 35% |
| Severe (0.9+) | 15% | 80% — window may open briefly |

**Temperature modifiers:**
- Below 35°F with any precipitation → automatic postponement (override)
- 35–45°F with any precipitation → +20% postponement probability
- Above 95°F (heat) → no postponement; pitcher stamina penalty instead

**Regional modifiers (applied multiplicatively):**
- `north` → postponement probability ×0.75 (experienced groundskeepers, better drainage)
- `south` → +15% delay probability for afternoon games (thunderstorm pattern)
- `east` → postponement probability ×1.1 (softer ground baseline)
- `west` → postponement probability ×0.65 (driest region, least rain risk)

**Delay-to-postponement logic:**
If the weather window doesn't clear within 2 hours of game time → game becomes postponed.
If it clears within 2 hours → game becomes delayed (delayed start, plays from that point).

**Mid-game suspension threshold:**
If intensity reaches 0.8+ during a live game → game suspended.
If 5+ innings completed when suspended → game is official, result stands.
If fewer than 5 innings → resumes from suspension point at makeup date.

**All thresholds stored as named constants in WeatherEngine** — no magic numbers in simulation logic.

#### Weather on Schedule Screen (LOCKED)

Weather icons shown on the schedule screen are limited to the 7-day forecast window only:
- Completed games: show actual weather that occurred (stored on game object)
- Games within next 7 days: show weather icon from rolling buffer
- Games beyond 7 days: **no weather icon shown** — it's not realistic to know months in advance

This means a weather icon on the schedule is always meaningful information, never fiction.

---

### 8.9 The Head Groundskeeper — Standing Character (LOCKED)

The Head Groundskeeper owns the **playing surface only** — grass, infield dirt, mound, warning track, and weather impact on the field. Everything else in the ballpark belongs to Facilities & Operations (Section 8.10).

The GM does not travel with the team. The GM is always in the front office. Road trips are not absences — they are windows of front office bandwidth when the ballpark isn't hosting games, making them ideal for field maintenance work. Cards frame this correctly: *"With no home games this week, we have a good window to get the infield drainage work done — want to move forward?"*

#### Relationship Score

`groundskeeperRelationship: Number` (0–100) on the `userTeam` object. Starts at 50.

Increases by: using the compose channel proactively, approving maintenance requests, acting on weather warnings the groundskeeper flags.

Decreases by: ignoring groundskeeper compose prompts, repeatedly declining maintenance requests, missing time-sensitive weather cards.

**Relationship effects:**
- High (70+): proactive weather warnings fire earlier (90 min out vs 60), field conditions maintained at higher baseline
- Low (below 30): delayed information, field condition cards less frequent, mound prep cards less specific

#### Compose Channel Prompts

| Prompt | Available when | Generates |
|---|---|---|
| "Check field conditions before tomorrow's game" | Any time | Field condition report card |
| "Check on the mound for {next_sp_name}" | Before a home game | SP mound prep card |
| "How does the field look after that rain?" | After a weather event | Post-weather assessment card |
| "What's your read on this week's weather?" | Any time | Weather anticipation card |
| "Good window to get some field work done this road trip" | Road trip | Field maintenance decision card |
| "Walk me through field priorities this offseason" | OFFSEASON phase | Hosting score contributor card |

#### Groundskeeper Card Pool

**Field condition cards:**
- Post-rain infield softness notice — sim modifier applied
- Heat wave pitcher warning — stamina sub-rating temporary penalty
- Cold snap hitter advisory — contact modifier for upcoming games
- Mound wear notice after heavy usage

**Home stand cards** (higher frequency during home stands):
- Pre-series field prep approval
- Mid-home-stand maintenance check
- Post-home-stand condition report

**Road trip cards** (lower frequency — maintenance opportunity framing):
- "Good window for infield work while we're away — approve?"
- "Mound reconstruction scheduled — confirm timeline?"

**Weather-anticipation cards:**
- "Storm tracking for Thursday — start pre-treating the field?"
- "Rough forecast for the home stand — brief the crew?"

**Offseason field cards** (feed All-Star hosting score):
- Outfield drainage improvement
- Infield playing surface upgrade
- Bullpen mound reconstruction
- Warning track resurfacing

---

### 8.10 Facilities & Operations — Department (LOCKED)

Facilities & Operations owns everything in the ballpark that isn't the playing surface: infrastructure, fan experience, broadcast facilities, security, and event logistics. Separate compose channel, separate relationship score, separate card pool.

The GM is always present for F&O decisions — there is no travel-based absence framing here either. F&O cards are front office business decisions.

#### Relationship Score

`facilitiesRelationship: Number` (0–100) on `userTeam`. Starts at 50.

High relationship: F&O flags problems proactively before they become public-facing issues. Low relationship: problems surface reactively, often after affecting atmosphere.

#### F&O Domain

- Visiting clubhouse and umpire room
- Concourse infrastructure — concessions, restrooms, entry gates
- Scoreboard and video board systems
- Lighting systems
- Press box and broadcast facilities
- Bullpen and dugout infrastructure
- Security and event staffing
- Fan experience infrastructure — wifi, mobile ticketing, ADA compliance
- Parking and transportation

#### Compose Channel Prompts

| Prompt | Available when | Generates |
|---|---|---|
| "Check on visiting clubhouse ahead of the series" | Before a home series | Visiting clubhouse condition card |
| "How are the concourse systems holding up?" | Mid-home-stand | Concourse maintenance decision |
| "Any issues from last night's game?" | Morning after home game | Post-game ops report |
| "What facility projects can we tackle this road trip?" | Road trip | Infrastructure improvement card |
| "Walk me through ballpark priorities this offseason" | OFFSEASON | Hosting score contributor card |

#### F&O Card Pool

**Pre-series preparation:**
- Visiting clubhouse condition decision (affects GM relationship with visiting team)
- Broadcast facility readiness for high-profile series
- Security staffing level decision for rivalry games

**Infrastructure decisions:**
- Scoreboard/video board upgrade proposal
- Concourse renovation section by section
- Lighting system upgrade (affects night game atmosphere)
- WiFi and mobile experience upgrade

**Fan experience:**
- Accessibility improvement proposal
- Parking logistics decision for high-demand games
- Food and beverage vendor decision (revenue vs atmosphere tradeoff)

**Road trip maintenance window cards:**
- "Good window to close a concourse section for repairs — approve?"
- "Electrical systems need attention — schedule during road trip?"

**Offseason F&O cards** (feed All-Star hosting score):
- Press box renovation
- Concourse full-section renovation
- Umpire room upgrade
- Broadcast infrastructure overhaul
- Accessibility compliance upgrade

---

### 8.11 Ticket Office — Department (LOCKED)

The Ticket Office handles all sales, attendance, pricing, and fan-facing financial decisions. Its decisions connect directly to the revenue and atmosphere metrics.

**Core principle for ticket office cards:** Every card must be a business decision with a real tradeoff — not information delivery. "Attendance was low this week" is not a card. "Season ticket renewals are down 8% — offer an early-bird incentive or hold pricing?" is a card.

#### Relationship Score

`ticketOfficeRelationship: Number` (0–100) on `userTeam`. Starts at 50.

High relationship: ticket office brings opportunities proactively (demand surge cards, group sales wins). Low relationship: missed revenue opportunities, delayed postponement handling.

#### Compose Channel Prompts

| Prompt | Available when | Generates |
|---|---|---|
| "Check on season ticket renewal status" | Any time | Renewal campaign decision card |
| "How's demand looking for this series?" | Before a home series | Pricing/promotion decision |
| "What's the rain check situation?" | After a postponement | Rain check handling card |
| "How are playoff ticket inquiries looking?" | Games 100+ | Playoff demand card |
| "Review group sales pipeline" | Any time | Group sales decision card |

#### Ticket Office Card Pool

**Season ticket management:**
- Renewal campaign decision (incentive vs hold pricing)
- Renewal rate milestone card (positive news, atmosphere boost)
- Corporate package proposal

**Single-game and series pricing:**
- Demand surge opportunity — winning streak driving interest
- Slow demand alert — losing streak affecting walk-up sales
- Rivalry series pricing decision
- Promotional giveaway decision (cost vs attendance vs atmosphere)

**Post-postponement:**
- Rain check outreach decision
- Makeup game pricing decision

**Playoff and special events:**
- Playoff ticket allocation decision
- All-Star week ticket management (hosting only)
- Championship series demand card

**Attendance milestones:**
- Home sellout streak card (atmosphere + revenue boost)
- Season attendance record approach card

---

### 8.12 Full Compose Channel Map (LOCKED)

The complete cast of recurring characters and departments in the GM's world. All channels exist in the architecture from day one — content is added progressively, but no channel requires structural changes to add later.

| Channel | Type | Primary domain | Initial priority |
|---|---|---|---|
| Manager | Field staff | Strategy, personnel, lineup, culture | High — built in core phases |
| Pitching Coach | Field staff | Rotation management, arm health | High |
| Hitting Coach | Field staff | Hitter development, slumps | High |
| Bench Coach | Field staff | In-game decisions, morale | Medium |
| Bullpen Coach | Field staff | Reliever usage and health | Medium |
| Head Groundskeeper | Field staff | Playing surface, weather | High — weather system dependent |
| Facilities & Operations | Front office | Ballpark infrastructure | Medium |
| Ticket Office | Front office | Sales, attendance, pricing | Medium |
| Scouting / Player Development | Front office | Prospects, opponents, acquisitions | Medium |
| Media Relations | Front office | Press, public narrative | Low — event-driven |
| Community Affairs | Front office | Fan relations, local events | Low |

**"Initial priority"** reflects which channels are built first — not which matter most. High-priority channels have card pools in the initial release. Medium channels are added in subsequent content phases. Low channels are event-driven and can be added whenever appropriate cards are written.

All channels share the same compose UI pattern and card delivery architecture. Adding a new channel is a content decision (write the cards, add the compose prompts) not an engineering decision.

- On commit: slim all pre-gen fields, keep only `boxScore` and `recap`
- `_drainTradeTransactions(gameIndex)` runs at commit
- Deferred incoming players placed, pending departure players removed

### 8.5 Calendar Pacing (LOCKED)

Games are scheduled at real-world daily cadence — one game per day when scheduled, mirroring a real baseball calendar. A 132-game regular season plays out over approximately 5–6 months of real time.

All games scheduled at **1:05 PM ET** (matching v1). This is the anchor timestamp from which play-by-play timestamps are distributed across the game's duration.

**Travel days** (gaps between series with no game scheduled) are real calendar days with no game. They are not dead time — they have their own card pool and between-games engagement layer (see Section 8.6).

**Schedule generation** must produce:
- Series groupings (3 or 4 game series per opponent)
- Home/away designation per series
- Travel day identification (gap between series, different home/away status)
- Home stand and road trip continuity tracking (consecutive home or road games)
- Division opponent flagging
- All-Star Break gap (no games scheduled around game 66)
- Trade deadline window flagging (games 88–92)

### 8.6 Situational Card Context (LOCKED)

The CardEngine receives a rich context object before every card delivery check. This context is computed fresh each time and passed to every card's eligibility function — cards declare their situational requirements, the context satisfies or blocks them. No card computes its own situation.

```javascript
// Computed by GameEngine before each CardEngine check
const cardContext = {
  // Game basics
  gameIndex: Number,
  phase: String,
  isHome: Boolean,

  // Series context
  seriesPosition: Number,        // 1st/2nd/3rd/4th game of this series
  seriesLength: Number,          // 3 or 4
  isDivisionOpponent: Boolean,
  upcomingOpponent: String,

  // Home stand / road trip position
  isHomeStandOpener: Boolean,    // First game of a home stand
  isHomeStandCloser: Boolean,    // Last home game before a road trip
  isRoadTripOpener: Boolean,     // First game of a road trip
  isRoadTripCloser: Boolean,     // Last road game before returning home
  consecutiveHomeGames: Number,  // How deep into this home stand
  consecutiveRoadGames: Number,  // How deep into this road trip
  isTravelDay: Boolean,          // No game today — gap between series

  // Between-games timing
  daysUntilNextGame: Number,
  daysSinceLastGame: Number,

  // Recent performance
  streak: Number,                // Positive = win streak, negative = loss streak
  lastGameResult: String | null, // 'W' | 'L'

  // Season context
  gamesBack: Number,             // Games behind division leader (0 if leading)
  playoffPosition: String,       // 'leading' | 'wildcard' | 'out'
  daysUntilDeadline: Number | null,
}
```

**Situational card flags (declared in card definitions):**
- `_requiresHome: Boolean` — only fires during home games
- `_requiresRoad: Boolean` — only fires during road games
- `_requiresHomeStandOpener: Boolean`
- `_requiresRoadTripOpener: Boolean`
- `_requiresTravelDay: Boolean`
- `_requiresDivisionOpponent: Boolean`
- `_minConsecutiveRoadGames: Number` — road trip fatigue cards
- `_minStreak: Number` — winning or losing streak threshold
- `_requiresDeadlineWindow: Boolean` — only fires games 88–92

### 8.7 Situational Card Categories (New in Rebuild)

These card categories are new or significantly expanded from v1, enabled by the situational context system:

**Home stand preparation cards** (fire on `_requiresHomeStandOpener`):
- Facility readiness reports from the grounds crew or operations staff
- Front office sponsor activation decisions tied to the home opener
- Fan engagement initiatives — promotions, giveaways, community events
- Season ticket holder outreach decisions

**Travel day cards** (fire on `_requiresTravelDay`):
- Front office desk work — scouting calls, contract research, trade conversations
- League-wide activity recap — what happened around the league while traveling
- Rest and recovery check-ins for high-usage players
- Advance scouting report for the next opponent

**Road trip culture cards** (fire on `_minConsecutiveRoadGames: 4+`):
- Clubhouse temperature check — team cohesion under travel fatigue
- Individual player road struggles (a specific hitter with poor road numbers)
- Manager's approach to maintaining routine away from home

**Series-specific opponent cards** (fire on `_requiresDivisionOpponent` or specific opponent context):
- Scouting report decisions tied to the upcoming series
- Historical rivalry callbacks — *"This is the fourth time we've faced New York this season"*
- Opposing pitcher tendencies when a known ace is scheduled

**Return home cards** (fire on `_requiresHomeStandOpener` after a road trip of 7+ games):
- Morale recovery acknowledgment after a long road trip
- Facility welcome-back cards — something positive about returning home
- Fan energy cards if the home stand opens a key stretch of the season

---

### 8.13 Geographic Region (LOCKED — Phase 13.5)

The user selects a region during team creation (Setup Step 2, between archetype and naming). Region is abstract — four options with flavor descriptions implying real geography without naming it. Affects weather, facilities, travel, card pools, and CPU team flavor.

**Schema:** `state.settings.region: 'north'|'south'|'east'|'west'`

**Four regions:**

| Region | Climate character | Key mechanical effects |
|---|---|---|
| `north` | Cold springs/falls, frost risk | Postponement probability ×0.75 (better drainage), cold-suppressed offense Apr/Sep, pitcher stamina reduced in cold, groundskeeper snow/frost card pool |
| `south` | Hot/humid, warm all season | Afternoon thunderstorm pattern (+15% delay for afternoon games), heat reduces pitcher stamina, no early/late season cold risk, irrigation/turf stress cards |
| `east` | Moderate, highest rain frequency | Postponement probability ×1.1, coastal fog possibility, salt air corrosion in facilities cards, densest travel schedule |
| `west` | Driest, wind primary factor | Postponement probability ×0.65, altitude lifts ball carry (slight scoring boost), longest road trips generate travel fatigue, dust/sand facilities cards |

**What region does NOT affect:** archetype, roster structure, finances, playoff format, or card system mechanics. Region is atmosphere and modifier, not difficulty.

**Setup screen change:** Region becomes Step 2. Full flow: Archetype → Region → Naming → Colors → Take the Job. (4 steps, still no mode selector — Section 2.1.)

**New constant:** `REGIONS` object in `data/constants.js` with modifier profiles per region.

---

## 9. Trade System Design

> Status: LOCKED — no cash in trades (decided Phase 8 pre-build).
> Trade fairness communicated via a fairness rating signal, not cash exchange.
>
> **Decided (Session 8, §78): cash returns to trades** — money moves between club funds, usually one club covering part of a player's remaining salary. Built in §78 Phase 4.
>
> ~~Under review (Session 8, before B7 user-initiated trades):~~ the GM wants to reconsider the no-cash rule — cash may need to be part of trades after all (as in real baseball, where clubs include money to balance salaries or a deal). **Discuss with the GM before implementing B7; do not build B7 on the no-cash assumption.** See §76.
> Cash considerations create budget complexity without adding meaningful strategy for a mobile GM sim.

### 9.1 Cash Direction (LOCKED)

| Rating differential | Cash direction | Card language |
|---|---|---|
| Incoming < Outgoing (user sends better player) | User RECEIVES cash | "They'll send $Xm to balance the deal" |
| Incoming > Outgoing (user receives better player) | User PAYS cash | "You'll send $Xm to complete the deal" |
| Incoming = Outgoing | No cash | "Even exchange" |

### 9.2 Cash Amount Formula

> TBD — to be designed. Inputs: rating differential, player salary, season phase.
> Rough guidance: each rating point differential ≈ $Xm. To be calibrated.

### 9.3 Trade Card Types (v1 baseline)

| Card | Type | Notes |
|---|---|---|
| t1 | Pitcher acquire (cash) | CPU offers pitcher, user pays cash |
| t2 | Hitter acquire (cash) | CPU offers hitter, user pays cash |
| t3 | Pitcher-for-pitcher swap | Cash direction determined by formula |
| t4 | Hitter-for-hitter swap | Cash direction determined by formula |
| t5 | Cash-only acquire | User receives cash + player |
| t6 | Prospect return | Minor leaguer comes back |

### 9.4 Game-Day Deferral

- Trade accepted on game day: outgoing marked `_pendingDeparture`, TRADED badge shown
- Incoming held in `state._pendingAcquisitions`
- Both shown in Pending Transactions section
- `drainPending(gameIndex)` runs at game commit: removes outgoing, places incoming
- Depth checks run AFTER drain, not before

### 9.4b Contract Extensions (Phase 8)

`player.contractExtended: Boolean` is present on the player object from Phase 2. Contract extension mechanics are built in Phase 8 alongside user-initiated trades.

**Two distinct concepts — do not confuse:**

**Contract extension** — offering a player additional years on their *current active* contract before it expires. A player on a 3-year deal in year 2 gets 2 more years added, effectively extending the deal. `contractExtended: true` prevents this from happening twice on the *same contract* — you cannot extend an already-extended deal. This is a mid-contract action.

**Contract renewal / re-signing** — when a player's contract *expires*, you offer them a brand new contract. This is unlimited — a player can be re-signed season after season with no restriction. `contractExtended` resets to `false` on every new contract issued (re-sign, trade acquisition, free agent signing).

Extension rules:
- One extension per active contract (`contractExtended` guards this — resets to false on new contract)
- Extension offered before the player's final contract year: gmRelationship +6
- Extension offered after player has requested one: gmRelationship -2 (they had to ask)
- Extended contract adds 1–3 years at current or slightly elevated salary
- `contractExtended` set to true on execution; reset to false when a new contract is issued

### 9.5 User-Initiated Trades (IN SCOPE — Phase 8)

The user can propose trades from the Players tab or a league team's roster view. Designed now so nothing built in Phases 1–7 prevents it. Built in Phase 8 after the CPU trade foundation is proven stable.

- "Offer Trade" button on any league player profile
- Roster picker — user selects player(s) to offer in return
- Side-by-side OVR and sub-rating comparison view
- Cash direction auto-calculated by the same `TradeEngine.evaluateTrade()` used for CPU trades — identical logic, no special casing
- CPU evaluation based on GM relationship score and rating differential
- Per-team cooldown (~15 games) after a declined offer
- Accepted user-initiated trades use the identical `executeTrade` / `deferTrade` path — no separate execution code

### 9.6 Counter-Offer System (IN SCOPE — Phase 9)

Extends user-initiated trades. CPU teams can counter instead of flat accept/decline.

- CPU proposes a different player or adjusts cash
- Maximum 2 rounds of negotiation per attempt
- Counter weighted by GM relationship — friendly teams counter more reasonably
- Counter-offer arrives as inbox card with revised terms
- User can accept, decline, or counter back once

### 9.7 Waiver System (IN SCOPE — Phases 10–12)

Full waiver system. Data model built in Phase 1 so it's present from day one. User-facing features built in later phases once the player lifecycle is stable.

**Data model fields (Phase 1):**
- `state.waiverPool` — array of player IDs currently on waivers
- `player.onWaivers: Boolean`
- Waiver claim order: inverse standings (worst team claims first)
- Claim window: 72 real-world hours before player clears to free agency

**Phase 10:** CPU team waiver activity — league places and claims players automatically
- Waiver priority cycling (LOCKED — Section 20.2): `state.waiverPriority` array added to schema (Phase 5 retroactive fix). Priority resets at season start by inverse standings. When a team uses a claim, they drop to last position, all others shift up. `LeagueEngine.processWaiverClaims()` currently uses simple inverse standings — must be updated in Phase 10 to implement full cycling logic.
**Phase 11:** User waiver pool view in Players tab + claim interaction
**Phase 12:** Full player release, dead cap tracking

**Farm vs waivers rule (LOCKED — decided during Phase 3 planning):**
- `sendToFarm()` is valid ONLY during spring training cuts (38→28) and position-aware farm overflow displacement
- ALL other player removals — mid-season cuts, IL return decisions, declined re-signs — go through `placeOnWaivers()`
- No minor league option restrictions — players can be sent to the farm freely during spring, but never mid-season outside overflow displacement
- IL return always surfaces a decision card (CardEngine Phase 9) — `returnFromIL()` never auto-activates; flags `_pendingILReturn: true` and adds to `state.ilReturnQueue`

---

## 10. Card System Design

> Status: LOCKED — finalized during Phase 9 pre-build audit.

### 10.1 Card Pools (LOCKED)

| Pool | When it fires | Notes |
|---|---|---|
| `DECISIONS_POOL` | Main pool — checked each game day | Includes spring cards (filtered by `_requiresSpring:true`) |
| `PREGAME_POOL` | 30–90 min before first pitch | |
| `INGAME_POOL` | Between half-innings during live games | |
| `BETWEEN_GAMES_POOL` | Travel days, home stand openers/closers, road trip culture | New in v2 — 12 cards written in Phase 9 pre-build |
| `FOLLOWUP_POOL` | Triggered by earlier card decisions | |
| `PERSONAL_LEAVE_POOL` | Player personal leave situations | |
| `MANAGER_CONTRACT_POOL` | Offseason manager contract renewals | |
| `COACHING_CONTRACT_POOL` | Offseason coaching staff renewals | |

Note: `SPRING_POOL` is not a separate array — spring cards live in `DECISIONS_POOL` filtered by `_requiresSpring:true`. `ALLSTAR_HOST_POOL` and `OFFSEASON_POOL` are future content phases.

### 10.2 Token System

Card text uses `{token}` placeholders resolved at delivery time.

**Standard tokens (LOCKED — no rating tokens in card text):**
- `{active_sp_name}`, `{active_sp_pos}` — random active SP. Name token automatically includes handedness: e.g. `"Marcus Johnson (R)"`. Applies to all pitcher name tokens. Format is `(R)`/`(L)` — short form for mobile space efficiency. Card authors never manually include handedness — the resolver enforces it.
- `{active_hitter_name}`, `{active_hitter_pos}` — random active hitter
- `{active_bp_name}` — random active bullpen arm
- `{manager_name}`, `{pitching_coach_name}`, `{hitting_coach_name}`, `{bench_coach_name}`
- `{physician_name}` — team physician
- `{misc_cost_sm}`, `{misc_cost_capped}`, `{misc_cost_xs}`, `{misc_cost_lg}` — budget cost tokens (resolve to $K display string)
- `{rev_amount}` — revenue token
- `{streak_context_clause}` — contextual text based on current streak
- `{next_opponent}` — name of next scheduled opponent
- `{farm_pitcher_name}`, `{farm_hitter_name}` — farm system players (name only)

**Removed tokens (Phase 9 cleanup):**
- `{active_sp_rating}`, `{active_hitter_rating}`, `{active_bp_rating}`, all `{*_rating}` variants — removed. Player ratings are visible on the Roster/League screen. Cards reference players by name and position only.
- `{trade_cash_note}` — removed. No cash in trades (LOCKED).

### 10.3 Card Delivery Rules

- Once-per-season deduplication (by card `id`)
- `_minGames` — card won't fire before this schedule index
- `_maxTier` — card won't fire above this prestige tier
- `_requiresRegular` — only fires in REGULAR_SEASON phase
- `_requiresSpring` — only fires in SPRING_TRAINING phase
- `_requiresHome` — only fires for home games (INGAME cards)
- `_requiresBenchSP` — only fires if a bench SP is available

### 10.3b CardInstance Shape (LOCKED)

See `store/schema.js` — `state.inbox` contains `CardInstance[]`. Each instance is created by CardEngine at delivery time from the card definition. Key fields: `instanceId`, `cardId`, `deliveredAt`, `expiresAt`, `expiresAtMs` (weather cards only), `resolved`, `choice`, `type`, `tag`, `sender`, `subject`, `preview`, `body`, `yesLabel`, `noLabel`, `yesEffect`, `noEffect`, `autoResolve`, `_playerRelationshipEffect`, `_budgetCost`, `_raw`.

### 10.4 Auto-Resolve

- Cards expire at `expiresAtGame`
- `autoResolve: 'no'` → resolves as 'no' with `autoResolveTax` applied
- `autoResolve: 'skip'` → dismissed silently (INGAME cards use this)
- Expiry message shown in card history if `_expireMsg` set

### 10.5 Priority Ordering

Inbox sorted: `urgent` → `normal` → `good`, then by delivery game (newest first within tier).

### 10.6 Personal Leave Status (Implementation Note)

`player.onPersonalLeave: Boolean` exists on the player object (Section 4.3). This flag is set and cleared exclusively by CardEngine when PERSONAL_LEAVE_POOL cards are resolved. No other engine sets this flag. The personal leave state affects:
- Player is unavailable for lineup (treated same as `isResting` for availability checks)
- Duration is card-determined, not game-count-determined
- CardEngine must clear the flag when the follow-up personal leave resolution card resolves

---

## 11. Injury Card Redesign

### 11.1 The Two-Act Model

All injury events that occur during a live game use the two-act structure. Classic mode injuries can use a condensed single card since there is no "live" moment.

#### Act 1 Card (INGAME — fires during live game, between half-innings)

```
sender: 'Head Trainer'
type: 'urgent'
tag: 'INJURY'
subject: '{player_name} down — leaving the game, evaluation pending'
body: '{player_name} left the field in the {inning_ordinal} inning and is being evaluated
      in the clubhouse. No diagnosis yet. {manager_name} wants to know how to handle
      the lineup for the rest of the game.'
yesLabel: 'Cover the slot — adjust the lineup now'
noLabel: 'Hold — wait to see if they can return'
yesEffect: { morale: -1 }
noEffect: { morale: -2 }   ← higher risk if they can't return
```

Decision is real: burning a bench player vs gambling on a return.

#### Act 2 Card (FOLLOWUP — fires next morning or post-game)

```
sender: 'Team Physician'
type: 'urgent'
tag: 'INJURY'
subject: '{player_name} — diagnosis confirmed: {injury_description}'
body: 'MRI results are in. {injury_description_full}. {physician_name} recommends
      {recommended_il_days} days minimum. You can place on the 10-day IL now and
      call someone up, or try to manage day-to-day and preserve roster flexibility.'
yesLabel: 'Place on IL — call up {callup_candidate}'
noLabel: 'Day-to-day — manage the roster manually'
```

Uncertainty mechanic: sometimes Act 2 is better than Act 1 feared (sprain not a tear),
sometimes worse (stress fracture found). This is determined at Act 1 resolution time
but not revealed until Act 2 fires.

### 11.2 Classic Mode Injury Cards (RETIRED)

Classic mode was retired in Section 3.4. All injury events use the two-act live model. References to "classic mode" in this section are legacy — ignore them.

### 11.3 Existing Injury Cards (v1 audit)

The existing cards `i1`–`i5` in `cards-pool.js` fire outside the live game context.
These need to be:
- Converted to Act 2 cards for live mode (Act 1 fires during the game instead)
- Kept as-is for classic mode
- The conflation in v1 (injury cards that didn't know whether they were in-game or post-game) is removed by the two-act model

> Full card-by-card audit: TBD.

---

## 12. Push Notification Architecture

### 12.1 Why v1 Broke on Android

The v1 service worker used `setTimeout` inside `sw.js` to schedule notifications. Android kills service workers aggressively to save battery — any pending `setTimeout` dies with the worker. This is why notifications worked on desktop Chrome (which keeps workers alive longer) but silently failed on Android.

The v1 `worker.js` Cloudflare Worker was the right architectural instinct but was only half-wired — it used FCM tokens directly rather than the proper Web Push subscription flow, mixing two different systems.

### 12.2 Correct Architecture

```
App (browser)
  │
  ├─ 1. Request notification permission
  ├─ 2. Subscribe: navigator.serviceWorker.ready
  │       → registration.pushManager.subscribe({ applicationServerKey: VAPID_KEY })
  │       → returns PushSubscription object (endpoint + keys)
  │
  ├─ 3. POST subscription + userId to Cloudflare Worker /register
  │
  └─ 4. When cards are delivered or scheduled:
         POST updated schedule to Cloudflare Worker /schedule

Cloudflare Worker (push-worker.js)
  │
  ├─ Stores: { userId → { subscription, schedule[] } } in KV store
  │
  ├─ Cron (every minute):
  │   → Scan all KV records for due items (deliverAt <= now)
  │   → For each due item: POST to Web Push endpoint (NOT FCM HTTP API directly)
  │   → Uses VAPID private key to sign the push message
  │   → Browser's push service delivers to device
  │
  └─ /cancel endpoint: removes item from schedule

Service Worker (sw.js) — on device
  │
  ├─ Listens for 'push' event
  ├─ Parses payload: { title, body, tag, data: { cardId } }
  └─ Calls self.registration.showNotification(...)

```

**Key difference from v1:** The Cloudflare Worker sends to the browser's push service endpoint (e.g., `https://fcm.googleapis.com/fcm/send/...` — this is the Web Push endpoint embedded in the subscription, not a direct FCM API call). VAPID signing happens in the Worker, not in the app. The service worker on device only receives and displays — it never schedules.

### 12.3 Firebase Role

Firebase is used for:
- Generating VAPID keys (Firebase → Project Settings → Cloud Messaging → Web Push certificates)
- The browser's push service endpoint (on Android Chrome, this routes through FCM infrastructure)

Firebase is NOT used for:
- Direct FCM API calls
- Firebase SDK in the app
- Any server-side Firebase service

This means Firebase setup is minimal: create project, enable Cloud Messaging, copy VAPID public key. Done.

### 12.4 Cloudflare Worker Setup

Required:
- Cloudflare account with Workers enabled (free tier sufficient)
- KV namespace: `BGM_SCHEDULES` bound to worker
- Worker secrets:
  - `VAPID_PRIVATE_KEY` — from Firebase project
  - `VAPID_PUBLIC_KEY` — same, used in subscription
  - `VAPID_SUBJECT` — `mailto:your@email.com`

Worker endpoints:
- `POST /register` — store subscription + initial schedule
- `POST /schedule` — update schedule for existing user
- `POST /cancel` — remove a specific notification
- `GET /vapid-key` — returns VAPID public key (so app doesn't need to hardcode it)
- Cron: `*/1 * * * *` — every minute, check for due notifications

### 12.5 Notification Types

| Type | When | Card involved |
|---|---|---|
| Pre-game reminder | 30 min before first pitch | Scheduled at season start per game |
| Card delivery | When a new urgent card lands in inbox | Triggered by CardEngine.deliver() |
| Injury update (Act 2) | Next morning after Act 1 | Triggered by FOLLOWUP card schedule |

Quiet hours: if `deliverAt` falls within user's quiet window, advance to quiet window end time.

### 12.6 Permission Flow (UI)

1. First time app opens: no immediate permission request (bad practice, gets denied)
2. After user completes first game: prompt with context — "Get notified before game time and when decisions arrive?"
3. Settings > Notifications: toggle on/off, quiet hours, test button
4. If permission denied: Settings shows "Notifications blocked — enable in browser settings" with instructions

### 12.7 VAPID Key Setup — Confirmed Infrastructure (COMPLETED)

All infrastructure is configured. These values are confirmed and stored in Cloudflare secrets.

| Item | Value / Status |
|---|---|
| Firebase project ID | `baseball-gm-push` |
| Firebase Sender ID | `157200420537` |
| VAPID public key | `BPdBTqb92Gueg4-arpvFMQjD0rqcIABMYcIV7VAUbwepbsffrN-1YR8XfsjaYpZVX6qZ2Dvn30sp4H0_xNJzQCE` |
| VAPID private key | Stored in Cloudflare secret `VAPID_PRIVATE_KEY` |
| VAPID subject | Stored in Cloudflare secret `VAPID_SUBJECT` |
| Cloudflare Worker name | `baseball-gm-push` |
| Cloudflare Worker URL | `https://baseball-gm-push.baseball-gm.workers.dev` |
| KV namespace | `SCHEDULES` (ID: `e533db8115844e999e38c36ec7ba43f3`) |
| Cron trigger | `*/1 * * * *` (every minute) |

**`PUSH_WORKER_URL` for `data/constants.js`:**
```javascript
export const PUSH_WORKER_URL = 'https://baseball-gm-push.baseball-gm.workers.dev';
export const VAPID_PUBLIC_KEY = 'BPdBTqb92Gueg4-arpvFMQjD0rqcIABMYcIV7VAUbwepbsffrN-1YR8XfsjaYpZVX6qZ2Dvn30sp4H0_xNJzQCE';
export const FCM_SENDER_ID = '157200420537';
```

> **Superseded (r71, §77):** the app no longer bundles the public key — it always fetches it from the worker's `GET /vapid-key`.

**Security note — Phase 11 task:** Regenerate the VAPID key pair in Firebase after v2 push system is confirmed working. The private key was exposed during the setup audit. Steps: Firebase → Project Settings → Cloud Messaging → Web Push certificates → delete existing pair → generate new → update `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` in Cloudflare secrets immediately. Do not paste the new private key anywhere — copy directly from Firebase download into the Cloudflare secret field.

**Checklist — all items complete:**
- [x] Firebase project exists with FCM API V1 enabled
- [x] VAPID key pair exists in Firebase Web Push certificates
- [x] `FCM_SERVICE_ACCOUNT_JSON` deleted from Cloudflare
- [x] `VAPID_PUBLIC_KEY` updated to Firebase key
- [x] `VAPID_PRIVATE_KEY` updated to matching private key
- [x] `VAPID_SUBJECT` set to operator email
- [x] KV namespace `SCHEDULES` bound to worker
- [x] Cron trigger set to `*/1 * * * *`
- [x] Regenerate VAPID keys after Phase 11 testing (security cleanup) — done Oct 26, 2026 (§63)

---

## 13. Season-to-Season Transition

> Status: DESIGNED — open questions in Section 14 (items 11–16).

This is one of the most complex state operations in the game. It touches every system simultaneously and must execute in strict order. The OFFSEASON phase is a real phase with its own rules — not a series of inline function calls.

### 13.1 Transition Trigger

The transition begins when the final playoff series resolves (or when the user's team is eliminated and all other series complete). The phase moves from the final playoff phase → `SEASON_SUMMARY` → `OFFSEASON`.

### 13.2 Offseason Processing — Strict Execution Order

Each step must complete before the next begins. StateManager batches mutations and saves once at the end of each step.

**Step 1 — Lock the record**
- Final standings saved to `seasonHistory`
- Champion recorded
- Franchise history updated (prestige tier recalculated)
- `metricHistory` finalized for this season

**Step 2 — Archive player stats**
- Every player in `state.players`: `careerStats` updated from `stats`
- `careerStats.seasons++`
- `peakOvr` updated if this season's `ovr` is higher
- `stats` reset to zero for all players
- This runs on ALL players — user roster, all league rosters, IL players

**Step 3 — Player aging**
- Every player's age recalculated from `dob` (age is always computed from DOB, never stored — this prevents drift)
- No state change needed for age itself, but this step gates Step 4

**Step 4 — Sub-rating development and decline**
- Runs for every player on all 10 rosters
- Applies age curve + trait modifier + variance to each sub-rating
- OVR recomputed from new sub-ratings
- Injury penalties cleared (new season, clean slate)
- Results logged to `careerStats.peakOvr` if applicable

**Step 5 — Contract expiry**
- Every player with `contractExpiry === seasonNum` is flagged `contractExpired: true`
- User roster expiries → generate re-sign decision cards (one per expiring player, queued for OFFSEASON phase)
- League roster expiries → CPU teams process automatically (see Step 7)

**Step 6 — User roster decisions (player-gated)**
The OFFSEASON phase does not advance to Step 7 until the user resolves all expiring contract cards. This is intentional — roster construction is a core GM activity. Each expiring player card presents:
- Re-sign at market rate (based on age, OVR, and sub-rating trajectory)
- Let walk (player enters free agency — see Open Question 11)
- Negotiate extension (lower AAV in exchange for longer term — player must be receptive)

**Step 7 — League roster turnover**
- CPU teams process their own expiring contracts automatically
- Each CPU team signs free agents to fill gaps (using the same player generation logic as initial league build, or from a free agent pool — see Open Question 11)
- League team `str` values shift slightly based on offseason outcomes
- This step runs silently — results visible in the League tab

**Step 8 — Payroll recalculation**
- `userTeam.finances.payroll` recomputed from new roster after all contract decisions
- `operatingSpent` reset to 0
- Revenue archived to `revenueHistory`, `revenue` reset to 0

**Step 9 — Ownership evaluation card**
- Single card generated based on season performance (see Section 4.2 — Financial Model)
- Presents next season's `payrollCap` and `operatingBudget` offer
- User can accept, negotiate (push back for better terms at cost of ownerTrust), or push back hard (higher risk)
- This card is mandatory — OFFSEASON cannot advance without resolving it

**Step 10 — Coaching staff decisions**
- Generates MANAGER_CONTRACT_POOL and COACHING_CONTRACT_POOL cards for any expiring staff
- These can resolve in any order
- Manager exit conditions checked here — if `managerConfidence` is critically low, an exit card fires regardless of contract status

**Step 11 — Schedule generation**
- New 132-game schedule generated for season N+1
- New league schedule generated for all 9 CPU teams
- Game timestamps assigned (live mode only — based on real-world calendar from new season start date)

**Step 12 — Spring training setup**
- Spring training game schedule generated (~20 games)
- Phase transitions to `SPRING_TRAINING`
- `seasonNum++`
- Spring-specific card pools unlock

### 13.3 What Cannot Happen During OFFSEASON

- No regular season games can be advanced
- No INGAME cards can fire
- No PREGAME cards can fire
- Trade cards CAN fire (offseason trades are realistic)
- Signing cards CAN fire (free agent signings are an offseason activity)
- The schedule tab shows the new season's schedule in a "pending" state until spring begins

### 13.4 Player Lifecycle Summary

```
Generated → On roster (active) → IL (injured) → Return from IL
                ↓                                      ↑
         _pendingDeparture (traded) ──────→ Removed from roster
                ↓
         contractExpired → Re-signed (stays) OR Released (free agent)
                                                        ↓
                                              Free agent pool (see OQ-11)
                                                        ↓
                                              CPU team signs OR
                                              User signs via card OR
                                              Retires (age/rating threshold)
```

---

## 14. Build Order

The single most important lesson from v1: **build the foundation first and don't move on until it's stable.** Each phase must be complete and tested before the next begins.

### Phase 0 — Data & Constants (no logic) ✅ COMPLETE
1. `data/constants.js` — all magic numbers, enums, config (no difficulty presets — archetype parameters in Section 16.6 serve this role)
2. `data/player-names.js` — ES module export; 550→740 names; Scandinavian + West African names removed; ASCII-only enforced; separate FARM_H_NAMES/FARM_P_NAMES pools retired (farm draws from PLAYER_NAME_POOL); ACQ pools retained for external-player card flavor only
3. `data/cards-pool.js` — ES module export; c3/i1 collision fixed (missing closing brace on c3 _onResolve); all pool arrays exported
4. `data/league.js` — ES module export; state global references removed (seasonNum and leagueRosters now passed as parameters); functionality superseded by engine/LeagueFactory.js in Phase 2

> **Gate:** All data files export cleanly. No logic, no state references. ✅ 24/24 tests passed

### Phase 1 — State Foundation ✅ COMPLETE
5. `store/schema.js` — canonical state shape including save slots, weatherBuffer, waiverPool, ilReturnQueue, followupQueue, seenMilestones (Array not Set — JSON-serializable)
6. `store/DB.js` — IndexedDB wrapper; JSON round-trip enforcement on save; versionchange handler; appMeta store for small key-value app preferences
7. `store/StateManager.js` — get/set/mutate/save/load/reset/createSlot/deleteSlot; debounced auto-save; one-per-archetype enforcement; free tier slot limit; migration on load; crypto.randomUUID for all IDs; active slot ID in localStorage

> **Gate:** Can create a save slot, save state, close tab, reopen and restore. Multiple slots work independently. ✅ 38/38 tests passed

### Phase 2 — Player & League Pool ✅ COMPLETE
8. `engine/PlayerFactory.js` — `createPlayer()` single entry point for all player creation; `computeOVR()` single place OVR is ever calculated (accounts for injury penalty); sub-rating generation with strength/weakness bias; `computeAge()` always derived from DOB; all stat shapes; `clamp()` utility
9. `engine/LeagueFactory.js` — `buildFullLeague()` orchestrates full league generation; `initNameRegistry()` shuffles single PLAYER_NAME_POOL for all draws including farm; `buildLeagueRosters()` all 9 CPU teams + farm (20 players each); `buildUserRoster()` per archetype OVR/age/contract parameters; `applyArchetypeToUserTeam()` applies soft metrics, finances, GM relationship adjustments; payroll cap enforcement at generation time (proportional salary compression — generation constraint not runtime patch); uuidFn injected as parameter for testability
10. User team generation: all 6 archetypes handled with distinct OVR ranges, age skews, contract length distributions

> **Gate:** Full 10-team league with 280 active + 200 farm players exists in state. All player objects complete. OVR computes correctly from sub-ratings. ✅ 35/35 tests passed (3 false positives on comment scanning)

### 1.11b Build Full Features — No Artificial Gating During Development

Build every feature fully during its phase. Never artificially restrict features to "free tier" behavior during development. Free vs premium gating is applied as a single pass when the monetization system is designed — not inline during screen builds.

**Rationale:** Restricting features during development means the full feature is never tested until the worst possible time. Bugs discovered during free/premium implementation are harder to fix than bugs found during normal development. Build the full feature, test the full feature, then gate it.

**Applies to:** hot/cold indicators (league-wide, not roster-only), radar slider range, watchlist size, stat leader categories, forecast depth, and any other feature with a planned free/premium split.

### 1.12 Code Quality Standard — Written by Someone Who Knows What They're Doing

Every file in this codebase should look like it was written by a senior engineer, not generated and left as-is. This is not cosmetic — code that reads clearly is code that can be debugged, extended, and understood by anyone who picks it up.

**Enforced standards:**

- **Naming conventions** — camelCase for functions and variables, PascalCase for classes, SCREAMING_SNAKE_CASE for constants. No abbreviations that aren't universally understood (`ovr`, `sp`, `rp` are domain terms and acceptable; `tmp`, `x`, `res` are not).
- **JSDoc on every exported function** — `@param` with type and description, `@returns` with type and description. Internal helpers may use lighter comments but must have at least a one-line description.
- **Error messages name the module and function** — `"RosterEngine.sendToFarm: player not found"` not `"player not found"`.
- **No magic numbers inline** — every numeric constant is imported from `data/constants.js` by name.
- **No commented-out code** — removed code is deleted, not commented out. The plan doc tracks decisions; the code does not.
- **No `// TODO` or `// FIXME` in production files** — those are plan document items (Section 13 open questions).
- **Functions do one thing** — if a function exceeds ~40 lines and does multiple distinct operations, it should be decomposed.
- **File headers explain ownership** — every file starts with a JSDoc block stating what the module owns and explicitly what it does NOT do. This prevents scope creep.
- **Consistent import ordering** — constants first, then store, then engines, then utilities.
- **Pure function return values are mutations objects, never undefined** — if a pure function has nothing to mutate, it returns `{}`, not `undefined` or `null`.

**Audit triggers (proactive — no prompting needed):**
- Full cross-system audit after every 3 phases
- Before any UI phase begins
- After any decision that changes a locked value
- Before the first browser test session

### 1.13 Project Management Standard

The build is managed proactively. The owner makes product decisions; the builder manages the build.

**What the builder does without being asked:**
1. **Pre-phase checklist** — before every phase: locked decisions, forward assumptions, questions needing answers, gate test specification.
2. **Post-phase forward look** — after every phase: what was built, what was found and fixed, what the next phase depends on, any decisions needed.
3. **Proactive audit scheduling** — cross-system audits triggered at the moments listed in Section 1.12, not when the owner notices something feels off.
4. **Decision surfacing** — every TBD or stub encountered during a build is surfaced immediately with a recommendation. Never deferred silently.
5. **Plan document currency** — the plan is updated as part of every phase. If a phase completes without a plan update, that is a failure.
6. **Architectural health flags** — when something is technically correct but architecturally risky (a function doing too much, logic duplicated across two engines, a field referenced before it's defined), it is flagged proactively.

**What the owner does:**
- Makes product decisions when surfaced
- Confirms or adjusts recommendations
- Does not need to track implementation details, ask for audits, or manage phase sequencing

### 1.14 Navigation Structure (LOCKED — from v1, carried into v2)

**5 bottom nav tabs:**
- **Dashboard** — wins/losses/OVR, morale/atmosphere, next game preview, advance button
- **Inbox** — 3 internal tabs: `To Do` (with unread badge), `Completed`, `Compose`
- **Team** — 2 internal tabs: `Players`, `Staff`
- **League** — 3 internal tabs: `Players`, `Teams`, `Standings`
- **Schedule** — flat list with Scores button

Inbox tab labels match v1 exactly: To Do / Completed / Compose.
Team screen label is "Team" not "Roster" — matches v1.
Compose is a tab within Inbox, not a separate bottom nav item.

### Pre-build process (adopted Phase 5 onward)
Before each phase: explicit pre-flight audit of cross-system assumptions carried forward from previous phases.
Gate tests must assert structural correctness (exact player counts, required fields, value ranges) — not just syntax validity and export presence.

### Phase 3 — Roster Engine
12. `engine/RosterEngine.js` — all roster mutations, farm send-down/callup
13. Position-aware farm overflow displacement
14. Depth checking (Type 1/Type 2) + auto-resolve
15. IL system with return dates
16. Waiver placement and tier transitions

> **Gate:** Can move players between all tiers. Farm caps enforced. IL works. Waiver wire processes correctly.

### Phase 4 — Season, Schedule & League Engine
17. `engine/SeasonEngine.js` — full user schedule + all 9 CPU schedules (132 games each)
18. Series grouping, home/away, travel days, staggered game times
19. Standings calculation and update
20. `engine/LeagueEngine.js` — CPU roster decisions, waiver activity, activity feed
21. Season phase state machine

> **Gate:** Full 132-game schedule for all 10 teams. Standings update correctly. CPU teams make roster decisions. Activity feed populates.

### Phase 5 — Weather Engine
22. `engine/WeatherEngine.js` — 48-hour buffer generation, hourly frames
23. Game weather evaluation and status transitions
24. Radar frame pre-generation

> **Gate:** Weather buffer generates and persists. Game statuses transition correctly (DELAYED, POSTPONED, SUSPENDED). Radar frames available for UI.

### Phase 6 — Sim Engine
25. `engine/SimEngine.js` — win probability using difficulty preset constants
26. Score generation with sub-rating inputs
27. Full play-by-play pre-generation for user AND CPU games
28. Live game timing (timestamp assignment per game time slot)

> **Gate:** Can simulate any game (user or CPU) and produce a complete, valid play-by-play with correct cumulative scores and timestamps.

### Phase 7 — Injury Engine
29. `engine/InjuryEngine.js` — daily probability check across all teams
30. Injury report generation with relationship-filtered text
31. IL return processing

> **Gate:** CPU teams get injured and call up farm players. Reports available with correct relationship filtering.

### Phase 8 — Game Engine & Loop
32. `engine/GameEngine.js` — orchestrator ✅ COMPLETE
    - startNewGame, tick (with _tickOffset weather drift), commitGame (14-step sequence)
    - getNextGame, checkMilestone, advancePhase, buildCardContext
    - runOffseason (12-step, player-gated at steps 6+9), resumeOffseasonAfterResigns, resumeOffseasonAfterOwnership
    - applyWeatherDelay, suspendGame, resumeSuspendedGame
    - Only module that imports StateManager. Does not generate cards.
    - schema.js: farmIds added to userTeam. Pre-flight: 58/58 + 1 gap caught (farmIds).
    > **Gate:** 68/68 tests passed
33. Live game tick + play reveal
34. CPU game commit + league schedule update
35. Milestone trigger detection
36. Game commit + drain (trade deferral, pending acquisitions)
37. Weather card triggering via WeatherEngine events

> **Gate:** Full live game plays out. CPU games commit on schedule. Milestone screens trigger. Weather events work end-to-end.

### Phase 9 — Card Engine
38. `engine/CardEngine.js` — delivery with full situational context
39. Token resolution including gmRelationship and trade cash direction
40. Expiry with minute-based weather card support
41. Follow-ups and two-act injury flow
42. Player relationship effect application
43. Wire all card pools including new groundskeeper, F&O, ticket office, playoff pools

> **Gate:** Cards deliver, resolve, expire correctly. Two-act injury works. Relationship effects apply. All pools active.

### Phase 10 — Trade Engine
44. `engine/TradeEngine.js` — evaluation, cash direction from constants
45. CPU-initiated trades
46. Game-day deferral + drain
47. User-initiated trades (Phase 8 from old plan)
48. Counter-offer system

> **Gate:** All trade types execute correctly. Cash direction is always right. User proposals and counters work.

### Phase 11 — Notification Engine
49. `engine/NotificationEngine.js`
50. `workers/push-worker.js` (Cloudflare) — VAPID Web Push, cron, quiet hours, urgent bypass
51. VAPID key setup (Section 12.7 checklist)
52. Permission flow UI

> **Gate:** Notification fires on real Android device when app is closed. Urgent weather notifications bypass quiet hours. Pre-game reminder arrives 30 min before first pitch.

### Phase 12 — UI Core
53. `ui/EventBus.js`
54. `ui/App.js` + navigation + milestone screen routing
55. `ui/screens/MilestoneScreen.js` — full catalog
56. Dashboard with league activity feed widget
57. Roster screen with farm system section
58. Schedule screen
59. League screen with activity feed, CPU game viewer, injury icons, stat leaders
60. Players screen with waiver pool section and watchlist
61. Inbox/Compose screen with all channel prompts

> **Gate:** Full UI navigable with real game state. All screens show live data. CPU games watchable.

### Phase 13 — Live Game UI
62. User live game view (score, diamond, PBP, stats, linescore)
63. CPU live game view (same components, different data source)
64. Weather display states (delay screen, radar widget)
65. Box score modal
66. Recap modal

> **Gate:** Both user and CPU games fully watchable with correct state.

### Playoff Screen Spec (LOCKED — Phase 13)

Two-panel bracket view, one panel per division.

**Per-division bracket:**
- Wild Card row: 4th seed vs 5th seed — single game chip
- First Round row: 1st vs WC winner chip + 2nd vs 3rd chip (side by side)
- Division Series row: winner chips collapse to single matchup
- World Series row: division champion chips face each other

Each series chip shows: team names, current series record (e.g. "2-1"), game status (LIVE/FINAL/TBD).
User's team highlighted with accent color.
Tapping a series chip opens that series detail (schedule of games + results).

**World Series row** spans full width below both division panels.

### Offseason Screen Spec (LOCKED — Phase 13)

Shown when `state.phase === PHASE.OFFSEASON`.

**Layout:**
- Day indicator pill at top: "Offseason · Day X of 6"
- Real-time progress bar showing time remaining in current day
- Daily focus label (changes by day: "Season Review" / "Contract Decisions" / "Staff & Trades" / "Development" / "Final Decisions" / "Spring Begins")
- Hard gate status row: 3 icons (Ownership / Contracts / Manager) — green checkmark when cleared, amber lock when pending
- If all gates cleared: "Ready for Spring Training" banner with Start button
- Normal inbox card list below (same as standard inbox)
- On Day 6 with unresolved gates: "Auto-resolving remaining decisions…" banner

### Phase 13 Component Pass — Supporting Components

After all screen modules are built, the following components are built and wired in:

| Component | Wired into | Notes |
|---|---|---|
| `RadarWidget.js` | DashboardScreen (next-game card), GameScreen (live view, delay state) | Section 8.8 LOCKED. Real SVG component — hourly frames, scrubber slider, 3 zoom levels. No placeholder. |
| `LiveDiamond.js` | GameScreen | SVG baserunner diamond, updates on each tick |
| `Linescore.js` | GameScreen, LeagueScreen (CPU games) | Per-inning cells, R/H/E totals |
| `PlayerCard.js` | TeamScreen, LeagueScreen (player tap) | Full player detail modal |
| `CardModal.js` | InboxScreen | Expanded card detail if body overflows |

RadarWidget specifically: when built, wire `_renderRadarWidget(nextGame, state)` into DashboardScreen `_renderNextGameCard()` after the weather emoji line. The TODO comment is already in place in DashboardScreen.js.

### Phase 13.5 — Geographic Region (LOCKED)

Add region selection to SetupScreen as Step 2 (between archetype and naming). Region is abstract — four options with flavor descriptions. Affects weather behavior, facilities card pool, travel fatigue, CPU team name pool, and groundskeeper card pool.

**Schema change:** `state.settings.region: 'north'|'south'|'east'|'west'`

**Four regions:**

| Region | Climate | Key weather behaviors | Facilities flavor | Travel pattern |
|---|---|---|---|---|
| `north` | Cold springs/falls, frost risk | Elevated postponement Apr/Sep, cold-suppressed offense, pitcher stamina reduced in cold | Snow/frost situations in groundskeeper pool, drainage after thaw, heated facilities budget | Dense geography, shorter trips |
| `south` | Hot/humid, warm all season | Afternoon thunderstorm pattern, heat reduces pitcher stamina, elevated scoring, no early/late season cold risk | Heat management, turf stress in summer, irrigation needs | Mid-range trip distances |
| `east` | Moderate, highest rain frequency | Coastal fog possibility, consistent rain risk across season, wind off water | Drainage investment, salt air corrosion over time, older stadium flavor | Densest schedule, frequent short hops |
| `west` | Driest, wind primary factor | Lowest postponement rate, altitude lifts ball carry (slightly elevated scoring), wind cards unique to region | Dry field maintenance, dust/sand issues, water conservation | Longest road trips, meaningful travel fatigue |

**What region does NOT affect:** archetype, roster structure, finances, playoff format, or card system mechanics. Region is atmosphere and modifier, not difficulty.

**New constant:** `REGIONS` object in `data/constants.js` with the four keys and their weather modifier profiles.

**SetupScreen change:** Region selection becomes Step 2. Steps become: Archetype → Region → Naming → Colors → Take the Job. (4 steps total, still no mode selector — Section 2.1.)

**Gate:** Region stored in schema. WeatherEngine reads region modifier when generating buffer. Groundskeeper card pool filtered by region. Travel fatigue modifier applied in SimEngine.

---

### Phase 13.6 — Narrative Engine Infrastructure (LOCKED)

The Narrative Engine is an enrichment layer on the existing card system. It does not create a new card type, a new inbox tab, or a new interaction pattern. Every card still has a meaningful yes/no choice. The narrative depth lives in the card body text — organizational memory, character voice, references to past decisions — not in new UI patterns.

**Architecture:**

```
state.narrativeFlags[]          — append-only log of significant decisions
NarrativeEngine.js              — reads flags, generates enrichment context
CardEngine (delivery)           — calls NarrativeEngine at card delivery time
                                  to select conditional card body variant
```

**`state.narrativeFlags` structure (Option B — flat append-only log):**

```javascript
state.narrativeFlags = [
  // Each entry:
  {
    key:      String,    // e.g. 'extension_declined', 'facility_deferred', 'player_rushed_back'
    subject:  String,    // playerId, staffId, or null for org-level flags
    gameIdx:  Number,    // when it happened
    season:   Number,    // which season
    choice:   String,    // 'yes'|'no'|'auto'|null
    context:  Object,    // optional: { amount, role, reason } — flag-specific metadata
  }
]
```

Query function (in NarrativeEngine):
```javascript
export function getFlags(state, filter)
// filter: { key?, subject?, season?, minGameIdx?, maxGameIdx? }
// returns matching flags sorted by gameIdx descending
```

**Flag taxonomy — every domain that generates flags:**

*Roster decisions:*
- `extension_declined` / `extension_accepted` — subject: playerId
- `player_rushed_back` — IL return before recommended return date
- `player_held_back` — IL return significantly after recommended date
- `veteran_released` — releasing a player with gmRelationship >= 70
- `prospect_called_up` — first call-up of a player from farm
- `trade_accepted` / `trade_declined` — subject: lead playerId
- `waiver_claimed` / `waiver_passed`

*Financial decisions:*
- `budget_conservative` — finished season >15% under payroll cap (count: cumulative)
- `budget_aggressive` — exceeded payroll cap
- `facility_upgrade_approved` / `facility_upgrade_deferred`
- `sponsor_deal_accepted` / `sponsor_deal_declined`
- `ticket_price_raised` / `ticket_price_lowered`

*Staff decisions:*
- `manager_extended_early` / `manager_extended_late` / `manager_contract_lapsed`
- `coach_retained` / `coach_released`
- `staff_request_approved` / `staff_request_declined` — subject: staffId

*Operational decisions:*
- `community_event_approved` / `community_event_declined`
- `maintenance_approved` / `maintenance_deferred`
- `promotional_night_approved` / `promotional_night_declined`
- `media_engagement_high` / `media_engagement_low` — set based on compose frequency

*Compose behavior:*
- `compose_used` — topic: topicId, channel: channelId (tracks engagement pattern)
- Aggregated into GM profile dimensions (see below)

*Outcome flags (set automatically, not by user choice):*
- `player_milestone_hit` — subject: playerId, context: { milestone }
- `playoff_series_won` / `playoff_series_lost`
- `season_record_above_500` / `season_record_below_500`
- `attendance_trend_up` / `attendance_trend_down` — set end-of-season

**GM Profile Dimensions (derived from flags, not stored directly):**

NarrativeEngine computes these on demand from the flags log:

| Dimension | Derived from |
|---|---|
| `spender` vs `conservationist` | budget flags, payroll vs cap ratio |
| `loyal` vs `transactional` | extension_declined count, veteran_released count, trade frequency |
| `aggressive` vs `cautious` | rushed_back count, call-up timing, trade deadline behavior |
| `community_oriented` vs `business_focused` | community/promotional approvals vs declines |
| `hands_on` vs `delegating` | compose frequency and channel distribution |
| `process_driven` vs `results_driven` | correlates with archetype but diverges based on decisions |

These dimensions feed card body variant selection. A `loyal + process_driven` GM receives different language in the same card than a `transactional + results_driven` GM.

**Card body conditional variants:**

Existing cards in `cards-pool.js` will have an optional `variants` array alongside the base `body`:

```javascript
{
  id: 'il_return_act2',
  body: 'Default body text...',
  variants: [
    {
      condition: { flags: [{ key: 'player_rushed_back', subject: '{playerId}' }] },
      body: 'Variant body that references the rushed return...',
    },
    {
      condition: { gmProfile: { loyal: true, season: { min: 2 } } },
      body: 'Variant body for a loyal GM in their second+ season...',
    }
  ]
}
```

NarrativeEngine selects the first matching variant at delivery time. If no variant matches, the base `body` is used. This means all existing cards continue to work unchanged — variants are additive.

**`NarrativeEngine.js` exports:**
```javascript
export function getFlags(state, filter)
export function setFlag(state, flagEntry)         // called by card resolution handlers
export function getGMProfile(state)               // returns derived dimension object
export function selectCardVariant(card, state)    // returns body string for delivery
export function getRelevantFlags(state, card)     // returns flags contextually relevant to a card
```

**Flag instrumentation points (where setFlag is called):**

Every yes/no card resolution in CardEngine checks if the resolved card has a `flagKey` field. If so, it calls `NarrativeEngine.setFlag()`. This means flag instrumentation is centralized in CardEngine's `resolve()` function — no scattered calls across multiple files.

Cards that generate flags have a `flagKey` and optional `flagContext` field in the card pool entry:
```javascript
{
  id: 'contract_extension_veteran',
  flagKey: 'extension_declined',      // set on 'no' resolution
  flagKeyYes: 'extension_accepted',   // set on 'yes' resolution
  flagSubject: '{playerId}',          // resolved at delivery
  // ... rest of card
}
```

Automatic flags (outcome-based, not choice-based) are set by GameEngine after `commitGame()` and by SeasonEngine at season boundary.

**Gate:** NarrativeEngine passes all unit tests. `state.narrativeFlags` correctly populated after card resolutions. `selectCardVariant()` returns correct variant based on flags. CardEngine's `resolve()` calls `setFlag()` where flagKey is present.

---

### Phase 13.7 — Narrative Card Content (LOCKED)

Expand the card pool with narrative-aware variants for all high-impact existing cards, and add new cards that could only exist because of the flag system.

**Existing cards to add variants to (priority order):**
1. All IL return cards (flag: player_rushed_back)
2. Contract extension cards (flag: extension_declined/accepted history)
3. Trade inquiry cards (flag: trade history, GM profile loyalty dimension)
4. Manager relationship cards (flag: manager_extended_early/late/lapsed)
5. Ownership check-in cards (flag: budget_conservative/aggressive, season record)
6. Facility cards (flag: facility_upgrade_deferred history)

**New cards that require the flag system:**
- "Long memory" cards — arrives 10-15 games after a significant decision, references it indirectly through a character voice
- "Reputation" cards — a staff member or player references the GM's established pattern ("You've always given players time to work through slumps...")
- "Consequence" cards — a deferred facility upgrade surfaces as a playing condition issue in a subsequent season
- "Milestone witness" cards — when a player hits a career milestone, the narrative context references their history with the franchise

**Authorship principle:** Card body variants never reference the flag system directly. They speak in character voices. The groundskeeper doesn't say "you deferred the drainage upgrade." He says "the water's been sitting longer than I'd like out near first base. Same issue we talked about last summer." The user feels the world remembering, not the system reporting.

**Gate:** At least 6 existing card types have narrative variants. At least 4 new flag-dependent cards exist in the pool. All variants pass the authorship principle (no direct flag references in card text).

---

### Phase 13.8 — Franchise History Screen (LOCKED)

A browsable record of significant franchise events, organized by season. Called "History" or "Franchise Story" in the UI — never "diary."

**`state.history` structure (append-only array):**
```javascript
state.history = [
  {
    id:       String,     // unique entry ID
    type:     String,     // 'trade'|'injury'|'retirement'|'coaching'|'playoff'|
                          //  'milestone'|'prestige'|'record'|'championship'
    season:   Number,
    gameIdx:  Number,
    headline: String,     // short display label e.g. "Rodriguez traded to Boston"
    detail:   String,     // fuller description
    playerId: String,     // optional — links to player data
    icon:     String,     // emoji for the entry type
  }
]
```

**What gets recorded automatically:**
- Trades (both directions, with context: standings at time of trade)
- Serious injuries (IL stints > 14 games)
- Player retirements
- Coaching hires and fires
- Playoff series results (each round, game-by-game record)
- World Series victory (full summary entry)
- Prestige tier changes
- Franchise Legend unlock
- Season final record and division finish
- Player milestones (first call-up, 100th career game, significant IMP peaks)

**UI:** Accessible from Settings or a dedicated section. Organized by season, collapsible. Each entry shows icon + headline, expandable to detail. User can optionally add a personal note to any entry (short freeform text — stored in `entry.userNote`). Looking back at Season 1 entries from Season 3 is the emotional payoff of this feature.

**Connection to Narrative Engine:** `getFlags()` and `state.history` are both read by NarrativeEngine when selecting card variants. A card delivered in Season 3 can reference a history entry from Season 1 if the conditions match.

**Gate:** History entries created for all listed event types. History screen renders correctly with season grouping. User notes save and persist.

---

### Phase 14 — PWA Shell
67. `manifest.json` — name, icons, theme color, display: standalone
68. Service worker — offline shell, cache strategy for static assets
69. App icons — all required sizes (192, 512, apple-touch-icon)
70. Dynamic favicon — team color applied to favicon canvas at runtime

> **Gate:** App installs to home screen on iOS and Android. Opens as standalone (no browser chrome). Works offline for cached assets.

---

### Phase 15 — Season/Gameplay Polish
71. Full offseason flow (6-day structure, tiered gates) — wire OffseasonEngine fully
72. Playoff bracket and round management — wire PlayoffScreen to SeasonEngine bracket
73. Playoff roster expansion cards
74. Franchise Turning Point and Franchise Legend flows
75. Settings screen (all toggles, theme/color live preview, region display)
76. Debug panel (full catalog from Section 24)

> **Gate:** Full season-to-season transition works. Playoffs complete. Franchise Legend fires. Debug tools operational.

---

### Phase 16 — Reports System

Basic reports free. Full analytical suite premium (Section 1.11b — build all fully, gate in Phase 18).

**Three report types:**

**Roster Report** — all players ranked by OVR, with IMP trend (30-day), age, contract years remaining, salary. Sortable by any column. Shows depth chart gaps. Free tier: OVR + position + age only. Premium: full sortable suite with IMP.

**Financial Report** — payroll by position group, operating budget vs spent, projected next-season payroll (based on expiring vs retained contracts), attendance trend by homestand, revenue vs expenses. Premium only.

**Trade Value Report** — composite score per player based on OVR + age curve + IMP trend + contract value. Identifies surplus value (tradeable) and core assets (untouchable). Premium only. Surfaces automatically when a trade card arrives.

**UI:** Accessible from Team screen as a "Reports" sub-tab alongside Players and Staff.

> **Gate:** Roster report functional and accurate. Financial and trade value reports functional for premium. Reports update correctly after game commits.

---

### Phase 17 — Waiver System
77. User waiver pool view in Players tab
78. Claim interaction with priority display
79. Full player release + dead cap tracking
80. IL return waive option

> **Gate:** User can browse waiver pool, claim players, release players. Priority cycling works correctly.

---

### Phase 18 — Monetization (ui/Premium.js)

> **Prerequisite:** All features must be built and tested in full (premium) mode before this phase begins. Section 1.11b.

**Architecture (single source of truth):**

All premium gating flows through one module: `ui/Premium.js`

```javascript
export function isPremium()
export function requiresPremium(feature)
// Features: 'hotcold_league' | 'weather_7day' | 'radar_full' | 'save_slots_full'
//           | 'reports_full' | 'narrative_depth' | 'history_full'
//           | 'farm_arcs' | 'career_history' | 'scouting_full' | 'watchlist_full'
```

Every feature with a free/premium split calls `isPremium()` or `requiresPremium(feature)`.
No conditional in engine code — engines always run at full capability.
Gating is view-only: hide, blur, or upgrade prompt in the UI layer.

**Free vs Premium splits:**

| Feature | Free | Premium |
|---|---|---|
| Hot/cold indicators | Own roster only | League-wide |
| Weather forecast | 48h (next game) | 7-day rolling (168h) |
| Radar scrubber | Current → +12h | Full 48h range |
| Save slots | 1 slot | Unlimited |
| Reports | Roster (OVR/pos/age only) | Full sortable suite + financial + trade value |
| Narrative card depth | Mechanical cards always delivered | Full narrative variant pool |
| Franchise History | Current season only | Full multi-season history |
| Farm system | OVR + position | Full arc indicators + development notes |
| Career history | Current season stats | Season-by-season breakdown |
| Scouting reports | Basic opponent tendencies | Full breakdown via compose |
| Watchlist | 5 players | Unlimited |

**Phase 18 tasks:**
81. Build `ui/Premium.js` with purchase/unlock flow
82. Add `isPremium: false` to `state.settings` in schema
83. Wire `requiresPremium()` into each feature's UI render — one pass per feature per table above
84. Staff delegation system
85. Ad placement integration (non-blocking, dead time only)

**Pricing model:** One-time purchase recommended. Subscription only if real-world data integration added post-launch.

> **Gate:** Free and premium experiences distinct. No premium feature accessible without unlock. `isPremium()` returns false by default; purchase flow sets `state.settings.isPremium = true` and saves.

---

## 14. Open Design Questions

These must be answered before the relevant phase begins. Adding questions here as they arise.

| # | Question | Phase blocked | Status |
|---|---|---|---|
| 1 | Sub-ratings for players — design and ranges | Phase 2 | ✅ Locked — Section 4.1 |
| 2 | Financial model — payroll vs operating budget vs revenue | Phase 2 | ✅ Locked — Section 4.2 |
| 3 | Multi-team save slots — Model A vs Model B | Phase 1 | ✅ Locked — Model B, Section 4.8 |
| 4 | Difficulty tiers vs archetype system | Phase 2 | ✅ Locked — Archetype system, Section 16 |
| 5 | Trade cash amount formula — $M per rating point differential | Phase 8 | ❓ Open |
| 6 | Trade deadline game index | Phase 4 | ✅ Locked — opens game 88, closes game 92 |
| 7 | Waiver pool — rebuild scope or post-launch? | Phase 10 | ✅ Locked — in scope, Phases 10–12, Section 9.7 |
| 8 | User-initiated trades — rebuild scope or post-launch? | Phase 8 | ✅ Locked — in scope, Phase 8, Section 9.5 |
| 9 | Spring training game count and integration | Phase 4 | ✅ Locked — 20 games, stats tracked, contested spots mechanic, Section 5 |
| 10 | All-Star Break system | Phase 4 | ✅ Locked — Section 17 |
| 11 | Prestige tiers and win condition | Phase 4 | ✅ Locked — Section 18 |
| 12 | Classic mode — keep, retire, or premium? | — | ✅ Locked — retired entirely, Section 2.1 |
| 13 | Where do released/walked players go? | Phase 5 | ✅ Locked — waiver → farm → retirement, Section 20 |
| 37 | User team divisionId stored explicitly in state | Phase 4 complete | ✅ Locked — always Division A, stored as `userTeam.divisionId: 'A'` in schema to avoid hardcoding in standings logic. schema.js updated. |
| 38 | Sim soft metric adjustments | Phase 6 | moraleAdj=(morale-50)*0.001, atmosAdj=(atmosphere-50)*0.0006, weatherAdj per condition. Confirm ranges are gameplay-balanced before Phase 6 SimEngine build. |
| 14 | Do CPU teams poach user's expiring contract players? | Phase 5 | ✅ Locked — yes, gmRelationship-gated, sign-and-trade mechanic, Section 22 |
| 15 | How many offseason decisions are mandatory before spring? | Phase 5 | ✅ Locked — tiered gates, 6-day offseason, Section 23 |
| 16 | Does the farm system feed into offseason promotions? | Phase 5 | ✅ Locked — yes, full farm system with story arcs, Section 20 |
| 17 | Retirement threshold — age/OVR that triggers retirement | Phase 5 | ✅ Locked — Section 20.7 |
| 18 | Ownership evaluation card — win target thresholds per archetype | Phase 5 | ✅ Locked — annual adjustment + tier bumps + archetype floors/ceilings, Section 25 |
| 19 | Initial payrollCap and operatingBudget values per archetype | Phase 2 | ✅ Locked — Section 16.6 |
| 20 | Final archetype names | Phase 2 | ✅ Locked — Section 16.1 |
| 21 | Theme preference — per-slot or global? | Phase 1 | ✅ Locked — per-slot, gameMode field removed |
| 22 | Premium pricing model — one-time vs subscription | Post-launch | ❓ Open |
| 23 | Ad implementation — SDK and confirmed placements | UI phase | ❓ Open |
| 24 | One team per archetype rule | Phase 1 | ✅ Locked — Section 16.3 |
| 25 | Archetype transitions | Phase 5 | ✅ Locked — Section 16.3 |
| 26 | Multiplayer leagues — scope and architecture | Future v3 | ✅ Locked — Section 1.7 |
| 27 | Calendar pacing — daily cadence vs compressed schedule | Phase 4 | ✅ Locked — real-world daily cadence, Section 8.5 |
| 28 | WAR/hot-cold player value calculation — factors and formula | Phase 5 | ✅ Locked — Impact Rating (IMP), Section 30 |
| 29 | Additional stats — which require new tracked fields vs computable | Phase 2 | ✅ Locked — full stat shapes in Section 4.3 |
| 30 | Difficulty preset system | Phase 1 | ✅ Removed — archetypes serve as difficulty selection, Section 1.9 |
| 31 | CPU full schedule — confirmed full 132-game league schedule for all 9 teams | Phase 4 | ✅ Locked — full schedule, Section 28 |
| 32 | Player watchlist size — free vs premium | Phase 9 | ✅ Locked — free: 5, premium: 50 |
| 33 | Stat leaders categories | Phase 9 | ✅ Locked — AVG, HR, RBI, SB, ERA, W, K, SV (8 categories) |
| 34 | Hot/cold visibility — own roster vs league-wide | Phase 9 | ✅ Locked — free: own roster only, premium: league-wide |
| 35 | Feed retention window | Phase 9 | ✅ Locked — 72 hours, then gone |
| 36 | CPU game detail level — PBP, diamond, box score | Phase 4 | ✅ Locked — full detail, same pipeline as user game, Section 28 |
| 39 | Playoff bracket structure and seeding | Phase 6 pre-build | ✅ Locked — Section 26.1. All 5 per division qualify. 1/3/5/7 game progression. Division-contained. Head-to-head tiebreaker. |

## 20. Player Lifecycle & Farm System (LOCKED)

### 20.1 The Three-Tier Player Lifecycle

Every player in the game exists in exactly one of three tiers at any time. Tier assignment is a property of the player object, not a separate list.

```
TIER 1 — Active Roster
  ↓ (cut, not re-signed, or optioned down)
TIER 2 — Waiver Wire (72-hour window)
  ↓ (claimed by a team)        ↓ (clears waivers unclaimed)
TIER 1 (new team)           TIER 3 — Farm System
                                ↓ (called up)
                            TIER 1 (return to roster)
                                ↓ (age/OVR threshold met, not claimed for 1 offseason)
                            RETIRED
```

Player tier is stored as `player.tier: 'active' | 'waivers' | 'farm' | 'retired'`.
Team ownership stored as `player.teamId` — always points to the team that controls the player's rights, even when on waivers or the farm.

### 20.2 Waiver Wire System (LOCKED)

#### Priority Order

Waiver priority is dynamic, not static. It resets at the start of each season and shifts throughout the season as claims are used.

**Season start:** Priority set by inverse final standings from the prior season. Worst record = highest priority (1st claim). Best record = lowest priority. First season: inverse of archetype-based starting strength.

**Priority cycling (LOCKED):**
- When a team uses a waiver claim: that team immediately drops to lowest priority (position 10)
- All teams below the claiming team shift up one position
- A team that claims early in the season burns their priority for the rest of the season

This means teams face a genuine strategic decision: use priority now for a good player, or hold it for something better later. CPU teams evaluate this based on roster need urgency and player rating.

**User priority visibility:** The user's current waiver priority position is always visible in the Players tab waiver view — *"Your current waiver priority: 4th of 10."* This is actionable information: placing a player on waivers when you're 1st priority means you're likely to lose them; placing them when you're 9th means other teams probably won't claim.

#### Waiver Process

1. Player is placed on waivers — `player.tier = 'waivers'`, `player.onWaivers = true`, `player.waiverStartTime` set (Unix ms)
2. 72-hour real-world claim window opens
3. CPU teams evaluate: does this player address a positional weakness? Is the OVR upgrade worthwhile? Is this team's priority high enough to beat competing claimants?
4. Highest-priority claiming team wins the player
5. Claiming team must immediately drop a player to maintain roster size — that dropped player enters waivers
6. Claiming team's priority drops to last
7. If unclaimed after 72 hours: player optioned to the placing team's farm system

#### CPU Team Waiver Logic

CPU teams claim waived players based on three factors:
- **Positional need:** Does the player fill a genuine gap (injured starter, expiring contract at that position)?
- **Rating threshold:** Is the player's OVR at least equal to the weakest player at that position on their roster?
- **Priority feasibility:** Would using this claim burn priority that might be needed for a more urgent need?

CPU teams do not claim players they don't need. This keeps the waiver wire realistic — a poor backup catcher doesn't get claimed by a team with three healthy catchers.

### 20.3 Farm System (LOCKED)

#### Full Player Registry

All 10 teams — user and CPU — maintain persistent farm systems. Every farm player is a full player object in `state.players` with a UUID, stats, sub-ratings, contract, and story arc. There is no "generated on demand" farm player — every callup draws from a persistent, known object.

This enables the emergent gameplay of learning CPU team depth patterns: a user who pays attention over multiple seasons learns that the New York Empire almost always calls up the same RF prospect when their starting RF is injured. That's real strategic intelligence earned through observation.

#### Farm Roster Composition Caps (LOCKED)

Fixed composition caps — separate hitter and pitcher limits, not a single total:

```javascript
export const FARM_HITTER_MAX = 12;
export const FARM_PITCHER_MAX = 8;
export const FARM_HITTER_MIN_POSITIONS = ['C', 'CI', 'MI', 'OF']; // min 1 each
export const FARM_PITCHER_MIN_SP = 2;
export const FARM_PITCHER_MIN_RP = 2;
```

Total farm capacity: 20 players per team.

**Overflow displacement rule (LOCKED):**
When an incoming player would exceed the cap for their group:
1. Check which position is most overstocked (most players relative to minimum coverage)
2. The lowest OVR player at that position is the displacement candidate
3. If displacement would violate minimum position coverage, skip and find the next-lowest at a non-critical position
4. Displaced player goes to **waivers** — not retirement. Other teams can claim them.
5. If displaced player clears waivers unclaimed → free agency → retirement eligibility

This ensures the farm never loses its last catcher or last SP to make room for a fifth OF prospect.

#### User Farm System UI

Located on the Roster screen as a collapsible section below Pending Transactions:

```
Roster Screen sections:
├── Hitters               (collapsible)
├── Pitchers              (collapsible)
├── Injured List          (collapsible)
├── Pending Transactions  (collapsible)
└── Farm System           (collapsible)
    ├── Position Players — 12 max, sorted by position group then OVR
    └── Pitchers — 8 max, sorted by role then OVR
```

**Farm player row displays:**
- Name, position, OVR badge, age, trait indicator
- Send-down date
- Story arc indicator: ↑ motivation, ↓ decline, — stable
- Brief context note: *"Optioned Apr 14 — performing well"*

Tapping opens full player card — same modal as active roster players.

**CPU farm systems:** Not browsable by the user. CPU farm players surface when called up — their profile shows farm origin. The user cannot browse CPU farm rosters directly.

### 20.4 Farm System Story Arcs (LOCKED)

A player sent to the farm isn't just a stat entry — they have an ongoing story. Arc is determined at send-down time based on trait, age, and a random element, and plays out over subsequent games.

#### Motivation Arc (responds well)
- **Triggered by:** veteran trait, consistent trait, younger players (22–25), or random chance (~45% baseline)
- **Sub-rating effect:** Small upward drift during farm time (+0.5 to +1.5 per sub-rating per month on farm, up to +3 max before callup)
- **Card generated at callup threshold:** *"Davis has been outstanding at Triple-A — his contact numbers are the best they've been in years. He's ready."* Callup card presents genuine decision: promote now and displace someone, or let him keep developing?
- **Morale effect on callup:** +2 morale on active roster when a motivation-arc player returns

#### Decline Arc (responds poorly)
- **Triggered by:** volatile trait, older players (30+), high-rated players (75+) sent down (pride injury), or random chance (~25% baseline)
- **Sub-rating effect:** Small downward drift (-0.5 to -1.5 per sub-rating per month, down to -4 max)
- **Card generated:** *"Word from the farm is that Miller hasn't been himself since the send-down. He's asking questions about his future with the organization."* Options: call up early (disrupts roster but stops decline), talk to him (managerConfidence decision), or let it play out
- **Extended decline risk:** If decline arc player stays in farm more than 60 real days, they may request release — generating a card with a deadline

#### Stable Arc (neither improves nor declines)
- **Triggered by:** ~30% baseline for any player not otherwise triggered
- **Sub-rating effect:** No change
- **Card generated:** Simple callup-ready notification when needed, no narrative weight

#### Arc Modifiers
- `youngGun` trait: motivation arc probability +20%, decline arc probability -10%
- `volatile` trait: decline arc probability +25%, variance on sub-rating changes increased
- `clubhouseLeader` trait: always stable arc (veterans accept organizational decisions gracefully)
- Age 28+: decline arc probability +10% per year above 28

### 20.5 Callup Mechanics

When a farm player is called up to the active roster:

1. A callup card fires in the inbox — presenting the decision to promote and who gets displaced
2. User confirms the promotion — depth check identifies the displaced player
3. Displaced player goes to farm (or waivers if farm is full)
4. Farm player's story arc status clears on callup — they start fresh on the active roster
5. Sub-rating changes from the farm arc are permanent — a player who developed on the farm keeps those gains

**Auto-callup for depth emergencies:** If a Type 2 roster integrity failure exists (a starter slot uncovered) and the user doesn't act within 4 hours of the next game, `RosterEngine.autoResolveDepth()` promotes the highest-OVR eligible farm player automatically. A notification fires immediately when the auto-callup occurs.

### 20.6 End-of-Season Farm Processing

During the season transition (Step 4 — development/decline), farm players receive the same sub-rating aging treatment as active roster players. Additionally:

- Farm players on decline arc for a full season may retire if OVR drops below threshold (feeds OQ-17)
- Farm players on motivation arc for a full season may receive a contract upgrade offer (generates offseason card)
- Farm roster spots freed by retirements or promotions may be filled by newly generated prospects (keeping farm depth meaningful across seasons)

### 20.7 Player Retirement (LOCKED — resolves OQ-17)

A player retires when both conditions are met:
- Age ≥ 35 AND OVR < 55, OR
- Age ≥ 38 (regardless of OVR — physical decline assumed), OR
- Farm system decline arc completes with OVR < 50

**Retirement triggers:**
- End-of-season processing: players meeting the threshold retire silently (no card) unless they were on the user's active roster or farm in the past 2 seasons
- If they were recently connected to the user: a brief retirement notification card fires (*"Former [Team] player {name} has announced his retirement."*)
- Veterans (trait: `veteran`) get one additional season grace period before the age/OVR check applies — veterans fight to stay on the field

**Retirement in the player registry:** `player.tier = 'retired'`, `player.retiredAt = seasonNum`. Retired players remain in the registry permanently for franchise history — career stats preserved, visible in franchise records.

Constants:
```javascript
export const RETIREMENT_AGE_HARD = 38;
export const RETIREMENT_AGE_SOFT = 35;
export const RETIREMENT_OVR_SOFT = 55;
export const RETIREMENT_OVR_FARM = 50;
```

---

## 22. Player-GM Relationship System (LOCKED)

### 22.1 Overview

Each player has a `gmRelationship` score (0–100) representing their personal trust in and satisfaction with the GM — distinct from team morale, distinct from their trait, and persistent across seasons.

| Metric | What it measures | Scope | Changes from |
|---|---|---|---|
| `morale` | Team-wide emotional state | Whole roster | Win/loss streaks, broad decisions |
| `atmosphere` | Organizational energy | Organization | Facility, performance, events |
| `player.gmRelationship` | Individual player's trust in the GM | One player | Decisions that specifically affect that player |

A team can have 72 morale while a franchise cornerstone has a 35 gmRelationship because the GM declined to extend his contract. These metrics coexist independently.

### 22.2 Starting Values

- New players (generated at game start): 50
- Acquired players (trade, waiver, free agency): 50
- Re-acquired players (previously in the org and traded away): 45 — partial reset, history acknowledged
- Re-acquired players show `_previouslyWithOrg: true` on their player card: *"Previously with the organization"*

### 22.3 Relationship Effects — Positive

| Decision | gmRelationship effect | Who it affects |
|---|---|---|
| Named clubhouse leader | +8 | That player |
| Contract extension offered before player requests it | +6 | That player |
| Farm callup after motivation arc earned it | +5 | That player |
| Defended player publicly in a media card | +5 | That player |
| Accepted trade specifically recommended by manager | +3 | Incoming player |
| Approved player-specific training program | +4 | That player |
| Chose player's preferred rest schedule when offered | +3 | That player |
| Team wins a championship | +5 | All players on roster |

### 22.4 Relationship Effects — Negative

| Decision | gmRelationship effect | Who it affects |
|---|---|---|
| Declined contract extension player requested | -8 | That player |
| Passed over veteran for clubhouse leader | -6 | Passed-over player |
| Sent player down to farm | -5 to -10 (arc-dependent) | That player |
| Traded away player's close teammate | -3 | Remaining player |
| Chose cost over player in contract negotiation | -6 | That player |
| Ignored player's personal leave request | -10 | That player |
| IL placement when player wanted to play through | -5 | That player |
| Ignored a player-specific card for 3+ games (expired) | -2 | That player |

### 22.5 How gmRelationship Feeds Into Other Systems

**CPU poaching (OQ-14 — LOCKED):**
A player with gmRelationship below 60 is eligible to be targeted by CPU teams in the offseason. Three conditions must all be true for a poaching card to fire:
1. The player fills a genuine positional need for that CPU team
2. The player's OVR meets that team's acquisition threshold
3. The player's gmRelationship is below 60

A player at 60+ gmRelationship is simply not contacted by other teams — loyalty built through good decisions actively protects the roster.

When all three conditions are met, a poaching card fires from the competing GM. Decision:
- **Re-sign him** — pay market rate (lower gmRelationship = higher market demand), poaching disappears
- **Accept the sign-and-trade** — get a return package; quality weighted by your relationship with that CPU team's GM
- **Let it play out** — risk free agency with no return, but preserve payroll flexibility

Card fires before the user has seen the re-sign offer — decision made under genuine uncertainty. Sign-and-trade package quality: strong CPU GM relationship = fair package. Weak relationship = low-ball offer.

**Contract negotiations:**
- gmRelationship below 40: player demands a premium above market rate — relationship damage has a dollar cost
- gmRelationship above 70: player accepts a slight discount to stay — loyalty has a financial reward
- This makes relationship management a financial strategy, not just a soft metric

**Sim engine performance variance:**
- gmRelationship below 30: increased outcome variance on that player's contributions — slightly more likely to underperform on any given game. Small effect, not dramatic.
- gmRelationship above 80: small consistency bonus — this player shows up reliably

**Clubhouse disruption cards:**
A player with gmRelationship below 30 AND volatile trait is a disruption risk. Specific cards fire when this combination is present: *"Sources say Miller has been vocal in the clubhouse about the front office's decisions."* Decision: address it directly (managerConfidence cost, relationship recovery possible) or ignore it (morale risk).

**Trade value signals:**
When evaluating CPU-initiated trades, player gmRelationship colors the value note qualitatively — not as a number, but as a signal. High relationship: *"He's been a reliable presence and clearly values his time here."* Low relationship: *"He's been productive but a change of scenery might benefit both sides."*

**Trade card — audit flag:**
Every card in `cards-pool.js` that specifically names and affects a player needs a `_playerRelationshipEffect` field in its `yesEffect` and `noEffect` objects. This is a **Phase 9 task** (CardEngine build) — every card's effects are reviewed for player-specific relationship impact at that time. The card schema supports this field from day one.

**gmRelationship decay (Phase 6+ task — LOCKED):**
Without active maintenance, gmRelationship drifts toward 50 at ~-1 per 10 games for extreme values (>70 or <30). Implementation: add to `GameEngine.commitGame()` sequence after Step 11 (metric history snapshot). Not yet implemented — add in Phase 6 when SimEngine drives per-player outcomes.

**gmRelationship → sim variance (Phase 6 task — LOCKED):**
- gmRelationship < 30: increased outcome variance on that player's contributions (more volatile stat lines)
- gmRelationship > 80: small consistency bonus (player shows up reliably)
- SimEngine must accept gmRelationship as an input parameter for each player's at-bat/pitch resolution. Design this into SimEngine from the start — do not patch in later.

### 22.6 gmRelationship Visibility

The GM never sees a raw score — that would feel gamey. Instead they see qualitative signals:
- Player card shows a relationship indicator using descriptive language: *"Loyal"* (70+), *"Content"* (50–69), *"Unsettled"* (30–49), *"Disgruntled"* (below 30)
- Player card shows a small icon reflecting the category, not a number
- Cards and compose channel prompts reference the relationship qualitatively in their body text
- The score itself is internal to the engine

### 22.7 Relationship Decay

Without active maintenance, gmRelationship drifts slowly toward 50 over time — extreme values (very high or very low) decay toward neutral at a rate of approximately -1 per 10 games. This prevents relationship scores from being permanently toxic or permanently maxed out without any decisions being made. Active decisions are required to keep a player's relationship high.

---

### 21.1 Injuries Are Not User-Only

Injuries happen to players on all 10 teams using the same probability model. In v1, injuries only fired against the user's roster because the injury system was wired into the card engine. This made CPU teams feel invincible and the league artificial.

In the rebuild: `InjuryEngine` runs on every team's active roster during the daily simulation tick — not just the user's. CPU team injuries are silent (no inbox card for the user), but they update the player registry and affect CPU team OVR and lineup decisions.

**Parity rule:** CPU teams experience injuries at the same statistical frequency as the user's team. Same constants, same probability tables. No hidden invincibility.

### 21.2 CPU Team Injury Processing

When a CPU player is injured:
1. `player.isInjured = true`, `player.ilReturnDate` set
2. CPU team automatically calls up the highest-OVR eligible farm player at that position
3. CPU team OVR recalculated — opponent rating in the sim engine reflects the injury
4. Player becomes visible as injured in the League screen (see 21.3)

A user who notices the league's best SP is out for 3 weeks might exploit that window at the trade deadline. That's real GM strategy enabled by this system.

### 21.3 League Injury Visibility (LOCKED)

On the League screen, injured CPU players show a small **💬 icon** next to their name. Tapping generates a brief inline injury report. Information quality scales with GM relationship:

| Relationship with that team | Information shown |
|---|---|
| Below 40 | *"The organization is not commenting on player availability."* |
| 40–60 | *"Upper body injury. Day-to-day."* |
| 61–80 | *"Hamstring strain. Estimated 2–3 weeks."* |
| 81–100 | *"Grade 1 hamstring strain. Targeting return in 10–14 days. No structural concern."* |

**Report timestamp:** Reports older than 5 days show a stale indicator — *"(Report from 6 days ago — status may have changed)"*. Information freshness is part of the mechanic.

**Implementation:** Injury report text is pre-generated at injury time and stored on the player object as `player.injuryReport: { vagueText, detailedText, generatedAt }`. The League screen applies the relationship filter at display time. No card fires — this is a passive information layer the user pulls, not pushed at them.

### 21.4 Multiplayer Forward-Compatibility Note

In the multiplayer context (future v3), this system applies in reverse — other GMs can tap your injured players and see reports filtered by their relationship score with you. Designed now so nothing prevents this later.

---

## 23. Offseason Structure (LOCKED)

### 23.1 Duration

The offseason lasts exactly **6 calendar days** — long enough to feel meaningful, short enough to not be a nuisance. Each day has a primary focus, giving the offseason a structured arc that the notification system supports.

| Day | Primary focus | Card pools active |
|---|---|---|
| 1 | Season summary. Ownership evaluation card fires. | SEASON_SUMMARY, OFFSEASON |
| 2 | Expiring player contracts. CPU poaching cards can fire. | OFFSEASON |
| 3 | Manager and coaching staff renewals. Trade cards active. | OFFSEASON, MANAGER_CONTRACT, COACHING_CONTRACT |
| 4 | Facility and groundskeeper offseason cards. Farm development. Free agency signings. | OFFSEASON |
| 5 | Final reminder day — unresolved hard gates get urgent notification. Soft gates begin auto-resolving. | OFFSEASON |
| 6 | Spring training begins at end of day. Hard gate auto-resolve with penalty fires for anything still unresolved. | SPRING_TRAINING |

### 23.2 Decision Tiers (LOCKED)

**Hard gates — spring cannot begin without these resolving:**
- Ownership evaluation card (sets financial parameters for new season)
- All expiring player contracts on active roster (re-sign, sign-and-trade, or let walk)
- Manager contract (you need a manager to run spring training)

Auto-resolve behavior if hard gate reaches Day 6 unresolved: resolves on conservative path with penalty. Notification fires: *"Ownership made a decision in the absence of your response."* Small consequence — not catastrophic, but meaningful.

**Soft gates — auto-resolve after timer if ignored:**
- Coaching staff renewals → auto-renew at same salary after 4 days if unresolved
- CPU poaching cards → auto-resolve to "let it play out" after 4 days
- Free agency signing cards → auto-decline after 3 days

**Non-gated — available but never blocking:**
- Facility and groundskeeper offseason cards (carry to spring if unresolved)
- Farm system management cards
- Scouting and development cards
- Trade cards (come and go throughout offseason)
- Community and media cards

### 23.3 Offseason Notification Cadence

The notification system supports the offseason arc with one daily summary push rather than individual card notifications — except for hard gates on Day 5, which fire individual urgent notifications. This prevents notification fatigue during a 6-day window where multiple cards arrive daily.

---

## 24. Debug Tools (LOCKED)

### 24.1 Purpose

The debug panel enables testing of any game phase or transition without playing through a full season. Essential for testing the offseason transition, playoff flow, weather events, and multi-season mechanics. Built as a proper tool, not an afterthought.

### 24.2 Access

Debug mode is never visible in production. Access via one of:
- URL parameter: `?debug=true` (development only)
- Hidden tap sequence: tap version badge in Settings 5 times (same UX as iOS developer mode)

All debug actions are logged to an in-panel console showing exact state changes made.

### 24.3 Debug Tool Catalog

| Tool | What it does |
|---|---|
| **Jump to game N** | Advances to any schedule index, simulating all prior games with randomized results |
| **Jump to trade deadline** | Advances to game 88, simulates prior games |
| **Jump to All-Star Break** | Advances to game 66, triggers All-Star hosting check |
| **Jump to season end** | Simulates all remaining games, sets final record, advances to SEASON_SUMMARY |
| **Jump to offseason** | Enters OFFSEASON phase with configurable win total (input field) |
| **Jump to spring training** | Completes all offseason gates on default paths, enters SPRING_TRAINING |
| **Set season number** | Jump to any season number for multi-season mechanic testing |
| **Trigger specific card** | Dropdown of all card definition IDs — delivers that card immediately to inbox |
| **Trigger weather event** | Force DELAYED, POSTPONED, or SUSPENDED on next scheduled game |
| **Force injury** | Injure a specific player with configurable severity and return timeline |
| **Set metric value** | Input fields for morale, atmosphere, ownerTrust, managerConfidence |
| **Set player gmRelationship** | Set a specific player's relationship score for testing poaching and contract cards |
| **Force farm arc** | Set a specific farm player's arc to motivation, decline, or stable |
| **Set waiver priority** | Set user's waiver priority position |
| **Set prestige score** | Set cumulative prestige score for testing tier advancement cards |
| **Trigger Franchise Turning Point** | Forces the Ember/Lab turning point card |
| **Trigger Franchise Legend** | Forces the Dynasty win condition card |
| **Reset weather buffer** | Force regeneration of the weather time series |
| **Set hosting score** | Set the All-Star hosting score to any value |
| **Simulate CPU injuries** | Force a round of league-wide injury processing |

### 24.4 Testing Expectations for v2

The planned architecture significantly reduces the testing burden compared to v1:

**Will not need extensive testing (architectural fixes):**
- Trade cash direction — locked formula in constants, always correct
- Boxscore sync — pre-computed fields, single source of truth
- Card timing — phase flags and context object enforce eligibility
- Push notifications on Android — proper VAPID architecture, no setTimeout

**Will still require real-world testing:**
- Card token resolution — every card produces readable, grammatically correct text
- Roster depth edge cases — last catcher to IL with no farm catcher, etc.
- Push notification delivery on a real Android device
- Full offseason transition (2–3 times, different archetypes) — use debug jump tools
- Weather event flows end-to-end — delay, postponement, suspended game, makeup

**Honest estimate:** v2 testing will require approximately 30% of the effort v1 required. The remaining testing is the interesting kind — does the game feel right? — rather than the frustrating kind — why is this broken again?

---
|---|---|---|
| Push notifications silently fail on Android | `setTimeout` in SW — killed by OS | Cloudflare Worker cron + VAPID Web Push (Section 12) |
| Trade cash going wrong direction | Cash direction computed inconsistently, no single rule | Locked formula in TradeEngine (Section 9.1) |
| Trade card body text inconsistent with cash direction | Token resolved before direction known | `{trade_cash_note}` token resolved last, after direction computed |
| Live boxscore not updating mid-inning | PBP reveal logic and linescore were reading different fields | Pre-computed `cumOurScore`/`cumTheirScore` on every play; linescore reads same fields as PBP |
| Injured players re-promoted by depth checks | `_ensureDepth` didn't exclude `_pendingDeparture` | RosterEngine depth checks explicitly exclude `_pendingDeparture` and `isInjured` |
| Incoming traded player placed before game commit | Deferral check ran after roster push | Deferral check runs BEFORE roster push in RosterEngine |
| Injury cards didn't fit live mode | Cards written before live mode existed | Two-act injury model (Section 11) separates in-game and post-game cards cleanly |
| Coach card collision around line 525 in cards-pool.js | Manual editing of 19,000-line file — closing brace missing | Fixed in Phase 0 when export is added; module structure prevents this class of error |
| Weather delay card fired but live game kept running | Weather was a card event, not a game state — two separate systems with no shared state | Weather is a first-class `game.status` — all systems read the same state (Section 8.8) |
| League team `str` not reflected in opponent rating lookup | `_getOpponentRating` used hardcoded values in some paths | All opponent ratings computed from `leagueTeams[].str` via single utility function |

---

*Document last updated: Planning session — OQ-15 locked (6-day offseason, tiered gates), expanded debug tools catalog, testing expectations documented*
*Next: OQ-18 — Ownership win target escalation across seasons (final substantive open question)*

---

## 16. GM Archetype System

> Status: LOCKED — names, profiles, parameters, and persistence rules all confirmed.

Replaces the concept of "difficulty tiers." The archetype is chosen at game creation and defines the franchise context the user inherits. It is an in-world concept — not a meta-game difficulty setting. Ownership hired you to execute a specific mandate. That mandate shapes everything.

### 16.1 The Six Archetypes (LOCKED)

| ID | Name | One-line premise |
|---|---|---|
| `ember` | **The Ember** | A once-great franchise, cold now. You're the rebuild. |
| `contender` | **The Contender** | A good team that hasn't broken through. Playoff expectations. |
| `empire` | **The Empire** | A dynasty in progress. Championship or bust. |
| `gambler` | **The Gambler** | A volatile franchise. Boom-or-bust everything. |
| `lab` | **The Lab** | Analytics-forward. Process over results, for now. |
| `institution` | **The Institution** | Old-school, veteran-heavy, deeply traditional. |

#### The Ember
*A once-great franchise, cold now. Long-suffering fans. You're the rebuild.*
- Roster profile: younger players, wide OVR spread (some gems, some liabilities), affordable contracts
- PayrollCap: low — ownership is cutting costs while rebuilding
- OperatingBudget: minimal — no room for expensive fixes
- Ownership patience: high — they hired you to rebuild, they know it takes time
- Win target: modest (season 1: ~68 wins)
- Starting morale: low-medium
- Starting atmosphere: low
- GM relationships: neutral across the board — new face, no history
- Card weighting: development cards, scouting cards, culture cards weighted higher; trade deadline pressure lower
- Sim tendency: more variance — this roster can surprise or collapse

#### The Contender
*A good team that hasn't broken through. Solid core, playoff expectations.*
- Roster profile: mid-to-high OVR, mix of veterans and mid-career players, some expensive contracts
- PayrollCap: mid-high
- OperatingBudget: comfortable
- Ownership patience: medium — two seasons to make a run, then questions get asked
- Win target: high (season 1: ~88 wins, playoff berth expected)
- Starting morale: medium-high
- Starting atmosphere: medium-high
- GM relationships: mixed — some good relationships from prior trades, one friction point
- Card weighting: trade cards weighted higher near deadline; ownership pressure cards active

#### The Empire
*A dynasty in progress. Championship or bust.*
- Roster profile: high OVR across the board, veteran-heavy, expensive long-term contracts
- PayrollCap: high — ownership will spend to win
- OperatingBudget: generous
- Ownership patience: low — they're paying for championships, not rebuilds
- Win target: very high (season 1: ~95 wins, deep playoff run expected)
- Starting morale: high
- Starting atmosphere: high
- GM relationships: mostly strong — established franchise, known quantity
- Card weighting: ownership pressure cards frequent; high-profile signing cards; legacy/prestige cards
- Risk: contract flexibility is limited — you're locked into expensive veterans

#### The Gambler
*A volatile franchise. Boom-or-bust everything.*
- Roster profile: uneven — some elite players, notable weaknesses, aggressive contract structure
- PayrollCap: mid — owner will bend rules but isn't unlimited
- OperatingBudget: medium, but owner will approve bold moves
- Ownership patience: unpredictable — loves a big swing, hates mediocrity
- Win target: variable — owner reacts to narrative, not just wins
- Starting morale: volatile baseline
- Starting atmosphere: medium with high variance
- GM relationships: some very strong, some actively hostile — this team has made enemies
- Card weighting: bold trade cards, high-risk/high-reward decisions, volatile player cards
- Sim tendency: high variance outcomes — this team wins big or loses ugly

#### The Lab
*An analytics-forward organization. Process over results, for now.*
- Roster profile: efficiently constructed — mid-OVR but excellent sub-rating profiles (high contact, high control), affordable contracts, younger skew
- PayrollCap: mid — ownership values efficiency over spending
- OperatingBudget: medium, biased toward development spend
- Ownership patience: high — they believe in the model
- Win target: modest early, escalating (season 1: ~78 wins; they're building)
- Starting morale: medium
- Starting atmosphere: low-medium (fans are skeptical of the approach)
- GM relationships: neutral to slightly cold — traditional GMs distrust analytics shops
- Card weighting: scouting cards, training/development cards, innovative lineup cards; fewer emotional/culture cards
- Unique mechanic: development cards have higher upside — The Lab's players develop faster

#### The Institution
*Old-school, veteran-heavy, deeply traditional.*
- Roster profile: veteran-skewed, reliable OVR, slower development ceiling, loyal long-termers
- PayrollCap: mid-high — respects paying veterans fairly
- OperatingBudget: medium
- Ownership patience: medium — values stability and reputation as much as wins
- Win target: consistent (season 1: ~82 wins; they want steady excellence)
- Starting morale: high — veterans run a tight clubhouse
- Starting atmosphere: high — deep fanbase, loyal
- GM relationships: strong with traditional teams, cold with analytics teams
- Card weighting: culture cards, veteran leadership cards, coaching staff cards; trade cards are conservative (they don't trade veterans lightly)
- Unique mechanic: veteran trait bonuses amplified; young players take longer to develop (culture is set in its ways)

### 16.2 Archetype at Game Creation

The game creation flow presents the six archetypes with:
- A one-sentence premise (as above)
- Three at-a-glance indicators: Roster Strength / Ownership Patience / Financial Room
- No sliders — the archetype IS the configuration

After selecting an archetype, the user customizes:
- GM name
- Team city and nickname
- Team icon (emoji picker)
- Primary and secondary team colors (COLOR_PALETTE pickers)

Note: Game mode selection is not present — classic mode is retired (Section 2.1). Always live mode.

The archetype pre-fills all financial and roster parameters. The user never sees raw numbers at setup — they see the story.

### 16.3 Archetype Persistence (LOCKED)

The archetype is set at game creation and never changes — it is the founding identity of the franchise. What changes across seasons is the *result* of playing well or badly: financial parameters shift via the ownership evaluation card, prestige tier evolves, card weights adjust. The identity stays constant; the circumstances change around it.

**One team per archetype (LOCKED):**
- A user cannot have two save slots with the same archetype
- Free tier: 1 save slot (any archetype)
- Premium tier: up to 6 save slots — one per archetype maximum
- The slot picker enforces this at creation — already-used archetypes are shown but not selectable
- This makes each archetype feel like a distinct franchise identity, not a setting

**The Franchise Turning Point (LOCKED):**
A single special transition event available once per franchise lifetime. Fires only for Ember and Lab archetypes that achieve something extraordinary — winning a championship or reaching the highest prestige tier. Presented as an ownership card:

*"What you've built here is no longer a rebuild. The organization has changed. Ownership is ready to invest accordingly."*

The user chooses: accept the transition (new financial parameters matching Contender tier, higher expectations going forward) or decline (stay the course, keep patient ownership and lower pressure). This is a meaningful decision — some players will decline to preserve the low-pressure environment. The archetype label does not change, but the parameters shift permanently. This event can only fire once.

No other archetype transitions exist. A Contender does not become an Empire through good play — that would require a different ownership situation, which is out of scope for the single-player game. The Turning Point is the one exception because it represents something genuinely rare and earned.

### 16.5 Archetype and the Card System

The archetype biases which cards are weighted higher in the draw pool each game. It does not block cards — any card can appear for any archetype — but frequency shifts meaningfully. An Empire player sees more championship pressure cards. An Ember player sees more development opportunity cards. This makes each archetype feel tonally distinct throughout the season.

---

### 16.6 Archetype Parameter Table (LOCKED)

Concrete initial values used to initialize the state object at game creation.

**Financial scale (LOCKED):** All monetary values stored in **$K (thousands)**.
Display formatter `formatMoney(amountK)` in `ui/formatters.js` handles contextual display:
- Under $1,000K → `$XXK` (e.g. `$350K`)
- $1,000K and over → `$X.XM` (e.g. `$1.2M`, `$35M`)

This ensures `$350K` never displays as `$0.35M` and `$85,000K` never appears.
Player salaries, payroll caps, operating budgets, and card costs all use $K internally.

| Parameter | Ember | Contender | Empire | Gambler | Lab | Institution |
|---|---|---|---|---|---|---|
| **Roster** | | | | | | |
| Starter OVR range | 52–72 | 62–80 | 72–90 | 55–88 | 58–76 | 65–82 |
| Avg roster OVR | ~62 | ~72 | ~82 | ~68† | ~67 | ~74 |
| Age skew | Young (22–27) | Mixed (24–32) | Veteran (28–35) | Mixed (23–34) | Young-mid (22–29) | Veteran (27–34) |
| Contract length skew | Short (1–2yr) | Mixed (1–3yr) | Long (2–4yr) | Aggressive (1–4yr) | Short-mid (1–2yr) | Mid (2–3yr) |
| **Finances** | | | | | | |
| PayrollCap | $85M | $120M | $160M | $110M | $95M | $125M |
| Starting payroll | ~$6M | ~$18M | ~$30M | ~$12M | ~$9M | ~$15M |
| Payroll cap | $8M | $22M | $35M | $16M | $12M | $18M |
| Operating budget | $500K | $1.5M | $2.5M | $1.25M | $750K | $1M |
| OperatingBudget | $8M | $18M | $28M | $15M | $12M | $16M |
| **Ownership** | | | | | | |
| OwnerTrust start | 65 | 60 | 55 | 50 | 70 | 60 |
| Season 1 win target | 68 | 88 | 95 | 72–88* | 78 | 82 |
| Patience rating | High | Medium | Low | Erratic | High | Medium |
| **Soft Metrics** | | | | | | |
| Starting morale | 52 | 65 | 78 | 45–70‡ | 58 | 72 |
| Starting atmosphere | 40 | 68 | 82 | 55 | 45 | 75 |
| ManagerConfidence | 60 | 65 | 70 | 55 | 62 | 68 |
| **GM Relationships** | | | | | | |
| Default all teams | 50 | 50 | 50 | 50 | 50 | 50 |
| Adjustments | None | +15 one, −10 one | +20 two teams | +25 one, −20 two | −10 three teams§ | +15 two, −15 two |
| **Card Weights** | | | | | | |
| Development cards | +40% | baseline | −20% | baseline | +60% | −10% |
| Scouting cards | +30% | baseline | baseline | +10% | +50% | baseline |
| Trade cards | baseline | +20% | +30% | +40% | baseline | −20% |
| Ownership pressure | −30% | +20% | +50% | erratic¶ | −20% | baseline |
| Culture/morale cards | +20% | baseline | baseline | +30% | −20% | +30% |
| **Sim** | | | | | | |
| Outcome variance | High | Medium | Low | Very high | Medium | Low-medium |
| Turning Point eligible | Yes | No | No | No | Yes | No |

*Gambler win target randomized between 72–88 at season start — owner reacts to narrative, not a fixed number.
†Gambler OVR has high spread — some elite players, some well-below-average.
‡Gambler starting morale randomized within range at game creation.
§Lab relationship penalty: three traditional GM teams start skeptical of the analytics approach.
¶Gambler ownership pressure cards fire on a weighted-random schedule regardless of performance.

**Starting payroll vs cap — intentional gap:**
- Ember: ~$25M room — space to add, but a thin roster to start
- Contender: ~$20M room — some flexibility, meaningful decisions
- Empire: ~$15M room — very little flexibility, locked into veterans
- Gambler: ~$25M room, but existing contracts are front-loaded and aggressive
- Lab: ~$25M room — efficient construction leaves operating room
- Institution: ~$20M room — stable but most of it is committed to veterans

If generated roster payroll overshoots cap at creation time, contract salaries are adjusted downward proportionally during generation — this is a generation constraint, not a runtime patch.

---

## 17. All-Star Game System (LOCKED)

### 17.1 The Hosting Score

A background metric that accumulates from decisions throughout the season and across seasons. The user never sees a raw number — they receive qualitative signal through relevant card outcomes: *"The league office has taken notice of the improvements to your facility"* or *"Your atmosphere ratings are among the best in the league this season."*

**What contributes to the hosting score:**
- Facility improvement cards accepted (scoreboard, visiting clubhouse, field quality, concourse upgrades, etc.)
- Atmosphere metric sustained above 70 for a full season
- Revenue metric — the league wants to host the game somewhere profitable
- Prestige tier — minimum Tier 2 required for first hosting; minimum Tier 3 for second

The formula and exact threshold values live in `data/constants.js` as named constants (wiki-documentable, easily tunable).

### 17.2 The Announcement Card (LOCKED)

Fires during the **current season**, around games 45–55, if the hosting score threshold is met. This is intentionally earlier than real-world timing because the narrative benefit of in-season announcement — the user sees the payoff of their decisions while still playing — outweighs the realism cost.

The announcement is a high-prominence card: different visual weight from standard inbox cards, explicit celebration language, distinct sender (*"Commissioner's Office"*).

### 17.3 What Hosting Delivers (LOCKED)

When the announcement fires, the following are applied or queued:

**Immediate (on card resolution):**
- One-time revenue bonus: $10–15M (scaled by atmosphere and prestige tier)
  - *Superseded (§78, r72):* the hosting share is 5–8% of the payroll target, posted to Club Funds — $10–15M was more than a season's gate.
- Atmosphere bump: +15, sustained for the remainder of the hosting season
- OwnerTrust: +10
- GM relationship boost: +5 with all league teams (organizational prestige signal)

**All-Star Week card set (fires during the All-Star Break phase):**
A set of 3–4 cards exclusive to the hosting team, each with a real decision:
- Sponsor activation decision (revenue vs atmosphere tradeoff)
- Community event decision (atmosphere vs operating budget)
- Media access decision (atmosphere vs clubhouse distraction)
- Player selection influence card (one of your players is in contention — advocate publicly or stay quiet)

**Post-All-Star glow (remainder of hosting season):**
- Home attendance modifier: +small atmosphere boost on home game cards for ~20 games post-break
- One special trade target card: a player from another team who *"was impressed by your organization during All-Star week"* — exclusive to hosting franchises, fires within 10 games of the break

### 17.4 Escalating Stakes (LOCKED)

Hosting once sets a new, permanently higher threshold for all future bids. The league explicitly acknowledges this in future hosting-related card text.

| Hosting instance | Threshold difficulty | Additional requirement |
|---|---|---|
| First hosting | Achievable with 2–3 seasons of sustained effort | Prestige Tier 2+ |
| Second hosting | Significantly harder — requires peak facility ratings | Prestige Tier 3+, min 3 seasons since last hosting |
| Third hosting | Dynasty-level achievement — near maximum on all inputs | Prestige Tier 5, min 4 seasons since last hosting |

Hosting three times in a franchise's history is one of the conditions that can contribute to the Franchise Legend win condition (see Section 18).

---

## 18. Prestige Tier System & Win Condition (LOCKED)

### 18.1 Philosophy (LOCKED)

**Philosophy B operates each season:** Every season has a clear ownership win target. Meeting or exceeding it is that season's verdict — success or failure is explicit at the season summary screen.

**Philosophy C defines the franchise arc:** Reaching the highest prestige tier AND winning a championship in the same season triggers the **Franchise Legend** end state — a proper conclusion with a ceremony card, full franchise history summary, and the choice to retire the franchise or continue building the legacy.

### 18.2 The Five Prestige Tiers (LOCKED)

| Tier | Name | What it represents |
|---|---|---|
| 1 | **Cellar Dweller** | Struggling franchise — below .500, no meaningful playoff history |
| 2 | **Fringe Contender** | Occasional winning seasons, first playoff appearance reached |
| 3 | **Established Franchise** | Consistent winning, multiple playoff runs, recognized organization |
| 4 | **Perennial Contender** | Regular playoff presence, at least one championship, respected league-wide |
| 5 | **Dynasty** | Multiple championships, sustained excellence, franchise legend in progress |

### 18.3 Tier Advancement

Prestige tier is recalculated at the SEASON_SUMMARY phase each year. It is based on a **cumulative prestige score** that accumulates across all seasons played. The score never decreases — prestige is earned permanently, not lost in bad seasons. (Ownership patience and financial parameters respond to bad seasons; prestige does not.)

**Prestige score inputs (exact weights in `data/constants.js`):**

| Event | Points |
|---|---|
| Each regular season win | +1 |
| Winning season (>66 wins in 132-game season) | +15 bonus |
| Playoff appearance | +25 |
| Each playoff round won | +20 |
| Championship won | +100 |
| All-Star Game hosted | +40 |
| Franchise Turning Point achieved (Ember/Lab) | +30 |
| Season win target met | +10 |
| Season win target exceeded by 10+ wins | +20 bonus |

**Tier thresholds (exact values in `data/constants.js`):**

| Tier | Cumulative score required |
|---|---|
| 1 → 2 | 150 points |
| 2 → 3 | 400 points |
| 3 → 4 | 800 points |
| 4 → 5 | 1,400 points |

A well-run franchise playing consistently good baseball reaches Tier 5 in approximately 6–8 seasons. A championship-focused run can get there faster. The thresholds are tunable constants — not magic numbers embedded in logic.

### 18.4 Tier Advancement Card

When the prestige tier increases, a prominent card fires at the SEASON_SUMMARY phase acknowledging the milestone. Different from a standard inbox card — this is a franchise moment. The sender is the ownership group; the language is celebratory and specific to the tier reached.

### 18.5 The Franchise Legend Win Condition (LOCKED)

**Trigger:** Prestige Tier 5 AND a championship won in the same season.

**What happens:**
1. The World Series victory card resolves normally
2. The SEASON_SUMMARY phase plays out normally
3. A special **Franchise Legend** card fires — distinct visual treatment, full-screen ceremony presentation, franchise history displayed in its entirety
4. The card presents a final decision: *"Your legacy here is complete. Will you step away at the top, or keep building?"*
   - **Retire the franchise:** Save slot is marked "Legend" status, read-only. A permanent achievement badge on the team picker screen. The franchise exists as a completed story.
   - **Continue building:** Game continues into the next offseason. Ownership raises expectations further. New challenges unlock (league expansion rumors, international competition cards, media legacy cards). The game doesn't end — but it acknowledges that you won.

**Why this matters:** Players who want closure get it. Players who want to keep going can. Neither is penalized. The win condition is a narrative beat, not a hard stop.

### 18.6 Secondary Win Conditions (Contributing Achievements)

These don't trigger the Franchise Legend on their own but contribute to the franchise's legacy score and are tracked in the franchise history:

- First championship
- Back-to-back championships
- Three championships in five seasons
- All-Star Game hosted three times
- Franchise Turning Point completed (Ember/Lab only)
- 10 consecutive winning seasons
- Reaching Tier 5 from a Tier 1 Ember start (the full rebuild arc)

Each of these fires its own milestone card when achieved. All are documented in the franchise history modal and will be covered in the player wiki.

---

## 19. Player Reference Wiki (Future Project)

> Status: NOTED — does not affect current build scope. Shapes how we build.

A companion website — separate from the app, hosted on GitHub Pages in a companion repo — that gives players full transparency into the game's mechanics. Inspired by the reference wikis that exist for deep RPG and simulation games (Stardew Valley, Dwarf Fortress, etc.).

**What it would cover:**
- How each archetype affects starting parameters and card weights
- How every card's effects impact each metric (full effect tables)
- How the All-Star hosting score is calculated and what contributes to it
- Sub-rating development curves by age and trait
- Prestige tier thresholds and scoring inputs
- Trade cash direction formula
- Sim engine win probability formula
- How roster depth checks work
- Season transition processing order

**The architectural implication for this build (ACTIVE):**

Every mechanical value must live in `data/constants.js` as a named constant, not as a magic number inside logic code. This is required for the wiki to be accurate and maintainable. It also makes the game easier to tune and debug.

Examples of what must be constants:
```javascript
// data/constants.js
export const ALLSTAR_HOSTING_THRESHOLD_BASE = 850;
export const ALLSTAR_HOSTING_THRESHOLD_SECOND = 1400;
export const PRESTIGE_TIER_THRESHOLDS = [0, 150, 400, 800, 1400];
export const PRESTIGE_POINTS_CHAMPIONSHIP = 100;
export const TRADE_CASH_PER_RATING_POINT = 2.5; // $M
export const SPRING_TRAINING_GAME_COUNT = 20;
export const TRADE_DEADLINE_OPEN = 88;
export const TRADE_DEADLINE_CLOSE = 92;
// ... etc
```

No engine module should contain a hardcoded number that isn't either derived from state or imported from constants. This is a code quality rule enforced from Phase 0.

> Status: FRAMEWORK DRAFTED — feature details and pricing are open questions (see Section 15).

### 17.1 The Between-Games Problem

In live mode, the user's next game is tomorrow at 1pm. There can be 23 hours of dead time. The app needs intentional design for this window — not filler, but meaningful lightweight engagement that respects the GM fantasy.

### 17.2 Between-Games Features (Free)

**League Activity Feed**
A live-updating feed on the Dashboard showing what's happening around the league between games: CPU trades, injuries to other teams, standings shifts, hot streaks. No decisions required — this is ambient awareness. Makes the league feel alive when you're not playing.

**Compose Tab (deepened)**
The Compose tab currently generates cards based on topic. The between-games window is when a real GM would check in with staff. Specific between-games compose prompts:
- "Check in with {pitching_coach} about tomorrow's starter" → generates a contextual pregame card
- "Request a scouting report on upcoming opponent" → generates a scouting card with opponent tendencies
- "Check clubhouse temperature" → generates a morale/culture card
These should feel like proactive GM actions, not random card draws.

**Lineup Tinkering**
The roster screen is always available. Between games is when GMs adjust their lineup for the next opponent. Small UI additions: "Next opponent is {team} — their starter is a lefty" as a contextual nudge.

**Notification-Driven Re-entry**
The pregame reminder notification (30 min before first pitch) is the primary re-entry mechanism. Secondary: card delivery notifications for anything urgent that arrives between games.

### 17.3 Between-Games Features (Premium)

**Weather Radar**
Animated procedural radar visualization available at all times — not just during delays. Slider covers current time → +12 hours in 1-hour increments with 3 zoom levels. Free users see weather status cards and delay indicators only. See Section 8.8 for full design.

**Extended Weather Forecast**
Free tier: 48-hour weather visibility. Premium tier: 7-day forecast. Knowing about a storm system 5 days out lets the user anticipate makeup game risk, prep the groundskeeper channel, and make strategic roster decisions before a key home stand.

**Extended Scouting Reports**
Detailed opponent breakdowns: starter tendencies, bullpen usage patterns, lineup hot/cold zones. Free users get a summary card; premium users get the full report with sub-rating level detail.

**Prospect Development Tracker**
Farm system visibility — see your prospects' sub-rating progression, projected call-up timeline, development milestone cards. Free users see a basic farm list; premium users see full development arcs.

**Historical Stat Depth**
Career stat breakdowns by season, sub-rating history charts, franchise records. Free users see current season and career totals; premium users see season-by-season breakdowns.

**Staff Delegation**
The ability to hire department heads or assistants to handle certain categories of messages automatically. See Section 17.6 for full design.

**Additional Save Slots**
Free tier: 1 save slot. Premium: up to 6 save slots (one per archetype). The primary premium hook — directly enables the multi-team feature.

**Ad-Free Experience**
See Section 17.4.

### 17.4 Advertising Model

**Core rule: ads interrupt dead time, never active play.**

Permitted ad placements:
- Between the end of a committed game and returning to the dashboard (post-game interstitial)
- On the Dashboard when no live game is in progress and no urgent cards are pending
- In the League tab when browsing standings (banner format, non-intrusive)

Banned ad placements:
- During a live game (any moment from first pitch to final out)
- When a card is open and waiting for a decision
- During the game creation / archetype selection flow
- During offseason decisions (contract renewals, ownership evaluation)
- On the Roster screen during an active transaction

**Premium removes all ads.** Clean value proposition: the experience without interruption.

**Ad implementation:** Client-side ad SDK (Google AdSense for PWAs or similar). Not a Phase 1 concern but must be designed into the UI layout from the start so placements don't require later restructuring.

### 17.5 Premium Pricing Model

> Exact pricing is an open question (OQ-22). Framework only here.

- **One-time purchase** — pay once, unlock all premium features forever. Simpler, better user trust, no subscription fatigue.
- **Monthly subscription** — recurring revenue, but higher churn risk for a game with natural stopping points between seasons.

Recommendation: one-time purchase for the core premium unlock. Optional subscription for a future "live data" tier if real-world data integration is ever added (out of scope for this rebuild).

### 17.6 Staff Delegation (Premium Feature — LOCKED as planned feature)

The ability to hire department heads or assistants to handle certain categories of messages automatically, without requiring GM input on every decision.

**How it works:**
The GM hires a delegate for a specific channel or card category. The delegate auto-resolves cards in their domain using a configurable decision style (conservative, balanced, aggressive). The GM still sees the outcome as a brief inbox notification — *"Facilities handled the concourse repair request — approved, $1.2M from operating budget"* — but doesn't make the decision themselves.

**The tradeoff (real decision, not just convenience):**
Delegates make reasonable but imperfect decisions. A conservative delegate may decline a revenue opportunity the GM would have taken. An aggressive delegate may overspend on operating budget. Delegate quality is tied to their experience level (upgradeable) and the GM's relationship score with that department. A neglected relationship means a less reliable delegate.

**Delegatable channels:**
- Facilities & Operations (infrastructure decisions)
- Ticket Office (sales and pricing decisions)
- Community Affairs (fan relations and local events)
- Media Relations (press and public narrative)

**Non-delegatable — always require GM input:**
- Manager, Pitching Coach, Hitting Coach, Bench Coach, Bullpen Coach — field decisions are the GM's core job
- Head Groundskeeper — weather and field conditions are too consequential to delegate
- Scouting / Player Development — acquisition decisions are the GM's core job
- Any card tagged `urgent` — regardless of delegation settings, urgent cards always surface to the GM

**Implementation note:** Delegation settings live in the save slot settings object, not the game state. Each slot can have different delegation preferences.

---

## 25. Ownership Win Target Escalation (LOCKED)

### 25.1 Annual Adjustment

Each offseason, ownership adjusts the coming season's win target based on last season's performance relative to target. Adjustment is bounded — ownership cannot raise by more than 5 wins or lower by more than 3 wins in a single offseason.

| Last season result | Target adjustment |
|---|---|
| Missed target by 10+ wins | −3 |
| Missed target by 5–9 wins | −2 |
| Missed target by 1–4 wins | −1 |
| Met target (within 2 wins) | +1 |
| Exceeded target by 3–7 wins | +3 |
| Exceeded target by 8+ wins | +5 |

### 25.2 Prestige Tier Milestone Bumps

When prestige tier advances, ownership recalibrates expectations upward regardless of recent performance — a one-time bump applied that season:

| Tier advancement | One-time target bump |
|---|---|
| Tier 1 → 2 | +5 wins |
| Tier 2 → 3 | +7 wins |
| Tier 3 → 4 | +8 wins |
| Tier 4 → 5 | +10 wins |

### 25.3 Archetype Floors and Ceilings

Win targets never drop below the floor or rise above the ceiling for the franchise's archetype. These are tunable constants.

| Archetype | Target floor | Target ceiling |
|---|---|---|
| Ember | 60 | 88 |
| Contender | 75 | 95 |
| Empire | 85 | 98 |
| Gambler | 65 | 92 |
| Lab | 65 | 90 |
| Institution | 72 | 92 |

All values in `data/constants.js` — adjustable after testing without touching engine code.

---

## 26. Playoffs (LOCKED)

### 26.1 Bracket Structure (LOCKED — finalized during Phase 6 pre-build audit)

All 5 teams per division qualify. Bracket is fully division-contained until the World Series.

**Per-division bracket (identical structure for Division A and Division B):**

| Round | Format | Matchup | Notes |
|---|---|---|---|
| Wild Card | 1 game | 4th seed vs 5th seed | Single elimination — win or go home |
| First Round | Best of 3 | 1st vs WC winner; 2nd vs 3rd | Higher seed hosts all games |
| Division Series | Best of 5 | First Round winners | Higher seed hosts |
| World Series | Best of 7 | Division A champion vs Division B champion | Better record hosts |

**Seeding:**
- Seeds 1–5 determined by regular season record within each division
- Tiebreaker: head-to-head record (wiki-documented — see Section 19)
- Overall #1 seed: best record in the entire league (determines World Series home field)
- Overall #2 seed: best record in the other division (confirmation only — no bracket effect)

**Wild Card significance:**
- 4th and 5th place finish is a genuine penalty — one bad game ends your season
- Rich card/decision territory if the user team is seeded 4th or 5th
- No bye for any team — 1st seed plays the Wild Card winner, not a rested team

**Series progression:** 1 game → best of 3 → best of 5 → best of 7
Each round longer than the last — escalating drama and commitment.

CPU-vs-CPU series simulated automatically using team OVR ratings with home field modifier.

### 26.2 Playoff Roster Expansion (LOCKED)

Before each playoff round, the GM receives a **playoff roster submission card** — a genuine strategic decision, not a formality.

Before the Wild Card game:
- GM can activate up to 3 additional players from: farm callups, players returning from IL, or previously inactive players
- Card presents the options with OVR and position displayed
- Decision has tactical weight: extra reliever vs extra bench bat vs activating an injured starter

Between rounds (First Round → Division Series → World Series):
- GM can make up to 1 roster change per round
- Players added must be declared before the next series begins

```javascript
export const PLAYOFF_ROSTER_EXPANSION_ROUND1 = 3;
export const PLAYOFF_ROSTER_EXPANSION_BETWEEN_ROUNDS = 1;
```

### 26.3 Playoff-Specific Card Pool

Regular season card pools are suspended during playoffs. Active pools:

| Pool | Content |
|---|---|
| `PLAYOFF_PREGAME_POOL` | Pre-series scouting, opponent tendencies, matchup analysis |
| `PLAYOFF_ROTATION_POOL` | Starter selection for each game, skip decisions, SP-in-relief options |
| `PLAYOFF_BULLPEN_POOL` | High-leverage usage, rest concerns, closer sequencing |
| `PLAYOFF_INJURY_POOL` | Two-act injury model with elevated stakes — playoff injury = higher drama |
| `PLAYOFF_ATMOSPHERE_POOL` | Home playoff crowd energy, travel decisions, media access |
| `PLAYOFF_ADJUSTMENT_POOL` | Mid-series opponent adjustments — *"They've figured out your closer"* |

### 26.4 Playoff Sim Adjustments

Playoff games use the same SimEngine with adjusted constants:

```javascript
export const PLAYOFF_HOME_FIELD_BONUS = 0.035;  // stronger than regular season
export const PLAYOFF_ACE_FREQUENCY = 1.4;        // aces pitch more often
export const PLAYOFF_VARIANCE_MULTIPLIER = 1.2;  // upsets more likely — anything can happen
```

### 26.5 Elimination and Advancement

Series conclusions are milestone screen moments (see Section 27). After a series win or loss, the SEASON_SUMMARY or next round begins with the appropriate milestone screen.

---

## 27. Milestone Screens (LOCKED)

### 27.1 What They Are

Milestone screens are full-screen interstitial moments that replace the normal dashboard at the game's most important junctures. They are not cards, not modals — they are scene-setters with a completely different visual language.

**What makes them different from cards:**
- Full-screen — no inbox chrome, no sender/avatar, no card frame
- Single action only: "Continue" or a swipe gesture
- Large illustrative SVG — thematic, atmospheric
- Typography-driven — the moment's name large, a one-line subtext beneath
- Color palette shifts from the app's normal dark theme
- Brief ambient sound if enabled (crowd noise, stadium ambience — one moment)
- One-time display per trigger — shown once, never repeated for that instance

### 27.2 Milestone Screen Catalog (LOCKED)

| Trigger | Screen title | Subtext | Visual tone |
|---|---|---|---|
| Spring training begins | **Spring Training** | *"The work starts here."* | Warm, hopeful |
| Regular season game 1 | **Opening Day** | *"The season begins."* | Bright, anticipatory |
| All-Star Break (non-host) | **Midsummer** | *"Halfway there."* | Reflective, calm |
| All-Star Break (host) | **All-Star Week** | *"The league comes to you."* | Celebratory, prestige |
| Trade deadline opens | **The Deadline** | *"Make your move."* | Tense, urgent |
| Trade deadline closes | **Deadline Passed** | *"The window is closed."* | Brief closure |
| Final 5 regular season games | **The Stretch Run** | *"Every game matters now."* | Stakes-driven |
| Playoff clinch | **Postseason Bound** | *"You earned it."* | Earned triumph |
| Wild Card begins | **Wild Card** | *"Win or go home."* | Cinematic |
| Division Series begins | **Division Series** | *"The real test starts now."* | Cinematic |
| Championship Series begins | **Championship Series** | *"One series from the top."* | Elevated tension |
| World Series begins | **The World Series** | *"This is what it's all for."* | Maximum stakes |
| Series win (any round) | **Series Won** | *"On to the next."* | Triumph |
| Series loss / elimination | **Season Over** | *"A season to build on."* | Respectful, not harsh |
| Championship won | **Champions** | *"You did it."* | Full ceremony |
| Offseason begins | **The Offseason** | *"The work begins again."* | Calm transition |
| New season (season 2+) | **Year [N]** | *"A new chapter."* | Continuity, franchise arc |
| Franchise Turning Point | **A New Era** | *"Everything changes now."* | Pivotal, weighted |
| Franchise Legend | **A Legacy Complete** | *"Your name is in the record books."* | The game's most important screen |

### 27.3 Sequencing With Cards

Milestone screens and cards are sequenced, not simultaneous:

1. Milestone screen shows (full-screen, atmospheric)
2. User taps "Continue"
3. Normal game view returns
4. First card of the new phase is waiting in the inbox

The milestone sets the stage. The card delivers the first decision. These are separate concerns — the screen never contains a decision, the card never tries to be a ceremony.

### 27.4 Implementation

Milestone screen configs live in `data/constants.js`. `GameEngine` checks for milestone triggers at each phase transition and game index boundary.

```javascript
export const MILESTONE_SCREENS = {
  OPENING_DAY: {
    title: 'Opening Day',
    subtitle: 'The season begins.',
    palette: 'warm',          // CSS palette token
    icon: '⚾',
    triggerPhase: 'REGULAR_SEASON',
    triggerGame: 0,
  },
  TRADE_DEADLINE: {
    title: 'The Deadline',
    subtitle: "Make your move.",
    palette: 'urgent',
    icon: '⏱',
    triggerPhase: 'TRADE_DEADLINE',
    triggerGame: 88,
  },
  // ... full catalog
}
```

`MilestoneScreen.js` is a standalone UI component in `ui/screens/`. It reads the config, renders the screen, and dispatches a `MILESTONE_DISMISSED` event when the user taps Continue. `GameEngine` listens for this event before resuming normal game flow.

One-time display enforced by `state.seenMilestones: String[]` — milestone ID pushed to the array on dismiss, never shown again for that franchise instance. Stored as Array (not Set) to satisfy the JSON-serializable state rule (Section 1.7).

---

*Document last updated: v1.0 — Firebase and Cloudflare infrastructure confirmed and documented. All planning complete. Ready to begin Phase 0.*

## 28. League Activity System & CPU Game Detail (LOCKED)

### 28.1 The Living League Principle

The league operates independently of the user. CPU teams run their own franchises — games, transactions, injuries, roster moves — on their own schedules. The user is one GM among ten, not the center of the universe.

### 28.2 Full CPU Schedule

Every CPU team plays a full 132-game schedule against the other 9 teams. The schedule structure (matchups + dates) is generated at season start and stored in `state.leagueSchedule.dayMap`. No outcomes, no plays at generation time.

**Why simulation happens on game day, not at season start (LOCKED):**
CPU game outcomes depend on the roster as it exists on that date — after all injuries, trades, and callups that occurred since Opening Day. Pre-generating outcomes at season start would produce results based on stale rosters. `LeagueEngine.processCPUDay()` runs on each calendar date, pulls current rosters from `state.players`, runs SimEngine, commits results, accumulates stats, strips plays, keeps box score and recap.

This enables: real game results feeding player stats, authentic league standings, watchable CPU games, and a rich activity feed — all with roster-accurate simulation.

**Schedule generation constraint:** At least 4 teams have a game on any given day during the regular season. On the user's off/travel days, there are always CPU games to follow.

### 28.3 Game Timing (LOCKED)

All 10 teams share the same day-of-week time range. No division-based time splits. No timezone accounting.

```javascript
export const GAME_TIMES_BY_DOW = {
  MON: ['7:05 PM'],
  TUE: ['7:05 PM'],
  WED: ['1:05 PM', '7:05 PM'],
  THU: ['1:05 PM', '7:05 PM'],
  FRI: ['7:05 PM'],
  SAT: ['1:05 PM', '4:05 PM', '7:05 PM'],
  SUN: ['1:05 PM', '4:05 PM'],
}
```

Teams in the same series play at the same time. Teams in different series on the same day may have different time slots, creating the staggered schedule that keeps the league feed active throughout the day.

**User's team timing:** First spring training game always at 1:05 PM regardless of day. After that, the user's team follows the same time assignment logic as every CPU team.

### 28.4 CPU Game Detail Level (LOCKED)

CPU games are watchable from the League screen with close to the same detail as the user's live game:

- Live score header (away/home, current score)
- Diamond SVG showing baserunner state — updates as plays reveal
- High-level PBP feed: scoring plays, home runs, strikeouts, walks, pitching changes, stolen bases, final out
- Box score updating as runs score and outs accumulate
- Linescore with per-inning cells filling as half-innings complete
- Status pill: PRE-GAME / LIVE / FINAL

The CPU game uses the same pre-generation pipeline as the user's game. The difference is display context — the user watches their own game on the main dashboard; CPU games are watched by navigating to that game in the League screen.

CPU games run on the same 5-second tick cycle. The user can watch one CPU game at a time. Switching away and back shows the current state.

### 28.5 League Activity Feed (LOCKED)

A 72-hour rolling feed of transactions and events from around the league. Accessible from the League screen and as a widget on the Dashboard.

**Feed entry types:**

| Type | Example entry | Timing |
|---|---|---|
| IL placement | "BOS placed CF Rodriguez on the 10-day IL" | When injury fires |
| Farm callup | "SEA recalled SP Nakamura from Triple-A" | When callup processes |
| Waiver claim | "NYE claimed 1B Torres off waivers from ATL" | When claim resolves |
| Trade | "CHI and MIA completed a trade: SP Wallace to MIA, OF Garza to CHI" | When trade commits |
| Game result | "BOS def. NYE 4–2 — Kondo 7IP, 1ER" | When game commits |
| Injury update | "LAP SS Torres (hamstring) — 2–3 weeks" | When diagnosis fires |
| Standings shift | "ATL moves into Wild Card position" | When standings recalculate |
| Playoff clinch | "CHI clinched a playoff berth" | When standings confirm it |
| Free agent signing | "ATL signed RP Castillo to a 1-year deal" | During offseason |

**Retention:** 72 hours. Entries older than 72 hours are removed from the feed. No archive — gone is gone. Season-level summaries (trades this season, IL stints this season) are accessible in team detail views separately.

**Standings context near season end:** In the final 10 games of the season, game result entries automatically include a standings note when the result affects playoff positioning — *"SEA def. MIA 3–1 — SEA moves to 1 game behind the Wild Card lead."*

### 28.6 Player Watchlist (LOCKED)

The user can watch individual players from any team. Watched players surface in the between-games feed with recent stats, injury status, and roster decisions.

- Free tier: 5 watched players
- Premium tier: 50 watched players

Watchlist is per save slot. Adding a player to the watchlist is a single tap from their player card anywhere in the app.

### 28.7 League Stat Leaders (LOCKED)

A league-wide leaderboard accessible from the League screen. Updates daily.

**8 categories (initial release):**

| Batting | Pitching |
|---|---|
| AVG | ERA |
| HR | W |
| RBI | K |
| SB | SV |

Top 5 players per category shown. User's players highlighted when they appear.

**Future expansion (noted for post-launch design session):** OPS, BB, WHIP, Holds, and the Impact Rating (IMP) metric. The IMP calculation and the additional stat fields are fully designed in Sections 30 and 4.3.

### 28.8 Hot/Cold Indicators (LOCKED)

A simple directional indicator per player based on recent simulated performance.

- Calculated from last 7 games played
- Three states: 🔥 Hot, ❄️ Cold, — Neutral
- Free tier: own roster players only
- Premium tier: league-wide

**Future expansion (Section 30):** IMP-7/IMP-15/IMP-30/IMP-S rolling Impact Rating windows, similar to fantasy baseball performance ratings.

---


## 29. Difficulty Preset System

> **REMOVED** — Archetypes serve as the difficulty selection (Section 1.9). No separate difficulty setting exists. All mechanical constants are fixed values; challenge comes entirely from archetype roster quality, financial parameters, and ownership expectations.

---



## 30. Impact Rating (IMP) — LOCKED

### 30.1 What It Is

**Impact Rating** — shortened to **Impact**, acronym **IMP** — is the game's proprietary player value metric. It is a single decimal number representing how much a player is contributing relative to the position average — positive means above average, zero means replacement level, negative means below.

Impact Rating is not WAR. It is a hybrid of fantasy baseball counting-stat accessibility and positional normalization from baseball analysis. The name is deliberately simple and ownable — no other sport uses "Impact Rating" as a standalone baseball metric, and "his Impact is running hot" reads naturally in any context within the game.

**Displayed as:** "Impact" in the UI. "IMP" in tight spaces (stat tables, player rows). "Impact Rating" in full contexts (wiki, onboarding, settings descriptions).

**Expected ranges:**
| IMP range | What it means |
|---|---|
| +6.0 and above | Elite — MVP-caliber season |
| +3.0 to +5.9 | Solid starter — clear positive contributor |
| +1.0 to +2.9 | Average starter — holds their own |
| -1.0 to +0.9 | Replacement level — borderline roster spot |
| Below -1.0 | Below replacement — roster decision needed |

### 30.2 Rolling Windows

IMP is calculated four ways from the same formula, using different stat windows:

| Window | Stat source | Character |
|---|---|---|
| IMP-7 | Last 7 days of games | Volatile — pure hot/cold signal |
| IMP-15 | Last 15 days | Short-term form trend |
| IMP-30 | Last 30 days | Most actionable for roster decisions |
| IMP-S | Full season | Most stable — true season value |

**Hot/cold indicator** (Section 28.8) is IMP-7 vs threshold constants:
```javascript
export const IMP_HOT_THRESHOLD   = 2.5;   // IMP-7 above this = 🔥
export const IMP_COLD_THRESHOLD  = -2.0;  // IMP-7 below this = ❄️
```

### 30.3 Hitter IMP Formula

```
IMP = (OPS_delta   × IMP_H_OPS_WEIGHT)
    + (HR_rate_delta × IMP_H_HR_WEIGHT)
    + (RBI_rate_delta × IMP_H_RBI_WEIGHT)
    + (SB_net        × IMP_H_SB_WEIGHT)
    + (BB_pct_delta  × IMP_H_DISCIPLINE_WEIGHT)
    - (K_pct_delta   × IMP_H_STRIKEOUT_PENALTY)
    - (BABIP_luck_adjustment)
```

**Definitions:**
- `OPS_delta` — player OPS minus position average OPS (e.g. SS average OPS is lower than DH average OPS)
- `HR_rate_delta` — player HR per AB minus position average HR rate
- `RBI_rate_delta` — player RBI per AB minus position average RBI rate
- `SB_net` — `SB - (CS × 1.5)` — caught stealing costs more than a steal gains
- `BB_pct_delta` — player BB% minus position average BB%
- `K_pct_delta` — player K% minus position average K% (high K% is negative)
- `BABIP_luck_adjustment` — if player BABIP exceeds their career BABIP (or league average for new players) by more than `IMP_H_BABIP_ADJ_TRIGGER`, a small downward correction is applied. Prevents lucky hot streaks from inflating IMP.

All `_delta` values are position-normalized — a shortstop is compared to other shortstops, not to the whole league.

### 30.4 Pitcher IMP Formula

```
IMP = (ERA_delta   × IMP_P_ERA_WEIGHT)
    + (WHIP_delta  × IMP_P_WHIP_WEIGHT)
    + (K9_delta    × IMP_P_K9_WEIGHT)
    - (BB9_delta   × IMP_P_WALK_PENALTY)
    - (HR9_delta   × IMP_P_HR_PENALTY)
    + (QS_rate     × IMP_P_QS_BONUS)      // SP only
    + (SV_pct      × IMP_P_SAVE_BONUS)    // closers only
    + (HLD_rate    × IMP_P_HOLD_BONUS)    // setup relievers only
    + (IP_bonus)                           // durability value
```

**Definitions:**
- All `_delta` values normalized against SP average or RP average (not combined)
- `ERA_delta` — league average SP/RP ERA minus player ERA (higher is better)
- `QS_rate` — QS / GS (quality start percentage, SP only)
- `SV_pct` — SV / SVO (save percentage, closers only)
- `HLD_rate` — HLD / (HLD + BS) (hold success rate, setup relievers only)
- `IP_bonus` — logarithmic durability bonus: `log(IP) × IMP_P_IP_LOG_SCALE`. Rewards innings eaters without letting volume dominate.

### 30.5 All IMP Constants (wiki-documented, all tunable)

```javascript
// data/constants.js — IMP weights

// Hitter
export const IMP_H_OPS_WEIGHT          = 8.0;
export const IMP_H_HR_WEIGHT           = 0.8;
export const IMP_H_RBI_WEIGHT          = 0.4;
export const IMP_H_SB_WEIGHT           = 0.3;
export const IMP_H_DISCIPLINE_WEIGHT   = 3.0;
export const IMP_H_STRIKEOUT_PENALTY   = 2.5;
export const IMP_H_BABIP_ADJ_TRIGGER   = 0.040;
export const IMP_H_BABIP_ADJ_WEIGHT    = 1.5;

// Pitcher
export const IMP_P_ERA_WEIGHT          = 3.5;
export const IMP_P_WHIP_WEIGHT         = 4.0;
export const IMP_P_K9_WEIGHT           = 1.2;
export const IMP_P_WALK_PENALTY        = 1.8;
export const IMP_P_HR_PENALTY          = 2.0;
export const IMP_P_QS_BONUS            = 0.5;
export const IMP_P_SAVE_BONUS          = 0.8;
export const IMP_P_HOLD_BONUS          = 0.4;
export const IMP_P_IP_LOG_SCALE        = 0.015;

// Thresholds
export const IMP_HOT_THRESHOLD         = 2.5;
export const IMP_COLD_THRESHOLD        = -2.0;
export const IMP_ELITE_THRESHOLD       = 6.0;
export const IMP_BELOW_REPLACEMENT     = -1.5;
```

Post-testing: if IMP-S values are running too high league-wide, reduce `IMP_H_OPS_WEIGHT`. If pitchers are rating too similarly, widen `IMP_P_ERA_WEIGHT`. No engine changes required.

### 30.6 Display Contexts

IMP is displayed differently in different contexts:

| Context | What's shown |
|---|---|
| Roster screen player row | IMP-S with small hot/cold indicator |
| Player detail modal | All four windows (IMP-7, IMP-15, IMP-30, IMP-S) as a small bar chart |
| Watchlist | IMP-7 and IMP-S side by side |
| League stat leaders | IMP-S leaderboard — top 5 hitters, top 5 pitchers |
| Trade card value note | Qualitative IMP language ("elite contributor", "below replacement") — not the number |
| IMP-7 display label | Shows as "IMP-7" in UI |

Free users see IMP-S only. Premium users see all four windows.

### 30.7 Wiki Documentation

The IMP wiki page covers:
- What IMP measures and the design philosophy
- Hitter and pitcher formulas in plain English
- Position normalization explained
- BABIP luck adjustment explained
- Rolling window meanings and when to use each
- Expected IMP ranges reference table
- Full constants table with current values and descriptions

---



---

## 33. Tutorial System (POST-LAUNCH — LOCKED ORDER)

> ⚠️ Status: NOT STARTED. Must be the very last step after all game systems are fully locked and complete.

The tutorial is built last — after every screen, card, and mechanic is finalized — to ensure it accurately reflects the actual game rather than an earlier version of it.

**Scope:**
- New user onboarding flow for first-time players
- Triggered automatically on first save slot creation
- Non-blocking — user can dismiss at any point and return via Settings
- Covers: archetype selection, reading the dashboard, inbox cards, the live game screen, the roster screen, and the trade system
- Does NOT cover every feature — focused on the critical path to first meaningful decision

**Dependency:** Tutorial cannot be written until Phase 13 (App Shell) and all UI screens are complete. It is the final deliverable after everything else is locked.
---

## 34. Narrative Engine (Phase 13.6–13.7 — LOCKED)

The Narrative Engine is an enrichment layer on the existing card system. It does not create a new card type, a new inbox tab, or a new interaction pattern. Every card still requires a meaningful yes/no choice from the user. The narrative depth lives in the card body text — the voice, the organizational memory, the references to past decisions — not in new UI patterns.

### 34.1 Architecture

```
state.narrativeFlags[]          — append-only log of significant decisions
NarrativeEngine.js              — reads flags, generates enrichment context
CardEngine (delivery)           — calls NarrativeEngine at card delivery time
                                  to select conditional card body variant
```

NarrativeEngine is a pure engine (no StateManager import). It receives state as a parameter.

### 34.2 narrativeFlags Schema (LOCKED — Option B flat log)

```javascript
state.narrativeFlags = [
  {
    key:      String,    // e.g. 'extension_declined', 'facility_deferred'
    subject:  String,    // playerId, staffId, or null for org-level flags
    gameIdx:  Number,    // when it happened
    season:   Number,    // which season
    choice:   String,    // 'yes'|'no'|'auto'|null
    context:  Object,    // optional flag-specific metadata { amount, role, reason }
  }
]
```

Query: `NarrativeEngine.getFlags(state, { key?, subject?, season?, minGameIdx?, maxGameIdx? })`

### 34.3 Full Flag Taxonomy

**Roster decisions:**
- `extension_declined` / `extension_accepted` (subject: playerId)
- `player_rushed_back` — IL return before recommended date
- `player_held_back` — IL return significantly after recommended date
- `veteran_released` — releasing a player with gmRelationship >= 70
- `prospect_called_up` — first call-up from farm
- `trade_accepted` / `trade_declined` (subject: lead playerId)
- `waiver_claimed` / `waiver_passed`

**Financial decisions:**
- `budget_conservative` — finished season >15% under cap (count cumulative)
- `budget_aggressive` — exceeded payroll cap
- `facility_upgrade_approved` / `facility_upgrade_deferred`
- `sponsor_deal_accepted` / `sponsor_deal_declined`
- `ticket_price_raised` / `ticket_price_lowered`
- `concession_investment_approved` / `concession_investment_declined`

**Staff decisions:**
- `manager_extended_early` / `manager_extended_late` / `manager_contract_lapsed`
- `coach_retained` / `coach_released`
- `staff_request_approved` / `staff_request_declined` (subject: staffId)

**Operational decisions:**
- `community_event_approved` / `community_event_declined`
- `maintenance_approved` / `maintenance_deferred`
- `promotional_night_approved` / `promotional_night_declined`
- `media_engagement_high` / `media_engagement_low` (set from compose frequency)

**Marketing and concessions:**
- `concession_upgrade_approved` / `concession_upgrade_declined`
- `marketing_campaign_approved` / `marketing_campaign_declined`
- `fan_experience_invested` / `fan_experience_deferred`

**Compose behavior (aggregated):**
- `compose_used` — topic: topicId, channel: channelId (tracks engagement pattern)

**Outcome flags (set automatically after game commits and season boundaries):**
- `player_milestone_hit` (subject: playerId, context: { milestone })
- `playoff_series_won` / `playoff_series_lost`
- `season_record_above_500` / `season_record_below_500`
- `attendance_trend_up` / `attendance_trend_down` (end of season)
- `ownership_trust_gained` / `ownership_trust_lost` (offseason gate outcomes)

### 34.4 GM Profile Dimensions (Derived)

NarrativeEngine computes these on demand — never stored directly in state:

| Dimension | Derived from |
|---|---|
| `spender` vs `conservationist` | budget flags, payroll vs cap ratio |
| `loyal` vs `transactional` | extension_declined count, veteran_released count, trade frequency |
| `aggressive` vs `cautious` | rushed_back count, call-up timing, trade deadline behavior |
| `community_oriented` vs `business_focused` | community/promotional/fan-experience approvals vs declines |
| `hands_on` vs `delegating` | compose frequency and channel distribution |
| `process_driven` vs `results_driven` | correlates with archetype but diverges based on actual decisions |

### 34.5 Card Body Conditional Variants

Existing cards get an optional `variants` array alongside the base `body`:

```javascript
{
  id: 'il_return_act2',
  body: 'Default body text...',
  variants: [
    {
      condition: { flags: [{ key: 'player_rushed_back', subject: '{playerId}' }] },
      body: 'Variant referencing the rushed return (in character voice, never directly)...',
    },
    {
      condition: { gmProfile: { loyal: true }, season: { min: 2 } },
      body: 'Variant for a loyal GM in their second+ season...',
    }
  ]
}
```

NarrativeEngine selects the first matching variant at delivery time. Base `body` used if no variant matches. All existing cards continue to work unchanged — variants are additive.

**Authorship principle (LOCKED):** Card body variants never reference the flag system directly. They speak in character voices. The groundskeeper doesn't say "you deferred the drainage upgrade." He says "the water's been sitting longer than I'd like out near first base. Same issue we talked about last summer." The world remembers — the system does not report.

### 34.6 Flag Instrumentation (LOCKED)

Flag-setting is centralized in `CardEngine.resolve()`. Cards that generate flags have `flagKey` and optional `flagKeyYes` fields in the card pool entry:

```javascript
{
  id: 'contract_extension_veteran',
  flagKey:     'extension_declined',   // set on 'no'
  flagKeyYes:  'extension_accepted',   // set on 'yes'
  flagSubject: '{playerId}',           // resolved at delivery
}
```

Automatic (outcome-based) flags are set by `GameEngine.commitGame()` and `SeasonEngine` at season boundaries.

### 34.7 NarrativeEngine.js Exports

```javascript
export function getFlags(state, filter)           // query the flat log
export function setFlag(state, flagEntry)         // append to log
export function getGMProfile(state)               // derive dimension object
export function selectCardVariant(card, state)    // return body string for delivery
export function getRelevantFlags(state, card)     // flags contextually relevant to a card
```

---

## 35. Franchise History Screen (Phase 13.8 — LOCKED)

A browsable record of significant franchise events organized by season. Called "History" or "Franchise Story" in the UI — never "diary."

### 35.1 state.history Schema

```javascript
state.history = [
  {
    id:       String,     // unique entry ID
    type:     String,     // 'trade'|'injury'|'retirement'|'coaching'|'playoff'|
                          //  'milestone'|'prestige'|'record'|'championship'
    season:   Number,
    gameIdx:  Number,
    headline: String,     // short display label e.g. "Rodriguez traded to Boston"
    detail:   String,     // fuller description
    playerId: String,     // optional
    icon:     String,     // emoji for entry type
    userNote: String,     // optional user-added note
  }
]
```

### 35.2 Auto-Recorded Events

- Trades (both directions, with standings context at time of trade)
- Serious injuries (IL stints > 14 games)
- Player retirements
- Coaching hires and fires
- Playoff series results (each round, game-by-game record)
- World Series victory (full summary entry)
- Prestige tier changes
- Franchise Legend unlock
- Season final record and division finish
- Player milestones (first call-up, significant IMP peaks, career statistical thresholds)

### 35.3 UI

Accessible from Settings or a dedicated section. Organized by season, collapsible. Each entry shows icon + headline, expandable to detail. User can add a personal note to any entry (short freeform text). Multi-season view is the emotional payoff — looking back at Season 1 from Season 3.

### 35.4 Narrative Engine Connection

Both `getFlags()` and `state.history` are read by NarrativeEngine when selecting card variants. A card delivered in Season 3 can reference a history entry from Season 1 if conditions match.

---

## 36. Reports System (Phase 16 — LOCKED)

Three report types. Basic free, full suite premium.

### 36.1 Roster Report

All players ranked by OVR. Columns: name, position, OVR, 30-day IMP trend, age, salary, contract years remaining.

Free tier: OVR + position + age only. No sorting.
Premium tier: full sortable suite with IMP trend.

Shows depth chart gaps explicitly (e.g. "No backup at C").

### 36.2 Financial Report (Premium)

- Payroll by position group
- Operating budget vs spent
- Projected next-season payroll (expiring vs retained contracts)
- Attendance trend by homestand
- Revenue vs expenses
- Concessions and ticket revenue breakdown

### 36.3 Trade Value Report (Premium)

Composite score per player: OVR + age curve + IMP trend + contract value. Identifies surplus value (tradeable) vs core assets. Surfaces automatically when a trade card arrives — the relevant player's report data appears inline in the card context.

### 36.4 Player Comparison Tool (Premium)

Side-by-side stats for two players — triggered by selecting two players in any player list. Answers the trade evaluation question without requiring the user to hold numbers in their head.

### 36.5 UI

Reports sub-tab in the Team screen alongside Players and Staff. Reports are read-only, no actions. Stats-first users navigate here directly.


---

## 37. GitHub Deployment Guide (Phase 14 — for owner)

This section documents exactly what to do when it's time to put the v2 files into the GitHub repo. Written for a non-technical user.

### 37.1 Folder structure

The v2 app uses subfolders. GitHub doesn't have a "create folder" button — you create a folder by uploading a file into a path that includes the folder name. The assistant will walk through this file by file in Phase 14. The structure is:

```
/ (repo root)
├── index.html
├── manifest.json
├── sw.js
├── icon-192.png
├── icon-512.png
│
├── data/
│   ├── constants.js
│   ├── player-names.js
│   └── cards-pool.js
│
├── store/
│   ├── schema.js
│   ├── DB.js
│   └── StateManager.js
│
├── engine/
│   ├── PlayerFactory.js
│   ├── LeagueFactory.js
│   ├── RosterEngine.js
│   ├── SeasonEngine.js
│   ├── LeagueEngine.js
│   ├── GameEngine.js
│   ├── SimEngine.js
│   ├── WeatherEngine.js
│   ├── InjuryEngine.js
│   ├── TradeEngine.js
│   ├── CardEngine.js
│   ├── IMPEngine.js
│   ├── PrestigeEngine.js
│   ├── OffseasonEngine.js
│   └── NarrativeEngine.js
│
└── ui/
    ├── formatters.js
    ├── EventBus.js
    ├── App.js
    │
    ├── screens/
    │   ├── SetupScreen.js
    │   ├── DashboardScreen.js
    │   ├── InboxScreen.js
    │   ├── TeamScreen.js
    │   ├── LeagueScreen.js
    │   ├── ScheduleScreen.js
    │   ├── GameScreen.js
    │   ├── PlayoffScreen.js
    │   ├── OffseasonScreen.js
    │   └── HistoryScreen.js
    │
    └── components/
        ├── RadarWidget.js
        ├── LiveDiamond.js
        ├── Linescore.js
        ├── PlayerCard.js
        └── CardModal.js
```

### 37.2 Icon replacement (LOCKED)

The new app icons are already named correctly. To update them:
- Go to the repo root on GitHub
- Click `icon-192.png` → Edit (pencil) → upload new file with the same name
- Repeat for `icon-512.png`
- No folder change needed — both files stay in the repo root

The `manifest.json` built in Phase 14 references them at root level. No path changes required.

### 37.3 How to create a folder on GitHub by uploading a file

GitHub creates folders automatically when you include a folder path in a filename during upload. To upload `constants.js` into a `data/` folder:
1. In your repo, click **Add file → Upload files**
2. Drag the file in — it will appear as `constants.js`
3. Before committing, click the filename field and type `data/` before it, making it `data/constants.js`
4. GitHub creates the `data/` folder automatically

The assistant will give exact per-file instructions during Phase 14 deployment.

---

## 38. Locked Implementation Decisions (Session — Phase 13.5–13.6)

### 38.1 selectCardVariant wiring order (Phase 13.6 — LOCKED)

`NarrativeEngine.selectCardVariant()` runs **before** token resolution in CardEngine's delivery path. The correct order is:

1. Select the variant body (choose which version of the card text to use based on narrative flags)
2. Then resolve tokens in that chosen body (fill in player names, costs, etc.)

This is the only correct order. Token resolution must run on the final chosen text — not on placeholder text that might then get swapped out.

### 38.2 Phase 13.5 pre-existing bugs fixed

Two duplicate constant declaration bugs in `constants.js` were found and corrected during Phase 13.5:
- Duplicate `PRESTIGE_POINTS_TURNING_POINT` declaration
- Duplicate `IMP_H_OPS_WEIGHT` and full IMP block

These were pre-existing in the uploaded file, not introduced by Phase 13.5 edits.

### 38.3 SetupScreen import bug fixed (Phase 13.5)

`SetupScreen.js` was importing `createNewGame` from `GameEngine.js`, but `GameEngine.js` only exports `startNewGame`. This mismatch would have caused a runtime crash on new game creation. Fixed in Phase 13.5 — `SetupScreen` now correctly imports and calls `startNewGame`.


---

## 39. xBA and xSLG — Planned Addition (Phase 16)

> Status: NOTED — not in current build scope. Planned for Phase 16 alongside the Reports screen.

### 39.1 What they are

Expected Batting Average (xBA) and Expected Slugging Percentage (xSLG) are luck-adjusted versions of BA and SLG. They answer: "given the quality of contact this batter made, what would a typical player produce?" In real baseball these derive from Statcast exit velocity and launch angle.

### 39.2 Why they're not in the current build

The sim currently goes directly from sub-ratings → hit type outcome. There is no intermediate "quality of contact" layer. Adding xBA/xSLG properly requires:

1. A `contactQuality` value (0–1) per at-bat in `simulateAtBat` — how hard the ball was hit regardless of outcome
2. A batted ball type per at-bat (`groundBall` / `lineDrive` / `flyBall`)
3. Both stored on each play's `_statDeltas`
4. Expected stat computation from those inputs
5. Display additions in TeamScreen, LeagueScreen, PlayerCard, and Reports

This is a clean extension of the existing system — the foundation supports it — but it touches enough files that it belongs in a dedicated phase.

### 39.3 Phase 16 implementation plan

- Add `contactQuality: Number` and `batType: 'gb'|'ld'|'fb'` fields to the play object shape (Section 8.1)
- Generate both in `SimEngine.simulateAtBat()` based on `contact`, `power`, and hit type
- Accumulate per-player in `accumulateStats()` — store raw totals for xBA/xSLG computation
- Compute xBA and xSLG on demand in `IMPEngine` or a new `StatsEngine` helper
- Surface in: PlayerCard (alongside BA/SLG), Reports roster report (premium), player comparison tool
- Add to IMP formula as optional inputs once validated against sim output ranges

### 39.4 Constants needed (all go in data/constants.js)

```javascript
export const xBA_LINEDRIVE_RATE  = 0.685;  // league average LD hit rate
export const xBA_FLYBALL_RATE    = 0.205;  // league average FB hit rate
export const xBA_GROUNDBALL_RATE = 0.240;  // league average GB hit rate
export const xSLG_LINEDRIVE_SLG  = 1.120;
export const xSLG_FLYBALL_SLG    = 0.530;
export const xSLG_GROUNDBALL_SLG = 0.260;
```

All tunable post-testing — constants not magic numbers.


---

## 40. Session Status — Phase 13.5–13.8 Complete (May 31, 2026)

### 40.1 Completed this session

All sub-phases of Phase 13 are now complete:

**Phase 13.5 — Geographic Region**
- `constants.js`: `REGIONS` constant (4 regions), `REGION_DEFAULT`, all weather postponement threshold named constants, fixed 2 pre-existing duplicate constant declarations
- `schema.js`: `state.settings.region: 'north'` default added
- `SetupScreen.js`: Region selection as Step 2 (4-card grid), full flow now Archetype → Region → Naming → Colors → Take the Job. Fixed pre-existing `createNewGame`→`startNewGame` import bug and config field name mismatches.
- `WeatherEngine.js`: `region` param on `generateWeatherBuffer` and `evaluateGameWeather`, region-weighted condition generation, `_computePostponeProb` uses named constants, `_generateTemp` applies regional `tempOffset`
- `SimEngine.js`: `region` + `consecutiveRoadGames` on `computeWinProbability`, `_computeTravelFatigue` helper, west altitude bonus
- `GameEngine.js`: `startNewGame` sets `s.settings.region` from config
- `cards-pool.js`: `_groundskeeperFlavor` filter pattern documented, 5 universal groundskeeper cards tagged

**Phase 13.6 — Narrative Engine Infrastructure**
- `schema.js`: `state.narrativeFlags: []` added
- `engine/NarrativeEngine.js`: New pure engine — `getFlags`, `setFlag`, `getGMProfile`, `selectCardVariant`, `getRelevantFlags`
- `CardEngine.js`: `flagKey` instrumentation in `resolve()`, `selectCardVariant` wired before `resolveTokens` in `_createInstance`

**Phase 13.7 — Narrative Card Content**
- `cards-pool.js`: 7 card types with `flagKey` fields and `variants` arrays (`i4`, `i6`, `s3`, `s3h`, `t1`, `f1`, `mgr_contract_renewal`). 4 new flag-dependent narrative cards (`narr_long_memory_trade`, `narr_reputation_loyal`, `narr_consequence_facility`, `narr_milestone_witness`). Authorship principle verified clean.

**Phase 13.8 — Franchise History**
- `schema.js`: `state.history: []` added
- `GameEngine.js`: History entries written for trades (commitGame Step 3), season record, championship, prestige tier advancement, Franchise Legend
- `CardEngine.js`: History entry written for serious IL stints (>14 days) in `deliverInjuryAct2`
- `ui/screens/HistoryScreen.js`: New screen — season grouping, collapsible entries, user notes, `openHistory()` / `closeHistory()` API

**Audit #4** — Passed 0 blocking issues. 41/41 files syntax clean.

**Plan updates this session**
- Section 37: GitHub deployment guide (folder structure, icon replacement, step-by-step for non-technical user)
- Section 38: Locked implementation decisions (selectCardVariant wiring order, pre-existing bugs fixed)
- Section 39: xBA/xSLG planned addition (Phase 16)
- Section 40: This status entry

### 40.2 Complete file inventory — current state

All 41 source files complete and passing Audit #4:

```
index.html                    — app shell (unchanged this session)
manifest.json                 — Phase 14 — NOT YET BUILT
sw.js                         — Phase 14 — NOT YET BUILT

data/
  constants.js                ✅ Phase 13.5 — REGIONS, weather thresholds, duplicate fix
  player-names.js             ✅ unchanged
  cards-pool.js               ✅ Phase 13.7 — flagKey, variants, 4 new narrative cards

store/
  schema.js                   ✅ Phase 13.5/13.6/13.8 — region, narrativeFlags, history
  DB.js                       ✅ unchanged
  StateManager.js             ✅ unchanged

engine/
  PlayerFactory.js            ✅ unchanged
  LeagueFactory.js            ✅ unchanged
  RosterEngine.js             ✅ unchanged
  SeasonEngine.js             ✅ unchanged
  LeagueEngine.js             ✅ unchanged
  GameEngine.js               ✅ Phase 13.5/13.8 — region wiring, history entries
  SimEngine.js                ✅ Phase 13.5 — region + travel fatigue
  WeatherEngine.js            ✅ Phase 13.5 — region-aware generation
  InjuryEngine.js             ✅ unchanged
  TradeEngine.js              ✅ unchanged
  CardEngine.js               ✅ Phase 13.6/13.8 — narrative wiring, injury history
  IMPEngine.js                ✅ unchanged
  PrestigeEngine.js           ✅ unchanged
  OffseasonEngine.js          ✅ unchanged
  NarrativeEngine.js          ✅ Phase 13.6 — NEW

ui/
  formatters.js               ✅ unchanged
  EventBus.js                 ✅ unchanged
  App.js                      ✅ unchanged
  Premium.js                  — Phase 18 — NOT YET BUILT

  screens/
    SetupScreen.js            ✅ Phase 13.5 — Region step, import fix
    DashboardScreen.js        ✅ unchanged
    InboxScreen.js            ✅ unchanged
    TeamScreen.js             ✅ unchanged
    LeagueScreen.js           ✅ unchanged
    ScheduleScreen.js         ✅ unchanged
    GameScreen.js             ✅ unchanged
    PlayoffScreen.js          ✅ unchanged
    OffseasonScreen.js        ✅ unchanged
    HistoryScreen.js          ✅ Phase 13.8 — NEW
    ReportsScreen.js          — Phase 16 — NOT YET BUILT

  components/
    RadarWidget.js            ✅ unchanged
    LiveDiamond.js            ✅ unchanged
    Linescore.js              ✅ unchanged
    PlayerCard.js             ✅ unchanged
    CardModal.js              ✅ unchanged
```

### 40.3 Known gaps entering Phase 14

| Item | Phase |
|---|---|
| manifest.json | 14 |
| sw.js (service worker) | 14 |
| Dynamic favicon (team color) | 14 |
| App icons (replace in repo root) | 14 — owner replaces icon-192.png + icon-512.png |
| HistoryScreen wired into Settings gear button | 15 |
| Full offseason wire-up | 15 |
| Full playoff bracket wire-up | 15 |
| Settings screen | 15 |
| Debug panel | 15 |
| Reports screen + xBA/xSLG | 16 |
| Waiver pool UI | 17 |
| ui/Premium.js | 18 |
| Tutorial system | Post-launch |

### 40.4 Audit schedule

| Audit | Timing | Status |
|---|---|---|
| Audit #1 | Post-Phase 9 | ✅ Complete |
| Audit #2 | Post-Phase 12 pre-UI | ✅ Complete |
| Audit #3 | Post-Phase 13 screens | ✅ Complete — 89/89 |
| Audit #4 | Before Phase 14 | ✅ Complete — 41/41, 0 issues |
| Audit #5 | Before first browser test | ⏳ Pending — after Phase 15 |


---

## 41. Standing Operational Rule — Continuous Improvement Checks

Added end of Phase 13.8 session.

After every phase, and at any natural pause point, run a quick scan for:

- **Stale TODO comments** — phase numbers that have passed, deferred items that are now in scope
- **Incomplete resets** — module-level state variables that should clear on mount/init but don't
- **Unwired UI elements** — buttons, modals, or controls that exist in HTML but have no event listeners
- **False positives in audits** — grep results that look like violations but are comments or reads, not active code
- **Pre-existing bugs** — things that were broken before the current phase started, caught incidentally during pre-build checks

These are not full audits. They take 5 minutes and catch the kind of small issues that become confusing the moment you open the app in a browser. The three fixes at the end of the Phase 13.8 session (SetupScreen reset, gear button wiring, stale TODO phases) are the model for this.

This runs in addition to the scheduled full audits — not instead of them.


---

## 42. Compose Channel Overhaul (Phase 15 — Review Point)

> Status: NOTED — review during Phase 15 before Settings screen is finalized.

The compose tab was designed before the narrative engine, geographic region, and franchise history existed. With those systems now in place, the compose prompts are worth revisiting to make sure they're taking advantage of what's been built.

**Specific areas to review:**

- Groundskeeper compose prompts should reflect the franchise's region (a north franchise asks about frost/drainage; a west franchise asks about wind/dust)
- Compose prompts that generate cards should be eligible to trigger narrative variants where relevant (e.g. asking the groundskeeper about field conditions after previously deferring a facility upgrade should feel different)
- The 11-channel structure (Section 8.12) is correct and stays — this is about the prompt content within channels, not the architecture
- Any compose prompt that fires a card which now has a flagKey should ensure the flag is set on resolution — audit this during Phase 15

**What this is not:**
- A structural change to the compose system
- New channels
- New card types

This is a content and wiring review — make sure the prompts and the cards they generate are as good as the systems they sit on top of.


---

## 43. Standing Operational Rule — Runtime Execution Testing

Added after Phase 15 browser testing revealed a class of errors that `node --check` (syntax-only) does not catch.

**The problem:** `node --check` validates syntax only. It does not catch:
- Variables referenced before they are defined (ReferenceError)
- Functions called by the wrong name (_private vs public)
- Import mismatches (wrong export name between files)
- Logic errors that only surface at runtime

**The rule:** After building or modifying any engine file, run an actual import test in addition to the syntax check. The test directory at `/tmp/bgm-test/` mirrors the production folder structure and can be used for this purpose.

**Minimum test after every engine change:**
```bash
node --input-type=module << 'EOF'
import * as M from 'file:///tmp/bgm-test/engine/ChangedEngine.js';
console.log('✅ imports OK');


---

## 43. Standing Operational Rule — Runtime Execution Testing

Added after Phase 15 browser testing revealed a class of errors that node --check (syntax-only) does not catch.

The problem: node --check validates syntax only. It does not catch:
- Variables referenced before they are defined (ReferenceError)
- Functions called by the wrong name (_private vs public)
- Import mismatches (wrong export name between files)
- Logic errors that only surface at runtime

The rule: After building or modifying any engine file, run an actual import test in addition to the syntax check.

Full path test after any change to LeagueFactory, GameEngine, CardEngine, or StateManager: run the startNewGame execution path test. It exercises: createGameState, buildFullLeague, generateUserSchedule, computeFullStandings, computeSeasonPrestige, computeAllIMP.

Bugs caught by this test that syntax-checking missed during Phase 15:
- _computeAge called instead of computeAge in PlayerFactory.js
- playersOut referenced in wrong scope in LeagueFactory.js
- PRESTIGE_POINTS_ALLSTAR_HOST name mismatch in constants.js
- IMP_CS_COST and IMP_MIN_BF_7 missing from constants.js
- get body() getter methods and _onResolve inline functions in cards-pool.js
- Unescaped apostrophes in single-quoted strings in cards-pool.js


---

## 44. Browser Testing Log — Phase 15 (First Browser Test)

All bugs discovered and fixed during the first live browser test of v2.
URL: https://kokanjohn.github.io/baseball-gm/

### 44.1 Deployment fixes (path issues)

These were GitHub Pages subdirectory hosting issues — the app was deployed at /baseball-gm/ but files were referencing paths at the root.

- manifest.json: start_url, scope, and icon paths updated to /baseball-gm/ prefix
- sw.js: all 44 precache asset paths updated to /baseball-gm/ prefix, OFFLINE_URL updated, scope fixed
- index.html: <base href="/baseball-gm/"> added, manifest/icon links changed to relative paths
- App.js: service worker registration path fixed to /baseball-gm/sw.js with correct scope

### 44.2 App initialization bugs

- App.js called StateManager.load() with no argument → DataError. Fixed to StateManager.init().
- App.js called StateManager.get() before checking if slot loaded → ReferenceError. Fixed to guard on hasSlot return value.
- App.js never called SetupScreen.mount() → swirly background with no content. Fixed by adding mount() call after _showScreen('setup').
- App.js never mounted any screens before switchTab() → blank dashboard, broken nav. Fixed by importing and mounting all 5 screens before switchTab('dashboard').

### 44.3 Runtime reference errors (caught only in browser, not by node --check)

These required actual code execution to surface — syntax checking alone is insufficient.

- PlayerFactory.js: _computeAge called instead of computeAge (private vs public name mismatch)
- LeagueFactory.js: playersOut referenced inside buildLeagueRosters where variable is called players
- constants.js: PRESTIGE_POINTS_ALLSTAR_HOST missing (PrestigeEngine imports this name, constant exported as PRESTIGE_POINTS_ALLSTAR_HOSTED)
- constants.js: IMP_CS_COST and IMP_MIN_BF_7 missing entirely
- SetupScreen.js: region cards used archetype-card CSS class, causing archetype listener to fire on region taps and overwrite _archetype with undefined. Fixed by giving region cards their own region-card class.
- cards-pool.js: Multiple v1-incompatible patterns required full cleanup:
  - All get body(), get subject(), get yesLabel(), get yesEffect(), get yesMsg() getter methods replaced with static values
  - All _onResolve, _onExpire inline function blocks removed (referenced undefined state, pickName, applyTagModifier)
  - 3 missing closing braces (rv4, op3, tier_fa_interest) left by _onResolve removal
  - dl1 getter methods removed, static values added
  - s3h card duplication fixed
  - All unescaped apostrophes in contractions inside single-quoted strings escaped

### 44.4 Screen rendering fixes (first dashboard load)

- updateHeader read state.userTeam.name (field doesn't exist). Fixed to construct from city + nickname.
- settings CSS had two conflicting .settings-row definitions. Old definition overriding new icon-layout style. Unified to single definition.
- Tier badge (Cellar Dweller) overflowing header. Fixed with max-width:110px and text-overflow:ellipsis.
- _gameStatusBadge returning PRE-GAME when no scheduled time. Fixed to return game date string instead.
- DashboardScreen/ScheduleScreen reading game._scheduledMs (doesn't exist). SeasonEngine already stores Unix ms in game.gameTime. Fixed to read game.gameTime.
- Weather radar showing ugly placeholder when no weather generated. Fixed to hide radar entirely when hourlyFrames is empty.
- Default sun emoji (☀️) on every schedule row. _makeGameObject defaults weather.label to Clear which maps to ☀️. Fixed by only showing weather icon when game._weatherGenerated is true.

### 44.5 Screen feature gaps fixed

Dashboard:
- Wins/losses cards opened schedule screen. Changed to open a game log bottom sheet showing game-by-game W/L results.
- First pitch countdown now reads game.gameTime correctly, shows seconds in final minute, adds haptic feedback in final 60s.

Team screen:
- Sections expanded by default. Fixed: _groupOpen initializes hitters/pitchers to false.
- Status showed ACT/BENCH. Fixed to Active/Bench.
- Bench↔starter move buttons missing entirely. Added swap buttons to all hitter/pitcher rows with _handleSwap function.

Schedule screen:
- Opponent team names not clickable. Added data-opp attribute and _openTeamModal function.

League screen:
- Default tab was standings. Changed to players.
- Players tab missing last-name search. Added search input and _lpSearch filter.
- Players tab had only All/My Team filter chips. Added per-team chips for all 9 CPU teams.
- Teams not clickable in Teams or Standings tabs. Added click handlers and _openLeagueTeamModal function.
- Stat leaders blank (required 30 AB / 5 IP threshold). Threshold lowered to 1 AB / 0.1 IP so leaders appear from game 1.

GameEngine:
- New game start had empty inbox. Fixed by seeding sp1, sp2, and one random trade card after startNewGame saves state.

### 44.6 Standing rule additions (from this session)

Section 43 formalized: runtime execution testing required after every engine change. node --check alone is not sufficient. Use /tmp/bgm-test/ test directory which mirrors production folder structure.

The full startNewGame execution path test must be run after any change to LeagueFactory, GameEngine, CardEngine, or StateManager.

### 44.7 Known remaining issues (as of this log entry)

Cosmetic/UX issues still to address:
- Settings modal color swatches not showing team creation colors on open
- No reset/new game option in settings
- Install to home screen button unnecessary (owner uses Chrome menu)
- Dashboard stat cards (morale, atmosphere, owner trust) visual polish
- W/L game log modal score format (score.user vs score.us field name mismatch likely)
- Overall UI polish pass needed — v2 is functional but not yet as polished as v1 was after iteration

Next phase after current fixes are confirmed working:
- Phase 16: Reports screen + xBA/xSLG
- Ongoing: UI polish pass



---

## 45. UI Polish Pass — Session 2 (June 3, 2026)

### 45.1 Screen-by-screen port philosophy established

After initial browser testing revealed a large gap between v2 scaffolded screens and v1 look/feel, we established the correct approach: for each screen, read the full v1 implementation first (all CSS, all event handlers, all render logic), then produce a complete replacement adapted to v2 state shape. Patching is slower and produces worse results than a proper port.

### 45.2 DashboardScreen — full port

- Week banner now shows SPRING TRAINING / SPRING GAME N / OPENING DAY / GAME N (not record)
- Stat cards W/L/OVR are centered, OVR color updates dynamically based on actual rating
- Progress bars use _barColor() for precise color gradients (green/gold/orange/red)
- Next game card shows last game W/L badge, spring training badge, game time formatted
- First pitch countdown reads game.gameTime (Unix ms, not _scheduledMs which didn't exist)
- Radar widget hidden when no weather data generated yet
- Wins/losses tap opens a game log bottom sheet instead of navigating to schedule
- Haptic feedback in countdown final 60 seconds
- _barColor() helper added
- ngc-last, ngc-right, recap-btn, season-done-card CSS added to index.html

### 45.3 InboxScreen fixes

- Single-action cards (autoResolve:'yes') show one centered button, not both Yes/No
- Compose tab rebuilt: flat recipient grid, inline topic list, stateful _composeChannel/_composeTopic
- Topic cooldowns show remaining games per topic
- _composeChannel and _composeTopic added to module state, reset on tab switch
- _showTopicPanel/_hideTopicPanel removed (replaced by stateful refresh approach)

### 45.4 TeamScreen fixes

- Sections collapsed by default (_groupOpen hitters/pitchers: false)
- Status labels show "Active"/"Bench" instead of "ACT"/"BENCH"
- Swap buttons added to all hitter/pitcher rows (Bench/▲ Start, Bench/▲ Active)
- _handleSwap function added — moves players between starter/bench slots
- Role parameter threaded through _renderPitcherRow and _renderPitcherGroup

### 45.5 ScheduleScreen fixes

- Score field fallback: score.us ?? score.user and score.them ?? score.opponent
- Weather icon only shown when game._weatherGenerated is true (no more default sun)
- Opponent team names clickable — _openTeamModal function added
- _scheduledTime reads game.gameTime (Unix ms) correctly after SeasonEngine fix

### 45.6 LeagueScreen fixes

- Default tab changed from standings to players
- Last-name search input added (_lpSearch filter)
- Per-team filter chips added for all 9 CPU teams
- Teams clickable in both Teams and Standings tabs — _openLeagueTeamModal added
- Stat leaders threshold lowered from 30 AB / 5 IP to 1 AB / 0.1 IP
- PCT column added to standings
- lp-chip-sm CSS added for smaller team chips
- lgt-card cursor:pointer added

### 45.7 Settings modal — full rebuild

- Franchise info section added: GM name, team, season (all read from state on open)
- Color swatches now reflect actual saved colors when settings opens
- _initSettingsPickers (wires listeners once at init) separated from _refreshSettingsSwatches (updates display on open)
- Reset button changed to "New / Switch Team" → opens TeamSelectScreen
- Install button removed (user accesses via Chrome menu on Android)
- "Danger Zone" section label changed to "Teams"

### 45.8 GameEngine — colors fix

- startNewGame was writing config.region to state.settings but NOT writing primaryColor or secondaryColor
- Fixed: state.settings.primaryColor and state.settings.secondaryColor now saved on new game start
- This was the root cause of settings modal always showing gold/green defaults

### 45.9 TeamSelectScreen — new screen

Built full Load or Start a Team screen (ui/screens/TeamSelectScreen.js):
- Shows all saved teams as tappable cards (tap = load)
- Active team has gold border and ACTIVE badge
- Each card shows: team name, archetype, season, W-L, last-played time, Tier X of 5 badge
- Delete button on each card with confirmation sheet
- New Team card at bottom goes straight to setup (no free-tier gate during development)
- Added to sw.js precache
- Wired into App.js via _openTeamSelect() helper
- Settings "New / Switch Team" button opens this screen
- SAVE_SLOT_LIMIT_FREE raised to 99 (TODO Phase 18: lower to 1)

### 45.10 SetupScreen — archetype step redesign

Complete redesign of Step 1 (archetype selection):
- Layout: 2-column grid, 3 rows (3 difficulty groups)
- Difficulty grouping: Easy (Institution/Empire), Normal (Contender/Gambler), Hard (The Lab/Ember)
- Difficulty rationale: roster strength is the primary difficulty axis — Empire starts with max roster (easiest), Ember starts with minimum (hardest)
- Each difficulty group wrapped in faint border with centered inline label (EASY/NORMAL/HARD)
- Icons removed from all archetype cards
- Real dot elements (arch-dot/arch-dot.filled) replace text strings (●●○○○)
- Dot rows in two aligned columns (label col + dots col) centered within each card
- No taglines at bottom of cards
- Card names and premises centered
- Premises shortened to one line
- "CONTINUE" button (all caps, no arrows) pinned to bottom
- "Team Type" replaces "Choose Your Franchise"
- Logo/diamond/title removed from all setup steps
- All steps now use consistent step-header pattern

### 45.11 App name

"The Front Office" conflicts with a well-known soccer GM app. Using "Your Team" as placeholder in setup screen title. Final name TBD after playtesting. Candidates discussed: The War Room, Club Control, The Hot Corner.

### 45.12 SeasonEngine — gameTime field clarification

- _parseGameTime already returns Unix ms timestamp stored in game.gameTime
- DashboardScreen and ScheduleScreen updated to read game.gameTime (not game._scheduledMs)
- Bad _makeGameObject modification reverted

### 45.13 Initial inbox cards seeding

- startNewGame now delivers sp1, sp2, and one random trade card after saving state
- Inbox no longer empty on first load

### 45.14 SAVE_SLOT_LIMIT_FREE

- Raised to 99 in constants.js for full testing
- TODO Phase 18: lower back to 1



---

## 46. UI Polish & Sim Realism — Session 3 (June 6, 2026)

### 46.1 Session scope

This session covered: schedule screen overhaul, live game engine bugs, full sim realism (Option C runner advancement), league screen rebuild, team/player interconnection, CPU team names by region, and a comprehensive set of bug fixes. Every file that ships has been ES-module checked before delivery.

---

### 46.2 ScheduleScreen — full overhaul

**Month grouping**
- Spring training games now fall under the March month group (no separate "Spring Training" section)
- All months render as collapsible month groups with the same header pattern
- Month headers show game count ("22 Games") instead of chevrons
- Only the current month is open by default; all others are closed
- Manual toggles are preserved across refreshes — auto-open only fires when `currentGameIndex` moves into a new month
- `_monthOpen` keyed by 'YYYY-MM'

**Spring training schedule**
- Spring training anchored to March 14, no day-of-week rolling
- 10 games with off-day pattern `[2, 5, 8]` (game-game-off-game-game-off-game-game-off-game-game)
- Last spring game lands ~March 26-28; Opening Day is April 1 (no Monday roll)
- CPU teams also get 10 spring training games in `generateCPUSchedules` with the same date pattern, so the Scores modal shows full league during spring training

**Scores modal**
- "Scores" button added to schedule header
- Day navigation: prev/next day arrows + month jump buttons
- User's game shown first with accent border; CPU games below
- User's game: live score + inning indicator when active; final score when committed; scheduled time when upcoming
- CPU games: final score when played; scheduled time when not yet played
- Refreshes every 5 seconds while open
- Spring training CPU games now appear (previously empty)
- "No games today" shown on true off days

**Player tap from team modal**
- Tapping a team name on the schedule screen opens the team modal
- Tapping a player in the team modal opens `openPlayerCard` (canonical PlayerCard.js)
- `roster:changed` listener added so team name changes from settings reflect immediately

**Bugs fixed**
- March header not collapsing — auto-reopen logic was fighting manual toggle; removed
- `_openTeamModal` function declaration was missing (orphaned function body at module scope) — restored
- Duplicate `_renderGroup` function declaration causing `SyntaxError: Unexpected end of input` — removed
- `(missed)` note removed from committed game rows

---

### 46.3 DashboardScreen — live game fixes

**OPP/US in linescore while staying on dashboard**
- `_onTick` was calling `_renderLinescore(ds)` without abbr params, causing fallback to `'OPP'`/`'US'` on every tick
- Fixed: `_onTick` now derives `userAbbr`/`oppAbbr` from state and passes them to `_renderLinescore`

**3 outs displayed before half flip**
- `_deriveGameState` was reading `curHalf`/`curInning` from the last play without advancing when outs=3
- Fixed: when `outs >= 3 && !isFinal`, code advances `curHalf` (TOP→BOT or BOT→TOP+inning++) and resets `outs = 0`
- Display now immediately shows the upcoming half with 0 outs

**PBP null entries**
- Old `_onTick` PBP handler had three branches that could miss plays
- Simplified to: `if (play && play.description && play.type !== 'inning_end' && play.type !== 'game_end')`

**game_start announcement**
- Was showing both SPs: "Corporan takes the mound. Lopez starts for the home team."
- Now shows only the relevant pitcher: away SP when user is home, user SP when user is away

**R H E linescore**
- Linescore now shows three totals columns: R (runs), H (hits), E (errors)
- H and E tracked from play sequence in `_deriveGameState`
- E column header is red; E values are red when non-zero, muted when zero
- `totalAwayHits`, `totalHomeHits`, `totalAwayErrors`, `totalHomeErrors` added to `_deriveGameState` return

**IMP hot/cold strip**
- Gated to `gamesPlayed >= 3` so it doesn't show pre-game with default values

**Countdown timer**
- Changed `Math.floor(diffMs / 60000)` to `Math.ceil(...)` so countdown shows one more minute (rounds up)

---

### 46.4 SimEngine — Option C full runner advancement

This was a major rewrite of `_advanceBases` and `_simulateHalfInning`. All runner advancement is now modeled with realistic probabilities.

**New play types**
- `double_play` — batter out + runner out; `extraOuts = 1` signals second out to half-inning loop
- `fielders_choice` (FC) — batter reaches first safely, lead runner out; no AB charged
- `error` (E) — batter reaches safely, no out; no AB charged
- `sac_fly` (SF) — flyout scoring a runner from third; no AB charged, `sf: 1` stat recorded
- `sac_bunt` (SH) — batter out, runners advance one base; no AB charged, `sac: 1` stat recorded
- `stolen_base` (SB) — between-pitch runner advancement; `sb: 1` stat
- `caught_stealing` (CS) — failed steal; runner out, `cs: 1` stat

**Runner advancement model**
- **Double:** runner from first tries to score; throw-out probability roll based on `SIM_THROWOUT_PLATE_BASE = 0.28` minus speed factor. Can be thrown out at plate — otherwise stops at third
- **Single:** runner from second: throw-out roll at plate. Runner from first: if speed ≥ 70, tries for third with throw-out check
- **Flyout:** tag-up from second now possible (50% of fast runners try for third). Throw-out check at third
- **Groundout:** checks in order — error (6%), double play (40% with runner on first, <2 outs), fielder's choice (30% of remainder), standard groundout

**Stolen base attempts**
- `_attemptStolenBase` runs before each at-bat if fast runner on base and <2 outs
- Threshold: `SIM_H_SPEED_SB_THRESHOLD = 65`; attempt prob: `SIM_SB_ATTEMPT_PROB = 12%`
- Success rate: `SIM_SB_BASE_SUCCESS = 68%` + speed/500
- Second stealing third: 70% of first→second attempt rate

**Sac bunt**
- Checks before normal at-bat resolution: low-power (`power ≤ 45`), runners on, <2 outs, inning 6+, 18% chance
- 85% success (batter out, runners advance); 15% fail (treated as weak groundout)

**`_buildStatDeltas` — stat accuracy**
- No AB on sac fly, sac bunt, walk, HBP, error, FC
- `sf`, `sac`, `sb`, `cs` counters added
- Pitcher `ip` only charged on actual batter outs (not FC, error)

**New constants added to constants.js**
- `SIM_THROWOUT_PLATE_BASE`, `SIM_THROWOUT_EXTRA_BASE`, `SIM_SPEED_THROWOUT_DIVISOR`
- `SIM_SB_BASE_SUCCESS`, `SIM_SB_SPEED_BONUS_DIVISOR`, `SIM_SB_ATTEMPT_PROB`
- `SIM_FC_PROB`, `SIM_DP_PROB`, `SIM_ERROR_PROB`
- `SIM_SAC_BUNT_POWER_MAX`, `SIM_SAC_BUNT_INNING_MIN`, `SIM_SAC_BUNT_PROB`

**`_isOut` updated**
- Now includes `sac_bunt` and `caught_stealing`

**DashboardScreen box score updated**
- AB correctly excludes sac fly, sac bunt, walk, HBP
- Stolen bases counted in box score
- Pitcher outs: double play correctly adds 2
- New play type icons: `double_play: '▲▲'`, `fielders_choice: 'FC'`, `sac_fly: 'SF'`, `sac_bunt: 'SH'`, `error: 'E'`, `stolen_base: 'SB'`, `caught_stealing: 'CS'`

---

### 46.5 SimEngine — W/L/SV/HD pitcher decisions

`_assignPitcherDecisions(plays, userScore, oppScore, isHome)` — post-processing function that runs after simulation completes, assigns pitcher decisions using real baseball rules:

- **Win:** SP gets win if ≥15 outs (5 innings); otherwise goes to pitcher on mound when user took permanent lead
- **Loss:** Pitcher who gave up the go-ahead run that held
- **Save:** Last pitcher used if: user won, entered with lead ≤3, recorded ≥1 out, doesn't have the win
- **Hold:** Middle relievers who entered in save situation, recorded ≥1 out, left with lead intact

Decisions attached to `game_end` play as `_statDeltas`; `accumulateStats` now allows `game_end` plays through for this purpose. `w`, `l`, `sv`, `hd` stats accumulate correctly at commit time.

---

### 46.6 LeagueFactory — region-specific team names

`LEAGUE_TEAMS` replaced by `LEAGUE_TEAMS_BY_REGION` — four regions × 9 teams each. All city names and team nicknames are completely fictional (no real MLB, MiLB, or other professional team names).

| Region | Teams |
|---|---|
| North | Ironfield Bears, Greystone Foxes, Northhaven Pines, Ridgecrest Owls, Hollowbrook Herons, Coldwater Elk, Frostburg Lynx, Ashmont Ravens, Clearfield Bucks |
| South | Bayside Pelicans, Palmetto Kings, Sunridge Hawks, Copperfield Bulls, Bayou Herons, Crestview Gators, Suncoast Tarpon, Delta Cranes, Mossglen Foxes |
| East | Harborview Gulls, Tideland Anchors, Seagrove Osprey, Lightshore Breakers, Millbay Sails, Cliffport Herons, Cheswick Skippers, Reedmont Cranes, Gulfport Mullets |
| West | Mesaview Condors, Peakstone Pumas, Canyon Rams, Dryrock Hawks, Highgrass Coyotes, Arroyo Dust Devils, Ridgeway Eagles, Sundusted Vipers, Saltflat Scorpions |

- `buildFullLeague` accepts `region` param; selects correct team set
- `buildLeagueRosters` accepts optional `teamDefs` param (defaults to north)
- `startNewGame` passes `config.region || 'north'` to `buildFullLeague`
- `_LEAGUE_TEAM_DEFAULTS_BY_REGION` in App.js matches all four regions for the Settings team name reset button
- `LEAGUE_TEAMS` backward-compat export points to north set

---

### 46.7 player-names.js — real player name audit

16 real MLB player names removed and replaced with fictional alternatives:

| Old | New |
|---|---|
| Robinson Cano | Roberto Canosa |
| Johan Santana | Jorge Santamaria |
| Felix Hernandez | Felix Herreros |
| Adrian Beltre | Andres Beltran |
| Miguel Cabrera | Miguel Cabrales |
| Yadier Molina | Yadier Moreira |
| Carlos Beltran | Carlos Beltrado |
| Pablo Sandoval | Pablo Sandiago |
| Hanley Ramirez | Hanley Restrepo |
| Asdrubal Cabrera | Andres Cabrales |
| Victor Martinez | Victor Maravilla |
| Freddy Garcia | Freddy Galvez |
| Erick Aybar | Erick Aguilar |
| Pedro Strop | Pedro Estrada |
| Javier Santana | Javier Salinas |
| Hyun-Jin Jin | Hyun-Soo Jin |

---

### 46.8 LeagueScreen — Players tab rebuild

**Position filter**
- Row 1: `Batters | Pitchers`
- Row 2: `C | 1B | 2B | 3B | SS | OF | DH | SP | RP`
- Position families: clicking `2B` shows `2B` and `2B/SS` players; `1B` → `1B/3B`; `SS` → `2B/SS`; `3B` → `1B/3B`; `DH` → `DH/OF`; `OF` → `DH/OF`
- Defaults to `Batters`

**Roster/team filter bar**
- `All | Other Teams | [team dropdown] [last name search]`
- "Other Teams" hides user's own players (not "On Rosters" which was ambiguous)
- Team dropdown: 130px wide; last name search: 90px fixed
- Search bypasses all other filters — any player findable by name regardless of pos/team/roster state

**Search focus bug fixed**
- `refresh()` was replacing the DOM and destroying input focus
- Fix: save cursor position before refresh, re-find input by ID after refresh, restore focus + cursor position
- Only one search event listener (old code had two)

**Column changes**
- `Form` → `IMP`, `OVR` → `RTG`, `SV+H` → `SVHD`
- No sort arrows in column headers — active column highlighted only
- Clicking same column toggles asc/desc

**Pitcher stats added**
- IP, BB, SVHD (saves + holds) added to pitcher view
- ERA calculation uses `outs` field (from sim) correctly

**IMP as first stat column**
- Shows `+2.4` / `-1.8` / `—` in colored badge
- Hot/cold emoji removed from player rows (IMP number is sufficient)

**Sticky header**
- Filter bars + column headers are `position: sticky; top: 0`
- Only `#lp-list` scrolls

**`roster:changed` listener added**
- Team name changes from settings now immediately refresh the Players tab

---

### 46.9 LeagueScreen — Teams and Standings tabs

**Teams tab**
- Every team card (both divisions including user's team) opens `_openLeagueTeamModal`
- Modal shows Hitters / Pitchers sections with tappable player rows
- Tapping a player opens `openPlayerCard` (canonical PlayerCard.js)
- Modal has proper flex layout with scrollable body

**Standings tab**
- Every standing row (including user's own row) is tappable with `cursor: pointer`
- Tapping opens `_openLeagueTeamModal` → same player drill-down as Teams tab

**Team grade column (TODO Phase 17)**
- v1 showed a trade relationship grade for each CPU team based on trade history
- Currently shows `—` (no trades have occurred)
- Will be implemented in Phase 17 (Waiver/Trade UI) when trade tracking is active

---

### 46.10 PlayerCard.js — emoji removal

- GM Relationship labels: `😊 Strong` → `Strong`, `😤 Strained` → `Strained`, `😐 Neutral` → `Neutral`
- Bar color and label text still communicate the relationship tier without emojis

---

### 46.11 SeasonEngine — spring/season timing

- Spring training: starts March 14, no day-of-week rolling, 10 games, ends ~March 26-28
- Regular season: starts April 1 exactly, no Monday rolling
- `generateCPUSchedules` now includes 10 spring training CPU games matching the same date pattern
- `SPRING_TO_SEASON_GAP_DAYS = 18` for the `startDateOverride` path

---

### 46.12 Universal stale-screen fix

**Problem:** After saving team name changes in Settings, screens showing team names didn't update until the user navigated away and back.

**Root cause:** `_applyLeagueTeams` in App.js emits `roster:changed`, but not all screens were listening to it.

**Fix:** `roster:changed → refresh()` listener added to:
- LeagueScreen (new)
- ScheduleScreen (new)
- DashboardScreen (was already present)

**Rule going forward:** Any screen that displays team names must wire `roster:changed → refresh()`. This is the canonical event for any mutation to `state.leagueTeams` or `state.userTeam` name/abbr fields.

---

### 46.13 EventBus listener cleanup — universal fix

**Problem:** All screens that use EventBus were storing the return value of `EventBus.on()` (which returns the handler function) then trying to destructure as `[event, handler]` in `unmount()`. `EventBus.off()` was called with garbage arguments and handlers were never removed. Every tab switch added a new set of handlers.

**Fix applied to:** TeamScreen, LeagueScreen, InboxScreen, DashboardScreen, ScheduleScreen.

**Pattern (canonical):**
```js
const wire = (event, handler) => {
  EventBus.on(event, handler);
  _listeners.push({ event, handler });
};

// In unmount:
_listeners.forEach(({ event, handler }) => EventBus.off(event, handler));
```

---

### 46.14 PlayerCard.js — canonical player detail sheet

`ui/components/PlayerCard.js` deployed for the first time. All player detail entry points now use this single component:
- TeamScreen: tapping a player row
- LeagueScreen Players tab: tapping a player row
- LeagueScreen Teams tab: team modal → player row
- LeagueScreen Standings tab: standing row → team modal → player row
- ScheduleScreen: opponent team modal → player row

The custom `_openPlayerSheet` function previously built into ScheduleScreen was removed and replaced with `openPlayerCard` from the canonical component.

---

### 46.15 Service worker cache versioning

Cache version bumped to `tfo-v2-r20` over the course of this session (r2 through r20). Every deployment batch bumps the version. Rule: bump whenever 3+ JS files change in a batch.

---

### 46.16 Known pending items (as of Session 3)

**Phase 7 — WeatherEngine wiring (deferred)**
- WeatherEngine.js is fully built (698 lines) but not called from GameEngine
- Infrastructure in place: `GAME_STATUS.POSTPONED/DELAYED/SUSPENDED`, `scheduleMakeupGame`, `resumeSuspendedGame`
- Needs: automatic weather evaluation on each tick, CPU team postponements, doubleheader scheduling
- Dedicated phase required — touches tick loop, card delivery, groundskeeper system

**Phase 17 — Trade grade column in Teams tab**
- v1 showed a trade relationship grade for each CPU team (how many trades, how equitable)
- Currently shows `—` (no trades have occurred yet)
- Wire when trade tracking is active in Phase 17

**All-Star hosting**
- `evaluateAllStarHostingEligibility` imported in GameEngine but never called at `PHASE.ALL_STAR_BREAK`
- `_hostedAllStarThisSeason` flag exists on `userTeam`
- `ALL_STAR_WEEK` milestone with `requiresHosting: true` exists
- Wire in Phase 19

**Spring roster expansion (38-man) — Phase 15**
- 10 invitees from farm (5H+5P), Opening Day cut to 28, keeper tags
- Not yet built

**Phase 16 — Reports screen + xBA/xSLG**
**Phase 17 — Waiver pool UI + trade system**
**Phase 18 — Monetization**
**Phase 19 — All-Star Game hosting**

**Sim realism — intentional walk (IBB)**
- Not modeled; could approximate by bumping walk probability for high-power batters with bases loaded
- Low priority — rare in real baseball

**Diamond/out dots — verify in live testing**
- All new play types (stolen_base, caught_stealing, double_play, FC, error, sac_fly, sac_bunt) set `_basesAfter` and `outsAfter` correctly
- Has not been verified in a live game since Option C implementation


---

## 47. TeamScreen Full Rebuild — Design Spec (Session 3, pre-implementation)

### 47.1 SP/RP designation + handedness on all pitcher rows

- Remove slot numbers (#1, #2) from rotation rows — never show these
- Every pitcher row (rotation, bullpen, bench) shows `player.pos` (SP/RP) and `player.hand` (L/R) inline after the player name, same pattern as farm rows
- During spring training, invitee pitcher rows also get an "ST" badge
- Format: `Name · SP · R` or `Name · RP · L`

---

### 47.2 Roster optimization (ropt) bar + hint button

**The bar:**
- Sits in the Team screen header alongside the payroll bar
- Label: "Lineup OPT" with percentage value colored green (≥90), blue (≥60), red (<60)
- `?` hint button to the right of the percentage

**`_calcRopt(state)` — pure function:**
- For each active hitter slot: compare starter OVR vs best eligible bench hitter for that slot (using `_eligibleSlots` — see 47.3)
- For each rotation slot: compare active SP OVR vs best bench SP
- For each bullpen slot: compare active RP OVR vs best bench RP
- Score = `Math.floor(activeSum / bestPossibleSum * 100)`
- Returns `{ score: Number, moves: Array<String> }`
- Spring invitees on bench are included as candidates

**Team OVR card:**
- Small card in header row alongside payroll: "OVR: 71"
- Computed as average OVR of all active starters (9 hitters + 5 SP + 5 RP = 19 slots)
- Same color tier as player row OVR badges

**Hint sheet:**
- Bottom sheet listing up to 5 specific suggested swaps
- Format: "Start Torres (72) over Martinez (65) at SS"
- Pitchers: "Move SP Reyes (71) into rotation over Santos (64)"
- If already 100%: "Your best available players are all active."

---

### 47.3 Position eligibility (`_eligibleSlots`)

Port of v1's `eligibleLineupSlots`. Every bench hitter is eligible for their natural position(s) AND DH. Used by ropt calculation and swap modal.

```
C       → [C, DH]
1B      → [1B, DH]
2B      → [2B, DH]
3B      → [3B, DH]
SS      → [SS, DH]
OF      → [OF, DH]
DH/OF   → [OF, DH]
2B/SS   → [2B, SS, DH]
1B/3B   → [1B, 3B, DH]
SS/OF   → [SS, OF, DH]
1B/OF   → [1B, OF, DH]
other/  → split on / + DH
```

---

### 47.4 Swap modal — always a 1-for-1 exchange

**Rule:** Nobody moves without a replacement going the other way. Roster counts stay exactly right at all times.

**Bench hitter → starter (▲ button):**
1. Show slot picker: `[natural pos(es)] + [DH]` — always shown, even single-position players have DH option
2. Slot chosen → show current starter at that slot → confirm swap
3. If slot is empty → promote directly, no confirmation needed
4. If no bench players eligible for any slot → button disabled

**Starter → bench (Bench button):**
1. Show bench players eligible for that starter's slot
2. Bench player chosen → swap atomically
3. If no eligible bench players exist for that slot → Bench button is **disabled** (not greyed with a message — just disabled)

**Bench pitcher → active (▲ button):**
- SP → show current 5-man rotation → tap one to replace
- RP → show current bullpen → tap one to replace
- If rotation/bullpen not full → promote directly

**Active pitcher → bench (Bench button):**
- Show bench pitchers of same type (SP shows SP bench, RP shows RP bench)
- Tap to swap
- If no bench pitchers of same type → button disabled

**Multi-position players (2B/SS, 1B/3B, etc.):**
- Step 1 slot picker always fires — user picks which slot to fill
- Step 2 shows the starter at that specific slot
- Back button in modal returns from step 2 to step 1

**Spring training — expanded bench:**
- Same flow, more choices
- Invitees appear as options in both directions
- Keeper tags are completely independent of lineup decisions

**Enforcement:**
- Hard caps: 9 `STARTING_HITTERS`, 5 `STARTING_PITCHERS`, 5 `BULLPEN`
- Bench: uncapped during spring training; normal depth (5H/2SP/2RP) during regular season
- Caps enforced naturally by the swap-only model — you can only promote when someone goes the other way

---

### 47.5 Spring training invitees

**At `startNewGame` and at `advancePhase(SPRING_TRAINING)` for subsequent seasons:**
- Pull top 5 farm hitters and top 5 farm pitchers by OVR
- Set `player._isSpringInvitee = true`, `player._isKeeper = false`
- Assign real bench groups: `BENCH_HITTERS` or `PITCHER_BENCH`
- Move IDs from `farmIds` → `rosterIds`
- Farm section now shows only remaining farm players — no player appears in two places

**Keeper toggle (Option B — tag during spring, maximum flexibility):**
- Every player row during spring shows a keeper badge (solid pill = keeper, outline = cut)
- Default: regular roster players start as `_isKeeper: true`, invitees start as `_isKeeper: false`
- Tap to toggle at any time during spring training
- Cap: cannot tag more than 28 keepers; toast fires if user tries: "Untag another player first"
- Counter shows "Keepers: 26/28" in the section header
- Keeper tag is independent of lineup decisions — starting an invitee does not auto-tag them

**Keeper badge is visible on all player rows during spring (hitters and pitchers), including:**
- Starting lineup players
- Bench players
- Spring invitees (who also show "ST" badge)

**At `advancePhase(REGULAR_SEASON)`:**
1. Read all players where `_isKeeper: true`
2. If exactly 28 → `applySpringCuts(state, keeperIds)` directly
3. If < 28 → auto-fill from untagged regular roster players by OVR descending; toast: "Your roster was filled automatically"
4. Hard guard: if > 28 (shouldn't happen due to cap) → drop lowest-OVR excess keepers
5. Non-keeper invitees: `_isSpringInvitee: true` → return to `farmIds`, reset to `PRACTICE_SQUAD`
6. Non-keeper regular players → waived (not farm)
7. Clear `_isSpringInvitee` and `_isKeeper` flags from all players

**No player in two places guarantee:**
- Spring start: invitee leaves `farmIds`, enters `rosterIds`
- Spring end: non-keeper invitees leave `rosterIds`, return to `farmIds`
- A player is either in `rosterIds` OR `farmIds`, never both

---

### 47.6 Files that change

| File | What changes |
|---|---|
| `constants.js` | Add `SPRING_INVITEE_HITTERS: 5`, `SPRING_INVITEE_PITCHERS: 5` to `ROSTER_LIMITS` |
| `schema.js` | Add `_isSpringInvitee: false`, `_isKeeper: false` to player schema |
| `GameEngine.js` | `_addSpringInvitees()` at `startNewGame` and `advancePhase(SPRING_TRAINING)`; `advancePhase(REGULAR_SEASON)` reads keeper flags |
| `RosterEngine.js` | `toggleKeeperTag(state, playerId)`; update `applySpringCuts` to use keeper flags |
| `TeamScreen.js` | SP/RP+hand labels; ropt bar+hint; swap modal with slot picker; keeper toggle+ST badge; slot caps enforced; no slot numbers |

---

### 47.7 Card system updates required (Phase 15 — deferred)

**Edit existing cards:**
- Spring training standout cards currently reference the old competition system (incumbent vs challenger, cards firing around game 12-15)
- These need to be rewritten to reference the keeper system — e.g. "Torres has been outstanding this spring. Consider tagging him as a keeper." rather than "Will you start Torres or Martinez on Opening Day?"
- All `triggerPhase: 'SPRING_TRAINING'` cards in CardEngine need audit

**New cards to add:**
- **Thin at position warning:** If the user has fewer than 2 eligible bench players for a given position slot (e.g. only one catcher on the entire 38-man roster including invitees), a card fires early in spring: "You're thin at catcher — consider calling up a prospect or monitoring your depth."
- **Keeper deadline reminder:** Around spring game 8 (of 10): "Opening Day is approaching. You have [N] keepers tagged — you need 28."
- **Auto-resolve notification:** If spring ends with fewer than 28 keepers tagged: "We filled your roster automatically. [X] players were added based on rating."
- **Unexpected invitee breakout:** If an invitee's spring OVR improvement or spring stats significantly exceed expectations, a card fires: "[Name] is making a strong case for a roster spot."

---

### 47.8 Known edge cases

- **Bench button disabled** when no eligible replacement exists for that starter's slot — no message, just disabled state
- **DH slot** — every hitter is eligible for DH; slot picker always includes DH as an option
- **Multi-position bench player** — slot picker fires first, then replacement selection
- **Promoted invitee still shows ST badge** — even if a spring invitee is moved into the starting lineup, their ST badge remains; their keeper tag stays wherever the user set it
- **After spring cuts, `_isSpringInvitee` and `_isKeeper` cleared** — clean state for regular season

---

## 48. TeamScreen Full Rebuild — Implementation (Session 3)

### 48.1 Phase 1 — Data layer (COMPLETE)

**Files changed:** `constants.js`, `schema.js`, `GameEngine.js`, `RosterEngine.js`

**`constants.js`**
- Added `SPRING_INVITEE_HITTERS: 5` and `SPRING_INVITEE_PITCHERS: 5` to `ROSTER_LIMITS`

**`schema.js`**
- Added `_isSpringInvitee: Boolean` and `_isKeeper: Boolean` to player schema comment

**`GameEngine.js`**
- Added `_addSpringInvitees(s)` function — position-scarcity aware selection treating OF as 3 separate slots, ranks farm players by (scarcity DESC, OVR DESC), picks top 5 hitters and 5 pitchers, moves them from `farmIds` → `rosterIds`, sets `_isSpringInvitee: true`, `_isKeeper: false`, assigns real bench groups (`BENCH_HITTERS` or `PITCHER_BENCH`)
- Tags all existing 28-man players as `_isKeeper: true` by default at spring start
- Called in `startNewGame` (season 1) AND new `case PHASE.SPRING_TRAINING` in `advancePhase` (all subsequent seasons)
- Added `case PHASE.SPRING_TRAINING` to `advancePhase` switch
- Updated `case PHASE.REGULAR_SEASON` to use keeper flags: if any keeper tagged → `applySpringCuts`; if none tagged → `autoResolveSpringCuts`
- Added imports: `applySpringCuts`, `toggleKeeperTag` from RosterEngine

**`RosterEngine.js`**
- Added `toggleKeeperTag(state, playerId)` — flips `_isKeeper`, enforces 28-keeper cap, returns `{ error: String }` if cap hit
- Rewrote `applySpringCuts(state)` — now reads `_isKeeper` flags directly (no longer accepts a passed array); auto-fills to 28 from untagged regular players if under; invitees not kept → farm; regular players not kept → waivers; clears both flags from all players after cuts
- Updated `autoResolveSpringCuts` to build a patched state with top-28 tagged then call the new `applySpringCuts`

---

### 48.2 Phase 2 — Display layer (COMPLETE)

**Files changed:** `TeamScreen.js`

**Imports**
- Added `ROSTER_LIMITS` and `PHASE` to constants import

**`_eligibleSlots(player)`** — new function
- Returns array of slot labels a player can fill including DH
- Handles all multi-position combos: `2B/SS`, `1B/3B`, `DH/OF`, `SS/OF`, `1B/OF`, etc.
- Every hitter includes DH in their eligible slots

**`_calcRopt(state)`** — new function
- Returns `{ score: 0–100, moves: String[], teamOvr: Number }`
- Slot-aware: uses `_eligibleSlots` to find best bench candidates per active slot
- SP/RP handled separately from hitters
- `teamOvr` = average OVR across all 19 active starters

**`refresh()` header — second row added**
- Team OVR card alongside payroll card
- Ropt bar row below payroll bar: "Lineup OPT N%" with colored fill (green ≥90, blue ≥60, red <60)
- `?` hint button wired to `_calcRopt` toast — exact v1 format: "To improve: [move] · [move] · [move]" (max 3, joined by ` · `)

**`_renderHitterGroup` / `_renderHitterRow`**
- Now accepts `isSpring`, `allPlayers`, `rosterIds` params
- Keeper badge on every row during spring: `♦` (solid, green) = keeper, `◇` (outline, muted) = cut
- ST badge on invitee rows during spring
- `data-keeper` attribute set for Phase 3 toggle wiring

**`_renderPitcherGroup` / `_renderPitcherRow`**
- Now accepts `isSpring`, `allPlayers`, `rosterIds` params
- **Slot numbers removed** — never show `#1`, `#2` etc.
- SP/RP + handedness shown on every pitcher row always: `SP · RHP`, `RP · LHP`
- Section headers: "Rotation (SP)" and "Bullpen (RP)"
- Keeper badge and ST badge during spring (same as hitters)

**`_renderPlayers`**
- Computes `isSpring` from `state.phase === PHASE.SPRING_TRAINING`
- Computes `keeperCount` from roster during spring
- Renders keeper banner at top: "Spring Camp · Keepers: N/28" (turns accent green at 28)
- Passes `isSpring`, `players`, `rosterIds` down to group renderers

**CSS added:** ropt bar, keeper badge, ST badge, keeper banner, pitcher-pos-hand, player-sub line, row-actions flex column

---

### 48.3 Phase 3 — Interaction layer (COMPLETE)

**Files changed:** `TeamScreen.js`

**Swap buttons — disabled state**
- Hitter starter "Bench" button: disabled if no bench player has the slot in `_eligibleSlots`
- Pitcher "Bench" button: disabled if no bench pitcher of the same type (SP/RP) exists
- `disabled` attribute prevents firing entirely — no message, just visually dimmed (`.swap-btn:disabled { opacity: .3 }`)

**Keeper toggle**
- `[data-keeper]` tap → lazy imports `toggleKeeperTag` from RosterEngine
- Error from cap hit → `App.showToast(result.error, 'negative')`
- Success → `StateManager.mutate` writes `_isKeeper` flip → `refresh()`
- Player card tap guarded: tapping keeper badge does not open player card

**`_handleSwap(playerId, role, state)` — full rewrite**

Four paths, all producing clean 1-for-1 swaps:

| Path | Behavior |
|---|---|
| Bench hitter → starter | `_openSlotPicker` → user picks slot → if empty promote directly; if occupied `_execHitterSwap` |
| Starter hitter → bench | `_openReplacementPicker` showing eligible bench → tap → `_execHitterSwap` |
| Bench pitcher → active | If below cap promote directly; else `_openReplacementPicker` showing active pool → tap → `_execPitcherSwap` |
| Active pitcher → bench | `_openReplacementPicker` showing same-type bench pool → tap → `_execPitcherSwap` |

**`_execHitterSwap(incoming, slot, outgoing)`**
- Single `StateManager.mutate`: sets incoming to `STARTING_HITTERS`, outgoing to `BENCH_HITTERS`
- Fires `roster:changed`, descriptive toast, `refresh()`

**`_execPitcherSwap(incoming, outgoing, isSP)`**
- Single `StateManager.mutate`: sets incoming to `STARTING_PITCHERS` or `BULLPEN`, outgoing to `PITCHER_BENCH`
- Fires `roster:changed`, descriptive toast, `refresh()`

**`_openSlotPicker(player, slots, starters, onSlotChosen)`**
- Step 1 for bench→starter hitter swaps
- Shows each eligible slot with current occupant name + OVR, or "Empty — promote directly"
- Tap closes modal and calls `onSlotChosen(slot)`

**`_openReplacementPicker(title, candidates, onChosen)`**
- Generic picker for all "who comes out?" decisions
- Shows player name, pos/hand, OVR badge
- Tap closes modal and calls `onChosen(player)`

**`_showSwapSheet(title, subtitle, rowsHtml, wireRows)`**
- Shared bottom sheet renderer used by both pickers
- Modal ID `ts-swap-modal` — new open removes any existing one first (no stacking)
- Closes on `×` button or tap-outside

---

### 48.4 Swap modal CSS

`.sm-row`, `.sm-slot-label`, `.sm-slot-sub`, `.sm-current`, `.sm-empty`, `.sm-pick-info`, `.sm-pick-name`, `.sm-pick-sub`, `.sm-pick-ovr`, `.sm-arrow` — all added to `_injectCSS`

---

### 48.5 Items still pending from Section 47

- **Card system updates (Phase 15)** — spring training standout cards need rewriting for keeper system; 4 new card types (thin-at-position, keeper deadline, auto-resolve notification, invitee breakout) — deferred
- **Live testing** — spring invitees on bench, keeper toggle, bench button disabled (only catcher scenario), slot picker for all hitter types, pitcher swap modal, Opening Day cuts on phase transition

---

### 48.6 Cache version

`tfo-v2-r29` after Phase 3 delivery.

---

## 49. Session 3 Close — State of the App (August 2026)

### 49.1 Cache version at close
`tfo-v2-r38`

### 49.2 Work completed this session (not previously documented)

**Regional team names restored (Section 46.6 re-implemented)**
- `LeagueFactory.js` was overwritten from uploads at start of Phase 1 (lineupSlots work), losing `LEAGUE_TEAMS_BY_REGION`
- Re-built from transcript — all 4 regions × 9 teams now in `LeagueFactory.js`
- Old flat array with real-sounding names (New York Empire, LA Palms, etc.) removed
- `buildFullLeague` accepts `region` param; `buildLeagueRosters` accepts `teamDefs`

**TeamScreen fixes (post-lineupSlots)**
- OF slot picker now enumerates all 3 OF slots (was only showing first)
- DH player no longer duplicated in slot picker (`_eligibleSlots` now returns `['DH']` for `pos === 'DH'`, not `['DH','DH']`)
- OVR color numbers fixed — no longer follow team accent color (`!important` overrides in `_injectCSS`)

**TeamScreen payroll bar removed**
- Red progress bar above ropt bars removed; payroll card in header is sufficient

**DashboardScreen countdown fixed**
- `_renderFirstPitchCountdown` was using `Math.floor` while `_startCountdown` used `Math.ceil`
- Now both use `Math.ceil` — no visible jump from 48→49 when dashboard first loads

**Background catch-up**
- `visibilitychange` listener in `App.js`
- On resume: computes elapsed time, calls `tick()` silently for each missed interval
- Single `game:tick` emitted at end with latest play — dashboard refreshes to correct state
- Auto-commits if game reached FINAL during fast-forward

### 49.3 Known issues at close

**CRITICAL: Live box score (Stats tab) does not work properly**
- Stats during a live game are not displaying correctly
- This is the first priority for the next session
- `_buildBoxScore` and `_renderBoxScore` in `DashboardScreen.js` need full audit
- May require ground-up rewrite of the box score accumulation system
- Trace from `_statDeltas` → `accumulateStats` → `_deriveGameState` → render

**MAJOR MISSING: Weather radar display**
- `WeatherEngine.js` (698 lines) fully built but not called anywhere
- Visual radar component needs to be designed and built — flagship visual feature
- Should use real radar color conventions, animated sweep, storm cell movement
- Phase 7 in plan doc
- Should be tackled after live box score is resolved

### 49.4 Project setup for new Claude project
- `PROJECT_SETUP.md` — full onboarding document for new session
- `PROJECT_INSTRUCTIONS.md` — Claude project instructions
- All output files at `tfo-v2-r38` are the authoritative current version

---

## 50. Full-Codebase Audit + Remediation (Session 4)

A senior-review audit of all 42 source files was performed before any changes. Findings clustered into five recurring root patterns rather than isolated bugs: (A) logic duplicated across modules and drifting, (B) `lineupSlots`/`rotation.order` never reconciled after roster changes, (C) locked lifecycle steps never actually implemented, (D) an event-wiring gap, (E) shallow save migration. The remediation is sequenced as batches; new-game required after each batch that touches `constants.js`/`schema.js`/engines.

### 50.1 Batch 0 — Spring-count landmine (COMPLETE, `tfo-v2-r39`)

**Bug:** `SPRING_TRAINING_GAME_COUNT` was `20` in `constants.js`, but the schedule generator produced `10` spring games (hardcoded in two places). The constant drives regular-season index math in `GameEngine` (`gameIndex - SPRING_TRAINING_GAME_COUNT`) and the phase transition in `SeasonEngine.getNextPhase`. With the wrong value: the first regular-season game computed a regular index of `-10` (corrupting IL-return timing), and `getNextPhase` kept schedule positions 10–19 (real regular-season games) in the SPRING phase.

**Root-cause fix (not a patch):**
- `constants.js` — `SPRING_TRAINING_GAME_COUNT` set to its correct value `10` (single source of truth). The off-day pattern `[2,5,8]` is tuned for 10.
- `SeasonEngine.js` — both spring loops (user `_generateSpringGames` and `generateCPUSchedules`) now derive their bound from `SPRING_TRAINING_GAME_COUNT` instead of a hardcoded `10`, so generator and constant can never drift again. Removed the local `SPRING_CPU_GAME_COUNT`.
- `SeasonEngine.generateUserSchedule` — added a fail-loud gate: throws if `springGames.length !== SPRING_TRAINING_GAME_COUNT` (per §1.11 structural gate-test rule). A future divergence surfaces immediately at generation.
- Stale "20 games" comment corrected.

**Verified:** first regular game → regular index `0`; phase at first regular game → `REGULAR_SEASON`; total schedule length `142` (10 + 132).

**Files:** `data/constants.js`, `engine/SeasonEngine.js`, `sw.js` (cache `tfo-v2-r38` → `tfo-v2-r39`). Fresh team required.

### 50.2 Queued batches (agreed)

- **Batch 1 — Box score + live-game consolidation (Path A).** One shared stat accumulator reading `_statDeltas`; wire the orphaned `GameScreen`/`Linescore`/`LiveDiamond` components as the shared live-game render path; Dashboard keeps the full live experience but draws from those shared pieces (no reduction in UX); write `game.boxScore` at commit; strip plays at commit; point `ScheduleScreen._openResultSheet` at the stored box; fix holds `hd`→`hld`. Folded in: shallow-migration hardening (deep nested fill) and the `game:phaseChanged` emit on auto transitions (Opening Day / playoffs / offseason) from the `commitGame` result in `App.js`.
- **Batch 2 — Roster integrity.** A single `reconcileRoster(state)` invariant (lineupSlots + rotation.order + 28-cap) called after every roster mutation across `InjuryEngine`, `RosterEngine`, `CardEngine._applyRosterAction`, and `TeamScreen` swaps; fix `checkDepth` counting injured incumbents as coverage; fix `_buildSyntheticCPUTeam` (0 hitters under lineupSlots model).
- **Batch 3+ — Farm-cap mismatch (8 vs 10 pitchers), then duplication/cleanup** (shared `_escape`/formatters, dup tick constant, `_teamOvr` bench+starter lumping, TeamScreen "Bench" badge for starters).

### 50.3 Batch 0.5 — Headless test harness (COMPLETE)

The live-only design makes time-based transitions impractical to test manually (waiting real days; every restart loses progress). Because the engines are pure and state is JSON (§1.7), the whole season can run headless in Node. Delivered under `tools/harness/`:

- `shims.js` — installs in-memory `indexedDB` + `localStorage`, ensures `crypto.randomUUID`, a **seeded** `Math.random` (reproducible runs), and a controllable virtual clock (overrides `Date.now`). Dev/test only; never imported by the app.
- `sim-season.js` — seeds a fresh game via the REAL `startNewGame`, then drives the REAL `GameEngine.tick`/`commitGame` through the season with time collapsed, printing a pass/fail invariant checklist (schedule structure, every game reaches FINAL + commits, score==linescore, currentGameIndex advances, phase-aware active-roster bounds, Opening Day phase transition).
- Requires a root `package.json` with `{"type":"module"}` (harmless to the static PWA; Node-only). Run: `node tools/harness/sim-season.js [games] [seed]`.

**Result:** full 142-game season runs in ~18s; 839/850 checks pass on seed 1. This is now the regression gate — run after every change.

**Bug the harness found on first run (#21 — queued as Batch 0.6):** `getNextPhase` (SeasonEngine) is called from `commitGame` with `regularIdx = gameIndex − SPRING_TRAINING_GAME_COUNT`, but its `SPRING_TRAINING` branch compares that against `SPRING_TRAINING_GAME_COUNT` *again* (a double-subtraction). Effect: spring→regular fires ~10 games late, so the Opening Day cut to 28 never runs on time and the roster sits at 38 through the first ten "regular" games. Fix: make `getNextPhase` take the raw schedule index and compute the regular-relative index internally for the All-Star/deadline/playoff checks; verify All-Star (66), trade deadline (88/92), and playoffs (132) all still land correctly via the harness before shipping.

Note: roster-integrity (Pattern B) checks passed this seed only because no injury/trade fired in the regular season — Batch 2 will add deterministic fault injection (force injuries/trades) to exercise `reconcileRoster`.

### 50.4 Batch 0.6 — Phase-transition fixes (COMPLETE, `tfo-v2-r40`)

Found by the Batch 0.5 harness on its first run. `getNextPhase` (SeasonEngine) is documented to take a regular-season-relative index, and `commitGame` passed `regularIdx = gameIndex − SPRING_TRAINING_GAME_COUNT`. Two bugs resulted:
1. The `SPRING_TRAINING` branch compared that regular-relative index against `SPRING_TRAINING_GAME_COUNT` again (double-subtraction) → spring→regular fired ~10 games late, so the Opening Day cut to 28 never ran on time (roster sat at 38 through the first ten "regular" games).
2. The playoff branch used `reg >= REGULAR_SEASON_GAME_COUNT` (132), but the final regular game only reaches `reg = 131` → **playoffs never triggered**; the season dead-ended in REGULAR_SEASON.

**Structural fix:** `getNextPhase` now takes the RAW schedule index and derives the regular-relative index (`reg`) internally. Spring ends when `scheduleIndex + 1 >= SPRING_TRAINING_GAME_COUNT`; playoffs begin when `reg + 1 >= REGULAR_SEASON_GAME_COUNT`. `commitGame` passes the raw `gameIndex` (removed the now-unused `regularIdx`). All-Star (raw 76 / reg 66) and the trade deadline (98/103) are unchanged.

**Harness-verified timeline:** spring→regular after game 9; All-Star after 76; deadline 98→103; playoffs after 141. Full season 851/851 checks pass; the harness now also asserts the playoff trigger so this can't silently regress.

**Files:** `engine/SeasonEngine.js`, `engine/GameEngine.js`, `sw.js` (r39→r40), `tools/harness/sim-season.js` (added playoff-trigger check). Fresh team recommended.

### 50.5 Batch 0.7 — Dev tooling: version display, easy debug access, PWA update, live speed (COMPLETE, `tfo-v2-r41`)

Addresses testing friction: no visible build version, hidden debug access (700ms long-press), and stale-cache confusion (new deploys not visible without clearing site data).

- **Visible version:** `App.APP_VERSION` ('tfo-v2-r41', bump alongside `sw.js` CACHE_VERSION) shown in Settings and the Debug banner.
- **Obvious debug access:** replaced the hidden long-press with an explicit "🛠 Developer Menu" button in Settings. (`data-debug-trigger` long-press removed.)
- **In-PWA update/refresh:** `sw.js` gains a `GET_VERSION` message handler. App.js surfaces "🔄 New version ready" when a newer service worker is waiting (no forced mid-game reload), and a "↻ Check for updates & refresh" button applies it (`registration.update()` → SKIP_WAITING → `controllerchange` → single reload). No more clearing site data.
- **Live speed (dev):** `App.setDevTimeScale(n)` restarts the tick loop at `TICK_INTERVAL_MS / n`. Default 1× — shipping players are unaffected and remain live-only (rule #1 intact). Developer Menu offers 1× / 10× / 60× / 300× for watching games play out quickly.

**Files:** `ui/App.js`, `index.html`, `sw.js` (r40→r41), `ui/screens/DebugScreen.js`. Verification note: PWA update flow and tick timing are browser-only (syntax-checked here; verify live).

**Follow-up found while wiring this (queued):** `commitGame` only commits FINAL games and `_silentlyCommitGame` (instant resolve) isn't exported — so the existing Debug "Simulate N games" buttons are no-ops on unplayed games, and instant "skip to next game / Opening Day / All-Star" controls need a small exported `simulateGameNow(gameIndex)` in GameEngine (harness-verifiable). Deferred to a follow-up batch.

### 50.6 Batch 1 — Box score + live-game consolidation (Path A)

**Phase 1 — Shared accumulator + committed box (COMPLETE, `tfo-v2-r42`, harness-verified).**
The stat-attribution logic existed 3× and drifted (§50 Pattern A). Phase 1 collapses box-score construction onto one function that consumes each play's `_statDeltas` — the same data `accumulateStats` uses for season totals — so live box, committed box, and season stats cannot diverge.

- **`SimEngine.accumulateBox(plays, players, {awayOrder,homeOrder,userIsHome})`** — the single source of truth. Team-agnostic (away/home; TOP = away batting). Routes each delta by role (playerId===pitcherId → pitcher/fielding side; game_end decisions → the pitcher's existing side; else → hitter/batting side), so shared stat names (`k`,`bb`,`h`) never collide. Runs read from runners' `r` deltas (correct without an RBI); pitcher innings counted as integer outs (no 0.333 drift); full 9-man hitter order seeded from the starting lineup with pinch-hitters appended by appearance. Output is self-contained (names/pos snapshotted) so it survives play-stripping.
- **`generatePlays`** snapshots the starting away/home batting orders before simulation mutates slots, builds the box via `accumulateBox`, and returns `{ plays, boxScore, liveLineups }`.
- **`GameEngine`** stores `liveLineups` at activation and silent-commit, and at commit promotes the precomputed box to **`game.boxScore`**. Plays are NOT stripped yet (Phase 2, once all readers use `boxScore`).
- **Holds fix (#7):** `_assignPitcherDecisions` now emits `stat:'hld'` (was `'hd'`), matching schema + readers.
- **Harness:** adds per-game box checks — boxScore written, box runs == final score, linescore sums == box runs, both lineups seeded. Full season **1419/1419**.

Phase 1 is additive and low-risk: `game.boxScore` is new and not yet read by the UI, the old `_buildBoxScore` is simply no longer called, and nothing user-visible changes except holds now landing in season stats.

**Phase 2 (next):** wire the orphaned GameScreen/Linescore/LiveDiamond as the shared live render path (Dashboard keeps the full live experience, drawn from those pieces); Dashboard live box + ScheduleScreen result sheet read `game.boxScore` / live `accumulateBox`; THEN strip plays at commit; remove dead `_buildBoxScore`. Fold in migration hardening (#4) and the `game:phaseChanged` emit on auto transitions (#5).

**Phase 2a — Shared box renderer + committed box + play-stripping (COMPLETE, `tfo-v2-r43`, harness-verified).**
Migrated the last committed-game `plays` reader to the stored box, then stripped plays at commit.

- **`ui/components/BoxScore.js`** (new) — one shared two-team renderer consuming the `accumulateBox` shape (AB R H RBI BB K SB AVG / IP H ER BB K ERA, sticky name column + horizontal scroll). Replaces the third inline box (ScheduleScreen); Dashboard live card will use it in 2b.
- **`ScheduleScreen._openResultSheet`** now renders `game.boxScore` via `renderBoxScore` (both teams, correct R/SB), with an on-the-fly `accumulateBox(game.plays…)` fallback for old saves committed before the box existed. Gate updated to accept stored box.
- **`GameEngine.commitGame`** strips `plays`, `_precomputedBoxScore`, `liveLineups` at the end of commit (only when `boxScore` is present). Confirmed only reader was ScheduleScreen (Linescore.linescoreFromGame is called solely by the still-unwired GameScreen; `computeAllIMP` reads state, not plays). **State no longer grows across the season** (full-season harness runtime ~17s → ~7.7s).
- **Removed dead `_buildBoxScore`/`buildBoxScore`** from SimEngine.
- **Folded in #5:** App.js emits `game:phaseChanged` on auto transitions (Opening Day/All-Star/deadline/playoffs) from the `commitGame` result, so the four listening screens refresh.
- **Harness:** adds "plays stripped after commit" check. Full season **1561/1561**.

Deferred: migration hardening (#4) not required — old committed games are handled by the ScheduleScreen fallback; deep-fill remains queued.

**Phase 2b (next):** Dashboard live card computes `accumulateBox(revealedPlays, liveLineups)` and renders via the shared `BoxScore.js` (Priority 1 — the live box you *see*), replacing `_deriveGameState`'s inline box; optionally adopt shared Linescore/LiveDiamond. Browser-verified at 300× dev speed.

**Phase 2b — Live box via the shared accumulator (COMPLETE, `tfo-v2-r44`). Priority 1 resolved.**
The Dashboard live card was the last of the three drifting box implementations.

- **`DashboardScreen._renderBoxScore`** now builds the live box with `accumulateBox(revealedPlays, players, game.liveLineups)` and renders it through the shared `BoxScore.js` — both teams, full 9-man lineup seeded from first pitch, correct runs and stolen bases, pinch-hitters appended by appearance. Falls back to `game.boxScore` once plays are stripped.
- **Removed** the buggy inline box loop from `_deriveGameState` (this also deletes the undefined-`userIds` crash on the `game_end` play and the wrong `hd` field) and the box keys from its return.
- **Removed** the dead `_deriveBattingOrder` — the hand-maintained clone of SimEngine's batting order (Pattern A). Batting order now flows from the sim via `game.liveLineups`.

The live box, the committed box (Schedule), and season stats are now all produced by one function (`SimEngine.accumulateBox`) reading `_statDeltas` — they cannot drift. Priority 1 (the live box score) is fixed. Browser-verify: watch a live game (Developer Menu → Live Speed 300×) and confirm both lineups, runs/SB, and pitcher lines tick correctly.

**Batch 1 status:** box-score consolidation COMPLETE. Remaining optional Path-A cleanup (not a bug): the Dashboard live card still uses its own inline linescore/diamond rather than the shared `Linescore.js`/`LiveDiamond.js`; those components + `GameScreen.js` remain orphaned and could be adopted or retired in a later consolidation pass.

### 50.7 Batch 1 leftover — retire orphaned live-view files (COMPLETE, `tfo-v2-r45`)

Closed out the Path-A leftover by removing dead/inferior code rather than adopting it:

- **Deleted `ui/screens/GameScreen.js`** (907 lines) — a complete alternate live view, imported by nothing since the Dashboard is the live view. Its one genuinely-correct piece (a `_statDeltas`-based box) was already harvested into `accumulateBox`/`BoxScore.js` in Batch 1.
- **Deleted `ui/components/Linescore.js`** (250 lines) — only imported by GameScreen, and inferior to the Dashboard's inline linescore (component shows only R; inline shows R/H/E with correct per-inning data, whereas the component's `linescoreFromGame` produced cumulative + collapsed innings).
- **Deleted `ui/components/LiveDiamond.js`** (227 lines) — only imported by GameScreen. It is a nicer animated diamond, but adopting it into the Dashboard would require restructuring the Dashboard's separate outs display (untestable DOM change on the working live card). Deferred as an opt-in visual upgrade instead of risking the live card blind.
- **`sw.js`** — removed the three precache entries; bumped r44→r45.

Net: ~1,384 lines of dead code removed, zero working-code changes, zero regression risk. The three drifting box implementations are now one (`accumulateBox`), and the redundant live-view stack is gone. Remaining optional polish: adopt the LiveDiamond visual (browser-verified) if a fancier diamond is wanted.

---

## 51. Current State — Start of Batch 2 (session checkpoint)

**Deployed and green through `tfo-v2-r45`.** Full-season harness: **1561/1561**, run automatically on every commit via GitHub Actions (`.github/workflows/harness.yml`).

**Done this session (Batches 0 → 1 + cleanup):**
- Batch 0 — `SPRING_TRAINING_GAME_COUNT` landmine fixed (constant matches generator; fail-loud gate).
- Batch 0.5 — Headless season harness (`tools/harness/`) + in-memory shims; the regression gate.
- Batch 0.6 — `getNextPhase` double-subtraction + playoff off-by-one fixed (found by the harness).
- Batch 0.7 — Dev tooling: visible version, obvious Developer Menu (replaced long-press), in-PWA update/refresh, live-speed control.
- Batch 1 — Box score + live-game consolidation. One shared accumulator (`SimEngine.accumulateBox`) feeds the live box (Dashboard), committed box (Schedule), and season stats; `game.boxScore` written at commit; plays stripped at commit (state stops growing); holds `hd`→`hld`; `game:phaseChanged` emitted on auto transitions. Shared `ui/components/BoxScore.js`. Deleted the orphaned GameScreen/Linescore/LiveDiamond.

**Next: Batch 2 — Roster integrity (audit Pattern B).** Root cause: `lineupSlots`/`rotation.order` and the 28-man active count are never reconciled after a roster change. Symptoms span four layers (all in §50 findings): `InjuryEngine.injurePlayer` (leaves injured player in the lineup, no backfill), `RosterEngine.checkDepth` (counts the injured incumbent as coverage → auto-backfill never fires), `CardEngine._applyRosterAction` (IL-return activates to bench/bullpen, no lineup/rotation restore, no 28-cap enforcement), `TeamScreen._execPitcherSwap` (changes group but not `rotation.order`, so rotation edits are ignored by the sim). Fix: a single `reconcileRoster(state, teamId)` invariant called after every roster mutation, plus fixing `checkDepth`'s injured-incumbent bug and `_buildSyntheticCPUTeam` (0 hitters under lineupSlots model). Verify deterministically by adding fault injection (force injuries/trades) to the harness and asserting active count stays 28 and every lineup slot / rotation entry points to a healthy, rostered player.


---

## 52. Batch 2 — Roster Integrity (Session 5) — DELIVERED

**Deploys as `tfo-v2-r46`** (`sw.js` CACHE_VERSION + `App.js` APP_VERSION both bumped from r45/r41 → r46).

### The single invariant
`RosterEngine.reconcileRoster(state, teamId = 'user', { autoManage = false })` — a **pure** function (reads state, works on clones, returns a mutation object) that must hold after *any* roster mutation. Guarantees:
1. `lineupSlots` is exactly the 9 canonical slots in `C/1B/2B/3B/SS/OF/OF/OF/DH` order; every non-null occupant is a healthy, rostered `BENCH_HITTERS` hitter eligible for that slot.
2. Vacant slots backfill from eligible healthy **bench** hitters (always); if bench can't cover, the slot is filled from farm (CPU) or reported (user).
3. `rotation.order` = rostered, healthy `STARTING_PITCHERS`, de-duped, no injured/departed ids; a short rotation tops up from `PITCHER_BENCH` (always), then farm (CPU only); `currentIndex` clamped.
4. Active-count (regular season): CPU (`autoManage`) calls up from farm to reach `ACTIVE_TOTAL` (28) and waives the lowest-OVR droppable surplus back down; the **user** is never auto-managed — reconcile reports `pendingCallups {slots, count}` and `pendingSurplus [ids]` for the card/UI layer. Spring: no cap enforcement.
5. No id in both `rosterIds` and `farmIds`.

Also added: `applyRosterMutation(state, mut)` (one shared merge impl for the non-GameEngine callers; ignores the advisory keys `pendingCallups`/`pendingSurplus`/`surplusCount`), and `eligibleSlotsFor(player)` (the authoritative lineup-slot eligibility map — TeamScreen's local `_eligibleSlots` now delegates to it, so the swap UI and reconcile can never disagree).

### Manager-vs-GM ownership (the design decision)
Following the plan's framing that lineup + rotation are **manager**-owned and roster construction is **GM**-owned, reconcile splits cleanly:
- **Manager domain — always automatic, all teams** (only rearranges players *already on the active roster*): pull injured/departed players out of slots + rotation; slide a bench hitter into a vacated slot; promote a `PITCHER_BENCH` pitcher into a short rotation. Non-destructive, no roster-size change.
- **GM domain — auto for CPU, gated for the user**: farm call-ups and waivers. CPU auto-manages to a legal 28; the user's needs are *reported*, not acted on.

So after a user injury the injured player leaves the lineup, a bench player covers if possible, and the team sits at 27 with a reported pending call-up. The user picks the call-up (penalty-free if active). **Deferred to Batch 2.5** (the IL card flow): the grace-window timer, the "didn't act" metric penalty, the suboptimal auto-fallback call-up, and the "who comes off the roster?" surplus card on IL activation. Batch 2 just *exposes* `pendingCallups`/`pendingSurplus` so 2.5 has something to consume.

### The four-layer fix (+ two engine bugs)
- **GameEngine** commit pipeline Step 5: replaced the user-side `autoResolveDepth(s)` (which silently auto-called-up from farm) with `reconcileRoster(s, 'user')` + `applyRosterMutation` — manager-domain integrity + report pending, no auto farm call-up. `autoResolveDepth` import dropped (now unused there).
- **LeagueEngine** `processCPURosterDecisions`: after per-team IL-returns + `autoResolveDepth`, runs `reconcileRoster(patched, team.id, { autoManage: true })` on a patched view that reflects this team's and every earlier team's accumulated mutations; merges `players`/`leagueTeams`/`waiverPool`.
- **CardEngine** `_applyRosterAction`: after `il_return_activate` / `il_return_waive` / `il_return_farm`, runs `reconcileRoster('user')` + apply (restores lineup/rotation; activation surplus is reported, never silently waived). `trade_execute` is intentionally **not** reconciled here — it defers to the commit-pipeline reconcile after `drainPendingTrades`.
- **TeamScreen**: `_execHitterSwap` and `_execPitcherSwap` reconcile after their mutate (**pitcher-swap fix**: `rotation.order` now reflects the swap — before, the swap changed only `group` and the sim, which reads `rotation.order`, ignored it entirely). `_handleCallUp` reconciles after call-up and shows a warning toast if the roster is now over 28 (user must send down/waive). Local `_eligibleSlots` delegates to `eligibleSlotsFor`.
- **Bug — `checkDepth`** (RosterEngine): rewrote coverage counting to a clean healthy-body count. Removed the injured-incumbent miscount (an injured starter carried group IL but was still counted as coverage, so a CRITICAL gap never fired) and the muddled `.length + (some ? 1 : 0)` collapse.
- **Bug — `_buildSyntheticCPUTeam`** (SimEngine): pulled hitters from `STARTING_HITTERS` (no longer assigned under the lineupSlots model) → 0 hitters → 0-0 fallback games. Now pulls from `BENCH_HITTERS` and seats a proper 9-entry `lineupSlots` by eligibility so `_buildLineup` fields a full lineup.

`InjuryEngine.js` — **no functional change** (deliberate: it's pure/player-scoped; team-level backfill is reconcile's job).

### Verification
- `test-reconcile.mjs` — **71/71** (bench backfill, no-cover → vacant+`pendingCallups` for user vs farm-fill for CPU, SP injury → `PITCHER_BENCH` promotion, pitcher-swap → `rotation.order` reflects it, ghost/dup slot cleanup, CPU surplus auto-waive to 28, user surplus reported-not-dropped, `checkDepth` CRITICAL when the injured incumbent isn't miscounted).
- `test-harness-logic.mjs` — **15/15** on a realistic base incl. a CPU team (CPU injury → 28, CPU departure w/ deleted player → 28, user injury → 27 + pending, user SP injury → bench-SP promote + rotation 5; all clean lineup/rotation).
- **Harness fault injection** added to `tools/harness/sim-season.js`: at the first committed regular-season game it JSON-clones the live state and runs the four fault scenarios (user hitter injury, user SP injury, CPU hitter injury, CPU departure), asserting no injured/departed id remains in any slot or the rotation and that the active-count rule holds (user opens a spot + reports; CPU auto-manages to 28).

### Needs LIVE (browser) verification (harness can't test the DOM)
- Pitcher swap taking effect in a watched live game (Developer Menu → Live Speed 300×) — the rotation actually changes who starts.
- TeamScreen swap/call-up toasts; the over-28 warning toast after a manual call-up.
- Fresh team required (touched `GameEngine`/`LeagueEngine`/`SimEngine`).

### Forward-compatibility for Batch 2.5
reconcile leaves the user roster possibly at 27 (injury, awaiting call-up) or 29 (IL activation / manual call-up, awaiting drop) — legal for the sim (it reads `lineupSlots` + groups), enforced by user choice. 2.5 builds on `pendingCallups`/`pendingSurplus`: wire injuries live (nothing currently sets `isInjured` — `runDailyInjuryCheck`/`InjuryEngine.injurePlayer` are never called; injury-card `onYes` types are unhandled), add the IL/call-up card with a grace window + "didn't act" penalty + suboptimal auto-fallback, and the "who comes off?" surplus card on IL activation.

---

## 53. r47 (staged) + r48 — Rotation fix & Live Game View audit (Session 6)

### r47 (staged with #1; deployed base already at r47)
**Wrong starter (rotation display vs sim).** The Team screen sorted the rotation by OVR, but the sim starts `rotation.order[currentIndex]`, and `order` was built in roster-generation order — so the pitcher shown on top wasn't the one who started. Fixes: `GameEngine` now OVR-sorts `rotation.order` at team creation (ace = order[0] opens game 1); `TeamScreen` renders the rotation in true `order` sequence ("Rotation (SP) — in start order") with a green **NEXT** badge on `order[currentIndex]`, so the display matches what the sim starts and the badge advances as the rotation cycles. Requires a fresh team. Verified: ace opens G1, badge tracks G2–5 and wraps, stray SPs append safely.

### r48 — Live Game View audit (Priority 1)
Ground-up pass on the reveal → derive → render path. Root causes and fixes:

- **Cadence / inning-batching (#2, #3).** `GameEngine.tick()` revealed one play per call; with the r47 dev speed scaling the scaled clock raced ahead while plays trickled out one-per-interval → PBP/diamond lagged and batched by inning. `tick()` now **batch-reveals**: it advances `livePlayIndex` past every play whose (scaled) timestamp has passed, in one tick. Harness-safe: at scale 1 the caller's clock only advances to the next play, so exactly one play reveals per call — bit-identical to before, and the headless harness (which steps a virtual clock to `nextPlay._timestamp + 1000`) is unaffected.
- **PBP batch render (#2).** `_onTick` no longer assumes one new play per tick; it appends every play revealed since `_pbpRenderedIdx` (oldest→newest), and the index is synced to `livePlayIndex` on every full dashboard render. Diamond, score, inning/outs, and linescore update from the single `_deriveGameState` snapshot, so all live elements stay in lockstep.
- **Stats/PBP sync (#4).** The box already derives from the same revealed-plays snapshot (`SimEngine.accumulateBox`) and rebuilds on tab-switch and per-tick when the Stats tab is active — the batch-reveal keeps it current with the PBP.
- **Inning-score sequencing (#5).** Root cause: `_deriveGameState` built the linescore run arrays from `inning_end`-based `completedHalves` **before** the outs≥3 speculative advance moved the highlight, so the highlight jumped to the next inning while the just-finished half's runs were still absent. Rewrote the linescore to post by **progression (ordinal)**: a half's runs post once the current position has moved past it (`ord(half,inn) < curOrd`), or at game end for any half that was played. Score and highlight now move atomically. This also removes the dependency on `inning_end` plays (which carry `half:'END'` in places). Verified with a standalone invariant test (bottom-half posts exactly when the highlight reaches the next inning; walk-offs post at final).
- **"Us"/"US"/"You" team labels (#4).** These were empty-abbr fallbacks. Added shared helpers `_userAbbr`/`_userFull`/`_oppAbbr`/`_oppFull` (abbr → nickname → city → name, never a placeholder) and routed the live card, tick-handler linescore, `_renderLinescore` fallback, and the box score through them. Box now shows full team names on both sides.

**Deploys as `tfo-v2-r48`** (`sw.js` CACHE_VERSION + `App.js` APP_VERSION). Fresh team required (rotation-order init changed in r47's GameEngine edit). Batch-reveal is scale-1-identical, so the CI harness is expected to stay green; the reconcile unit suites (71/71, 15/15) are unaffected and still pass.

**Live (browser) checks — can't be covered by the harness:** at 25×/40×, PBP + diamond keep pace with no inning-batching; Stats stays in sync with PBP; the linescore posts a half's runs before/as the highlight advances; team names show correctly (no "Us"/"US").

---

## 54. r50 — Scheduling: no double-booking (Session 7, batch 1 of 3)

**Root cause.** The user's schedule (series blocks, `SeasonEngine.generateUserSchedule`) and the CPU league schedule (`generateCPUSchedules` → `leagueSchedule.dayMap`, a round-robin over `leagueTeams`) are generated independently. The user is not in `leagueTeams`, so on a day the user plays opponent X, the CPU dayMap also pairs X with another team → X is booked twice. Separately, `commitGame` only updated the *user's* record, never the opponent's, so the opponent's standings omitted every game it played against the user.

**Fixes.**
- `LeagueEngine.processCPUDay(state, dateStr)` now looks up the user's opponent for that date (via `state.schedule`) and **drops** any CPU-slate game involving that team before simulating — the user's opponent plays only the user that day. (Its round-robin partner sits idle that day; a minor schedule-sparsity trade-off, not a correctness issue.)
- `GameEngine.commitGame` Step 1b now also **credits the opponent's league record** with the mirror result, so the opponent's standings include user games. The record update is gated on a new `g._recordApplied` flag instead of `alreadyCommitted`, so it runs exactly once for **both** watched and silently-committed games — this also fixes a latent bug where `_silentlyCommitGame` (games missed by 4+ hours) set `_committed`/`result` but never updated the win/loss record at all.

**Verification.** New `test-schedule.mjs` (9/9): the user's opponent is dropped from the slate, unrelated CPU games still play, the dropped-game partner sits idle, and mirror-credit is correct both ways. Harness `sim-season.js` gains a per-game invariant: the user's opponent must not appear in `dayMap[game.date]` after commit. Reconcile suites unaffected (71/71, 15/15).

**Deploys as `tfo-v2-r50`.** Fresh team required (schedule generation). Batch 1 of 3 (r50 scheduling → r51 pitching changes → r52 end-of-game results); deployed together as the r52 bundle.

---

## 55. r51 — Pitching changes (Session 7, batch 2 of 3)

**Root causes (three, compounding).**
1. **Empty bullpen source.** `_checkPitcherChange` filtered relievers out of the *batting lineup* (`userLineup.slots`), which never contains pitchers — so `bullpen` was always empty and no reliever ever entered. This was the primary blocker.
2. **Fatigue threshold far too high.** `maxBatters = stamina × 1.8` ≈ 80–150 batters (stamina is OVR-scaled, ~45–85), i.e. ~20+ innings — a starter never tired inside a 9-inning game even if the bullpen had worked.
3. **Cross-wired counter.** The batters-faced increment referenced the opposite counter from the fatigue check (`userPitchCount` vs `oppPitchCount`), so fatigue tracked the wrong pitcher. And the count was never reset on a change, so a fresh reliever would inherit the starter's count.

**Fixes.**
- `_buildLineup` now also returns `bullpen` — healthy rostered relievers (BULLPEN + PITCHER_BENCH), sorted weakest→best so lower-leverage arms enter first and the closer finishes. `_checkPitcherChange` sources relievers from this (the synthetic CPU opponent is covered too, since it reads `team.rosterIds`).
- Fatigue is now **innings-based**, evaluated per inning in `_simulateFullGame` via `_accrueInningAndFatigue` + `_pitcherTargetInnings` (starters ~5–8 IP by stamina, relievers ~1–2 IP). Innings (not batters) keeps the hook stable regardless of how much offense a game produces. The old batter-based block and the `SIM_P_FATIGUE_MULTIPLIER` constant use were removed; the throwing-pitcher counter direction was corrected and both the count and innings reset when a reliever enters.

**Result.** Starters go ~5–7 innings then the pen takes over, for both the user's team and the CPU. Verified by new `test-pitching.mjs` (6/6): every game (25/25 per side) uses ≥2 pitchers, the first change lands mid/late (avg ~inning 7 for stamina-70 starters), and no starter is yanked before the 4th. Harness `sim-season.js` gains a season-level check that the bullpen is used in ≥70% of committed games. Reconcile/schedule suites unaffected.

**Deploys as `tfo-v2-r51`.** Fresh team required (SimEngine). Batch 2 of 3.

**Open polish note:** relievers enter weakest→closer and one reliever may finish multiple innings; true one-inning-per-arm modern bullpen usage is a candidate for a future pass.

---

## 56. r52 — End-of-game results: ties, extra innings, series screen (Session 7, batch 3 of 3)

**Ties no longer recorded as losses.** Result was computed as `won ? 'win' : 'loss'`, so a tie fell through to a loss. Now 3-way (`win`/`loss`/`tie`) in all three code paths (`_silentlyCommitGame`, the watched-commit result, and Step 1b). The schema's `springWins`/`springLosses` were vestigial (never referenced — spring games increment the regular `wins`/`losses`), so a real `ties` counter was added to the user schema and CPU team init. Step 1b increments `ties` for both the user and the mirror-credited opponent on a tie (no streak change). Standings (`computeFullStandings`) now carry `ties`; win% still excludes them. Displays show **T** instead of an implicit L: the dashboard last-game badge, the schedule game-result label, and the season/final-record lines (`W–L–T`, shown only when ties > 0).

**No phantom top-10th.** The game loop increments the inning before the end check, so `game_end` was tagged with the post-increment value (10 after a 9-inning game). `game_end` now records the true last inning played, derived from the actual plays. With the r49 derive fix (suppress the speculative advance when the next play is `game_end`), the phantom 10th is gone in both data and display.

**Regular season never ties.** The real terminator was `_gameOver`, which capped at inning 14 regardless of score. Both the loop breaks and `_gameOver` were rewritten: spring ends after 9 (ties allowed), regular season plays extra innings until the score differs, with a 30-inning safety valve that realistic offense never reaches. `gs` now carries `isSpring` so `_gameOver` can distinguish the two.

**Series screen fixed.** `MILESTONE_SCREENS.SERIES_WON` had `triggerPhase: null, triggerGame: null`, so the generic seen-gated loop fired it on game 1 regardless of result. Added `SERIES_LOST` and `SERIES_SPLIT`, flagged all three `isSeries: true` (skipped by the generic loop), and added `_checkSeriesMilestone`: it fires only when the just-committed game is the last of a multi-game series (next game is a different opponent / schedule end), computes the outcome from the user's record across the consecutive same-opponent block, and returns Won/Lost/Split with the actual record in the subtitle. Fires once per series (guarded by `_seriesMilestoneFired`), recurring rather than seen-gated.

**Verification.** New `test-endgame.mjs` (10/10): regular games never tie before the safety cap, extra innings occur, spring never exceeds 9, `game_end` inning matches the real final inning, 3-way outcome, and all series cases (ongoing → no fire, Won/Lost/Split, single game → not a series). All prior suites still green.

**Deploys as `tfo-v2-r52`** — the combined r50+r51+r52 bundle. Fresh team required.

---

## 57. r53 — Five reported regressions fixed at root + a process correction (Session 7, batch 4)

After the r52 bundle, five issues were reported that earlier claims had said were fixed. The root cause of the *recurrence* was a process failure: fixes were verified against the changed function (isolated unit tests) rather than the user-visible artifact, "throughout/fixed" was claimed from narrow changes, and instances were fixed instead of classes. This batch fixes each at the layer where the data originates and verifies against the real artifact.

**1 — "Us" instead of the team abbr (Scores screen, and everywhere).** Root: SetupScreen collects city + nickname but never an abbreviation, so `createUserTeamObject` set `abbr: config.abbr || ''` = empty, and every screen fell back to its placeholder ('Us'/'US'/'You'/'YOU'). Fix at the source: the schema now derives the abbr from the nickname (else city, else 'TM') as three uppercase letters when setup supplies none. ScheduleScreen's fallbacks were additionally hardened (nickname → city) as defense. Verified: `createUserTeamObject({nickname:'Bears'})` → 'BEA'; city-only → 'ROA'; explicit respected. **⚠ See §59: this schema change was deployed to the wrong path and is not live.**

**2 — Opponent double-booked on the first spring day.** Root: the r50 fix dropped the conflict only at *commit* time, but the Scores screen reads the *stored* day-map before any game is played. Fix at generation: new `SeasonEngine.reconcileScheduleConflicts(userSchedule, leagueSchedule, leagueTeams)` strips every CPU game involving the user's opponent-of-the-day from the stored day-map, wired into both schedule-generation sites (team creation and new season). Verified against a **real generated schedule**: 76 conflicts before, 0 after, including the first spring day. The r50 commit-time drop + opponent-record credit remain as harmless defense.

**3 — Wrong pitcher "takes the mound."** Root: the game-start announcement named the away team's starter, but the home team pitches the top of the 1st. Fix: announce the home starter (`moundSP = homeSPPlayer`), pitcherId = home SP.

**4 — Reliever missing from the Stats tab for ~an inning.** Root: `accumulateBox` skipped any play without stat deltas, and a `pitching_change` play carries the incoming pitcher but an empty `_statDeltas`. Fix: a `pitching_change` branch at the top of the box loop registers the pitcher on the correct side immediately (side resolved by `teamId` vs `userIsHome`).

**5 — "Season Over" screen after game 1.** Root (a *class*): `SEASON_OVER`, `CHAMPIONS`, and `FRANCHISE_TURNING_POINT` all have `triggerPhase: null, triggerGame: null`, and the generic seen-gated loop fired the first unseen one on game 1. Fix: the generic loop now skips **any** milestone lacking both a phase and a game trigger — those must be fired explicitly by game logic. (Wiring explicit end-of-season/championship triggers remains future work; `SEASON_OVER`/`CHAMPIONS` currently do not fire at all.)

**Also — regular season truly never ties.** Pathological no-score games could reach the inning-30 safety cap still level. A cap-level tie now awards the home team a walk-off run. **⚠ See §59: this tiebreaker combines with the weather `scoringMod` to add runs that are not in the plays.**

**Process changes going forward:** (a) fix at the layer where the data originates; (b) verify against the real artifact, not the changed function; (c) back any "everywhere" claim with a grep/scan showing zero remaining instances; (d) fix the class, not the instance; (e) calibrate claims to evidence ("changed" vs "verified").

**Verification:** seven local suites, 126 checks, 0 failures — reconcile 71, harness-logic 15, schedule 9, pitching 6, endgame 9, schedule-integrity 5 (real generated schedule), r53 11.

**Deploys as `tfo-v2-r53`.** Fresh team required (schema, schedule generation, and SimEngine all changed).

---

## 58. r54 — Spring stats on League leaders + Player Card (Session 7, batch 5)

**Diagnosis (confirmed against the real commit path):** stats commit correctly and immediately at game end — the watched-game path auto-commits when the game hits FINAL (App.js), and the silent path commits via `_silentlyCommitGame`; both run `accumulateStats` that same tick. Spring games write to `player.springStats`, regular games to `player.stats` (separate, never merged). The problem was purely display: every stat surface read only `player.stats`, so during spring nothing showed.

**Fix (display only — no fresh team required):** PlayerCard and LeagueScreen's stat leaders select the stat source by phase — `state.phase === PHASE.SPRING_TRAINING ? springStats : stats`. During spring they carry a "SPRING TRAINING" designation (amber header on the League leaders block; amber badge on the Player Card stat label). Once the regular season begins they show `stats` with the normal "Season Stats" label. The League Standings tab already refreshes on `game:committed`, so leaders update live during spring.

**Verification:** `test-spring-stats.mjs` (13/13). Full regression green (8 suites, 139 checks).

**Deploys as `tfo-v2-r54`.** Files changed: ui/components/PlayerCard.js, ui/screens/LeagueScreen.js (+ version bump).

**Open follow-up (not done):** spring stats reset at opening day by design; an optional "spring line" section on the Player Card during the season was offered but not requested.


---

## 59. Session 8 — Reconstruction + state of the repo at r54 (October 2026)

**Plan doc reconstruction.** The Project copy of this doc ended at §51. §52–§58 were written during Session 5–7 but only ever existed as chat downloads (the doc was not in the repo). They were recovered verbatim from the Chat #2 transcript (§52, §53, §54, §55, §56, §57) or from its delivery summary (§58). r49 never had its own section; from the commit it was: PBP rendered before the score update in `_onTick` (so a play appears with the score it produced), and `_deriveGameState` suppresses the speculative half-inning advance when the next play is `game_end` (no "TOP 10th" flash before FINAL).

**Source of truth going forward.** The GitHub repo is canonical. Project knowledge files were frozen at r45 and are no longer used for source; each session clones `kokanjohn/baseball-gm` directly. Only `BGM_Rebuild_Plan.md` and `PROJECT_SETUP.md` belong in Project knowledge. This doc should also live in the repo root.

**Findings at the r54 baseline (all fixed in §60 unless noted):**
1. **r52/r53 schema changes were never live.** They were uploaded to `data/schema.js`; the app imports `store/schema.js`. The abbr derivation ("Us" fix) and the `ties` field were not running.
2. **CI harness red, 1706/1720.** All 14 failures were "box runs ≠ final score" — exactly one run missing.
3. **The run environment was broken since at least the Aug 8 build:** 0.5–0.7 runs and ~2 hits per team per game. The §7.2 hit term `contact/400 − stuff/300` is ≤ 0 at the generator's real league average (~55), so most at-bats could not produce a hit. 18/142 games reached the extra-innings cap still tied; r53's cap tiebreaker then added a run that existed in no play (cause of finding 2).
4. **r52 regression: games ended after 8 innings.** `_gameOver` is the loop's entry guard and tested `inning < 9`, so it ended every spring game and every non-tied regular game before the 9th was played.
5. **Bottom-of-9th rule keyed on the user, not the home team** — when the user was away and led after the top of the 9th, the home team never batted; walk-offs played on to 3 outs.
6. **Empty inbox on a new team.** `startNewGame` saved, then seeded 3 cards via a 2s-debounced mutate; `SetupScreen` immediately ran `App.init` → `StateManager.load(sameSlot)`, which only flushed when switching slots, so the DB copy (no cards) replaced memory and the timer then saved it back. The seeds were also built by the *debug* injector (no expiry, `_resolved` instead of `resolved`, unresolved budget cost, empty token context).
7. **94 of 140 delivered card types showed raw `{tokens}`.** The resolver knew ~25 tokens; the v1-ported pool uses 115. Its regex also excluded digits (`{sp2_items}` could never match), and each text field re-rolled every random pick (subject and body could name different players; shown cost ≠ charged cost). `_revenueToken` revenue was never credited.
8. **60 pool cards promise roster actions that have no handler** (42 action types: signings, call-ups, benching, training, DFA claims…). Accepting them changed nothing but soft metrics. Only `il_return_*`, `trade_execute/decline`, `injury_act2` are wired. *(Gated in §60; wiring them is a future batch.)*
9. **v1 pool trade cards `t1`–`t9` were fake trades** (actions unhandled; `t7` was cash, retired by §9.1). The real `TradeEngine.generateCPUTradeOffer` → `deliverTradeOffer` path existed but nothing called it, and its offer direction was inverted (accepting would have "acquired" the user's own player).
10. **All-Star hosting score is designed (§17) but not accumulated.** `userTeam.hostingScore` exists and is never written; the announcement card is never delivered; eligibility uses prestige tier + atmosphere only. The spring hint cards `sp_hint1/2/3` move atmosphere. *(Not built — see §60 open items.)*
11. **Push notifications never worked.** `App._registerPushSubscription` is an empty stub, `sw.js` has no `push` handler, and the Cloudflare worker source is not in the repo. Infrastructure from §12.7 is live: `https://baseball-gm-push.baseball-gm.workers.dev/vapid-key` returns the VAPID public key.
12. **`ui/components/BoxScore.js` was missing from the `sw.js` precache** since r45 (offline/first-install failure risk).
13. `_simFatigued` is never set, so the in-at-bat fatigue modifiers never apply (the r51 innings-based hook still pulls tired pitchers). *(Not changed.)*

---

## 60. r55 — Inbox seeding, real trades, full card tokens, realistic sim (Session 8)

**Deploys as `tfo-v2-r55`.** Fresh team required (constants, schema, GameEngine, SimEngine changed). CI harness: **2293/2293** on seeds 1, 7, 13 (full 142-game seasons).

### Persistence
- `StateManager.load()` now flushes pending state before replacing it **whenever a slot is loaded** — same slot or different. Class fix: any mutate followed within 2s by a reload previously lost data.

### New-franchise inbox seed (LOCKED)
- `NEW_TEAM_SEED_CARDS = ['sp1','sp2','sp_hint1','sp_hint3']` (constants) + **one real TradeEngine offer** (`CardEngine.deliverSeedTradeOffer`, `force: true` skips only the probability roll). 5 cards on a new team.
- `sp_hint1`/`sp_hint3` are the first "the league is watching" signals toward All-Star hosting.
- Seeds use `CardEngine.deliverSeedCards` → the normal `_createInstance` path; flagged `_seed: true` and **never push-notified**. `startNewGame` saves after seeding.

### Trades
- `generateCPUTradeOffer` direction fixed: `incomingIds` = CPU player the user receives, `outgoingIds` = user player sent (matches `evaluateTrade`/`executeTrade`).
- `checkAndDeliver` now asks CPU teams for real offers (one per check, skipping teams with a pending offer). Trade window: spring, and regular season through `TRADE_DEADLINE_CLOSE`. ~6 real offers per 40 games observed.
- v1 pool trade cards `t1`–`t9` marked `_retired: true`; `_filterEligible` never delivers retired cards.

### Card tokens (LOCKED design)
- New pure module `engine/CardTokens.js`: `buildTokenMap(cardDef, context, state)` → `{ values, amountsK }`, built **once per card instance**; `applyTokens`, `hasUnresolvedTokens`, `formatK`. Player picks within one card never repeat a player.
- New data file `data/card-tokens.js`: phrase pools + money ranges for the 68 tokens the action-free cards use. Edit pools against the exact card sentence.
- `_createInstance`: every text field (subject, preview, body, sender, labels, `yesMsg`, `noMsg`, `expireMsg`) from the one map; **a card with any unresolved `{token}` is never delivered**. Money: `_budgetCost` (yes), `_budgetCostNo` (`{no}` form or `_rawBudgetCostNo`), `_revenueK` (`_revenueToken`, credited to `finances.revenue` on yes) — all the same draw the text shows.
- `resolveTokens()` remains as a single-string wrapper; never use it field-by-field.
- `deliverCardById` (debug) and compose cards build instances through the same path.
- `userTeam.ownerName` generated at team creation (schema default `''`, token falls back to "Ownership").
- **Action gate:** `HANDLED_CARD_ACTIONS` (CardEngine) lists the onYes/onNo actions with real handlers. Pool cards declaring any other action are not delivered. Add the action name in the same change that adds its handler. 180 cards deliverable now; 60 gated pending action wiring.

### Sim engine (supersedes §7.2 coefficients — structure unchanged)
- **Plate-appearance model** re-centred on `SIM_RATING_AVG = 55` (the generator's real mean): walk / K / hit rates are league-average baselines moved linearly by the rating gap and clamped (`SIM_PA_*`, `SIM_HIT_*` in constants). §7.2's resolution order and rating→outcome mapping are unchanged. Observed: 4.2–5.1 R and 8.0–9.0 H per team per game; extras ~2–3% of games; nothing near the cap.
- **Weather and field act inside every at-bat** (`fieldMod × weather.scoringMod` on hit probability and HR share). The post-game score rescale is gone.
- **No runs outside the plays.** The r53 cap tiebreaker is removed; `SIM_MAX_INNINGS_GUARD = 99` only stops a pathological loop (logs an error, never edits the score).
- `_gameOver` entry guard fixed (`inning <= 9` → not over): 9 full innings always played.
- Bottom of the 9th+ skipped only when the **home** team leads; **walk-offs end the game immediately**, counting only the runs needed to win except on a home run (`_walkoff` flag on the inning-end play).
- Fatigue modifiers are multipliers (were additive +0.10 to walk rate).

### Schema / deployment
- `store/schema.js` replaced with the intended r52/r53 version; stray `data/schema.js` deleted.
- `sw.js` precache gains `data/card-tokens.js`, `engine/CardTokens.js`, `ui/components/BoxScore.js`.

### Harness additions (`tools/harness/sim-season.js`)
New-team seeds survive the `App.init` reload and are real instances; seeded trade direction; every game: runs in plays == final score, ≥ 9 innings, bottom half skipped only when home leads, regular season never ties; season run/hit environment bands; no delivered card has a raw token; **every deliverable pool card (incl. variants) resolves**; shown money == applied money; no retired card delivered; real CPU offers arrive with correct direction; every app module is precached.

### Open items carried forward
1. **Timed delivery + push notifications** (next batch): cards currently arrive in bursts right after each game commit. Design proposed in-session: plan the next batch of cards at commit with real `deliverAtMs` times between games, reveal them on tick/app open, and sync the same schedule to the Cloudflare worker so pushes arrive with the app closed. Blocked on the worker's source (its `/register` and `/schedule` contract).
2. **Wire the 42 unhandled card actions** (re-enables 60 cards).
3. **All-Star hosting score** accumulation + announcement card (§17).
4. Outcome messages (`yesMsg`/`noMsg`) are now resolved on each instance but not displayed — the inbox toast says only "Decision made." (UI pass).
5. `_simFatigued` never set (finding 13).

---

## 61. r56 — Timed inbox delivery + working push notifications (Session 8)

**Deploys as `tfo-v2-r56`** (includes r55). Fresh team required. Harness **2303/2303** on seeds 1, 7, 13; `test-webpush.mjs` green. **The push worker must also be redeployed** from `workers/push-worker.js` (Cloudflare dashboard → Workers & Pages → baseball-gm-push → Edit code → paste → Deploy).

### Root cause: push never worked
1. Client: `_registerPushSubscription` was an empty stub — no device was ever subscribed or registered.
2. Service worker: no `push` / `notificationclick` handler.
3. **Worker encryption was wrong.** `encryptPayload` derived the IKM with `info = as_public ‖ ua_public`; RFC 8291 §3.4 requires `"WebPush: info" ‖ 0x00 ‖ ua_public ‖ as_public`. Browsers cannot decrypt such messages and drop them silently. Proven with an independent RFC 8291 decryptor validated on the RFC's Appendix A vector: the deployed code's output fails to decrypt; the fixed code round-trips. Now a CI step (`tools/harness/test-webpush.mjs`).
4. Quiet hours: Settings wrote `localStorage`, nothing read it. Now `state.push.quietStart/quietEnd` is the single source.

### Worker (source now in repo: `workers/push-worker.js`)
Contract unchanged: `GET /vapid-key`; `POST /register { userId, subscription, schedule:[{ id, deliverAt, title, body, tag }] }` **replaces** the device's whole schedule; cron every minute sends due items and keeps future ones. Additions: input validation, 200-item cap, `Urgency` header, notification `data.url`, and the cron re-reads before writing so a `/register` that lands mid-send is not overwritten.

### Timed delivery (LOCKED design — user-approved)
- Cards produced at game commit (pool cards + real CPU trade offers) are **not** put in the inbox. `engine/CardScheduler.js` (pure) gives **each card its own random time**, uniform over the waking part of `[now + 4 min, next first pitch]` (default 18h span if no next game; max 30h). Independent draws → some arrive hours apart, some minutes apart. Never during quiet hours; a window entirely inside quiet hours delivers shortly after wake-up.
- Parked in `state.scheduledCards` (new top-level field, migrated). `CardEngine.releaseDueCards()` moves due cards into the inbox (`arrivedAtMs`); called on every app tick, on app open, and when a push arrives / is tapped.
- Capacity, once-per-season dedup and "one pending offer per CPU team" all count scheduled cards.
- Immediate (never scheduled, never pushed): new-team seeds, compose replies, in-game injury/IL events, debug injection.

### Client
- `ui/PushClient.js`: `enablePush()` (permission → VAPID subscribe → register), `syncPushSchedule()` (debounced; sends `CardEngine.getPushSchedule()`; skips unchanged; empty when paused), `sendTestPush()` (real round trip through the worker; arrives within ~1 min, works with the app closed). Per-device id in `localStorage`; resubscribes if the VAPID key changes.
- Sync triggers: app open, every `game:committed`, every release, toggle change.
- `sw.js`: `push` shows the notification **always** (also while the app is open, per user request) with `tag = card instanceId`; `notificationclick` focuses the app on the Inbox (or opens `/baseball-gm/?tab=inbox`).
- In-app: released cards update the badge and inbox; a toast shows when the user isn't on the Inbox tab.

### Known limits
- The world only advances while the app is open (live-only). If the app stays closed through a game, that game commits on next open, so the schedule covers one inter-game window at a time.
- Notifications require the PWA installed to the home screen on Android Chrome and permission granted in Settings → Notifications → Enable.
- Open question from user: whether to add a "first pitch in 30 minutes" reminder (not built).

### Repo access
GitHub connector is read-only for this repo; pushing needs the Claude GitHub App installed on `kokanjohn/baseball-gm`. Cloudflare connector can read worker code but not deploy.

---

## 62. r57 — Inbox decisions fixed, hidden audio bug, push diagnostics (Session 8)

**Reported on r56:** only the pre-season inspection card could be decided; the other four cards ignored both buttons. Send Test showed its toast but no notification arrived with the app closed.

### Inbox decisions (root cause)
`InboxScreen`'s inline Yes/No buttons called `_resolveCard(...)`, a function that **never existed** in that module (checked back through repo history). Every tap threw a ReferenceError inside the click handler and did nothing. Cards whose body is ≥ 400 chars open in `CardModal` instead, which had its own working inline resolver — that is why the long `sp_hint1` card worked and the short ones did not. Fix: one `_resolveCard(instanceId, choice)` used by both paths; it also shows the card's own outcome line (`yesMsg`/`noMsg`) as the toast instead of "Decision made.", and reports a failure instead of failing silently.

### Hidden audio bug (found by the new check)
A stray `/**` in `App.js` (after a dangling "COLOR + THEME PICKERS" banner) turned `let _audioCtx` and `function _getAudioCtx()` into a comment until the next `*/`, so every game sound threw (swallowed by try/catch). Removed.

### New CI guard: `tools/harness/check-refs.mjs`
The season harness cannot execute screens (DOM). This static check fails CI when any module calls a private `_helper()` that is neither defined nor imported in that module, or when a block comment hides line-start declarations (stray opener). Run on r56 it reports exactly the two bugs above; on r57 it passes (43 modules).

### Push diagnostics
The worker code was proven correct offline, so the failure is in deployment state that could not be seen (VAPID secrets, cron, or the push service's answer — the old cron swallowed errors). Added:
- `POST /test-send` — sends a push **immediately** and returns `{ ok, status, response, error, keys }` (the push service's real answer + a VAPID key check).
- `GET /status` — last cron run (`meta:cron`: sent/failures/lastError), VAPID check (`privateMatchesPublic`, `subjectValid`), per-device schedule size, next delivery, and last send result. No secrets or full endpoints.
- `vapidKeyCheck`: imports `VAPID_PRIVATE_KEY`, derives its public point and compares it with `VAPID_PUBLIC_KEY` (a mismatch makes every push fail with 403).
- Settings → Send Test now: (1) immediate send through `/test-send`, toast shows ✅ or the exact failure reason; (2) a second test queued 90 s out through the normal schedule + cron to prove delivery with the app closed.
- `test-webpush.mjs` now runs the whole worker in Node against a fake KV and fake push service: register → test-send → cron → status, decrypts what the push service received and verifies the VAPID JWT; also proves `/status` flags a key mismatch.

**Requires redeploying `workers/push-worker.js`** to Cloudflare.

---

## 63. r58 — Completed-tab delete/undo, decision effects panel, card rating fix (Session 8)

**User-reported regressions vs v1** (`Baseball_GM.html`, verified in git history):

### Completed tab: Delete All / per-card × / ↩ Undo (restored)
- `CardEngine.clearHistory(ids | 'all')` → returns cleared ids; `restoreHistory(ids)` undoes. `getHistory` hides `_cleared` cards.
- Cleared cards stay in `state.inbox` for the current season because once-per-season dedup reads card ids from the inbox; cleared cards from earlier seasons are dropped on the next clear (keeps saves small).
- Undo is session-only (as in v1). Completed list now shows up to 100.

### Decision effects panel (restored v1 "effects toast")
- `App.showDecisionEffects({ title, before, after, positive })`: headline = the card's outcome line (`yesMsg`/`noMsg`, falls back to the button label); then one bar per metric that moved — **Team Rating, Team Morale, Atmosphere, Owner Trust, Budget** — each animating from old to new value one after another (v1 timing: 60 ms settle, 750 ms stagger, 0.7 s transition) with a +/- delta; auto-dismisses ~2.2 s after the last bar; tap to dismiss. Card revenue shows as a text row ("Counts toward ownership's season review") — per §4.2 revenue does not enter the operating budget.
- Only one pop-up: if nothing measurable moved, a plain toast shows the outcome line instead (v1 rule — no overlapping toasts).
- Shared helpers moved to `formatters.js`: `metricBarColor`, `computeRosterOvr`, `snapshotMetrics`. The Dashboard bars and the panel use the same functions, so numbers and colours always match.

### Bug: card rating effects never changed any rating
`_applySoftEffects` nudged a player's primary sub-rating for `ovr` effects but never recomputed `player.ovr` (the comment claimed GameEngine did; it does not). Now recomputed immediately via `PlayerFactory.computeOVR`.

### Harness
New checks: each seed decision moves a dashboard metric; delete one / undo / delete all / undo; cleared cards still count for dedup. **2309/2309** on seeds 1, 7, 13.

### Push status at r58
The deployed worker was still the r56 build (no `/test-send`), which is why Send Test reported "worker answered 404". Deploy `workers/push-worker.js` (r57+).

### §63 addendum — push confirmed working on a real device (Oct 26, 2026)
- Root cause of the last failure: Cloudflare `VAPID_PRIVATE_KEY` was not the partner of `VAPID_PUBLIC_KEY` (found by the r57 `/test-send` key check). User generated a new pair in Firebase and set both Cloudflare secrets — this also completes the §12.7 "regenerate VAPID keys" security item.
- The app fetches the public key from the worker's `/vapid-key` and re-subscribes automatically when it changes. `data/constants.js` `VAPID_PUBLIC_KEY` is now only an offline fallback and still holds the OLD key — update it when convenient (the public key is safe to commit).
- Closed-app delivery confirmed on Android: test notification arrived ~3 min after Send Test (queued +90 s, then up to 60 s for the next cron tick, then FCM `Urgency: normal` batching while the phone is idle).
- Wrangler "update your configuration" notice in the dashboard can be ignored — the worker is deployed by pasting into the dashboard, not via a local wrangler config.

---

## 64. Gap register — what is designed but not wired (audit, Oct 26 2026, at r58)

Every item below was verified against the code or by a headless probe (full-season runs, forced trades). Severity: **S1** = breaks the season / corrupts data, **S2** = a designed system that never runs, **S3** = polish.

### A. Season integrity
- **A1 (S1) Season dead-ends after game 142.** Phase moves to `PLAYOFF_BRACKET_BUILD`, the bracket is built, but no playoff games are ever scheduled; phase transitions only happen inside `commitGame`, so nothing advances again. Playoffs, `SEASON_SUMMARY`, prestige, offseason and season 2 are unreachable. (Probe: 30 simulated days after game 142 — phase unchanged.)
- **A2 (S1) CPU teams play 41–104 games vs the user's 142.** The CPU league schedule is a separate sparse round-robin (avg 2.4 games/day for 9 teams); r50/r53 then drop every game involving the user's opponent, idling its partner. Standings, seeding and win% are not comparable. Root fix: one unified league schedule (user included, every team one game per scheduled day, equal totals).
- **A3 (S1) Spring games count in the regular-season record and standings** (user and mirror-credited opponent). §Spring Training Rules (LOCKED): spring W/L is a separate "ST" record.
- **A4 (S2) Milestones `SEASON_OVER`, `CHAMPIONS`, `FRANCHISE_TURNING_POINT` never fire** (generic trigger removed in r53; explicit triggers never added). Depends on A1.

### B. Trades / pending transactions
- **B1 (S1) A traded-away player keeps playing for you until the next game commit — including against the team that just acquired him.** (Probe: SS traded to that day's opponent batted 5× for us vs them.)
- **B2 (S1) He is on both rosters in that window** (`executeTrade` adds him to the CPU roster immediately; the user side is deferred).
- **B3 (S1) After the drain he is stranded on the CPU roster**: `drainPendingTrades` overwrites `teamId: null, group: 'traded'` → CPU team has a dead roster spot and an invalid group.
- **B4 (S2) Pending Transactions never display**: engines write `state._pendingAcquisitions`; TeamScreen reads `userTeam._pendingAcquisitions` (always empty). Departures are not listed at all.
- **B5 (S2) Timing is "next game commit", not time.** Accept after tonight's game → the new player also misses tomorrow's game; accept before first pitch → the departing player still plays today. Needs a time-based transaction model (user decision).
- **B6 (S2) Incoming player is on no roster during the window.**
- **B7 (S3) User-initiated trades**: `TradeEngine.evaluateCPUResponse` exists; no UI calls it.

### C. Injuries, vacancies, call-ups, ghost messages
- **C1 (S2) Injuries never happen.** `InjuryEngine.runDailyInjuryCheck` / `injurePlayer` are never called (0 injuries across a full season, all teams). This is why roster counts currently look correct — nothing ever opens a vacancy, so none of the vacancy machinery has run in real play.
- **C2 (S2) Two-act injury chain unwired**: Act 1 is only reachable from the Debug menu, which calls `deliverInjuryAct1(target.id)` with the wrong arguments (no-op); Act 2's `il_placement` / `day_to_day` actions have no handler, so choosing the IL does nothing.
- **C3 (S2) Roster-level vacancy has no UI.** The Team screen's dashed "Slot empty — tap to fill" card exists only for an empty *lineup slot* and only fills from the bench. No dashed card for an open 28-man spot, no pitching vacancy card, no farm call-up from a vacancy.
- **C4 (S2) No single source for a "transaction need".** `reconcileRoster` reports `pendingCallups` / `pendingSurplus`, but nothing stores or consumes them; the inbox and Team screen cannot share state.
- **C5 (S2) Ghost messages.** TeamScreen never touches the inbox and cards have no validity check, so a call-up handled on the Team screen leaves its card behind; trade offers naming players who have since moved also stay live. Root fix: actionable cards declare a validity condition re-checked on render/tick and auto-withdraw when the need is gone.
- **C6 (S2) §52 Batch 2.5 never built**: grace window → auto call-up of a sub-optimal player + "didn't act" metric penalty; "who comes off the roster?" surplus card on IL activation.

### D. Card actions
- **D1 (S2) 42 card action types have no handler** (signings, call-ups, benching, training, DFA claims, rest, intl scouting…). Gated since r55 — 60 cards are withheld until wired (`HANDLED_CARD_ACTIONS`). Many depend on C's roster operations.
- **D2 (S2) Personal leave never happens**: `PERSONAL_LEAVE_POOL` is not in any phase's pool list; `onPersonalLeave` is never set.
- **D3 (S3) Pre-game and in-game cards arrive at random times** (they go through the between-games scheduler), not before first pitch / during a live game.

### E. Other designed systems
- **E1 (S2) All-Star hosting score never accumulates; announcement card never sent** (§17). Only the spring hint cards move atmosphere.
- **E2 (S2) Weather + radar unwired**: every game is hardcoded "Clear"; `WeatherEngine` is never called; `RadarWidget` is imported by the Dashboard but never rendered; postponement/delay paths exist but nothing triggers them. (Planned flagship phase.)
- **E3 (S3) `_simFatigued` is never set**, so in-at-bat fatigue modifiers never apply (the innings-based hook still pulls tired pitchers).
- **E4 (S3) `constants.VAPID_PUBLIC_KEY`** offline fallback still holds the pre-rotation key. *(Resolved r71, §77: the bundled key is removed.)*

### Verified working (no action)
Opening Day keeper cut to 28; reconcile keeps lineup/rotation valid after roster changes (fault-injection checks); CPU teams hold 28 usable players absent trades; pitching changes; box score = plays; timed inbox + push.

### Proposed batch order (pending user decision)
1. **Transactions & vacancies** (B1–B6, C1–C6): one transaction model shared by inbox + Team screen; time-based trades; injuries on; dashed vacancy cards with farm call-up; ghost-card withdrawal; grace window + penalty.
2. **Season integrity** (A1–A4): unified schedule, separate spring record, playable playoffs → offseason → season 2.
3. **Card actions** (D1–D3).
4. **All-Star hosting, fatigue, user-initiated trades** (E1, E3, B7).
5. **Weather + radar** (E2).

## 65. r59 — Transactions, injuries & vacancies on a real clock (Session 8, Batch 1)

Closes gap-register items **B1–B6, C1–C6** (§64). Design approved by the user before coding; decisions in **bold** are theirs.

### 65.1 The roster clock (LOCKED)
- `rosterClock(state, now) = min(now, first pitch of the next game not yet played)`. Nothing changes a roster mid-game; when the app was closed for days, games and roster moves replay in the order they really happened (each game is simulated with the roster it would actually have had).
- `GameEngine.advanceClock(now)` is the one driver: (1) roster cards past their deadline auto-resolve **at their deadline time**; (2) `TransactionEngine.applyDue` — ledger, waivers, injury timeline, reconcile, the GM's vacancy deadline; (3) `CardEngine.syncRosterCards` — new cards + withdrawal of every card whose situation is gone. Called from `tick()` (so the harness covers it), the App tick, app open, every inbox roster decision, and at the end of `commitGame` (with `reconcileAll`, after the phase transition).
- `hasDue()` keeps the 5-second tick write-free when idle.

### 65.2 The ledger — `state.transactions`
- `'trade'` (one record per accepted deal, `TradeEngine.queueTrade`) executes when the clock reaches it → every player in the deal leaves his roster at once and goes `IN_TRANSIT` (`PLAYER_GROUP.IN_TRANSIT = 'transit'`, `teamId` = destination) → one `'arrival'` each, **reporting the next calendar day (local midnight)** — both directions, so a traded player can never face his old team that day. Re-validated at execution: a player no longer where the deal expects, or injured, voids the trade ("failed physical") with an inbox notice.
- **Farm call-ups also report the next calendar day** (user choice), same `'arrival'` record (`by: 'gm' | 'manager' | 'cpu'`). A call-up is refused when the active roster has no open spot.
- Arrivals hold their roster spot: every count of the active roster is **active (non-IL) + pending arrivals**. CPU reconcile, spring cuts and needs all use it.
- Removed: `markPendingDeparture`, `drainPendingTrades`, `_pendingAcquisitions`, `executeTrade`/`deferTrade`, commit Steps 3–4, `callUpFromFarm`, `autoResolveDepth`, `processWaiverClaims`, `ilReturnGame` (game-index IL).

### 65.3 Injuries (C1, C2)
- On for **all ten teams**, rolled at commit for the players who actually appeared (box score for the user + opponent; lineup/starter/relievers for other CPU clubs playing that date). **Existing locked rates kept** (user choice) — ~10 IL-level injuries per club per 142 games in the harness.
- Real-day timeline on `player.injury = { status: 'evaluating'|'dtd'|'il'|'cleared', severity, days, injuredAt, returnAt, eligibleAt }`. IL is backdated to the injury with MLB minimums (**10-day hitters / 15-day pitchers**); season-ending = 200 days (cleared over the winter).
- User flow (two acts, delivered at real moments, pushed outside quiet hours):
  - **Act 1** (5–20 min after the game, Head Trainer): *MRI tonight ($15K, diagnosis in 60–120 min, so a move before midnight reports tomorrow)* vs *wait for the morning exam (9:00–10:30, free, replacement reports a day later)*. Unanswered by midnight → morning exam.
  - **Act 2** (diagnosis; better ×0.6 / as feared / worse ×1.4): *Place on IL — call up {best fit}* vs *Day-to-day — keep his roster spot* (only when ≤10 days; otherwise *Place on IL — I'll pick the call-up*). Due at the roster deadline; unanswered → IL + the manager's call-up + penalty.
  - IL clearance → *Activate {name} — waive {lowest same-side non-starter}* when the roster is full, or *Place on waivers* (spring: farm). Unanswered → manager activates.
- CPU GMs decide at once: ≤5 days day-to-day, otherwise IL; their call-ups go through the ledger.
- An evaluating player who leaves the active roster (cut/waived) simply heals on a day-to-day timeline.

### 65.4 Vacancies — one source, two screens (C3, C4, C5, C6)
- `TransactionEngine.getRosterNeeds(state, team)` is DERIVED, never stored: short/surplus, one need per open spot with side (hitter/pitcher by the 14/14 composition) and a position hint (a lineup slot held by an out-of-position fill, a short rotation). The Team screen's dashed cards and the inbox's "Open roster spot" cards both read it.
- **Deadline: 1 hour before the next first pitch** (user choice). `userTeam.vacancyDeadlineAt` is set when the roster first falls short, cleared when whole. A spot that opens in the final hour is due before the following game.
- **Manager fill + small Owner/Fan hit** (user choice): at the deadline the field manager calls up by position, then seniority (oldest), never by best rating, never the wrong side; `MANAGER_FILL_PENALTY = { ownerTrust: -2, atmosphere: -1 }`; an inbox notice explains it.
- Ghost withdrawal: every roster card carries `_rosterKey`; `syncRosterCards` deletes unresolved cards whose situation no longer exists (injury no longer 'evaluating', player off the IL-return queue, need index ≥ open spots or deadline changed, trade offer whose players moved/got hurt) — whichever screen the GM acted on. A card tapped after withdrawal shows "no longer needed".
- Manager domain: a lineup slot nobody on the bench can play is filled out of position (`emergency: true`, red "out of position" on the Team screen) — every club always fields nine.

### 65.5 Waivers, farm depth (Section 20.2 completed)
- 72-hour real claim window on the clock. CPU clubs claim only a real upgrade (≥3 OVR over the weakest active player at his position), worst record first; the claimant drops a player at once (reconcile). Unclaimed → **outrighted to the placing team's farm** (§20.2 step 7 — previously he went to free agency and never left the pool); farm-overflow displacements still go to free agency.
- Farm director (every club, regular season/playoffs, once per game day): keeps a C, CI, MI, OF, 2 SP, 2 RP and ≥6 hitters / ≥5 pitchers on the farm by signing the best matching free agent to a minor-league deal ($20K, 1 year); when the pool has nobody of that type, a low-OVR independent-league veteran is created. User signings arrive as a Farm Director notice. Without this, farms only shrank and late-season injuries couldn't be covered.

### 65.6 Root causes fixed along the way
- **Every farm hitter was generated as a pitcher** (`createPlayer` decided hitter/pitcher by group, and `PRACTICE_SQUAD` holds both): farm hitters had stuff/control/stamina and null contact/power/speed. Now decided by position.
- **Spring cuts re-ran every time the phase re-entered REGULAR_SEASON** (after the All-Star break and the trade deadline) and counted IL players — silently waiving healthy players mid-season. Cuts now run only coming out of spring and count only the active roster (+ arrivals).
- **Opening Day auto-cuts kept the 28 highest OVRs regardless of position** (e.g. 15 hitters / 13 pitchers, no backup catcher). Cuts now build a real roster: every lineup position + a backup C, 5 starters + 2 spot starters, 14 / 14, then best available.
- **Spring camp could exceed 38** when an IL player was activated; `rosterIsFull()` (28 in season incl. arrivals, 38 in camp) now governs activations and call-ups.
- **Silently committed games never credited player stats** (gate was `!alreadyCommitted`); now `_statsApplied`.
- `commitGame` returned `result` before declaring it (TDZ) on a non-committable game.
- Waiver claims put pitchers in the hitter group (eligible to DH); now `defaultActiveGroup`.
- Trade cards stored live player objects (`_tradeEval`), so a card's text changed after the trade; now a frozen snapshot.
- **League-relative plate appearances**: the PA model measured every at-bat against a fixed rating (55). With injuries on, league talent drifts (≈3 OVR in the lineups by September) and runs fell from 4.7 to ~3.2 R/G over a season. `SimEngine.leagueNorms()` now supplies the league's current average contact/power/speed and stuff/control at first pitch — rates are relative to the league, as in real baseball. A team of call-ups still does worse than the others; the league environment stays MLB-like.
- Quiet hours now delay only the phone ALERT for real-time roster news (`CardScheduler.pushTimeFor`); the card itself reaches the inbox when it happens. An alert that would sound after the card's deadline is dropped.

### 65.7 UI
- Team screen: red-dashed banner "N open roster spots — due {time} or {manager} picks"; dashed **Open spot** cards per need in Hitters / Pitchers (tap → farm picker, best fit first); dashed **arriving** cards ("Called up — reports tomorrow"); Pending Transactions from the ledger (pending trade, INCOMING, OUTGOING with report dates); IL shows "Elig. {date}" / "Cleared" / "Season"; Eval / DTD status chips; farm Call Up greyed when the roster is full.
- Inbox: real-time "⏰ by 6:05 PM" badge on roster cards; Completed shows what auto-resolve did ("No decision — placed on IL, {manager} made the call-up").
- Debug "Injure random player" runs the real path (`GameEngine.debugInjure`).

### 65.8 Harness (all green on 30 seeds)
New invariants every game: active + arriving = 28 for the user **and every CPU club**; every lineup fields nine; no player on two rosters / in transit without exactly one arrival (`auditRosters`); nobody plays for a club before reporting or after leaving (built from every arrival record); no ghost card after any action. A simulated GM lives between games — answers ~75% of roster cards in the inbox, makes ~30% of call-ups from the Team screen path instead, ignores the rest (deadlines + manager fills run), accepts ~35% of trade offers. Season checks: injuries happen at a realistic rate, every accepted trade executes or is voided, every traded player reports the next calendar day, no alert sounds in quiet hours.

### 65.9 Still open (unchanged from §64 unless noted)
- The CPU league schedule (A2) still gives some clubs ~40 games; the injury check accepts 8/10 clubs hurt until Batch 2.
- CPU-vs-CPU games are still the quick OVR formula (plan §28 wants the full pipeline) — Batch 2.
- User waiver claims and free-agent signings by the GM (B7-adjacent) — Batch 4.
- In-game injuries (a player leaving mid-game in the play-by-play) — later; injuries are currently discovered after the final out.
- Pitcher/hitter injury share is ~30/70 under the locked rates (MLB is closer to 55/45) — flag for the user before changing locked constants.

## 66. r60 — Injury split rebalanced (Session 8)
User decision: move the injury split toward MLB's ~50/50 pitchers vs position players (Section 21 rates were ~30/70). Total injury volume unchanged (~0.10 per team-game):
`INJURY_PROB_HITTER_PER_GAME 0.008 → 0.0055`, `INJURY_PROB_SP_PER_START 0.012 → 0.020`, `INJURY_PROB_RP_PER_APP 0.006 → 0.010`. Harness: pitcher share 44–57% across seeds (new check, 40–60%), ~10–12 injuries per club per 142 games, run environment 4.25–4.98 R/team/game.

## 67. r61 — One league calendar, real CPU games, live league view (Session 8, Batch 2a)
Closes §64 **A2, A3** and plan §28.2/§28.4. User decisions: **division-weighted schedule**; **CPU games watchable now** — from small square cards on the Dashboard (below the first-pitch card) and from Schedule → Scores (tap a game in progress or final).

### 67.1 `SeasonEngine.generateLeagueCalendar` (replaces generateUserSchedule / generateCPUSchedules / reconcileScheduleConflicts)
- All ten teams on one calendar. Spring: 10 games each, everyone plays every spring day (off days 3/6/9); first spring day all games 1:05 PM.
- Regular season: 46 series rounds (four shuffled cycles of the 9 league-wide matchings + 10 division rounds; teams resting in their division meet each other, re-ordered so no resting pair repeats). Every team plays in every round → **every team exactly 132 games**; ~17 vs each division rival, ~13 vs the other division. 40 three-game + 6 two-game rounds, laid out so the **All-Star break (4 days) falls exactly after game 66**. Every other round is staggered (half the pairs start a day later) → one off day per two series for every team and ≥4 teams playing every day. ~155 days.
- Real (gameTime) and display (date) calendars share one offset; times from `GAME_TIMES_BY_DOW`. User games carry `opponentId, seriesId, seriesGame, seriesLength`; CPU games live in `leagueSchedule.dayMap[date]` with `id, gameTime, status`.

### 67.2 CPU games are real games on the league clock
- `GameEngine.advanceClock` interleaves CPU first pitches / final outs with the roster clock in time order. First pitch: `generatePlays` with both clubs' rosters at that moment (home = side A). Final out: result + streak, **pitcher decisions for both sides**, player stats + hot/cold log, both rotations turn over, injuries from the actual box score (CPU GM reconciles at once), plays stripped, box kept, standings recomputed.
- The user's game credits the opponent's record (mirror) and now also **turns the opponent's rotation** (it never advanced — the user always faced the same starter).
- `LeagueEngine.simulateCPUGame` / `processCPUDay` (random-score shortcut) removed.

### 67.3 Spring record kept separate (LOCKED rule)
`_creditResult` sends spring results to `springWins/springLosses/springTies` for the user and every CPU club; standings use regular-season games only. `formatTeamRecord` shows "8–1–1 ST" during spring (Schedule header, team select).

### 67.4 Other root fixes
- `_assignPitcherDecisions` rewritten: W (pitcher of record at the go-ahead run; starter needs 15 outs), L, SV, HLD for both teams (opponents previously never got decisions). League totals now = one W and one L per game.
- `accumulateBox` takes the explicit home roster (`homeIds`) instead of inferring sides from `teamId === 'user'` (needed for CPU-vs-CPU; stored in `liveLineups.homeIds`).
- League leaders' SV+HLD read `s.hd` (never written) → `s.hld`.
- RP injury rate 0.010 → 0.008 now that relief outings come from real CPU box scores (pitcher share ≈50%, ~15 injuries per club per season).

### 67.5 UI — `ui/components/LiveGame.js`
`renderLeagueLiveRow` (Dashboard "Around the league" row of square cards: abbrs, scores, ▲/▼ inning, base diamond; refreshes every 5 s) and `openLeagueGame` (sheet: score, status, inning, diamond, outs, linescore, last 30 plays, live box score). Revealed plays are derived from the clock, so every view agrees.

### 67.6 Harness
New: calendar (10 × 132, no double-booking, ≥4 clubs per day, division weighting), spring record separate (user + CPU), every CPU game before the user's last game played with a box score, every club's W+L = games played, CPU players accumulate stats, one W and one L per game, ≥20 different opposing starters faced. 12 seeds green.

## 68. r62 — Playable playoffs on the league clock (Session 8, Batch 2b)
Closes §64 **A1 (playoffs part), A4 (series/season milestones)**. User decision: **if eliminated, the playoffs continue in real time** and the user follows along.

- **League-driven season end.** `getNextPhase` no longer ends the season on the user's 132nd game. `GameEngine._seasonProgress` (run by `advanceClock` after every league event) builds the bracket when the LAST regular-season game in the league is final, starts each round when every series of the previous one is decided, and enters SEASON_SUMMARY after the World Series.
- **`engine/PlayoffEngine.js` (pure)** — Section 26 bracket: seeding by win %, then head-to-head, then run differential; WC (1) → First Round (bo3) → Division Series (bo5) → World Series (bo7, better record hosts); `prepareRound`, `recordGame`, `roundComplete`, `stillAlive`. Series shape `{ id, round, teamA (host), teamB, winsA, winsB, status, winner: 'A'|'B', games }` — the shape PlayoffScreen reads. `SeasonEngine.buildPlayoffBracket` removed.
- **Scheduling.** Each round starts after one off day; one game a day at the evening slot (World Series travel days after games 2 and 5). The user's games are appended to `state.schedule` (normal live pipeline, PLAYOFF badges, Schedule round groups); everyone else's go into the league day map as real CPU games. When a series is clinched its unplayed games are removed.
- **Records.** Playoff results go to `postseasonWins/Losses` and player `postseasonStats` — never the standings or regular-season stats.
- **Milestones.** `advancePhase` split into sync `_applyPhase` + async save so the clock can change phases. Phase milestones without a game trigger are queued once on entry (playoff rounds only if the user is in them) in `state.milestoneQueue`; the user's series results queue Series Won / Champions / Season Over. `checkMilestone` serves the queue first; the App shows one per tick. Seen keys are now per season (`ID@season`) so Opening Day etc. recur every year. Phase milestones are no longer polled (they re-fired on load).
- **UI.** League → Playoffs tab (shown once a bracket exists) renders PlayoffScreen (fixed to the series shape; series log shows each game's away @ home score). Dashboard: banner shows the round and postseason record; the no-game card explains the state (regular season complete — waiting for the league's last games / through to the next round / eliminated in the X — follow along / champions). Scores browses every league date, including playoff days after elimination.
- **Harness.** Full postseason driven on the clock after game 142: bracket built, 9 series decided at exactly the wins needed, seeds follow the standings, champion crowned, SEASON_SUMMARY reached, no orphaned games, playoff games never touch regular records, user's live playoff games counted, postseason stats = one W per game. 8 seeds green.

### 68.1 Balance finding (needs a user decision)
Full league seasons now show the user's starting roster far above the league: contender finishes ~108–112 wins in 132 (target 88), ember's lineup (61.6) is already above every CPU lineup (48–59), empire's is 83. CPU clubs are generated around `str` 0.45–0.57 (base OVR 45–57) while archetype starters are 52–72 / 62–80 / 72–90. Raised to the user before Batch 2c.

---

## 69. r63 — League talent set around the archetype; one live-situation derivation (Session 8)
Closes §68.1. User decision: **adjust CPU team talent based on the archetype chosen.**

- **League talent level.** CPU clubs are built at base OVR `CPU_STR_CENTER×100 + (str − CPU_STR_CENTER)×100×CPU_STR_SPREAD + offset` (`data/constants.js`). `str` still orders the clubs; the **spread** (0.5) keeps the league's best and worst inside a realistic band (old spread produced 23–31-win and 97–102-win CPU clubs); the **offset** per archetype (`LEAGUE_TALENT_OFFSET_BY_ARCHETYPE`) sets how good the league is around the user so typical season-1 records land near the owner's win target. Calibrated with full simulated seasons: ≈2.75 user wins per point of lineup/rotation strength gap, one offset point ≈ 0.85 points of CPU strength.
- **`state.leagueTalentOffset`** stores the league's level. `createPlayer({ leagueLevel })` makes contract length and traits relative to it, and farm-director independent-league signings come in at `42 + level`. (Pay stays on one absolute OVR scale for every club — the user's payroll cap is set on that scale; corrected in r64, §70.)
- **Live diamond audit.** `SimEngine.liveSituation(revealed, nextPlay)` is now the single derivation of inning / half / outs / bases for both the user's live game (Dashboard) and the league viewer + mini cards (LiveGame). Fixed at the source: the play that records the third out now carries empty bases (stranded runners were shown on base for a tick while the inning label had already flipped to the next half); a pinch-hit play carries the real outs and bases (it carried `outsAfter: 0` — the outs display reset to 0 mid-inning — and `null` bases). The league viewer now flips to the next half after the third out exactly as the user's game does. Audited over ~100 games / 10k reveal steps: outs always 0–2 mid-game, bases always empty after a third out.
- **Running score (live scoreboard).** Every play of a half carried the score at the END of the half (`_updateCumulativeScores`), so the scoreboard showed a half's runs at its first pitch — before they scored. Replaced by `SimEngine._stampRunningScore`: each play carries the score after that play. The Dashboard linescore now shows the half in progress with its runs so far (broadcast style), so cells always add up to R. Decision spans (W/L/SV) also read exact per-play leads now.
- **CPU roster build.** A club's starting lineup, rotation and bullpen ratings are drawn stratified across their range (`_spreadTargets`) instead of independently — each club still has its star and its weak spot, but its core averages its intended level. Independent draws let pure roster luck swing a club ±15 wins (one CPU club went 101–31).
- **Play-by-play correctness found in the audit.** (1) A fielder's choice recorded **no out** — the runner forced at second stayed on base and the batter reached too; it now records the runner's out and moves the runners up on the force. (2) A routine groundout with a runner on first put the **batter** on second; the runner now moves up. (3) Pitchers were charged IP only for the batter's out — a double play's second out, a fielder's choice out and a caught stealing were never charged. Every out on a play is now charged to the pitcher of record (`_buildStatDeltas(…, outsRecorded)`; caught stealing carries the pitcher and his out). Audit: IP recorded = outs recorded in every half of ~100 games.
- **Injury split nudge.** Balanced leagues shifted the pitcher share of injuries to ~43%; SP 0.020→0.023 per start, RP 0.008→0.009 per appearance.
- **Harness.** New checks: contender wins 60–112; every CPU club 35–100 wins; and per user game, at every play: running score = runs scored so far, bases empty after a third out, IP = outs in every half. Calibration (full seasons, table offsets): ember ≈ 66, contender ≈ 86–91, empire ≈ 90, gambler ≈ 80, lab ≈ 78, institution offset lowered 19→16 after verifying low; CPU win spread sd ≈ .065 (MLB ≈ .07).

---

## 70. r64 — The offseason on the league calendar; season 2 (Session 8, Batch 2c)
Closes §64 **A1 (season-to-season)**. User decisions: **unsigned players mostly go to a league free-agent pool, but older players may retire and some sign with another league; one card per expiring player; the offseason always runs 6 days (no early spring, no start button).**

- **Calendar.** At the World Series' last out the league enters SEASON_SUMMARY and `state.offseason = createOffseason(endMs)`: day 1 starts the next local midnight, spring training opens the midnight after day 6. `GameEngine.advanceClock` interleaves the offseason steps with everything else on the clock (`OffseasonEngine.dueSteps`), each at its own time — catch-up after the app was closed replays them in order.
  | Step | Time | What happens |
  |---|---|---|
  | day1 | 00:00 | phase OFFSEASON; season locked into `seasonHistory` (record, target, postseason result, champion, standings); stats archived (`careerStats`, `careerPostseasonStats`, per-season `seasonLog`); every player ages a year and develops/declines on the §4.1 curves; injuries heal; retirements; next win target (§25); ownership card 9:00 |
  | day2 | 10:00 | CPU clubs decide every expiring deal (re-sign / free agent / another league); farm deals roll over; expiring waiver-wire players become free agents; one re-sign card per expiring user player (9:00); CPU free-agency round; FA cards for the GM (12:00) |
  | day3 | 10:00 | manager contract card if his deal is up; CPU round |
  | day4–6 | 10:00 | CPU rounds; new FA cards day 4; day-5 reminder if anything required is open |
  | spring | day 7 00:00 | open required cards auto-resolve (conservative path); unsigned free agents leave the league; coaches kept on; 2–3 amateur prospects join every farm (caps hold); CPU rosters set to 28; season N+1 calendar (spring opens that day); every record reset; SPRING_TRAINING |
- **`engine/OffseasonEngine.js` rewritten (pure).** The old 12-step functions (unwired, wrong data model) and GameEngine's `runOffseason` / `resumeOffseasonAfter*` / dead `_applyAgeAndDevelopment` etc. removed; `ui/screens/OffseasonScreen.js` (with its "Begin Spring Training" button) removed.
- **Contracts.** `contractExpiry` = first season not covered (a 1-year deal signed for season S has expiry S+1); a deal is up at the end of season S when `yearsLeft ≤ 1`. Asking terms (`marketTerms`): salary on the one league-wide OVR scale, discounted 15% at 32–33 and 30% at 34+; length by age and standing. CPU re-sign odds by OVR relative to the league level (75/60/40/20%, ×0.6 at 34+); a player not re-signed goes abroad (35% at 31+, 15% younger) or to the pool.
- **Free agency.** Pool players: `group/tier 'freeAgent'`, `_ask`, `_faFrom`. CPU clubs (random order, one signing per round): fill an open spot with the best fit who beats the farm option; a full club still upgrades by FA_UPGRADE_MIN (3) over its weakest reserve, who is optioned to the farm (or released if the farm side is full). ~25 signings per offseason in testing. The GM gets up to 3 FA cards on days 2 and 4 (open spot or a clear upgrade; names who would go to the farm when the 28 is full); soft gate — auto-pass after 3 days, withdrawn if he signs elsewhere.
- **Hard gates (§23.2)** are the cards themselves (`_osGate`): ownership (accept / push for +4% at −5 owner trust / unanswered: 3% tighter, −3 trust), contracts (re-sign / walk; unanswered = walks, −1 morale each), manager (extend 2 yrs +5% / open a search → new manager, −3 morale / unanswered: 1-year deal, −5 confidence). The pool manager/coaching cards no longer fire in the offseason.
- **Baseball calendar & age.** `state.baseYear` fixed at creation (old saves: year of their first scheduled game); `baseballYear(state)` = baseYear + season − 1; calendars are built for that year (season 2 = year+1, never read off the real clock). `computeAge(dob, seasonYear)` is baseball age (age on July 1), used by every engine and the Team screen/player card, so every player is exactly one year older each season; DOBs are generated against the season year.
- **Pay scale.** Corrects §69: CPU pay is back on the single absolute OVR scale (the user's cap lives on it); league level still shapes contract length and traits.
- **UI.** Dashboard `OffseasonCard`: "Offseason · Day N of 6", day focus, countdown to spring (or to day 1), required-decision chips (Ownership / Contracts n / Manager), last season's line, free agents on the market; banner reads OFFSEASON. Team screen flags "contract up". Inbox deadlines more than a day out name their day. Activity feed shows real-time "2h ago" (it showed "142g ago" for every entry) and records signings/retirements/departures at their event time.
- **Harness.** After the World Series the harness drives the six days hour by hour with the simulated GM acting on cards, then checks: phase order and timing, season 1 history, everyone a year older, stats archived, development young↑/veterans↓, retirements, no player on two lists or off-roster on a club, every rostered player under contract for season 2, FA pool empty at spring, one re-sign card per expiring player, ownership decided, all gates resolved, CPU signings, CPU clubs at 28, farm caps, prospects, records reset, full new calendar in year+1, and the first spring games of season 2 play and commit.

### 70.1 Open / next
- §23.3 offseason push cadence (one daily summary push instead of per-card pushes) not yet done.
- A Free Agents view (League tab) beyond the inbox cards.

---

## 71. r65 — Card actions, part 1: player availability & development (Session 8, Batch 3)
User decision: **ratings gains are gradual and varied — sometimes an immediate bump, other times slower.**

- **One availability test.** `PlayerFactory.isAvailable(p)` (not injured, suspended, or away) replaces ~30 ad-hoc checks across SimEngine, RosterEngine, GameEngine, LeagueEngine, TradeEngine, CardTokens and the Team screen (several missed personal leave).
- **`engine/DevelopmentEngine.js` (pure).**
  - *Availability:* `player.unavailable = { reason: rest|illness|training|benched|suspended|leave, gamesLeft, slot, rotationIndex }`, counted down after each of the club's games (`countGame`, user and CPU); when it ends he gets his lineup spot / rotation turn back.
  - *Condition:* `player.condition = { subRating, amount, gamesLeft }` — playing sick or hurt; the sim applies it through `_effectiveSR` alongside injury penalties.
  - *Development plans* (`state.developmentPlans`): each plan rolls an outcome — quick (20%: most the next day), gradual (55%: over 1–3 weeks), slow (15%: starts after 10–20 days), flop (10%: a fraction). Size × age (1.3 ≤24 … 0.4 at 34+), × trait (young gun, volatile/consistent spread), × the hitting/pitching coach relationship. Increments land on the clock (GameEngine roster step); an injury pauses the plan; a player not getting into games has each increment wait a day (up to 3). Gains spread over the focus skills by OVR weight. A finished plan sends a coach report card.
- **Cards act on the player they name.** `buildTokenMap` now returns which player each role token picked; `_createInstance` binds `_targetPlayerId` from the first player token in the card's text. Card OVR effects land on that player: a gain is a development plan, a loss is a temporary condition dip for 2–5 games (they used to nudge a random player's rating permanently). Suspension cards carry their game count (`_gamesToken` → the same number the text shows).
- **Actions wired:** `rest_active_hitter`, `bench_active_pitcher`, `bench_active_hitter` (rest / illness / benched / suspended by tag), `train_hitter`, `train_pitcher_sp`, `train_pitcher_bp` (away N games + development plan), `ill2_sick_start` (starts sick: −5 stuff for one game). A player card is only delivered — and stays in the inbox — while the club can spare him (`_canSpare`: a healthy bench bat; five healthy starters; four other relievers) and he is ours, healthy and not already away.
- **UI.** Team screen status chip "Rest 1 / Sick 2 / Train 3 / Sat 2 / Susp 4"; ▲ development marker (with OVR landed so far).
- **Harness.** The simulated GM acts on player cards; checks: cards delivered and acted on (~50/season), a "yes" takes the named player out of lineup/rotation at once, nobody away is ever in the lineup/rotation after a game, every absence ends, plans complete with exactly their realized gain, outcomes vary.

### 71.1 Remaining card-action families
Roster moves (call-ups incl. spring, audition, move to DH, bullpen → rotation, in-season extension/release), acquisitions (sign_*, waiver/DFA claims, trade_* cards — need acquisition tokens bound to real players), health (`injurePlayer_*`), org/media (scouting trips, media boost/suppress, crew/mascot/PA illness), then D2 personal leave and D3 pre-game / in-game card timing.

---

## 72. r66 — Card actions, part 2: the action registry and roster moves (Session 8, Batch 3)

- **`engine/CardActions.js` (pure) — one registry for what cards do.** Each action is `{ feasible(state, card), apply(draft, card, atMs) }`. CardEngine never delivers a card whose action can't happen (`cardFeasible` at instance creation), withdraws a card the moment it no longer can (clock-step sync), re-checks on the tap, applies through the owning engines and reconciles the lineup. `HANDLED_CARD_ACTIONS` is built from the registry. The §71 player actions moved here (`canSpare` too).
- **Cards name real players for every role they use.** `buildTokenMap` is card-aware (`_cardFit`): a contract-year card picks a player in his contract year (and above `_minRating` relative to the league level), a bullpen-to-rotation card a reliever with ≥55 stamina, a DH card a fielder in the lineup, an audition card a starter with a bench alternative. New roles: `prospect_hitter` / `prospect_pitcher` (the farm's best), `drop_hitter` (the weakest bench bat — who loses his spot), `audition_hitter` (the best bench bat who can play the named starter's position). Cards r2 and r5 were corrected to use them (r5 used `drop_hitter` for the auditioner, while every other card uses it for the man displaced). The instance keeps `_tokenPlayers` for multi-player actions.
- **Actions wired:**
  - `callup_hitter`: the farm's best bat is called up through the transaction ledger (reports next day). If the 28 is full, the weakest bench bat is optioned first.
  - `sp11_callup` / `sp11b_callup`: spring. The farm player joins camp as a keeper for Opening Day.
  - `audition_promote`: the bench bat takes the starter's lineup spot.
  - `move_to_dh`: the fielder moves to DH. The DH (if eligible) or the best bench option takes his spot.
  - `move_bp_to_rotation`: the reliever becomes a starter; the weakest starter goes to the pen; roles and positions are updated.
  - `retain_active_*`: in-season extension. `player.pendingContract` takes effect on offseason contract day, with no re-sign card.
  - `release_active_*`: "let him walk." `player._willWalk` — he plays out the season and leaves as a free agent on contract day.
- **Team screen:** "extended" / "leaving after season" notes.
- **Harness:** the simulated GM acts on every registered action and verifies each "yes" did exactly what the card said, immediately (`cardDidIt`). Also checks that in-season extensions take effect in the offseason. The roster canary accepts a spot that is open while its decision deadline is still ahead (§65 design). 8 seeds green; ~50–85 card actions per season across 12 action types.

### 72.1 Next: acquisitions and the rest
Acquisition cards (`sign_*`, `waiver_dfa`, `sign_dfa`, `dl3_acquire`, `trade_*`, NRI, international/indie scouting) still use flavor names (`{acq_*}`, `{dfa_*}`, `{intl_*}`, `{nri_*}`) that never resolved, so these cards could never be delivered. They need real players bound to them: the free-agent pool or generated players, the waiver wire, and CPU rosters through TradeEngine. Then health (`injurePlayer_*`), org/media, D2 personal leave, and D3 card timing.

---

## 73. r67 — Card actions, part 3: outside players are real (Session 8, Batch 3)

- **`engine/MarketEngine.js` (pure).**
  - `marketCandidate`: the best real free agent who fits a card (veteran / depth / prospect / international / independent, by side, position and minimum OVR). If nobody fits, it generates a player at the league's talent level. That player is handed back as a candidate and only joins the free-agent pool if the card is actually delivered.
  - `signingTerms`: veterans get a one-year deal at ~80% of market; prospects get a bonus plus a 3-year minor-league deal.
  - `signToClub`: to the 28, optioning (or releasing) the named reserve when full, including the 38-man spring camp; or to the farm, releasing the farm's least promising player when a side is over its cap.
  - `rentalTarget` / `prospectToSend`: trades.
  - In-season deals cover the current season (`applyContract(…, { startNow })`).
- **Tokens bound to real players** (`CardTokens._marketRoles`, by the card's action):
  - `acq_*`: the signing candidate, or the CPU club's player in a trade.
  - `dfa_player`: a CPU-waived player on the wire (claim), or a released free agent (sign).
  - `trade_prospect`: the farm player we'd send.
  - `nri`: a spring non-roster invitee.
  - `intl_player`: an international prospect, with `intl_country`.
  - `indie_player`: an independent-league prospect.
  - `drop_pitcher`: the weakest arm.
  - Also: real `era_10day` (the bullpen's ERA over its last 10 game-log entries) and `streak_context`.
  - A card with no real player to offer is never sent (`missingPlayer`), and the empty "()" artifacts in the card text were replaced with age / OVR.
- **No cash in trades (§9.1 LOCKED).** The b1, dl3 and dl4 deadline cards used to say "costs {trade_cost}". They now ask for one of our prospects, and the deal goes through the trade ledger (`queueTrade`, executes on the clock §65). The retired t1–t9 cards stay retired; real CPU trade offers come from TradeEngine.
- **Actions wired:**
  - `sign_acquire_hitter` / `sign_veteran_hitter`: the veteran signs and takes the weak starter's spot; the weakest bench bat is optioned.
  - `sign_acquire_pitcher` / `sign_prospect_pitcher` / `sign_intl_player` / `sign_intl_flyer` / `indie_sign`: the prospect goes to the farm with a bonus.
  - `sign_dfa`: a released veteran joins the 28.
  - `waiver_dfa`: puts in a claim. It's resolved when the 72-hour window closes, in claiming order (worst record first, the user included). The GM gets a "claim awarded / lost" card; if the claim is won with a full 28, the weakest reserve is optioned.
  - `trade_acquire_*` / `dl3_acquire`: a CPU club's player for one of our prospects.
  - `sp15_callup`: a non-roster invitee joins spring camp.
  - `intl_workout`: the workout result arrives in 3–5 days as sc3_sign or sc3_fail about the same player.
  - `scouting_intl_trip`: 1–2 workout leads from that country over the next week.
  - `scouting_indie_tip`: the scout's report card arrives in 2–4 days.
  - `sr2_shakeup`: call up the farm's best bat and option the weakest bench bat.
- **Follow-up cards** (`_intlFollowupOnly`) are never drawn from the pool; they are delivered only about the player they follow, and withdrawn if he signs elsewhere.
- **Harness:** every one of these actions is verified to have done what the card said. 27 action types were exercised across 8 seeds; all green.

---

## 74. r68 — Card actions, part 4: every live card is wired (Session 8, Batch 3 complete)
Closes §64 **D1–D3** and a gap the audit didn't list: **follow-up chains never fired** (`_fireFollowup` was an empty switch, `_followup` configs were never read).

- **Card-invented injuries retired.** i1–i8 and their follow-ups (i4/i6/i8_followup) made up an injury on a random player, outside the injury system. That bypassed the calibrated injury rates, the IL minimums and the two-act exam flow (§65). Injuries now come only from games (InjuryEngine), and the GM decides through the two-act cards. Retired cards keep `_retiredWhy`.
- **Follow-up chains (§74).** On resolve, a card with `_followup: { on, chance, delayMin, delayMax }` sets its FOLLOWUP_POOL card in motion a few days later (delays were written in games; ≈ one a day). It is about the same players (`_tokenPlayers` preset, pitcher names keep their hand), and only if the follow-up's own actions are handled.
- **D2 personal leave.** PERSONAL_LEAVE_POOL joins the regular-season pools (weight 0.12 per card). Both choices send the player away (`unavailable.reason = 'leave'`). The choice sets the length: bereavement 5 vs 3 games, paternity 6 vs 3, family medical 5 vs 3, emergency/personal 3. An unanswered card resolves as "no" and he still goes, for the minimum: **a card whose auto path is "no" now runs its `onNo` action** (this also applies to "let him walk" on unanswered extension demands).
- **D3 timing.** Instances carry `_pool`. PREGAME cards are scheduled 45–150 min before first pitch and expire at first pitch. INGAME cards are scheduled 20–120 min into the game. Everything else is spread between games as before.
- **Ballpark / front office actions:**
  - Stadium staff out sick with nobody hired: `ill5a_crew` — the crew either steps up (groundskeeper relationship +2) or the field shows it (atmosphere −2). `ill5b_mascot` — atmosphere −2. `ill5c_pa` — −1, or a 20% fan-favorite night (+2).
  - `media_boost`: two days away from scouting prep. `scouting_suppress`: an 8-day scouting freeze, and the savings are credited back. While scouting is quiet (`userTeam.scoutingQuietUntil`) no SCOUTING cards are delivered.
  - Instances keep their money draws (`_amountsK`) for actions.
- **Money is the limit on adding players.** A signing, claim or trade card is only delivered (and stays in the inbox) while it fits: the salary under the payroll cap (a player optioned to make room comes off the payroll), the bonus within the operating budget that's left. A workout isn't booked for a player we couldn't afford to sign. Before this, a GM saying yes to most offers stacked the roster (one test season ended 114–18).
- **A decision is judged on the world the GM tapped in.** `resolve` asks the action's `feasible()` *before* charging the card's own cost, then carries the action out. A card's feasibility already counts its own price (a scouting trip needs money left after the trip for a lead's workout and bonus); re-checking after the charge counted it twice, and a GM who could afford the trip got nothing for it. Auto-resolved cards charge nothing first, so they're still checked at the moment they resolve. Each trip lead is its own card (keyed by instance, since it isn't about a named player yet).
- **Late joiners sign on.** A player who joins a club after offseason contract day with his deal up (a late waiver claim or outright) signs a one-year market deal at spring open. No one opens a season without a contract.
- **Injury rates.** RP 0.009 → 0.0095 per appearance. The harness's pitcher-share band became 36–64%, because about 130 injuries a season carry ±4–5 points of binomial noise.
- **Result:** 0 of 241 live card definitions are gated; every live follow-up's actions are handled. Harness: follow-up chains fire, pre-game cards arrive before first pitch, every action does what its card says.

---

## 75. r69 — The All-Star Game (Session 8, Batch 4 · E1)
Closes §64 **E1**. Before this there was no All-Star Game: the break was four empty days after game 66, and the §17 hosting functions were never called.

**Decisions (GM, Session 8):**
- **A real All-Star Game every season.** Division A's stars vs Division B's. Hosting is the extra prize on top.
- **Host: a same-season surprise (§17.2 as locked).** The league names the host after the user's game 45–55, for that season's game.
- **Watched live, like a regular game.** It plays at a real time during the break, with the live diamond, play-by-play and box score.

**The calendar.** The game is a league-calendar entry (`asg-<season>`, `isAllStar`) on day `ALLSTAR_GAME_BREAK_DAY` (2) of the four-day break, at `ALLSTAR_GAME_TIME` (8:00 PM). It is generated with every season's calendar (SeasonEngine). It starts and finishes through the same league-clock path as every CPU game (`_startLeagueGame` / `_finishLeagueGame` hand off to `_startAllStarGame` / `_finishAllStarGame`). It's an exhibition: no stats, standings, rotations or injuries move. The host's division's squad bats last.

**AllStarEngine (new, pure).** `state.allStar = { hostingScore, hostedCount, lastHostedSeason, hosts[], season, history[] }`. The legacy `allStarHostingScore` / `allStarHostedCount` / `allStarLastHostedSeason` / `userTeam.hostingScore` fields are removed. The old PrestigeEngine hosting functions were never called and are deleted.
- **Hosting score (§17.1) — never shown as a number.** It grows from:
  - every home game, by atmosphere above 55 (`HOSTING_PTS_PER_ATMO_POINT`);
  - ballpark and fan-experience card decisions (`_hosting: { yes, no }` on about 20 pool cards — facilities, stadium ops, field prep, travel and visiting-club care);
  - a season bonus when the average home atmosphere is 70 or higher.
  
  15% of the score fades each offseason (`HOSTING_SCORE_CARRYOVER` 0.85), so a bid is built by sustained effort.
- **Naming the host.** The user's club hosts when the score clears the bar for its next hosting (850 / 1400 / 2200), the prestige tier is met (2 / 3 / 5), the wait since last hosting is met (– / 3 / 4 seasons) and atmosphere is 65 or higher. Otherwise the CPU club that has waited longest hosts. A new franchise joins a league where each CPU club hosted once in the previous nine seasons.
  - **If the user hosts:** the Commissioner's Office card (`_prominent`: gold, labeled "ALL-STAR"). The §17.3 payoff applies at once: $10–15M revenue scaled by atmosphere and tier, +15 atmosphere, +10 owner trust, +5 GM relationship with every club.
  - **If someone else hosts:** the League Office says so and, in words, where our ballpark stood: "a finalist", "in the conversation", "not on the list yet", or a prestige / atmosphere / too-soon reason.
- **The vote (after the user's 58th game).** Per division, a 24-man squad: 13 hitters, 6 SP, 5 RP.
  - Nine starters by position (the fan vote), then the reserves a manager needs (a second catcher, a middle infielder, an outfielder), then the best bats left.
  - At most 6 per club beyond the elected starters, and every club sends at least one.
  - A vote blends first-half production (OPS plus HR and SB; run prevention, wins and K for starters; saves and holds for relievers) with reputation (OVR against the league).
  - **Only healthy big-leaguers can be voted in** (lineup, bench, rotation, bullpen, extra arms) — never the farm, the IL or a player between clubs. The league baselines come from the same players.
  - **Playing time is part of the case.** A player's numbers carry his vote once he has 60% of a regular's playing time at the break: a lineup regular's PA, a rotation starter's IP, a regular reliever's IP (all league medians). Below that, his vote is scaled toward half (`PLAYING_TIME_FLOOR`). A star back from an early injury can still make it on reputation; a swingman's 20 good innings can't.
- **Host's lobbying (§17.3 selection influence).** Three games before the rosters, the host GM can make the public case for his best player just short of the squad (an 8% vote boost) or stay out of it. The card is withdrawn when the rosters are named.
- **Game day.** At first pitch, anyone hurt, sent down or released since the vote is replaced by the next in line (each replacement is in the feed with a ⭐). Each squad's plan:
  - the nine starters in a real batting order;
  - each reserve paired with a starter he replaces from the 5th–7th inning (`_plannedSubstitution`), so everyone plays;
  - the best-voted SP starts and works 2 innings, every other arm 1, and the reliever with the most saves closes.
- **After the final.** The MVP is the best game on the winning side (`allStarMvps`). The selection, MVP and host are kept in `allStar.history` at the end of the season.

**The host's week (§17.3).** Three cards on the day before the game, each due at first pitch:
- FanFest title sponsor: revenue vs atmosphere.
- Youth clinic: budget vs atmosphere and owner trust.
- National media access: atmosphere vs clubhouse.

After the break: +1 atmosphere at each of the next 20 home games, and one trade offer from a player who "spent All-Star week in our ballpark" within 10 games.

**The GM sees:**
- An inbox card naming our All-Stars (role and position).
- ★ next to each All-Star on the Team screen, and an All-Star / MVP line on the player card.
- The Dashboard's game area belongs to the All-Star Game from our last game before the break until the morning after it:
  - before first pitch: matchup, place, countdown, our All-Stars;
  - live: the same live card as our games (scoreboard, diamond, linescore, play-by-play, box score, refreshed every 5 s) plus our All-Stars' lines;
  - final: score, MVP, box score and our All-Stars' lines.
- The schedule lists the game; the Debug screen shows the hosting score, the bar and the reasons.

**Fixed along the way (all games):**
- **No phantom relievers.** A tired pitcher was replaced at the end of his inning, before the game knew whether there'd be another half. When the game then ended (home team ahead after the top of the 9th, or a regulation finish), a reliever showed in the box with 0.0 IP, never having thrown. The change now happens when the pitcher's side next takes the field, as a manager makes it: first play of that half, nobody out, bases empty.
- **Games started and quality starts are recorded.** `gs` and `qs` were never counted for anyone. Each side's starter is the first pitcher to face a batter for that side. A quality start is 6+ IP with 3 or fewer ER.
- **Team screen status chip** read "Bench" for every lineup starter: it checked the `STARTING_HITTERS` group, which no hitter carries under the lineupSlots model (rule 5). It now reads the club's `lineupSlots`.
- **Inbox deadlines.** Any decision card with a real-time deadline (pre-game, All-Star week, roster) shows its "by" time; before this only roster cards did. Notices show none.

**Found, deferred to Batch 4 · E3 (fatigue):**
- **The simulator's bullpen is used weakest-first, every game, with no rest.** The weakest arm pitches nearly every 6th inning, and the best relievers barely pitch (median 8 IP at the break, while a few low-rated arms have 60–90). Relief usage needs roles (closer, setup, middle, long) and rest days.
- **TradeEngine `_assessDepthImpact`** still keys "improvement" on the `STARTING_HITTERS` group, so an incoming hitter never counts as filling a need. Fix with user-initiated trades (B7).

**Harness:** the game is on the calendar once and mid-break. The host is named in window and his division is home. Host seeds get the payoff, the host card, the three week cards and the lobbying card with the choice recorded; non-host seeds get the longest-waiting club and the reasons. At selection: healthy big-leaguers only and no swingman starters. Two 24-man squads, positions filled, every club represented, no one twice. Our All-Stars are told and marked. The game goes live with plays; score, box and linescore agree; no pitcher past 2 innings; the reserves get in; nothing outside the game moves; result and MVP are recorded. In season 2, last year's game is on the record and the new one is on the calendar. Every pitcher in every box score faced a batter. Two starts per game. 8 seeds green.


---

## 76. r70 — The bullpen, pitcher fatigue and rest (Session 8, Batch 4 · E3)
Closes §64 **E3** (`_simFatigued` was never set, so the §7.4 fatigue modifiers never applied) and r51's open note ("true one-inning-per-arm bullpen usage").

**What was wrong.** Each game's bullpen was the relief pool sorted weakest → best, always entered from the top, with no memory between games. The weakest arm (often a spare starter) pitched the 6th nearly every day, and a club's best relievers barely pitched. In r69, IRF's three best relievers (OVR 64–65) had 0 appearances at the break while a 52 had 68 IP. Nothing tracked rest, and a tired pitcher was never worse.

**PitchingEngine (new, pure) — how a manager runs a staff:**
- **Roles** (`bullpenRoles`): the relief corps (bullpen + pitcher bench, healthy) as a depth chart:
  - long men: the spare starters, most stamina first;
  - the rest by relief value (stuff .45, control .25, OVR .30): a closer, two setup men, then middle relievers.
  
  Computed from the roster (no stored state), like the manager would line them up.
- **The arm's record** (`player.arm = [{ at, day, bf, outs, start }]`, last 6 days): after every final out, user and CPU (`recordOutings`). Rest is counted in **calendar days by the day each game was played**. Elapsed hours rounded (the first version) misdated night-to-day turnarounds.
- **Rest** (`armStatus`):
  - **down** (can't go today): pitched today, two days running (never a third), 10+ batters yesterday, 18+ in the last two days, or a start's worth (25+) in the last three. Thresholds scale up with stamina (×0.7 + stamina/150).
  - **tired**: pitched yesterday, three outings in four days, or a long one two days ago.
  - **fresh**: otherwise.
  
  Starters need **four days' rest** (`starterRested`). The rotation skips a starter who hasn't had them, to the next man who has.
- **The manager's call** (`chooseReliever`), at the start of the half his side fields:
  - 9th+, up 1–3 or tied: closer, then setup;
  - 8th, close: setup;
  - 7th, close: the second setup man;
  - a blowout (5+) or an early hook (≤ 5th): a long man;
  - anything else: middle relief.
  
  In the late innings of a close game he takes the first arm who can go (his closer pitches back-to-back, never a third day). Elsewhere a rested arm first, and the low-leverage work is shared (within a role, the arm with the most days off). Only with no one else does an arm who needs rest pitch; then it's the one who has rested longest. Never someone already used.
- **When a pitcher comes out** (`_accrueInningAndFatigue`): his innings are in (relievers 1, long men 2–3, starters by stamina), he's past the batters his stamina carries, or a starter was hit hard (5 by the 6th, 4 by the 3rd). In a 9th-inning save a starter still going makes way for the closer. **A taxed pen:** a pitcher who's done only because his innings are in, and isn't tired, is asked for another inning when nobody rested is left.
- **§7.4 fatigue applies** (replaces `_simFatigued`): past `tireAfterBF` (starters 9 + stamina/5 ≈ 19–26 batters, the third time through; relievers 4 + stamina/12), the pitcher allows +10% hits, −15% K and +10% BB until he's replaced. A reliever who comes in still tired from recent days tires twice as fast. The flag is passed to the at-bat (`context.pitcherTired`), never written on the player.
- **League norms by innings.** The average pitcher a batter faces is weighted by the innings each arm actually throws (before he has any, a role prior: SP 30, RP 10, pitcher bench 5). Counting every arm equally, including the ones who barely pitch, would mis-measure the league once the best arms pitch the most.

**Roster balance (found while testing — the cause of empty pens).** The harness GM's club ran with 19–20 hitters and 8–10 pitchers for weeks. Pens of 3–4 healthy arms meant the third-day outings. "Is there room?" only counted the 28 total, so a pitcher's open spot (IL, trade) filled with a bat and never came back. **A roster spot belongs to its side** (14 hitters, 14 pitchers; 19/19 in camp):
- `rosterIsFull(state, teamId, side, { excluding })`: a hitter fits only while the hitters are under 14, a pitcher while the pitchers are under 14 (`excluding`: the man about to make room).
- Applied to call-ups, every card action that adds a player, signings (in season and offseason: `hasRoomFor` / `displacementFor`), IL returns, and **every club's waiver claims**. A CPU claim used to fill whatever spot was open; now, as for the user, the weakest same-side reserve goes down.
- A club over 28 (a trade) sheds from the side that's over its share (`_droppable`).
- `callUp` explains the refusal: "We already carry our 14 pitchers. Open one of their spots first."

**CPU managers play their best nine.** A CPU lineup only filled empty slots: a better bat (a waiver claim, a call-up, a player back from the IL) sat on the bench forever. One club went 28–104 with its best bench bats at 0 PA while a 49 played shortstop every day. In the reconcile, a healthy bench bat at least `CPU_LINEUP_UPGRADE_MARGIN` (3) OVR better, eligible at the spot, takes the job. The user's lineup stays the GM's.

**The GM sees:**
- On the Team screen, each reliever's role (CL / SU / MR / LR, the bullpen listed in the manager's order) and "tired" or "resting today".
- Bullpen arms read Active; the pitcher bench reads Bench.
- The pitching-change play carries `_role`.

**Harness (8 seeds green):**
- Relievers never pitch a third day in a row (0–13 per ~4,400 relief outings, only when a pen has nobody else).
- Starters start on four days' rest (≤ 2 per ~1,410).
- Relief work is spread (median 38–50 relief G; the busiest relief arm 70–97 IP, a long man).
- Closers collect the saves (top 10 hold 55–68%). Starters go 5.1–5.5 IP/GS. Every pitcher in a box faced a batter.
- Every club carries about 14 hitters and 14 pitchers.
- Run environment 3.6–4.4 R per team per game.
- Balance: the contender 70–100 wins (96–113 before the CPU lineup fix), CPU clubs 45–92.
- Dev dumps: `ARM_DUMP=1` (third-day outings with what the engine decided), `BAL_DUMP=1` (the worst CPU club's roster, runs and staff).

**Pending decision (B7): cash in trades.** §9 is LOCKED "no cash in trades", and r66–r68 built the deadline trade cards on it (a prospect instead of cash). The GM wants to reconsider: in real baseball, clubs send money to balance salaries or a deal. **Discuss with the GM before implementing B7 (user-initiated trades).** Open questions to bring:
1. Cash in both directions, or only to cover salary?
2. How the amount is set — the §9.2 formula (rating differential, salary, season phase) was never designed.
3. Whether cash counts against the operating budget or payroll.
4. Whether CPU-proposed offers change too.
5. Whether the deadline cards (b1 / dl3 / dl4) go back to cash or stay prospect-based.

Also fold in with B7: `TradeEngine._assessDepthImpact` still keys "improvement" on the `STARTING_HITTERS` group (§75).

**Observed, not changed:** the harness GM (who says yes to nearly every helpful card) wins 70–100 with the contender. Worth watching once real play data exists.


---

## 77. r71 — Push key: always from the worker (Session 8, Batch 4 · E4)
Closes §64 **E4**. `data/constants.js` bundled a copy of the VAPID public key as an "offline fallback" for subscribing. It still held the key from before the Oct 26 rotation.

**Decision (GM, Session 8): remove the copy rather than update it.** It did nothing useful:
- Setting up push needs the worker anyway (`POST /register`), so offline the fallback couldn't complete a sign-up.
- Stale (as it was after every rotation), it subscribed the device with a key that could receive nothing, which the app then had to tear down and redo.

**Now** `PushClient._vapidKey()` always asks the worker's `GET /vapid-key`.
- If the worker can't be reached it throws (`code: 'unreachable'`); nothing is cached.
- An existing subscription is never touched on a failed fetch: it is replaced only when the key is known to have changed.
- `enablePush()` returns `'unreachable'`, and the app says "Couldn't reach the notification server. Check your connection and try again."
- The test-push button reports the same reason.

Key rotations no longer need an app change: rotate in Firebase, update the Cloudflare secrets, and devices re-subscribe on their next sync. `VAPID_PUBLIC_KEY` is removed from constants (the worker's binding of that name is unchanged).

**Batch 4 status:** E1 (§75) and E3 (§76) are done, and E4 is now done. **B7 (user-initiated trades) is on hold** pending the cash-in-trades discussion (§76).


---

## 78. Club Funds — the money model (Session 8 design, decided with the GM)
Replaces §4.2's four separate concepts and §9's no-cash rule. **Why:** an audit (Session 8) found that salaries were never paid. Payroll was only a ceiling checked when a card added a player; re-signings and offseason free agents ignored it. The contender opened over its cap with no consequence. Revenue was tallied and fed nothing. Staff salaries were never charged. CPU clubs had no finances at all (payrolls $8.6M–$36.6M, unlimited signings). Extensions charged an invented "$200–500K fee" from the operating budget. 11 cards promised a `budget` effect the engine ignores, and 13 used `managerConf` while the engine reads `manConf`.

### 78.1 Decisions (GM)
- **Option B: one bank account — Club Funds** (the $ in the header). Every dollar in or out moves it. The operating budget and the revenue metric retire into its two sides.
- **Profits carry over** season to season (a good season funds the next).
- **Paydays every two weeks** in the regular season (the 1st and 15th), each a feed entry.
- **Minor-league salaries are not modeled.** A farm player costs nothing until he joins the active roster or IL; from then he is paid like anyone.
- **The GM never sets ticket prices.** Cards may still talk about prices (an owner wanting a discount, a premium-seating push), and their effects become real (gate multipliers for a stretch).
- **The extension fee is retired.** An extension costs its salary.
- **Owner strictness depends on the archetype and the season's record** (see 78.4).
- **Cash in trades** moves between club funds (78.6).
- **Cards are part of the model, not decoration.** Adjust the cards that no longer fit, retire the ones that can't, and add new card families the money model makes possible. Text varies by archetype, record, prior decisions, funds, the owner's mood and CPU clubs' situations, so the whole thing reads as one living franchise and never feels repetitious.

### 78.2 Money in
Scaled to each club's payroll level, so a club that meets its owner's expectations runs **near break-even** (tuning target: income ≈ 1.03 × expected spending at the archetype's starting atmosphere and a win-target pace). Market differences show in local revenue and gates. Constants live in `data/constants.js`.
- **League media share:** equal for every club, paid in installments on paydays.
- **Local media and sponsors:** by market/payroll level and prestige, on paydays. Sponsor and revenue cards add on top.
- **Home gate,** at each home final: `gateBase × attendance factor`. Attendance comes from atmosphere (absolute), the club's form against expectations, the opponent's draw, and later weather. The final shows "Attendance 31,204 · Gate $162K". Playoff home games pay a multiple. An improving atmosphere raises income, so a rebuild's fan work pays off in money.
- **Other:** All-Star hosting share, cash received in trades.

### 78.3 Money out
- **Payroll:** salaries accrue **daily** across the regular season (annual salary ÷ the season's days) for everyone on the active roster or IL that day, and are paid on paydays. A deadline pickup costs only the rest of the season; a departed player stops costing. Nothing in the offseason.
- **Coaching staff salaries:** accrued and paid the same way.
- **Immediate:** card costs, signing bonuses, scouting trips, cash sent in trades.
- **A ledger** (`finances.ledger`) records every movement with its reason; the season's income and spending by category are summed from it. The books always reconcile to the dollar (harness check).

### 78.4 The owner
- **Payroll target** (replaces the payroll cap): set each spring. It is a soft limit; what happens when you exceed it depends on his patience.
- **Patience** = the archetype's base + the season's pace against the win target + owner trust (+ the Gambler's mood, a random walk each payday).
- **Financial stress** = how far payroll is over the target + how deep the projected year-end funds are in the red (as a share of payroll). For the Lab, cost per win also counts.
- **Stages, evaluated each payday:**
  1. **Content** (silent).
  2. **Watching** (a note in his voice).
  3. **Concerned** (a warning with a clear ask; trust slips each payday).
  4. **Ordering cuts** ("payroll down $X by the next payday").
  
  An order met restores some trust. Missed: a sharp trust drop and a smaller target next season.
- **Winning buys room:** a club well ahead of its target pace can run over the target, or into the red, and only reach Watching. A club well behind reaches Ordering cuts quickly.
- **Archetype owners:**

  | Archetype | Owner |
  |---|---|
  | Ember | Tight-fisted, hates red ink; patient with losing. |
  | Contender | Middle; spends for a push, not for a losing team. |
  | Empire | Deep pockets, little patience; overspending is fine, overspending and losing is not. |
  | Gambler | Moody: generous some weeks, demanding others. |
  | Lab | Patient with losing; strict about cost per win. |
  | Institution | Conservative; dislikes debt more than overspending; values steadiness. |

- **Adding salary in season** (signings, claims, trades): allowed while the club's payroll stays within the owner's current tolerance of the target (a function of patience: 0% for an unhappy owner up to about 15% for a delighted one), and funds can cover any immediate cost. This replaces r68's hard cap check, and it now also covers offseason signings and re-signings.
- **Season review:** the owner covers any red ink (at a trust cost) and sets next season's target from results (the existing performance formula) **and the books** (profit or loss now matter, as §4.2 intended). "Push for more" stays.

### 78.5 CPU clubs keep books
Same model, simplified. Each CPU club has a payroll target (from its payroll at creation, i.e. its market), funds, gates and paydays. Their owners' tolerance limits their free-agent signings and waiver claims (today unlimited). A club over its target or in the red sheds salary: it offers players, sometimes with cash, which feeds trade offers and the card ecosystem ("RDC will cover $1.2M of his salary").

### 78.6 Cash in trades (with B7)
Cash moves between club funds, usually covering part of the traded player's **remaining** salary for the season. CPU clubs accept or offer cash by their books: a flush club takes on salary; a strapped one pays you to take it. User-initiated trade proposals (B7) are built on this. `TradeEngine._assessDepthImpact`'s `STARTING_HITTERS` check is fixed with it.

### 78.7 What the GM sees
- **The header chip:** Club Funds, red when negative.
- **A Finances view:** funds now; the season's income and spending by category; payroll against the owner's target; the next payday and its size; projected year-end funds; the owner's mood in a line.
- **Home finals:** attendance and gate.
- **The feed:** paydays.
- **Card text** names where the money goes or comes from.

### 78.8 Card audit (Session 8) — what changes in the card pool
156 card definitions touch money. 80 charge a cost and 28 pay revenue; these move to Club Funds automatically.
- **Broken today (promise money that never moves) — fix:**
  - `budget` effects on o1, fn1, sp_renew, sp_complaint, sp_slot_conflict, sth_group_conflict, sth_delinquency, fr4_followup;
  - fn5 ("budget takes the hit" — no cost);
  - bg4 (savings never credited);
  - sr1 and ms2 (ownership "loosens the budget" — nothing happens).
  
  A real `funds` effect replaces `budget`. The engine's `manConf` / `managerConf` mismatch is fixed.
- **Become real under Club Funds — rework:**
  - o4: an owner-requested ticket discount becomes a gate multiplier and attendance lift for a stretch;
  - season-ticket cards (sth_*): renewals and delinquency move real gate/STH money;
  - sponsor renewals (sp_renew): recurring payday income gained or lost;
  - broadcast renewal (fn3): media installments;
  - attendance and crowd cards: tied to the real attendance figure;
  - ownership push cards (sr1, o1, ms2): the owner actually raises or lowers the payroll target, or adds funds.
- **Reframe (the operating budget no longer exists):** the CFO "budget review / overrun" family (fn1, fn5, sp10, bg4) speaks about club funds, paydays and the owner. fn6 (payroll error) ties to a real payday.
- **Retire:** the extension fee on the retain cards (`_budgetCost: 'ext_cost'`).
- **New card families the model makes possible** (each with variants by archetype voice, record, funds and owner mood):
  - **The owner:** watching / concerned / ordering cuts; delight at a profitable winning season; red-ink conversations; a mid-season offer to fund a push. Varies by archetype personality.
  - **Paydays and cash flow:** a tight-funds week (defer maintenance? pass on a promotion?); a windfall week.
  - **Attendance:** sellout streaks, empty-seat concerns, giveaway and promotion nights that cost money and lift a gate, rivalry and weekend boosts.
  - **CPU salary dumps:** a struggling club offering a good player plus cash; a flush club asking us to take a contract; a rival's payroll troubles in the news.
  - **Contracts and money:** an agent's leverage when funds are visibly strong; a player asking for a raise after a big year; deferred-money offers.
  - **Postseason money:** playoff gate windfalls, player playoff-share asks.
  - **Media rights:** renewals tied to market and winning.

### 78.9 Build phases (each its own release, 8 harness seeds green)
1. **Phase 1 — FinanceEngine and the user's books:**
   - funds, ledger, daily accrual, paydays, gates, media and local income;
   - card costs and revenue into funds; the extension fee retired; a real `funds` effect replacing `budget`; the `manConf` fix;
   - the payroll target and owner tolerance (replaces the cap checks everywhere);
   - owner patience and the stage cards, season review and carry-over;
   - the UI (chip, Finances view, gate on finals, payday feed).
2. **Phase 2 — CPU books:** markets, funds, paydays and gates; spending limits on CPU signings and claims; CPU clubs shedding salary.
3. **Phase 3 — the card pool:** the audit list above (rework, reframe, retire), the new families, and variants by archetype, record, funds, owner mood and CPU situations.
4. **Phase 4 — cash in trades and B7** (trades the GM starts).

### 78.10 Phase 1 as built (r72)
- **`engine/FinanceEngine.js`** (pure; imports only `dayOf`): `initFinances`, `ensureSeason` (the season calendar: paydays the 1st and 15th plus a settling payday at season end), `dueSteps` / `accrueDay` / `payday`, `crowdFor` / `homeGate`, `projection`, `patience` / `strain` / `ownerStage`, `tolerance`, `canAddSalary` / `canSpend`, `ownerReview`, `cutOrderAmount` / `contractToMove`, `seasonEndReview`, `booksOfferAdjustment`. Every dollar is a ledger line (`post`), so the books always reconcile.
- **Who gets paid:** `player.contractMLB` — a major-league deal is paid wherever he plays, including in the farm. A prospect on a minor-league deal is paid only while he is on the active roster. Signings in the spring flag the active roster; `applyContract` sets the flag from the terms; depth signings are minor-league deals. Releasing a player mid-season leaves dead money for the rest of his salary that season.
- **Income:** a media share equal for every club (`FIN_MEDIA_SHARE_K`). Local revenue and the gate come from a market calibrated so a club at its owner's win target and starting atmosphere breaks even (`FIN_BREAK_EVEN_MARGIN` 1.0). Attendance comes from atmosphere, recent form and the day of the week. The crowd is set at first pitch (`g.attendance`, `gateK`, `sellout`; shown on the live line) and banked at the final. Playoff gates are ×1.5. Spring and postponed games bring in no gate.
- **Owner:** patience (archetype + pace vs win target + trust + Gambler mood) against strain (payroll over target net of a projected-funds cushion × `cushionUse`, red ink × `redWeight`, Lab cost per win). Stages: content → watching → concerned → cuts. A cut order names a contract (`contractToMove`) and is due at the next payday. The GM either moves it (a salary dump to the lowest-payroll CPU club) or the target is lowered next winter (`OWNER_ORDER_TARGET_PENALTY`). At season end the owner covers any red ink, and the books adjust the ownership offer.
- **Every salary path asks the owner:** card signings (`affords` → `canAddSalary`), FA cards, extensions (for the raise), and CPU trade offers (`_tradeSalaryOk` both at delivery and at execution; a blocked deal sends `owner_trade_blocked`).
- **Roster arrivals make a corresponding move:** a full side sheds its over-represented side first, otherwise the weakest reserve is optioned out.
- **Calibration found by the harness (8 seeds, a 142-game season):** season nets run from about −1.3M to +6.5M operating on a $22M target. The All-Star hosting share is a separate, one-time line. Harness check: |operating net| ≤ 35% of target.
- **Run environment recalibrated (r72).** The harness had only measured the user's games. Measured across the league, CPU-vs-CPU games — an average lineup against an average staff — ran 3.4–3.8 R/G. That was the same at r71, so it was not a money regression; the PA model's base rates were simply below MLB (H/PA .197, HR/H .10, K .242). New base rates: walk .080, K .226, hit .212, HR share of hits .128, doubles .195. League play now runs about 4.0–4.3 R/G, .243 AVG, ~1.0 HR, ~8.4 K and ~3.5 BB per team-game. The harness now checks the league environment (3.8–5.2) as well as the user's games (3.2–6.0).


## 79. Live view polish (r73, Session 8 — GM feedback)
- **Open on the game as it stands.** On launch the app used to draw the dashboard first and only start the game on the first 5-second tick, so a game already underway showed a "GAME IS LIVE" placeholder for a few seconds. The tick loop body is now `App._runTick({ quiet })`. It runs once **before the screens mount** (at boot and on team load), and immediately on resume. A game whose first pitch has passed therefore opens straight onto the full live view. `tick()` reveals every play that is due in one call, so the old resume fast-forward loop is gone. A re-entrancy guard means a commit can never start twice.
- **No team colors in the live view** (our game, CPU viewer, box score): team names, linescore, tabs, play-by-play lines, inning headers and box-score figures use `--text` (white in dark mode). Occupied bases fill with `--text`. Red stays for the LIVE pill and the out dots. Inactive tabs are dimmed by opacity, not by color.
- **Runs vs RBI, structurally.** Every play now carries `runs` (what scored; the score, linescore and decisions count these via `SimEngine.playRuns`) separately from `rbi` (the batter's official credit). No RBI is given on a ground-into-double-play or on a run that scores on an error. Earned runs come from `runs`, except a run on an error, which is unearned. Plays saved before r73 fall back to `rbi`.
- **Play-by-play calls the RBI.** Home runs are named by size (solo, two-run, three-run, grand slam). Any other play that drives in runs ends ", RBI" or ", 2 RBI". A run that scores without an RBI reads ", a run scores".
- **The feed holds its scroll.** The CPU viewer redrew every 5 seconds whether or not anything happened, which reset its scroll. It now redraws only when the game moves (a new play, the final) and keeps the sheet's position. A dashboard redraw for another reason (a roster move elsewhere) keeps the same game's tab and play-by-play scroll. Only a new game starts fresh on Play by Play.

## 80. The game day's inbox (r74, Session 8 — GM feedback)
**Found:**
1. Cards were only ever selected at a game's final (`checkAndDeliver` after `commitGame`), so a new team's first game day got nothing after the setup cards.
2. The phase's pools filled three shared slots in a fixed order. The general decisions pool always filled all three, so the pre-game, in-game, between-games and personal-leave pools almost never delivered.
3. Spring training excluded the pre-game and in-game pools, so its written spring game-day cards (media backlog, the visiting team's bus, a TV crew in the tunnel, the vendor walkout) could never arrive.

**Built:**
- **`GameEngine.planCardsForNextGame()`** plans each game day once (`state.cardPlanKey` = season|game index|date). It runs at the final of the game before, at team creation (the first game day), and on every tick (a no-op once planned, which also catches up saves from before r74).
- **Moments:** every pool belongs to a moment (`POOL_MOMENT`): between (decisions, between-games), pregame, ingame and leave. Each moment draws from its own pools, with counts set by `CARD_DAY`: 1–2 between, a pre-game card 55% of days, an in-game card 40%, personal leave 5% (regular season). A CPU trade offer is still at most one per game day, and the inbox cap of 12 still holds.
- **Timing against that game** (`_scheduleCards(…, game)`): pre-game cards arrive 45–150 minutes before first pitch and lapse at first pitch. In-game cards arrive 20–120 minutes after first pitch and lapse when the game is over (3.5 hours). A moment that has already passed when the day is planned is dropped, never delivered out of place. Between-games cards arrive up to first pitch, or, if the game is already underway, up to the next game's first pitch.
- **Spring** now has its pre-game and in-game pools.
- **Harness:** moment counts per season (about 200 between, 73 pre-game, 28 in-game, a few leave), in-game cards arrive while the game is on, the first game day is planned at creation, and spring game-day cards arrive.

### 80.1 First moments (r75)
- **`data/cards-moments.js`** holds the `MOMENT_CARDS` for four milestones, 27 versions in all. **takeover** (8) arrives within the hour of creating a team. **camp_open** (6) arrives when camp opens in seasons after the first. **spring_opener** (6) arrives before the season's first spring game. **opening_day** (7) arrives before the first regular-season game. Each is a real decision with modest effects, from the owner (in the archetype's voice), the manager, coaches, the CFO, PR, community relations or the beat writers.
- **Situation-aware:** `_when` narrows a version by archetype, season (first or returning), last season's record (winning or losing, quoting `{last_record}`) and Club Funds (flush ≥25% of the payroll target, tight <10%). Situation-specific versions are weighted ×2.
- **Never repetitive:** `CardEngine.deliverMomentCard` prefers a version never shown on this device (`localStorage` `bgm_seenMoments`, across every team and season) and never shown in this save (`state.momentsDone`). Once all have been seen, it uses the one shown longest ago. Each milestone fires once per season (`momentsDone['season|moment']`). A moment whose time has already passed is not marked done.
- **Triggers:** takeover in `startNewGame`. The rest come from `planCardsForNextGame` on the first spring game (camp_open as well from season 2) and on the first regular-season game.
- **New tokens:** `{team_name}`, `{team_city}`, `{team_nickname}`, `{gm_name}`, `{last_record}`.
- **Fix:** the same card can never be pending twice (unanswered in the inbox or scheduled). The selection filter excludes it, which found a setup card being picked again.
- **Harness:** the takeover and Opening Day cards arrive in season 1; a second season opens camp with a card.

## 81. Phase 2 — CPU clubs keep books (r76, §78.5 built)
- **Every CPU club has a real account.** `FinanceEngine.initClubBooks` sets each club up at league creation, or on the first clock pass for saves from before r76:
  - An owner personality, `ownerArchetype`, drawn from the six archetypes and kept for the franchise's life.
  - A park atmosphere from the club's strength, and a win target of 142 × str.
  - A payroll target 8% over its opening payroll (`FIN_CPU.targetHeadroom`), so the owner has budgeted for call-ups and injuries.
  - A coaching-staff budget of 3% of payroll (`staffK`; `staffAnnual` falls back to it).
  - A market calibrated like ours on what the club really carries: opening payroll +5% (`inSeasonLift`), with no front-office card budget. A club playing to its owner's expectations breaks even.
- **The same calendar as ours.** Daily accrual, paydays on the 1st and 15th plus the settling day, media and local installments. `advanceClock` merges every club's due steps in time order. The guard was raised to 12,000 to cover ten clubs' days.
- **Gates.** A CPU home game posts its gate at the final (`_finishLeagueGame`). When we play on the road, the home club's crowd pays the home club (`commitGame` Step 1b). The projection counts home games from banked gates, the same for any club.
- **Owner functions take a `teamId`:** patience, strain, allowance, stage, tolerance, `canAddSalary`, `canSpend`, `ownerReview`, `cutOrderAmount` and `contractToMove`. A CPU owner's trust sits at the pivot, and only our owner's trust moves. `payrollRoom(state, teamId)` is new.
- **Owners hold the purse:**
  - CPU waiver claims (`cpuWaiverClaimant`), offseason re-signings (new deal minus old) and free-agent signings, including the full-club upgrade, all require the owner to carry the salary.
  - CPU trade offers to us must fit both owners (`_tradeSalaryOk(state, offer, cpuId)`).
  - Our salary dump goes to the club with the most room that can take the contract. If none can, a notice says so and the order stands.
- **CPU owners cut.** At a CPU payday, an owner at 'cuts' before the trade deadline has the club move a contract (`TransactionEngine.cpuSalaryMove`): the smallest non-core salary covering the cut goes to the club with the most room, for nothing back. The move is a `cpu_trade` transaction and a feed line, and the sending club's roster is reconciled. After the deadline he waits for winter.
- **Season's end.** Each CPU club's books close (red ink covered by its owner), and `cpuNextTarget` moves its target ± with the books (`booksOfferAdjustment(state, teamId)`).
- **Debug screen:** a League Books section showing each club's funds, payroll/target, season net and owner stage.
- **Harness (8 seeds):**
  - Every club opens and closes reconciled books, with gates, media, local money and salaries.
  - CPU seasons run about −2.5M to +4M on 10–38M targets, with occasional owner-covered red ink.
  - Trade offers continue (8–10 a season). An owner ordering cuts moves a contract to a club with room (mechanism test on a copy).
  - Our own operating-net bound widens to 50% for a historic .650+ season.

## 82. Last names only, and gender-neutral writing (Session 8 — GM decision)
**The standard (GM, verbatim intent):** nothing in the game should imply who the players are. Anyone who picks the game up should be able to picture the team as women as easily as men. Gender-neutral text should never feel clunky. It should read as natural, ordinary baseball writing. Singular "they" only as a last resort: sentences are rewritten around the name or the role instead.

### 82.1 Names (r77)
- **No first names anywhere.** Players, coaches and the people cards mention are known by their last name. Your GM name is the only name left as typed.
- **Data:** `data/player-names.js` is rebuilt as `PLAYER_SURNAMES` (1,201 distinct), `STAFF_NAMES` (67) and `PERSON_NAMES` (15).
  - No name appears in two lists, so a coach is never mistaken for a player.
  - Removed: last names that read as ordinary words in a sentence once the first name is gone (Price, Best, Young, Stone, Hill, Wood, King and others), names outside the file's own guidelines (Scandinavian, West African), first names that had slipped in, and the unused ACQ_* lists.
  - `card-tokens.js` `person_name` is gone; the outside people come from `PERSON_NAMES`.
- **`engine/Names.js`** (pure) is the one rule:
  - `newPlayerName(players)` picks a last name nobody active in the league wears.
  - When the pool runs out, `uniqueName` gives a first initial nobody has ("E. Tejada").
  - A name is fixed for the player's career, and no two active players ever share one.
  - Used by every creation point: the league's draw (all distinct), depth signings, amateur signings and generated players (MarketEngine).
- **Old saves:** `_fillDefaults` converts once (`state._lastNamesOnly`).
  - Every player becomes a last name. Two-word surnames such as "De Paula" are kept whole. Clashes get initials, active players first, in id order.
  - The staff become last names.
  - New saves are created already marked, so a two-word surname is never cut twice.
  - Card text already in the inbox keeps its old wording.
- **Screens:** the four places that shortened names themselves (box score, League leaders and search, the hot/cold strip) now show the stored name. That also fixes "De Paula" showing as "Paula".
- **Harness:** every player's name is a pool last name (initial only where shared), no two active players share a name, and the staff are known by last name. Checked at the new league and again in season 2.

### 82.2 Gender-neutral writing (r78)
- **Every he/him/his reworded, about 105 lines.** Card pool (29 lines), first-moment cards (17), CardEngine-built cards (about 40: injuries, IL returns, call-ups, claims, owner orders, re-signs, free agents, retirements, the manager's contract, All-Star cards), token phrases (12) and small notices.
- **How:** sentences were rebuilt around the name or the role ("Tejada is unavailable until we know more", "The coach has been tracking…", "The ask is $X a year"). Singular "they" was never needed.
- **Other gendered wording:**
  - "the guys" became "the players", "the room" or "the hitters".
  - "a man short" became "a player short"; "setup man" became "setup arm" (role label "Setup").
  - Parental leave for a new baby ("just became a parent").
  - The nurse's first pitch no longer assumes a gender.
- **Harness:**
  - `checkNeutralText` scans every string the game can send (all pools, moment cards and token phrases: about 6,500 strings) and every card actually delivered in the season. Each must be free of he/him/his/himself/she/her/guys/fella/man/men and family terms.
  - Writing rule for every future card: write it so a reader pictures any player at all. Name the player or the role; reach for "they" only when nothing else reads naturally.

### 82.3 Fixes found by the sweep (r78)
- **A minimum-salary move is always allowed** (`FIN_MIN_MOVE_K` = 150, about a 50–54 player). Every club can fill a hole with depth however tight its books, like the league minimum in MLB. It's applied in `canAddSalary`, so every club and every path gets it.
- **CPU owners budget for the market, not just the roster.** `cpuTargetFloor` is 70% of the league's median payroll (`FIN_CPU.targetFloorShare`), at league creation and at every season end. The club's market is calibrated to carry it.
  - Before this, the league's weakest roster got the smallest target, couldn't afford a single claim, and sank (28–104 in one seed).
  - Worst CPU club across 8 seeds is now 35–55 wins.
- **Harness:** an unanswered All-Star lobbying card is withdrawn when the rosters are named, and the vote speaks. That is now accepted (it was failing whenever the test GM skipped the card).
- **Open (for later):** in season, a CPU club can only spend through waiver claims. A weak club with money still can't buy help mid-season. CPU-to-CPU trades or in-season CPU free-agent signings would close that gap.

## 83. Phase 3a — card money made real (r79)
- **New card effects** (`_applySoftEffects` → FinanceEngine):
  - `target: share`: the owner loosens (+) or tightens (−) **this season's** payroll target. `fin.seasonTargetAdj` is capped at ±15% and resets at season's end. `seasonTarget(fin)` is what the owner checks, the room, the UI and the card context all use.
  - `gate: { price, fill, homeGames }`: a ticket promotion. The crowd pays the discounted price and more seats fill, for the next N regular-season home games (`fin.promo`, counted down at each home gate).
  - `local: share`: a sponsor or rights deal won or lost changes local income from now on (`market.localAnnual` and this season's installments).
- **The audit's cards, rebuilt on them:**
  - o1 (+4% target), sr1 (+5% target; the stray `_rawBudgetCost` is gone) and ms2 (owner trust) carry ownership pushes that do something.
  - o4: a real 15%-off promotion for ten home games. The old flat "revenue cost" is gone; the gate tells the truth.
  - sp_renew: a reduced rate (−3% local) or the sponsor walks (−8%). sp_complaint: the legal fight costs 3% of local.
  - fn5: absorbing the overage now charges it. fn6: the recovered overpayment is the amount shown, tied to the last payday.
  - bg4: savings are credited. ms_5: the online store adds 2% to local income.
  - st1 and the charter follow-up: their $25K now charges (an unhandled `_rawBudgetCost`).
  - "Budget" wording was reframed to club funds.
- **Unanswered cards do what their default choice does:** that choice's effects and its money (a deal that goes through by default pays; an expense absorbed by default is charged), plus the tax for leaving it. Roster actions still only happen on the "no" path (§74); nothing on the roster moves on an unanswered "yes".
- **Card money is sized to the club's market:** every money token is scaled by the payroll target against a contender-sized market (`CARD_MONEY_BASE_TARGET_K` 22,000; ×0.5–1.6). Deals (`rev_amount`) are now $60–200K at that size.
  - Before this, unanswered deals never paid, and once they did, flat $100–400K deals added $5–9M a season.
  - Now deals bring $3.7–5.4M against $2.5–5.3M of card spending. Season results: +$0.6–1.7M operating at a contender.
- **Harness (8 seeds green):**
  - A promotion discounts the per-fan gate to 85% for exactly its home games.
  - An owner's push opens payroll room for the season and resets at its end.
  - Every deal that goes through by default is in the ledger at its shown amount.

## 84. Phase 3b — cards that know the club's situation (r80)
- **`cardSituation(state, context)`** describes the club right now in the words cards use:
  - archetype; season (first / returning); last season (winning / losing);
  - pace (winning ≥ .550, middling, losing ≤ .450, after 20 games); race (in = within 4 games back from game 60 on);
  - lossGap; funds (flush ≥ 25% of this season's target, tight < 10%, steady); red (projected to finish in the red); owner stage;
  - crowd (packed ≥ 95% filled, soft ≤ 62%, over the last 5 home gates) and sellouts; postseason;
  - cpuTrouble (a CPU owner concerned or cutting).
- **Card gating:** `_when` gates any pool card on that situation (`fitsSituation`). `_family` makes several cards one card with versions: one per season, whichever version fits when it's drawn. The old `_requiresDivClose` (sr1) and `_requiresLossGap` (ms2) are now enforced; they had been silently ignored.
- **New tokens:** `{attendance_avg}`, `{capacity}`, `{empty_seats}`, `{sellouts_recent}`, `{funds_now}`, `{payroll_target}`, `{record_now}`, `{troubled_team}`.
- **`data/cards-money.js`** has 26 cards in 13 families:
  - **Owner pleased** (winning + flush): 4 archetype voices, from Empire's "go get it" (+5%) and the Gambler's "let it ride" (+7%) to the Ember / Lab / Institution note (+3%).
  - **Owner and red ink:** a stern version (the CFO's plan: real savings plus trust) and a gentle one (coffee and a light trim).
  - **Owner funds a push** (in the race, owner content): bold (+6%) or measured (+3%).
  - **Cash tight:** defer maintenance, or pull the fireworks nights. **Cash flush:** a clubhouse recovery area, or a coaches' video room.
  - **Crowds packed:** raise prices 10% for ten home games, or throw an appreciation night. **Crowds soft:** a four-pack promotion (25% off, +15% filled, six games), or free seats for schools in a losing year.
  - **A CPU club cutting payroll:** a beat-writer or Pro Scouting version. "Make the call" (`fin_call_club`) asks that club for a real offer that both owners can carry; if nothing fits, word comes back.
  - **Postseason money:** a staff bonus pool, or road-game watch parties.
  - **Media rights:** winning brings an early extension (+4% local); losing brings a rate cut (−3%, or −5% and a secondary channel if refused).
  - **A big year:** the agent asks for a performance bonus.
  - **Home pre-game:** a giveaway night (+10% filled tonight), or a rivalry-night event.
- **Harness (8 seeds green):** at most one version of each family a season (5–6 families a season, versions matching the situation); a call to a club cutting payroll always gets an answer (an offer or word back); the new cards pass the neutral-text scan.
- **Fixed:** the intro on a called-back trade offer.

## 85. Phase 4 — trades: decisions (Session 8, GM, before building)
Replaces the locked "no cash in trades" (§9) and the open B7 questions (§76).
- **A. Cash only as part of a deal that includes players**, plus the occasional CPU offer to sell a fringe player for cash. No buying players outright.
- **B. Covered salary:** when the other club covers part of a player's salary, our owner counts only our share against the payroll target.
- **C. Covered salary is paid over the season**, coming off each payday as in real deals. A one-time cash sweetener is paid at once.
- **D. Starting a trade:** from any player's card (ours: "shop this player"; theirs: "ask about this player"), and from the inbox's compose section through a new "Other GMs" option.
- **E. Deal size:** up to 3 players a side, plus prospects and cash.
- **F. Replies are on a realistic clock:** sometimes within a few hours, sometimes more than a full day. Counteroffers are allowed, but every negotiation fizzles out after a few rounds if the sides can't agree.
- **G. Advice, not a meter:** the GM can run a deal by a scout or other staff for a read. Never a fairness meter.
- **H. Trade windows:** in season until the trade deadline, and in the offseason.
- **I. Guardrails:** CPU clubs must judge trades realistically (needs, role, age, contract, buying or selling, their books). A cooling-off period after a declined offer, and no flipping a just-acquired player for a few days.
- **J. CPU-to-CPU trades happen when situations arise for both clubs** (one short on pitching with hitting to spare, another the reverse), not at a fixed rate. They must reach the GM so the league feels alive, without "got it" messages. Each trade gets a line in the activity feed. An inbox card only when the trade touches us, always with a real decision: a rival got better (advance scouting), a club just sold (call them), a club now has a surplus (make an offer), someone beat us to a player we were pursuing (next-best option), a former player was flipped (reach out).
- **GM rapport:** the existing per-club `gmRelationships` (0–100, already used by the trade engine) gets shown as a grade (Strong / Good / Neutral / Cool / Strained). Trade talks move it: fair and completed deals warm it; lowballs and fizzled talks cool it.
- **Build order:**
  1. 4a: the trade engine (valuation, cash, covered salary, rapport, cooling-off, no-flip, windows).
  2. 4b: trades the GM starts (composer, the scout's read, timed replies, counters, fizzle).
  3. 4c: CPU-to-CPU trades and their feed lines and cards.
  4. Cleanup: the deadline cards b1/dl3/dl4 become real offers or retire; fix `_assessDepthImpact`'s `STARTING_HITTERS` check.

## 86. The Recent strip (r81, GM feedback)
The dashboard's activity feed (`state.activityFeed`, kept 72 hours) was icon-led, took vertical space, and stayed hidden until Opening Day: nothing wrote to it in spring, and our own results never appeared there. Now:
- **Text only.** No icons anywhere in it (GM preference: icons as little as possible).
- **Collapsed by default:** one line showing the newest entry, with "More". A tap opens the list (the newest 12, scrolling inside its own box) with "Less". The state holds across refreshes in the session and starts collapsed each launch.
- **It starts with the club:** "‹GM› takes over the ‹city› ‹nickname›" and "Spring training opens — Season 1" at team creation. Our own results ("Spring: TST def. CLW 5–3", spring, regular season and playoffs) and every CPU game's final, spring included, are written at the final.
- **Role (agreed with §85 J):** Recent is the at-a-glance log of scores, paydays and milestones. The full record of league moves will be the League wire (a Transactions view on the League screen, built with 4c). The inbox gets a card only when a move touches us and there's a decision.

## 87. Phase 4a — the trade engine (r82)
- **Cash in trades is on** (`TRADE_CASH_ENABLED`). An offer is `{ incomingIds, outgoingIds, cashK, retain }`:
  - `cashK` is a one-time payment, + when the other club pays us.
  - `retain` is `{ playerId: share }`, the share of a traded player's salary the sending club keeps paying this season (at most 50%).
  - Execution posts cash to both clubs' funds as 'trade' and records retained shares (`Finance.retainSalary`).
- **Covered salary (§85 B, C):** `payrollOf` counts a player's salary less any share another club keeps paying, and adds the shares a club keeps on players it traded away. Paydays pay each club exactly its share; owner checks see only the club's own part. Shares end with the season.
- **How a CPU club judges a deal (§85 I):** `valueToClub(p, state, teamId, receiving)` starts from the base value (rating, age, contract, salary, health) and weighs it by:
  - the club's mode (`clubMode`: buyer ≥ .540; seller ≤ .460 or an owner cutting): buyers favor current rating and rentals; sellers favor youth, discount rentals and veterans, and are glad to move veterans;
  - whether the player would start there (`wouldStart`, read from the real lineup slots, rotation and top of the pen);
  - whether a player sent away is a key piece.
  
  `cashValue` turns money into value, worth more to a strapped club. `evaluateForClub` returns the net value and checks both owners' books.
- **Answers:** `cpuRespond` accepts at the club's bar, which is set by rapport (Strong −8 … Strained +12). Within 30 of the bar, it counters (`buildCounter`):
  - its books first: we keep paying part of a salary we send;
  - then the smallest fix: cash from us for a small gap, one more of our players (a prospect or a bench piece it would use), or one of its own players taken back out.
  
  Talks fizzle after 3 rounds (`TRADE.maxRounds`). Far below the bar is a decline, a lowball if very far.
- **Rules:** `tradeWindow` (open in spring, in season to the deadline and in the offseason; closed from the deadline through the postseason) and `tradeBlockers`:
  - the window and cooling off;
  - at most 3 players a side;
  - every player must be in the club's organization, active roster or farm;
  - no injured or in-transit players;
  - no flipping: `_acquiredAtMs`, 5 days;
  - salary kept only on a player in the deal, at most 50%.
  
  Cooling off is now real time (`state.tradeTalks[teamId].cooldownUntilMs`, 2 days), replacing the old game-count `_tradeDeclinedAt`. The unused `evaluateCPUResponse` and `recordDeclinedOffer` are gone.
- **Rapport:** `rapportOf`, `rapportGrade` (Strong ≥ 75 / Good ≥ 60 / Neutral ≥ 40 / Cool ≥ 25 / Strained) and `adjustRapport`. A completed trade adds +2.
- **Execution:** every player leaves the old club first, then each receiving club makes room. A full side options its weakest reserve at the moment of the deal, so a player in the deal can never be the corresponding move. A prospect traded from a farm reports to the new club's farm, and a full farm side releases its weakest.
- **CPU offers carry money** (`_dressWithMoney`): a selling club keeps paying part of a salary when our owner couldn't carry it, and adds a cash sweetener when the deal is a little short for us. **§85 A:** a selling club occasionally offers a fringe player who would start for us, for cash (`generateCPUCashSale`).
- **Offer cards** describe up to 3 a side, cash and salary kept. The `_assessDepthImpact` STARTING_HITTERS check is fixed (`wouldStart`).
- **Harness:** on copies of the real league:
  - a fair deal is accepted or countered, and a lowball refused;
  - counters improve the deal for the club and end within the round limit;
  - cash moves between the funds;
  - the sending club keeps its share and our payroll counts only ours;
  - a just-acquired player can't be flipped;
  - cooling off and the deadline block talks.
  
  7 of 8 seeds green. **Seed 1: the weakest CPU club finished 30–102** (no trades of its own; the r78 open item, a weak club with no in-season way to improve, reached by a different random path), plus a development-variety check that depends on chance. **4c's needs-based CPU-to-CPU trades are the planned fix.**

## 88. Phase 4b — trades the GM starts (r83)
- **`engine/Negotiation.js`** runs one open talk per club (`state.tradeTalks[teamId].talk`: offer, round, sentAtMs, replyAtMs, status).
  - `proposeTrade` checks the deal (`tradeBlockers`) and our owner (`ourSideBlocker`: the added payroll, any cash we send), then sets the answer for 2–36 hours later (skewed toward the same day).
  - `advanceClock` merges due answers into the league's ordered steps (`dueReplies` → `replyNow` → `cpuRespond`), so an answer due while the app was closed arrives in time order.
  - **Limitation:** an answer is decided when it comes due, so it isn't pushed while the app is closed (the push worker only knows cards already scheduled).
- **Every answer is a decision card** (roster cards with a deadline and an auto path):
  - accepted: Finalize, or Back Out (rapport −3 and the club cools off). Finalizes by default after 24h, since it was our offer.
  - countered: Take Their Counter (rapport +1), Walk Away, or **Make a New Offer**, which opens the composer pre-filled with their counter and continues the same talk. Walks away by default after 36h.
  - passed: Ask What It Would Take (their counter, if one exists within reach), or Move On. A lowball costs rapport −2.
  - run its course (fizzled after 3 rounds, or nothing would work): Keep the Door Open (rapport +1), or Move On.
  
  A revised offer withdraws the talk's open cards. A card only acts for the talk and round it was written in.
- **The scout's read** (`TradeEngine.scoutRead`, §85 G), in words only:
  - how close the deal is, from "they would jump at this" to "a lowball";
  - whether the club is buying or selling;
  - whether each of our players would play every day for them, or be a prospect or depth;
  - their owner's books and their cash, plus our owner;
  - whether we'd be giving up more than we get;
  - the relationship.
- **`ui/components/TradeComposer.js`:**
  - the club list (record, buying/selling or "not taking calls" / "talks open", relationship grade);
  - up to 3 a side from either roster or farm (hurt players disabled);
  - "they / we keep paying" None / 25% / 50% per player when it's in season;
  - a cash stepper ($50K steps, either way);
  - our payroll after the deal against the target (red when over);
  - the reasons a deal can't be sent;
  - Ask Pro Scouting and Send Offer.
- **Ways in:** "Shop This Player" or "Ask About This Player" at the bottom of every player card, and **Other GMs** in the inbox's compose section. "Make a New Offer" on a counter card (inline and in the long-card sheet).
- **Harness:**
  - the simulated GM starts trades (a fair package for a player who would start for us, and a lowball one time in five);
  - every offer is answered on the clock, and no talk goes past the round limit;
  - answers arrive as decisions, and every finalized deal is made or voided (checked against the franchise history; old transaction records are pruned).
  
  6 of 8 seeds green. Seed 5's weakest CPU club went 30–102 (the open weak-club item; **4c**). Seed 1 failed a chance-based follow-up-chain check.

## 89. Trade answers decided at send, delivered later (r84, GM feedback)

**Question from the GM:** why can't the other GM's answer be settled when the offer goes out and simply shown later, so it arrives as a push notification with the app closed like every other inbox message?

**Decision:** that is the right model, and it replaces §88's "decided when due."
- **Decided at send.** `Negotiation.proposeTrade` runs `cpuRespond` at the moment the offer is sent (the talk records `answer.atMs === sentAtMs`). The reply card is built then and scheduled via `_deliverAt` 2–36 hours out, so it sits in `scheduledCards` and reaches the push worker. The `dueReplies` / `replyNow` step is gone from `advanceClock`.
- **"What would it take?"** works the same way: the counter (or "nothing there") is decided when the GM asks and is delivered a third of a normal delay later.
- **Nothing leaks early.** How the offer landed (a lowball's rapport hit; fizzled talks' rapport hit and cooling-off) is stored on the talk as `pending` and takes effect only when the answer reaches us and is acted on or runs out (`Negotiation.settle`, called from the talk card's action). The club list shows "Talks open" while we wait (`talkIsOpen`: the reply time hasn't come, or there's an answer we haven't acted on), and a new offer to that club is refused until we hear back.
- **The gap is guarded.** `syncRosterCards` checks every scheduled or unanswered accept / counter card against `tradeBlockers` (a player hurt, moved, in transit, the window closed). One that can't be carried out is withdrawn and replaced by the club's "the deal is off" call, at the time the answer would have arrived; the talk closes (`Negotiation.callOff`). Finalizing still re-checks everything.

**Found and fixed on the way (harness, seed 3):**
- A player who cleared waivers with nowhere to go became a half-formed free agent (`tier: 'farm'`, no `_faFrom` / `_faSince`). `clearWaivers` now makes him a proper free agent (tier, the club that let him go, when, reason `waivers`). The harness's spring check now separates the offseason's unsigned (gone at spring) from players let go after spring opened (free agents in their own right).
- A free agent signed to the active roster while games were on joined instantly and could play that night, with no arrival record. `signToClub` now makes him report like anyone joining a club — an arrival the next day (`reason: 'signing'`). A veteran signed to start takes the spot he was signed for when he reports, if the player he replaces still holds it (`tx.startAt`, applied in `_arrive`). Offseason signings remain immediate.

**Harness:** talk checks now verify the answer is decided at send, no answer arrives before its reply time, and how an offer landed takes effect once its answer is read; signing checks accept a pending arrival. 8 seeds green; webpush and refs pass.

## 90. Phase 4c — trades between CPU clubs, the League wire, cards that touch us (r85)

**The trade desk.** Once a day, at a moment between 10:00 and 18:00 local (`state.tradeDesk.nextAtMs`, a step in `advanceClock` like the finance and offseason steps; catch-up replays each day in order), CPU clubs can deal (`engine/LeagueTrades.js`, pure):
- **A need** (`clubNeeds`): a lineup starter, the weakest rotation arm or the end of the top-4 pen well below the league's norm at that spot (`needGap` 5). A spot the club can fill from its own bench or farm is a lineup decision, not a trade need.
- **The chance a club with a need works the phones** each day: season 3%, the days around the deadline 20%, spring 2%, offseason 8%. At most 2 trades a day, a club rests 14 days after a trade, and a player a CPU club traded for isn't moved on again for 120 days (the 5-day no-flip still applies to everyone).
- **The deal** (`buildPackage`): the seller's player who fills the need (at least +4 over the incumbent); the buyer sends the fewest, closest-to-price pieces it can spare (never its key players, never its own answer at the spot; the incumbent being replaced may go). Cash closes a small gap. A selling club keeps part of a salary the buyer's owner can't carry. The seller must clear its bar; the buyer overpays at most a little (buyer 8, neutral 3, seller 0).
- **Execution** goes through the same ledger as ours: `_executeTrade` now handles any two clubs (history and rapport only when we're in it). **A club in the middle of a game finishes it first:** the ledger holds any trade (ours too) until that club's final out (`clubBusyUntil`). Found when a player traded mid-game was injured in that game while in transit.

**How clubs value players (changes for every trade, ours included):**
- Value is measured above replacement level (`_ovrScore`: 6 × (OVR − (44 + league level))^1.25), so a star is worth several regulars and a fringe player little.
- A player is worth this season plus the future: `0.45 + 0.55 × age × contract`. A final-year veteran is a rental, not a fraction of a player (final year 0.80, one more year 0.90).
- Salary efficiency is narrowed to 0.85–1.15; money is weighed apart (books, cash).
- **Quality over quantity:** a package counts its best piece fully, the next 60% and the rest 40% (`packageValue`).
- **Sending a regular away leaves a hole:** the drop to the club's best replacement at the spot counts against it (buyer 0.8, neutral 0.6, seller 0.3).
- Trade payroll counts only what the club pays (`isPaid`); a farm player on a minor-league deal isn't on it either way.

The first build traded a 77 SS for a 57 SP and bounced players back and forth; these rules fixed it.

**The League wire** (`state.leagueWire`, this season and last, up to 500): every trade (ours too, cash and salary kept included), CPU salary moves, waiver claims, offseason free-agent signings, departures and retirements. The League screen has a new **Moves** tab, text only, grouped by day, with All / Trades / Our Club. CPU trades also get a short line in Recent.

**Cards only when a trade touches us**, each a decision (`CardEngine._leagueTradeCards`), at most one per trade:
1. **Someone beat us to a player we were talking about:** our talks close. Pro Scouting offers the next-best option (same role, would start for us) as an offer to make, or says nobody fits.
2. **A player we traded away was flipped:** once the no-flip window has passed, an offer to bring them back.
3. **A division rival got better** (an above-average starter added, at most one a week, one per series): send an advance scout. The cost is scaled to the market. Our hitters' hit rate is ×1.03 against them and theirs ×0.975 against us, through our next series with them (`userTeam.advanceReports`; `SimEngine` `scout` context).
4. **A club just sold:** a veteran still there who would start for us. At most one opportunity card every 3 days.
5. **A club now has a surplus** (the starter it just replaced would start for us).

Offer cards (`lt_offer`) carry Pro Scouting's package (`scoutPackage`: the fewest of our spare pieces their GM should take at our rapport's bar, our owner able to carry it). The choices are **Make the Offer** (sent through `Negotiation.proposeTrade`; the answer comes on their clock, §89), **Adjust the Offer** (the composer, pre-filled), or **Pass**. They are withdrawn if the package can no longer be offered (`tradeBlockers` or our owner), and when we send that club another offer.

**Phase 4 cleanup:**
- dl3 and dl4 (deadline trade cards that skipped the other club's judgment) are retired. In their place, Pro Scouting's best target for our biggest need arrives as the deadline nears, once a season, when we're not selling (`deliverDeadlineIdea`).
- b1 (the bullpen crisis) now reads "Work the Phones": a reliever who would pitch the late innings for us, as an offer card a few hours later, or word that nobody fits.

**Also:** "What would it take?" counts as the talk's next exchange (round + 1).

**Harness:**
- CPU clubs trade with each other: 14–20 in season 1, at most 5–7 by one club.
- Every trade is on the wire (ours too); wire text is neutral and every trade reads as who acquired whom.
- The cards that touch us are decisions; advance-scouting reports cover a coming series; the retired cards never appear.
- **The balance band floor is now 33 of 132** (the 2024 White Sox, 41–121, .253). The weakest CPU club now finishes 37–57 across seeds (it was 28–30 before 4c), and the best 73–84.

8 seeds green; webpush and refs pass.

## 91. CPU clubs' offers to us, rebuilt on the trade desk (r86)

**Decisions (GM, Session 9):** a CPU club's call about one of our players comes from the daily trade desk, not a per-game roll; a club opens a little under, as a real GM would; the new-franchise seed offer varies, situation and wording, so it doesn't read the same for every new club.

**Retired:** `generateCPUTradeOffer`, `_identifyCPUNeed`, `_findTradeTarget`, `_assembleCPUOffer` and `_dressWithMoney` (TradeEngine). They found a club's need by averaging OVR across `group` buckets, targeted a random player of ours from the 20th–80th percentile, always offered one bench or final-year player back, and never checked the deal from the other club's side. The per-game roll now offers only the selling club's cash sale (§85 A).

**The desk calls us** (`LeagueTrades.findLeagueTrades`):
- A club with a need that works the phones also looks at our organization, for its two weakest spots (`clubNeeds`). One of our players qualifies when he fills the spot, beats its incumbent by `upgradeMin`, and a package exists.
- It calls us when our player is about as good a fit as the best it can get elsewhere (`callMargin` 4 OVR; a second-need fit counts 4 lower). It then waits for our answer instead of dealing elsewhere that day. At most one call a day.
- A club that is already dealing with us doesn't call (`TradeEngine.busyWithUs`): talks open, an offer of its own waiting on our answer, or cooling off after a no.
- **The opening bid** (`callOffer`): the package that costs the club least (`buildPackage` `cheapest`: the pieces it values least, plus any cash) that comes within `openUnder` (8% of the player's value to us, at least 4) of what he is worth to us. It always clears the club's own bar, the same bar it holds our counters to (`cpuRespond`). It is never a lowball.
- `room`: a better deal for us that the club would still make exists. Pro Scouting says so in words.
- Measured over 8 seeds: 3–10 calls a season, plus 1–6 cash sales.

**A club offering one of its own players** (`askingOffer`): what it asks of our spare pieces, a little over its bar when it opens. `shedK` requires the deal to take money off a club's books (the payroll call-back). Used by:
- **The seed** (`deliverSeedTradeOffer`): whichever situation the new league has, picked at random — a club that wants one of ours, or a club offering a player who would start for us.
- **The All-Star suitor** (§17.3): now an actual All-Star from another club (`allStarSeasons`) who would start for us. Before, the "spent All-Star week in our ballpark" line was attached to whatever bench player the old generator picked.
- **The payroll call-back** (§83): the club's biggest salary held by a player who would start for us, in a deal that takes at least half of that salary off its books. Before, it could come attached to a minimum-salary player.

**Clubs keep their word** (`promisedToUs`): a club doesn't move a player in a deal of ours it accepted, or in its own offer that waits on our answer. A counter isn't a promise, so "someone beat us to a player" (§90) now happens only after a counter. It used to fire after the club had accepted our offer.

**The offer card** (`CardEngine.deliverTradeOffer`, kinds `call`, `sell`, `sale`):
- An opening line varied by situation (four for a call, three for a club selling, three each for seeds). Then the deal, cash, salary kept, Pro Scouting's read in words, and the payroll change.
- **Accept the Trade / Decline / Counter.** Counter opens the composer pre-filled with their offer. It starts a talk at round 2 (their offer was round 1) and withdraws their card (`withdrawTalkCards`).
- Now a roster card on the real clock: it expires after 2 days (a seed after 3) and declines by default. It used to expire by game count, which never happens in the offseason.
- Withdrawn when the deal can no longer be made (`tradeBlockers`). The old check looked only at active rosters, so an offer with a farm prospect in it was dropped as invalid.
- The payroll note says only what the deal changes ("adds $X to a payroll already over ownership's target"), not "would push payroll over" on every card when the club was already over.

**Found and fixed on the way:**
- **A prospect traded from a farm held an active roster spot.** `pendingArrivals` counted farm-bound arrivals (`toFarm`), so trading an active player for two prospects left us at 27 with no open spot and no deadline. Every active count (call-ups, the 28-man check, reconciles, the offseason) now leaves them out. Seen when a call sent one of our regulars for two prospects.
- Possessive club names ("Ironfield Bears' front office").

**Harness:**
- New checks: calls come from the desk (2–30 in season 1); every opening bid clears the caller's bar and is never more than its `openBy` under; at least half the calls open under value; a selling club asks a price it would take; the All-Star suitor is a real All-Star; the wording varies; a counter opens round 2 and replaces their card; talks closed because another club got the player come with word from Pro Scouting.
- The GM counters about a quarter of offers (their offer plus $100K to us).
- The seed checks accept a farm player in the deal and a roster-clock expiry. The harness GM leaves the seed offer alone (it is made at the clock's far-future anchor, before the season clock starts).
- Ghost checks use `tradeBlockers`. The trade-engine copy checks run at neutral rapport. Odd seeds' forced All-Star host gets an atmosphere margin (a bad day had dropped it under 65 before the league named the host).
- `ROSTER_DUMP` prints pending arrivals and recent trades when the 28-man check fails.

8 seeds green; webpush and refs pass.

**Open:** when someone beats us to a player and nobody else fits, the card is still an "Understood" notice rather than a decision.

## 92. Every inbox card expands in place (r87, GM feedback)

**Question from the GM:** why did the seeded Facilities Management card ("Pre-season inspection") open as a sheet when every other message expands in place?

**Cause:** an old rule in `CardModal.shouldUseModal` sent any card with a body of 400 characters or more to a bottom sheet. That card runs about 410. It was never a design decision. The r86 trade offers usually crossed the line too.

**Decision:** every card expands in place, whatever its length. `ui/components/CardModal.js` had no other users and is deleted (and removed from the service worker's precache). The shared sheet styles in `index.html` stay; the player card, composer and other sheets use them.

**Found and fixed on the way:** the inline view showed one button for any card that goes through by default if unanswered (`autoResolve: 'yes'`), hiding its second choice. On "Pre-season inspection", "Targeted fixes only" was missing; 44 two-choice cards in the main pool alone were affected when short enough to expand inline. A card now shows one button only when it has one choice.

Checked in the browser: the long card expands in place with both choices, and deciding it from the inline buttons resolves it. 8 seeds green; webpush and refs pass.

## 93. Readable text in any team color; League table headings; a dashboard that doesn't scroll for nothing (r88, GM feedback)

**Team colors never color text on the League, Team, Inbox and Schedule screens, or in the shared chrome.** A dark team color (navy, maroon) made team-colored text unreadable on the dark background. Every place those screens used `--accent` or `--accent2` as a text color now uses `--text` (white in the dark theme, near-black in the light one):
- the screens' tabs and sub-tabs (Players / Teams / Standings / Moves, Players / Staff / Finances, To Do / Completed / Compose), chips and filters, the active sort heading, "YOU" / "Your Team", tags, roster group heads, rating and IMP values, results, schedule badges and dividers, the playoff views on the League screen;
- shared chrome on every screen: the active bottom-nav label, the funds pill, the tier badge, toasts, the settings sheet;
- the player card that opens from these screens.

Team colors stay on non-text elements (borders, underlines, bars, button fills, whose labels already pick black or white by contrast). The Dashboard's own cards are unchanged for now (not in the request).

**League Players table: headings sit over their columns, scrolled or not.** Two stylesheets styled the table. The older rules in `index.html` gave the header and rows different padding, laid the name cell out in a row, and made the table a flex column, which kept it from scrolling sideways on its own. The newer rules in `LeagueScreen.js` let the generic heading width (38px) override the "Player" heading, so it was 38px over a 120px column and every heading sat 82px left of its numbers. The old rules are gone; the name column has one rule shared by the heading and every row. Measured in the browser, every heading's left edge equals its column's, before and after scrolling sideways; the name column stays frozen. Our players' frozen name cells are now opaque (the tint sits over a solid fill), so stats no longer show through as they scroll under.

**The dashboard scrolls only when it has to.** With no game in progress and Recent collapsed, the dashboard had 36px of trailing space (the tab's 20px bottom padding and Recent's 16px margin). On a phone where the cards fit with a few pixels to spare, that made it scroll a little for nothing (measured at 390×664: content 531px in a 536px view, scroll height 567). `DashboardScreen._syncScrollRoom` now marks the idle dashboard (`dash-idle`), which drops that trailing space; a live game or an open Recent list gets it back. Nothing is hidden: a screen genuinely too short for the cards (about 640px tall or less, before the hot/cold strip appears) still scrolls.

8 seeds green; webpush and refs pass.

## 94. Messages say when they arrived, never a clock time they can't keep; push sync on hide; contract-year fix (r89, GM feedback)

**From the GM (on r87):** several messages arrived over a few hours with the app closed and no push came. A seeded message said the clubhouse meeting was "at 9" when the team was created after 9 and the first game was at 1 PM. Should messages carry a received time, and should card text stop naming times?

**When a message arrived.** Every inbox row shows its arrival time at the top right (the time today, "Yesterday", the weekday this week, the date before that); an open card starts with "Received Thu, Oct 29 at 11:42 AM". `arrivedAtMs` is now stamped on every path into the inbox (scheduled releases already had it; seeds, compose replies and debug cards get it too). Cards from before r89 that never recorded it show no time rather than a wrong one. A scheduled card's time is the moment it was due, so a card that came due with the app closed shows when it arrived, not when the app was opened.

**No clock times in card text.** Decision: a message never names a time it can't guarantee. Rewritten:
- clock times: the clubhouse meeting "at 9" (now: before the first game), "until approximately 6am", "until 3pm", "by 4pm", "by noon", "by lunch";
- time-of-day words that could be wrong when the card arrives: "dinner tonight", "this morning", "overnight", "confirm this morning";
- "tonight" in game-day cards (41 places; spring games and many regular-season games are 1:05 PM): pre-game and in-game cards arrive the same calendar day as the game, so they say "today"; between-games cards say "the game", "the next game" or nothing;
- the injury evaluation card: "came out of today's game", "MRI Now". Its midnight and morning-exam wording stays: those are the card's real deadlines.

**Push: the schedule is sent when the app goes to the background.** A schedule change waited 1.5 s (debounce) before syncing; if the app was swiped away in that window the phone froze the page and the worker never got it. `visibilitychange` → hidden now syncs immediately, and `/register` uses `keepalive` (under the browser's 64 KB cap) so the request finishes after the page is frozen. The deployed worker matches `workers/push-worker.js` (checked through the Cloudflare connector). **Not yet diagnosed:** why this morning's cards didn't push. The worker's `/status` page (last cron run, per-device schedule size, last push result) isn't reachable from the build session; the GM will send it.

**Found and fixed on the way (harness, seed 6):**
- **The trade engine read contracts one year off.** `contractExpiry` is the first season not covered (§70), but `_isRentalPlayer` and `_playerValue` read `expiry === season` as the final year. Final-year players were valued as if a year remained, and real rentals weren't treated as rentals. `TradeEngine.yearsAfterThis` now follows §70 and both use it.
- **A player whose contract had run out could be traded in the offseason** (an expiring regular of ours went in an offseason call, then re-signed with the new club). `contractRunOut`: in the offseason, a player in the last year of a deal who hasn't re-signed is headed for free agency — `tradeBlockers`, `movable`, the cash sale and counters all leave them out.
- **Two versions of a card family could arrive the same day** (one draw picked two, or two moments each picked one). `_selectCards` drops the rest of a family once one is picked, and the day's plan carries the families already chosen across its moments.
- Harness: the "fair deal" copy check picks a player the other owner's books can carry (it checks value, not payroll); "clubs open a little under" needs at least one under-value opening once a season has 3+ calls (packages come in whole players and $25K steps).

8 seeds green; webpush and refs pass.

## 95. The Completed tab shows messages in full; the Rating card opens the rating's history (r90, GM feedback)

**Completed tab.** Each decided message is shown in full instead of a summary line: sender and tag, subject, when it was received and when it was decided, the whole message, the decision ("Your decision", or "No answer in time — decided by default" with the default's label), and how it turned out (the card's own outcome line, or its expiry line for a default). Notices read as "Read". Cards now record `resolvedAtMs` on every path (a decision, a default, a notice read); the tab lists the newest decision first by that moment (older saves fall back to game order). Delete / Delete All / Undo are unchanged.

**The Rating card opens "Rating" (`ui/components/RatingHistory.js`).** A bottom sheet with:
- the rating now and its change since the GM took over; the high and low (with dates) and the number of seasons;
- a line chart of every change since the first day — drawn as steps, since the rating moves at moments (a trade, a call-up, an injury, development) and holds between them; a dashed line and label where each later season begins; touch-and-drag (or hover) shows the date, season and rating at that point;
- the changes as a list (newest first, up to 40): the same data as text;
- a fixed readable blue for the line in each theme, never the team color (§93).
Before the first change it says the history starts the day the GM took over.

**The history (`state.ratingHistory`, `{ t, r, s }`).** `RosterEngine.teamRating` is now the one definition of the Rating (average OVR of the healthy active roster); the dashboard (`formatters.computeRosterOvr`) reads it. `recordRating` adds a point when the rating changes or a new season starts: at team creation, at each committed game, and after every roster-clock pass (moves, injuries, development, offseason steps). It is kept for the life of the franchise. It replaces `metricHistory` (per game, this season only, written but never read, and computed with a different average that counted injured players); saves from before r90 convert this season's per-game points to the new history.

Harness: the rating history is kept across seasons, in time order, one point per change, and its last point is the rating the dashboard shows. 8 seeds green; webpush and refs pass.

## 96. Waivers and free agents on the League screen; signing and claiming with a corresponding move (r91, GM feedback)

**Asked:** how waived players show up on the League screen, and whether there are true free agents. They didn't show up anywhere (the Players tab listed only the 10 active rosters); free agents existed but were only ever seen one at a time through cards. **Decision:** list both on the League screen, and let the GM sign a free agent or claim a waived player — handled correctly on the roster: when the incoming player's side of the 28 is full, the GM chooses who goes down.

**League screen.** The Players tab's club filter adds **On Waivers (n)** and **Free Agents (n)**; the table is the same (stats, sorting, position filters). A waived player's line shows the time left on the 72-hour claim window and "claim in" once ours is. A search now looks everywhere: every roster, the waiver wire and the market.

**Player card.** A waived player reads "On waivers — from ‹club›"; a free agent "Free agent — formerly ‹club›" and shows the **Asking** terms instead of the old contract. Buttons: **Sign Free Agent**, **Put In a Claim**, or **Withdraw Our Claim**.

**The sheet (`ui/components/SignSheet.js`).** The terms (in season a short deal — §73 `signingTerms`; in the offseason the market ask — §70; a prospect signs to the farm with a bonus), when the player reports (the next day with games on), and for a claim how it's decided (when the window closes, worst record first; the contract comes with the player). When the side is full: **Make room** — every active player on that side (pitcher for a pitcher, hitter for a hitter, §76), weakest first, starters marked, each with what happens: to the farm; or, the farm side being full, to the farm with the farm's weakest put on waivers (in the offseason: released). For a claim the choice is who goes down **if the claim is awarded**. Payroll after the move against ownership's target; the reason when it can't be done (ownership won't approve the payroll, the bonus, the window closed, rosters set for the postseason). The button stays off until a player is chosen.

**Engine (`engine/FreeAgency.js`, pure):** `waiverList`, `freeAgentList`, `termsFor`, `roomFor`, `signBlocker`, `claimBlocker`, `sign`, `claim`, `withdrawClaim`. `GameEngine.gmSignFreeAgent` / `gmClaimOffWaivers` / `gmWithdrawClaim` carry them out (our signings go on the League wire; claims already did when awarded).
- A claim stores the GM's choice (`_userClaimDrop`); `TransactionEngine._resolveWaiver` sends that player down when our claim wins, if still on our active roster on that side — otherwise the weakest reserve, as before.
- **Found and fixed:** `MarketEngine.signToClub` released a player made room for when the farm side was full — a big-leaguer cut outright. It now uses the same farm rule as every option (`RosterEngine.sendToFarm`: the farm's weakest goes on waivers) and clears a lineup or rotation spot the player held. Its "games on" check missed the All-Star break, the trade-deadline phase and the postseason rounds (it named a `PHASE.POSTSEASON` that doesn't exist), so a signing in those phases joined at once instead of reporting the next day.

**Harness** (on copies of the real league at game 30): with our hitters full, a signing asks who goes down and offers only hitters; the signing reports the next day, our choice goes down, the 28 still holds, the salary is on our payroll; with our claim first in order, the claim is awarded and the player we chose (our best bench bat, not the weakest) goes down; the lists hold only waived players and unattached free agents. 8 seeds green; webpush and refs pass.

## 97. Waiver order stays by record; the Hitting Coach's icon (r92, GM decision)

**Waiver claims (decision, supersedes §20.2's priority cycling):** claims are decided when the 72-hour window closes, worst winning percentage first (fewer wins breaks a tie); the waiving club is skipped. We claim only by putting a claim in; a CPU club claims when the player is at least `WAIVER_CLAIM_MIN_UPGRADE` (3) OVR better than its weakest healthy active player at his position and its owner can carry the contract. §20.2's rolling priority (a claim drops the club to last; order set from last season; "your priority: 4th of 10") is **not** being built. `state.waiverPriority` stays unused.

**The Hitting Coach's icon** was a cricket bat (🏏 — Unicode has no baseball bat). It is now ⚾ on the compose screen and on the Hitting Coach's three report cards.

## 98. Push: the worker ran out of its free KV allowance every day (worker r93)

**Symptom:** cards arriving with the app closed didn't push (§94); the worker's `/status` page answered Cloudflare Error 1101 ("Worker threw exception").

**Cause:** Workers KV on the Free plan allows 1,000 writes and 1,000 list calls a day (reset 00:00 UTC); past either, every further call of that kind throws. The cron runs every minute — 1,440 times a day — and every run listed the devices (`SCHEDULES.list`) and wrote its report (`meta:cron`), whether or not anything was due; every `/register` wrote too. Both limits ran out each day — with the app's syncs, well before mid-afternoon US Eastern — and from then until 8 PM Eastern (00:00 UTC) the cron threw before sending anything, `/register` failed, and `/status` threw. It worked when tested in Chat #3 because that was early in the UTC day.

**Fix (`workers/push-worker.js`):**
- Devices are found through one index key, `meta:devices`, written only when a device is added or removed (built once with a single list call on first run). The cron never lists.
- The cron only reads unless something is due; it writes a device's schedule after sending, and `meta:cron` only when it sent something (`/status` shows it as `lastSend`).
- `/register` writes only when the schedule or subscription changed (the app re-sends unchanged schedules often).
- Any failure inside a request answers JSON `{ ok: false, error }` (503) instead of Error 1101, so a limit shows up as a readable reason.

**Harness (`test-webpush.mjs`):** a full day of idle cron minutes plus 50 unchanged registers cost 0 writes and 0 list calls; the existing send/decrypt/VAPID checks pass.

**Deploying:** the worker is deployed by pasting into Cloudflare (the connector reads code but can't deploy). After pasting, today's exhausted allowance still has to reset at 00:00 UTC (8 PM Eastern) before the first run can build the index; from then on it stays far inside the limits.

## 99. The 30-minute game reminder; "nobody fits" cards become Keep Watching / Drop It (r93, GM feedback)

**Game reminder.** A push 30 minutes before first pitch, so the GM can clear the inbox before the game. It's built into the push schedule the app already syncs (`CardEngine.getPushSchedule` → `gameReminders`). It covers the next `GAME_REMINDER.ahead` (3) uncommitted games, so it still fires when the app has been closed for a day or two. Title "First pitch in 30 minutes"; body "vs/@ Opponent — a good time to catch up on the inbox before the game." No clock time appears in the text (§93). A reminder falling inside quiet hours is skipped. Settings has a **Game Reminder** toggle (`push.gameReminder`, default on; older saves treat a missing value as on). Push only — no inbox card. It needs the redeployed worker (§98).

**Fewer "got it" cards.** Three notices said "nobody fits" and left the GM nothing to decide. They now ask **Keep Watching** / **Drop It**:
- the deadline-idea / bullpen search with no fit (`lt_none`);
- beaten to a player, with no other fit (`lt_beaten`);
- a club that wanted to shed payroll and had no deal that worked (`fin_called_back`).

Keep Watching opens a 14-day watch (`state.tradeDesk.watches`: spec, what, sender, startedAtMs, untilMs). Every daily trade desk runs `CardEngine.runWatches`:
- The first fit becomes the usual offer-to-make card (`lt_offer`, key `…:found`, "Found: Name"), or the club's offer for `fin_called_back`. That ends the watch.
- If two weeks pass, or the trade window closes, the watch ends with a line in Recent, not another card.
- Drop It, or no answer, ends it.

Watch specs are data (`need` / `rp` / `role` / `club`), turned into a fit test by `_fitsFor` at each desk, so a watch survives a save and reload.

**Kept as notices (GM's call).** These five report a fact with no real choice in it, so they stay one-button: `lt_unsent`, `lt_noscout`, `owner_no_taker`, `owner_trade_blocked`, `trade_off`.

**Dashboard team colors** stay as they are for now (GM's call).

**Harness:**
- The reminder lands at gameTime − 30 min unless it falls in quiet hours, and there are none when the toggle is off.
- Keep Watching opens a 14-day watch; a watch with no fit stays open a day later and ends at 15 days with a Recent line; a watch any club can meet turns into an `lt_offer` at the next desk.
- These injected cases run on a snapshot of the season, which is restored afterwards so they don't change the rest of it.
- Natural watch cards carry the labels and a spec.

## 100. Weather, forecasts and the radar — plan (GM decisions, before build)

Replaces the weather parts of §6.9 and §8.8 where they conflict. The game-state machine in §8.8 (SCHEDULED → PRE_GAME_WATCH → DELAYED → LIVE / POSTPONED, SUSPENDED → RESUMED) and the field-condition idea stay.

### What existed (audit)
- `WeatherEngine.js` is never called. Every game is hardcoded `Clear`, and the schedule icons never show (`_weatherGenerated` is never set).
- `RadarWidget.js` is imported but never rendered.
- `GameEngine.applyWeatherDelay` / `suspendGame` / `resumeSuspendedGame` exist, but nothing calls them. No makeup scheduling exists.
- The old engine can't support a trustworthy radar:
  - it generates one random condition per hour for a single location, using `Math.random`;
  - the radar "cell" is a random position every frame;
  - the buffer is re-rolled on refresh, so a forecast already shown could silently change.

  Its core is replaced. Its constants (region modifiers, delay and postponement thresholds, card expiries, penalties) carry over where they still fit.
- The sim already reads `game.weather` (`label`, `scoringMod`) and `fieldCondition`. Real weather affects play once it flows in.

### GM decisions
1. **Forecasts are realistic but nearly always right.** Systems sometimes break up before reaching a park that was forecast to get rain. Pop-up storms sometimes form where none was forecast. The past is always exact.
2. **League-wide.** The same weather delays and rains out CPU games at rival parks. Makeup games and doubleheaders happen across the league.
3. **The radar loop runs from 2 hours ago to 24 hours ahead.** The loop choices are Past 2 hours (10-minute steps), Next 6 hours (15-minute steps) and Next 24 hours (hourly steps). Future frames are labeled as forecast.
4. **A separate 10-day forecast**, apart from the radar. The schedule screen shows weather from the same source.
5. **No premium split.** Everyone gets the full radar and the 10-day forecast.
6. **Zoom:** three levels, Region / Metro (the default) / Ballpark, centered on the game's park.
7. **Colors follow real radar conventions:**
   - rain: green → yellow → orange → red → magenta at the top end;
   - mixed precipitation: pink;
   - snow: light blue → dark blue.

   The base map is a flat map.

### Two layers: what happens, and what was forecast
**What happens** is one weather model for the league's region: a set of systems.
- System types: stratiform rain shields, frontal lines, squall lines / thunderstorm clusters, pop-up afternoon cells, and snow / mixed bands when the column is cold enough.
- Each system has a shape, a track (mostly west → east, drifting a little SW → NE), a speed and a lifecycle (forms, grows, peaks, decays). Some break up early.
- Every system comes from the save's `weatherSeed` and the time slot it forms in. The precipitation at any (x, y, t) is a pure function, so it's never stored, never re-rolled, and comes out the same every time it's asked.
- Climate follows the **baseball calendar** (the date the schedule shows), so April in the North can bring frost and snow. Hour of day follows the real clock, so pop-ups peak in the afternoon. Region shapes frequencies:
  - East: the most rain;
  - West: the driest;
  - South: afternoon thunderstorms and heat;
  - North: cold, with snow early and late in the season.

**What was forecast** is a forecast "run" issued every hour. Like the truth, it's a pure function of the seed and the run's hour. A run projects the systems that exist (or are about to) along their *expected* track and lifecycle. Its error grows with lead time, and it is correlated from run to run, so forecasts firm up as time approaches instead of flip-flopping:
- **Track, speed and timing errors** grow with lead time.
- **Breakups** of a system that dies early: a run only "sees" the decay inside a short horizon, so forecasts several hours out can still show it arriving.
- **Pop-ups:** a run doesn't know where individual cells will form. Its future radar places its own plausible cells, and its point forecasts give a chance of storms from the convective setup. Real pop-ups form where the truth puts them.
- **Precipitation chances** come from an ensemble: perturbed members of the same run. They are **calibrated**: across a season, "40%" rains about 40% of the time. The harness checks this. Calibration is what makes the forecast trustworthy without being perfect.

The radar and every forecast display at a given moment read the **same current run**. The radar, the dashboard and the schedule can never disagree with each other.

### One source of truth, everything reads it
`engine/WeatherEngine.js` (pure) provides:
- `precipAt(seed, region, x, y, t)` and `conditionsAt(park, t)` — what happens;
- `forecastRun(seed, region, issueHour)`, with `forecastAt(run, park, t)` and `dailyForecast(run, park, days=10)`;
- `radarFrame(seed, region, t, run?)` — a grid of intensity and type;
- `gameWeather(game)`.

Readers:
- **Radar:** the past is truth; the future is the current run.
- **Ballpark conditions:** truth at the park's map point. **Away games use the host park.**
- **Dashboard:** next-game forecast and a compact radar.
- **Schedule screen:**
  - completed games show the weather that actually happened (recorded on the game when it's played);
  - games within 10 days show the current run's forecast icon and chance of rain;
  - games further out show nothing.
- **Game decisions:** watch, delay, postponement, suspension.
- **Groundskeeper and weather cards.**
- **Sim modifiers:** temperature, wind, wet field.

### Map
Each region gets a fictional flat map, built from data in `data/regions-map.js`. Ballparks sit at fixed points, with the user's park near the middle:
- East: a coastline and bays.
- South: a Gulf coast and bayous.
- North: lakes.
- West: mountains and desert basins.

The map also carries a few highways and city labels (the club name without the nickname). It's drawn in the app's dark theme, flat style, with no satellite or terrain imagery.

### Radar UI (`ui/components/RadarWidget.js`, rewritten on Canvas)
**Placement:** a compact live radar on the dashboard's next-game card. Tapping it opens a full-screen radar.

**Rendering:**
- Precipitation is drawn as a smooth field with soft, slightly textured edges, like real reflectivity, using the color scales above.
- A legend bar shows Rain / Mix / Snow, light → heavy.
- Each frame has a timestamp, with a FORECAST tag on future frames.
- The park is marked, and the other parks are labeled.

**Controls:**
- Play / pause, with the loop repeating.
- A scrubber with a Now marker.
- Loop window choices: Past 2 hrs / Next 6 hrs / Next 24 hrs.
- Zoom −/+ across the three levels.
- Text labels rather than icons, per GM preference.

**Performance:** frames render from the model grid on demand and are cached per frame. No stored images.

### Game effects (league-wide)
- **Thresholds carry over from §8.8:** intensity bands → delay and postponement odds, temperature overrides and region modifiers. These are re-tuned so a season comes out MLB-like: roughly 2–4 rainouts per club (more in the East, fewer in the West) and rain delays more common than rainouts.
- **Decision rolls** are seeded per game, so a reload never changes an outcome.
- **Decision timing:** the delay or postponement call is made from the truth at the park, starting about 2 hours before first pitch. A game in progress can be delayed or suspended. A game suspended after 5 innings is official.
- **Makeups:** the next common off-day within 10 games; otherwise a doubleheader. This applies to CPU games too, and the All-Star schedule is respected.
- **Weather cards** reuse the §8.8 timing. Quiet hours are bypassed only for minute-scale weather cards (§8.8). No clock times appear in card text (§93).

### Build phases
1. **Weather model** (truth, forecast runs, ensemble chances) and the regional maps. Harness checks:
   - determinism;
   - west → east motion;
   - forecast error grows with lead;
   - calibration;
   - region climate rates;
   - the radar sample equals the park conditions.
2. **Radar component** (Canvas) and the full-screen sheet; screenshots at all three zoom levels and loop windows.
3. **Forecast surfaces:** dashboard next-game forecast, a 10-day forecast view and the schedule screen.
4. **Game effects:** watch / delay / postponement / suspension in the tick loop, league-wide makeups and doubleheaders, actual weather recorded on each game, sim modifiers, and weather cards. Requires a fresh team.

### 100.1 Step 1 broken down; 1a done — the regional maps

**Step 1 (the weather model) sub-steps:**
- **1a** Regional maps and ballpark positions.
- **1b** Deterministic foundation and climate (baseball-calendar date, real hour, region).
- **1c** What happens: weather systems and the precipitation field.
- **1d** Ballpark conditions from that field.
- **1e** Forecast runs.
- **1f** Calibrated rain chances and the 10-day forecast.
- **1g** Weather harness and tuning.

**1a — what was built:**
- **`engine/WeatherNoise.js`** — the only randomness weather code uses: hashes, seeded streams and value/fractal noise, all pure functions of a seed and integers. No `Math.random`.
- **`data/region-maps.js`** — the four authored maps. Units are km, x east and y north, with our park at (0, 0).
  - North: Lake Northmere along the top, Long Lake to the northeast, small lakes.
  - South: The Gulf, a delta, a bay, a long river.
  - East: Atlantic Reach, a deep bay toward us, barrier islands.
  - West: the Sawtooth Range, High Mesa, the Salt Flat, Mirror Reservoir.

  The file also has fictional state lines, rivers, each club's park and city, and the town-name parts.
- **`engine/WeatherMap.js`** (pure, cached per region) builds on that data:
  - roughens the outlines deterministically into natural shores;
  - generates the highways (a spanning tree over the parks plus a few extra links, never crossing water, with exits off the map edges);
  - adds a city area around each park, ~500 small towns plus suburbs per region (unique fictional names), and local roads.

  It answers `isWater`, `distanceToWater`, `parkOf`, `venueOf(game)` (the home club's park, so away games use the host's) and `cityOf`.
- **`ui/components/RadarMap.js`** — the Canvas base-map renderer, in a flat radar-app style, with dark and light palettes.
  - **Zoom levels:** Region 720 km / Metro 240 km (default) / Ballpark 64 km.
  - **What each zoom shows:** towns and local roads appear at Metro and Ballpark; a street grid inside the city areas at Ballpark only; water names at Region only.
  - **Labels:** placed without collisions. Our park is ringed.
- **Tools:**
  - `tools/harness/map-preview.html` + `render-maps.mjs` render all regions and zooms to PNGs.
  - `tools/harness/check-weather.mjs` checks, per region: parks on land, every park on the highway network, unique town names on land, and identical output from a separate fresh build.

  20/20 pass.

**Not yet wired** into the app, so there's no `sw.js` change. The new modules join the precache when the radar is wired in.

**Note for 1c:** `isWater` walks polygons (a region builds in 40–300 ms in Node). The weather will ask it far more often, so 1b/1c adds a raster land/water mask.

### 100.2 Step 1b done — the climate; weather during a game in progress (r94)

**Built:**
- **`data/region-climate.js`** — monthly normals for March–November per region, modeled on real climates (north ≈ Chicago/Minneapolis, south ≈ Houston/New Orleans, east ≈ Philadelphia/Boston coast, west ≈ Denver/Salt Lake City high desert). Each month has:
  - high and low;
  - dew point;
  - wet-day chance;
  - thunderstorm share of wet days;
  - storm-system speed (fast in spring and fall, slow in midsummer);
  - surface wind.

  Region extras: the north–south temperature gradient, how much big water evens out temperatures, high ground colder, lake effect (north), sea breeze (south, east), monsoon (west).
- **`engine/WeatherClimate.js`** (pure):
  - **`weatherContext(state)`** — seed, region, calendar, clock, map.
  - **`calendarDay`** — real time → baseball calendar.
  - **`normalsAt`** — normals for that day.
  - **`diurnal`** — low near 6 AM, high near 4 PM.
  - **`tempAnomaly`** — warm and cold spells about 1,300 km wide that drift east and evolve over a few days. Their size follows the season: s.d. about 7–8 °F in spring and fall, 3–4 °F in midsummer.
  - **`airAt(x, y, t)`** — temperature and dew point:
    - colder to the north;
    - near big water: a smaller day/night swing and about six weeks behind the season;
    - colder over high ground.
  - **`steeringAt(t)`** — the flow that carries systems: always west → east, wandering about ±40°.
  - **`stormPotential(x, y, t)`** — how readily pop-up storms form: humid afternoons, sea breezes, monsoon over high ground.
- **`engine/WeatherMap.js`** — a 2 km raster of the map (water / high ground / salt flat) plus a distance-to-water field, for fast lookups (`maskAt`, `waterKmAt`). It agrees with the exact polygons on 99.8% of points; the rest are shoreline cells.
- **Save state (`store/schema.js`):**
  - `weatherSeed` is fixed for the life of the franchise.
  - `weatherTzMin` is the save's clock, for time of day.
  - `weatherCalendar` is append-only. It holds an entry per season (`realStartMs`, `dispIso`) and per offseason. Through the offseason the climate blends from where the season ended to the next spring's first day, so temperatures never jump and the climate never passes through winter.
  - `GameEngine` writes the entries at new team, at offseason day 1 and at spring.
  - The migration gives older saves a seed built from fields that never change, so running it twice gives the same weather. It also adds the current season's entry, plus the offseason entry if one is in progress.
- **`SPRING_START_MONTH` / `SPRING_START_DAY`** moved from SeasonEngine to `data/constants.js`.
- **`sw.js`** precaches the new weather modules.

**Harness:**
- **`check-weather.mjs`**, 46 checks:
  - the same place and moment always gives the same air;
  - real days map one-for-one onto the baseball calendar;
  - monthly highs and lows within about 5 °F of normals, per region, over three seeds;
  - warmest mid-afternoon, coolest near dawn;
  - weather moves west to east;
  - 300 km south is warmer;
  - the mountains are colder;
  - storms brew in the afternoon, ordered by climate;
  - no temperature jumps through an offseason;
  - the blend weights are correct.
- **`sim-season.js`** — the save has its seed, clock and calendar entries (season 1; then season 1, offseason 1, season 2). Every scheduled game falls on its own date on the weather calendar.
- All 8 seeds pass.

**Weather during a game in progress (GM request).** A game is simulated in full at first pitch, with its plays spread over about three real hours. The weather at the park is a fixed fact for every minute, so the sim can read the weather along the game's own timeline. Built in step 4; the model supports it now:
- **Conditions change as the game goes.** Each half-inning gets the park's conditions at its moment: temperature falling into the night, the wind shifting, rain starting or stopping. These feed the sim:
  - wind in or out changes how far fly balls carry;
  - cold hurts contact;
  - heat wears on pitchers;
  - rain makes the ball slick (walks, wild pitches) and the field wet (errors, ground-ball hits).
- **Light rain plays through.**
- **Rain delay mid-game.** When the rain at the park crosses the delay threshold:
  - the play timeline gets a gap, and every later play shifts by the delay: until the rain falls back below the threshold, plus time to get the field ready;
  - the live view shows the delay (tarp, radar) while the clock is inside the gap;
  - the §8.8 delay cards fire;
  - a starter whose delay runs past about 45 minutes doesn't come back.
- **If it won't clear** (the delay passes its limit, or it's too late at night), the game is called:
  - **official** after 5 innings (4½ if the home team leads) — the result stands, "called after N innings";
  - **suspended** otherwise — it resumes from the exact spot (score, inning, outs, bases) at its makeup date.
- **Before first pitch**, the call starts about 2 hours out: on time, a delayed start, or postponed.
- **The forecast is what the GM sees; what happens decides.** A game can start under a dry forecast and be interrupted by a pop-up storm, as in real life. The radar shows it coming.
- **CPU games follow the same rules** (delays, called and suspended games, rainouts), so the standings and the map always agree.

### 100.3 Step 1c done — what happens: weather systems and the precipitation field (r95)

**`engine/WeatherSystems.js`** (pure, deterministic) — the truth every other weather surface reads.
- **Kinds of system:**
  - **front:** a long, tilted, bowed band. Its leading edge is a line of storms in the warm months and a rain band otherwise. Lighter rain trails behind it.
  - **shield:** a broad area of steady rain, with internal bands, gaps and ragged edges.
  - **squall:** a summer squall line. A thin, intense, bowed leading edge (50–60 dBZ) moves at about 1.25–1.65× the flow. Behind it come a lighter gap, then a wide trailing rain area (29–37 dBZ). It forms late afternoon or evening, fades by morning, and 25% fall apart early.
  - **showers:** cool, unsettled days with scattered small showers.
  - **cell:** pop-up thunderstorms, 45–105 minutes long, irregular, with 1–3 lobes, sometimes in clusters of 2–3. Most are modest and a few are severe. They have an anvil downstream.
- **Where systems come from:**
  - Synoptic systems are born in 6-hour slots from the seed, at rates set by the day's normals (wet days, storm share, warm season). Some form upstream and some right over the region; about 12% of fronts and shields fizzle early.
  - Pop-ups get one chance per 36 km square per 20 minutes. The chance is `stormPotential` × a trigger made of storm zones a few hundred km across × a region-wide regime, so some days storms go up everywhere and some days hardly anywhere.
- **Motion:** systems move with the steering flow at their birth, with a gentle wobble.
- **Units:** reflectivity in dBZ. Overlapping systems add their powers, as on real radar. The rain rate comes from Marshall–Palmer.
- **API:**
  - `activeSystems(ctx, t, box)`;
  - `precipAt(ctx, x, y, t)` → { dbz, kind (rain / mix / snow), rateMmH, convective };
  - `radarField(ctx, t, box, cellKm)` → a dBZ grid plus a kind grid. Each cell is exactly `precipAt` at the cell's centre.
- **Rain, mix or snow:** decided by `precipTemp`, a fixed 24 km × 15-minute temperature lattice anchored to the map, shared by the radar and the ballparks. The radar's colour over a park always matches what the park reports. Heavy precipitation drags the air up to 3 °F colder.

**`ui/components/RadarPrecip.js`** — real radar colours:
- rain: light green → green → dark green → yellow → amber → orange → red → dark red → magenta → purple (hail);
- mix: pinks;
- snow: light → dark blue.

The field is painted per cell, then scaled up with smoothing.

`RadarMap.drawBaseMap(..., { labelsOnly })` draws place names over the precipitation, as radar apps do.

**Tools:** `tools/harness/radar-preview.html` + `render-radar.mjs` (frames over the base map, any region / seed / day / hour / zoom).

**Harness (`check-weather.mjs`, 59 checks; 13 new):**
- the same place and moment always gets the same precipitation (separate module copies);
- the radar exactly matches what each place reports (2,000 sampled cells, amount and kind);
- rain moves west → east (82% of hours, median 36 km/h);
- summer heavy rain peaks in the afternoon;
- pop-up storms are an afternoon thing (≈43 at 5 PM, 0 at 8 AM, 1 at 3 AM, Gulf Coast July);
- snow only where it's cold (never above 36 °F; never in a southern summer; yes in a northern early spring);
- each region's wet days within 12 points of its climate (N 29/34, S 33/34, E 37/34, W 22/19), with the West driest;
- some systems break up early (about 16%) and some form overhead;
- a region radar frame builds in about 80 ms (Node).

**First measurements, left for 1g:**
- monthly totals: North July about 4.1", South July about 8.6" (high), East about 2.5–3" (a little low), West about 1.3–3.2";
- cool-season thunder days are low;
- region frames at 4 km cells show slight stair-stepping at the edges (radar step 2 will render finer);
- light snow's fade-in edge looks a little grey on the dark map.

### 100.4 Step 1d done — the ballpark report (r96)

**`engine/WeatherConditions.js`** (pure) reads everything off the same weather the radar draws.
- **`conditionsAt(ctx, x, y, t)`** returns:
  - temperature, dew point, humidity, and feels-like (heat index / wind chill);
  - wind: mph, gusts, direction it comes from;
  - cloud (0..1) and sky;
  - precipitation: dBZ, rain / mix / snow, rate in mm/h and in/hr, convective;
  - lightning (a thunderstorm of 43+ dBZ within 16 km ≈ 10 miles — the play-stopping rule) and the storm's dBZ;
  - day or night;
  - a label ('Severe Thunderstorm', 'Thunderstorm', 'Heavy Rain', 'Rain', 'Light Rain', 'Drizzle', 'Sleet', 'Rain and Snow', 'Heavy Snow' / 'Snow' / 'Light Snow', 'Storms Nearby', 'Sunny' / 'Clear', 'Mostly Sunny' / 'Mostly Clear', 'Partly Cloudy', 'Mostly Cloudy', 'Cloudy', plus ', Windy' or ', Hot');
  - an icon key.
- **`parkConditions(ctx, teamId, t)`** adds the park's orientation (`WeatherMap.parkBearing`, home plate → centre field, fixed per club, 15–90°) and `windAtPark`: 'out to center' / 'out to left|right' / 'left to right' / 'right to left' / 'in from left|right' / 'in from center' / 'calm', with mph blowing out (+) or in (−).
- **`rainTotal(ctx, x, y, t0, t1)`** gives inches of liquid, for field condition.
- **`daylight`** gives sunrise and sunset on the baseball calendar.
- **Temperature:**
  - It reads the same lattice the radar uses for rain / mix / snow, less heavy precipitation's drag and less rain's evaporative cooling.
  - Rain-cooled air lingers: the coolest of now and the last 90 minutes, recovering with a one-hour half-life.
  - A park reporting snow is never above 33 °F, and rain never below 33.4 °F.
- **Wind:**
  - It blows from about 35° to the right of where systems are heading (so south-westerly in the usual flow).
  - It is stronger in the afternoon.
  - Ahead of a front it swings south and freshens; behind it, north-west and gusty. A squall's outflow and nearby thunderstorms gust 22–52 mph.
  - Sea and lake breezes come off the water on summer afternoons.

**Added to `engine/WeatherSystems.js`:**
- **`cloudAt`** — each system's cloud is wider than its rain and builds before it, over a drifting background cloud and fair-weather cumulus on humid afternoons.
- **`frontAir`:**
  - Cold air behind a front: 9–18 °F, half that in midsummer. It fades over about 1,400 km behind the front and lingers 18 hours after the front's rain ends.
  - A warm, humid sector ahead.
  - A squall's rain-cooled outflow.
  - The strongest of each kind counts; fronts don't stack.
- **`surfaceTemp`** — sunny days run warmer and cloudy ones cooler; clear nights colder and cloudy ones milder. It is zero-mean about an average sky, plus the fronts.
- **`stormNear`.**
- The rain/mix/snow lattice now samples `surfaceTemp`.
- `activeSystems` takes a separate box for pop-up storms, so cloud lookups stay fast.

**Harness (`check-weather.mjs`, 78 checks; 19 new):**
- every ballpark report agrees with the radar (2,336 reports, wet and kind);
- snow is never reported warm;
- the label says rain exactly when it rains, under a full sky, and thunderstorm only with lightning;
- temperatures move smoothly (worst 6.5 °F in 5 minutes, a gust front);
- afternoon highs still match normals in every region (−4.7…+1.1 °F);
- dry afternoons run the range of skies (Clear…Cloudy);
- the wind is from S through NW (100%) at about normal strength;
- behind a cold front the wind comes from the NW (97%);
- a front's passage cools things about 8 °F a day later;
- wind-at-park directions;
- June sunrise 5:33, sunset 8:39;
- rain totals add up;
- a report takes about 6 ms.

**Left for 1g:** highs run 3–5 °F cool in some months; this is in the background climate, not the new layers.

### 100.5 Step 1e done — forecast runs (r97)

**A forecast is the same weather machinery seen through a run.** `forecastContext(ctx, nowMs, member = 0)` adds `run: { issueMs (the hour), member }`. Every weather function (`activeSystems`, `precipAt`, `radarField`, `cloudAt`, `frontAir`, `surfaceTemp`, `conditionsAt`, `parkConditions`) then answers as that run sees it. A new run comes out each hour. The radar's future frames, the dashboard and the schedule all read the same current run, so they can't disagree. **At lead 0 a run is exactly the truth.**

**What a run knows, and how it's wrong (`engine/WeatherSystems.js`):**
- **Every system that exists when it's made**, seen through a forecast copy:
  - a timing error (early or late) with s.d. 1.5·L + 0.008·L² km along the track, L in hours of lead (about 40 km at a day, about 150 km at three);
  - a track error (north or south) of 1.0·L + 0.006·L² km;
  - a strength error growing at 0.15 dBZ per hour to ±8;
  - an uncertain end time;
  - less fine detail at long range.

  Errors change smoothly from one hourly run to the next (they drift over about 9 runs), so forecasts firm up instead of flip-flopping.
- **Early breakups** are seen only within 4 hours. Before that, the run shows the system arriving.
- **Systems not yet born** are foreseen with chance e^(−lead/τ). τ is 130 h for fronts, 72 h for shields, 36 h for showers and 14 h for squall lines. Once foreseen, always foreseen as the time approaches.
- **Phantoms:** each run also shows systems that never happen (`phantom: true`), with chance 0.85·(1 − e^(−lead/τ)). They fade away as their time nears, which keeps long-range forecasts as wet as the climate.
- **Pop-up storms:**
  - storms already up within 30 minutes of the run are tracked (nowcast);
  - after that the run places its own, from its own seed (refreshed every 6 runs);
  - they are set off by the true trigger at short range, blending to the run's own guess by 60 hours.
- **Temperature:** the run adds its own error, s.d. 1.6 °F at a day growing with √lead to 3.6 °F, on top of what the system errors cause.
- **Members:** `member` is for the ensemble (1f). Each member foresees, misses and errs differently.

**Harness (`check-weather.mjs`, 87 checks; 9 new):**
- a forecast at lead 0 is exactly what happens (radar cells and every ballpark report);
- the same run always gives the same forecast;
- rain-forecast skill falls with lead (CSI 0.82 at 1 h, 0.66 at 6 h, 0.30 at 24 h, 0.09 at 72 h, 0.02 at 168 h);
- forecasts are no wetter or drier than what happens (rain area ×1.00 at 1 h, ×1.02 at 6 h, ×1.00 at 24 h, ×1.19 at 72 h, ×1.15 at 168 h);
- temperature errors: 1.1 °F at 6 h, 1.7 °F at 24 h, 4.1 °F at 72 h, 6.1 °F at 168 h (east, afternoons — about real-world skill; north runs a little worse mid-range, south a little better);
- one hourly run to the next changes a forecast only a little (0.25 °F; rain areas overlap 0.74);
- a breakup is a surprise until a few hours out (still forecast 10 h before: 7 of 7 already formed; seen 2 h before: 12 of 12);
- pop-up storms: tracked minutes ahead (overlap 0.54); a day ahead the right amount (×1.08) in the wrong spots (overlap 0.05);
- phantoms: 53 at 5 days, 0 at 2 hours.

`radar-preview.html` takes `day:hour:lead` frames to draw the forecast made `lead` hours earlier.

### 100.6 Step 1f done — chances of rain and the 10-day forecast (r98)

**`engine/WeatherForecast.js`** (pure; cached per hourly run).

**`chanceOfPrecip(ctx, nowMs, x, y, t0, t1)`** — the chance of measurable precipitation (0.01") at a point over any window.
- **The ensemble:** the main run (member 0 — what the radar's future frames show; it counts as 2 members) plus 12 members. Each member is a run made at the same hour with its own errors, foresees and misses its own systems, and places its own pop-up storms. Members are sampled every 30 minutes out to 3 days, hourly after that. The rain-vs-snow work is skipped when the normal low is above 40 °F.
- **Raw share:** (wet + 0.25) / (14 + 0.5).
- **`calibrateChance(raw, climate, lead)`** = σ(logit c + a·(logit r − logit c) + b).
  - c is the climate's chance for the window (`climateChance`: the wet-day normal scaled as 1 − (1 − p_day)^((h/24)^0.7)).
  - a = 1.65 when the ensemble leans wet and 1.15 when it leans dry. It is held to about 4½ days, then fades to 0.2 by about 8½ days, where the forecast is essentially the climate.
  - b drifts from −0.1 to +0.2.
  - This was fitted on four regions × four seeds × a season, for windows of 3 hours and a day, then checked on seeds it wasn't fitted on. Within a day: 7% → 7%, 27% → 30%, 48% → 50%, 66% → 67%, 96% → 95%. At day 4: 9% → 16%, 24% → 20%, 44% → 44%, 63% → 70%, 88% → 96%.
- **Never contradicts the radar:** within 24 hours, rain the radar shows at the park is never below 30%, and a dry radar is never above 80%.
- **Returns:** { chance (0, then steps of 10), raw, climate, kind (rain / storms / snow / mix), timing (share overnight / morning / afternoon / evening), mainWet }.

**`dailyForecast(ctx, nowMs, x, y, 10)`** — one entry per local day from today:
- the baseball-calendar date (`WeatherClimate.baseballDateIso`; null in the offseason);
- the day's high and tonight's low, from the main run, drawn toward normals further out (`tempTrust`: full trust to a day, about 35% at day 10);
- the chance for the rest of the day;
- kind;
- a label, a summary and an icon:
  - **60% and up:** "Thunderstorms in the afternoon. Chance 70%."
  - **30–59%:** "Partly cloudy, with a chance of storms in the evening. Chance 40%."
  - **10–29%:** "Mostly sunny. A slight chance of showers."
  - **Under 10%:** the sky alone.
- the afternoon wind.

**`hourlyForecast(ctx, nowMs, x, y, hours)`** — hour by hour for a game window: temperature, the chance for that hour, label, icon and wind.

**Speed:** a 10-day forecast takes about 0.8 s in Node and is computed once per hour. To get there:
- the pop-up storm cache now uses numeric keys per world, looked up once per query;
- the normals are memoised per 10 minutes;
- calendar dates are memoised.

**Harness (`check-weather.mjs`, 97 checks; 10 new):**
- chances verify on held-out seeds (bins with 30 or more cases within 12 points; days 1 and 4);
- no wet or dry lean (forecast 35% vs 36% of days wet);
- skill over the climate: 0.68 at day 1, 0.35 at day 4, 0.03 at day 10;
- within a day the chance never contradicts the radar (0 of 240);
- 10 days on the baseball calendar;
- the words match the chances;
- highs above tonight's lows;
- forecast highs are off by 0.9° today, 4.9° at day 7 and 3.9° at day 10 (the run alone: 5.7°);
- 10-day speed;
- the hourly window.

### 100.7 Step 1g done — tuning; the weather model (step 1) is complete (r99–r100)

**Precipitation:**
- **Monthly rainfall normals** (`inches`) were added to `data/region-climate.js`, from the same real-climate analogues.
- **Rain rate is capped at 53 dBZ** (`RAIN_DBZ_CAP`), as radar rainfall estimates are: stronger echoes are hail, not more rain.
- **Fronts:**
  - Cool-season fronts are wider and steadier.
  - Summer fronts are weak and narrow; they were crawling across the Gulf Coast at about 20 km/h and dropping several inches.
  - A front comes through as a line of thunderstorms with chance min(0.9, 1.2 × storms), so spring and fall get their thunderstorms.
  - The front birth rate is scaled by (1.15 − 0.5 × storms), so fewer fronts form where storms supply the rain.
- **Squall lines** are twice as common (they rarely reached a ballpark).
- **Shields** rain a little harder.

**Calibration table (`data/weather-calibration.js`, generated by `tools/harness/calibrate-weather.mjs`):**
- **What it's measured on:** six seeds, three places, every month March–November, with the corrections off; then smoothed across months. Like the statistical corrections real forecast models use.
  - `rainK` — a rain-rate factor per region and month (0.58–1.98; real radars use different echo-to-rain rules in tropical and continental climates). The radar picture is unchanged.
  - `tempBias` — how far clouds, fronts and rain-cooled air pull the surface away from the background climate, by month and local hour. `surfaceTemp` subtracts it, so temperatures average to the normals.
- **How it's applied:** both ride along with the normals (`WeatherClimate`: `_months`, `tempBiasAt`, `useCalibration(false)` for the tool), so they interpolate by day and blend through the offseason.
- **Result, on saves the table wasn't built from (`tools/harness/tune-weather.mjs`):**
  - highs and lows within about 1 °F in most months; spring 1–3 °F warm, within a spring month's sampling noise;
  - wet days within about 0.1;
  - summer thunder days (lightning within 10 miles, as observers count them): N 0.21 / 0.19, S 0.27 / 0.32, E 0.20 / 0.17, W 0.13 / 0.14;
  - rain totals mostly close; a single storm moves a month noticeably in a three-save sample.

**Forecasts:**
- **Nowcast window is 60 minutes** (from 30). Storms that form within the hour after a run are tracked. This stands in for minute-by-minute nowcast updates between hourly runs; the radar's near-term frames match what happens with 97% overlap.
- **Chance calibration refitted** on a fresh 8-seed dataset (fit on 4, validated on 4):
  - wet leans are sharpened ×1.6 up close, growing to ×2.0 at 2½ days, then fade to 0.25 by about a week;
  - dry leans are softened to ×0.85, fading by about 5½ days;
  - the offset runs −0.4 to +0.2.
  - Held out: 8% → 8%, 24% → 24%, 45% → 51%, 66% → 82% (28 cases), 94% → 96%.
  - Skill 0.64 at day 1, 0.34 at day 4, 0.04 at day 10.

**Tools:**
- `tune-weather.mjs` — each region and month against its normals: highs, lows, wet days, inches by system kind, thunder days, day-to-day swing.
- `calibrate-weather.mjs` — regenerates the table. Rerun it whenever the systems change.

**Harness:** `check-weather.mjs` 97/97. All 8 season seeds pass.

**Step 1 (the weather model) is done** — `WeatherNoise`, `WeatherMap`, `WeatherClimate`, `WeatherSystems`, `WeatherConditions`, `WeatherForecast`, plus the data files. Nothing is on screen yet. **Next: step 2, the radar component.**

## 101. Step 2 — the radar (sub-steps)

- **2a** The frame engine.
- **2b** The renderer.
- **2c** The full-screen radar sheet.
- **2d** The compact radar on the dashboard's next-game card.
- **2e** Performance and review.

### 101.1 Step 2a done — radar frames (r101)

**`engine/RadarFrames.js`** (pure):
- **`LOOP_WINDOWS`:**
  - Past 2 hrs: 13 frames, 10 minutes apart, ending at the latest 10-minute picture.
  - Next 6 hrs: now, then 24 frames 15 minutes apart.
  - Next 24 hrs: now, then 24 hourly frames.
- **`frameTimes(now, loop)`:** the past and now are what happened. The future is the forecast run made in now's hour, the same run the dashboard and schedule read.
- **`viewBox(map, focusId, zoom, aspect)`:** the view is centred on a ballpark (Region 720 km / Metro 240 km / Ballpark 64 km wide). The grid covers it with a 6% margin at about 200 cells across, so it's 212×272 at a phone's shape at any zoom.
- **Packed frames, one byte a cell:**
  - 0 means nothing is falling.
  - Otherwise rain / mix / snow sits in the top two bits, and the dBZ is level + 11.5, to the nearest half-dBZ either way, so a faint echo never reads as dry.
  - About 58 KB a frame.
- **`buildFrame(base, frame, grid)`** and **`frameKey`.**

**`ui/components/radar-worker.js`** (module worker) builds frames off the main thread, one at a time, yielding between them. A newer request (a zoom or loop change) cancels the rest of an older one.

**`ui/components/RadarFrameSource.js`:**
- **`createFrameSource({ onFrame, onDone })`** with `setContext(state)` / `request(frames, grid, { first })` / `get(key)` / `dispose()`.
- The frame being shown is built first, then outward.
- **Shared cache:** a 12 MB byte-budgeted cache, so frames already built come back at once.
- **Fallback:** without workers (or if the worker dies mid-request), the remaining frames are built on the main thread in slices.

**Harness:**
- **`check-weather.mjs` (103 checks; 6 new):**
  - loop timings for all three windows;
  - the view centres on the park and the grid covers it;
  - packed frames match the radar field exactly (40,293 wet cells, 0 off; truth and forecast);
  - a frame builds in about 90–105 ms in Node at every zoom.
- **`test-radar-frames.mjs` + `radar-frames-test.html`** (Chromium, CPU ×4 to approximate a phone):

  | Path | Loop | First frame | Full loop | Longest main-thread stall | Matches main thread |
  |---|---|---|---|---|---|
  | Worker | Metro, Next 6 hrs (25 frames) | 0.5 s | 3.8 s | 51 ms | yes |
  | Worker | Region, Past 2 hrs (13 frames) | 1.1 s (worker start-up and map build) | 3.3 s | 64 ms | yes |
  | Fallback (no worker) | Ballpark, Next 24 hrs | 0.1 s | 3.9 s | about 1.1 s once, at start-up | yes |

### 101.2 Step 2b done — the radar renderer (r102)

**`ui/components/RadarRenderer.js`:**
- **API:** `createRadarRenderer(canvas)` → `setView({ map, focusId, zoomIdx, theme, userCity })`, `draw(frame | null)`, `prepare(frame)`, `resize()`, `grid` (the frame grid to request), `pictureOf(frame)` (for tests), `dispose()`.
- **Layers:**
  - The base map (no labels) and the label layer are drawn once per view, at device pixel ratio up to 2.
  - The label layer holds the place names and a scale bar in miles (1 / 2 / 5 / 10 / 20 / 25 / 50 / 100 / 200, about 80 px long). Labels go over the precipitation, as radar apps do. The scale bar's corner is kept clear of labels (`RadarMap.drawBaseMap(..., { reserve })`).
- **Precipitation:**
  - **Blending before colouring:** each frame's reflectivity is blended between grid points (an empty point counts as 6 dBZ, so edges fade out between points) before it is coloured through a per-kind lookup at every half-dBZ. Edges come out smooth, with crisp colour bands.
  - **Rain / mix / snow:** taken from the strongest of the four surrounding points.
  - **Faint echoes:** they fade in (12–16 dBZ); snow fades less, because pale blue at low strength read as grey fog on the dark map.
  - **Resolution and caching:** drawn at up to 1.25× CSS size; each frame's picture is cached (30 per renderer). The frame is unpacked once into a padded grid, so the per-pixel loop has no bounds checks.
- **Colours (`RadarPrecip.js`):** the lightest snow is now a true light blue (`#8cc8f5`, `#6fb4f0`, `#4d97e6`, …).
- **`radarLegendHTML()` + `radarLegendCSS`:** Rain / Mix / Snow colour bars, Light → Heavy.
- **`formatFrameTime(t, tzMin, now)`:** "2:30 PM", "Tomorrow 1:00 AM", "Sat 4:00 PM", on the save's clock.

**Speed (Chromium at CPU ×4, roughly a phone):** a new frame's picture takes 70–140 ms; drawing a cached frame takes about 1 ms. Desktop: 16–50 ms.

**Harness:**
- **`test-radar-render.mjs` + `radar-consistency-test.html`:** the radar's colour over every ballpark agrees with that park's report. Dry means no colour; rain / mix / snow means that colour family. Covers 186 park views across four regions, three zooms, now and forecast frames.
- **`radar-render-preview.html` + `render-radar2.mjs`:** phone-sized cards with a time bar (NOW / PAST / FORECAST tag), the radar and the legend, in either theme, optionally CPU-throttled.

### 101.3 Step 2c done — the full-screen radar (r103)

**`ui/components/RadarSheet.js`:**
- **API:** `openRadarSheet({ state, focusId, nowMs?, onClose?, loop?, zoomIdx? })` and `venueOf(game)` (the home club's park). It takes the save and the park; it doesn't reach into the app, so it is testable on its own.
- **Header:** "Radar", a **Center on** park picker (our city first, then the rest A–Z) and **Done**.
- **Time bar:** the frame's time on the save's clock ("Tomorrow 2:00 AM"), a tag (NOW / PAST / FORECAST, in gold) and "Loading k/n" while frames build.
- **The map:** fills the space between the time bar and the controls; the renderer from 2b.
- **Controls (text labels):**
  - **Play / Pause.**
  - **A timeline:** a range input, with a tick per frame underneath. Ticks light up once built (gold for forecast frames), and the shown frame is marked. The start and end times sit at the ends, with **Now** under the now frame.
  - **The loop:** Past 2 hrs / Next 6 hrs / Next 24 hrs.
  - **The zoom:** Region / Metro / Ballpark.
  - **The legend.**
- **Playback:**
  - 0.5 s a frame, holding 1.6 s on the last before starting over.
  - It plays whatever frames are built while the rest arrive, and opens on Now.
  - Scrubbing pauses. Zoom and park changes keep the time shown; a loop change starts it again.
  - Escape closes; Space plays or pauses.
- **Frames:** the frame source (worker) builds the shown frame first. Pictures for the rest are pre-drawn in idle time.
- **Refresh:** a check every minute rebuilds the loop when a newer radar picture or forecast run arrives, keeping the time shown.
- **Housekeeping:** the loop pauses while the app is hidden, and a ResizeObserver redraws on size change. Close tears everything down (listeners, the worker, timers, renderer).

**`RadarFrameSource` fix:** frames already in the cache are handed over just after `request` returns. Before, they arrived before the caller knew the new loop's keys, so a frame carried over from the previous loop was never counted.

**Harness — `test-radar-sheet.mjs` + `radar-sheet-test.html`** (Chromium at 390×844, ×3 pixels; at normal speed and at CPU ×4). Every check passes at both speeds:
- past 2 hrs loads all 13 frames through the worker (about 2 s at ×4) and plays;
- next 6 hrs loads its 25 (about 3.9 s);
- Pause, and scrubbing to a FORECAST frame;
- zooming out keeps the time shown;
- centring on another park;
- next 24 hrs at Ballpark;
- Done removes it;
- no page errors.

Screenshots cover each loop and zoom, plus the light theme with snow.

### 101.4 Step 2d done — the radar on the dashboard (r104)

**`ui/components/RadarCard.js`** — the small live radar under the next-game card and first-pitch countdown.
- **What it shows:** the past 2 hours at Metro zoom, centred on the game's ballpark (`RadarSheet.venueOf`: the home club's park, so away games show the host's city).
- **Header:** RADAR · the city · the frame time with a NOW / PAST tag.
- **Footer:** "Past 2 hrs" · "Tap for the full radar". Tapping opens the full-screen radar on the same park.
- **The loop:** 0.6 s a frame, holding 2.5 s on Now. It pauses when off screen (IntersectionObserver), when the app is hidden, and while the full radar is open. It picks up a newer radar picture each minute.
- **API:** `createRadarCard({ onOpen })` → `root`, `update({ state, focusId })`, `setMapHeight(h)`, `pause()` / `resume()`, `dispose()`.

**Shared frames:** `RadarFrames.viewBox` now always builds a grid covering at least a 0.7-aspect (tall phone) view, whatever shape asks. The card (wide) and the full radar (tall) request identical frames. The card's frames warm the shared cache, so opening the full radar's Past 2 hrs loop is ready in 2–60 ms.

**`DashboardScreen`:**
- **Mounting:** `_radarSlot(game)` adds an empty slot (`data-focus` = the venue) after the next-game card and countdown. After every redraw `_attachRadar` moves the same card element into the new slot, so redraws don't restart it.
- **Fitting:**
  - **The rule:** the idle dashboard still doesn't scroll (§88).
  - **`_fitRadar`:** the map takes the room there is — 180 px when it fits, shorter on shorter screens.
  - **Too little room:** under 90 px the card steps aside and a **Radar** button appears in the next-game card's right column, opening the full radar.
  - **When it runs:** after each redraw, on resize, and when Recent opens or closes (from `_syncScrollRoom`).
- **Cleanup:** on unmount the card is disposed (its worker, observers and timers) and the resize listener is removed.
- **Old `RadarWidget.js` removed** (never rendered; read the old weather buffer).

**Harness — `test-dashboard-radar.mjs`** (the real app: a new team, Chromium at phone sizes, both themes). All pass in both themes:
- the next-game card has a radar on the game's ballpark (home and away);
- it names the place and shows a time;
- a dashboard redraw keeps the same radar;
- tapping opens the full radar on the same park, its loop ready at once (2–60 ms);
- Done closes it;
- no page errors;
- at 932 / 844 / 760 / 700 / 640 px tall the radar adds no scrolling to the idle dashboard: map 180 px at 932, 110 px at 844, a Radar button at 760 and below, and the button opens the full radar.

**Note (pre-existing, not the radar):** at 640 px tall the idle dashboard already overflows by 19 px without the radar.

### 101.5 Step 2e done — radar performance and review; step 2 (the radar) is complete (r105)

**Measured in the real app at CPU ×4 (`tools/harness/perf-radar.mjs`, 390×932, a new team):**

| | Before | After |
|---|---|---|
| Dashboard with radar ready | 3.0 s | 1.35 s |
| Longest long task while loading | 2.2 s | 0.43 s (a third of that is the app's own start-up) |
| Total long tasks while loading | 2.6 s | 0.8 s |
| First radar frame | — | 1.5 s after start |
| Full radar slides in after a tap | 0.8 s | 0.1 s |
| Full radar's loop ready | — | about 0.85 s |
| Loop / zoom switch, fully loaded | — | median about 2.1 s (frames play as they arrive; the shown frame comes first) |
| Small loop's CPU | — | about 4–6% of a core running, about 1% paused |
| Draws while paused or hidden | — | 0 |
| 10 open / close cycles of the full radar | — | heap 6 → 7 MB; workers 1 → 1 (each sheet's worker is terminated) |

**What changed:**
- **`WeatherMap.regionMap` builds the raster first.** The highway, local-road and town placement then ask the raster "is this water?" in constant time instead of polygon tests. The build fell from 140–430 ms to about 70–170 ms in Node (about 2.5 s → about 0.3 s at ×4).
- **Towns and suburbs** now keep two raster cells (4 km) from any water, so they are on land by the exact outline too. Town positions and names shifted slightly; they remain fixed from here on.
- **`RadarCard.update`** defers the weather setup (the region's map) and the first drawing to an idle moment. The card keeps its space (a placeholder background), so the dashboard paints first with no layout shift.
- **The card's header and footer have fixed heights** (38 px / 34 px; an empty tag is hidden). Text arriving later no longer changes the card's height, which had caused a 4 px overflow the dashboard fit hadn't measured.
- **`RadarSheet`** slides in, then draws the map on the next frame (the base map and labels at full resolution are the heavy part).
- **`RadarFrames` `GRID_ASPECT` is 0.55** (from 0.7). The shared grid covers a tall phone's full radar (390×641 map at 932 px tall), so the card's frames serve it.
- **`RadarCard` exposes its controller on `root.radarCard`** for tests, with a draw count.

**Review — `tools/harness/radar-gallery.mjs`:** the full radar at every zoom × loop, in both themes, at a stormy moment (a northern squall line overnight). The storms sit consistently across zooms, and the forecast frames carry the line northeast past our park overnight, clear by morning.

**Regression:** all pass, the dashboard tests four runs in a row:
- `check-weather.mjs` 103/103;
- `test-radar-frames.mjs` (×4);
- `test-radar-render.mjs`;
- `test-radar-sheet.mjs` (×4);
- `test-dashboard-radar.mjs` (both themes, five heights);
- the season harness.

**Step 2 (the radar) is done.** Next in the §100 plan: **step 3 — forecast surfaces:**
- the dashboard's next-game forecast;
- a 10-day forecast view;
- the schedule screen showing the actual weather on played games and the current run's forecast within 10 days.

After that, **step 4 — game effects:**
- watch / delay / postponement / suspension in the tick loop;
- weather during a game in progress;
- league-wide makeups;
- sim modifiers;
- weather cards.

Step 4 will need a fresh team.

---

## 102. Step 4 — game effects (sub-steps)

GM asked for step 4 before step 3 (forecast surfaces), broken into sub-steps. Step 3 is still outstanding.

| Sub-step | What |
|---|---|
| **4a** | Each game's weather plan — a pure engine (r106) |
| 4b | The sim plays through the weather: wind / temperature / wet-field modifiers, delays as gaps in play timestamps, starters not returning after long delays, called and suspended games |
| 4c | The schedule reacts in the tick loop: statuses, league-wide postponements with makeups (off day or doubleheader), suspended games resuming, actual weather recorded on every game (replacing the hardcoded `'Clear'`) |
| 4d | On screen: the live delay view (tarp, radar), PPD / SUSP labels on the dashboard and schedule, weather inbox cards that are real decisions |
| 4e | Season checks and tuning: rates per region, no lost or doubled games, standings add up. **Needs a fresh team.** |

### 102.1 4a — each game's weather plan (r106)

`engine/GameWeather.js` — `gameWeatherPlan(ctx, game)`. Pure and deterministic: the save's weather context and a game in, a plan out. It works the same for our games and the rest of the league, and it can be computed at any time (it never changes), so 4c can work plans out ahead of time a few per tick and cache them on the games.

**One source of truth.** The ballpark is read every 5 minutes with `WeatherSystems.venueSample`. That is one look at the systems giving exactly `precipAt` plus `stormNear(16 km)`, so:
- the plan's "lightning" is the park report's `lightning` (`LIGHTNING_DBZ` 43, now exported);
- its rain is the radar's rain over the park.

**Rules** (`GAME_WEATHER` in constants):

*Play stops* for any one of:
- lightning within about 10 miles;
- rain of 7.5 mm/h or more (about 0.3 in/hr);
- steady rain of 2.5 mm/h or more for 20 minutes;
- snow or sleet of 18 dBZ or more.

*The tarp comes off* only when both hold:
- 30 minutes have passed since the last lightning;
- it has been no more than a sprinkle (< 1 mm/h) for 15 minutes.

Then the grounds crew needs 15 minutes plus 1 minute per millimetre that fell during the delay (at most 40). Rain during that prep resets it.

*Before first pitch*:
- 3 hours and 90 minutes out, the club reads the forecast run the GM sees at that hour. It postpones only when **both** hold:
  - that run shows no game (no first pitch, or a game called before it's official);
  - the GM-visible chance of rain for the game is high: 80% at 3 hours, 70% at 90 minutes. A club doesn't call off a 30% chance; the first trial had three of those, now none.
- The field: 3 inches or more of rain in the 6 hours before, or 4 mm or more of melted snow in the 12 hours before, postpones it at 90 minutes ("field" calls). 1.5 inches or more means 30 minutes of field work before a late start.

*During a delay*:
- every 30 minutes the crew reads the current run and calls it if it shows no restart;
- hard limits:
  - no first pitch within 3 hours of the scheduled time → postponed;
  - a 2½-hour delay once under way → called;
  - no start or restart after 1 AM local.

*Playing minutes.* The plan runs in playing minutes 0…180. SimEngine lays its plays over 3 hours, and `playClock(plan, min)` turns a playing minute into the clock time, delays included. Official at about 100 playing minutes is only a provisional marker. Whether a called game is **official or suspended** depends on the actual innings at the stop, which the sim decides in 4b.

**Plan shape:**
- `outcome`: played / postponed / called;
- `decidedAt`;
- `calledBy`: forecast / limit / curfew / field;
- `reason`: lightning / rain / snow / wet field;
- `startAt`;
- `delays[{startT, endT, atPlayMin, reason, mm}]`: a delay at 0 before `startAt` is a delayed start;
- `endT`;
- `stopAtPlayMin`.

Helpers are `playClock` and `delayAt`.

**Trial** (one seed, 930 games per region; tuning comes in 4e):

| Region | Postponed | Delayed | Called |
|---|---|---|---|
| North, South, East | about 1% | about 7% (average delay about 90 min) | 0.2–0.8% |
| West | 0.4% | 2.7% | 0.5% |

MLB is roughly 1–2% postponed.

Every pre-game forecast postponement fell on a 90–100% chance on the GM's forecast, and rain did fall.

**Cost:** about 12 ms per game in Node, most of it in the shared storm machinery. That is fine computed once per game, spread over ticks.

**Harness:** `check-weather.mjs` "Game weather" checks:
- one-look reads match the radar exactly;
- plans hang together;
- the park report agrees with the plan at every 5-minute playing moment, and at each delay start;
- play never resumes within 30 minutes of lightning;
- forecast calls match the GM-visible chance;
- field calls follow real rainfall;
- per-region rate bands, with the west the driest;
- determinism from a separate copy of the code;
- speed.

### 102.2 4b — the sim plays through the weather (r107)

`SimEngine.generatePlays(game, …, { …, weather: { plan, conditions } })`. The plan comes from `GameWeather.gameWeatherPlan` and the park report through the game from `GameWeather.gameConditions`. Without `weather` the sim behaves as before, apart from the new pacing below. **4c passes it in for every game**, ours and the league's.

**Pacing (all games).** A game's clock now follows its progress rather than spreading every play evenly over three hours:
- ten playing minutes per half-inning, spread by outs;
- nine innings take about three hours; a walk-off or a skipped bottom of the 9th ends sooner; extra innings run long;
- a median game is about 170 minutes;
- every play carries `_playMin`;
- the old per-play jitter is gone, and so is the reliance on `_tickOffset` (4c removes the legacy delay helpers).

**Delays happen in the game.** Before each plate appearance, the sim checks whether the game has reached the plan's next delay. Its estimate of playing minutes is ten per half plus a third of that per out. If it has, it inserts two plays:
- `weather_delay` — "The rain picks up — the tarp is coming out." / "Lightning in the area — the players head off the field." / snow;
- `weather_resume` — "Play resumes after a 1 hr 18 min rain delay."

Both sit on the clock at exactly the plan's moments. Everything before a delay happens before it, and everything after is pushed back by its length.

A delayed start shows its delay first, at the scheduled time; first pitch follows ("After a 47-minute delay, X takes the mound."). Delays the plan has after the game is already over never happen.

**Long delays.** After a delay of 45 minutes or more (`ARM_COOL_MIN`), neither pitcher goes back out. The pitcher on the mound is replaced right there, mid-inning ("After the delay: pitching change, X enters"). The other club's pitcher is replaced when that club next takes the field. The manager's "one more inning from a taxed pen" exception doesn't apply.

**Called games** (MLB rules; the game's `ruling`):
- Official after 5 innings, or 4½ with the home team ahead. Before that it's **suspended**.
- Official and called in an unfinished inning:
  - visitors tied it or went ahead in that inning and the home team hasn't answered → suspended;
  - home team went ahead in its own half → the score stands;
  - otherwise the score goes back to the end of the last complete inning; a tie there → suspended.
- Spring and All-Star games simply end. Postseason games are never shortened: always suspended.
- A reverted inning's plays stay in the play-by-play, marked `_reverted`. Once the game is over they carry nothing into the box, the stats or the W/L decisions.
- `game_end` reads "Final — called (rain) in the 6th; the score goes back to the end of the 5th" and sits at the moment of the call.
- In a game of 5 innings or fewer, a starter needs 4 innings, not 5, for the win (official scoring 9.17(b)).

**Suspended games.** The sim plays the rest of the game straight away, picking up at the exact inning, outs and runners. Both clubs start the resumption with fresh pitchers, and lineups are as they stood at the suspension.
- `plays` ends with a `game_suspended` play at the call ("Suspended (rain) in the top of the 7th — to be completed later");
- `resumePlays` holds the rest, with no clock yet (`_resumeMin` instead);
- 4c sets the clock when the game resumes, and commits stats then.

**Weather in every at-bat** (`SIM_WEATHER_ENV`). Per half-inning, from the park report nearest its middle:
- home run share: +0.7% per °F above 72, +1.8% per mph of wind blowing out beyond 5 (minus when it blows in), clamped 0.6–1.5;
- hit rate: slightly up in heat and wind blowing out, down 0.4% per mm/h while playing through rain;
- walks: up to +20% in rain, +4% below 45 °F;
- a typical night (72 °F, 5 mph out) changes nothing;
- the legacy `scoringMod` and the field condition's temperature term are skipped when the park report drives the weather.

Measured over 120 games each:

| Conditions | HR a game | Runs a game |
|---|---|---|
| 92 °F, wind 16 mph out | 3.65 | 9.6 |
| Typical night | 2.13 | 7.6 |
| 46 °F, wind 12 mph in | 1.54 | 6.6 |

**Wind fix (step 1).** While building this, the park wind turned out to blow out at about 90% of evening games: its direction barely varied, and evening speeds ran high (median 11–14 mph). `WeatherConditions.windAt` now has:
- a wider day-to-day swing;
- an easterly spell (a high passing to the north) settling in a day or two at a time;
- evening speeds nearer real ballparks.

Result: in about 20% of games, out about 70% (parks face east-north-east, the prevailing wind is from the south-west), medians 9–12 mph. The existing wind checks still pass: 73% from south round to north-west, north-west behind fronts.

**Output:** `generatePlays` returns `{ plays, boxScore, liveLineups, resumePlays, weather }`, where `weather` is `{ startAt, delays [with inning / half / outs], ruling, conditions }`.

**Harness:** `tools/harness/check-game-sim-weather.mjs [region]`, 18 checks:
- pacing;
- a mid-game delay on the exact clock, with nothing played during it;
- long delays changing both pitchers (20 of 20);
- a delayed start;
- 160 called games ruled correctly, with the box equal to the final and suspended games resuming at the exact spot;
- spring and postseason;
- the ball in hot, cold and rain;
- real plans across a season with no play during a delay, in lightning or in a downpour.

All four regions pass. `check-weather` passes 116/116. `sim-season` passes on seeds 1, 2, 4, 5 and 7. Seed 3 had one CPU club at 31 wins, just under the band's floor of 33. The changed end-of-game times reshuffle the random path, and this was a tail outcome: other seeds' weakest clubs won 43–50, and no at-bat changes without a plan.

### 102.3 4c — the schedule reacts to the weather (r108) — **fresh team required**

Every game, ours and the league's, now goes through the weather the same way. Everything here is driven by each game's plan (`GameWeather`), so what happens is always what the radar and the forecasts showed.

**Plans on the games.** `GameEngine._ensureWeatherPlans` gives every game starting within `PLAN_AHEAD_MIN` (4 h) of the clock its plan, `g.wx`. It runs on each step of the league clock.
- A plan is worked out again only if the game moved (new time or park).
- A suspended game due to pick up gets the plan for its resumption (`GameWeather.resumptionPlan`).
- The All-Star Game uses the host's park.

**At first pitch** (`_wxAtFirstPitch`): the plan, the park report through the game (`gameConditions`) and the record (`gameRecord`) go to the sim.
- The game keeps `weather` (label, icon, °F, humidity, wind and how it plays at the park), replacing the old fixed "Clear".
- It also keeps `fieldCondition` (infield softness and mound from the rain in the 12 hours before; feeds SimEngine's field modifier), `wx` (its plan) and `wxResult` (the sim's delays and ruling).

**Postponements** (`_postponeGame`, at the plan's decision time):
- *Spring:* cancelled, not made up (as in the majors). Ours closes through `commitGame`: result `'postponed'`; nobody's rotation turn or absence counts down. The league's is marked played.
- *Regular season:* moved by `WeatherSchedule.findMakeupSlot`:
  1. a doubleheader later in the same series;
  2. a day both clubs are off within 14 days (a night game at the original park);
  3. a doubleheader the next time they meet (at that day's park, `venueId`; the original home club stays home);
  4. a day added after the regular season.
- *Doubleheaders:* day–night (the makeup at 1:05 before a night game), or before a day game that game moves 4 h later. Game two always waits for game one to end plus 30 minutes, if a delay runs long (`_wxHoldForClubs`).
- *Playoffs and the All-Star Game:* back a day, and the rest of the series with them.
- *Record kept:* the game keeps `postponements[]` (original date and time, when decided, reason, by forecast or field) and `makeup.how`. The Recent list gets a line: "DET at TST postponed (rain) — makeup Jul 14 (doubleheader)".

**When it's decided.** The league clock holds at our first pitch (§65), so:
- our pre-game postponements run on the league clock (`_userWeatherEvents`);
- a postponement called during a delayed start, a suspension (when its last play is revealed) and a suspended game's turn run in `tick()`.

A start the weather is holding up shows status `DELAYED` until it starts or is called off.

**Suspensions** (`_suspendGame`):
- the game stands as it was (plays, score, `suspension` = where and why) and moves to a slot found like a makeup (playoffs: the next day);
- at its turn (`_resumeGame`), its resumption has its own weather. If that rains out or would stop it again before the rest is played, it waits for another day;
- otherwise `SimEngine.resumeTimeline` puts the rest on that day's clock ("The suspended game picks up where it stopped: top of the 7th, 2 out.", with that day's delays) and it's live again;
- stats, records and arms count once, at the final.

**Our schedule stays in playing order.** Unplayed games are kept sorted by first pitch (`_wxSortSchedule`). Indexes, `regularSeasonIndex`, deadline-window and stretch-run flags are renewed for unplayed games, so everything keyed on "the Nth game" follows the games actually played.

**Retired:**
- `WeatherEngine.js` (the old probability design; never wired);
- `SeasonEngine.scheduleMakeupGame`;
- `GameEngine.applyWeatherDelay` / `suspendGame` / `resumeSuspendedGame`;
- `_tickOffset` (delays are on the plays' own clock now);
- the hardcoded weather / field defaults in `_makeGameObject` (now null until first pitch).

**Fixes found on the way:**
- a pitcher brought in as his side took the field, just before a stoppage that ends the day, never threw a pitch, so the change is undone;
- a pitcher who hasn't faced a batter isn't forced out by a long delay;
- this removed "phantom" relief appearances.

**Harness** (`sim-season.js`, now `REGION=…` for any region):
- weather-aware per-game checks (an official called game can be shorter than nine and its reverted runs don't count);
- the All-Star break check allows rainouts made up after the break;
- cancelled spring games close like games;
- a season block (`checkWeatherSeason`):
  - every regular game played exactly once, rainouts made up;
  - no club ever in two games at once;
  - suspended games finished after they stopped;
  - every game keeps its weather;
  - believable rates.

Seed 1 (north), full league season:
- 660 regular games; 7 postponed (1.1%: 5 in the same series, 1 at the next meeting, 1 on an off day);
- 4 spring games cancelled;
- 30 delayed, 2 suspended and finished;
- 8 doubleheaders;
- 3,621 / 3,621 checks.

Other seeds and regions, full league seasons (all checks pass):

| Seed | Region | Postponed | Delayed | Called official | Suspended | Doubleheaders | Spring games cancelled | Checks |
|---|---|---|---|---|---|---|---|---|
| 2 | South | 9 (1.4%) | 69 | 4 | 5 | 9 | — | 3,619 |
| 3 | East | 4 (0.6%) | 53 | 2 | 2 | 4 | 7 | 3,610 |
| 4 | West | 6 (0.9%) | 30 | 2 | 1 | 5 | 0 | 3,619 |

The dashboard UI test passes with no page errors. Showing these states on screen (delay view, PPD / SUSP labels, makeup rows, weather cards) is **4d**.

### 102.4 4d — the weather on screen and in the inbox

4d is split in two:
- **4d-1** puts the weather on screen (r109);
- **4d-2** adds weather inbox cards that are real decisions (next).

#### 4d-1 — on screen (r109)

**One source:** `ui/components/WeatherStatus.js` (read-only, text not icons). It is used by the dashboard, the league game viewer and the schedule.
- `wxState(game, revealed)` gives the weather's hold on a game right now, read off the plays revealed so far:
  - **delay**: its delay play is the last revealed;
  - **start-delay**: the status says `DELAYED` before any plays, or a pre-start delay play is the last revealed;
  - **suspended**: the last revealed play is `game_suspended`;
  - **called**: an official game called short.

  Each comes with a title, a sentence and a status pill.
- `weatherLine(game)`: "72° Partly Cloudy · Wind 8 mph out to right".
- `gameNotes(game, siblings)` gives the schedule's notes:
  - "Makeup of Apr 12 (rain)"
  - "Game 1 of 2"
  - "Suspended Apr 12 in the top of the 7th — picks up Apr 14 1:05 PM" / "…, finished Apr 14"
  - "Rain delay, 1 hr 05 min" / "2 delays, …" / "Delayed start, …"
  - "Called after 6 innings (rain)"
  - "Postponed (rain) — spring games aren't made up"
- `calledInnings`, `postponedOn(games, date)`, plus labels.

**Dashboard:**
- **Live card:**
  - the status pill reads RAIN DELAY / LIGHTNING DELAY / SNOW DELAY / START DELAYED / SUSPENDED;
  - under the linescore, a banner gives the delay name with a running clock ("Rain delay · 30 min") and what happened ("The rain picks up — the tarp is coming out."), with the **radar on the ballpark** right under it while the weather holds the game;
  - a called game shows why it ended;
  - otherwise a quiet line with the weather it's played in.
- **Play-by-play:** weather lines in orange.
- **Next-game card:** notes for makeups, doubleheaders and a suspended game picking up.
- **Countdown card:** for a start the weather is holding up, it becomes "START DELAYED · 25 min — Waiting on the weather".
- **The 5-second pulse:** the dashboard's league-row timer also moves the delay clocks, and redraws when our next game's status, time or opponent changes without a play (a start held up, a postponement, a suspended game's turn).

**League games** (`LiveGame.js`):
- the mini cards show DELAY in place of the inning;
- the viewer has a weather pill and a line (the hold, with how long so far; or the weather played in, plus the schedule's notes), and weather lines in its play-by-play.

**Schedule:**
- each row has the weather it was played in and the weather notes;
- results: SUSP for a suspended game, "W 4–2 (6)" for an official game called short, PPD for cancelled spring games;
- the DH badge comes from the dates;
- **Scores:** both games of a doubleheader; DELAY / SUSP / F/6 pills; and, on the date a game was rained off, a PPD row saying where it went ("rain · made up Apr 14" / "not made up").

**Radar:** `RadarSheet.venueOf` respects `venueId` (a makeup at the other club's park).

**Harness:** `tools/harness/test-weather-ui.mjs outDir [theme]`, in the real app with a new team. Our next game is given a plan for each situation in turn:
- a rain delay in progress (pill, banner and clock, radar, play-by-play, the clock running);
- a start held up, then called off ("Start delayed", the dashboard moving on, the schedule's note, that date's scoreboard PPD row);
- a called game (the ruling, the schedule's innings and note).

14 / 14 pass in dark and light, with no page errors. The existing dashboard radar test still passes.

#### 102.5 4d-2 — weather decisions in the inbox (r110)

Every weather card is a real decision about **who pitches**, made on the forecast the GM can see, with a real effect. The weather's other news (postponements, makeups, suspensions) goes on the Recent list, not the inbox.

**"Rain likely tonight — start X?"** (`wx_rain_start`)
- *When:* three hours before each of our regular-season and postseason games (`START_CARD_LEAD_MIN`), the manager reads the GM's own forecast (`chanceOfPrecip` for the game window, run made then). He asks if the chance is at least `START_CARD_CHANCE` (60%) and there's a rested alternative in the rotation.
- *The card says:* the chance, the first pitch, and the rule — a delay of 45 minutes or more (`ARM_COOL_MIN`) ends the night of the pitcher on the mound, spending his turn.
- *Hold X, start Y:* tonight's rotation spot goes to Y and the next to X; everyone else keeps their order (`wx_hold_starter`).
- *Start X:* nothing changes.
- *Timing:* expires 30 minutes before first pitch, defaulting to "Start X". It's withdrawn if the game is called off first, and isn't asked at all if the club calls it off at the 3-hour look.

**"Doubleheader — who starts game two?"** (`wx_doubleheader`)
- *When:* a rainout makes one of our days a doubleheader (a makeup slot of either doubleheader kind).
- *Bullpen game:* the long man opens (`bullpenRoles(...).long[0]`) and the pen covers. Game two carries `userStarterId` (SimEngine starts him) and `keepRotation` (the commit doesn't turn the rotation), so the rotation stays on schedule (`wx_bullpen_game`).
- *Next man in turn:* every starter's turn comes a day sooner.
- *Timing:* expires an hour before game one, defaulting to the next man. Withdrawn if the doubleheader is undone.

**Engine:**
- `SimEngine.rotationStarter` (exported: the sim's own choice) and `game.userStarterId`;
- `commitGame` respects `keepRotation`;
- `GameEngine._wxUserCards` (on the clock), `_wxDoubleheaderCard`;
- `CardEngine.deliverRainStartCard` / `deliverDoubleheaderCard` / `withdrawWeatherCards`, and `wx_` actions.

**Harness:**
- `tools/harness/check-weather-cards.mjs`, 11 checks in a real league:
  - holding the starter puts the alternate on the mound tonight and the held man next game;
  - "start him" changes nothing;
  - the bullpen game's long man starts game two and the rotation doesn't turn;
  - the asking rate (4 of 60 games at 60%+);
- `sim-season`: the weather cards are asked and none are left hanging.
- North, seed 2: asked twice; 3,620 / 3,620 checks.

### 102.6 4e — season checks and tuning (r111)

**Benchmarks** (real MLB home-park weather postponements, 2015 – mid-2025, about nine seasons; sources below):

| Park | Postponements | Per season | Share of home games |
|---|---|---|---|
| Cleveland | 35 | about 3.9 | about 4.8% |
| Detroit | 33 | | |
| Washington | 30 | | |
| Mets | 29 | | |
| White Sox | 28 | | |
| Baltimore | 26 | | |
| Cubs / St. Louis | 21 each | | |
| Atlanta | 18 | about 2 | about 2.5% |
| Philadelphia | 18 | | |
| Dodger Stadium | 0 | | |

League-wide: about 22 by June in a typical season; 28 through April in the record 2018.

Targets by region (each modelled on real cities; the West is high-desert Front Range, Denver-like with spring snow):

| Region | Modelled on | Target postponed |
|---|---|---|
| North | Chicago | about 3% |
| East | Philadelphia / Washington | 3–3.5% |
| South | Atlanta / Gulf | about 2% |
| West | Denver-like | 1–2% |

**Tuning — a wet evening is called off ahead** (`GameWeather._steadyRain`). The club's 3-hour and 90-minute forecast looks now also postpone when the forecast run shows steady rain (`STEADY_RATE_MMH` 0.5 mm/h or more) through `STEADY_SHARE` (half) of the game's three hours — not only when it shows no game possible. Both still require the GM-visible chance `PREGAME_CALL_CHANCE` (70% at 3 h, 60% at 90 min, was 80 / 70). False alarms (called ahead, then the window stayed dry): 4 of 82 (5%), mostly southern pop-up-storm days; the median called-off game saw 0.2–0.3 in.

**Rates** (`tools/harness/weather-season-rates.mjs`, plans only, 3 seeds × about 900 games a region):

| Region | Before (postponed) | After (postponed) | Delayed | Called short |
|---|---|---|---|---|
| North | 0.9% | 3.0% (April 3%+, with snow) | 4.0% | 0.1% |
| South | 1.3% | 2.7% | 8.0% | 0.9% |
| East | 0.8% | 2.7% | 5.1% | 0.4% |
| West | 0.5% | 1.3% | 2.5% | 0.0% |

- Median delay 75–85 min, 90th percentile about 2 h.
- The starter question comes up in 2–5% of our games.

**Fixes found in the season runs:**
- Doubleheader card wording used "next man / long man" (the neutral-text check caught it; now "next starter / long reliever"), and it named a weekday from the real calendar next to a baseball-calendar date (now the baseball date only).
- Harness: cancelled spring games close without a score or box (per-game checks and the spring-record check now count them right); the "asked at least once" weather-card check removed (a dry season can ask none — the rate is in the rates tool).

**Full league seasons after tuning** (all checks pass):

| Seed | Region | Postponed | Doubleheaders | Weather questions (starter / doubleheader) | Checks |
|---|---|---|---|---|---|
| 9 | North | 2.9% | 12 | 4 / 2 | 3,620 |
| 10 | South | 1.5% | 12 | 2 / 0 | 3,615 |
| 11 | East | 3.5% | 19 | 1 / 2 | 3,587 |
| 12 | West | 1.8% | 6 | 2 / 0 | 3,609 |

- North had one makeup on a day added after the season; the All-Star break check excepted two clubs' rainouts made up after it.
- Every rainout was made up; no club was ever in two games at once; every suspended game was finished.

**Open (not weather):** in two of eleven post-weather seasons a CPU club finished at 31–32 wins, just under the harness floor of 33.
- In south seed 5 (`BAL_DUMP`) the club's rotation averaged 55 OVR against a league 63: a CPU club not replacing weak starters (roster management, §90).
- The weather hits every club alike; it reshuffles which seasons show the tail. Left as a follow-up.

**Sources:** Matt Lanza, "Get a roof" (mattlanza.substack.com/p/get-a-roof); weather.com, "MLB postponements break April record" (2018-04-23).

**Step 4 is complete.** Next in the §100 plan: **step 3 — forecast surfaces:**
- the dashboard's next-game forecast;
- the 10-day forecast view;
- the schedule's forecasts.

## 103. Step 3 — forecast surfaces (sub-steps)

GM asked to continue after step 4. Step 3 sub-steps:

| Sub-step | What |
|---|---|
| **3a** | The next game's forecast on the dashboard, and the forecast sheet (r112) |
| 3b | The 10-day outlook in the forecast sheet |
| 3c | Forecasts on the schedule (upcoming games within 10 days) |
| 3d | Consistency and speed checks across every forecast surface |

### 103.1 3a — the next game's forecast (r112)

**One forecast per game.** `WeatherForecast.gameForecast(ctx, now, x, y, gameTime, bearing)`, wrapped by `GameWeather.forecastForGame(ctx, now, game)` (the game's park — a makeup moved to the other park is forecast there). Every screen shows this:
- the chance of measurable rain in the game's three hours (`chanceOfPrecip`, the same window the manager's starter question reads);
- the kind;
- a label: "Storms likely" / "Chance of showers" / "Slight chance of storms" / the sky;
- the first game hour with a real chance (≥ 30%), for "after 8 PM";
- the temperature, wind and how it plays at the park at first pitch (the temperature drawn toward the normal at that hour past a day out, as the outlook's highs are);
- the game's own hours from first pitch, each with its own chance, within two days (the first hour is the headline).

All from the hourly run made in now's hour, cached per run.

`dailyForecast` is now built from `dailyForecastDay(…, d)` (one day at a time, each cached), so screens can fill the outlook in as it comes. The numbers are unchanged; `check-weather` passes 116 / 116.

**Off the main thread.** `ui/components/forecast-worker.js` (a module worker; the same pure functions) and `ForecastSource.js`:
- `gameForecastFor`, `outlookFor` (day by day), `hourlyFor`, `peekGameForecast`;
- answers cached per forecast hour and shared by every screen;
- a main-thread fallback in slices.

Costs on a desktop: a game about 25–100 ms; the 10-day about 0.85 s. A phone is about 4× that, hence the worker.

**Dashboard.**
- The next-game card has one forecast line under the time: "40° · Chance of showers 40%" / "74° · Storms likely 70% · after 8 PM". It's tappable; blue text; only for a game not yet started.
- It's drawn at once if this hour's forecast is already worked out, otherwise "Forecast…" and filled in about 0.3–0.4 s later (phone speed included).
- It's redrawn when the next hourly forecast comes out (the 5-second pulse).
- The radar card gives up the room, so the idle dashboard still doesn't scroll.

**Forecast sheet** (`ForecastSheet.js`):
- the game: matchup, date and time, the headline temperature and label, "N% chance of rain during the game", the wind at first pitch, and the game's hours (temperature and chance; wet hours highlighted);
- a note on when the forecast was made and that it's updated hourly.

**Harness:** `tools/harness/test-forecast-ui.mjs outDir [theme] [throttle]`, in the real app with a new team:
- the line fills in and is exactly the engine's forecast for that game, worked out directly on the page;
- the idle dashboard doesn't scroll;
- the sheet shows the same numbers, its first hour the headline;
- no page errors.

Passes in dark, and in light at 4× CPU throttle.

### 103.2 3b — the 10-day outlook (r113)

**In the forecast sheet**, under the game:
- the 10-day forecast at the game's park, with a switch between our park and the game's when they differ;
- one row a day: "Today" / "Tomorrow" (with the date) / the baseball calendar's date — no weekday names, which would come from the real calendar; the words; the chance (blue at 30%+); the high and low;
- rows fill in day by day as the worker finishes each;
- under each day, our games at that park with their forecast line (the dashboard's exact line); our games at another park that day link to that park's outlook.

**Nested windows never contradict each other** (found in the first screenshot: "Mostly Sunny, 20%" on a day whose afternoon game said "Chance of showers 40%"). Each window's chance is calibrated against the climate of a window that long. A short window that's wetter than normal is sharpened more than the whole day around it, so nested windows can come out in the wrong order. Where nested windows are shown together, the larger is never lower:
- `gameForecast`: the game's three hours are at least each hour's chance. The hour strip is exactly the game's three hours, from first pitch.
- `WeatherForecast.withinDay(day, windows)`: a day shown beside our games there is at least as likely to rain as each of them, and its words follow (the day keeps `_words` — kind, timing, sky — for this).
- The manager's starter question now reads `forecastForGame` too, the same number the dashboard and the schedule show at that hour.

**Harness** (`test-forecast-ui`), now also checks:
- the 10-day fills in with the engine's numbers, day for day;
- no shown day is less likely than a game in it, and no game less likely than an hour of it;
- our game sits under its day with the dashboard's line;
- the park switch.

All pass (dark; light at 4× throttle). The outlook fills in about 0.6–0.8 s after opening.
