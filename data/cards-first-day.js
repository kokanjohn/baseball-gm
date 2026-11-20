/**
 * data/cards-first-day.js
 * r211 §122.89 A new team's first day: the messages that come between taking over and the first pitch, on top
 * of the four seed messages, the first trade call and the takeover moment.
 *
 *   FIRST_DAY_CORE       one per slot, always (as many as there's time for), spread through the time there is.
 *                        Two versions a slot, so two new teams don't open the same way.
 *   FIRST_DAY_SECONDARY  more when there's more time (a team made the day before), so something comes
 *                        about every couple of hours.
 *   GM_HELLOS            other clubs' GMs reaching out through the first spring (one may come the first day).
 *                        `{gm}` and `{club}` are filled in by CardEngine (the club and its GM's last name);
 *                        `_rapport` is what each answer does to our standing with that front office.
 *
 * None of these repeat a seed or a spring-pool subject (field prep, clubhouse upkeep, the standards review, the
 * fan experience package, the spring travel, media day, a player's role, arm soreness, the camp's intensity).
 * Some staff introduce themselves (always with a real task); others skip the introductions. The manager never
 * asks us to set the lineup (that's the manager's call), only about a specific situation.
 * Card shape is the pool's (cards-pool.js); tokens resolve the same way.
 */

