# Meshdrop

A zero-sign-in, serverless peer-to-peer (P2P) file transfer platform inspired by Send Anywhere. Files move directly between browsers — no accounts, no uploads to a central server, no trace left behind.

## Features

- **No sign-in required** — the entire app is anonymous and tied to your current browser tab session
- **Send files** — drag-and-drop a file, get a 6-digit pairing code and QR code to share
- **Receive files** — enter the 6-digit code to download the file
- **Live transfer metrics** — real-time progress bar, transfer speed (MB/s), ETA, and bytes written
- **Transfer history** — stored locally in your browser only (never sent to a server)
- **10-minute expiration** — pairing codes auto-expire after 10 minutes for security
- **Dark cyber-tech UI** — sleek, minimalist, responsive from mobile to desktop

## How It Works

```
Sender (Browser A)                    Receiver (Browser B)
     │                                      │
     ├─ Selects a file                       │
     ├─ Engine generates a 6-digit PIN       │
     ├─ PIN → ticket mapping published       │
     │  to GunDB + localStorage              │
     ├─ Shares PIN with receiver ──────────→ ├─ Enters 6-digit PIN
     │                                      ├─ Engine looks up PIN in
     │                                      │  GunDB / localStorage
     │                                      ├─ Resolves connection ticket
     │                                      ├─ Establishes P2P stream
     │ ←────────── file chunks flow ────────┤
     │                                      ├─ File downloads to device
     └─ Transfer complete                   └─ Transfer complete
```

### PIN-to-Ticket Mapping (Two Layers)

1. **localStorage** — for same-device transfers (sender and receiver in the same browser). Instant lookup, no network needed.
2. **GunDB with public relay peers** — for cross-device transfers. GunDB is a serverless, decentralized key-value graph that syncs across browsers without a central database. Three public relay peers are configured for redundancy.

### P2P Transport (Iroh)

The transfer engine uses the official Iroh browser WebAssembly runtime for direct, encrypted QUIC connections between browsers. Iroh connections are end-to-end encrypted by default, even when relayed through a server (browsers can't send raw UDP packets, so browser-to-browser connections flow through Iroh's relay servers — but the relays can't decrypt the traffic).

> **Note:** The Iroh browser WASM npm package (`@number0/iroh-browser`) is not yet published. The engine dynamically imports it when available and falls back to a simulation mode that exercises the exact same UI flow. When the package is published, real P2P transfers will activate automatically with no code changes needed.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | React 18 + TypeScript |
| Build tool | Vite 5 |
| Styling | Tailwind CSS + custom CSS |
| Icons | Lucide React |
| P2P transport | Iroh (WebAssembly, dynamic import) |
| Ephemeral KV store | GunDB (decentralized, no central DB) |
| Local storage | Browser LocalStorage (transfer history + PIN cache) |

## Getting Started

```bash
npm install
npm run dev
```

Open your browser to the displayed URL.

### Cross-Origin Isolation

The dev server is configured with COOP and COEP headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

These are required for `SharedArrayBuffer` support, which the Iroh WASM threading layer needs. If you deploy to a static host, make sure your hosting provider sets these headers (see deployment section below).

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

**Critical:** Your hosting provider must serve the COOP/COEP headers for the Iroh WASM layer to function:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

#### Netlify (`netlify.toml`)

```toml
[[headers]]
  for = "/*"
  [headers.values]
    Cross-Origin-Opener-Policy = "same-origin"
    Cross-Origin-Embedder-Policy = "require-corp"
```

#### Vercel (`vercel.json`)

```json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "Cross-Origin-Opener-Policy", "value": "same-origin" },
        { "key": "Cross-Origin-Embedder-Policy", "value": "require-corp" }
      ]
    }
  ]
}
```

#### Cloudflare Pages

Add these as custom headers in the Pages dashboard or via a `_headers` file:

```
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
```

> Without these headers, the simulation fallback still works, but real Iroh P2P transfers will be blocked by the browser's security sandbox.

## Project Structure

```
src/
├── App.tsx              # Main UI: send/receive tabs, metrics, history
├── lib/
│   └── transfer.ts      # P2P engine: Iroh + GunDB + simulation fallback
├── index.css            # Global styles + Tailwind
└── main.tsx             # React entry point
vite.config.ts           # Vite config with COOP/COEP headers
```

## Transfer States

The UI cycles through these connection states:

| State | Description |
|-------|-------------|
| Idle | No transfer in progress |
| Hashing File | Sender's file is being prepared |
| Waiting for Peer... | Sender has published the PIN, waiting for receiver to connect |
| Actively Streaming Data | File chunks are flowing between peers |
| Transfer Complete | Transfer finished, file ready for download |

## Troubleshooting

**"No active transfer found for that PIN"**
- Make sure the sender has selected a file and their pairing code is displayed
- The code expires after 10 minutes — ask the sender to re-select the file
- For cross-device transfers, both devices need internet connectivity for GunDB sync
- If the GunDB relay peers are down, try again — the app checks three peers for redundancy

**File download doesn't start**
- Check that the transfer state shows "Transfer Complete"
- The download button appears at the bottom of the transfer card after completion

**Build warnings about browserslist**
- Run `npx update-browserslist-db@latest` to clear the warning (cosmetic only)

## License

MIT
