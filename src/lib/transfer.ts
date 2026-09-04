/**
 * Peer-to-peer transfer engine for Meshdrop.
 *
 * Transport strategy (in priority order):
 *   1. Same-device fast path (in-memory, when sender+receiver share a browser)
 *   2. WebRTC data channel (when both peers are online and signaling succeeds)
 *   3. Supabase chunk relay (fallback — works on any static host including
 *      GitHub Pages, since it only needs the Supabase REST API)
 *
 * Supabase is used for:
 *   - `transfer_tickets`: PIN → file metadata + connection state
 *   - `transfer_chunks`: chunked file relay fallback
 *   - `transfer_chat`: ephemeral text messages
 *   - Supabase Realtime: connection handshake + WebRTC SDP/ICE exchange
 *
 * Connection-first flow:
 *   The receiver resolves the PIN, then both sides exchange a "ping/pong"
 *   through the ticket row's `receiver_status` / `sender_status` columns.
 *   Only after the connection is confirmed does the file transfer begin.
 */

import { createClient, type RealtimeChannel } from '@supabase/supabase-js';

// --- Types ------------------------------------------------------------------

export type TransferStage =
  | 'Idle'
  | 'Hashing File'
  | 'Waiting for Peer...'
  | 'Connecting...'
  | 'Connected'
  | 'Actively Streaming Data'
  | 'Transfer Complete';

export type TransferProgress = {
  percent: number;
  bytesTransferred: number;
  totalBytes: number;
  speed: number;
  eta: number;
};

export type TransferCallbacks = {
  onStage: (stage: TransferStage) => void;
  onProgress: (progress: TransferProgress) => void;
  onComplete: (downloadUrl: string, fileName: string, fileSize: number) => void;
  onError: (message: string) => void;
};

export type ChatMessage = {
  id: string;
  sender: 'sender' | 'receiver';
  message: string;
  timestamp: number;
};

export type ChatCallbacks = {
  onMessage: (msg: ChatMessage) => void;
};

export type SenderSession = {
  pairingPin: string;
  file: File;
};

export type ReceiverSession = {
  pairingPin: string;
  fileName: string;
  fileSize: number;
  downloadUrl: string;
};

type TransferMeta = { fileName: string; fileSize: number; fileType: string };
type TicketEntry = TransferMeta & { ticket: string };

// --- Constants --------------------------------------------------------------

const TICKET_TTL_MS = 10 * 60 * 1000;
const STORAGE_PREFIX = 'meshdrop-pin-';
const CHUNK_SIZE = 256 * 1024; // 256KB per chunk for Supabase relay
const WEBRTC_CHUNK_SIZE = 16 * 1024; // 16KB per WebRTC message
const RESOLVE_TIMEOUT_MS = 60000; // 60 seconds to find a PIN
const RESOLVE_POLL_MS = 1000;
const HANDSHAKE_TIMEOUT_MS = 45000; // 45 seconds for connection handshake
const HANDSHAKE_POLL_MS = 500;
const MAX_MESSAGE_LENGTH = 1000;
const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

// --- Supabase client --------------------------------------------------------

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

const supabase = supabaseUrl && supabaseAnonKey && /^https?:\/\//i.test(supabaseUrl)
  ? createClient(supabaseUrl, supabaseAnonKey, {
      realtime: { params: { eventsPerSecond: 20 } },
    })
  : null;

// --- Utilities --------------------------------------------------------------

function generatePin(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function formatSpeed(bytesPerSec: number): number {
  return +(bytesPerSec / (1024 * 1024)).toFixed(1);
}

function calcEta(remainingBytes: number, bytesPerSec: number): number {
  if (bytesPerSec <= 0) return 0;
  return Math.ceil(remainingBytes / bytesPerSec);
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunkLen = 8192;
  for (let i = 0; i < bytes.length; i += chunkLen) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkLen));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function fileToChunks(file: File, size: number): Promise<ArrayBuffer[]> {
  const chunks: ArrayBuffer[] = [];
  for (let offset = 0; offset < file.size; offset += size) {
    const buf = await file.slice(offset, offset + size).arrayBuffer();
    chunks.push(buf);
  }
  return chunks;
}

