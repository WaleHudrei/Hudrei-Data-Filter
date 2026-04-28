// ═══════════════════════════════════════════════════════════════════════════════
// src/email.js — Phase 2 transactional email
//
// Single funnel for every outbound email (verification, password reset, change-
// password notifications). Uses Postmark when POSTMARK_SERVER_TOKEN is set;
// otherwise logs to stdout so local dev / first-boot-without-creds still works.
//
// Required env (production):
//   POSTMARK_SERVER_TOKEN  — Postmark Server API token
//   EMAIL_FROM             — verified sender (e.g. "Ocular <hello@ocular.app>")
//   APP_BASE_URL           — public URL used to build absolute links in emails
//                            (e.g. "https://app.ocular.app" or
//                             "https://staging.up.railway.app"). Falls back to
//                             http://localhost:3000.
// ═══════════════════════════════════════════════════════════════════════════════

let _postmarkClient = null;

function getClient() {
  if (_postmarkClient !== null) return _postmarkClient;
  const token = process.env.POSTMARK_SERVER_TOKEN;
  if (!token) {
    _postmarkClient = false; // sentinel: don't try again
    return false;
  }
  try {
    const postmark = require('postmark');
    _postmarkClient = new postmark.ServerClient(token);
    return _postmarkClient;
  } catch (e) {
    console.error('[email] Postmark init failed:', e.message);
    _postmarkClient = false;
    return false;
  }
}

function baseUrl() {
  return (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
}

function fromAddress() {
  return process.env.EMAIL_FROM || 'Ocular <no-reply@ocular.app>';
}

// Low-level send. Returns true on success, false on failure (failure is
// logged — callers should NOT abort signup/reset just because email failed,
// they should still respond OK and surface the resend path in the UI).
async function send({ to, subject, htmlBody, textBody }) {
  const client = getClient();
  if (!client) {
    console.log('\n[email:devmode] ──────────────────────────────────');
    console.log(`[email:devmode] To:      ${to}`);
    console.log(`[email:devmode] Subject: ${subject}`);
    console.log(`[email:devmode] Body:\n${textBody || htmlBody}`);
    console.log('[email:devmode] ──────────────────────────────────\n');
    return true;
  }
  try {
    await client.sendEmail({
      From: fromAddress(),
      To: to,
      Subject: subject,
      HtmlBody: htmlBody,
      TextBody: textBody || htmlBody.replace(/<[^>]+>/g, ''),
      MessageStream: 'outbound',
    });
    return true;
  } catch (e) {
    console.error('[email] send failed:', to, subject, e.message);
    return false;
  }
}

// ── Templates ────────────────────────────────────────────────────────────────
// Plain HTML, inline-styled. Postmark supports templates server-side but we
// keep them in code so the diff for "what does the verification email say"
// lives next to the rest of the auth flow.

function wrap(title, bodyHtml) {
  return `<!DOCTYPE html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f4f0;margin:0;padding:24px;color:#1a1a1a">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;border:1px solid #e0dfd8">
    <div style="font-size:18px;font-weight:600;margin-bottom:24px;color:#1a1a1a">Ocular</div>
    <h1 style="font-size:22px;margin:0 0 16px 0">${title}</h1>
    ${bodyHtml}
    <div style="margin-top:32px;padding-top:16px;border-top:1px solid #eee;font-size:12px;color:#888">
      You're receiving this because someone (probably you) used your email at Ocular. If that wasn't you, you can ignore this message.
    </div>
  </div>
</body></html>`;
}

async function sendVerifyEmail(to, name, token) {
  const link = `${baseUrl()}/verify-email?token=${encodeURIComponent(token)}`;
  const html = wrap('Confirm your email',
    `<p>Hi ${name || 'there'},</p>
     <p>Click the button below to confirm your email and finish setting up your Ocular account.</p>
     <p style="margin:24px 0">
       <a href="${link}" style="display:inline-block;background:#1a1a1a;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600">Confirm email</a>
     </p>
     <p style="font-size:13px;color:#666">Or copy this link into your browser:<br><span style="word-break:break-all">${link}</span></p>
     <p style="font-size:13px;color:#666">This link expires in 24 hours.</p>`
  );
  const text = `Hi ${name || 'there'},\n\nConfirm your email by visiting:\n${link}\n\nThis link expires in 24 hours.`;
  return send({ to, subject: 'Confirm your Ocular email', htmlBody: html, textBody: text });
}

async function sendPasswordResetEmail(to, name, token) {
  const link = `${baseUrl()}/reset-password?token=${encodeURIComponent(token)}`;
  const html = wrap('Reset your password',
    `<p>Hi ${name || 'there'},</p>
     <p>Someone asked to reset the password on your Ocular account. Click the button to choose a new one.</p>
     <p style="margin:24px 0">
       <a href="${link}" style="display:inline-block;background:#1a1a1a;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600">Reset password</a>
     </p>
     <p style="font-size:13px;color:#666">Or copy this link into your browser:<br><span style="word-break:break-all">${link}</span></p>
     <p style="font-size:13px;color:#666">This link expires in 1 hour. If you didn't request a reset, you can safely ignore this email.</p>`
  );
  const text = `Hi ${name || 'there'},\n\nReset your password at:\n${link}\n\nThis link expires in 1 hour.`;
  return send({ to, subject: 'Reset your Ocular password', htmlBody: html, textBody: text });
}

async function sendPasswordChangedEmail(to, name) {
  const html = wrap('Your password was changed',
    `<p>Hi ${name || 'there'},</p>
     <p>This is a confirmation that the password on your Ocular account was just changed.</p>
     <p>If you did this, no action is needed.</p>
     <p>If you didn't, please <a href="${baseUrl()}/forgot-password">reset your password</a> immediately.</p>`
  );
  const text = `Hi ${name || 'there'},\n\nYour Ocular password was just changed. If this wasn't you, reset it at ${baseUrl()}/forgot-password`;
  return send({ to, subject: 'Your Ocular password was changed', htmlBody: html, textBody: text });
}

module.exports = {
  send,
  sendVerifyEmail,
  sendPasswordResetEmail,
  sendPasswordChangedEmail,
  baseUrl,
};
