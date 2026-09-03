/*
# Fix transfer_chunks.data column type

The `data` column was `bytea` but the app stores base64-encoded strings.
Postgres interpreted the base64 text as a bytea hex literal, corrupting
the data. `atob()` on the receiver then failed with:
  "The string to be decoded is not correctly encoded."

Fix: change `data` from `bytea` to `text` so base64 strings round-trip
cleanly through Supabase's REST API.
*/

ALTER TABLE transfer_chunks
  ALTER COLUMN data TYPE text
  USING encode(data, 'escape');

DROP INDEX IF EXISTS idx_transfer_chunks_pin_idx;
CREATE INDEX idx_transfer_chunks_pin_idx ON transfer_chunks (pin, chunk_index);
