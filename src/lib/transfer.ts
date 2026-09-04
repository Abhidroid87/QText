/**
 * Room-based transfer engine for Meshdrop.
 *
 * Flow:
 *   1. User clicks "Send" or "Receive" → a room is created with a 6-digit PIN + QR
 *   2. Others join the room via PIN or QR scan
 *   3. Inside the room: chat + file sharing, all in one unified conversation view
 *   4. Multiple people can join the same room
 *
 * Transport:
 *   - Chat messages: Supabase `transfer_chat` table + Realtime
 *   - File data: Supabase `transfer_chunks` relay (works on any static host)
 *   - Presence: `room_members` table + Realtime
 *   - File metadata: `file_offers` table
 */

import { createClient, type RealtimeChannel } from '@supabase/supabase-js';

// --- Types ------------------------------------------------------------------

export type RoomMember = {
  member_id: string;
  display_name: string;
  role: 'host' | 'member';
  is_online: boolean;
};

export type ChatMessage = {
  id: string;
  sender: 'sender' | 'receiver' | 'system';
  sender_name: string;
  message: string;
  timestamp: number;
};

export type FileOffer = {
  file_id: string;
  file_name: string;
  file_size: number;
  file_type: string;
  sender_id: string;
  sender_name: string;
  status: 'offered' | 'uploading' | 'ready' | 'downloading' | 'done';
  total_chunks: number;
  created_at: number;
};

export type TransferProgress = {
  percent: number;
  bytesTransferred: number;
  totalBytes: number;
  speed: number;
  eta: number;
};

export type RoomCallbacks = {
  onMembersChange: (members: RoomMember[]) => void;
  onChatMessage: (msg: ChatMessage) => void;
  onFileOffer: (offer: FileOffer) => void;
  onFileOfferUpdate: (offer: FileOffer) => void;
  onProgress: (fileId: string, progress: TransferProgress) => void;
  onError: (message: string) => void;
};

// --- Constants --------------------------------------------------------------

const TICKET_TTL_MS = 10 * 60 * 1000;
const STORAGE_PREFIX = 'meshdrop-pin-';
const CHUNK_SIZE = 256 * 1024;
const MAX_MESSAGE_LENGTH = 1000;
const PRESENCE_INTERVAL_MS = 5000;
const PRESENCE_TIMEOUT_MS = 15000;

// --- Supabase client --------------------------------------------------------
//
// The anon key is public-safe — it's designed to be exposed in the browser.
// RLS policies protect the data, not the key. We hardcode fallback values so
// the app works even when .env is missing (e.g. GitHub Pages builds where
// .env is gitignored). Environment variables take priority when available.

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || 'https://vzagkaawgkagkbyllufq.supabase.co';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ6YWdrYWF3Z2thZ2tieWxsdWZxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg0MTc0NjksImV4cCI6MjEwMzk5MzQ2OX0.N1cdhY47TdkZpZ4T86Twl-LRiPQQesmswXFArpF47h8';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  realtime: { params: { eventsPerSecond: 20 } },
});

// --- Utilities --------------------------------------------------------------

