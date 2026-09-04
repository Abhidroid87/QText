/*
# Create room_members, transfer_chat, file_offers, transfer_chunks tables
# and add status columns to transfer_tickets

1. Purpose
   Meshdrop uses a room-based transfer model. When a user creates a room,
   others join via a 6-digit PIN. Inside the room, members can chat and
   share files. This migration creates all the tables needed for that flow.

2. New Tables
   - room_members: tracks who is in each room (PIN-keyed)
     - pin (text), member_id (text), display_name (text), role (text),
       last_seen (timestamptz)
   - transfer_chat: chat messages within a room
     - id (bigserial pk), pin (text), sender (text), sender_name (text),
       message (text), created_at (timestamptz)
   - file_offers: file metadata for files shared in a room
     - file_id (text pk), pin (text), file_name (text), file_size (bigint),
       file_type (text), sender_id (text), sender_name (text), status (text),
       total_chunks (int), created_at (timestamptz)
   - transfer_chunks: base64-encoded file data chunks relayed through Supabase
     - id (bigserial pk), pin (text), file_id (text), chunk_index (int),
       data (text), created_at (timestamptz)

3. Modified Tables
   - transfer_tickets: add sender_status and receiver_status text columns

4. Security
   - RLS enabled on all new tables
   - All policies use TO anon, authenticated with USING(true) / WITH CHECK(true)
     because this is a no-auth app — data is intentionally public/shared and
     ephemeral (auto-deleted after 10 minutes)
*/

-- Add status columns to transfer_tickets
ALTER TABLE transfer_tickets ADD COLUMN IF NOT EXISTS sender_status text DEFAULT 'ready';
ALTER TABLE transfer_tickets ADD COLUMN IF NOT EXISTS receiver_status text DEFAULT 'waiting';

-- room_members
CREATE TABLE IF NOT EXISTS room_members (
  pin text NOT NULL,
  member_id text NOT NULL,
  display_name text NOT NULL,
  role text NOT NULL DEFAULT 'member',
  last_seen timestamptz DEFAULT now(),
  PRIMARY KEY (pin, member_id)
);

ALTER TABLE room_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_room_members" ON room_members;
CREATE POLICY "anon_select_room_members" ON room_members FOR SELECT
  TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_room_members" ON room_members;
CREATE POLICY "anon_insert_room_members" ON room_members FOR INSERT
  TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_room_members" ON room_members;
CREATE POLICY "anon_update_room_members" ON room_members FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_room_members" ON room_members;
CREATE POLICY "anon_delete_room_members" ON room_members FOR DELETE
  TO anon, authenticated USING (true);

-- transfer_chat
CREATE TABLE IF NOT EXISTS transfer_chat (
  id bigserial PRIMARY KEY,
  pin text NOT NULL,
  sender text NOT NULL DEFAULT 'system',
  sender_name text NOT NULL DEFAULT 'System',
  message text NOT NULL,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE transfer_chat ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_transfer_chat" ON transfer_chat;
CREATE POLICY "anon_select_transfer_chat" ON transfer_chat FOR SELECT
  TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_transfer_chat" ON transfer_chat;
CREATE POLICY "anon_insert_transfer_chat" ON transfer_chat FOR INSERT
  TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_transfer_chat" ON transfer_chat;
CREATE POLICY "anon_update_transfer_chat" ON transfer_chat FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_transfer_chat" ON transfer_chat;
CREATE POLICY "anon_delete_transfer_chat" ON transfer_chat FOR DELETE
  TO anon, authenticated USING (true);

-- file_offers
CREATE TABLE IF NOT EXISTS file_offers (
  file_id text PRIMARY KEY,
  pin text NOT NULL,
  file_name text NOT NULL,
  file_size bigint NOT NULL,
  file_type text DEFAULT 'application/octet-stream',
  sender_id text NOT NULL,
  sender_name text NOT NULL,
  status text NOT NULL DEFAULT 'offered',
  total_chunks int NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE file_offers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_file_offers" ON file_offers;
CREATE POLICY "anon_select_file_offers" ON file_offers FOR SELECT
  TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_file_offers" ON file_offers;
CREATE POLICY "anon_insert_file_offers" ON file_offers FOR INSERT
  TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_file_offers" ON file_offers;
CREATE POLICY "anon_update_file_offers" ON file_offers FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_file_offers" ON file_offers;
CREATE POLICY "anon_delete_file_offers" ON file_offers FOR DELETE
  TO anon, authenticated USING (true);

-- transfer_chunks
CREATE TABLE IF NOT EXISTS transfer_chunks (
  id bigserial PRIMARY KEY,
  pin text NOT NULL,
  file_id text NOT NULL,
  chunk_index int NOT NULL,
  data text NOT NULL,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE transfer_chunks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_transfer_chunks" ON transfer_chunks;
CREATE POLICY "anon_select_transfer_chunks" ON transfer_chunks FOR SELECT
  TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_transfer_chunks" ON transfer_chunks;
CREATE POLICY "anon_insert_transfer_chunks" ON transfer_chunks FOR INSERT
  TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_transfer_chunks" ON transfer_chunks;
CREATE POLICY "anon_update_transfer_chunks" ON transfer_chunks FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_transfer_chunks" ON transfer_chunks;
CREATE POLICY "anon_delete_transfer_chunks" ON transfer_chunks FOR DELETE
  TO anon, authenticated USING (true);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_room_members_pin ON room_members (pin);
CREATE INDEX IF NOT EXISTS idx_transfer_chat_pin ON transfer_chat (pin);
CREATE INDEX IF NOT EXISTS idx_file_offers_pin ON file_offers (pin);
CREATE INDEX IF NOT EXISTS idx_transfer_chunks_pin_file ON transfer_chunks (pin, file_id);
CREATE INDEX IF NOT EXISTS idx_transfer_chunks_pin_file_chunk ON transfer_chunks (pin, file_id, chunk_index);
