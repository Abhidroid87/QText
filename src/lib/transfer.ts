/**
 * Peer-to-peer transfer engine for Meshdrop.
 *
 * Uses WebRTC data channels for direct device-to-device file transfer.
 * Supabase is used only for:
 *   - `transfer_tickets`: PIN → file metadata (signaling)
 *   - `transfer_chat`: ephemeral text messages
 *   - Supabase Realtime: SDP/ICE exchange for WebRTC handshake
 *
 * File data flows directly between browsers — never stored on any server.
 * For same-device transfers (sender and receiver in the same browser),
 * an in-memory fast path is used.
 */

import { createClient, type RealtimeChannel } from '@supabase/supabase-js';

// --- Types ------------------------------------------------------------------

export type TransferStage =
  | 'Idle'
  | 'Hashing File'
  | 'Waiting for Peer...'
  | 'Connecting...'
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
const CHUNK_SIZE = 16 * 1024; // 16KB per WebRTC message (reliable size for data channels)
const RESOLVE_TIMEOUT_MS = 30000;
const RESOLVE_POLL_MS = 1000;
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

async function fileToChunks(file: File): Promise<ArrayBuffer[]> {
  const chunks: ArrayBuffer[] = [];
  for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
    const buf = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
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

// --- In-memory store (same-device fast path) --------------------------------

const inMemoryFiles = new Map<string, { chunks: ArrayBuffer[]; meta: TransferMeta }>();
const activeSenderSessions = new Map<string, SenderSession>();

// --- PIN → Ticket store (Supabase + localStorage) ---------------------------

async function publishTicket(pin: string, meta: TransferMeta): Promise<void> {
  const entry = { ticket: `mem:${pin}`, fileName: meta.fileName, fileSize: String(meta.fileSize), fileType: meta.fileType, ts: String(Date.now()) };
  const key = STORAGE_PREFIX + pin;
  try { localStorage.setItem(key, JSON.stringify(entry)); } catch { /* quota */ }

  try {
    if (!supabase) return;
    const { error } = await supabase.from('transfer_tickets').upsert({
      pin,
      ticket: `supa:${pin}`,
      file_name: meta.fileName,
      file_size: meta.fileSize,
      file_type: meta.fileType,
    });
    if (error) throw error;
  } catch (error) {
    console.warn('Could not publish to Supabase (cross-device may fail):', (error as Error).message);
  }

  setTimeout(() => {
    try { localStorage.removeItem(key); } catch { /* gone */ }
    if (supabase) {
      void supabase.from('transfer_tickets').delete().eq('pin', pin);
      void supabase.from('transfer_chat').delete().eq('pin', pin);
    }
  }, TICKET_TTL_MS);
}

async function resolveTicket(pin: string): Promise<TicketEntry | null> {
  const key = STORAGE_PREFIX + pin;

  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const data = JSON.parse(raw) as { ticket: string; fileName: string; fileSize: string; fileType?: string };
      if (data.ticket) {
        return { ticket: data.ticket, fileName: data.fileName, fileSize: parseInt(data.fileSize || '0', 10), fileType: data.fileType || 'application/octet-stream' };
      }
    }
  } catch { /* parse error */ }

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
        return { ticket: data.ticket, fileName: data.file_name, fileSize: data.file_size, fileType: data.file_type || 'application/octet-stream' };
      }
    } catch { /* network blip */ }
    await new Promise((r) => setTimeout(r, RESOLVE_POLL_MS));
  }

  return null;
}

async function deleteTicket(pin: string): Promise<void> {
  try { localStorage.removeItem(STORAGE_PREFIX + pin); } catch { /* gone */ }
  try {
    if (supabase) {
      await supabase.from('transfer_tickets').delete().eq('pin', pin);
      await supabase.from('transfer_chat').delete().eq('pin', pin);
    }
  } catch { /* gone */ }
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

    // Receive ICE candidates from receiver
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

    // Send our ICE candidates to receiver
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
        // Send a done marker
        dc.send(JSON.stringify({ done: true }));
        // Wait for receiver to close, then resolve
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

    // Create offer and send to receiver
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .then(() => {
        sendSignal(pin, { type: 'offer', sdp: pc.localDescription!.sdp ?? '' });
      })
      .catch((err) => fail(`Failed to create offer: ${(err as Error).message}`));

    // Safety timeout
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

    // Receive offer and ICE from sender
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
        // Check for done marker
        if (typeof event.data === 'string') {
          try {
            const msg = JSON.parse(event.data);
            if (msg.done) {
              resolved = true;
              cb.onStage('Transfer Complete');
              const url = URL.createObjectURL(new Blob(receivedChunks, { type: fileType }));
              cleanup();
              resolve(url);
              return;
            }
          } catch { /* not JSON, treat as binary */ }
        }

        // Binary chunk
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
            const url = URL.createObjectURL(new Blob(receivedChunks, { type: fileType }));
            cleanup();
            resolve(url);
          } else {
            fail('Connection closed before transfer completed');
          }
        }
      };

      dc.onerror = () => fail('Data channel error');
    };

    // Safety timeout
    setTimeout(() => {
      if (!resolved && (!dc || dc.readyState !== 'open')) {
        fail('Connection timed out — the sender may not be online');
      }
    }, 30000);
  });
}