function generatePin(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function generateId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function generateName(): string {
  const adjectives = ['Swift', 'Bright', 'Calm', 'Bold', 'Quick', 'Wild', 'Cool', 'Warm'];
  const nouns = ['Falcon', 'River', 'Comet', 'Wolf', 'Star', 'Oak', 'Lynx', 'Drift'];
  return `${adjectives[Math.floor(Math.random() * adjectives.length)]} ${nouns[Math.floor(Math.random() * nouns.length)]}`;
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

async function fileToChunks(file: File): Promise<ArrayBuffer[]> {
  const chunks: ArrayBuffer[] = [];
  for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
    const buf = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
    chunks.push(buf);
  }
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Room state --------------------------------------------------------------

let currentPin: string | null = null;
let currentMemberId: string | null = null;
let currentDisplayName: string | null = null;
let currentRole: 'host' | 'member' = 'member';
let roomChannel: RealtimeChannel | null = null;
let chatChannel: RealtimeChannel | null = null;
let presenceTimer: number | null = null;
let callbacksRef: RoomCallbacks | null = null;

// --- Public API: Room management --------------------------------------------

export function isSupabaseConfigured(): boolean {
  return true;
}

export function getCurrentMemberId(): string | null {
  return currentMemberId;
}

export function getCurrentDisplayName(): string | null {
  return currentDisplayName;
}

export async function createRoom(cb: RoomCallbacks): Promise<string> {
  const pin = generatePin();
  currentPin = pin;
  currentMemberId = generateId();
  currentDisplayName = generateName();
  currentRole = 'host';
  callbacksRef = cb;

  // Store locally for same-device fast path
  try {
    localStorage.setItem(STORAGE_PREFIX + pin, JSON.stringify({ pin, ts: Date.now() }));
  } catch { /* quota */ }

  // Publish ticket in Supabase
  if (supabase) {
    try {
      await supabase.from('transfer_tickets').upsert({
        pin,
        ticket: `room:${pin}`,
        file_name: '',
        file_size: 0,
        file_type: '',
        receiver_status: 'waiting',
        sender_status: 'ready',
      });
    } catch (error) {
      console.warn('Could not publish room to Supabase:', (error as Error).message);
    }
  }

  // Register as room member
  await joinRoomMember(pin, currentMemberId, currentDisplayName, 'host');

  // Start listening
  startRoomListeners(pin, cb);
  startPresence(pin);

  // Auto-cleanup after TTL
  setTimeout(() => {
    if (currentPin === pin) leaveRoom();
  }, TICKET_TTL_MS);

  return pin;
}

export async function joinRoom(pin: string, cb: RoomCallbacks): Promise<void> {
  currentPin = pin;
  currentMemberId = generateId();
  currentDisplayName = generateName();
  currentRole = 'member';
  callbacksRef = cb;

  // Check if room exists
  if (supabase) {
    const { data, error } = await supabase
      .from('transfer_tickets')
      .select('pin')
      .eq('pin', pin)
      .maybeSingle();

    if (error || !data) {
      throw new Error('No active room found for that code. Ask the host to share their 6-digit code, then try again.');
    }
  }

  // Check same-device
  const local = localStorage.getItem(STORAGE_PREFIX + pin);
  if (!local && !supabase) {
    throw new Error('No active room found for that code.');
  }

  await joinRoomMember(pin, currentMemberId, currentDisplayName, 'member');
  startRoomListeners(pin, cb);
  startPresence(pin);

  // Send system message
  await sendSystemMessage(pin, `${currentDisplayName} joined the room`);
}

export async function joinRoomMember(pin: string, memberId: string, name: string, role: 'host' | 'member'): Promise<void> {
  if (!supabase) return;
  try {
    await supabase.from('room_members').upsert({
      pin,
      member_id: memberId,
      display_name: name,
      role,
      last_seen: new Date().toISOString(),
    });
  } catch { /* non-fatal */ }
}

export function leaveRoom(): void {
  if (currentPin && currentMemberId && supabase) {
    void supabase.from('room_members').delete().eq('pin', currentPin).eq('member_id', currentMemberId);
    if (currentDisplayName) {
      void sendSystemMessage(currentPin, `${currentDisplayName} left the room`);
    }
  }
  if (roomChannel && supabase) {
    void supabase.removeChannel(roomChannel);
    roomChannel = null;
  }
  if (chatChannel && supabase) {
    void supabase.removeChannel(chatChannel);
    chatChannel = null;
  }
  if (presenceTimer) {
    window.clearInterval(presenceTimer);
    presenceTimer = null;
  }
  currentPin = null;
  currentMemberId = null;
  currentDisplayName = null;
  callbacksRef = null;
}

// --- Presence ---------------------------------------------------------------

function startPresence(pin: string): void {
  if (presenceTimer) window.clearInterval(presenceTimer);
  presenceTimer = window.setInterval(async () => {
    if (!supabase || !currentMemberId || !currentPin) return;
    try {
      await supabase.from('room_members')
        .update({ last_seen: new Date().toISOString() })
        .eq('pin', currentPin)
        .eq('member_id', currentMemberId);
    } catch { /* non-fatal */ }
    await refreshMembers(currentPin);
  }, PRESENCE_INTERVAL_MS);
  // Initial fetch
  void refreshMembers(pin);
}

async function refreshMembers(pin: string): Promise<void> {
  if (!supabase || !callbacksRef) return;
  try {
    const { data } = await supabase
      .from('room_members')
      .select('member_id, display_name, role, last_seen')
      .eq('pin', pin);
    if (!data) return;

    const now = Date.now();
    const members: RoomMember[] = data.map((row) => ({
      member_id: row.member_id,
      display_name: row.display_name,
      role: row.role as 'host' | 'member',
      is_online: now - new Date(row.last_seen).getTime() < PRESENCE_TIMEOUT_MS,
    }));
    callbacksRef.onMembersChange(members);
  } catch { /* non-fatal */ }
}

// --- Realtime listeners -----------------------------------------------------

function startRoomListeners(pin: string, cb: RoomCallbacks): void {
  if (!supabase) return;

  // Chat channel
  if (chatChannel) void supabase.removeChannel(chatChannel);
  chatChannel = supabase
    .channel(`chat:${pin}`)
    .on('broadcast', { event: 'message' }, (event: { payload: ChatMessage }) => {
      cb.onChatMessage(event.payload);
    })
    .subscribe();

  // File offers + members channel
  if (roomChannel) void supabase.removeChannel(roomChannel);
  roomChannel = supabase
    .channel(`room:${pin}`)
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'file_offers',
      filter: `pin=eq.${pin}`,
    }, (payload) => {
      const row = payload.new as { file_id: string; file_name: string; file_size: number; file_type: string; sender_id: string; sender_name: string; status: string; total_chunks: number; created_at: string };
      cb.onFileOffer({
        file_id: row.file_id,
        file_name: row.file_name,
        file_size: row.file_size,
        file_type: row.file_type,
        sender_id: row.sender_id,
        sender_name: row.sender_name,
        status: row.status as FileOffer['status'],
        total_chunks: row.total_chunks,
        created_at: new Date(row.created_at).getTime(),
      });
    })
    .on('postgres_changes', {
      event: 'UPDATE',
      schema: 'public',
      table: 'file_offers',
      filter: `pin=eq.${pin}`,
    }, (payload) => {
      const row = payload.new as { file_id: string; file_name: string; file_size: number; file_type: string; sender_id: string; sender_name: string; status: string; total_chunks: number; created_at: string };
      cb.onFileOfferUpdate({
        file_id: row.file_id,
        file_name: row.file_name,
        file_size: row.file_size,
        file_type: row.file_type,
        sender_id: row.sender_id,
        sender_name: row.sender_name,
        status: row.status as FileOffer['status'],
        total_chunks: row.total_chunks,
        created_at: new Date(row.created_at).getTime(),
      });
    })
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'room_members',
      filter: `pin=eq.${pin}`,
    }, () => { void refreshMembers(pin); })
    .on('postgres_changes', {
      event: 'DELETE',
      schema: 'public',
      table: 'room_members',
      filter: `pin=eq.${pin}`,
    }, () => { void refreshMembers(pin); })
    .on('postgres_changes', {
      event: 'UPDATE',
      schema: 'public',
      table: 'room_members',
      filter: `pin=eq.${pin}`,
    }, () => { void refreshMembers(pin); })
    .subscribe();

  // Load initial data
  void loadChatHistory(pin).then((msgs) => msgs.forEach((m) => cb.onChatMessage(m)));
  void loadFileOffers(pin).then((offers) => offers.forEach((o) => cb.onFileOffer(o)));
}

