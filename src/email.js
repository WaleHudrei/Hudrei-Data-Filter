// ═══════════════════════════════════════════════════════════════════════════════
// src/email.js — Phase 2 transactional email
//
// Single funnel for every outbound email (verification, password reset, change-
// password notifications). Provider order of preference:
//
//   1. SMTP (Nodemailer) — when SMTP_HOST is set. Works with any SMTP service:
//      Gmail (with app password), SendGrid, Mailgun, Squarespace email,
//      Resend, AWS SES, etc. Most flexible — pair with whichever sender the
//      operator has credentials for.
//
//   2. Postmark — when POSTMARK_SERVER_TOKEN is set and SMTP is not. Original
//      provider this module shipped with; kept for back-compat.
//
//   3. Dev-mode fallback — neither set. Logs the email body to stdout so local
//      development and first-boot-without-creds don't break.
//
// Env (any provider):
//   EMAIL_FROM    — verified sender, e.g. "Oculah <noreply@oculah.com>"
//   APP_BASE_URL  — public URL used for links in emails. Falls back to
//                   http://localhost:3000.
//
// SMTP provider env:
//   SMTP_HOST     — e.g. smtp.gmail.com, smtp.sendgrid.net
//   SMTP_PORT     — defaults to 587 (STARTTLS); use 465 for implicit TLS
//   SMTP_USER     — login username
//   SMTP_PASS     — login password (or app password for Gmail)
//   SMTP_SECURE   — "true" forces TLS on connect (use with port 465)
//
// Postmark provider env:
//   POSTMARK_SERVER_TOKEN — Postmark Server API token
// ═══════════════════════════════════════════════════════════════════════════════

const BRAND = 'Oculah';

let _provider = null;          // resolved transport: 'smtp' | 'postmark' | 'devmode'
let _smtpTransport = null;
let _postmarkClient = null;

function _resolveProvider() {
  if (_provider) return _provider;
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    try {
      const nodemailer = require('nodemailer');
      const port = parseInt(process.env.SMTP_PORT || '587', 10);
      const secure = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || port === 465;
      _smtpTransport = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port,
        secure,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });
      _provider = 'smtp';
      console.log(`[email] provider: SMTP (${process.env.SMTP_HOST}:${port}, secure=${secure})`);
      return _provider;
    } catch (e) {
      console.error('[email] Nodemailer init failed:', e.message);
    }
  }
  if (process.env.POSTMARK_SERVER_TOKEN) {
    try {
      const postmark = require('postmark');
      _postmarkClient = new postmark.ServerClient(process.env.POSTMARK_SERVER_TOKEN);
      _provider = 'postmark';
      console.log('[email] provider: Postmark');
      return _provider;
    } catch (e) {
      console.error('[email] Postmark init failed:', e.message);
    }
  }
  _provider = 'devmode';
  console.log('[email] provider: devmode (logs to stdout — no SMTP_HOST or POSTMARK_SERVER_TOKEN configured)');
  return _provider;
}

