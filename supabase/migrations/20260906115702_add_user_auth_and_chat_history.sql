/*
# Add user authentication and chat history persistence

1. New Tables
- `user_room_history`: stores a log of rooms that a signed-in user has participated in,
  including the room pin, display name used, role (host/member), and timestamps.
  This lets signed-in users look back at their interaction history.

2. Modified Tables
- `room_members`: add `user_id uuid` column (nullable) to link a room member to an
  auth account. Unsigned users have null user_id; signed-in users have their UUID.
- `transfer_chat`: add `user_id uuid` column (nullable) so chat messages can be
  attributed to a signed-in user for history purposes.

3. Security
- `user_room_history`: RLS enabled, owner-scoped (authenticated users can only
  see/modify their own history rows). user_id defaults to auth.uid().
- `room_members` and `transfer_chat`: existing anon+authenticated policies remain.
  The new user_id columns are nullable so unsigned users still work.
*/

-- user_room_history
CREATE TABLE IF NOT EXISTS user_room_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  pin text NOT NULL,
  display_name text NOT NULL DEFAULT 'Anonymous',
  role text NOT NULL DEFAULT 'member',
  joined_at timestamptz DEFAULT now(),
  left_at timestamptz
);

ALTER TABLE user_room_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_history" ON user_room_history;
CREATE POLICY "select_own_history" ON user_room_history FOR SELECT
  TO authenticated USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "insert_own_history" ON user_room_history;
CREATE POLICY "insert_own_history" ON user_room_history FOR INSERT
  TO authenticated WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "update_own_history" ON user_room_history;
CREATE POLICY "update_own_history" ON user_room_history FOR UPDATE
  TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "delete_own_history" ON user_room_history;
CREATE POLICY "delete_own_history" ON user_room_history FOR DELETE
  TO authenticated USING (auth.uid() = user_id);

-- Add user_id to room_members (nullable for unsigned users)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'room_members' AND column_name = 'user_id'
  ) THEN
    ALTER TABLE room_members ADD COLUMN user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Add user_id to transfer_chat (nullable for unsigned users)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'transfer_chat' AND column_name = 'user_id'
  ) THEN
    ALTER TABLE transfer_chat ADD COLUMN user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Index for faster history lookups
CREATE INDEX IF NOT EXISTS idx_user_room_history_user ON user_room_history (user_id);
CREATE INDEX IF NOT EXISTS idx_room_members_user ON room_members (user_id);