// --- Chat -------------------------------------------------------------------

export async function sendChatMessage(message: string): Promise<ChatMessage | null> {
  if (!supabase || !currentPin || !currentMemberId || !currentDisplayName) return null;
  const trimmed = message.trim().slice(0, MAX_MESSAGE_LENGTH);
  if (!trimmed) return null;

  const chatMessage: ChatMessage = {
    id: generateId(),
    sender: currentRole === 'host' ? 'sender' : 'receiver',
    sender_name: currentDisplayName,
    message: trimmed,
    timestamp: Date.now(),
  };

  const { error } = await supabase.from('transfer_chat').insert({
    pin: currentPin,
    sender: chatMessage.sender,
    sender_name: chatMessage.sender_name,
    message: chatMessage.message,
  });
  if (error) throw new Error(`Failed to send message: ${error.message}`);

  if (chatChannel) {
    const result = await chatChannel.send({
      type: 'broadcast',
      event: 'message',
      payload: chatMessage,
    });
    if (result !== 'ok') throw new Error('Message could not reach the room. Check the connection and try again.');
  }

  return chatMessage;
}

async function sendSystemMessage(pin: string, message: string): Promise<void> {
  if (!supabase) return;
  try {
    await supabase.from('transfer_chat').insert({
      pin,
      sender: 'system',
      sender_name: 'System',
      message,
    });
  } catch { /* non-fatal */ }
}

export async function loadChatHistory(pin: string): Promise<ChatMessage[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('transfer_chat')
    .select('id, sender, sender_name, message, created_at')
    .eq('pin', pin)
    .order('created_at')
    .limit(200);
  if (error || !data) return [];
  return data.map((row) => ({
    id: String(row.id),
    sender: row.sender as ChatMessage['sender'],
    sender_name: row.sender_name || 'Anonymous',
    message: row.message,
    timestamp: new Date(row.created_at).getTime(),
  }));
}

// --- File sharing -----------------------------------------------------------

export async function loadFileOffers(pin: string): Promise<FileOffer[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('file_offers')
    .select('file_id, file_name, file_size, file_type, sender_id, sender_name, status, total_chunks, created_at')
    .eq('pin', pin)
    .order('created_at');
  if (error || !data) return [];
  return data.map((row) => ({
    file_id: row.file_id,
    file_name: row.file_name,
    file_size: row.file_size,
    file_type: row.file_type,
    sender_id: row.sender_id,
    sender_name: row.sender_name,
    status: row.status as FileOffer['status'],
    total_chunks: row.total_chunks,
    created_at: new Date(row.created_at).getTime(),
  }));
}

