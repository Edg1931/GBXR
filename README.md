# GBXR — Grok bots that live in your room

GBXR puts a crew of voice bots, each with its own personality, voice and job,
into Android XR (Galaxy XR headset, Project Aura glasses). They also run on a
plain phone or tablet. Bots sit on your desk or at a spot in your home, wake
up when you come over, look at what's in front of you, talk with you in their
own voice, and take on work in the background.

It's built for two audiences that share one engine:

- **Senior care**: bots that live where the task happens:
  - Pantry on the fridge
  - Pip by the pill organizer
  - Walter at the front door
  - Sentry the scam guard at the mail table
  - Scout the object finder
  - Rose the story-keeping companion
  - Coach Max for balance exercise

  Family members see a daily summary and alerts, limited to what the senior
  chooses to share.
- **Everyone**: a desk crew you can talk to and delegate work to: Chief the
  team leader, Nova the nerdy researcher, and Juno the executive secretary.
  Tell Chief a goal and it hands assignments to the others. You watch them get
  to work on your desk, each teammate reports its piece, and Chief sums up when
  the whole team is done.

Every bot has a look that matches its personality (outfit, colors, props,
signature moves). See [docs/CHARACTERS.md](docs/CHARACTERS.md) for the crew and
ready-to-paste prompts for making their 3D avatars, from a phone or a PC.

## How it works

```
 Android XR app / phone app                 Backend (this repo)               xAI
 ┌──────────────────────────┐   HTTPS   ┌───────────────────────────┐
 │ XrStage: anchors, avatars│──────────▶│ /v1/voice/session ────────┼──▶ client secret
 │ BotDirector (core)       │           │ /v1/perception  ──────────┼──▶ Grok vision
 │  PlaceBotEngine          │           │ /v1/tools/:name           │
 │  BotStateMachine         │           │ caregiver summary/alerts  │──▶ Instacart, Kroger,
 │  SpeakPolicy, meds       │           │ jobs: missed doses, sales │    Open-Meteo
 │ Mic/speaker ◀────────────┼── WSS ────┼───────────────────────────┼──▶ Grok Voice (realtime)
 └──────────────────────────┘           └───────────────────────────┘
```

1. **Placement**: you drop a bot on a surface. It stays there as a persistent
   spatial anchor.
2. **Wake**: the bot wakes when you look at its spot from close by (with a
   scene-change check, e.g. the fridge door opening) or at scheduled times
   (medicine at 8:00).
3. **Look**: bots with a camera job take 1–2 photos only at that moment. The
   backend asks Grok vision for structured results: fridge inventory, pills
   seen, a mail scam review, objects seen.
4. **Think**: the backend compares the results with what it already knows. It
   updates the shopping list, matches pills to your medicine list, and raises
   caregiver alerts.
5. **Talk**: each bot has its own realtime voice session with its own voice and
   instructions. The app gets a short-lived token, so the xAI key never leaves
   the server. A speak policy keeps low-priority chatter rate-limited and
   quiet at night. Urgent things always get through.
6. **Act**: the voice model calls tools. The backend enforces each bot's tool
   list. Delegated tasks run in the background, the bot shows a "working"
   pose, and it comes back to report when the task finishes.
7. **Not wearing the glasses?** Reminders go to the phone or tablet instead.

## Repository layout

