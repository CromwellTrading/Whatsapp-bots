# WhatsApp Bot SaaS

A multi-tenant SaaS platform for managing WhatsApp bots, allowing multiple users to connect their WhatsApp accounts and configure automated behaviors.

## Architecture

- **Backend**: Node.js + Express (serves both API and static frontend)
- **WhatsApp**: @whiskeysockets/baileys for WhatsApp Web API
- **Auth & Database**: Supabase (PostgreSQL + Auth + RLS)
- **Task Scheduling**: node-cron for scheduled bot tasks
- **Frontend**: Static HTML/JS files served via Express from `/public`

## Project Structure

- `index.js` — Entry point, Express server setup
- `core/manager.js` — WhatsApp instance manager (multi-tenant)
- `core/userBot.js` — Incoming message handling (auto-replies, commands)
- `core/cron.js` — Centralized cron for scheduled tasks
- `auth/supabase.js` — Supabase client (user + admin clients)
- `auth/sessionAdapter.js` — Session handling
- `routes/auth.js` — Registration and login endpoints
- `routes/user.js` — User bot controls (status, settings, link)
- `routes/admin.js` — Admin dashboard endpoints
- `utils/db.js` — Database abstraction helpers
- `public/` — Static frontend files (login.html, user.html, admin.html)
- `auth_states/` — WhatsApp session files (generated at runtime, gitignored)

## Environment Variables (Secrets Required)

- `SUPABASE_URL` — Supabase project URL
- `SUPABASE_ANON_KEY` — Supabase anonymous/public key
- `SUPABASE_SERVICE_ROLE_KEY` — Supabase service role key (admin operations)

## Running

```bash
npm start
```

Starts on port 5000 (bound to 0.0.0.0).

## Deployment

Uses VM deployment target (always-on) since WhatsApp bot connections require persistent server memory.
