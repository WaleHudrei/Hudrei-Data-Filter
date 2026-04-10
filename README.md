# HudREI List Filtration Bot

Internal tool for the HudREI cold calling department. Processes Readymode call log exports, applies SOP filtration rules, and outputs REISift-ready update files.

## Deploy to Railway (one-time setup)

### Step 1 — Push to GitHub
1. Create a new **private** repo on GitHub (e.g. `hudrei-filtration-bot`)
2. Inside this folder run:
```bash
git init
git add .
git commit -m "Initial deploy"
git remote add origin https://github.com/YOUR_USERNAME/hudrei-filtration-bot.git
git push -u origin main
```

### Step 2 — Deploy on Railway
1. Go to [railway.app](https://railway.app) and sign in
2. Click **New Project → Deploy from GitHub repo**
3. Select your `hudrei-filtration-bot` repo
4. Railway will auto-detect Node.js and deploy

### Step 3 — Set Environment Variables
In Railway dashboard → your service → **Variables**, add:

| Variable | Value |
|---|---|
| `APP_USERNAME` | `hudrei` (or whatever you want) |
| `APP_PASSWORD` | Set a strong password |
| `SESSION_SECRET` | Any long random string |

Railway will redeploy automatically after you save variables.

### Step 4 — Get your URL
Railway assigns a URL like `hudrei-filtration-bot-production.up.railway.app`
Share this with your team along with the username/password.

---

## SOP Rules
- **Transfer** → Lead, always remove from dialer
- **Not Interested** → filter at 3+ logs per list
- **Do Not Call / Wrong Number / Spanish Speaker** → always remove
- **Voicemail / Hung Up / Dead Call / Not Available** → filter at 4+ logs per list
- **Callback** → keep

## Filtration counts
The bot calculates call log count from the export itself — it is NOT read from any column. It counts how many times each phone number appears per list in the file. Cumulative memory across uploads handles dialer resets.
