/*
# Add connection handshake columns to transfer_tickets

The connection-first flow needs two status columns so sender and receiver
can coordinate before the file transfer begins:

- `receiver_status`: 'waiting' (default) → 'connected' (receiver resolved PIN)
- `sender_status`: 'ready' (default) → 'ack' (sender saw receiver) → 'chunks_ready' (upload done)

Both default to their initial values so existing rows are treated as "just published".
*/

ALTER TABLE transfer_tickets
  ADD COLUMN IF NOT EXISTS receiver_status text DEFAULT 'waiting',
  ADD COLUMN IF NOT EXISTS sender_status text DEFAULT 'ready';