// --- Chat -------------------------------------------------------------------

let chatChannel: RealtimeChannel | null = null;

export function joinChat(pin: string, role: 'sender' | 'receiver', callbacks: ChatCallbacks): void {
  if (!supabase) return;

  if (chatChannel) {
    void supabase.removeChannel(chatChannel);
    chatChannel = null;
  }

  chatChannel = supabase
    .channel(`chat:${pin}`)
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'transfer_chat',
      filter: `pin=eq.${pin}`,
    }, (payload) => {
      const row = payload.new as { id: string; pin: string; sender: string; message: string; created_at: string };
      callbacks.onMessage({
        id: String(row.id),
        sender: row.sender as 'sender' | 'receiver',
        message: row.message,
        timestamp: new Date(row.created_at).getTime(),
      });
    })
    .subscribe();
}

export async function sendChatMessage(pin: string, sender: 'sender' | 'receiver', message: string): Promise<void> {
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

export async function initSenderEngine(file: File, cb?: TransferCallbacks): Promise<SenderSession> {
  const cbs = cb ?? defaultCallbacks;
  const pin = generatePin();
  cbs.onStage('Hashing File');

  const meta: TransferMeta = { fileName: file.name, fileSize: file.size, fileType: file.type || 'application/octet-stream' };
  const chunks = await fileToChunks(file);

  inMemoryFiles.set(pin, { chunks, meta });
  await publishTicket(pin, meta);
  cbs.onStage('Waiting for Peer...');

  const session = { pairingPin: pin, file };
  activeSenderSessions.set(pin, session);
  return session;
}

export async function streamSenderFile(pin: string, cb?: TransferCallbacks): Promise<void> {
  const cbs = cb ?? defaultCallbacks;
  const session = activeSenderSessions.get(pin);
  if (!session) return;

  const stored = inMemoryFiles.get(pin);
  if (!stored) return;

  // Same-device fast path: in-memory, no WebRTC needed
  const isSameDevice = localStorage.getItem(STORAGE_PREFIX + pin) !== null && !supabase;
  if (isSameDevice) {
    cbs.onStage('Actively Streaming Data');
    let transferred = 0;
    const startTime = Date.now();
    for (const chunk of stored.chunks) {
      await new Promise((r) => setTimeout(r, 5));
      transferred += chunk.byteLength;
      const elapsed = (Date.now() - startTime) / 1000;
      cbs.onProgress({
        percent: Math.round((transferred / stored.meta.fileSize) * 100),
        bytesTransferred: transferred,
        totalBytes: stored.meta.fileSize,
        speed: formatSpeed(transferred / Math.max(elapsed, 0.1)),
        eta: calcEta(stored.meta.fileSize - transferred, transferred / Math.max(elapsed, 0.1)),
      });
    }
    cbs.onStage('Transfer Complete');
    activeSenderSessions.delete(pin);
    return;
  }

  // Cross-device: WebRTC P2P
  try {
    await sendViaWebRTC(pin, session.file, stored.chunks, cbs);
    activeSenderSessions.delete(pin);
  } catch (error) {
    cbs.onError((error as Error).message);
  }
}

// --- Public API: Receiver ---------------------------------------------------

export async function initReceiverEngine(pin: string, cb?: TransferCallbacks): Promise<ReceiverSession> {
  const cbs = cb ?? defaultCallbacks;

  const entry = await resolveTicket(pin);
  if (!entry) throw new Error('No active transfer found for that PIN. Ask the sender to share their 6-digit code, then try again.');

  // Same-device fast path
  const stored = inMemoryFiles.get(pin);
  if (stored) {
    cbs.onStage('Actively Streaming Data');
    let transferred = 0;
    const startTime = Date.now();
    for (const chunk of stored.chunks) {
      await new Promise((r) => setTimeout(r, 5));
      transferred += chunk.byteLength;
      const elapsed = (Date.now() - startTime) / 1000;
      cbs.onProgress({
        percent: Math.round((transferred / stored.meta.fileSize) * 100),
        bytesTransferred: transferred,
        totalBytes: stored.meta.fileSize,
        speed: formatSpeed(transferred / Math.max(elapsed, 0.1)),
        eta: calcEta(stored.meta.fileSize - transferred, transferred / Math.max(elapsed, 0.1)),
      });
    }
    const url = URL.createObjectURL(new Blob(stored.chunks, { type: stored.meta.fileType }));
    inMemoryFiles.delete(pin);
    cbs.onStage('Transfer Complete');
    cbs.onComplete(url, entry.fileName, entry.fileSize);
    await deleteTicket(pin);
    return { pairingPin: pin, fileName: entry.fileName, fileSize: entry.fileSize, downloadUrl: url };
  }

  // Cross-device: WebRTC P2P
  const downloadUrl = await receiveViaWebRTC(pin, entry.fileSize, entry.fileType, cbs);
  cbs.onStage('Transfer Complete');
  cbs.onComplete(downloadUrl, entry.fileName, entry.fileSize);
  await deleteTicket(pin);

  return { pairingPin: pin, fileName: entry.fileName, fileSize: entry.fileSize, downloadUrl };
}

export function isSupabaseConfigured(): boolean {
  return supabase !== null;
}
