# Meshdrop

A zero-sign-in, room-based real-time chat and file transfer platform. Create a room, share a 6-digit code, and anyone can join to chat and share files instantly — no accounts, no uploads to a central server, no trace left behind.

## Features

- **No sign-in required** — the entire app works anonymously. Create or join a room in seconds.
- **Room-based chat** — real-time text messaging with anyone in the room, delivered via Supabase Realtime broadcast.
- **File sharing** — drag-and-drop or click to share any file (images, documents, archives, code, up to ~50MB). Files are chunked and relayed through Supabase for reliable cross-device delivery.
- **Multi-person rooms** — multiple people can join the same room. See who's online with live presence tracking.
- **QR code sharing** — each room generates a QR code for instant joining via camera scan.
- **Optional sign-in** — signed-in users get access to their room history (rooms visited, role, timestamps). Unsigned users get the same chat and file sharing but no persistent history.
- **Signed/guest badges** — in the room sidebar, signed-in users can see who is signed in vs. guest. Guest users see the same chat experience without badges.
- **10-minute auto-expiration** — rooms auto-expire after 10 minutes for security and resource cleanup.
- **Dark, premium UI** — sleek, minimalist, responsive from mobile to desktop with micro-interactions and hover states.

## How It Works

```
Person A (Host)                        Person B (Joiner)
     │                                      │
     ├─ Clicks "Create a room"               │
     ├─ Gets 6-digit code + QR               │
     ├─ Shares code/QR ─────────────────────→ ├─ Enters code or scans QR
     │                                      ├─ Joins the room
     │ ←──── real-time chat (broadcast) ────┤
     │ ←──── file chunks (Supabase) ────────┤
     │                                      ├─ Downloads file
     └─ Both can chat + share files          └─ Both can chat + share files
```

### Step-by-step

1. **Create a room** — Click "Create a room" to get a 6-digit code and QR instantly. No sign-up needed.
2. **Share the code** — Send the 6-digit code or QR to anyone. They enter it or scan to join your room.
3. **Chat & connect** — Start chatting in real-time. See who's online and exchange messages instantly.
4. **Share files** — Drag a file into the chat or click the + button. Others in the room can download it with one click.

### What you can share

| Type | Formats |
|------|---------|
| Images | JPG, PNG, GIF, WebP, SVG |
| Documents | PDF, Word, Excel, plain text |
| Archives | ZIP, RAR, 7Z, tar.gz |
| Code files | JS, TS, JSON, Python, more |
| Any file | No type restrictions, up to ~50MB |
| Real-time chat | Text messages with instant delivery |

## Authentication (Optional)

Meshdrop uses **Supabase Auth** for the optional sign-in feature. Authentication is never required — the app works fully without an account.

### Why Supabase Auth (not Firebase)

Since the app already uses Supabase for its database, realtime, and file relay, using Supabase Auth keeps everything in one platform:
- **Single backend** — no need to manage a separate Firebase project alongside Supabase.
- **Shared session** — the Supabase client handles auth state and database access with the same connection.
- **RLS integration** — Row Level Security policies on the `user_room_history` table use `auth.uid()` to scope each user's history to their own account.
- **No extra dependencies** — the `@supabase/supabase-js` client already handles auth; no Firebase SDK needed.

### What sign-in gives you

- **Room history** — signed-in users see a "Recent rooms" section on the landing page showing every room they've joined or created, with timestamps and role.
- **Persistent logs** — your room participation is saved to the `user_room_history` table and tied to your account.
- **Signed-in badge** — in the room sidebar, other signed-in users can see you're a verified member (shield icon). Guest users appear with a lock icon (only visible to signed-in users).

### What stays the same for guests

- Full chat and file sharing capabilities
- Real-time presence and member list
- Room creation and joining
- No data stored — everything is ephemeral

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | React 18 + TypeScript |
| Build tool | Vite 5 |
| Styling | Tailwind CSS + custom CSS |
| Icons | Lucide React |
| Backend | Supabase (database, realtime, auth) |
| Chat transport | Supabase Realtime broadcast channels |
| File transport | Supabase `transfer_chunks` table (chunked base64 relay) |
| Presence | Supabase `room_members` table + polling |
| QR codes | qrcode.react |
| QR scanning | jsqr |

## Database Schema

| Table | Purpose |
|-------|---------|
| `transfer_tickets` | Room registry — maps 6-digit PINs to active rooms with connection status |
| `room_members` | Presence — tracks who's in each room, with `user_id` for signed-in users |
| `transfer_chat` | Chat messages — text messages with sender name and optional `user_id` |
| `transfer_chunks` | File data — files split into 256KB base64 chunks for reliable relay |
| `file_offers` | File metadata — file name, size, type, upload status, chunk count |
| `user_room_history` | Signed-in user history — rooms visited with timestamps (owner-scoped via RLS) |

All tables have Row Level Security enabled. The transfer tables use `anon, authenticated` policies (public/shared ephemeral data). The `user_room_history` table uses `authenticated`-only policies scoped to `auth.uid() = user_id`.

## Getting Started

```bash
npm install
npm run dev
```

Open your browser to the displayed URL.

## Build

```bash
npm run build      # production build to dist/
npm run typecheck  # TypeScript type checking
npm run lint       # ESLint
```

## Deployment

### GitHub Pages / Netlify / Vercel / Cloudflare Pages

1. Run `npm run build` — outputs to `dist/`
2. Deploy the `dist/` folder to your static host

For the GitHub Pages workflow, add these repository secrets under **Settings →
Secrets and variables → Actions**:

- `VITE_SUPABASE_URL` — your Supabase project URL
- `VITE_SUPABASE_ANON_KEY` — your Supabase anon/public key

The workflow passes these values into the Vite build and stops if either is
missing. Never use the Supabase service-role key in a frontend deployment.

## Project Structure

```
src/
├── App.tsx              # Main UI: landing page, room screen, auth modal
├── lib/
│   └── transfer.ts      # Room engine: Supabase realtime, chat, file relay, auth
├── components/
│   └── QrScanner.tsx    # QR code camera scanner
├── index.css            # Global styles + Tailwind
└── main.tsx             # React entry point
supabase/
└── migrations/          # Database migration SQL files
vite.config.ts           # Vite config
```

## How the Sign-In Flow Works

1. User clicks "Sign in" or "Create account" on the landing page.
2. A modal opens with email/password fields (Supabase Auth, email confirmation OFF).
3. On success, `onAuthStateChange` fires and updates the app's user state.
4. If signed in, the landing page shows a "Recent rooms" section with the user's history.
5. When creating or joining a room, a row is inserted into `user_room_history` with the user's ID, room PIN, display name, and role.
6. When leaving a room, the `left_at` timestamp is recorded.
7. In the room sidebar, signed-in users see shield badges next to other signed-in members, and lock icons next to guest members. Guest users don't see badges.

## Troubleshooting

**"No active room found for that code"**
- Make sure the host has created the room and their code is displayed
- The code expires after 10 minutes — ask the host to create a new room
- Both devices need internet connectivity to reach the Supabase database

**Messages not appearing from the other person**
- Both devices must be in the same room (same 6-digit code)
- Check that the network status pill shows "Network online"
- Realtime broadcast requires an active Supabase connection

**File download doesn't start**
- Wait for the upload progress to reach 100% and show "Ready to download"
- The download button only appears for users who didn't upload the file

**Sign-in not working**
- Make sure your Supabase project has email/password auth enabled (it's on by default)
- Email confirmation is OFF — users can sign in immediately after signing up
- Check the browser console for Supabase auth errors

## License

MIT
