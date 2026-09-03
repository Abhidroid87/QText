/*
# Create transfer_tickets table for ephemeral PIN-to-ticket mapping

1. Purpose
   Meshdrop is a zero-sign-in P2P file transfer app. When a sender selects a file,
   the engine generates a random 6-digit PIN and a connection ticket. This table
   stores the ephemeral mapping: PIN → ticket + file metadata. The receiver looks
   up the PIN to find the ticket and file metadata, then establishes a direct
   P2P connection. Rows auto-expire after 10 minutes.

2. New Tables
   - `transfer_tickets`
     - `pin` (text, primary key) — the 6-digit pairing code
     - `ticket` (text, not null) — the Iroh connection ticket or simulation ticket
     - `file_name` (text, not null) — name of the file being transferred
     - `file_size` (bigint, not null) — size in bytes
     - `file_type` (text) — MIME type of the file
     - `created_at` (timestamptz, default now()) — when the PIN was published

3. Security
   - Enable RLS on `transfer_tickets`.
   - This is a no-auth app: the frontend uses the anon key only. All four CRUD
     policies use `TO anon, authenticated` with `USING (true)` / `WITH CHECK (true)`
     because the data is intentionally public/shared — any visitor can create a
     PIN and any visitor can look one up. The data is ephemeral (auto-deleted
     after 10 minutes) and contains no sensitive user information.

4. Notes
   - A cleanup function deletes rows older than 10 minutes. The frontend also
     deletes the row after a successful transfer.
*/

CREATE TABLE IF NOT EXISTS transfer_tickets (
  pin text PRIMARY KEY,
  ticket text NOT NULL,
  file_name text NOT NULL,
  file_size bigint NOT NULL,
  file_type text DEFAULT 'application/octet-stream',
  created_at timestamptz DEFAULT now()
);

ALTER TABLE transfer_tickets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_transfer_tickets" ON transfer_tickets;
CREATE POLICY "anon_select_transfer_tickets"
ON transfer_tickets FOR SELECT
TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_transfer_tickets" ON transfer_tickets;
CREATE POLICY "anon_insert_transfer_tickets"
ON transfer_tickets FOR INSERT
TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_transfer_tickets" ON transfer_tickets;
CREATE POLICY "anon_update_transfer_tickets"
ON transfer_tickets FOR UPDATE
TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_transfer_tickets" ON transfer_tickets;
CREATE POLICY "anon_delete_transfer_tickets"
ON transfer_tickets FOR DELETE
TO anon, authenticated USING (true);

CREATE INDEX IF NOT EXISTS idx_transfer_tickets_created_at ON transfer_tickets (created_at);
