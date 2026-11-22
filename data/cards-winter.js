/**
 * data/cards-winter.js
 * r218 §122.97 The winter, a day at a time (message plan, release 5): from the day after our last game to the eve of
 * spring, a quiet day (fewer than two decisions due that day) gets one of these, at midday (WinterStory).
 *
 *   _winter: 'out'     while the postseason goes on without us
 *            'winter'  once the postseason is over (the summary, the offseason)
 *            'any'     either
 *   _winterMax         how many times a winter it may come (default once)
 *   _needsChampion     the World Series is over, and we didn't win it (a parade has its own message)
 *
 * Each is an ordinary pool card otherwise (tokens, money, actions, relationships).
 */

export const WINTER_POOL = [

  // ── while the postseason goes on without us ──
  {id:'wt_exit',_winter:'out',autoResolve:'no',type:'normal',tag:'CULTURE',sender:'{manager_name} (Manager)',avatar:'📋',
   subject:"{pl_player_name}'s exit meeting",
   preview:"{pl_player_name} asked for a bigger role next year…",
   body:"I finished the exit meetings today. {pl_player_name} asked straight out for a bigger role next year. I'd like to tell them we'll look at it honestly this winter — it keeps them working, and it's true. Or I tell them where they stand right now, which is harder to hear and cleaner in the spring.",
   yesLabel:"Tell Them We'll Look",noLabel:'Tell Them Where They Stand',
   yesEffect:{morale:1},noEffect:{},
   yesMsg:"Told them. They left the room lighter.",noMsg:"Told them. They didn't like it, but they heard it.",
   _relYes:{pl_nm:2},_relNo:{pl_nm:-1,mgr_nm:1}},

  {id:'wt_scouts_october',_winter:'out',autoResolve:'no',type:'normal',tag:'SCOUTING',sender:'Scouting',avatar:'🔭',
   subject:"Scouts at the rest of the postseason?",
   preview:"We'd like to keep two scouts on the road through October…",
   body:"We'd like to keep two scouts on the road through the rest of the postseason — {misc_cost_xs} in travel. Half the players in this winter's free-agent class are still playing, and October is where you see who they really are. We'd come back with a read on the market before it opens. Or we bring everyone home and work from video.",
   yesLabel:'Keep Them Out',noLabel:'Bring Them Home',
   yesEffect:{},noEffect:{},
   yesMsg:"Two scouts stay out. Their read on the market will follow.",noMsg:"Everyone's home. Video it is.",
   onYes:'fd_fa_look',_budgetCost:'misc_cost_xs'},

  {id:'wt_winterball',_winter:'out',autoResolve:'no',type:'normal',tag:'TRAINING',sender:'{hitting_coach_name} (Hitting Coach)',avatar:'🎯',
   subject:"Winter ball for {active_hitter_name}",
   preview:"A winter league club wants {active_hitter_name} for six weeks…",
   body:"A winter league club wants {active_hitter_name} ({active_hitter_pos}) for six weeks. Everyday at-bats against good pitching is the best development there is this time of year. It's also more baseball on a body that just played a full season, and they come to spring a little more tired.",
   yesLabel:'Let Them Go',noLabel:'Rest This Winter',
   yesEffect:{morale:-1},noEffect:{morale:1},
   yesMsg:"They're going. I'll keep in touch with their manager down there.",noMsg:"Resting. Fresh legs for spring.",
   onYes:'offday_session',_trainGain:2},

  {id:'wt_renewals',_winter:'out',autoResolve:'no',type:'normal',tag:'FINANCE',sender:'Ticket Office',avatar:'🎟️',
   subject:"Season-ticket renewals",
   preview:"Renewals open next week, and we need a price…",
   body:"Season-ticket renewals open next week, and we need a price. Raising it brings in {event_rev_sm} more before spring, and most renewals will come through anyway. Some won't, and the ones who do will grumble all season. Or we hold the price and thank them for sticking with us.",
   yesLabel:'Raise the Price',noLabel:'Hold the Price',
   yesEffect:{atmo:-2},noEffect:{atmo:1},
   yesMsg:"Raised. The letters go out Monday.",noMsg:"Held. The letters go out Monday with a thank-you.",
   _revenueToken:'event_rev_sm'},

  {id:'wt_studio',_winter:'out',autoResolve:'no',type:'normal',tag:'MARKETING',sender:'PR Dept.',avatar:'🎙️',
   subject:"A night in the postseason studio",
   preview:"A network wants you in the studio for a postseason game…",
   body:"A network wants you in the studio for one of the postseason games this week — an hour of talk before the first pitch. It puts the club in front of the whole league. It also puts you on the record about clubs you'll be trading with this winter, so choose your words.",
   yesLabel:'Do the Show',noLabel:'Pass',
   yesEffect:{atmo:2},noEffect:{},
   yesMsg:"Booked. A car picks you up at five.",noMsg:"Passed. They'll ask again next year."},

  {id:'wtn_series',_winter:'out',_winterMax:2,_needsSeries:true,autoResolve:'yes',type:'normal',tag:'SCOUTING',sender:'Scouting',avatar:'📺',_toastOnly:true,
   subject:"The postseason, without us",
   preview:"{series_line}",
   body:"{series_line} We're watching every game; most of the clubs still playing have players in this winter's free-agent class.",
   yesLabel:'Understood',noLabel:'Understood',yesEffect:{},noEffect:{}},

  {id:'wtn_cleanout',_winter:'out',_winterMax:1,autoResolve:'yes',type:'normal',tag:'OPERATIONS',sender:'Equipment Mgr.',avatar:'🧢',_toastOnly:true,
   subject:"Clean-out day",
   preview:"The lockers are empty…",
   body:"The lockers are empty. Everyone's gone home — a few hugs, a few long goodbyes. We've packed the gear for the winter and sent the bats out to be checked. The room is very quiet.",
   yesLabel:'Understood',noLabel:'Understood',yesEffect:{},noEffect:{}},

  // ── the winter ──
  {id:'wt_caravan',_winter:'any',autoResolve:'no',type:'good',tag:'MARKETING',sender:'Community Relations',avatar:'🚌',
   subject:"A winter caravan",
   preview:"We'd like to take a few players around the region this winter…",
   body:"We'd like to take a few players around the region this winter — schools, hospitals, a stop in every town within three hours. It costs {misc_cost_xs}, and it's the best way we know to sell tickets in January. The players who go give up a week of their winter.",
   yesLabel:'Run the Caravan',noLabel:'Skip It',
   yesEffect:{atmo:4,morale:-1},noEffect:{},
   yesMsg:"The caravan is on. We'll have the route by next week.",noMsg:"Skipped this year.",
   _budgetCost:'misc_cost_xs'},

  {id:'wt_party',_winter:'any',autoResolve:'no',type:'good',tag:'STAFF',sender:'{owner_name}',avatar:'🎉',
   subject:"A party for the staff",
   preview:"I'd like to throw something for the staff…",
   body:"The coaches and the front office worked hard this year. I'd like to throw something for them — dinner, families welcome, a few awards. It's {misc_cost_xs} out of the club's funds. Or we skip it; nobody expects it.",
   yesLabel:'Throw the Party',noLabel:'Skip It',
   yesEffect:{},noEffect:{},
   yesMsg:"Good. I'll take care of the details.",noMsg:"Fair enough. Another year.",
   _relYes:{mgr_nm:1,pc_nm:1,hc_nm:1,bc_nm:1},_budgetCost:'misc_cost_xs'},

  {id:'wt_strength',_winter:'any',autoResolve:'no',type:'normal',tag:'TRAINING',sender:'Head Trainer',avatar:'🏋️',
   subject:"A winter program for {active_pitcher_who}",
   preview:"We'd like {active_pitcher_who} on a supervised winter program…",
   body:"We'd like {active_pitcher_who} ({active_pitcher_pos}) on a supervised strength program this winter — one of our trainers with them three days a week. It's {misc_cost_xs}, and pitchers who do it come to spring stronger. Or they train on their own, the way most do.",
   yesLabel:'Fund the Program',noLabel:'Train on Their Own',
   yesEffect:{},noEffect:{},
   yesMsg:"Funded. The trainer flies out next week.",noMsg:"On their own, then.",
   onYes:'offday_session',_trainGain:2,_budgetCost:'misc_cost_xs'},

  {id:'wt_fanfest',_winter:'winter',autoResolve:'no',type:'good',tag:'MARKETING',sender:'PR Dept.',avatar:'🎪',
   subject:"A winter fan fest",
   preview:"We'd like to open the ballpark for a fan fest in January…",
   body:"We'd like to open the ballpark for a fan fest in January — autographs, tours of the clubhouse, the new season's schedule unveiled on the scoreboard. It's {misc_cost_sm} to put on, and it fills the season-ticket line before spring. Or we wait for Opening Day.",
   yesLabel:'Hold the Fan Fest',noLabel:'Wait for Spring',
   yesEffect:{atmo:4},noEffect:{atmo:-1},
   yesMsg:"Fan fest is on the calendar.",noMsg:"We'll wait for spring.",
   _budgetCost:'misc_cost_sm'},

  // r254 §122.133 two Opening Day decisions that take weeks to set up: out of the Opening Day morning, into the winter
  {id:'wt_flyover',_winter:'winter',autoResolve:'no',type:'normal',tag:'OPERATIONS',sender:'Stadium Ops.',avatar:'✈️',
   subject:"An Opening Day flyover?",
   preview:"The requests for Opening Day flyovers are due this month…",
   body:"The requests for Opening Day flyovers are due this month, and they take weeks to approve. A flyover for the anthem runs {misc_cost_sm}. It's a big moment and the crowd will remember it. Keeping the ceremony on the ground saves the money, and nobody will miss what they didn't expect.",
   yesLabel:'Request the Flyover',noLabel:'Keep It on the Ground',
   yesEffect:{atmo:4},noEffect:{},
   yesMsg:"Requested. We'll have the approval before spring.",noMsg:"A clean, simple ceremony, then.",
   _budgetCost:'misc_cost_sm'},

  {id:'wt_scarves',_winter:'winter',autoResolve:'no',type:'normal',tag:'CULTURE',sender:'Community Relations',avatar:'🎟️',
   subject:"A scarf for every fan on Opening Day?",
   preview:"If we order now, every fan gets a scarf at the gate on Opening Day…",
   body:"If we order now, the scarves are here in time for every fan at the gate on Opening Day ({misc_cost_xs}): a small thank-you for sticking with us, and it wins back the ones who were thinking about it. Saving it keeps the money, but the fans who come back will notice nobody thanked them.",
   yesLabel:'Order the Scarves',noLabel:'Save It',
   yesEffect:{atmo:4},noEffect:{atmo:-1},
   yesMsg:"Ordered. They'll be in the warehouse by spring.",noMsg:"Saved.",
   _budgetCost:'misc_cost_xs'},

  {id:'wt_clubhouse',_winter:'winter',autoResolve:'no',type:'normal',tag:'FACILITIES',sender:'Facilities Mgmt.',avatar:'🔧',
   subject:"The clubhouse, over the winter",
   preview:"The clubhouse is empty until spring — a good time for work…",
   body:"The clubhouse is empty until spring, which makes this the time for work: new lockers, a bigger kitchen, the training room redone. It's {misc_cost_sm}. The players would come back to a room that feels like the club cares. Or we paint it and wait another year.",
   yesLabel:'Redo the Clubhouse',noLabel:'Paint It',
   yesEffect:{morale:3},noEffect:{},
   yesMsg:"Work starts Monday. It'll be done before camp.",noMsg:"A fresh coat of paint, then.",
   _budgetCost:'misc_cost_sm'},

  {id:'wt_clinic',_winter:'any',autoResolve:'no',type:'good',tag:'MARKETING',sender:'{pitching_coach_name} (Pitching Coach)',avatar:'⚾',
   subject:"A clinic for the high school coaches",
   preview:"The high school coaches asked me to run a clinic…",
   body:"The high school coaches around town asked me to run a pitching clinic this winter — a Saturday, a few hundred coaches and players. It's good for the club, and some of those kids will be prospects one day. It's also a Saturday of my winter, and I'd want a couple of our pitchers there with me.",
   yesLabel:'Run the Clinic',noLabel:'Not This Winter',
   yesEffect:{atmo:2},noEffect:{},
   yesMsg:"I'll set it up for a Saturday in January.",noMsg:"Not this winter. I'll tell them next year.",
   _relYes:{pc_nm:1}},

  {id:'wt_uniform',_winter:'winter',autoResolve:'no',type:'good',tag:'MARKETING',sender:'Partnerships',avatar:'👕',
   subject:"An alternate uniform",
   preview:"An apparel partner has designs for an alternate uniform…",
   body:"Our apparel partner has designs for an alternate uniform — the city's colors, worn on Friday nights. It's {misc_cost_sm} to produce, and the merchandise usually pays it back over a season or two. The traditionalists will grumble.",
   yesLabel:'Approve the Uniform',noLabel:'Keep What We Have',
   yesEffect:{atmo:3},noEffect:{},
   yesMsg:"Approved. The unveiling will be at the fan fest.",noMsg:"Keeping what we have.",
   _budgetCost:'misc_cost_sm'},

  {id:'wt_analyst',_winter:'any',autoResolve:'no',type:'normal',tag:'STAFF',sender:'Scouting',avatar:'📊',
   subject:"A winter hire for the numbers",
   preview:"We'd like to add an analyst for the winter…",
   body:"We'd like to add an analyst for the winter — someone to go through every pitch we threw this year and tell us what we're missing. It's {misc_cost_xs} for the contract. The coaches are skeptical; they think they already know.",
   yesLabel:'Make the Hire',noLabel:'Trust the Coaches',
   yesEffect:{ovr:1},noEffect:{},
   yesMsg:"Hired. The first report will be ready before camp.",noMsg:"No hire. The coaches have it.",
   _relNo:{pc_nm:1,hc_nm:1},_budgetCost:'misc_cost_xs'},

  {id:'wt_mentor',_winter:'any',autoResolve:'no',type:'good',tag:'CULTURE',sender:'{manager_name} (Manager)',avatar:'📋',
   subject:"{leader_player_name}'s winter workouts",
   preview:"{leader_player_name} offered to have the young players work out with them…",
   body:"{leader_player_name} offered to have our young players work out with them this winter — a month together, their place, their routine. It's the kind of thing that builds a clubhouse. The club would cover the travel and the housing, {misc_cost_xs}. Or everyone trains at home.",
   yesLabel:'Cover the Travel',noLabel:'Train at Home',
   yesEffect:{morale:2},noEffect:{},
   yesMsg:"Covered. The young ones are excited.",noMsg:"At home this winter. I'll let them know.",
   _relYes:{ldr_nm:2},_relNo:{ldr_nm:-1},_budgetCost:'misc_cost_xs'},

  {id:'wt_minicamp',_winter:'winter',autoResolve:'no',type:'normal',tag:'TRAINING',sender:'Player Development',avatar:'🏋️',
   subject:"A January minicamp",
   preview:"We'd like to bring the young players in for a week in January…",
   body:"We'd like to bring the young players in for a week in January — conditioning, fundamentals, a first look at the new staff's way of doing things. It's {misc_cost_xs}, and they come to camp a step ahead. The veterans won't be invited, and a few will notice.",
   yesLabel:'Hold the Minicamp',noLabel:'Wait for Camp',
   yesEffect:{ovr:1},noEffect:{},
   yesMsg:"Minicamp is set for the second week of January.",noMsg:"We'll wait for camp.",
   _budgetCost:'misc_cost_xs'},

  // ── the winter's news ──
  {id:'wtn_champ',_winter:'winter',_needsChampion:true,autoResolve:'yes',type:'normal',tag:'SCOUTING',sender:'{manager_name} (Manager)',avatar:'🏆',_toastOnly:true,
   subject:"The {champion_name} won it all",
   preview:"The {champion_name} won the World Series…",
   body:"The {champion_name} won the World Series. I watched every inning of it, and I'll be honest: I'd rather it had been us. Every club starts at zero in the spring.",
   yesLabel:'Understood',noLabel:'Understood',yesEffect:{},noEffect:{}},

  {id:'wtn_mail',_winter:'winter',_winterMax:2,autoResolve:'yes',type:'good',tag:'MARKETING',sender:'PR Dept.',avatar:'✉️',_toastOnly:true,
   subject:"Mail from the fans",
   preview:"The mail keeps coming, even in winter…",
   body:"The mail keeps coming, even in winter — cards, drawings, a few strong opinions about the lineup. The most common question by far: when do tickets go on sale.",
   yesLabel:'Understood',noLabel:'Understood',yesEffect:{},noEffect:{}},

  // r233 §122.112 two decisions that belong to the winter, not the first day of spring
  {id:'wtn_uniforms',_winter:'winter',autoResolve:'yes',type:'normal',tag:'OPERATIONS',sender:'Equipment Mgr.',avatar:'🧢',
   subject:"Which uniforms for Opening Day?",
   preview:"The order for next season's uniforms goes in soon…",
   body:"The order for next season's uniforms goes in soon, and I need to know which set goes in the lockers on Opening Day. Our uniform sponsor has offered {misc_cost_xs} to debut the new set that day. The fans love the throwbacks, and the stands would be full of them.",
   yesLabel:'The Sponsor\'s Set',noLabel:'The Throwbacks',
   yesEffect:{atmo:-1},noEffect:{atmo:3},
   yesMsg:"The new set it is. The sponsor's check is on the way.",
   noMsg:"Throwbacks for Opening Day. The fans will love it. The sponsor won't call.",
   _revenueToken:'misc_cost_xs'},

  {id:'wtn_field_prep',_winter:'winter',autoResolve:'no',type:'normal',tag:'OPERATIONS',sender:'Head Groundskeeper',avatar:'🌱',
   _fieldNote:{days:120,yes:"The full prep before spring is under way.",no:"We're doing a partial prep before spring, like you said."},
   subject:"Field prep before spring",
   preview:"I'd like to start on the field before spring…",
   body:"I'd like to start on the field before spring — regrading the warning track, resodding the infield corners and testing the irrigation. Full prep runs {grounds_crew_cost}. A partial job saves money but leaves the field below standard for Opening Day.",
   yesLabel:'Full Prep',noLabel:'Partial Job',
   yesEffect:{morale:2,atmo:3},noEffect:{atmo:-2},
   yesMsg:"Full prep it is. The ballpark will be ready.",noMsg:"Partial prep. A few rough edges heading into the season.",
   _budgetCost:'grounds_crew_cost'},

  {id:'wtn_field',_winter:'winter',autoResolve:'yes',type:'normal',tag:'FACILITIES',sender:'Head Groundskeeper',avatar:'🌱',_toastOnly:true,
   subject:"The field is put away for the winter",
   preview:"The field is put away for the winter…",
   body:"The field is put away for the winter — the grass is cut low and covered, the mound and the plate areas are tarped. We'll start bringing it back a month before Opening Day.",
   yesLabel:'Understood',noLabel:'Understood',yesEffect:{},noEffect:{}},

  {id:'wtn_checkin',_winter:'any',_winterMax:2,autoResolve:'yes',type:'normal',tag:'CULTURE',sender:'{manager_name} (Manager)',avatar:'📋',_toastOnly:true,
   subject:"Checking in on the players",
   preview:"I've been calling around to the players…",
   body:"I've been calling around to the players. {leader_player_name} is already throwing and hitting again, and most of the others are resting the way they should. Nobody is hurt.",
   yesLabel:'Understood',noLabel:'Understood',yesEffect:{},noEffect:{}},
];