const defaultCallbacks: TransferCallbacks = {
  onStage: () => {},
  onProgress: () => {},
  onComplete: () => {},
  onError: () => {},
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- In-memory store (same-device fast path) --------------------------------

const inMemoryFiles = new Map<string, { chunks: ArrayBuffer[]; meta: TransferMeta }>();
const activeSenderSessions = new Map<string, SenderSession>();

// --- PIN → Ticket store (Supabase + localStorage) ---------------------------

async function publishTicket(pin: string, meta: TransferMeta): Promise<void> {
  const entry = {
    ticket: `mem:${pin}`,
    fileName: meta.fileName,
    fileSize: String(meta.fileSize),
    fileType: meta.fileType,
    ts: String(Date.now()),
  };
  const key = STORAGE_PREFIX + pin;
  try {
    localStorage.setItem(key, JSON.stringify(entry));
  } catch {
    /* quota */
  }

  try {
    if (!supabase) return;
    await supabase.from('transfer_tickets').upsert({
      pin,
      ticket: `supa:${pin}`,
      file_name: meta.fileName,
      file_size: meta.fileSize,
      file_type: meta.fileType,
      receiver_status: 'waiting',
      sender_status: 'ready',
    });
  } catch (error) {
    console.warn('Could not publish to Supabase (cross-device may fail):', (error as Error).message);
  }

  setTimeout(() => {
    try {
      localStorage.removeItem(key);
    } catch {
      /* gone */
    }
    if (supabase) {
      void supabase.from('transfer_tickets').delete().eq('pin', pin);
      void supabase.from('transfer_chunks').delete().eq('pin', pin);
      void supabase.from('transfer_chat').delete().eq('pin', pin);
    }
  }, TICKET_TTL_MS);
}

async function resolveTicket(pin: string): Promise<TicketEntry | null> {
  const key = STORAGE_PREFIX + pin;

  // Same-device fast path
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const data = JSON.parse(raw) as {
        ticket: string;
        fileName: string;
        fileSize: string;
        fileType?: string;
      };
      if (data.ticket) {
        return {
          ticket: data.ticket,
          fileName: data.fileName,
          fileSize: parseInt(data.fileSize || '0', 10),
          fileType: data.fileType || 'application/octet-stream',
        };
      }
    }
  } catch {
    /* parse error */
  }

  if (!supabase) return null;

  const deadline = Date.now() + RESOLVE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const { data, error } = await supabase
        .from('transfer_tickets')
        .select('pin, ticket, file_name, file_size, file_type')
        .eq('pin', pin)
        .maybeSingle();

      if (error) throw error;
      if (data) {
        return {
          ticket: data.ticket,
          fileName: data.file_name,
          fileSize: data.file_size,
          fileType: data.file_type || 'application/octet-stream',
        };
      }
    } catch {
      /* network blip — keep polling */
    }
    await sleep(RESOLVE_POLL_MS);
  }

  return null;
}

async function deleteTicket(pin: string): Promise<void> {
  try {
    localStorage.removeItem(STORAGE_PREFIX + pin);
  } catch {
    /* gone */
  }
  try {
    if (supabase) {
      await supabase.from('transfer_tickets').delete().eq('pin', pin);
      await supabase.from('transfer_chunks').delete().eq('pin', pin);
      await supabase.from('transfer_chat').delete().eq('pin', pin);
    }
  } catch {
    /* gone */
  }
}

// --- Connection Handshake ---------------------------------------------------
//
// Uses the `receiver_status` and `sender_status` columns on transfer_tickets
// to coordinate a connection-first flow:
//   1. Receiver resolves PIN → sets receiver_status = 'connected'
//   2. Sender detects receiver_status = 'connected' → sets sender_status = 'ack'
//   3. Receiver detects sender_status = 'ack' → connection confirmed
//
// This ensures both sides know the other is present before transferring.

async function receiverSignalConnected(pin: string): Promise<void> {
  if (!supabase) return;
  try {
    await supabase
      .from('transfer_tickets')
      .update({ receiver_status: 'connected' })
      .eq('pin', pin);
  } catch {
    /* non-fatal */
  }
}

async function senderAckConnected(pin: string): Promise<void> {
  if (!supabase) return;
  try {
    await supabase
      .from('transfer_tickets')
      .update({ sender_status: 'ack' })
      .eq('pin', pin);
  } catch {
    /* non-fatal */
  }
}