function baseUrl() {
  return (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
}

function fromAddress() {
  return process.env.EMAIL_FROM || `${BRAND} <no-reply@oculah.com>`;
}

// Low-level send. Returns true on success, false on failure (failure is
// logged — callers should NOT abort signup/reset just because email failed,
// they should still respond OK and surface the resend path in the UI).
async function send({ to, subject, htmlBody, textBody }) {
  const text = textBody || htmlBody.replace(/<[^>]+>/g, '');
  const provider = _resolveProvider();

  if (provider === 'smtp') {
    try {
      await _smtpTransport.sendMail({
        from: fromAddress(),
        to,
        subject,
        html: htmlBody,
        text,
      });
      return true;
    } catch (e) {
      console.error('[email] SMTP send failed:', to, subject, e.message);
      return false;
    }
  }

  if (provider === 'postmark') {
    try {
      await _postmarkClient.sendEmail({
        From: fromAddress(),
        To: to,
        Subject: subject,
        HtmlBody: htmlBody,
        TextBody: text,
        MessageStream: 'outbound',
      });
      return true;
    } catch (e) {
      console.error('[email] Postmark send failed:', to, subject, e.message);
      return false;
    }
  }

  // Dev mode — log only.
  console.log('\n[email:devmode] ──────────────────────────────────');
  console.log(`[email:devmode] To:      ${to}`);
  console.log(`[email:devmode] Subject: ${subject}`);
  console.log(`[email:devmode] Body:\n${text}`);
  console.log('[email:devmode] ──────────────────────────────────\n');
  return true;
}

// ── Templates ────────────────────────────────────────────────────────────────
function wrap(title, bodyHtml) {
  return `<!DOCTYPE html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f4f0;margin:0;padding:24px;color:#1a1a1a">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;border:1px solid #e0dfd8">
    <div style="font-size:18px;font-weight:600;margin-bottom:24px;color:#1a1a1a">${BRAND}</div>
    <h1 style="font-size:22px;margin:0 0 16px 0">${title}</h1>
    ${bodyHtml}
    <div style="margin-top:32px;padding-top:16px;border-top:1px solid #eee;font-size:12px;color:#888">
      You're receiving this because someone (probably you) used your email at ${BRAND}. If that wasn't you, you can ignore this message.
    </div>
  </div>
</body></html>`;
}

async function sendVerifyEmail(to, name, token) {
  const link = `${baseUrl()}/verify-email?token=${encodeURIComponent(token)}`;
  const html = wrap('Confirm your email',
    `<p>Hi ${name || 'there'},</p>
     <p>Click the button below to confirm your email and finish setting up your ${BRAND} account.</p>
     <p style="margin:24px 0">
       <a href="${link}" style="display:inline-block;background:#1a1a1a;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600">Confirm email</a>
     </p>
     <p style="font-size:13px;color:#666">Or copy this link into your browser:<br><span style="word-break:break-all">${link}</span></p>
     <p style="font-size:13px;color:#666">This link expires in 24 hours.</p>`
  );
  const text = `Hi ${name || 'there'},\n\nConfirm your email by visiting:\n${link}\n\nThis link expires in 24 hours.`;
  return send({ to, subject: `Confirm your ${BRAND} email`, htmlBody: html, textBody: text });
}

async function sendPasswordResetEmail(to, name, token) {
  const link = `${baseUrl()}/reset-password?token=${encodeURIComponent(token)}`;
  const html = wrap('Reset your password',
    `<p>Hi ${name || 'there'},</p>
     <p>Someone asked to reset the password on your ${BRAND} account. Click the button to choose a new one.</p>
     <p style="margin:24px 0">
       <a href="${link}" style="display:inline-block;background:#1a1a1a;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600">Reset password</a>
     </p>
     <p style="font-size:13px;color:#666">Or copy this link into your browser:<br><span style="word-break:break-all">${link}</span></p>
     <p style="font-size:13px;color:#666">This link expires in 1 hour. If you didn't request a reset, you can safely ignore this email.</p>`
  );
  const text = `Hi ${name || 'there'},\n\nReset your password at:\n${link}\n\nThis link expires in 1 hour.`;
  return send({ to, subject: `Reset your ${BRAND} password`, htmlBody: html, textBody: text });
}

async function sendSignupExistingAccountEmail(to, name) {
  const html = wrap(`You already have an ${BRAND} account`,
    `<p>Hi ${name || 'there'},</p>
     <p>Someone (probably you) just tried to sign up at ${BRAND} with this email address — but you already have an account.</p>
     <p style="margin:24px 0">
       <a href="${baseUrl()}/login" style="display:inline-block;background:#1a1a1a;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600">Sign in</a>
     </p>
     <p style="font-size:13px;color:#666">Forgot your password? <a href="${baseUrl()}/forgot-password">Reset it here.</a></p>
     <p style="font-size:13px;color:#666">If you didn't try to sign up, you can safely ignore this email.</p>`
  );
  const text = `Hi ${name || 'there'},\n\nSomeone tried to sign up at ${BRAND} with your email, but you already have an account. Sign in at ${baseUrl()}/login or reset your password at ${baseUrl()}/forgot-password.`;
  return send({ to, subject: `You already have an ${BRAND} account`, htmlBody: html, textBody: text });
}

async function sendPasswordChangedEmail(to, name) {
  const html = wrap('Your password was changed',
    `<p>Hi ${name || 'there'},</p>
     <p>This is a confirmation that the password on your ${BRAND} account was just changed.</p>
     <p>If you did this, no action is needed.</p>
     <p>If you didn't, please <a href="${baseUrl()}/forgot-password">reset your password</a> immediately.</p>`
  );
  const text = `Hi ${name || 'there'},\n\nYour ${BRAND} password was just changed. If this wasn't you, reset it at ${baseUrl()}/forgot-password`;
  return send({ to, subject: `Your ${BRAND} password was changed`, htmlBody: html, textBody: text });
}

// 2026-05-01 Phase 4 — workspace invite email
async function sendInviteEmail(to, inviterName, workspaceName, token) {
  const link = `${baseUrl()}/invite/${encodeURIComponent(token)}`;
  const subject = `${inviterName || 'Someone'} invited you to ${workspaceName || 'Oculah'}`;
  const html = `<p>You've been invited to join the <strong>${workspaceName || 'Oculah'}</strong> workspace on ${BRAND}.</p>
    <p>Click below to accept and create your account. The link expires in 7 days.</p>
    <p><a href="${link}" style="display:inline-block;padding:11px 18px;background:#1a1a1a;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Accept invitation</a></p>
    <p>Or paste this URL: <code>${link}</code></p>`;
  const text = `Accept your invitation to ${workspaceName || 'Oculah'}: ${link}`;
  return send({ to, subject, htmlBody: html, textBody: text });
}

module.exports = {
  send,
  sendVerifyEmail,
  sendPasswordResetEmail,
  sendPasswordChangedEmail,
  sendSignupExistingAccountEmail,
  sendInviteEmail,
  baseUrl,
};
