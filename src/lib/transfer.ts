/**
 * Serverless transfer engine for Meshdrop.
 *
 * Uses Supabase as the transport layer for cross-device file transfers:
 *   - `transfer_tickets` stores PIN → file metadata
 *   - `transfer_chunks` stores file data in 256KB chunks
 *   - `transfer_chat` stores ephemeral text messages
 *
 * For same-device transfers (sender and receiver in the same browser),
 * an in-memory fast path is used — no network round-trips needed.
 *
 * Real-time chat uses Supabase Realtime broadcast on the `transfer_chat`
 * channel so messages appear instantly on both sides.
 */

import { createClient, type RealtimeChannel } from '@supabase/supabase-js';

// --- Types ------------------------------------------------------------------

export type TransferStage =
  | 'Idle'
  | 'Hashing File'
  | 'Waiting for Peer...'
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
const CHUNK_SIZE = 256 * 1024; // 256KB per chunk
const RESOLVE_TIMEOUT_MS = 30000;
const RESOLVE_POLL_MS = 1000;
const POLL_CHUNK_INTERVAL_MS = 500;
const MAX_MESSAGE_LENGTH = 1000;

// --- Supabase client --------------------------------------------------------

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

const supabase = supabaseUrl && supabaseAnonKey && /^https?:\/\//i.test(supabaseUrl)
  ? createClient(supabaseUrl, supabaseAnonKey, {
      realtime: { params: { eventsPerSecond: 10 } },
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

async function fileToChunks(file: File): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
    const buf = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
    chunks.push(new Uint8Array(buf));
  }
  return chunks;
}

function bytesToBlobUrl(chunks: Uint8Array[], type: string): string {
  return URL.createObjectURL(new Blob(chunks, { type: type || 'application/octet-stream' }));
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const defaultCallbacks: TransferCallbacks = {
  onStage: () => {},
  onProgress: () => {},
  onComplete: () => {},
  onError: () => {},
};

// --- In-memory store (same-device fast path) --------------------------------

const inMemoryFiles = new Map<string, { chunks: Uint8Array[]; meta: TransferMeta }>();
const activeSenderSessions = new Map<string, SenderSession>();

// --- PIN → Ticket store (Supabase + localStorage) ---------------------------

async function publishTicket(pin: string, meta: TransferMeta): Promise<void> {
  const entry = { ticket: `mem:${pin}`, fileName: meta.fileName, fileSize: String(meta.fileSize), fileType: meta.fileType, ts: String(Date.now()) };
  const key = STORAGE_PREFIX + pin;
  try { localStorage.setItem(key, JSON.stringify(entry)); } catch { /* quota */ }

  try {
    if (!supabase) return; // localStorage is enough for same-device
    const { error } = await supabase.from('transfer_tickets').upsert({
      pin,
      ticket: `supa:${pin}`,
      file_name: meta.fileName,
      file_size: meta.fileSize,
      file_type: meta.fileType,
    });
    if (error) throw error;
  } catch (error) {
    // Don't throw — same-device transfer can still work via localStorage
    console.warn('Could not publish to Supabase (cross-device may fail):', (error as Error).message);
  }

  setTimeout(() => {
    try { localStorage.removeItem(key); } catch { /* gone */ }
    if (supabase) {
      void supabase.from('transfer_tickets').delete().eq('pin', pin);
      void supabase.from('transfer_chunks').delete().eq('pin', pin);
      void supabase.from('transfer_chat').delete().eq('pin', pin);
    }
  }, TICKET_TTL_MS);
}

async function resolveTicket(pin: string): Promise<TicketEntry | null> {
  const key = STORAGE_PREFIX + pin;

  // Layer 1: localStorage (same device)
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const data = JSON.parse(raw) as { ticket: string; fileName: string; fileSize: string; fileType?: string };
      if (data.ticket) {
        return { ticket: data.ticket, fileName: data.fileName, fileSize: parseInt(data.fileSize || '0', 10), fileType: data.fileType || 'application/octet-stream' };
      }
    }
  } catch { /* parse error */ }

  // Layer 2: Supabase (cross-device) — poll until row appears or timeout
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
    } catch { /* network blip — keep polling */ }
    await new Promise((r) => setTimeout(r, RESOLVE_POLL_MS));
  }

  return null;
}

async function deleteTicket(pin: string): Promise<void> {
  try { localStorage.removeItem(STORAGE_PREFIX + pin); } catch { /* gone */ }
  try {
    if (supabase) {
      await Promise.all([
        supabase.from('transfer_tickets').delete().eq('pin', pin),
        supabase.from('transfer_chunks').delete().eq('pin', pin),
        supabase.from('transfer_chat').delete().eq('pin', pin),
      ]);
    }
  } catch { /* gone */ }
}

// --- Chunk upload/download --------------------------------------------------

async function uploadChunks(pin: string, chunks: Uint8Array[], cb: TransferCallbacks, totalSize: number): Promise<void> {
  if (!supabase) throw new Error('Supabase is not configured for cross-device transfers.');

  let transferred = 0;
  const startTime = Date.now();

  for (let i = 0; i < chunks.length; i++) {
    const b64 = uint8ArrayToBase64(chunks[i]);
    const { error } = await supabase.from('transfer_chunks').insert({
      pin,
      chunk_index: i,
      data: b64,
    });
    if (error) throw new Error(`Failed to upload chunk ${i}: ${error.message}`);

    transferred += chunks[i].byteLength;
    const elapsed = (Date.now() - startTime) / 1000;
    cb.onProgress({
      percent: Math.round((transferred / totalSize) * 100),
      bytesTransferred: transferred,
      totalBytes: totalSize,
      speed: formatSpeed(transferred / Math.max(elapsed, 0.1)),
      eta: calcEta(totalSize - transferred, transferred / Math.max(elapsed, 0.1)),
    });
  }
}