async function waitForReceiverConnection(pin: string): Promise<boolean> {
  if (!supabase) {
    // No Supabase — check localStorage (same-device)
    return inMemoryFiles.has(pin);
  }

  const deadline = Date.now() + HANDSHAKE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const { data, error } = await supabase
        .from('transfer_tickets')
        .select('receiver_status')
        .eq('pin', pin)
        .maybeSingle();

      if (!error && data?.receiver_status === 'connected') {
        await senderAckConnected(pin);
        return true;
      }
    } catch {
      /* keep polling */
    }

    // Also check same-device fast path
    if (inMemoryFiles.has(pin) && localStorage.getItem(STORAGE_PREFIX + pin)) {
      return true;
    }

    await sleep(HANDSHAKE_POLL_MS);
  }

  return false;
}

async function waitForSenderAck(pin: string): Promise<boolean> {
  if (!supabase) return true; // same-device, no ack needed

  const deadline = Date.now() + HANDSHAKE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const { data, error } = await supabase
        .from('transfer_tickets')
        .select('sender_status')
        .eq('pin', pin)
        .maybeSingle();

      if (!error && data?.sender_status === 'ack') {
        return true;
      }
    } catch {
      /* keep polling */
    }
    await sleep(HANDSHAKE_POLL_MS);
  }

  return false;
}

// --- WebRTC Signaling via Supabase Realtime ---------------------------------

type SignalPayload =
  | { type: 'offer'; sdp: string }
  | { type: 'answer'; sdp: string }
  | { type: 'ice'; candidate: string; sdpMid: string | null; sdpMLineIndex: number | null };

let signalChannel: RealtimeChannel | null = null;

function joinSignalChannel(pin: string, onSignal: (payload: SignalPayload) => void): void {
  if (!supabase) return;

  if (signalChannel) {
    void supabase.removeChannel(signalChannel);
    signalChannel = null;
  }

  signalChannel = supabase
    .channel(`signal:${pin}`)
    .on('broadcast', { event: 'signal' }, (payload: { payload: SignalPayload }) => {
      onSignal(payload.payload);
    })
    .subscribe();
}

function sendSignal(pin: string, payload: SignalPayload): void {
  if (!signalChannel) return;
  void signalChannel.send({ type: 'broadcast', event: 'signal', payload });
}

function leaveSignalChannel(): void {
  if (signalChannel && supabase) {
    void supabase.removeChannel(signalChannel);
    signalChannel = null;
  }
}

// --- WebRTC Sender -----------------------------------------------------------

async function sendViaWebRTC(
  pin: string,
  file: File,
  chunks: ArrayBuffer[],
  cb: TransferCallbacks,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    const dc = pc.createDataChannel('file-transfer', { ordered: true });
    let transferred = 0;
    const startTime = Date.now();
    let chunkIndex = 0;
    let resolved = false;

    const cleanup = () => {
      dc.close();
      pc.close();
      leaveSignalChannel();
    };

    const fail = (msg: string) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      cb.onError(msg);
      reject(new Error(msg));
    };

    cb.onStage('Connecting...');

    joinSignalChannel(pin, async (signal) => {
      try {
        if (signal.type === 'answer') {
          await pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
        } else if (signal.type === 'ice') {
          await pc.addIceCandidate({
            candidate: signal.candidate,
            sdpMid: signal.sdpMid,
            sdpMLineIndex: signal.sdpMLineIndex,
          });
        }
      } catch (err) {
        fail(`Signaling error: ${(err as Error).message}`);
      }
    });

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignal(pin, {
          type: 'ice',
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
        });
      }
    };

    dc.onopen = () => {
      cb.onStage('Actively Streaming Data');
      sendNext();
    };

    dc.onclose = () => {
      if (!resolved) {
        if (chunkIndex >= chunks.length) {
          resolved = true;
          cb.onStage('Transfer Complete');
          cleanup();
          resolve();
        } else {
          fail('Connection closed before transfer completed');
        }
      }
    };

    dc.onerror = () => fail('Data channel error');

    function sendNext() {
      if (dc.bufferedAmount > 4 * 1024 * 1024) {
        setTimeout(sendNext, 20);
        return;
      }
      if (chunkIndex >= chunks.length) {
        dc.send(JSON.stringify({ done: true }));
        setTimeout(() => {
          if (!resolved) {
            resolved = true;
            cb.onStage('Transfer Complete');
            cleanup();
            resolve();
          }
        }, 500);
        return;
      }
      const chunk = chunks[chunkIndex];
      dc.send(chunk);
      transferred += chunk.byteLength;
      chunkIndex++;

      const elapsed = (Date.now() - startTime) / 1000;
      cb.onProgress({
        percent: Math.round((transferred / file.size) * 100),
        bytesTransferred: transferred,
        totalBytes: file.size,
        speed: formatSpeed(transferred / Math.max(elapsed, 0.1)),
        eta: calcEta(file.size - transferred, transferred / Math.max(elapsed, 0.1)),
      });

      sendNext();
    }

    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .then(() => {
        sendSignal(pin, { type: 'offer', sdp: pc.localDescription!.sdp ?? '' });
      })
      .catch((err) => fail(`Failed to create offer: ${(err as Error).message}`));

    setTimeout(() => {
      if (!resolved && dc.readyState !== 'open') {
        fail('Connection timed out — the receiver may not be online');
      }
    }, 30000);
  });
}