export async function shareFile(file: File): Promise<string> {
  if (!supabase || !currentPin || !currentMemberId || !currentDisplayName) {
    throw new Error('You must be in a room to share a file');
  }

  const fileId = generateId();
  const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));

  // Create file offer
  const { error } = await supabase.from('file_offers').insert({
    pin: currentPin,
    file_id: fileId,
    file_name: file.name,
    file_size: file.size,
    file_type: file.type || 'application/octet-stream',
    sender_id: currentMemberId,
    sender_name: currentDisplayName,
    status: 'uploading',
    total_chunks: totalChunks,
  });
  if (error) throw new Error(`Failed to create file offer: ${error.message}`);

  // Upload chunks in background
  const chunks = await fileToChunks(file);
  void uploadFileChunks(currentPin, fileId, chunks, file.size);

  return fileId;
}

async function uploadFileChunks(pin: string, fileId: string, chunks: ArrayBuffer[], totalSize: number): Promise<void> {
  if (!supabase || !callbacksRef) return;

  let transferred = 0;
  const startTime = Date.now();

  for (let i = 0; i < chunks.length; i++) {
    try {
      const b64 = arrayBufferToBase64(chunks[i]);
      let retries = 0;
      const maxRetries = 5;

      while (retries < maxRetries) {
        const { error } = await supabase.from('transfer_chunks').insert({
          pin,
          chunk_index: i,
          data: b64,
          file_id: fileId,
        });
        if (!error) break;
        retries++;
        if (retries >= maxRetries) throw new Error(`Failed to upload chunk ${i}: ${error.message}`);
        await sleep(1000 * retries);
      }

      transferred += chunks[i].byteLength;
      const elapsed = (Date.now() - startTime) / 1000;
      callbacksRef.onProgress(fileId, {
        percent: Math.round((transferred / totalSize) * 100),
        bytesTransferred: transferred,
        totalBytes: totalSize,
        speed: formatSpeed(transferred / Math.max(elapsed, 0.1)),
        eta: calcEta(totalSize - transferred, transferred / Math.max(elapsed, 0.1)),
      });
    } catch (error) {
      // Mark offer as failed
      await supabase.from('file_offers').update({ status: 'offered' }).eq('file_id', fileId).eq('pin', pin);
      callbacksRef.onError(`Upload failed: ${(error as Error).message}`);
      return;
    }
  }

  // Mark as ready
  await supabase.from('file_offers').update({ status: 'ready' }).eq('file_id', fileId).eq('pin', pin);
}

export async function downloadFile(offer: FileOffer): Promise<string> {
  if (!supabase) throw new Error('Supabase is not configured');

  // Update status
  await supabase.from('file_offers').update({ status: 'downloading' }).eq('file_id', offer.file_id).eq('pin', currentPin!);

  const receivedChunks: ArrayBuffer[] = [];
  let transferred = 0;
  const startTime = Date.now();
  const expectedChunks = offer.total_chunks;

  for (let i = 0; i < expectedChunks; i++) {
    let retries = 0;
    const maxRetries = 60; // Wait up to 30s per chunk

    while (retries < maxRetries) {
      const { data, error } = await supabase
        .from('transfer_chunks')
        .select('data')
        .eq('pin', currentPin!)
        .eq('file_id', offer.file_id)
        .eq('chunk_index', i)
        .maybeSingle();

      if (error) throw error;
      if (data) {
        const buf = base64ToArrayBuffer(data.data as string);
        receivedChunks.push(buf);
        transferred += buf.byteLength;

        if (callbacksRef) {
          const elapsed = (Date.now() - startTime) / 1000;
          callbacksRef.onProgress(offer.file_id, {
            percent: Math.round((transferred / offer.file_size) * 100),
            bytesTransferred: transferred,
            totalBytes: offer.file_size,
            speed: formatSpeed(transferred / Math.max(elapsed, 0.1)),
            eta: calcEta(offer.file_size - transferred, transferred / Math.max(elapsed, 0.1)),
          });
        }
        break;
      }
      retries++;
      await sleep(500);
    }

    if (receivedChunks.length <= i) {
      throw new Error('Download timed out — the file may not be fully uploaded yet.');
    }
  }

  // Mark as done
  await supabase.from('file_offers').update({ status: 'done' }).eq('file_id', offer.file_id).eq('pin', currentPin!);

  return URL.createObjectURL(new Blob(receivedChunks, { type: offer.file_type }));
}
