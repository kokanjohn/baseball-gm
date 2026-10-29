/**
 * data/cards-moments.js
 * §80 First moments — the cards that mark a club's milestones:
 *   takeover       the day the GM takes over the club (a new team)
 *   camp_open      the first day of spring camp (every season after the first)
 *   spring_opener  before the first spring game of a season
 *   opening_day    before the first regular-season game
 *
 * Each moment has many versions. `_when` narrows a version to a situation
 * (all keys optional):
 *   archetypes: [ids]           the owner's archetype
 *   season:     'first' | 'returning'
 *   last:       'winning' | 'losing'   last season's record (returning only)
 *   funds:      'flush' | 'tight'      Club Funds against the payroll target
 * CardEngine.deliverMomentCard picks among the versions that fit, preferring
 * ones this device has never shown (across every team and season), so a new
 * team or a new season never opens on the same message twice in a row.
 * Card shape is the pool's (cards-pool.js); tokens resolve the same way.
 */

export const MOMENT_CARDS = Object.freeze({

  // ── The day the GM takes over ───────────────────────────────────────────
  takeover: [
    {id:'mo_take_presser',type:'good',tag:'CULTURE',sender:'PR Dept.',avatar:'🎤',
     subject:'Your introductory press conference is set',
     preview:'The media wants to meet the new GM of the {team_name}…',
     body:'The {team_city} press corps wants its first look at the new GM. PR has a podium, a backdrop and a short list of questions they expect: the roster, the payroll and what fans should expect this year. You can promise a winner out loud — the fan base will love it and remember it — or keep it measured and let the work speak.',
     yesLabel:'Promise a Winner',noLabel:'Keep It Measured',
     yesEffect:{atmo:4,ownerTrust:-2},noEffect:{atmo:1,ownerTrust:2},
     yesMsg:'Headline tomorrow: "New GM: We\'re Here to Win Now." The phones lit up.',
     noMsg:'A steady first impression. One columnist called it "refreshingly honest."'},

    {id:'mo_take_owner_dinner',type:'normal',tag:'OWNERSHIP',sender:'{owner_name}',avatar:'🍽️',_when:{archetypes:['empire','contender']},
     subject:'Dinner with ownership — they want to hear the plan',
     preview:'{owner_name} wants your plan for the {team_nickname} over dinner…',
     body:'{owner_name}: "Welcome aboard. I didn\'t bring you here to rebuild — I brought you here to win. Dinner at my club. Bring the plan." You can walk in with a bold, specific plan for this season, or ask for the first month to evaluate the roster before committing to anything.',
     yesLabel:'Bring a Bold Plan',noLabel:'Ask for a Month to Evaluate',
     yesEffect:{ownerTrust:4,morale:1},noEffect:{ownerTrust:-2},
     yesMsg:'Ownership loved it. "That\'s what I want to hear." Now it has to happen.',
     noMsg:'"A month," ownership repeated, not smiling. "Fine. Use it well."'},

    {id:'mo_take_owner_note',type:'normal',tag:'OWNERSHIP',sender:'{owner_name}',avatar:'✉️',_when:{archetypes:['ember','lab','institution']},
     subject:'A handwritten note from ownership',
     preview:'"Build it the right way" — a note waiting on your desk…',
     body:'A note is waiting on your new desk: "We hired you for the long run. Build it the right way — I\'d rather be patient than lucky." Ownership is offering to hold a town hall with season-ticket holders to set expectations together. Do it alongside them, or let the work introduce you?',
     yesLabel:'Hold the Town Hall Together',noLabel:'Let the Work Introduce Me',
     yesEffect:{ownerTrust:3,atmo:2},noEffect:{ownerTrust:1},
     yesMsg:'Packed room. Tough questions, honest answers. Ownership was pleased.',
     noMsg:'Quiet start. Ownership respects it — for now.'},

    {id:'mo_take_gambler',type:'normal',tag:'OWNERSHIP',sender:'{owner_name}',avatar:'🎲',_when:{archetypes:['gambler']},
     subject:'Ownership: "Make some noise"',
     preview:'{owner_name} wants a splash on day one…',
     body:'{owner_name} called before you\'d found the coffee machine: "First day, let\'s make some noise. Billboard on the interstate, your face, the words \'New Era\'. Costs {misc_cost_xs}. Or are you a quiet type? I can\'t tell yet."',
     yesLabel:'Put Up the Billboard',noLabel:'Stay Quiet',
     yesEffect:{atmo:4,ownerTrust:2},noEffect:{ownerTrust:-1},
     yesMsg:'Billboard is up. Somebody already drew a mustache on it. Ownership loves it.',
     noMsg:'"Quiet," ownership said. "Interesting." It didn\'t sound like a compliment.',
     _budgetCost:'misc_cost_xs'},

    {id:'mo_take_manager',type:'normal',tag:'COACHING',sender:'{manager_name} (Manager)',avatar:'📋',
     subject:'{manager_name} wants a word before camp',
     preview:'The manager wants to know where things stand with the new GM…',
     body:'{manager_name} knocked on your open door: "New GM usually means a new manager eventually. I\'d rather know now. Do I have your support going into camp, or am I auditioning?" You can offer public support, or say the season decides it.',
     yesLabel:'Public Support',noLabel:'"The Season Decides"',
     yesEffect:{manConf:6,morale:2},noEffect:{manConf:-3,ownerTrust:1},
     yesMsg:'A handshake that lasted a second longer than usual. The clubhouse heard about it before long.',
     noMsg:'"Fair enough." Expect a tight camp — and everyone in it knows why.'},

    {id:'mo_take_clubhouse',type:'normal',tag:'CULTURE',sender:'{bench_coach_name} (Bench Coach)',avatar:'🧢',
     subject:'The players are waiting to meet you',
     preview:'The players want to hear from the new GM before the first game…',
     body:'{bench_coach_name}: "The players want a clubhouse meeting before the first game. The veterans want to know if you\'re going to blow it up. Some of the kids just want to know your name." Speak to the whole room, or skip the speech and meet them one at a time over the week?',
     yesLabel:'Address the Whole Room',noLabel:'One at a Time',
     yesEffect:{morale:3},noEffect:{morale:1,manConf:1},
     yesMsg:'Short, direct, no promises you can\'t keep. A couple of veterans nodded.',
     noMsg:'Slower, but personal. A few players mentioned it to the beat writers.'},

    {id:'mo_take_tight',type:'normal',tag:'FINANCE',sender:'{cfo_name} (CFO)',avatar:'💼',_when:{funds:'tight'},
     subject:'The CFO\'s first briefing: the books are thin',
     preview:'{cfo_name} wants ten minutes on the money before you spend any of it…',
     body:'{cfo_name}: "Welcome. Before you spend a dollar — we\'re thinner than the brochure says. Payroll runs every two weeks and the gate won\'t carry us until the weather turns. I\'d like a spending freeze on non-baseball items through camp." Freeze it, or keep the operation running at full speed?',
     yesLabel:'Freeze Non-Baseball Spending',noLabel:'Full Speed',
     yesEffect:{ownerTrust:2,atmo:-1},noEffect:{atmo:1},
     yesMsg:'Freeze in place. The CFO relaxed visibly. Someone cancelled the fruit trays.',
     noMsg:'Full speed. "Your call," the CFO said, already updating a spreadsheet.'},

    {id:'mo_take_fans',type:'good',tag:'CULTURE',sender:'Community Relations',avatar:'📣',
     subject:'Fans are lined up outside the team store',
     preview:'Word got out about the new GM — a crowd is gathering at the team store…',
     body:'Word got out. A few hundred fans are outside the {team_nickname} team store hoping to catch the new GM. Community Relations can set up a table and you sign for an hour, or they can tell the crowd you\'re in meetings all day.',
     yesLabel:'Go Out and Meet Them',noLabel:'Stay in Meetings',
     yesEffect:{atmo:3},noEffect:{atmo:-1},
     yesMsg:'An hour turned into two. A kid asked if you\'d trade for a favorite player from another club. You said you\'d look into it.',
     noMsg:'The crowd thinned out early. Somebody posted a photo of the closed blinds.'},
  ],

  // ── First day of camp (seasons after the first) ─────────────────────────
  camp_open: [
    {id:'mo_camp_win_hangover',type:'normal',tag:'COACHING',sender:'{manager_name} (Manager)',avatar:'📋',_when:{last:'winning'},
     subject:'Camp opens — {manager_name} on avoiding a hangover',
     preview:'Coming off {last_record}, the manager is worried about a comfortable clubhouse…',
     body:'{manager_name}: "Coming off {last_record}, everybody walked in smiling. That\'s what scares me. I want to open camp with a hard week — set the tone that last year is over. Or we ride the good feeling and ease them in."',
     yesLabel:'Hard Week — Last Year Is Over',noLabel:'Ride the Good Feeling',
     yesEffect:{manConf:3,morale:-1},noEffect:{morale:3},
     yesMsg:'First day: 7 a.m. fielding drills. Nobody\'s smiling now, and that was the point.',
     noMsg:'Loose first week. Laughs in the clubhouse. The manager is watching closely.'},

    {id:'mo_camp_lose_reset',type:'normal',tag:'CULTURE',sender:'{manager_name} (Manager)',avatar:'📋',_when:{last:'losing'},
     subject:'Camp opens — the room still feels last season',
     preview:'After {last_record}, the manager wants to address the clubhouse on day one…',
     body:'{manager_name}: "After {last_record} the room still feels heavy. I want you in there on day one — the GM saying out loud that this year is different. Or I handle it myself and you stay upstairs."',
     yesLabel:'I\'ll Address Them',noLabel:'You Handle It',
     yesEffect:{morale:3,manConf:-1},noEffect:{manConf:3},
     yesMsg:'You named last season for what it was and said it was over. The room exhaled.',
     noMsg:'The manager took it. Players noticed who was in the room and who wasn\'t.'},

    {id:'mo_camp_report_early',type:'good',tag:'CULTURE',sender:'Clubhouse Manager',avatar:'🧳',
     subject:'Half the roster reported early',
     preview:'More than a dozen players showed up before report day…',
     body:'More than a dozen players reported before the official date — the clubhouse is already full. The clubhouse manager can open the facility and the full kitchen staff now (small cost, {misc_cost_xs}) or keep reduced hours until report day.',
     yesLabel:'Open Everything Now',noLabel:'Reduced Hours Until Report Day',
     yesEffect:{morale:3},noEffect:{morale:-1},
     yesMsg:'Kitchen open, cages open. Players noticed the club met them halfway.',
     noMsg:'Reduced hours. A couple of veterans grumbled about cold sandwiches.',
     _budgetCost:'misc_cost_xs'},

    {id:'mo_camp_owner_visit',type:'normal',tag:'OWNERSHIP',sender:'{owner_name}',avatar:'🏟️',
     subject:'Ownership wants to address camp',
     preview:'{owner_name} wants to say a few words to the team on day one…',
     body:'{owner_name} wants to speak to the full squad on the first morning of camp — the season\'s expectations, straight from ownership. Some GMs welcome it; some managers hate it. Allow it, or ask ownership to watch from the stands this year?',
     yesLabel:'Let Ownership Speak',noLabel:'Ask Them to Watch',
     yesEffect:{ownerTrust:3,manConf:-2},noEffect:{ownerTrust:-2,manConf:2},
     yesMsg:'Ten minutes, no notes. Ownership left happy. The manager\'s jaw was tight.',
     noMsg:'Ownership watched from behind the backstop. The manager thanked you quietly.'},

    {id:'mo_camp_tight_funds',type:'normal',tag:'FINANCE',sender:'{cfo_name} (CFO)',avatar:'💼',_when:{funds:'tight'},
     subject:'Camp budget — the CFO wants a trimmed spring',
     preview:'{cfo_name} proposes cutting spring extras with the books where they are…',
     body:'{cfo_name}: "The books came out of the winter thin. I\'d like to trim camp — fewer non-roster invites, a shorter travel list, no charter for the short trips. It saves {misc_cost_sm}." Trim it, or run a full camp?',
     yesLabel:'Trim Camp',noLabel:'Full Camp',
     yesEffect:{morale:-2,ownerTrust:2},noEffect:{morale:1},
     yesMsg:'Trimmed. The CFO\'s spreadsheet looks better. The bus rides got longer.',
     noMsg:'Full camp. "Noted," the CFO said.',
     _budgetCost:{no:'misc_cost_sm'}},

    {id:'mo_camp_flush',type:'good',tag:'OPERATIONS',sender:'Stadium Ops.',avatar:'🛠️',_when:{funds:'flush'},
     subject:'The spring complex upgrade is ready to go',
     preview:'With the books healthy, ops wants to finish the new hitting tunnels before camp…',
     body:'With the books healthy, Stadium Ops can finish the new hitting tunnels and recovery room at the spring complex before the first workout ({misc_cost_sm}). Or push it to next winter.',
     yesLabel:'Finish It Now',noLabel:'Next Winter',
     yesEffect:{morale:3,atmo:1},noEffect:{},
     yesMsg:'Finished in a day. The players found it when they reported.',
     noMsg:'Pushed to next winter. The old tunnels will do.',
     _budgetCost:'misc_cost_sm'},
  ],

  // ── Before the first spring game ────────────────────────────────────────
  spring_opener: [
    {id:'mo_spo_ceremonial',type:'good',tag:'CULTURE',sender:'PR Dept.',avatar:'⚾',
     subject:'Spring opener — who throws the first pitch?',
     preview:'PR needs a name for the ceremonial first pitch before the spring opener…',
     body:'The first spring game is today and PR needs a ceremonial first pitch. {legend_name} is in town and would love it. Or the honor goes to a local youth league coach the community has been campaigning for.',
     yesLabel:'{legend_name}',noLabel:'The Youth Coach',
     yesEffect:{atmo:2,morale:1},noEffect:{atmo:3},
     yesMsg:'A strike, mostly. The old-timers in the stands stood up.',
     noMsg:'Bounced it. Nobody cared. The kids from the youth team went wild.'},

    {id:'mo_spo_starter_pitch_count',type:'normal',tag:'COACHING',sender:'{pitching_coach_name} (Pitching Coach)',avatar:'🎯',
     subject:'First spring start — how long does the starter go?',
     preview:'{pitching_coach_name} wants a pitch limit for today\'s starter…',
     body:'{pitching_coach_name}: "First outing of the spring for {active_sp_name}. My call is a 30-pitch cap — arms aren\'t ready. The ask is 45, to get a real feel." Hold the cap or allow the 45?',
     yesLabel:'Cap It at 30',noLabel:'Allow 45',
     yesEffect:{manConf:1},noEffect:{morale:2,ovr:-1},
     yesMsg:'Two clean innings, an annoyed starter, and a healthy arm.',
     noMsg:'All 45 pitches. "Felt great." The trainer is watching a little closer.'},

    {id:'mo_spo_lineup_kids',type:'normal',tag:'TRAINING',sender:'{manager_name} (Manager)',avatar:'📋',
     subject:'Spring opener lineup — the regulars or the kids?',
     preview:'{manager_name} asks who starts the first spring game…',
     body:'{manager_name}: "Regulars usually get two at-bats in the opener and head to the back fields. But I\'ve got a few kids who\'ve never played in front of a crowd. Start the kids and let the regulars come in late?"',
     yesLabel:'Start the Kids',noLabel:'Regulars First',
     yesEffect:{morale:1,atmo:-1},noEffect:{atmo:1},
     yesMsg:'One of them doubled in a first big-league at-bat and couldn\'t stop grinning.',
     noMsg:'The regulars got their two at-bats. The crowd got the names they came for.'},

    {id:'mo_spo_weather',type:'normal',tag:'OPERATIONS',sender:'Stadium Ops.',avatar:'🌦️',
     subject:'Spring opener — the field is soft after rain',
     preview:'Grounds crew says the infield is soft for today\'s opener…',
     body:'Rain left the infield soft. The grounds crew can bring in drying agent and a second crew ({misc_cost_xs}) to have it right by first pitch, or the game goes on as the field is — it\'s spring.',
     yesLabel:'Bring in the Crew',noLabel:'Play It As Is',
     yesEffect:{morale:1},noEffect:{ovr:-1},
     yesMsg:'Field was fast and true by first pitch. Nobody noticed, which is the point.',
     noMsg:'A couple of bad hops. One of the infielders came off rubbing an ankle.',
     _budgetCost:'misc_cost_xs'},

    {id:'mo_spo_returning_fans',type:'good',tag:'CULTURE',sender:'Community Relations',avatar:'🎟️',_when:{season:'returning'},
     subject:'Spring opener — season-ticket holders get in early',
     preview:'Community Relations wants to open the gates an hour early for season-ticket holders…',
     body:'Community Relations wants to open the gates an hour early for season-ticket holders at the spring opener — batting practice up close, a thank-you for coming back after {last_record}. It costs {misc_cost_xs} in extra staff.',
     yesLabel:'Open Early',noLabel:'Normal Gates',
     yesEffect:{atmo:3},noEffect:{},
     yesMsg:'They lined the rail during BP. A few players signed for twenty minutes.',
     noMsg:'Normal gates.',
     _budgetCost:'misc_cost_xs'},

    {id:'mo_spo_first_look',type:'normal',tag:'CULTURE',sender:'Beat Writer',avatar:'📰',_when:{season:'first'},
     subject:'The beat writers want a word before the first game',
     preview:'Reporters want the new GM\'s first look at the club before the spring opener…',
     body:'The beat writers want five minutes before the first spring game of the new era. They\'ll ask what you\'ve seen so far. Give them something quotable about the club, or keep it to "it\'s early"?',
     yesLabel:'Give Them a Quote',noLabel:'"It\'s Early"',
     yesEffect:{atmo:2,ownerTrust:-1},noEffect:{},
     yesMsg:'Tomorrow\'s headline has your quote in it. Ownership read it twice.',
     noMsg:'"It\'s early," you said. They wrote that down, too.'},
  ],

  // ── Before the first regular-season game ────────────────────────────────
  opening_day: [
    {id:'mo_od_first_pitch',type:'good',tag:'CULTURE',sender:'PR Dept.',avatar:'⚾',
     subject:'Opening Day — the ceremonial first pitch',
     preview:'PR needs your pick for the Opening Day first pitch…',
     body:'Opening Day. PR has two options for the ceremonial first pitch: {legend_name}, a fan favorite who hasn\'t been back to the ballpark in years — or a nurse from the local children\'s hospital chosen by the community.',
     yesLabel:'{legend_name}',noLabel:'The Nurse',
     yesEffect:{atmo:3,morale:1},noEffect:{atmo:4},
     yesMsg:'Standing ovation before the walk to the mound was even halfway done.',
     noMsg:'A strike, right down the middle. The stadium went louder than it did for the anthem.'},

    {id:'mo_od_flyover',type:'normal',tag:'OPERATIONS',sender:'Stadium Ops.',avatar:'✈️',_when:{funds:'flush'},
     subject:'Opening Day flyover is available',
     preview:'Ops can book a flyover for the anthem — a short window to confirm…',
     body:'A flyover for the Opening Day anthem is available if we confirm now ({misc_cost_sm}). It\'s a big moment and the crowd will remember it. Or keep the ceremony on the ground.',
     yesLabel:'Book the Flyover',noLabel:'Keep It on the Ground',
     yesEffect:{atmo:4},noEffect:{},
     yesMsg:'Timed perfectly to the last note. The roar shook the press box.',
     noMsg:'A clean, simple ceremony.',
     _budgetCost:'misc_cost_sm'},

    {id:'mo_od_lineup_speech',type:'normal',tag:'COACHING',sender:'{manager_name} (Manager)',avatar:'📋',
     subject:'Opening Day — {manager_name} asks you to say something',
     preview:'The manager wants the GM to speak to the team before Opening Day…',
     body:'{manager_name}: "First game that counts. I\'d like you to say something to them before they take the field — a minute, no more. Or I can do it. Your call."',
     yesLabel:'I\'ll Say a Few Words',noLabel:'That\'s Your Room',
     yesEffect:{morale:2},noEffect:{manConf:2},
     yesMsg:'Short and real. A couple of players tapped the logo on the way out.',
     noMsg:'The manager handled it — and appreciated the trust.'},

    {id:'mo_od_owner_box',type:'normal',tag:'OWNERSHIP',sender:'{owner_name}',avatar:'🥂',
     subject:'Ownership invites you to the owner\'s box',
     preview:'{owner_name} wants you upstairs with the sponsors for Opening Day…',
     body:'{owner_name} wants you in the owner\'s box for Opening Day — sponsors, local officials, handshakes. Most GMs watch from their own suite where they can actually see the game. Go upstairs, or politely stay put?',
     yesLabel:'Go Upstairs',noLabel:'Watch From My Suite',
     yesEffect:{ownerTrust:3},noEffect:{ownerTrust:-1},
     yesMsg:'Nine innings of small talk. Ownership introduced you to everyone as "my GM."',
     noMsg:'You saw every pitch. Ownership sent a text in the 4th: "Missed you up here."'},

    {id:'mo_od_after_losing',type:'normal',tag:'CULTURE',sender:'Community Relations',avatar:'🎟️',_when:{last:'losing'},
     subject:'Opening Day — win back the fans?',
     preview:'After {last_record}, Community Relations wants to give something back on Opening Day…',
     body:'After {last_record}, there are empty seats in the season-ticket report. Community Relations wants to give every fan a free scarf at the gate on Opening Day ({misc_cost_xs}) — a small "thank you for sticking with us." Or save it.',
     yesLabel:'Give Away the Scarves',noLabel:'Save It',
     yesEffect:{atmo:4},noEffect:{atmo:-1},
     yesMsg:'A sea of team colors in the stands. It looked like a winner\'s crowd.',
     noMsg:'Plenty of empty seats in the upper deck.',
     _budgetCost:'misc_cost_xs'},

    {id:'mo_od_after_winning',type:'good',tag:'CULTURE',sender:'PR Dept.',avatar:'🏆',_when:{last:'winning'},
     subject:'Opening Day — raise last season\'s banner?',
     preview:'PR wants to mark last season\'s {last_record} on Opening Day…',
     body:'PR wants to mark last season\'s {last_record} with a short video and a banner before first pitch. Some in the clubhouse would rather leave last year behind. Celebrate it, or keep the focus on today?',
     yesLabel:'Celebrate It',noLabel:'Focus on Today',
     yesEffect:{atmo:3,morale:1},noEffect:{manConf:2},
     yesMsg:'The video got the place on its feet. A few players watched from the dugout rail.',
     noMsg:'No video. The manager liked that.'},

    {id:'mo_od_first_season',type:'normal',tag:'CULTURE',sender:'Beat Writer',avatar:'📰',_when:{season:'first'},
     subject:'Opening Day — the new era\'s first game that counts',
     preview:'The beat writers want a prediction from the new GM…',
     body:'First game that counts under the new GM. The beat writers are asking everyone in a front-office polo for a prediction. Give them a win total, or decline?',
     yesLabel:'Give Them a Number',noLabel:'Decline',
     yesEffect:{atmo:3,ownerTrust:-2},noEffect:{ownerTrust:1},
     yesMsg:'Your number is on the back page. It will be quoted back to you in September.',
     noMsg:'No number. "Ask me in October," you said.'},
  ],
});