// --- WebRTC Receiver --------------------------------------------------------

async function receiveViaWebRTC(
  pin: string,
  totalSize: number,
  fileType: string,
  cb: TransferCallbacks,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    let dc: RTCDataChannel | null = null;
    const receivedChunks: ArrayBuffer[] = [];
    let transferred = 0;
    const startTime = Date.now();
    let resolved = false;

    const cleanup = () => {
      if (dc) dc.close();
      pc.close();
      leaveSignalChannel();
    };

    const fail = (msg: string) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      cb.onError(msg);
      reject(new Error(msg));
    };

    cb.onStage('Connecting...');

    joinSignalChannel(pin, async (signal) => {
      try {
        if (signal.type === 'offer') {
          await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          sendSignal(pin, { type: 'answer', sdp: answer.sdp ?? '' });
        } else if (signal.type === 'ice') {
          await pc.addIceCandidate({
            candidate: signal.candidate,
            sdpMid: signal.sdpMid,
            sdpMLineIndex: signal.sdpMLineIndex,
          });
        }
      } catch (err) {
        fail(`Signaling error: ${(err as Error).message}`);
      }
    });

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignal(pin, {
          type: 'ice',
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
        });
      }
    };

    pc.ondatachannel = (event) => {
      dc = event.channel;
      cb.onStage('Actively Streaming Data');

      dc.onmessage = (event) => {
        if (typeof event.data === 'string') {
          try {
            const msg = JSON.parse(event.data);
            if (msg.done) {
              resolved = true;
              cb.onStage('Transfer Complete');
              const url = URL.createObjectURL(
                new Blob(receivedChunks, { type: fileType }),
              );
              cleanup();
              resolve(url);
              return;
            }
          } catch {
            /* not JSON */
          }
        }

        if (event.data instanceof ArrayBuffer) {
          receivedChunks.push(event.data);
          transferred += event.data.byteLength;

          const elapsed = (Date.now() - startTime) / 1000;
          cb.onProgress({
            percent: Math.round((transferred / totalSize) * 100),
            bytesTransferred: transferred,
            totalBytes: totalSize,
            speed: formatSpeed(transferred / Math.max(elapsed, 0.1)),
            eta: calcEta(totalSize - transferred, transferred / Math.max(elapsed, 0.1)),
          });
        }
      };

      dc.onclose = () => {
        if (!resolved) {
          if (transferred >= totalSize) {
            resolved = true;
            cb.onStage('Transfer Complete');
            const url = URL.createObjectURL(
              new Blob(receivedChunks, { type: fileType }),
            );
            cleanup();
            resolve(url);
          } else {
            fail('Connection closed before transfer completed');
          }
        }
      };

      dc.onerror = () => fail('Data channel error');
    };

    setTimeout(() => {
      if (!resolved && (!dc || dc.readyState !== 'open')) {
        fail('Connection timed out — the sender may not be online');
      }
    }, 30000);
  });
}

// --- Supabase Chunk Relay (fallback transport) ------------------------------

