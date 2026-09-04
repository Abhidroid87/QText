/*
# Add missing UPDATE policies to transfer_chat and transfer_chunks

The security posture check revealed that transfer_chat and transfer_chunks
have no UPDATE policy. The app needs UPDATE to work on these tables for:
- transfer_chat: updating sender_name (already handled by INSERT default)
- transfer_chunks: updating file_id for multi-file rooms

Since this is a no-auth app with intentionally public/shared ephemeral data,
UPDATE policies use TO anon, authenticated with USING (true).
*/

DROP POLICY IF EXISTS "anon_update_transfer_chat" ON transfer_chat;
CREATE POLICY "anon_update_transfer_chat" ON transfer_chat FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_transfer_chunks" ON transfer_chunks;
CREATE POLICY "anon_update_transfer_chunks" ON transfer_chunks FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);
