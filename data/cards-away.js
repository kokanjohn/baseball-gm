/**
 * data/cards-away.js
 * r217 §122.96 Off days and road trips (message plan, release 4).
 *
 *   OFFDAY_POOL     the off day's messages (CardEngine's 'offday' moment: the first whole day with no game before
 *                   the next one, 9am–7pm) — a player's request, an early workout, a bullpen session, a community
 *                   visit, a scouting trip, another club's GM, the trainer's rest day; and the day's news.
 *   ROAD_POOL       the road's messages (the 'road' moment, when our next game is away): how the park plays, the
 *                   local media, a player's hometown, the hotel, a long trip; and the ballpark's bookings while
 *                   we're away (`_parkEvent`, one per road trip) — a festival, a high school championship, a film
 *                   shoot, a charity run, fireworks, a wedding, and the older ones (rv1–rv4).
 *   AWAY_FOLLOWUPS  how a booking went, the morning of our first home game back (CardActions park_event picks one
 *                   of the booking's `_outcomes`): a repair to approve, a bonus, a complaint.
 */

export const OFFDAY_POOL = [

  {id:'od1',autoResolve:'no',_weight:1.0,type:'normal',tag:'CULTURE',sender:'{manager_name} (Manager)',avatar:'📋',
   _minGames:8,_repeat:{gapDays:21,max:2},
   subject:"{pl_player_name} wants to fly home today",
   preview:"{pl_player_name} asked if they could fly home for the off day…",
   body:"{pl_player_name} asked if they could fly home today — family, and they haven't been back since spring. The flight back lands late tonight, so it's tight, and it's {misc_cost_xs} if the club books it. Saying yes buys a lot of goodwill. Saying no keeps everyone in town and on schedule; they'll understand, even if they won't like it.",
   yesLabel:'Book the Flight',noLabel:'Keep Them Here',
   yesEffect:{morale:1},noEffect:{morale:-1},
   yesMsg:"Booked. {pl_player_name} was out the door in ten minutes.",noMsg:"{pl_player_name} is staying in town. They took it well enough.",
   _relYes:{pl_nm:2},_relNo:{pl_nm:-2},_budgetCost:'misc_cost_xs'},

  {id:'od2',autoResolve:'no',_weight:1.0,type:'normal',tag:'TRAINING',sender:'{hitting_coach_name} (Hitting Coach)',avatar:'🎯',
   _minGames:10,_repeat:{gapDays:18,max:3},
   subject:"An off-day workout for {active_hitter_name}",
   preview:"{active_hitter_name} wants to come in today and hit…",
   body:"{active_hitter_name} ({active_hitter_pos}) wants to come in today and hit. The swing has been a tick late all week, and an hour in the cage on an empty day is the best chance to fix it. It costs them the day off, and a few of the others will feel they should come in too. Or everyone takes the day, and we work on it in batting practice.",
   yesLabel:'Open the Cage',noLabel:'Everyone Rests',
   yesEffect:{morale:-1},noEffect:{morale:1},
   yesMsg:"The cage is open. We'll be there until it clicks.",noMsg:"Everyone rests. We'll get to it in BP.",
   onYes:'offday_session',_trainGain:1},

  {id:'od3',autoResolve:'no',_weight:1.0,type:'normal',tag:'TRAINING',sender:'{pitching_coach_name} (Pitching Coach)',avatar:'⚾',
   _minGames:10,_repeat:{gapDays:18,max:3},
   subject:"A bullpen session for {active_bp_who}",
   preview:"{active_bp_who} has been leaving the breaking ball up…",
   body:"{active_bp_who} ({active_bp_pos}) has been leaving the breaking ball up. I'd like a bullpen session today, with nobody around, to work on the release point. It's a day of rest given up in the middle of the season, and the arm will feel it tomorrow. Or they rest, and we fix it between outings.",
   yesLabel:'Schedule the Session',noLabel:'Let Them Rest',
   yesEffect:{},noEffect:{morale:1},
   yesMsg:"Session set for this afternoon.",noMsg:"Resting. We'll work on it between outings.",
   onYes:'offday_session',_trainGain:1},

  {id:'od4',autoResolve:'no',_weight:0.9,type:'good',tag:'MARKETING',sender:'Community Relations',avatar:'🤝',
   _repeat:{gapDays:15,max:3},
   subject:"A few players for {od_community_event}?",
   preview:"We've been asked to bring a few players to {od_community_event}…",
   body:"We've been asked to bring a few players to {od_community_event} today, with {leader_player_name} leading the group. It's the kind of thing the city remembers, and the players who go always come back glad they did. It's also their one day off, and asking them to give it up has a cost in the clubhouse.",
   yesLabel:'Send a Group',noLabel:'Give Them the Day',
   yesEffect:{atmo:3,morale:-1},noEffect:{},
   yesMsg:"{leader_player_name} has the group together. We'll send pictures.",noMsg:"We passed this time. They'll ask again.",
   _relYes:{ldr_nm:1}},

  {id:'od5',autoResolve:'no',_weight:0.8,type:'normal',tag:'SCOUTING',sender:'Scouting',avatar:'🔭',
   _minGames:20,_oncePerSeason:true,_promise:{yes:{kind:'college_look',when:'fa_opens'}},
   subject:"Come see a player with us today",
   preview:"There's a college game an hour away today…",
   body:"There's a college game an hour away today, and one of the players in it will be in this winter's free-agent class. We'd like you to come with us and see them yourself — the travel and the seats are {misc_cost_xs}. A GM in the stands gets us the coaches' time and a closer look, and we'll know that player better than anyone when the winter comes. Or we send one of ours with a radar gun, and we know what everybody knows.",
   yesLabel:'Go See Them',noLabel:'Send One of Ours',
   yesEffect:{},noEffect:{},
   yesMsg:"We'll pick you up at noon.",noMsg:"One of ours is on the way with a radar gun.",
   _budgetCost:'misc_cost_xs'},

  {id:'od6',autoResolve:'no',_weight:0.8,type:'normal',tag:'TRADE',sender:'{other_gm_name} ({other_gm_club} GM)',avatar:'⛳',
   _minGames:10,_repeat:{gapDays:30,max:2},_aboutOtherGm:true,onYes:'gm_rapport_yes',onNo:'gm_rapport_no',_rapport:{yes:4,no:-1},
   subject:"Golf today?",
   preview:"We both have the day off, and I've got a tee time at ten…",
   body:"We both have the day off, and I've got a tee time at ten. Come play — no business, I promise, though you know how these things go. Fair warning: I take the game more seriously than I should.",
   yesLabel:'Play the Round',noLabel:"Can't Make It",
   yesEffect:{},noEffect:{},
   yesMsg:"Ten o'clock. Bring a lot of balls.",noMsg:"Another time, then.",
   _expiresAfterMs:4*3600000},

  {id:'od7',autoResolve:'no',_weight:0.8,type:'normal',tag:'HEALTH',sender:'Head Trainer',avatar:'🩹',
   _minGames:30,_repeat:{gapDays:20,max:2},
   subject:"A real day of rest",
   preview:"The legs are heavy after the last stretch…",
   body:"The legs are heavy after the last stretch. We'd like the whole team out of the building today — no early work, no treatment unless it's needed — and a later report time tomorrow. Everyone comes back fresher. The coaches would rather keep tomorrow's early work; they think the edge is in the routine.",
   yesLabel:'Full Rest',noLabel:'Usual Schedule',
   yesEffect:{morale:2},noEffect:{ovr:1},
   yesMsg:"Building's closed. Report time is pushed back tomorrow.",noMsg:"Usual schedule tomorrow. Early work as planned."},

  // ── the off day's news ──
  {id:'odn1',autoResolve:'yes',_weight:1.0,type:'normal',tag:'CULTURE',sender:'{manager_name} (Manager)',avatar:'📋',
   _minGames:10,_repeat:{gapDays:12,max:4},_toastOnly:true,
   subject:"A quiet day",
   preview:"A quiet day. The players scattered…",
   body:"A quiet day. {div_race_line} The players scattered — a few went fishing, a few slept, and the cage was empty for once. We go again tomorrow.",
   yesLabel:'Understood',noLabel:'Understood',yesEffect:{},noEffect:{}},

  {id:'odn2',autoResolve:'yes',_weight:0.7,type:'good',tag:'MARKETING',sender:'PR Dept.',avatar:'✉️',
   _repeat:{gapDays:30,max:2},_toastOnly:true,
   subject:"Letters from a third-grade class",
   preview:"A box of letters came in from a school across town…",
   body:"A box of letters came in from a third-grade class across town, most of them for {active_hitter_name}. We've set them out in the clubhouse. A few of the drawings are already taped to lockers.",
   yesLabel:'Understood',noLabel:'Understood',yesEffect:{},noEffect:{}},

  {id:'odn3',autoResolve:'yes',_weight:0.7,type:'normal',tag:'OPERATIONS',sender:'Equipment Mgr.',avatar:'🧢',
   _repeat:{gapDays:20,max:2},_toastOnly:true,
   subject:"An empty building",
   preview:"With the building empty, we got some work done…",
   body:"With the building empty, we used the day to {od_clubhouse_job}. Everything is ready for tomorrow.",
   yesLabel:'Understood',noLabel:'Understood',yesEffect:{},noEffect:{}},
];