async function sendViaSupabaseChunks(
  pin: string,
  file: File,
  chunks: ArrayBuffer[],
  cb: TransferCallbacks,
): Promise<void> {
  if (!supabase) throw new Error('Supabase is not configured');

  cb.onStage('Actively Streaming Data');
  let transferred = 0;
  const startTime = Date.now();

  for (let i = 0; i < chunks.length; i++) {
    const b64 = arrayBufferToBase64(chunks[i]);
    let retries = 0;
    const maxRetries = 5;

    while (retries < maxRetries) {
      try {
        const { error } = await supabase.from('transfer_chunks').insert({
          pin,
          chunk_index: i,
          data: b64,
        });
        if (error) throw error;
        break;
      } catch (err) {
        retries++;
        if (retries >= maxRetries) {
          throw new Error(
            `Failed to upload chunk ${i}: ${(err as Error).message}`,
          );
        }
        await sleep(1000 * retries);
      }
    }

    transferred += chunks[i].byteLength;
    const elapsed = (Date.now() - startTime) / 1000;
    cb.onProgress({
      percent: Math.round((transferred / file.size) * 100),
      bytesTransferred: transferred,
      totalBytes: file.size,
      speed: formatSpeed(transferred / Math.max(elapsed, 0.1)),
      eta: calcEta(file.size - transferred, transferred / Math.max(elapsed, 0.1)),
    });
  }

  // Signal that all chunks are uploaded
  await supabase
    .from('transfer_tickets')
    .update({ sender_status: 'chunks_ready' })
    .eq('pin', pin);

  cb.onStage('Transfer Complete');
}

async function receiveViaSupabaseChunks(
  pin: string,
  totalSize: number,
  fileType: string,
  cb: TransferCallbacks,
): Promise<string> {
  if (!supabase) throw new Error('Supabase is not configured');

  cb.onStage('Actively Streaming Data');

  const receivedChunks: ArrayBuffer[] = [];
  let transferred = 0;
  const startTime = Date.now();
  const expectedChunks = Math.ceil(totalSize / CHUNK_SIZE);

  // Wait for sender to signal chunks_ready, or start polling as chunks arrive
  let chunksReady = false;
  const readyDeadline = Date.now() + HANDSHAKE_TIMEOUT_MS;
  while (Date.now() < readyDeadline && !chunksReady) {
    try {
      const { data } = await supabase
        .from('transfer_tickets')
        .select('sender_status')
        .eq('pin', pin)
        .maybeSingle();
      if (data?.sender_status === 'chunks_ready') {
        chunksReady = true;
        break;
      }
    } catch {
      /* keep polling */
    }

    // Also check if chunks are already arriving
    const { count } = await supabase
      .from('transfer_chunks')
      .select('id', { count: 'exact', head: true })
      .eq('pin', pin);
    if (count && count > 0) {
      // Chunks are arriving — start receiving them as they come
      break;
    }

    await sleep(500);
  }

  // Poll for chunks until we have them all
  let nextIndex = 0;
  const pollDeadline = Date.now() + 5 * 60 * 1000; // 5 min max for receiving

  while (nextIndex < expectedChunks && Date.now() < pollDeadline) {
    try {
      const { data, error } = await supabase
        .from('transfer_chunks')
        .select('chunk_index, data')
        .eq('pin', pin)
        .eq('chunk_index', nextIndex)
        .maybeSingle();

      if (error) throw error;

      if (data) {
        const buf = base64ToArrayBuffer(data.data);
        receivedChunks.push(buf);
        transferred += buf.byteLength;
        nextIndex++;

        const elapsed = (Date.now() - startTime) / 1000;
        cb.onProgress({
          percent: Math.round((transferred / totalSize) * 100),
          bytesTransferred: transferred,
          totalBytes: totalSize,
          speed: formatSpeed(transferred / Math.max(elapsed, 0.1)),
          eta: calcEta(totalSize - transferred, transferred / Math.max(elapsed, 0.1)),
        });
      } else {
        await sleep(300);
      }
    } catch {
      await sleep(500);
    }
  }

  if (nextIndex < expectedChunks) {
    throw new Error('Transfer timed out — not all file chunks were received');
  }

  const url = URL.createObjectURL(new Blob(receivedChunks, { type: fileType }));
  cb.onStage('Transfer Complete');
  return url;
}

