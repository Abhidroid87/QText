/*
# Add chunked file transfer and real-time chat support

1. Purpose
   The original transfer_tickets table only stored a PIN → ticket mapping.
   Since the Iroh browser WASM package was never published, cross-device
   transfers failed for files over 4MB. This migration adds:

   - `transfer_chunks` table: stores file data in 256KB chunks keyed by PIN,
     enabling reliable transfer of any file type/size through Supabase.
   - `transfer_chat` table: stores ephemeral text messages between sender
     and receiver, keyed by PIN.

2. New Tables
   - `transfer_chunks`
     - `id` (bigint identity, primary key)
     - `pin` (text, not null) — the 6-digit pairing code
     - `chunk_index` (integer, not null) — order of this chunk in the file
     - `data` (bytea, not null) — the raw file bytes for this chunk
     - `created_at` (timestamptz, default now())
     - Index on (pin, chunk_index) for efficient ordered retrieval

   - `transfer_chat`
     - `id` (bigint identity, primary key)
     - `pin` (text, not null) — the 6-digit pairing code
     - `sender` (text, not null) — 'sender' or 'receiver'
     - `message` (text, not null) — the chat message content
     - `created_at` (timestamptz, default now())
     - Index on (pin, created_at) for message ordering

3. Security
   - Enable RLS on both new tables.
   - This is a no-auth app: all policies use `TO anon, authenticated` with
     `USING (true)` / `WITH CHECK (true)` because the data is intentionally
     public/shared and ephemeral (auto-deleted after 10 minutes).

4. Notes
   - The existing transfer_tickets table is unchanged.
   - Chunks are 256KB each, allowing files up to ~2GB (Supabase row size limits permitting).
   - The frontend deletes all chunks and chat messages after a transfer completes.
*/