export const FIRST_DAY_CORE = Object.freeze({

  // ── The trainer ──
  trainer: [
    {id:'fd_trainer_surgery',autoResolve:'no',autoResolveTax:{morale:-1},type:'normal',tag:'MEDICAL',sender:'Head Trainer',avatar:'🩹',
     _promise:{no:{kind:'worn_down',afterDays:4,player:'active_hitter'}},
     subject:"Introductions, and {active_hitter_name}'s knee",
     preview:"I run the training room. First thing you should know about…",
     body:"I run the training room, and I'm glad you're here. First thing you should know: {active_hitter_name} had a knee cleaned up this winter. Cleared, strong, and wants to play the first game. I'd hold {active_hitter_name} out of it and let the knee take one more day of work. Playing now keeps the bat in the lineup, but if the knee isn't ready we lose more than a game.",
     yesLabel:'Hold Them Out One Game',noLabel:'Let Them Play',
     yesEffect:{morale:1},noEffect:{morale:1},
     yesMsg:"One more day of work on the knee. {active_hitter_name} grumbled, then got on the bike.",
     noMsg:"{active_hitter_name} plays. I'll be watching that knee.",
     onYes:'rest_active_hitter',_restGames:1,_ttl:2},

    {id:'fd_trainer_heavy',autoResolve:'no',autoResolveTax:{morale:-1},type:'normal',tag:'MEDICAL',sender:'Head Trainer',avatar:'🩹',
     _promise:{no:{kind:'worn_down',afterDays:5,player:'active_hitter'}},
     subject:"Hello from the training room, and a question about {active_hitter_name}",
     preview:"Welcome. I'll keep this short, because I need an answer…",
     body:"Welcome. I'll keep this short, because I need an answer: {active_hitter_name} reported to camp heavier than we'd like and is already favoring a hamstring. I want a conditioning program that keeps {active_hitter_name} out of the first game. The other way, {active_hitter_name} plays and works it off as we go, and a hamstring like that can go on us.",
     yesLabel:'Start the Program',noLabel:'Let Them Play It Off',
     yesEffect:{morale:-1,ovr:1},noEffect:{morale:1},
     yesMsg:"The program starts in the morning. {active_hitter_name} isn't thrilled, but the work is the work.",
     noMsg:"Playing it off. I'll keep the hamstring wrapped and an eye on it.",
     onYes:'rest_active_hitter',_restGames:1,_ttl:2},
  ],

  // ── The equipment manager ──
  equipment: [
    {id:'fd_equip_uniforms',autoResolve:'yes',type:'normal',tag:'OPERATIONS',sender:'Equipment Mgr.',avatar:'🧢',
     subject:"Which uniforms for the first game?",
     preview:"No time for introductions: I need to know which set goes in the lockers…",
     body:"No time for introductions: I need to know which set goes in the lockers for the first game. Our uniform sponsor has offered {misc_cost_xs} to see the new set on the field that day. The fans love the throwbacks, and the stands would be full of them.",
     yesLabel:'The Sponsor\'s Set',noLabel:'The Throwbacks',
     yesEffect:{atmo:-1},noEffect:{atmo:3},
     yesMsg:"The new set it is. The sponsor's check is on the way.",
     noMsg:"Throwbacks in the lockers. The fans will love it. The sponsor won't call.",
     _revenueToken:'misc_cost_xs',_ttl:2},

    {id:'fd_equip_bats',autoResolve:'yes',type:'normal',tag:'OPERATIONS',sender:'Equipment Mgr.',avatar:'🧢',
     subject:"Hello, and a bat order before the first game",
     preview:"I'm the one who keeps everything in the lockers. Here's what's short…",
     body:"I'm the one who keeps everything in the lockers. Before the first game: half the hitters are down to their last few bats, and the maker we use can rush an order for {misc_cost_xs}. The standard order comes after the first week, and until then some of them swing whatever's in the rack.",
     yesLabel:'Rush the Order',noLabel:'The Standard Order',
     yesEffect:{morale:3},noEffect:{morale:-2},
     yesMsg:"Rushed. Fresh bats in every locker before first pitch.",
     noMsg:"The standard order. A few of them are already arguing over the rack.",
     _budgetCost:'misc_cost_xs',_ttl:2},
  ],

  // ── The ticket office ──
  tickets: [
    {id:'fd_tickets_opener',autoResolve:'no',type:'normal',tag:'MARKETING',sender:'Ticket Office',avatar:'🎟️',
     subject:"The first home game — fill it, or sell it?",
     preview:"We're skipping the formalities: the first game is close and we have seats left…",
     body:"We're skipping the formalities: the first game is close and we have seats left. Half-price seats would pack the park for your first day and cost us about {misc_cost_xs} at the gate. Full price keeps the money, and the TV shot will show empty seats.",
     yesLabel:'Half-Price Seats',noLabel:'Full Price',
     yesEffect:{atmo:4,ownerTrust:-1},noEffect:{atmo:-2},
     yesMsg:"Half-price seats are selling fast. It'll be loud.",
     noMsg:"Full price. We'll sell what we sell.",
     _budgetCost:'misc_cost_xs',_ttl:2},

    {id:'fd_tickets_giveaway',autoResolve:'no',type:'normal',tag:'MARKETING',sender:'Ticket Office',avatar:'🎟️',
     subject:"A giveaway for your first game?",
     preview:"Welcome. We need one decision from you before the gates open…",
     body:"Welcome. We need one decision from you before the gates open: a giveaway for the first home game. Caps for the first ten thousand through the gates run {misc_cost_xs}, and people remember the first game they got something at. Without one, it's just another spring game.",
     yesLabel:'Order the Caps',noLabel:'No Giveaway',
     yesEffect:{atmo:4},noEffect:{atmo:-1},
     yesMsg:"Caps ordered. The line will be around the block.",
     noMsg:"No giveaway. The gates open the usual way.",
     _budgetCost:'misc_cost_xs',_ttl:2},
  ],

  // ── The scouting director ──
  scouting: [
    {id:'fd_scout_market',autoResolve:'no',type:'normal',tag:'SCOUTING',sender:'Scouting Dept.',avatar:'🔭',
     subject:"Introductions — and a first look at the market",
     preview:"I run our scouting. Before anything else, I'd like to show you what's out there…",
     body:"I run our scouting, and I'm looking forward to working with you. Before anything else, I'd like to show you who's still unsigned and worth a look at the positions where we're thin. Say the word and I'll have it to you soon. If you'd rather settle in first, it'll keep.",
     yesLabel:'Send It Over',noLabel:'It Can Wait',
     yesEffect:{},noEffect:{},
     yesMsg:"On it. You'll have it soon.",
     noMsg:"Understood. Ask me anytime.",
     onYes:'fd_fa_look',_ttl:2},

    {id:'fd_scout_holes',autoResolve:'no',type:'normal',tag:'SCOUTING',sender:'Scouting Dept.',avatar:'🔭',
     subject:"Where we're thin, and who's out there",
     preview:"We'll do introductions later. Where we're thin…",
     body:"We'll do introductions later. I've been through the roster, and there are spots where we're thin. There are still players out there who could help, and they won't be out there long. I can put the list together now, or we can see how camp shakes out first.",
     yesLabel:'Put the List Together',noLabel:'See How Camp Goes',
     yesEffect:{},noEffect:{},
     yesMsg:"Putting it together now.",
     noMsg:"Camp first, then.",
     onYes:'fd_fa_look',_ttl:2},
  ],

  // ── The manager (a specific situation, never the lineup itself) ──
  manager: [
    {id:'fd_mgr_order',autoResolve:'no',autoResolveTax:{manConf:-1},type:'normal',tag:'CULTURE',sender:"{manager_name} (Manager)",avatar:'📋',
     subject:"{active_hitter_name} and the batting order",
     preview:"Not the lineup — that's mine — but you should hear this before the first game…",
     body:"Not the lineup — that's mine — but you should hear this before the first game. {active_hitter_name} came to my office wanting to hit higher in the order and wasn't happy with my answer. I'm keeping the order the way I have it. If you back me, I'll tell {active_hitter_name} it came from both of us. If you'd rather I give it a look, I'll move {active_hitter_name} up and see.",
     yesLabel:'Back the Manager',noLabel:'Give It a Look',
     yesEffect:{manConf:2,morale:-1},noEffect:{manConf:-2,morale:2},
     yesMsg:"Good. We'll tell {active_hitter_name} together. One voice.",
     noMsg:"I'll move {active_hitter_name} up and see. My call stands the rest of the way.",
     _ttl:2},

    {id:'fd_mgr_captain',autoResolve:'no',autoResolveTax:{manConf:-1},type:'normal',tag:'CULTURE',sender:"{manager_name} (Manager)",avatar:'📋',
     subject:"A captain, before the first game?",
     preview:"We haven't had a captain in years. Some of the players want one…",
     body:"We haven't had a captain in years, and some of the players want one. The room points at {active_hitter_name}. A captain gives the clubhouse one voice when things go sideways, and some of the veterans won't like being passed over. I'd rather wait and see who leads, but this is a front office decision.",
     yesLabel:'Name a Captain',noLabel:'Wait and See',
     yesEffect:{morale:3,manConf:-1},noEffect:{manConf:1},
     yesMsg:"{active_hitter_name} gets the C. We'll announce it before the first game.",
     noMsg:"We wait. The leaders will show themselves.",
     _ttl:3},
  ],
});