export const ROAD_POOL = [

  {id:'rd1',autoResolve:'no',_weight:1.0,type:'normal',tag:'COACHING',sender:'{bench_coach_name} (Bench Coach)',avatar:'💬',
   _requiresAway:true,_repeat:{gapDays:10,max:4},
   subject:"How the park in {road_city} plays",
   preview:"The park in {road_city} plays {park_quirk}…",
   body:"The park in {road_city} plays {park_quirk}. I'd like to shade the lineup to it for the series — a different bat or two at the bottom of the order, the outfield positioned for it. It squeezes a little more out of the series, but a couple of regulars will lose at-bats and notice. Or we play our game and let the park be the park.",
   yesLabel:'Shade the Lineup',noLabel:'Play Our Game',
   yesEffect:{ovr:1,morale:-1},noEffect:{morale:1},
   yesMsg:"Lineup shaded for the park.",noMsg:"Our lineup, our game."},

  {id:'rd2',autoResolve:'no',_weight:0.8,type:'normal',tag:'MARKETING',sender:'PR Dept.',avatar:'📣',
   _requiresRoad:true,_oncePerSeries:true,_repeat:{gapDays:14,max:3},
   subject:"The morning show in {road_city}",
   preview:"The morning show in {road_city} wants {leader_player_name} live…",
   body:"The morning show in {road_city} wants {leader_player_name} live tomorrow. It's good for the club's name around the league, and the hosts are friendly. It's also an early call on a road day, and the manager would rather the players rest.",
   yesLabel:'Book the Interview',noLabel:'Decline Politely',
   yesEffect:{atmo:2,morale:-1},noEffect:{},
   yesMsg:"Booked. A car picks {leader_player_name} up at six.",noMsg:"Declined. They were gracious about it."},

  {id:'rd3',autoResolve:'no',_weight:1.2,type:'good',tag:'CULTURE',sender:'Travel Coordinator',avatar:'✈️',
   _requiresAway:true,_requiresHometown:true,_oncePerSeries:true,_repeat:{gapDays:10,max:3},
   subject:"{hometown_player_name}'s family in {road_city}",
   preview:"{hometown_player_name} grew up near {road_city}…",
   body:"{hometown_player_name} grew up near {road_city}, and about forty family and friends want to come to the series. We can hold a block of seats behind our dugout and set up a visit on the field after batting practice — {misc_cost_xs}. Or we leave them to find their own tickets, which is what most clubs do.",
   yesLabel:'Hold the Seats',noLabel:'Leave It to Them',
   yesEffect:{morale:1},noEffect:{},
   yesMsg:"Seats held, and the field visit is set.",noMsg:"They'll find their own seats.",
   _relYes:{ht_pl:3},_relNo:{ht_pl:-1},_budgetCost:'misc_cost_xs'},

  {id:'rd4',autoResolve:'no',_weight:1.0,type:'normal',tag:'OPERATIONS',sender:'Travel Coordinator',avatar:'✈️',
   _minConsecutiveRoadGames:5,_oncePerRoadTrip:true,_repeat:{gapDays:20,max:3},
   subject:"The trip is wearing on them",
   preview:"We're deep into this trip, and it shows…",
   body:"We're deep into this trip, and it shows — late check-ins, early flights, the same hotel food. We can upgrade the rest of it: later departures, a better hotel in the next city, a team dinner each night — {misc_cost_sm}. Or we keep the plan we have, and they push through.",
   yesLabel:'Upgrade the Trip',noLabel:'Keep the Plan',
   yesEffect:{morale:3},noEffect:{morale:-2},
   yesMsg:"Upgraded. The players noticed.",noMsg:"Same plan. A few more days.",
   _budgetCost:'misc_cost_sm'},

  {id:'rd5',autoResolve:'no',_weight:0.8,type:'urgent',tag:'OPERATIONS',sender:'Travel Coordinator',avatar:'✈️',
   _requiresRoad:true,_oncePerSeries:true,_repeat:{gapDays:20,max:2},
   subject:"A problem at the hotel in {road_city}",
   preview:"The hotel booked a convention on our floors…",
   body:"The hotel in {road_city} booked a convention on our floors, and the halls were loud until two in the morning. We can move the team to another hotel across town today — {misc_cost_xs}, and a longer ride to the ballpark. Or we ask for quieter rooms and hope it settles down.",
   yesLabel:'Move the Team',noLabel:'Stay Put',
   yesEffect:{morale:1},noEffect:{morale:-2},
   yesMsg:"Moving this afternoon. Bags will be in the rooms before you are.",noMsg:"Staying. The hotel promised quieter rooms.",
   _budgetCost:'misc_cost_xs'},

  {id:'rd6',autoResolve:'no',_weight:0.7,type:'normal',tag:'OPERATIONS',sender:'Equipment Mgr.',avatar:'🧢',
   _requiresAway:true,_repeat:{gapDays:30,max:2},
   subject:"The visitors' clubhouse in {road_city}",
   preview:"The visitors' clubhouse here is the smallest in the league…",
   body:"The visitors' clubhouse in {road_city} is the smallest in the league — no batting cage of its own, and the hot water gives out by the fifth inning. We can rent a cage at a training center nearby for the hitters' early work — {misc_cost_xs}. Or we make do, like every other visiting club.",
   yesLabel:'Rent the Cage',noLabel:'Make Do',
   yesEffect:{ovr:1},noEffect:{morale:-1},
   yesMsg:"Cage rented. The van leaves at one.",noMsg:"Making do.",
   _budgetCost:'misc_cost_xs'},

  {id:'rd7',autoResolve:'no',_weight:1.0,type:'normal',tag:'DISCIPLINE',sender:'{manager_name} (Manager)',avatar:'🌙',
   _requiresRoad:true,_minConsecutiveRoadGames:1,_oncePerRoadTrip:true,_repeat:{gapDays:14,max:3},
   subject:"A curfew in {road_city}?",
   preview:"A few of the players have plans in {road_city} tonight…",
   body:"A few of the players have plans in {road_city} tonight, and it's the kind of town where a night out turns into a late one. I can set a curfew — midnight, rooms checked — and we'll be sharper tomorrow, but they'll grumble, and the veterans don't like being treated like kids. Or we trust them.",
   yesLabel:'Set a Curfew',noLabel:'Trust Them',
   yesEffect:{ovr:1,morale:-2},noEffect:{morale:2},
   yesMsg:"Curfew's set. Rooms get checked at midnight.",noMsg:"No curfew. I told them not to make me regret it."},

  {id:'rd8',autoResolve:'no',_weight:0.8,type:'good',tag:'MARKETING',sender:'Community Relations',avatar:'🤝',
   _requiresRoad:true,_minConsecutiveRoadGames:1,_repeat:{gapDays:20,max:2},
   subject:"A hospital visit in {road_city}",
   preview:"The children's hospital in {road_city} asked whether a few players could visit…",
   body:"The children's hospital in {road_city} asked whether a few of our players could visit tomorrow morning. It isn't our city, and nobody would blame us for saying no — but a club that shows up on the road gets noticed around the league. It's an early morning before a night game.",
   yesLabel:'Send a Few Players',noLabel:'Not This Trip',
   yesEffect:{atmo:2,morale:-1},noEffect:{},
   yesMsg:"Four players signed up. We'll send pictures.",noMsg:"We passed this time."},

  // ── the road's news ──
  {id:'rdn1',autoResolve:'yes',_weight:0.7,type:'good',tag:'MARKETING',sender:'PR Dept.',avatar:'📣',
   _requiresRoad:true,_oncePerSeries:true,_repeat:{gapDays:20,max:2},_toastOnly:true,
   subject:"Our fans in {road_city}",
   preview:"A few hundred of our fans made the trip…",
   body:"A few hundred of our fans made the trip to {road_city} — you'll see them behind our dugout. The players have noticed; a couple of them plan to toss balls into the section before the game.",
   yesLabel:'Understood',noLabel:'Understood',yesEffect:{atmo:1},noEffect:{atmo:1}},

  {id:'rdn2',autoResolve:'yes',_weight:0.6,type:'good',tag:'MARKETING',sender:'PR Dept.',avatar:'📰',
   _requiresRoad:true,_oncePerSeries:true,_repeat:{gapDays:30,max:2},_toastOnly:true,
   subject:"A profile in the {road_city} paper",
   preview:"The paper in {road_city} ran a long piece this morning…",
   body:"The paper in {road_city} ran a long piece on {active_hitter_name} this morning — the swing, the road here, what the other clubs think. It's a good read, and a flattering one. We've sent it around.",
   yesLabel:'Understood',noLabel:'Understood',yesEffect:{},noEffect:{}},

  // ── the ballpark while we're away (one booking a road trip; how it went comes when we're home) ──
  // rv1: Concert/large event — can recur with cooldown, each resolves different tokens
  {id:'rv1',autoResolve:'no',_weight:0.85,type:'good',tag:'REVENUE',sender:'Partnerships',relay:"{road_event_promoter}",avatar:'🎤',
   _requiresRoadAhead:3,_parkEvent:true,_requeueOnNo:false,_requeueCooldown:20,
   subject:"{road_event_type} at the ballpark while we're on the road?",
   preview:"{road_event_promoter} wants the ballpark for {road_event_type}…",
   body:"{road_event_promoter} called us about using the ballpark for {road_event_type} while we're on the road. The revenue is real ({rev_amount}), and the event would put the ballpark at the center of town for a night. The catch: lighting towers in the outfield, and a teardown that runs right up to our first home game back. Passing protects the field, which the players will appreciate, but the people who wanted the event will be let down.",
   yesLabel:'Book it — take the revenue',noLabel:'Protect the field — pass',
   yesEffect:{atmo:5},noEffect:{atmo:-3,morale:2},
   yesMsg:"Event booked. The grounds crew has its window. The first game back will be the test.",
   noMsg:"Passed. The grounds crew appreciates it. The players quietly do too.",
   _revenueToken:'rev_amount',onYes:'park_event',_outcomes:[['rv1_field_condition',0.3],['rv1_good',0.7]],
   _oncePerSeason:false},

  // rv2: Youth tournament — once per season, full vs field-only access tradeoff
  {id:'rv2',autoResolve:'yes',_weight:0.8,type:'good',tag:'REVENUE',sender:"{tournament_org}",avatar:'⚾',
   _requiresRoadAhead:3,_parkEvent:true,_oncePerSeason:true,
   subject:"Using your ballpark while you're on the road",
   preview:"We'd love to bring our tournament to your ballpark…",
   body:"We'd love to bring {tournament_org} to your ballpark while you're on the road — with full access, including the home clubhouse. Seeing a real big-league locker room is the centerpiece for these kids; it's why families drive hours to come. We'd pay more for full access. Field-only would be a lower fee, but honestly, if it's field-only we'll look for another venue.",
   yesLabel:'Full access including clubhouse',noLabel:'Field only — clubhouse stays closed',
   yesEffect:{atmo:6,morale:3},noEffect:{atmo:3,morale:1},
   yesMsg:"Thank you! The kids are going to remember this. We'll take good care of the place.",
   noMsg:"Field-only, then. We're disappointed, but we understand.",
   _revenueToken:'rev_amount',_rawBudgetCostNo:15,onYes:'park_event',_outcomes:[['rv2_clubhouse_issue',0.2],['rv2_good',0.8]]},

  // rv3: University/college game — once per season, revenue vs brand identity tradeoff
  {id:'rv3', _promise:{yes:{kind:'college_look',when:'fa_opens'}},autoResolve:'no',_weight:0.75,type:'good',tag:'REVENUE',sender:'Community Relations',avatar:'🏫',
   _requiresRoadAhead:3,_parkEvent:true,_oncePerSeason:true,
   subject:"{university_name} wants to host {university_game} here",
   preview:"{university_name} has a capacity problem for {university_game}…",
   body:"{university_name} has a capacity problem for {university_game} and wants to move it to our ballpark while we're on the road. The facility fee is fair. The complication: their athletic department wants full co-branding — their colors on every scoreboard surface and their signage for the day — and marketing is worried about diluting our identity. Hosting brings the revenue and the goodwill, and our scouts get an up-close look at the players: one of them will turn up in this winter's free-agent class, and we'll know that player better than anyone. Passing protects the brand.",
   yesLabel:'Host the game — open the ballpark',noLabel:'Pass — protect the brand',
   yesEffect:{atmo:4,morale:1},noEffect:{atmo:-2},
   yesMsg:"Game confirmed, co-branding agreed. Our scouts will be watching.",
   noMsg:"Passed. They'll find another venue; the scouts will track the player another way.",
   _revenueToken:'rev_amount',onYes:'park_event',_outcomes:[['rv3_good',1]]},

  // rv4: Corporate rental — requeues with cooldown, each resolves different corp/controversy
  {id:'rv4',autoResolve:'no',_weight:0.8,type:'normal',tag:'REVENUE',sender:'Partnerships',avatar:'💼',
   _requiresRoadAhead:3,_parkEvent:true,_requeueCooldown:15,_oncePerSeason:false,
   subject:"{corp_event_name} wants to rent the ballpark",
   preview:"{corp_event_name} wants the venue for {corp_event_type}…",
   body:"{corp_event_name} wants to rent the whole ballpark for {corp_event_type} while we're on the road. No field use, no risk to the playing surface, and the best revenue of any non-game event ({rev_amount}). The contract includes full scoreboard and signage branding for the day — and {corp_event_name} has been associated with {corp_controversy}. Taking it is pure revenue. Passing leaves the money on the table and earns a little respect from the fans and the clubhouse.",
   yesLabel:'Take the rental — revenue is revenue',noLabel:'Pass — not the right partner',
   yesEffect:{},noEffect:{atmo:2,morale:1},
   yesMsg:"Rental confirmed. The ballpark is theirs for the day; the money's in the bank.",
   noMsg:"Passed. Some partners are not worth it.",
   _revenueToken:'rev_amount',onYes:'park_event',_outcomes:[['rv4_good',0.7],['rv4_press',0.3]]},

  // rv6: a music festival — the most money, the most wear
  {id:'rv6',autoResolve:'no',_weight:0.85,type:'good',tag:'REVENUE',sender:'Partnerships',avatar:'🎶',
   _requiresRoadAhead:3,_parkEvent:true,_oncePerSeason:true,
   subject:"A music festival at the ballpark while we're away",
   preview:"A festival company wants the ballpark for a weekend…",
   body:"A festival company wants the ballpark for a two-day music festival while we're on the road — {event_rev_lg} for the weekend, and it would be the biggest thing in town. Two stages go up in the outfield. The grounds crew's warning: two days of crowds on the grass is two days of crowds on the grass.",
   yesLabel:'Book the Festival',noLabel:'Protect the Field',
   yesEffect:{atmo:3},noEffect:{morale:1},
   yesMsg:"Booked. The stages go up the day after we leave.",noMsg:"Passed. The grounds crew is relieved.",
   _revenueToken:'event_rev_lg',onYes:'park_event',_outcomes:[['rv6_damage',0.45],['rv6_good',0.4],['rv6_noise',0.15]]},

  // rv7: the state high school championship
  {id:'rv7',autoResolve:'no',_weight:0.85,type:'good',tag:'MARKETING',sender:'Community Relations',avatar:'🏆',
   _requiresRoadAhead:3,_parkEvent:true,_oncePerSeason:true,
   subject:"The high school championship, at our ballpark?",
   preview:"The state high school association wants to play its final here…",
   body:"The state high school association wants to play its championship game at our ballpark while we're on the road. The fee is modest ({event_rev_sm}), but it's a day the players and their towns will remember, and plenty of them grew up rooting for us. The mound and the infield get a full day of use.",
   yesLabel:'Host the Final',noLabel:'Not This Year',
   yesEffect:{atmo:3},noEffect:{atmo:-1},
   yesMsg:"Hosting. The association is thrilled.",noMsg:"Passed. They'll play it at the university.",
   _revenueToken:'event_rev_sm',onYes:'park_event',_outcomes:[['rv7_good',0.85],['rv7_mound',0.15]]},

  // rv8: a film shoot
  {id:'rv8',autoResolve:'no',_weight:0.75,type:'good',tag:'REVENUE',sender:'Partnerships',avatar:'🎬',
   _requiresRoadAhead:3,_parkEvent:true,_oncePerSeason:true,
   subject:"A film shoot at the ballpark",
   preview:"A film production wants to shoot a baseball scene here…",
   body:"A film production wants to shoot a baseball scene at the ballpark while we're away — {event_rev_lg} for three days. They'd bring their own crew, their own lights and a lot of trucks, and they'd want our logos covered for some of the shots. It's money and a little fame. It's also three days of people who don't know a ballpark moving heavy equipment around one.",
   yesLabel:'Sign the Contract',noLabel:'Pass',
   yesEffect:{atmo:2},noEffect:{},
   yesMsg:"Signed. Lights, camera, and a lot of trucks.",noMsg:"Passed. They'll find another park.",
   _revenueToken:'event_rev_lg',onYes:'park_event',_outcomes:[['rv8_good',0.5],['rv8_wall',0.3],['rv8_overstay',0.2]]},

  // rv9: a charity run
  {id:'rv9',autoResolve:'no',_weight:0.8,type:'good',tag:'MARKETING',sender:'Community Relations',avatar:'🏃',
   _requiresRoadAhead:3,_parkEvent:true,_oncePerSeason:true,
   subject:"A charity run that finishes at home plate",
   preview:"A local charity wants its 5K to finish inside the ballpark…",
   body:"A local charity wants its 5K to finish inside the ballpark — runners on the warning track, families in the stands, the finish line at home plate. The fee is small ({event_rev_sm}); it's mostly goodwill. A few thousand runners on the warning track will chew it up some.",
   yesLabel:'Open the Gates',noLabel:'Not This Time',
   yesEffect:{atmo:4},noEffect:{atmo:-2},
   yesMsg:"The finish line goes in at home plate.",noMsg:"We passed. They'll finish at the park downtown.",
   _revenueToken:'event_rev_sm',onYes:'park_event',_outcomes:[['rv9_good',0.8],['rv9_track',0.2]]},

  // rv10: the city's fireworks
  {id:'rv10',autoResolve:'no',_weight:0.8,type:'good',tag:'REVENUE',sender:'Partnerships',avatar:'🎆',
   _requiresRoadAhead:3,_parkEvent:true,_oncePerSeason:true,
   subject:"The city's fireworks show, at the ballpark",
   preview:"The city wants to hold its fireworks show here…",
   body:"The city wants to hold its fireworks show at the ballpark while we're on the road — {rev_amount}, the concourse open, and a crowd full of people who have never been to a game. The launch site would be in center field. Fireworks leave debris, and now and then a scorch mark.",
   yesLabel:'Host the Show',noLabel:'Pass',
   yesEffect:{atmo:3},noEffect:{atmo:-2},
   yesMsg:"Hosting. The launch crew arrives the day after we leave.",noMsg:"Passed. The show moves to the riverfront.",
   _revenueToken:'rev_amount',onYes:'park_event',_outcomes:[['rv10_good',0.6],['rv10_scorch',0.4]]},

  // rv11: a wedding at home plate
  {id:'rv11',autoResolve:'no',_weight:0.7,type:'good',tag:'REVENUE',sender:'Partnerships',avatar:'💍',
   _requiresRoadAhead:3,_parkEvent:true,_oncePerSeason:true,
   subject:"A wedding at home plate",
   preview:"Two longtime season-ticket holders want to get married here…",
   body:"Two longtime season-ticket holders want to get married at home plate while we're away, with dinner for two hundred on the field. They'd pay {event_rev_sm}, and they'd tell everybody. A party on the infield is still a party on the infield.",
   yesLabel:'Say Yes',noLabel:'Decline Kindly',
   yesEffect:{atmo:2},noEffect:{atmo:-1},
   yesMsg:"Yes. They cried on the phone.",noMsg:"Declined. They were gracious about it.",
   _revenueToken:'event_rev_sm',onYes:'park_event',_outcomes:[['rv11_good',0.8],['rv11_grass',0.2]]},
];

