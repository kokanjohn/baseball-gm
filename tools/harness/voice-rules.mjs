/**
 * r158 The voice rules for inbox messages (§122.30), shared by check-message-voice.mjs (the written
 * library, tokens unresolved) and sim-season.js (every message a real season delivers, tokens resolved).
 *
 * voiceProblems(card, personOf) → [rule, field] pairs. personOf(sender) returns the signer's own name as it
 * would appear in the text (a token like "{manager_name}" or a resolved name) when a person signs, else null.
 */
export const TEXT_FIELDS = ['preview', 'body', 'yesMsg', 'noMsg', 'expireMsg'];
const unquoted = (s) => String(s || '').replace(/"[^"]*"|“[^”]*”/g, '');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function voiceProblems(c, personOf) {
  const out = [];
  if (!c.sender) return [['noSender', '']];
  const texts = TEXT_FIELDS.map(f => [f, c[f]]).filter(([, v]) => v);
  // personOf → the signer's name, or { name, owner: true } for the owner (who also never says "ownership").
  const who = personOf(c.sender);
  const me = who && typeof who === 'object' ? who.name : who;
  const isOwner = !!(who && typeof who === 'object' && who.owner);
  if (!c.relay) {
    if (me) {
      const re = new RegExp(`(^|[^\\w'])${esc(me)}(?![\\w])(?!'s (agent|handwriting))`);
      // (Your buttons are your reply to this person: they don't name the person in the third person either.)
      const own = [...texts, ['yesLabel', c.yesLabel], ['noLabel', c.noLabel]].filter(([, v]) => v);
      for (const [f, v] of own) if (re.test(unquoted(v)) || (isOwner && /\bownership\b/i.test(unquoted(v)))) { out.push(['selfThird', f]); break; }
    } else {
      const name = String(c.sender).replace(/\s+Dept\.?$|\.$/, '').trim();
      const re = new RegExp(`\\b${esc(name)}\\b(\\s+(has|is|wants|needs|says|can|asked|flagged|made|recommends|sent|team)\\b|'s\\s)`, 'i');
      for (const [f, v] of texts) if (re.test(unquoted(v))) { out.push(['deptSelf', f]); break; }
    }
    if (/^(A (handwritten )?note|A letter|A memo)\b|\b(left|sent) (a|this) note\b/i.test(c.body || '')) out.push(['aboutMsg', 'body']);
    if (/^[^"“]{0,80}\b(texted|called|pulled you aside|caught you|knocked on|over dinner|relayed a message)\b[^"“]{0,40}[:—]\s*["“]/i.test(c.body || '')) out.push(['narrated', 'body']);
  } else {
    // (any word of who it's from — a short surname too — but not filler like "the" or "a veteran's")
    const words = String(c.relay).toLowerCase().replace(/[{}']/g, ' ').split(/\s+/).filter(w => w.length >= 2 && !['the', 'a', 'an', 'of', 's', 'veteran', 'three'].includes(w));
    const body = String(c.body || '').toLowerCase().replace(/[{}']/g, ' ');
    if (c.relay === c.sender || !(words.some(w => body.includes(w)) || /["“]/.test(c.body || ''))) out.push(['relay', 'body']);
  }
  for (const [f, v] of texts) if (/Compose tab|in the \w+ tab would|the way they would from a real/i.test(v)) { out.push(['explainer', f]); break; }
  return out;
}

export const RULE_NAMES = {
  noSender:  'every message has a sender',
  selfThird: 'a person never appears in the third person in their own message (body, preview, outcomes)',
  deptSelf:  'a department writes as "we", never about itself by name',
  aboutMsg:  'no message about a note or letter unless someone relays it',
  narrated:  'no narrated conversation ("X texted: …") unless relayed',
  relay:     'a relayed message names or quotes who it is from, and the sender is someone else',
  explainer: 'no notes about how the game works',
};
