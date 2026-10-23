/**
 * data/card-tokens.js
 * Content for card {tokens} that are not derived from game state (§60).
 *
 * Each list is a pool of interchangeable phrases; engine/CardTokens.js picks one
 * per card instance (stable across that card's subject, body and messages).
 * Phrases are written to drop into the exact sentence the card uses — read the
 * card text in data/cards-pool.js before editing a list.
 *
 * Money ranges are in $K, the same unit as CARD_COST_* in constants.js. A card's
 * displayed amount and the amount actually charged/credited are the SAME draw.
 *
 * No logic here — data only.
 */

// ─────────────────────────────────────────────────────────────
// MONEY RANGES ($K)
// ─────────────────────────────────────────────────────────────

export const CARD_TOKEN_MONEY = Object.freeze({
  rev_amount:       { min: 100, max: 400 },  // sponsorships, naming rights, media access
  camp_cost:        { min:  20, max:  45 },
  camp_revenue:     { min:  35, max:  90 },
  pipe_repair_cost: { min:  15, max:  40 },
  captain_bonus:    { min:  25, max:  60 },
});

// Broadcast renewal: full market value = rev_amount × this range
export const BROADCAST_MARKET_MULTIPLIER = Object.freeze({ min: 1.25, max: 1.6 });

// ─────────────────────────────────────────────────────────────
// PHRASE POOLS
// ─────────────────────────────────────────────────────────────