export const FIRST_DAY_SECONDARY = Object.freeze([
  {id:'fd_pc_pitch',autoResolve:'no',type:'normal',tag:'ROSTER',sender:"{pitching_coach_name} (Pitching Coach)",avatar:'⚾',
   subject:"Introductions, and a new pitch",
   preview:"I coach the pitchers. One of them wants to try something new…",
   body:"I coach the pitchers, and I'm glad to finally meet you. {active_sp_name} wants to spend the spring throwing a new pitch in games. If it takes, it's a real weapon. If it doesn't, it's a spring of hard contact and a pitcher who has lost some confidence. I'm fine either way, but the clubhouse will know it came from you.",
   yesLabel:'Let Them Try It',noLabel:'Keep It Simple',
   yesEffect:{morale:2,ovr:1},noEffect:{morale:-1},
   yesMsg:"{active_sp_name} is grinning. We start in the bullpen tomorrow.",
   noMsg:"Simple it is. {active_sp_name} will get over it.",
   _ttl:3},

  {id:'fd_hc_swing',autoResolve:'no',type:'normal',tag:'ROSTER',sender:"{hitting_coach_name} (Hitting Coach)",avatar:'🏏',
   subject:"{active_hitter_name} wants to rebuild the swing",
   preview:"Skipping the hellos: one of the hitters wants to tear the swing down…",
   body:"Skipping the hellos: {active_hitter_name} wants to tear the swing down this spring and rebuild it. Spring is the time to do it, and the new swing could be better than the old one. It could also leave {active_hitter_name} lost at the plate in the first weeks of the season.",
   yesLabel:'Rebuild It',noLabel:'Leave It Alone',
   yesEffect:{ovr:1,morale:1},noEffect:{morale:-1},
   yesMsg:"We start in the cage tomorrow. Ask me in a month.",
   noMsg:"The swing stays. {active_hitter_name} is disappointed, but it's a good swing.",
   _ttl:3},

  {id:'fd_radio',autoResolve:'no',type:'good',tag:'MARKETING',sender:'PR Dept.',avatar:'📻',
   subject:"The radio station wants you on the pregame show",
   preview:"The flagship station would like the new GM on before the first game…",
   body:"The flagship station would like the new GM on the pregame show before the first game: ten minutes with the play-by-play voice, the fans' questions, the season ahead. It's the easiest way to meet the people who'll be listening every night. You can also let the work speak first.",
   yesLabel:'Go On the Show',noLabel:'Let the Work Speak',
   yesEffect:{atmo:2,ownerTrust:1},noEffect:{},
   yesMsg:"You're booked. They'll call the office before the pregame.",
   noMsg:"We'll tell them next time.",
   _ttl:2},

  {id:'fd_open_practice',autoResolve:'no',type:'normal',tag:'MARKETING',sender:'Fan Relations',avatar:'🤝',
   subject:"An open workout for the season-ticket holders?",
   preview:"The season-ticket holders are asking to see camp. We could open a workout…",
   body:"The season-ticket holders are asking to see camp. We could open a workout to them, with an autograph line after. It costs {misc_cost_xs} for the staff and the security, and it puts the players on their feet for an extra hour. Those fans renew.",
   yesLabel:'Open the Workout',noLabel:'Keep Camp Closed',
   yesEffect:{atmo:3,morale:-1},noEffect:{atmo:-1},
   yesMsg:"The gates open for the workout. The autograph line is already forming.",
   noMsg:"Camp stays closed. We'll send them a letter.",
   _budgetCost:'misc_cost_xs',_ttl:3},

  {id:'fd_nutrition',autoResolve:'no',type:'normal',tag:'CULTURE',sender:'Head Trainer',avatar:'🥗',
   subject:"A nutrition program for the season",
   preview:"The clubhouse spread is fast food with a salad bar. A real program…",
   body:"The clubhouse spread is fast food with a salad bar. A real nutrition program, with a chef and plans built for each player, runs {misc_cost_sm} for the season. The players feel it by midsummer, when the legs usually go. Without it, they eat what they eat.",
   yesLabel:'Hire the Chef',noLabel:'Keep the Spread',
   yesEffect:{morale:3,ovr:1},noEffect:{},
   yesMsg:"The chef starts this week. The players are already asking about the menu.",
   noMsg:"The spread stays.",
   _budgetCost:'misc_cost_sm',_ttl:3},
]);

