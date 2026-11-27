/**
 * engine/cards/OwnerCards.js
 * CardEngine, the owner and the books (§78).
 * Moved from engine/CardEngine.js as it was (r290 §122.171, foundation step 2): CardEngine re-exports what it
 * exported; a declaration another area uses is exported from here. Write to state only through StateManager.
 */
import { eventRand } from '../Dice.js';

// ─────────────────────────────────────────────────────────────
// THE OWNER AND THE BOOKS (§78)
// ─────────────────────────────────────────────────────────────

// How each archetype's owner talks, by stage. {name} = the owner; lines are
// picked at random so the same stage doesn't read the same twice.
const OWNER_VOICE = {
  ember: {
    watching:  ["I've been looking at the payroll. This franchise can't spend like the old days — not yet.",
                "Every dollar matters here. I'm watching where they go."],
    concerned: ["We're spending money we don't have. That's how this club got cold in the first place.",
                "I won't run this franchise into the red again. Get it under control."],
  },
  contender: {
    watching:  ["The payroll's running hot. If we're going to spend, I want to see it in the standings.",
                "I'm keeping an eye on the money. Win and I'll stop asking."],
    concerned: ["We're paying like a contender and not playing like one. That has to change.",
                "The money's going out faster than the wins are coming in. Fix it."],
  },
  empire: {
    watching:  ["Spend what it takes — but I expect a parade for it.",
                "Money isn't the problem. Losing with this payroll would be."],
    concerned: ["The most expensive roster in the league, and look at the standings. Unacceptable.",
                "I don't mind the bill. I mind paying it for this."],
  },
  gambler: {
    watching:  ["Interesting bets you're making with my money. Let's see how they land.",
                "I like a big swing. I don't like a big miss."],
    concerned: ["I'm done being patient with these numbers. Tighten it up.",
                "The house always wins — and right now we're not the house."],
  },
  lab: {
    watching:  ["I ran our cost per win. It's drifting the wrong way.",
                "Process over results — but the process includes the budget."],
    concerned: ["We're paying more per win than almost anyone. That's not an efficient model.",
                "The spreadsheet doesn't lie. We're overpaying for what we're getting."],
  },
  institution: {
    watching:  ["This club has always paid its bills. I'd like to keep it that way.",
                "Steady, responsible spending — that's how we've always done things here."],
    concerned: ["We don't carry debt in this organization. We never have.",
                "Running in the red is not who we are. I expect that corrected."],
  },
};

export const _voice = (state, stage) => {
  const lines = (OWNER_VOICE[state.archetype] || OWNER_VOICE.contender)[stage] || [];
  return lines[Math.floor(eventRand() * lines.length)] || '';
};
