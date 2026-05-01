// ═══════════════════════════════════════════════════════════════════════════
// src/disposition-normalize.js
// Single source of truth for disposition normalization (5E).
//
// Maps any inbound disposition string — regardless of casing, underscores,
// hyphens, plurals, or punctuation — to a canonical bucket used everywhere
// downstream. Pre-5E this logic lived inline in server.js's normDispo() and
// drifted across other sites that built their own ad-hoc normalizers.
//
// Canonical buckets:
//   transfer        — Lead, Appointment, Transfer, transfer to manager…
//   potential_lead  — Potential Lead
//   sold            — Sold
//   listed          — Listed
//   not_interested  — Not Interested, NI, "not_interested"
//   hung_up         — Hung Up, hang up, hangup, hung-up
//   wrong_number    — Wrong Number(s), Wrong #, wrong number
//   voicemail       — Voicemail, voice mail, VM, voicemail msg
//   not_available   — Not Available, NA, not avail
//   do_not_call     — Do Not Call, DNC, do_not_call
//   dead_number     — Dead Call, Dead Number, dead, NIS
//   spanish_speaker — Spanish Speaker, spanish
//   callback        — Callback, call back
//   completed       — Completed, completed call
//   disqualified    — Disqualified, DQ
//   other           — anything we don't recognize
// ═══════════════════════════════════════════════════════════════════════════

// Tokenize for keyword matching: lowercase, strip punctuation, treat
// _ - and whitespace as separators. Returns a single space-joined string
// so .includes() can do natural-word matching that ignores formatting.
function _tokens(raw) {
  return String(raw == null ? '' : raw)
    .toLowerCase()
    .replace(/[_\-]+/g, ' ')
    .replace(/[^\w\s]+/g, ' ')   // strip ()/.,#/etc
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeDisposition(raw) {
  const s = _tokens(raw);
  if (!s) return '';

  // Exact-match shortcuts first — short codes (NI, VM, NA, DNC, DQ).
  if (s === 'ni')  return 'not_interested';
  if (s === 'vm')  return 'voicemail';
  if (s === 'na')  return 'not_available';
  if (s === 'dnc') return 'do_not_call';
  if (s === 'dq')  return 'disqualified';

  // Outcome buckets — tested before generic-keyword buckets so a string
  // like "not interested via voicemail" lands in not_interested rather
  // than voicemail.
  if (s.includes('potential lead'))                         return 'potential_lead';
  if (s.includes('sold'))                                   return 'sold';
  if (s.includes('listed'))                                 return 'listed';
  if (s.includes('transfer') || s === 'lead' ||
      s === 'appointment'    || s.includes('appointment'))  return 'transfer';
  if (s.includes('not interested') ||
      s.includes('uninterested'))                           return 'not_interested';
  if (s.includes('do not call'))                            return 'do_not_call';
  if (s.includes('spanish'))                                return 'spanish_speaker';
  if (s.includes('disqualif'))                              return 'disqualified';
  if (s.includes('complete'))                               return 'completed';

  // Phone-state buckets.
  if (s.includes('wrong'))                                  return 'wrong_number';
  if (s.includes('voicemail') || s.includes('voice mail') ||
      s.includes('vmail'))                                  return 'voicemail';
  if (s.includes('hung up')   || s.includes('hang up') ||
      s.includes('hangup')    || s.includes('hung'))        return 'hung_up';
  if (s.includes('not available') ||
      s.includes('not avail'))                              return 'not_available';
  // Dead bucket: "dead", "dead call", "dead number", "nis", "not in service".
  if (s.includes('dead')      || s === 'nis' ||
      s.includes('not in service'))                         return 'dead_number';
  if (s.includes('callback')  || s.includes('call back'))   return 'callback';

  return 'other';
}

module.exports = { normalizeDisposition };