async function downloadChunks(pin: string, totalSize: number, fileType: string, cb: TransferCallbacks): Promise<string> {
  // Try in-memory first (same device)
  const stored = inMemoryFiles.get(pin);
  if (stored) {
    let transferred = 0;
    const startTime = Date.now();
    for (const chunk of stored.chunks) {
      await new Promise((r) => setTimeout(r, 10));
      transferred += chunk.byteLength;
      const elapsed = (Date.now() - startTime) / 1000;
      cb.onProgress({
        percent: Math.round((transferred / totalSize) * 100),
        bytesTransferred: transferred,
        totalBytes: totalSize,
        speed: formatSpeed(transferred / Math.max(elapsed, 0.1)),
        eta: calcEta(totalSize - transferred, transferred / Math.max(elapsed, 0.1)),
      });
    }
    const url = URL.createObjectURL(new Blob(stored.chunks, { type: fileType }));
    inMemoryFiles.delete(pin);
    return url;
  }

  if (!supabase) throw new Error('Supabase is not configured for cross-device transfers.');

  // Poll for chunks from Supabase
  const receivedChunks: Uint8Array[] = [];
  let transferred = 0;
  const startTime = Date.now();
  let nextIndex = 0;
  const totalChunks = Math.max(1, Math.ceil(totalSize / CHUNK_SIZE));

  while (nextIndex < totalChunks) {
    const { data, error } = await supabase
      .from('transfer_chunks')
      .select('chunk_index, data')
      .eq('pin', pin)
      .gte('chunk_index', nextIndex)
      .order('chunk_index')
      .limit(50);

    if (error) throw new Error(`Failed to download chunks: ${error.message}`);
    if (!data || data.length === 0) {
      await new Promise((r) => setTimeout(r, POLL_CHUNK_INTERVAL_MS));
      continue;
    }

    for (const row of data) {
      if (row.chunk_index === nextIndex) {
        const bytes = base64ToUint8Array(row.data);
        receivedChunks.push(bytes);
        transferred += bytes.byteLength;
        nextIndex++;

        const elapsed = (Date.now() - startTime) / 1000;
        cb.onProgress({
          percent: Math.round((transferred / totalSize) * 100),
          bytesTransferred: transferred,
          totalBytes: totalSize,
          speed: formatSpeed(transferred / Math.max(elapsed, 0.1)),
          eta: calcEta(totalSize - transferred, transferred / Math.max(elapsed, 0.1)),
        });
      }
    }
  }

  return URL.createObjectURL(new Blob(receivedChunks, { type: fileType }));
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

  // In-memory fast path for same-device
  const stored = inMemoryFiles.has(pin) || localStorage.getItem(STORAGE_PREFIX + pin);
  if (stored && !supabase) return;

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
}

// --- Public API: Sender ------------------------------------------------------

export async function initSenderEngine(file: File, cb?: TransferCallbacks): Promise<SenderSession> {
  const cbs = cb ?? defaultCallbacks;
  const pin = generatePin();
  cbs.onStage('Hashing File');

  const meta: TransferMeta = { fileName: file.name, fileSize: file.size, fileType: file.type || 'application/octet-stream' };
  const chunks = await fileToChunks(file);

  // Store in memory for same-device fast path
  inMemoryFiles.set(pin, { chunks, meta });

  // Publish ticket (Supabase + localStorage)
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

  cbs.onStage('Actively Streaming Data');

  // If Supabase is available, upload chunks for cross-device transfer
  if (supabase) {
    try {
      await uploadChunks(pin, stored.chunks, cbs, stored.meta.fileSize);
    } catch (error) {
      cbs.onError((error as Error).message);
      return;
    }
  } else {
    // Same-device only: simulate progress
    let transferred = 0;
    const startTime = Date.now();
    for (const chunk of stored.chunks) {
      await new Promise((r) => setTimeout(r, 20));
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
  }

  cbs.onStage('Transfer Complete');
  activeSenderSessions.delete(pin);
}

// --- Public API: Receiver ---------------------------------------------------

export async function initReceiverEngine(pin: string, cb?: TransferCallbacks): Promise<ReceiverSession> {
  const cbs = cb ?? defaultCallbacks;

  const entry = await resolveTicket(pin);
  if (!entry) throw new Error('No active transfer found for that PIN. Ask the sender to share their 6-digit code, then try again.');

  cbs.onStage('Actively Streaming Data');

  const downloadUrl = await downloadChunks(pin, entry.fileSize, entry.fileType, cbs);

  cbs.onStage('Transfer Complete');
  cbs.onComplete(downloadUrl, entry.fileName, entry.fileSize);
  await deleteTicket(pin);

  return { pairingPin: pin, fileName: entry.fileName, fileSize: entry.fileSize, downloadUrl };
}

export function isSupabaseConfigured(): boolean {
  return supabase !== null;
}