// ── Other clubs' GMs, through the first spring ─────────────────────────────
// `_rapport`: our standing with that front office (it carries into every trade talk with them).
export const GM_HELLOS = Object.freeze([
  {id:'gm_hello_coffee',autoResolve:'no',type:'normal',tag:'TRADE',sender:'{gm} ({club} GM)',avatar:'☕',
   subject:"Coffee at the complex?",
   preview:"We're in the same camp town, and I make a point of it…",
   body:"I run the {club}. We're in the same camp town, and I make a point of meeting every new GM. Coffee at the complex, no agenda. We'll be on the phone with each other plenty.",
   yesLabel:'Meet for Coffee',noLabel:'Not This Spring',
   yesMsg:"Coffee it is. A good hour, and a number to call.",
   noMsg:"Maybe next spring, then.",
   _rapport:{yes:6,no:-2},_ttl:4},

  {id:'gm_hello_dinner',autoResolve:'no',type:'normal',tag:'TRADE',sender:'{gm} ({club} GM)',avatar:'🍽️',
   subject:"Dinner, on me",
   preview:"Welcome to the league. The {club} would like to buy you dinner…",
   body:"Welcome to the league. I run the {club}. I'd like to buy you dinner this week and tell you how this league really works. Fair warning: I'll ask about your bullpen.",
   yesLabel:'Accept the Invitation',noLabel:'Decline Politely',
   yesMsg:"Dinner it is. Long, friendly, and yes, the bullpen came up.",
   noMsg:"Another time, then.",
   _rapport:{yes:7,no:-3},_ttl:4},

  {id:'gm_hello_golf',autoResolve:'no',type:'normal',tag:'TRADE',sender:'{gm} ({club} GM)',avatar:'⛳',
   subject:"A round on the off day?",
   preview:"A few of us play on the off days in camp…",
   body:"I run the {club}, and a few of us GMs play on the off days in camp, and we'd like you to join us. Four hours on a golf course with the people you'll be trading with is the best scouting you'll do all spring.",
   yesLabel:'Join the Round',noLabel:'Pass',
   yesEffect:{manConf:-1},noEffect:{},
   yesMsg:"Tee time booked. Your manager will run the off day without you.",
   noMsg:"The group plays every spring. The invitation stands.",
   _rapport:{yes:7,no:-2},_ttl:4},

  {id:'gm_hello_heads_up',autoResolve:'no',type:'normal',tag:'TRADE',sender:'{gm} ({club} GM)',avatar:'📞',
   subject:"Introducing myself — and a heads-up",
   preview:"I like to start on the right foot with a new GM…",
   body:"I run the {club}, and I like to start on the right foot with a new GM, so here's a heads-up: we'll be listening on our veterans this spring, and I'd rather you hear it from me. If you want the first call when something comes open, say so.",
   yesLabel:'Call Me First',noLabel:'Thanks for the Heads-Up',
   yesMsg:"You'll get the first call.",
   noMsg:"Glad to. Good luck this spring.",
   _rapport:{yes:5,no:1},_ttl:4},

  {id:'gm_hello_gripe',autoResolve:'no',type:'normal',tag:'TRADE',sender:'{gm} ({club} GM)',avatar:'📞',
   subject:"Your PR people and our ballpark",
   preview:"We haven't met, and I wish this were a friendlier first call…",
   body:"We haven't met, and I wish this were a friendlier first call. I run the {club}. Someone in your PR office called our park a minor-league stop in an interview. Our fans saw it. An apology from you would end it. Standing by it makes your fans happy and me less so.",
   yesLabel:'Apologize',noLabel:'Stand By It',
   yesEffect:{atmo:-1},noEffect:{atmo:2},
   yesMsg:"Thank you. Consider it done.",
   noMsg:"Understood. Our fans will remember it too.",
   _rapport:{yes:6,no:-6},_ttl:4},

  {id:'gm_hello_notes',autoResolve:'no',type:'normal',tag:'TRADE',sender:'{gm} ({club} GM)',avatar:'📋',
   subject:"A swap of spring notes?",
   preview:"A proposal between friends we haven't made yet…",
   body:"I run the {club}, and I have a proposal between friends we haven't made yet: we both have scouts at the same games this spring. We could share notes on the clubs neither of us plays much. Our scouts get a fuller spring, and you and I start out trusting each other. Some GMs keep their notes to themselves.",
   yesLabel:'Share Notes',noLabel:'Keep Ours',
   yesMsg:"Deal. Our scouts are thorough, and yours will see.",
   noMsg:"Understood. Plenty of GMs keep theirs.",
   _rapport:{yes:6,no:-1},_ttl:4},

  {id:'gm_hello_manager',autoResolve:'no',type:'normal',tag:'TRADE',sender:'{gm} ({club} GM)',avatar:'📞',
   subject:"I worked with your manager",
   preview:"Your manager and I go back a long way…",
   body:"I run the {club}, and {manager_name} and I go back a long way, and I wanted to say hello before the season gets going. If you want to know how {manager_name} handles a clubhouse, I'm happy to tell you over lunch. I'll be honest about it.",
   yesLabel:'Lunch',noLabel:'Another Time',
   yesEffect:{manConf:1},noEffect:{},
   yesMsg:"Lunch it is. I'll tell you the good stories first.",
   noMsg:"Another time, then.",
   _rapport:{yes:5,no:-1},_ttl:4},
]);
