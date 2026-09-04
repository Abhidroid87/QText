/*
# Add unique constraint on transfer_chunks

1. Purpose
   The transfer_chunks table had no unique constraint on (pin, file_id, chunk_index).
   When an upload retry happened, duplicate chunks were inserted. The download
   query used maybeSingle() which errors when multiple rows match, causing file
   downloads to fail.

2. Changes
   - Add UNIQUE constraint on (pin, file_id, chunk_index)
   - Delete any existing duplicate rows before adding the constraint

3. Notes
   This makes upsert with onConflict work correctly for chunk uploads.
*/

-- Remove existing duplicates (keep the latest one by id)
DELETE FROM transfer_chunks
WHERE id NOT IN (
  SELECT MAX(id) FROM transfer_chunks
  GROUP BY pin, file_id, chunk_index
);

-- Add unique constraint
CREATE UNIQUE INDEX IF NOT EXISTS idx_transfer_chunks_unique
ON transfer_chunks (pin, file_id, chunk_index);
