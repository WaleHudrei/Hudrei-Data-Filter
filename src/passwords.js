// ═══════════════════════════════════════════════════════════════════════════════
// src/passwords.js — Phase 2 bcrypt wrapper
//
// All password hashing goes through here. Keeps the cost factor (12) and
// "is this a real bcrypt hash" detection in one place so we never accidentally
// compare a plaintext column with bcrypt.compare and silently fail open.
// ═══════════════════════════════════════════════════════════════════════════════

const bcrypt = require('bcrypt');

const COST = 12;

async function hash(plaintext) {
  if (!plaintext || typeof plaintext !== 'string') {
    throw new Error('hash: plaintext required');
  }
  return bcrypt.hash(plaintext, COST);
}

async function verify(plaintext, hashed) {
  if (!plaintext || !hashed) return false;
  // bcrypt hashes start with $2a$, $2b$, or $2y$. Anything else means we're
  // looking at a placeholder or a corrupted value — refuse to compare.
  if (!/^\$2[aby]\$/.test(hashed)) return false;
  try {
    return await bcrypt.compare(plaintext, hashed);
  } catch (e) {
    console.error('[passwords] verify error:', e.message);
    return false;
  }
}

// Soft validation. Returns null if ok, otherwise an error message string the
// caller can show to the user. Kept liberal — we're not a bank.
function validate(plaintext) {
  if (!plaintext || typeof plaintext !== 'string') return 'Password is required.';
  if (plaintext.length < 8) return 'Password must be at least 8 characters.';
  if (plaintext.length > 200) return 'Password is too long.';
  return null;
}

module.exports = { hash, verify, validate };
