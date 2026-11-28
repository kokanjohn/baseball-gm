/**
 * data/cards-profile.js
 * r219 §122.98 What the club has come to expect of the GM, said by the people who'd notice (GMProfile). Each comes
 * only when the profile leans far enough (`_profile`: { dimension: { min } | { max } }); they join the decisions pool.
 */
export const PROFILE_POOL = [

  {id:'pf_spend',autoResolve:'no',_weight:1.2,type:'normal',tag:'FINANCE',sender:'Finance Dept.',avatar:'💼',
   _profile:{spender:{min:0.45}},_minGames:30,_oncePerSeason:true,onYes:'spend_freeze',
   subject:"The small asks are adding up",
   preview:"Since the season began, the club has said yes to {spent_count} of the smaller asks…",
   body:"Since the season began, the club has said yes to {spent_count} of the smaller asks — {spent_total} in all. None of them is much on its own; together they're real money. We'd suggest holding back for a month: the staff will bring fewer of them, and only the ones that matter. Or keep going. Most of them have been worth it.",
   yesLabel:'Hold Back for a Month',noLabel:'Keep Going',
   yesEffect:{},noEffect:{},
   yesMsg:"Noted. We've told the department heads.",noMsg:"Understood. We'll keep tracking it."},

  {id:'pf_community', party:'city', partyBig:'no', partyMoment:{ yes:'the gift to the youth fund', no:'the youth fund gift you held back' },  /* r298 §122.185 memory */autoResolve:'no',_weight:1.2,type:'urgent',tag:'MARKETING',sender:'Community Relations',avatar:'🤝',
   _profile:{communityFocused:{max:-0.45}},_minGames:30,_oncePerSeason:true,
   subject:"The city has noticed",
   preview:"We've turned down {community_no} of the city's requests this season…",
   body:"We've turned down {community_no} of the city's requests this season, and it's been noticed — a council member asked about it on the radio this week. A gift to the city's youth fund ({misc_cost_sm}) would say more than any statement. Or we hold the line; the club is a business, and most people understand that.",
   yesLabel:'Make the Gift',noLabel:'Hold the Line',
   yesEffect:{atmo:4},noEffect:{atmo:-2},
   yesMsg:"The gift goes out this week. We'll make sure the right people hear about it.",noMsg:"Holding the line. We'll weather it.",
   _budgetCost:'misc_cost_sm'},

  {id:'pf_loyal',autoResolve:'yes',_weight:1.0,type:'good',tag:'CULTURE',sender:'{manager_name} (Manager)',avatar:'📋',
   _profile:{loyal:{min:0.5}},_minGames:40,_oncePerSeason:true,_toastOnly:true,
   subject:"Something the agents say",
   preview:"When an agent calls about one of ours, the first thing they mention…",
   body:"Something I've noticed: when an agent calls about one of ours, the first thing they mention is how you treat your own players. It makes my job easier, and it'll make the next round of contract talks easier too.",
   yesLabel:'Understood',noLabel:'Understood',yesEffect:{morale:1},noEffect:{morale:1}},

  {id:'pf_transactional',autoResolve:'yes',_weight:1.0,type:'normal',tag:'CULTURE',sender:'{manager_name} (Manager)',avatar:'📋',
   _profile:{loyal:{max:-0.5}},_minGames:40,_oncePerSeason:true,_toastOnly:true,
   subject:"Faces coming and going",
   preview:"The clubhouse has noticed how many faces have come and gone…",
   body:"The clubhouse has noticed how many faces have come and gone. Nobody says it to me directly, but the players are guarding themselves a little — and their agents will be harder to deal with when contracts come up.",
   yesLabel:'Understood',noLabel:'Understood',yesEffect:{morale:-1},noEffect:{morale:-1}},
];
