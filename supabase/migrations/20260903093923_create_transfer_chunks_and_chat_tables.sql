/*
# Add transfer_chunks and transfer_chat tables

1. New Tables
   - `transfer_chunks` — stores file data in 256KB chunks for reliable cross-device transfer
   - `transfer_chat` — stores ephemeral text chat messages between sender and receiver

2. Security
   - RLS enabled on both tables with anon+authenticated CRUD (no-auth app, ephemeral data)
*/

CREATE TABLE IF NOT EXISTS transfer_chunks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pin text NOT NULL,
  chunk_index integer NOT NULL,
  data bytea NOT NULL,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE transfer_chunks ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_transfer_chunks_pin_idx ON transfer_chunks (pin, chunk_index);

DROP POLICY IF EXISTS "anon_select_transfer_chunks" ON transfer_chunks;
CREATE POLICY "anon_select_transfer_chunks"
ON transfer_chunks FOR SELECT
TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_transfer_chunks" ON transfer_chunks;
CREATE POLICY "anon_insert_transfer_chunks"
ON transfer_chunks FOR INSERT
TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_transfer_chunks" ON transfer_chunks;
CREATE POLICY "anon_delete_transfer_chunks"
ON transfer_chunks FOR DELETE
TO anon, authenticated USING (true);

CREATE TABLE IF NOT EXISTS transfer_chat (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pin text NOT NULL,
  sender text NOT NULL,
  message text NOT NULL,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE transfer_chat ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_transfer_chat_pin_created ON transfer_chat (pin, created_at);

DROP POLICY IF EXISTS "anon_select_transfer_chat" ON transfer_chat;
CREATE POLICY "anon_select_transfer_chat"
ON transfer_chat FOR SELECT
TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_transfer_chat" ON transfer_chat;
CREATE POLICY "anon_insert_transfer_chat"
ON transfer_chat FOR INSERT
TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_transfer_chat" ON transfer_chat;
CREATE POLICY "anon_delete_transfer_chat"
ON transfer_chat FOR DELETE
TO anon, authenticated USING (true);
