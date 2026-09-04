/*
# Add tables to Supabase realtime publication

1. Purpose
   postgres_changes realtime events only fire for tables that are part of
   the supabase_realtime publication. Currently NO tables are in it, which
   is why file offers and member joins/leaves are invisible to other room
   participants. Chat works because it uses broadcast channels (a separate
   mechanism that doesn't need the publication).

2. Changes
   - Add file_offers and room_members to supabase_realtime publication
*/

ALTER PUBLICATION supabase_realtime ADD TABLE file_offers;
ALTER PUBLICATION supabase_realtime ADD TABLE room_members;