// --- Chat -------------------------------------------------------------------

let chatChannel: RealtimeChannel | null = null;

export function joinChat(
  pin: string,
  role: 'sender' | 'receiver',
  callbacks: ChatCallbacks,
): void {
  if (!supabase) return;

  if (chatChannel) {
    void supabase.removeChannel(chatChannel);
    chatChannel = null;
  }

  chatChannel = supabase
    .channel(`chat:${pin}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'transfer_chat',
        filter: `pin=eq.${pin}`,
      },
      (payload) => {
        const row = payload.new as {
          id: string;
          pin: string;
          sender: string;
          message: string;
          created_at: string;
        };
        callbacks.onMessage({
          id: String(row.id),
          sender: row.sender as 'sender' | 'receiver',
          message: row.message,
          timestamp: new Date(row.created_at).getTime(),
        });
      },
    )
    .subscribe();
}

export async function sendChatMessage(
  pin: string,
  sender: 'sender' | 'receiver',
  message: string,
): Promise<void> {
  const trimmed = message.trim().slice(0, MAX_MESSAGE_LENGTH);
  if (!trimmed) return;
  if (!supabase) return;

  const { error } = await supabase.from('transfer_chat').insert({
    pin,
    sender,
    message: trimmed,
  });
  if (error) throw new Error(`Failed to send message: ${error.message}`);
}

export async function loadChatHistory(pin: string): Promise<ChatMessage[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('transfer_chat')
    .select('id, sender, message, created_at')
    .eq('pin', pin)
    .order('created_at')
    .limit(100);
  if (error || !data) return [];
  return data.map((row) => ({
    id: String(row.id),
    sender: row.sender as 'sender' | 'receiver',
    message: row.message,
    timestamp: new Date(row.created_at).getTime(),
  }));
}

export function leaveChat(): void {
  if (chatChannel && supabase) {
    void supabase.removeChannel(chatChannel);
    chatChannel = null;
  }
  leaveSignalChannel();
}

// --- Public API: Sender ------------------------------------------------------

export async function initSenderEngine(
  file: File,
  cb?: TransferCallbacks,
): Promise<SenderSession> {
  const cbs = cb ?? defaultCallbacks;
  const pin = generatePin();
  cbs.onStage('Hashing File');

  const meta: TransferMeta = {
    fileName: file.name,
    fileSize: file.size,
    fileType: file.type || 'application/octet-stream',
  };

  // Pre-chunk the file for both WebRTC and Supabase relay paths
  const chunkSize = supabase ? CHUNK_SIZE : WEBRTC_CHUNK_SIZE;
  const chunks = await fileToChunks(file, chunkSize);
  inMemoryFiles.set(pin, { chunks, meta });

  await publishTicket(pin, meta);
  cbs.onStage('Waiting for Peer...');

  const session = { pairingPin: pin, file };
  activeSenderSessions.set(pin, session);
  return session;
}

export async function streamSenderFile(
  pin: string,
  cb?: TransferCallbacks,
): Promise<void> {
  const cbs = cb ?? defaultCallbacks;
  const session = activeSenderSessions.get(pin);
  if (!session) return;

  const stored = inMemoryFiles.get(pin);
  if (!stored) return;

  // Same-device fast path: in-memory, no network needed
  if (inMemoryFiles.has(pin) && localStorage.getItem(STORAGE_PREFIX + pin)) {
    cbs.onStage('Actively Streaming Data');
    let transferred = 0;
    const startTime = Date.now();
    for (const chunk of stored.chunks) {
      await sleep(5);
      transferred += chunk.byteLength;
      const elapsed = (Date.now() - startTime) / 1000;
      cbs.onProgress({
        percent: Math.round((transferred / stored.meta.fileSize) * 100),
        bytesTransferred: transferred,
        totalBytes: stored.meta.fileSize,
        speed: formatSpeed(transferred / Math.max(elapsed, 0.1)),
        eta: calcEta(
          stored.meta.fileSize - transferred,
          transferred / Math.max(elapsed, 0.1),
        ),
      });
    }
    cbs.onStage('Transfer Complete');
    activeSenderSessions.delete(pin);
    return;
  }

  if (!supabase) {
    cbs.onError('Cannot transfer cross-device without Supabase configuration');
    return;
  }

  // --- Connection-first handshake ---
  cbs.onStage('Connecting...');

  // Wait for receiver to signal it's connected
  const receiverReady = await waitForReceiverConnection(pin);
  if (!receiverReady) {
    cbs.onError('No receiver connected within the timeout. Ask the receiver to enter the code again.');
    return;
  }

  cbs.onStage('Connected');

  // Try WebRTC first (faster, true P2P), fall back to Supabase chunk relay
  try {
    await sendViaWebRTC(pin, session.file, stored.chunks, cbs);
    activeSenderSessions.delete(pin);
  } catch (webrtcErr) {
    console.warn('WebRTC failed, falling back to Supabase chunk relay:', (webrtcErr as Error).message);

    // Re-chunk at Supabase relay size if needed
    if (stored.chunks[0]?.byteLength !== CHUNK_SIZE) {
      stored.chunks = await fileToChunks(session.file, CHUNK_SIZE);
      inMemoryFiles.set(pin, stored);
    }

    try {
      await sendViaSupabaseChunks(pin, session.file, stored.chunks, cbs);
      activeSenderSessions.delete(pin);
    } catch (relayErr) {
      cbs.onError((relayErr as Error).message);
    }
  }
}

// --- Public API: Receiver ---------------------------------------------------

export async function initReceiverEngine(
  pin: string,
  cb?: TransferCallbacks,
): Promise<ReceiverSession> {
  const cbs = cb ?? defaultCallbacks;

  const entry = await resolveTicket(pin);
  if (!entry) {
    throw new Error(
      'No active transfer found for that PIN. Ask the sender to share their 6-digit code, then try again.',
    );
  }

  // Same-device fast path
  const stored = inMemoryFiles.get(pin);
  if (stored) {
    cbs.onStage('Actively Streaming Data');
    let transferred = 0;
    const startTime = Date.now();
    for (const chunk of stored.chunks) {
      await sleep(5);
      transferred += chunk.byteLength;
      const elapsed = (Date.now() - startTime) / 1000;
      cbs.onProgress({
        percent: Math.round((transferred / stored.meta.fileSize) * 100),
        bytesTransferred: transferred,
        totalBytes: stored.meta.fileSize,
        speed: formatSpeed(transferred / Math.max(elapsed, 0.1)),
        eta: calcEta(
          stored.meta.fileSize - transferred,
          transferred / Math.max(elapsed, 0.1),
        ),
      });
    }
    const url = URL.createObjectURL(
      new Blob(stored.chunks, { type: stored.meta.fileType }),
    );
    inMemoryFiles.delete(pin);
    cbs.onStage('Transfer Complete');
    cbs.onComplete(url, entry.fileName, entry.fileSize);
    await deleteTicket(pin);
    return {
      pairingPin: pin,
      fileName: entry.fileName,
      fileSize: entry.fileSize,
      downloadUrl: url,
    };
  }

  if (!supabase) {
    throw new Error('Cannot receive cross-device without Supabase configuration');
  }

  // --- Connection-first handshake ---
  cbs.onStage('Connecting...');

  // Signal to sender that receiver is connected
  await receiverSignalConnected(pin);

  // Wait for sender to ack
  const senderAcked = await waitForSenderAck(pin);
  if (!senderAcked) {
    throw new Error('Sender did not respond within the timeout. Make sure the sender has pressed "Start secure transfer".');
  }

  cbs.onStage('Connected');

  // Try WebRTC first, fall back to Supabase chunk relay
  let downloadUrl: string;
  try {
    downloadUrl = await receiveViaWebRTC(pin, entry.fileSize, entry.fileType, cbs);
  } catch (webrtcErr) {
    console.warn('WebRTC receive failed, falling back to Supabase chunk relay:', (webrtcErr as Error).message);
    downloadUrl = await receiveViaSupabaseChunks(pin, entry.fileSize, entry.fileType, cbs);
  }

  cbs.onStage('Transfer Complete');
  cbs.onComplete(downloadUrl, entry.fileName, entry.fileSize);
  await deleteTicket(pin);

  return {
    pairingPin: pin,
    fileName: entry.fileName,
    fileSize: entry.fileSize,
    downloadUrl,
  };
}

export function isSupabaseConfigured(): boolean {
  return supabase !== null;
}