export const CARD_TOKEN_POOLS = Object.freeze({

  // ── Spring training ─────────────────────────────────────────
  sp2_items: [
    'a leaking shower bank, worn turf in the cage, and lockers that no longer close',
    'failing HVAC in the weight room and a training-table backlog',
    'cracked tile in the showers, dead lighting in the video room, and a broken ice machine',
    'outdated laundry equipment and a batting cage net that is coming apart',
  ],
  sp5_areas: [
    'two gates with failing badge readers and a camera blind spot by the bullpen',
    'outdated crowd-flow signage on the upper concourse and a weak perimeter fence section',
    'an unmonitored service entrance and stale emergency-evacuation drills',
    'parking lot lighting and an overdue radio upgrade for the event staff',
  ],
  sp7_item: [
    'two failing light banks along the first-base line',
    'a flickering bank over left field',
    'aging ballasts in the center-field towers',
    'uneven light levels in the outfield corners',
  ],
  sp8_context: [
    'the travel budget is already stretched this spring',
    'the CFO wants to see spring costs held flat',
    'several veterans have asked for the charter after last year',
    'the commercial itineraries include two early-morning connections',
  ],
  sp9_pitch: [
    'open workouts, player autographs, and a family zone on the back fields',
    'local TV and radio on site plus a fan Q&A with the coaching staff',
    'a social-media day with player takeovers and a behind-the-scenes tour',
    'an open-house morning for season-ticket holders and youth teams',
  ],

  // ── Between games / travel ──────────────────────────────────
  bg2_player_note: [
    'A couple of the younger guys took the last loss personally.',
    'The veterans are fine. A few of the bench guys are restless about playing time.',
    'There was some grumbling at the back of the plane about the schedule.',
    'Everyone is tired more than anything — it has been a long stretch.',
  ],
  bg7_items: [
    'a re-grade of the bullpen mounds and new padding on the outfield wall',
    'the clubhouse HVAC service and a refresh of the training room',
    'repairs to the tunnel lighting and the visiting dugout bench',
    'drainage work behind home plate and a new tarp',
  ],
  bg8_context: [
    'short tempers in the clubhouse and guys skipping the team breakfast',
    'a lot of headphones on and not much conversation',
    'a couple of sharp words after the last loss',
    'late nights and sluggish early work',
  ],
  bg11_move_description: [
    'they acquired a front-line starter for two prospects',
    'they signed a veteran slugger to a two-year deal',
    'they fired their manager and promoted the bench coach',
    'they traded their closer for a young everyday shortstop',
    'they called up their top prospect and put him straight into the lineup',
  ],
  bg11_relevance: [
    'we play them in a series soon',
    'they are a direct competitor in our division',
    'it changes the trade market for the players we have been watching',
    'it raises the price of every similar player on the market',
  ],
  bg11_implication: [
    'our own deadline plans',
    'how aggressive we want to be this month',
    'the next time we talk to their front office',
    'how we line up our rotation against them',
  ],
  bg12_observation: [
    'his front shoulder is flying open early',
    'he is a tick late on velocity up in the zone',
    'his load has gotten deeper and slower',
    'he is chasing more breaking balls away than he was a month ago',
  ],

  // ── Staff and people ────────────────────────────────────────
  coach_background: [
    'a former big-league hitting coordinator with two playoff clubs',
    'fifteen years in player development, most recently running a top farm system',
    'a former All-Star who has coached in the minors for a decade',
    'an analytics-first coach who rebuilt a struggling offense last year',
  ],
  bp_catcher_background: [
    'a former minor-league catcher with a reputation for reading relievers',
    'twelve years catching bullpens for a perennial contender',
    'a respected veteran who called games in Triple-A for eight seasons',
  ],
  captain_or_leader_note: [
    '',
    ' The veterans are on board, which helps.',
    ' A couple of clubhouse leaders volunteered to organise it.',
  ],
  d3_reason: [
    'overslept after a late night',
    'had a family issue and did not call ahead',
    'went to the wrong airport terminal and missed boarding',
    'misread the travel itinerary',
  ],
  owner_request: [
    'a meeting to review every veteran contract',
    'two concrete moves before the end of the month',
    'a revised timeline for contention',
    'a plan to bring in a recognisable name',
  ],
  sr1_tone: [
    'The fan base can feel it too',
    'The clubhouse believes it',
    'Ticket sales have noticed',
    'The league office has noticed as well',
  ],
  dl2_rationale: [
    'two of our veterans are on expiring deals and are playing at their peak value',
    'the bullpen has surplus arms that contenders are asking about',
    'our playoff odds have slipped and buyers are paying premium prices',
    'we have redundancy at the corners and a hole up the middle',
  ],
  ls1_concern: [
    'cumulative workload on the everyday players',
    'early signs of fatigue in the starting rotation',
    'rising soft-tissue risk across the lineup',
    'recovery times that are getting longer week to week',
  ],

  // ── Business, media and community ───────────────────────────
  tv_network: [
    'Pinnacle Sports Network', 'Northstar Media', 'Diamond Vision Films', 'Regional Sports One',
  ],
  media_outlet: [
    'The Sporting Ledger', 'Fieldhouse Magazine', 'The Dugout Review', 'Baseball Weekly',
  ],
  facility_area: [
    'home clubhouse', 'weight room', 'training room', 'batting cages', 'player lounge',
  ],
  grievance_type: [
    'a wrongful termination claim', 'a workplace harassment complaint',
    'an unpaid overtime claim', 'a discrimination complaint',
  ],
  hotel_issue: [
    'a double-booked block of rooms', 'a cancelled reservation after a hotel sale',
    'a water-damage closure at their hotel', 'a convention that swallowed their room block',
  ],
  outing_activity: [
    'golf day', 'bowling night', 'fishing charter', 'team dinner and escape room',
  ],
  payroll_reason: [
    'a decimal error in the per-diem table', 'a duplicate bonus payment in the system',
    'an outdated tax withholding setting', 'a timing error on incentive payouts',
  ],
  ms6_reason: [
    'a jersey design that did not catch on', 'over-ordering ahead of a slow start',
    'a player traded right after his jersey restock', 'a weather-hit summer of attendance',
  ],
  ms8_era: [
    'the franchise’s first decade', 'the club’s last championship run',
    'the old ballpark years', 'the franchise’s original uniforms',
  ],
  legend_era: [
    'the franchise’s first pennant team', 'the club’s championship years',
    'the old ballpark era', 'the early expansion years',
  ],
  corp_event_name: [
    'Vantage Financial Group', 'Helix Pharmaceuticals', 'Crestline Energy', 'Apex Digital',
  ],
  corp_event_type: [
    'a company-wide celebration', 'a product launch event', 'an employee family day', 'a client hospitality night',
  ],
  corp_controversy: [
    'a recent layoff controversy', 'a regulatory investigation', 'an environmental lawsuit', 'a data-privacy scandal',
  ],
  road_event_type: [
    'an outdoor concert', 'a festival weekend', 'a live TV broadcast event', 'a fireworks show',
  ],
  road_event_promoter: [
    'A regional concert promoter', 'A national festival company', 'A live-events producer',
  ],
  road_booked_event: [
    'a high school championship game', 'a charity softball game', 'a youth jamboree', 'a community movie night',
  ],
  tournament_org: [
    'a regional youth baseball tournament', 'a travel-ball championship', 'a Little League sectional',
  ],
  university_name: [
    'State University', 'the regional college conference', 'the local university',
  ],
  university_game: [
    'its rivalry game', 'a conference championship game', 'its season opener',
  ],
  transport_mode: [
    'team bus', 'charter flight', 'equipment truck',
  ],
  transport_issue: [
    'broke down', 'was grounded with a mechanical issue', 'was cancelled at the last minute',
  ],

  // Name pool for one-off people (attendant, legends, outside coaches). Kept
  // separate from STAFF_NAMES so they never collide with the coaching staff.
  person_name: [
    'Marty Delgado', 'Jim Kowalczyk', 'Bobby Ruiz', 'Ernie Watts', 'Sam Okafor',
    'Leo Brennan', 'Charlie Haddad', 'Tom Fitzgerald', 'Mike Varga', 'Dan Lindqvist',
    'Rich Moreau', 'Steve Tanaka',
  ],
});
