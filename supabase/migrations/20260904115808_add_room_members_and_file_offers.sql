/*
# Add room members and file offers tables for multi-person rooms

1. New Tables
- `room_members`: tracks people in each transfer room. Each member has a
  client-generated member_id, display name, role (host/member), and last_seen
  timestamp for presence detection. Unique on (pin, member_id).
- `file_offers`: tracks files shared within a room. Each offer has a
  client-generated file_id, file metadata, sender info, upload status, and
  total chunk count.
2. Modified Tables
- `transfer_chunks`: add `file_id text DEFAULT 'default'` column so multiple
  files can coexist in the same room without collisions.
- `transfer_chat`: add `sender_name text DEFAULT 'Anonymous'` column so chat
  messages can display the sender's display name without a join.
3. Security
- RLS enabled on both new tables with full anon CRUD (no-sign-in app).
- All tables are intentionally public/shared (ephemeral transfer rooms).
*/

-- room_members
CREATE TABLE IF NOT EXISTS room_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pin text NOT NULL,
  member_id text NOT NULL,
  display_name text NOT NULL DEFAULT 'Anonymous',
  role text NOT NULL DEFAULT 'member',
  last_seen timestamptz DEFAULT now(),
  joined_at timestamptz DEFAULT now(),
  UNIQUE(pin, member_id)
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

-- file_offers
CREATE TABLE IF NOT EXISTS file_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pin text NOT NULL,
  file_id text NOT NULL,
  file_name text NOT NULL,
  file_size bigint NOT NULL,
  file_type text NOT NULL DEFAULT 'application/octet-stream',
  sender_id text NOT NULL,
  sender_name text NOT NULL DEFAULT 'Anonymous',
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

-- Add file_id column to transfer_chunks
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'transfer_chunks' AND column_name = 'file_id'
  ) THEN
    ALTER TABLE transfer_chunks ADD COLUMN file_id text DEFAULT 'default';
  END IF;
END $$;

-- Add sender_name column to transfer_chat
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'transfer_chat' AND column_name = 'sender_name'
  ) THEN
    ALTER TABLE transfer_chat ADD COLUMN sender_name text DEFAULT 'Anonymous';
  END IF;
END $$;