| Path | What | Status |
|---|---|---|
| `bots/` | Bot profiles (personality, voice, instructions, tools, placement) | Shared by app and backend |
| `core/` | Pure-Kotlin engine: placement triggers, state machine, speak policy, medication schedule, realtime voice client, backend client, `BotDirector` | **Built and tested here** (20 tests) |
| `backend/` | TypeScript/Fastify: voice sessions, camera checks, tools (incl. Chief's team delegation), caregiver sharing, jobs | **Built and tested here** (19 tests) |
| `docs/CHARACTERS.md` | Each bot's look and its 3D-avatar prompt | Generated from the bot profiles |
| `supabase/migrations/` | Postgres schema with row-level security for multi-user and caregiver scopes | **Checked on Postgres 16** |
| `android/` | Android XR + phone app: audio, CameraX, XR stage (Jetpack XR 1.0), 2D companion UI | **Builds in CI** into a debug APK; not yet tried on a device |

## Running it

### Backend
```bash
cd backend
npm install
cp .env.example .env      # add XAI_API_KEY; DEV_AUTH=1 for local testing
npm test
npm run dev               # http://localhost:8787
```

### Core engine tests
```bash
gradle :core:test
```

### Android app
Every push builds a debug APK on GitHub Actions (workflow **Build**, artifact
`gbxr-debug-apk`). To build it yourself, open the repo in Android Studio (the
`:android` module is included once an Android SDK is configured). Pass
`-Pgbxr.backendUrl=https://your-server` to point the app at a deployed backend.
`android/src/main/kotlin/com/gbxr/app/xr/XrStage.kt` is the only file that uses
the Jetpack XR APIs. Avatars (`.glb`) go in `android/src/main/assets/avatars/`;
bots without one still work by voice and from the panel.

## Accounts: you and everyone else

- **Sign-in**: Supabase Auth (Google sign-in). The backend verifies the
  session JWT and keys all data by user id. Row-level security enforces the
  same rules in the database.
- **Paying for Grok**: the server holds one xAI key and mints short-lived
  voice tokens. Options for other users, in order of simplicity: meter usage
  and charge a subscription; let users bring their own xAI key (stored
  encrypted server-side); or "sign in with xAI" once xAI officially supports
  it for third-party apps.
- **Family access**: a senior grants a caregiver specific scopes (`meds`,
  `meals`, `activity`, `stories`, `safety`, `mood`, `messages`). Summaries and
  alerts only include those scopes. The summary text is built from logged facts,
  not written by the AI.

## Safety and privacy (senior care)

- Reminders and logging only. **Not a medical device and not an emergency
  service.** Bots tell people to call 911 or press their alert button. Connect
  a real medical-alert/fall-detection service rather than relying on the bot.
- A dose is never logged from a photo. The person confirms out loud, and the
  bot refuses to log the same dose twice.
- Photos are taken only when a bot wakes. The scene-change check uses a tiny
  on-device thumbnail that is never stored or uploaded.
- Visitor recognition only uses names the family registered. Bots never guess
  who a stranger is.
- Before handling health data with care providers, check HIPAA obligations and
  whether xAI will sign a BAA.

## Next steps

- [ ] Supabase-backed `Store` (replace `MemoryStore`) and supabase-kt sign-in in the app
- [ ] First run on Galaxy XR and Project Aura; tune panel size for glasses
- [ ] Host the backend over HTTPS and point the app at it
- [ ] Move phone reminders to AlarmManager/WorkManager so they survive the app being closed
- [ ] Caregiver web dashboard (summary + alerts endpoints are ready)
- [ ] Push notifications for urgent caregiver alerts (FCM)
- [ ] Avatars with the standard animation set; lip-sync morph target
- [ ] Verify Instacart field names and xAI client-secret options against live docs
- [ ] Glasses-specific UI (Jetpack Compose Glimmer) for Project Aura

## Deploying the backend (Supabase + Vercel)

1. **Supabase project**: apply `supabase/migrations/20261124000000_init.sql`. Turn on Google sign-in
   under Authentication → Providers.
2. **Vercel project** from this repo with **Root Directory = `backend`** (it uses `backend/vercel.json`
   and `backend/api/index.ts`). Environment variables:
   - `XAI_API_KEY`: your xAI key (Vercel dashboard only, never in chat or git)
   - `DATABASE_URL`: Supabase transaction-pooler connection string (port 6543)
   - `SUPABASE_JWKS_URL`: `https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json`
   - `CRON_SECRET`: any long random string
3. **Schedules**: Vercel's free plan runs crons once a day, which is fine for price checks. For
   missed-dose alerts every 10 minutes, schedule `GET /v1/jobs/missed-doses` with header
   `Authorization: Bearer <CRON_SECRET>` from Supabase (pg_cron + pg_net) or any scheduler.
4. Build the app with `-Pgbxr.backendUrl=https://<your-vercel-domain>`.
