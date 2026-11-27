/**
 * data/cards-around.js
 * r297 §122.183 Around the game, the first set (§122.182), written in parts (MessageParts, §122.176): each comes back
 * without reading alike. The facts in braces ({opp_bat}, {form_line}…) are the situation's own (AroundGame.js finds
 * the situation and its facts); the player a message is about is named the usual way ({active_hitter_name}…).
 *
 *   ag_scout          the advance scout before a regular-season series
 *   ag_form_bat       a hitter of ours on a hot run (the hitting coach)
 *   ag_form_arm_hot   an arm of ours on a hot run (the pitching coach)
 *   ag_form_arm_cold  an arm of ours on a cold run (the pitching coach)
 *   ag_crowd_soft     a soft stretch of crowds (the ticket office)
 *   ag_crowd_hot      a run of sellouts (the ticket office)
 *   ag_media_win      a big win: a walk-off, a shutout, a blowout (PR)
 *   ag_media_loss     a blowout loss (PR)
 *
 * Effects are the existing kinds (the user's choice): money, morale, owner trust, atmosphere, a named player's form.
 */

export const AROUND_POOL = [

  // ── The advance scout ──────────────────────────────────────────────────────
  { id: 'ag_scout', _around: 'scout', from: 'dept:advance_scouting', sender: 'Scouting', tag: 'SCOUTING', avatar: '🔭', type: 'normal',
    parts: {
      open: [
        'Advance report on {opp_club} ({opp_record}) ahead of the {series_len}-game set {series_where}.',
        'Our look at {opp_club} is done: {series_len} games {series_where}, and they come in at {opp_record}.',
        '{opp_club_cap} next, {series_len} games {series_where}. They\'re {opp_record}, and here\'s what we saw.',
        'We\'ve had eyes on {opp_club} all week. They\'re {opp_record}, and we get them for {series_len} games {series_where}.',
        'The book on {opp_club} for the {series_len}-game series {series_where}: they\'re {opp_record}.',
        { text: 'You passed on the extra work last time, so this is the short version: {opp_club}, {opp_record}, {series_len} games {series_where}.', when: { last: 'no' } },
        { text: 'No video package last time, so just the basics on {opp_club} ({opp_record}), {series_len} games {series_where}.', when: { last: 'no' } },
        { text: 'Keeping it short since we went without the extra work last series. {opp_club_cap} come in at {opp_record}; {series_len} games {series_where}.', when: { last: 'no' } },
      ],
      ask: [
        'The bat to worry about is {opp_bat}: {opp_bat_line}. On the mound, {opp_arm} has been sharp, with {opp_arm_line}.',
        '{opp_bat} is the one carrying them ({opp_bat_line}). {opp_arm} is their arm in form: {opp_arm_line}.',
        'Their lineup runs through {opp_bat} right now, {opp_bat_line}. Watch {opp_arm} too: {opp_arm_line}.',
        'If one hitter beats us, it\'s {opp_bat} ({opp_bat_line}). And {opp_arm} comes in hot, {opp_arm_line}.',
        '{opp_bat} has been the problem for everyone lately: {opp_bat_line}. Their best arm this week is {opp_arm}, {opp_arm_line}.',
      ],
      stakes: [
        'We can cut a full video package on both of them for {scout_cost}: every pitch, every swing, every tendency.',
        'For {scout_cost} we\'d put a second scout on them and have a pitch-by-pitch breakdown in the clubhouse before the opener.',
        'With {scout_cost} for extra video and a second pair of eyes, the staff would have a real plan for both.',
        'A deeper workup on the two of them runs {scout_cost}. The coaches like having it; the players like it more.',
        'We\'d need {scout_cost} to break down their last two weeks properly. Without it, the staff go off this note.',
      ],
      close: [
        'Want the full package?',
        'Your call on the extra work.',
        'Say the word and it\'s on their lockers by batting practice.',
        'Do we spend it?',
        'Let us know before the opener.',
      ],
    },
    subject: ['Advance report: {opp_club}', 'The scouting report on {opp_club}', 'Scouting {opp_club}', 'Ahead of {opp_club}', 'The book on {opp_club}'],
    preview: ['{opp_bat} and {opp_arm} are the ones to watch…', 'The report on {opp_club} is in…', 'What we saw from {opp_club}…'],
    body: '{@open} {@ask} {@stakes} {@close}',
    yesLabel: ['Do the full package', 'Spend it', 'Get the video done', 'Yes, the full workup'],
    noLabel: ['The report is enough', 'Not this series', 'Skip the extra work', 'We\'re fine as is'],
    yesMsg: ['The package was on every locker by batting practice.', 'The staff went through the video twice before the opener.', 'The extra work is done; the coaches had their plan.'],
    noMsg: ['The staff went off the written report.', 'No extra video this series.', 'The report was posted in the clubhouse as it was.'],
    _budgetCost: 'scout_cost',
    yesEffect: { morale: 1 }, noEffect: {},
    autoResolve: 'no', _ttl: 1 },

  // ── A hitter on a hot run (the hitting coach) ──────────────────────────────
  { id: 'ag_form_bat', _around: 'form', from: 'staff:hittingCoach', sender: '{hitting_coach_name} (Hitting Coach)', tag: 'COACHING', avatar: '🏏', type: 'normal',
    parts: {
      open: [
        '{active_hitter_name} is locked in: {form_line}.',
        'Look at {active_hitter_name} lately: {form_line}.',
        'Something clicked for {active_hitter_name}: {form_line}.',
        '{active_hitter_name} is on a tear, {form_line}.',
      ],
      ask: [
        'I\'d like to add early work while it\'s this good and get the swing on video, so we can find it again when it goes.',
        'I want to use this: early cage work every day this week and a session on tape, so we have the swing to go back to.',
        'This is when I\'d put in the extra work, not in a cold spell. Early sessions, film, the whole thing.',
        'I\'d bank it while it lasts: extra early swings and a film study of what\'s going right.',
      ],
      stakes: [
        'It costs some rest, and some hitters don\'t like anyone touching a hot streak.',
        'The risk is wearing the bat down, and a few hitters get superstitious about changing anything.',
        'It means a little more fatigue, and not every hitter loves the attention while it\'s going well.',
        'Some hitters want to be left alone when it\'s going like this. It\'s a fair worry.',
      ],
      close: [
        'Want me to do it?',
        'Your call.',
        'I can start tomorrow.',
        'Let me know.',
      ],
    },
    subject: ['{active_hitter_name} is locked in', 'A hot bat: {active_hitter_name}', 'Banking {active_hitter_name}\'s swing', '{active_hitter_name} on a tear'],
    preview: ['{active_hitter_name}: {form_line}…', 'While {active_hitter_name} is this hot…', 'Something clicked for {active_hitter_name}…'],
    body: '{@open} {@ask} {@stakes} {@close}',
    yesLabel: ['Do the extra work', 'Bank the swing', 'Start the early sessions'],
    noLabel: ['Leave the routine alone', 'Don\'t touch a hot streak', 'Let it ride'],
    yesMsg: ['The early sessions started the next day; the swing is on film.', 'Extra cage work and a film session for {active_hitter_name}.'],
    noMsg: ['{active_hitter_name}\'s routine stays as it is.', 'Nobody touched the streak.'],
    yesEffect: { ovr: 1, morale: -1 }, noEffect: { morale: 1 },
    _relYes: { act_hi: -1 }, _relNo: { act_hi: 1 },
    autoResolve: 'no', _ttl: 2 },

  // ── An arm on a hot run (the pitching coach) ───────────────────────────────
  { id: 'ag_form_arm_hot', _around: 'form', from: 'staff:pitchingCoach', sender: '{pitching_coach_name} (Pitching Coach)', tag: 'COACHING', avatar: '⚾', type: 'normal',
    parts: {
      open: [
        '{active_pitcher_name} is dealing: {form_line}.',
        '{active_pitcher_name} has been as good as anyone in the league lately, {form_line}.',
        'Quick one on {active_pitcher_name}: {form_line}.',
        '{active_pitcher_name} has found something, {form_line}.',
      ],
      ask: [
        'I want to sit down with the video and pin down what\'s different, the grip, the slot, all of it.',
        'I\'d like a film session this week to write down exactly what\'s working, so we can get back to it when it slips.',
        'Let me take an off day to break the delivery down on tape while it\'s right.',
        'I\'d like to map it now: pitch shapes, release point, sequencing. A run like this is the best time to learn.',
      ],
      stakes: [
        'It eats into the rest between outings, and some pitchers would rather not think about it.',
        'It\'s time out of recovery, and a few pitchers get in their heads when you study a good run.',
        'It costs some downtime, and thinking too hard about a hot streak can cool it off.',
      ],
      close: [
        'All right with you?',
        'Your call.',
        'Want me to set it up?',
      ],
    },
    subject: ['{active_pitcher_name} is dealing', 'A hot run: {active_pitcher_name}', 'What\'s working for {active_pitcher_name}'],
    preview: ['{active_pitcher_name}: {form_line}…', 'While {active_pitcher_name} is this good…'],
    body: '{@open} {@ask} {@stakes} {@close}',
    yesLabel: ['Set up the session', 'Map it while it\'s right', 'Do the film work'],
    noLabel: ['Just let the arm work', 'Leave it alone', 'Not while it\'s going well'],
    yesMsg: ['The film session is done; what\'s working is written down.', '{active_pitcher_name} and the staff went through the tape.'],
    noMsg: ['The routine stays as it is.', 'Nobody touched what\'s working.'],
    yesEffect: { ovr: 1, morale: -1 }, noEffect: { morale: 1 },
    _relYes: { act_pi: -1 }, _relNo: { act_pi: 1 },
    autoResolve: 'no', _ttl: 2 },

  // ── An arm on a cold run (the pitching coach) ──────────────────────────────
  { id: 'ag_form_arm_cold', _around: 'form', from: 'staff:pitchingCoach', sender: '{pitching_coach_name} (Pitching Coach)', tag: 'COACHING', avatar: '⚾', type: 'normal',
    parts: {
      open: [
        '{active_pitcher_name} is struggling: {form_line}.',
        'I\'m worried about {active_pitcher_name}: {form_line}.',
        '{active_pitcher_name} has lost something lately, {form_line}.',
        'It hasn\'t been pretty for {active_pitcher_name}: {form_line}.',
      ],
      ask: [
        'I want two extra bullpen sessions this week to rebuild the delivery from the ground up.',
        'I\'d like extra side sessions with me until the release point comes back.',
        'Let me set the normal throwing program aside and rework the mechanics in the bullpen.',
        'I\'d add extra side work this week. Something in the delivery has drifted.',
      ],
      stakes: [
        'More throwing means a more tired arm for a few days, and the frustration is already showing.',
        'The extra work adds wear, and it could read as a sign we\'ve lost faith.',
        'It costs rest, and a pitcher in a rut doesn\'t always want more attention on it.',
      ],
      close: [
        'Do I go ahead?',
        'Your call.',
        'Want me to start?',
      ],
    },
    subject: ['{active_pitcher_name} is struggling', 'Fixing {active_pitcher_name}', 'A rough run for {active_pitcher_name}'],
    preview: ['{active_pitcher_name}: {form_line}…', 'Something has drifted in {active_pitcher_name}\'s delivery…'],
    body: '{@open} {@ask} {@stakes} {@close}',
    yesLabel: ['Do the extra sessions', 'Rework the delivery', 'Start the side work'],
    noLabel: ['Work through it as is', 'Leave the program alone', 'Give it time'],
    yesMsg: ['The extra bullpen sessions started the next day.', '{active_pitcher_name} is back in the bullpen with the staff.'],
    noMsg: ['The normal program stays.', 'No extra work for now.'],
    yesEffect: { ovr: 1, morale: -1 }, noEffect: { morale: 1 },
    _relYes: { act_pi: -1 }, _relNo: { act_pi: 1 },
    autoResolve: 'no', _ttl: 2 },

  // ── A soft stretch of crowds (the ticket office) ───────────────────────────
  { id: 'ag_crowd_soft', _around: 'crowd', from: 'dept:ticket_office', sender: 'Ticket Office', tag: 'MARKETING', avatar: '🎟️', type: 'normal',
    parts: {
      open: [
        'The last {crowd_games} home games averaged {crowd_avg} in a park that holds {capacity}.',
        'We\'re looking at {crowd_avg} a night over the last {crowd_games} home games. Capacity is {capacity}.',
        'Crowds have been soft: {crowd_avg} on average over the last {crowd_games} at home.',
        'Not great at the gate. {crowd_avg} a game over the last {crowd_games}, out of {capacity} seats.',
      ],
      ask: [
        'We\'d run a promotion over the next homestand: cheaper seats in the upper deck and a family pack.',
        'We want to cut prices on the upper deck for the next six home dates and push group tickets.',
        'A discount on the next six home games would fill some of it: lower prices, a two-for-one night, a kids\' deal.',
        'We\'d like to drop prices across the cheap seats for the next homestand and promote it hard.',
      ],
      stakes: [
        'Each ticket brings in less, but a fuller park is louder and sells more at the stands.',
        'We give up some money a seat. The players notice a full park, though.',
        'It costs us per ticket, and the full seats pay some of it back at concessions.',
      ],
      close: [
        'Shall we run it?',
        'Can we go ahead?',
        'Let us know and we\'ll start Monday.',
      ],
    },
    subject: ['Soft crowds lately', 'Filling the seats', 'A promotion for the homestand', 'The gate is down'],
    preview: ['{crowd_avg} a game over the last {crowd_games}…', 'Crowds have been soft…'],
    body: '{@open} {@ask} {@stakes} {@close}',
    yesLabel: ['Run the promotion', 'Cut the prices', 'Fill the park'],
    noLabel: ['Hold prices', 'Not now', 'Leave the prices'],
    yesMsg: ['The promotion runs over the next six home games.', 'Upper deck prices are down for the homestand.'],
    noMsg: ['Prices stay where they are.', 'No promotion this time.'],
    yesEffect: { gate: { price: -0.15, fill: 0.10, homeGames: 6 }, atmo: 1 }, noEffect: { atmo: -1 },
    autoResolve: 'no', _ttl: 3 },

  // ── A run of sellouts (the ticket office) ──────────────────────────────────
  { id: 'ag_crowd_hot', _around: 'crowd', from: 'dept:ticket_office', sender: 'Ticket Office', tag: 'MARKETING', avatar: '🎟️', type: 'normal',
    parts: {
      open: [
        '{sellouts} sellouts in the last {crowd_games} home games.',
        'We\'ve sold every seat {sellouts} times in the last {crowd_games} at home.',
        'The phones haven\'t stopped: {sellouts} sellouts over the last {crowd_games} home games.',
        'Demand is way up. {sellouts} of the last {crowd_games} home games were sellouts.',
      ],
      ask: [
        'We\'d like to raise prices for the next homestand while demand is this high.',
        'We want to put the lower bowl up a few dollars for the next six home dates.',
        'We think the next homestand can carry higher prices, mostly in the good seats.',
        'We\'d raise prices for the next six home games and see what the market holds.',
      ],
      stakes: [
        'It\'s real money, but a few regulars will grumble, and some seats may go empty.',
        'More per ticket, at the cost of some goodwill with the season-ticket crowd.',
        'Fans notice a price jump during a good run, and not everyone takes it well.',
      ],
      close: [
        'Can we do it?',
        'Your call.',
        'Shall we?',
      ],
    },
    subject: ['Sellouts: raise prices?', 'The park is full', 'Pricing the next homestand', 'Demand is up'],
    preview: ['{sellouts} sellouts in the last {crowd_games}…', 'Every seat sold…'],
    body: '{@open} {@ask} {@stakes} {@close}',
    yesLabel: ['Raise the prices', 'Take the money', 'Go ahead'],
    noLabel: ['Keep prices where they are', 'Not during a good run', 'Leave them'],
    yesMsg: ['Prices are up for the next six home games.', 'The lower bowl costs more for the homestand.'],
    noMsg: ['Prices stay put; the regulars noticed.', 'No price change.'],
    yesEffect: { gate: { price: 0.10, fill: -0.03, homeGames: 6 }, atmo: -1 }, noEffect: { atmo: 1 },
    autoResolve: 'no', _ttl: 3 },

  // ── A big win (PR) ─────────────────────────────────────────────────────────
  { id: 'ag_media_win', _around: 'media', from: 'dept:media_relations', sender: 'PR Dept.', tag: 'MARKETING', avatar: '🎙️', type: 'normal',
    parts: {
      open: [
        'Everyone wants a piece of {game_line}.',
        'The phones have been going since {game_line}.',
        'After {game_line}, we\'ve had requests all morning.',
        '{game_line_cap} has the city talking.',
      ],
      ask: [
        'The morning shows want the manager on air, and two radio stations want time with the clubhouse.',
        'We could send the manager and a couple of players to the morning shows and do a radio hit at noon.',
        'TV wants the manager live tomorrow morning, and the papers want an hour in the clubhouse.',
        'We\'d like to say yes to the TV and radio requests: the manager, plus two players before batting practice.',
      ],
      stakes: [
        'It\'s good for the club\'s profile. It also eats the players\' morning before a game.',
        'Moments like this sell tickets. The clubhouse would rather just get ready to play.',
        'The city loves it, though the players lose some of their routine.',
        'It\'s the kind of attention that builds a fan base. Some players find it a chore.',
      ],
      close: [
        'Do we say yes?',
        'Your call.',
        'Should we book it?',
      ],
    },
    subject: ['Media requests after last night', 'Everyone wants a word', 'TV and radio calling', 'After the big win'],
    preview: ['The requests started after {game_line}…', 'TV wants the manager…'],
    body: '{@open} {@ask} {@stakes} {@close}',
    yesLabel: ['Book them', 'Say yes to all of it', 'Do the rounds'],
    noLabel: ['Keep the focus on the next game', 'Statement only', 'Turn them down'],
    yesMsg: ['The manager was on every morning show.', 'The rounds are booked: TV, radio and the papers.'],
    noMsg: ['A short statement went out instead.', 'The clubhouse stayed quiet.'],
    yesEffect: { atmo: 2, morale: -1 }, noEffect: { atmo: -1 },
    autoResolve: 'no', _ttl: 1 },

  // ── A blowout loss (PR) ────────────────────────────────────────────────────
  { id: 'ag_media_loss', _around: 'media', from: 'dept:media_relations', sender: 'PR Dept.', tag: 'MARKETING', avatar: '🎙️', type: 'normal',
    parts: {
      open: [
        'The coverage of {game_line} is rough.',
        'The talk shows haven\'t let go of {game_line}.',
        'After {game_line}, the questions are coming fast.',
        '{game_line_cap} is the story this morning, and not in a good way.',
      ],
      ask: [
        'We\'d like the manager to take questions before tonight\'s game, open to everyone.',
        'We think the manager should face it head-on with a full press conference today.',
        'The best move may be a proper press conference this afternoon rather than a written statement.',
        'We\'d put the manager in front of the cameras early to answer all of it.',
      ],
      stakes: [
        'It shows the club isn\'t hiding. It also keeps the story alive another day.',
        'Ownership likes when we own it. The clubhouse would rather move on.',
        'Fronting it earns credit upstairs, but it puts another night\'s loss on everyone\'s mind.',
      ],
      close: [
        'Do we do it?',
        'Your call.',
        'Shall we set it up?',
      ],
    },
    subject: ['After last night', 'The coverage is rough', 'Facing the questions', 'A press conference?'],
    preview: ['The coverage of {game_line}…', 'The questions are coming fast…'],
    body: '{@open} {@ask} {@stakes} {@close}',
    yesLabel: ['Hold the press conference', 'Face it head-on', 'Take every question'],
    noLabel: ['A statement is enough', 'Move on quietly', 'No press conference'],
    yesMsg: ['The manager took every question.', 'The press conference is done; the story moved on.'],
    noMsg: ['A short statement went out.', 'No press conference; the club moved on.'],
    yesEffect: { ownerTrust: 1, morale: -1 }, noEffect: { ownerTrust: -1 },
    autoResolve: 'no', _ttl: 1 },
];