const news = (id, sender, avatar, subject, body, extra = {}) => ({ type: 'park', card: {
  id, autoResolve: 'yes', type: 'normal', tag: 'OPERATIONS', sender, avatar, subject,
  preview: body.split(/(?<=[.!?])\s/)[0], body, yesLabel: 'Understood', noLabel: 'Understood', _toastOnly: true,
  yesEffect: {}, noEffect: {}, ...extra } });
const repair = (id, subject, body, yesLabel, noLabel, noEffect, yesMsg, noMsg) => ({ type: 'park', card: {
  id, autoResolve: 'no', type: 'urgent', tag: 'FACILITIES', sender: 'Head Groundskeeper', avatar: '🌱', subject,
  preview: body.split(/(?<=[.!?])\s/)[0], body, yesLabel, noLabel, yesEffect: {}, noEffect, yesMsg, noMsg,
  _budgetCost: 'repair_cost' } });

export const AWAY_FOLLOWUPS = [
  news('rv1_good', 'Partnerships', '🎤', 'The event went off cleanly',
    'The event went off without a problem, and the teardown finished with hours to spare. The promoter wants to come back.', { yesEffect: { atmo: 1 }, noEffect: { atmo: 1 } }),
  news('rv2_good', 'Community Relations', '⚾', 'The tournament, and the clubhouse',
    'The youth tournament wrapped up, and the clubhouse came back spotless — the coaches had the players clean it themselves. A few of the families have already bought tickets for the homestand.', { yesEffect: { atmo: 1 }, noEffect: { atmo: 1 } }),
  news('rv3_good', 'Community Relations', '🏫', 'The college game drew a full house',
    'The college game drew a full house and a lot of new faces in our colors. Our scouts sat behind the plate the whole game, and their notes are in.'),
  news('rv4_good', 'Partnerships', '💼', 'The rental went off quietly',
    'The rental went off quietly. The money is in, and nobody outside the building seemed to notice the signage.'),
  news('rv4_press', 'PR Dept.', '📰', 'A column about the rental',
    'A local columnist noticed whose name was on our scoreboard during the rental and wrote about it this morning. It\'s one column, and it will pass, but a few season-ticket holders have called.', { yesEffect: { atmo: -2 }, noEffect: { atmo: -2 } }),

  repair('rv6_damage', 'The festival tore up the outfield',
    'The festival is gone, and so is a good share of the outfield grass — the stages left two bare patches in left-center, and the crowds packed the rest down. We can resod the worst of it this morning for {repair_cost}, with batting practice moved to the cages. Or we paint the bare spots green and play on them, and the outfielders take their chances.',
    'Resod It', 'Play On It', { ovr: -2, morale: -1 }, 'Resodding now. BP is in the cages.', 'Painted green. The outfielders are not thrilled.'),
  news('rv6_good', 'Partnerships', '🎶', 'The festival sold out',
    'The festival sold out both days. Bar sales came in high enough that our share added {event_bonus} on top of the fee, and the promoter is already asking about next summer. The grass held up better than anyone expected.', { _revenueToken: 'event_bonus', yesEffect: { atmo: 2 }, noEffect: { atmo: 2 } }),
  news('rv6_noise', 'Community Relations', '🎶', 'The neighbors and the festival',
    'The festival went off, but the neighbors were not happy — music until midnight both nights, and the city council heard about it. We\'ll smooth it over; it will take some time.', { yesEffect: { atmo: -2 }, noEffect: { atmo: -2 } }),

  news('rv7_good', 'Community Relations', '🏆', 'A walk-off at our home plate',
    'The championship game went to extra innings and ended on a walk-off. The winning school sent a signed ball and a team photo taken at our home plate; it\'s hanging in the concourse now.', { yesEffect: { atmo: 2 }, noEffect: { atmo: 2 } }),
  repair('rv7_mound', 'The mound after the championship',
    'The championship game left the mound dug out in front of the rubber — their pitchers land in different spots than ours. We can rebuild the landing area this morning for {repair_cost}. Or we pack it and go, and our starter finds out about it in the first inning.',
    'Rebuild the Mound', 'Pack It and Go', { ovr: -1 }, 'Rebuilding it now.', 'Packed. We\'ll see how it holds.'),

  news('rv8_good', 'Partnerships', '🎬', 'The film crew wrapped',
    'The film crew wrapped on time and left the place cleaner than they found it. The director asked whether a few of our players would do a walk-on when the film comes out next summer. Everyone in the front office wants to be an extra.', { yesEffect: { atmo: 2 }, noEffect: { atmo: 2 } }),
  repair('rv8_wall', 'A dented panel in right field',
    'The film crew backed a lighting truck into the outfield wall in right — a dented panel and a seam that has come loose. We can have the panel replaced before first pitch for {repair_cost}. Or we pad over it for now, and balls off it will bounce oddly until the winter.',
    'Replace the Panel', 'Pad Over It', { ovr: -1 }, 'A new panel goes in this morning.', 'Padded over. Expect a few strange bounces.'),
  news('rv8_overstay', 'Stadium Ops.', '🎬', 'The film crew ran over',
    'The film crew ran over by a day, and their trucks were still in the lot this morning. We charged them for the extra day, {event_bonus}, but the grounds crew lost their prep window and is behind.', { _revenueToken: 'event_bonus', yesEffect: { morale: -1 }, noEffect: { morale: -1 } }),

  news('rv9_good', 'Community Relations', '🏃', 'The run raised more than they hoped',
    'The run raised more than the charity hoped, and the pictures of the finish line at home plate are everywhere this morning. The charity wants to make it a yearly thing.', { yesEffect: { atmo: 2 }, noEffect: { atmo: 2 } }),
  repair('rv9_track', 'The warning track after the run',
    'A few thousand runners chewed up the warning track — it\'s loose and rutted in the corners. We can regrade it before batting practice for {repair_cost}. Or we rake it and live with it, and our outfielders will be feeling for the wall.',
    'Regrade the Track', 'Rake It and Play', { ovr: -1 }, 'Regrading now.', 'Raked. The outfielders have been warned.'),

  news('rv10_good', 'Partnerships', '🎆', 'The biggest crowd of the year',
    'The fireworks drew the biggest crowd the ballpark has had all year, and the concessions did well enough to add {event_bonus} to the fee. The crew had every bit of debris off the field by sunrise.', { _revenueToken: 'event_bonus', yesEffect: { atmo: 2 }, noEffect: { atmo: 2 } }),
  repair('rv10_scorch', 'Scorch marks in center field',
    'The fireworks left scorch marks in center field and debris in the warning track. We can cut out the burned sod and replace it this morning for {repair_cost}. Or we paint it and play, and center field will play hard in those spots.',
    'Replace the Sod', 'Paint It and Play', { ovr: -1, morale: -1 }, 'New sod going in now.', 'Painted. Center field will play fast.'),

  news('rv11_good', 'Partnerships', '💍', 'The wedding at home plate',
    'The wedding went beautifully. The couple sent a photo of the two of them at home plate, and it\'s already the most-shared thing the club has posted this month.', { yesEffect: { atmo: 2 }, noEffect: { atmo: 2 } }),
  repair('rv11_grass', 'The infield after the wedding',
    'The wedding dinner left table marks in the infield grass and a few spots where the chairs sank in. We can roll and patch it this morning for {repair_cost}. Or we leave it, and a ground ball or two will take a funny hop.',
    'Roll and Patch It', 'Leave It', { ovr: -1 }, 'Rolling it now.', 'Left as is. Watch the hops.'),
];
