import { ChangeEvent, DragEvent, useEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  ChevronRight,
  Copy,
  File as FileIcon,
  FileArchive,
  FileCode2,
  FileImage,
  FileText,
  Link2,
  LockKeyhole,
  MoreHorizontal,
  Plus,
  Radio,
  ScanLine,
  Send,
  Users,
  X,
  Zap,
  UploadCloud,
} from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import {
  createRoom,
  downloadFile,
  getCurrentMemberId,
  getCurrentDisplayName,
  isSupabaseConfigured,
  joinRoom,
  leaveRoom,
  sendChatMessage,
  shareFile,
  type ChatMessage,
  type FileOffer,
  type RoomMember,
  type RoomCallbacks,
  type TransferProgress,
} from '@/lib/transfer';
import QrScanner from '@/components/QrScanner';

type Screen = 'landing' | 'room';
type HistoryEntry = { name: string; size: string; status: 'Success' | 'Failed'; timestamp: string };

const formatBytes = (bytes: number) => {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

const formatTimestamp = () => {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  return `Today, ${h}:${m}`;
};

const fileIconFor = (type: string) => {
  if (type.includes('image')) return FileImage;
  if (type.includes('zip') || type.includes('compressed') || type.includes('rar') || type.includes('7z')) return FileArchive;
  if (type.includes('text') || type.includes('pdf') || type.includes('document') || type.includes('msword') || type.includes('officedocument')) return FileText;
  if (type.includes('javascript') || type.includes('json') || type.includes('typescript') || type.includes('code')) return FileCode2;
  return FileIcon;
};

function App() {
  const [screen, setScreen] = useState<Screen>('landing');
  const [pin, setPin] = useState('');
  const [copied, setCopied] = useState(false);
  const [pinDigits, setPinDigits] = useState(['', '', '', '', '', '']);
  const [showScanner, setShowScanner] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  // Room state
  const [members, setMembers] = useState<RoomMember[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [fileOffers, setFileOffers] = useState<FileOffer[]>([]);
  const [progress, setProgress] = useState<Record<string, TransferProgress>>({});
  const [chatInput, setChatInput] = useState('');
  const [isHost, setIsHost] = useState(false);
  const [dragging, setDragging] = useState(false);

  const chatScrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const callbacksRef = useRef<RoomCallbacks | null>(null);

  const [history, setHistory] = useState<HistoryEntry[]>(() => {
    const saved = localStorage.getItem('meshdrop-history');
    return saved ? JSON.parse(saved) as HistoryEntry[] : [];
  });

  useEffect(() => {
    localStorage.setItem('meshdrop-history', JSON.stringify(history));
  }, [history]);

  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [messages]);

  const buildCallbacks = (): RoomCallbacks => ({
    onMembersChange: (m) => setMembers(m),
    onChatMessage: (msg) => setMessages((prev) => {
      if (prev.some((p) => p.id === msg.id)) return prev;
      return [...prev, msg];
    }),
    onFileOffer: (offer) => setFileOffers((prev) => {
      if (prev.some((p) => p.file_id === offer.file_id)) return prev;
      return [...prev, offer];
    }),
    onFileOfferUpdate: (offer) => setFileOffers((prev) => prev.map((p) => p.file_id === offer.file_id ? offer : p)),
    onProgress: (fileId, p) => setProgress((prev) => ({ ...prev, [fileId]: p })),
    onError: (message) => setErrorMessage(message),
  });

  callbacksRef.current = buildCallbacks();

  useEffect(() => () => { leaveRoom(); }, []);

  const handleCreateRoom = async () => {
    setErrorMessage('');
    try {
      const roomPin = await createRoom(callbacksRef.current!);
      setPin(roomPin);
      setIsHost(true);
      setScreen('room');
    } catch (error) {
      setErrorMessage((error as Error).message);
    }
  };

  const handleJoinRoom = async (joinPin: string) => {
    setErrorMessage('');
    try {
      await joinRoom(joinPin, callbacksRef.current!);
      setPin(joinPin);
      setIsHost(false);
      setScreen('room');
    } catch (error) {
      setErrorMessage((error as Error).message);
    }
  };

  const handlePinDigit = (value: string, index: number) => {
    const digit = value.replace(/\D/g, '').slice(-1);
    const next = [...pinDigits];
    next[index] = digit;
    setPinDigits(next);
    if (digit && index < 5) document.getElementById(`pin-${index + 1}`)?.focus();
  };

  const handleSendChat = async () => {
    const msg = chatInput.trim();
    if (!msg) return;
    setChatInput('');
    try {
      await sendChatMessage(msg);
    } catch { /* non-fatal */ }
  };

  const handleFileSelect = async (file: File) => {
    try {
      await shareFile(file);
      setHistory((prev) => [
        { name: file.name, size: formatBytes(file.size), status: 'Success', timestamp: formatTimestamp() },
        ...prev,
      ]);
    } catch (error) {
      setErrorMessage((error as Error).message);
      setHistory((prev) => [
        { name: file.name, size: formatBytes(file.size), status: 'Failed', timestamp: formatTimestamp() },
        ...prev,
      ]);
    }
  };

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) void handleFileSelect(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) void handleFileSelect(file);
  };

  const handleDownload = async (offer: FileOffer) => {
    try {
      const url = await downloadFile(offer);
      const a = document.createElement('a');
      a.href = url;
      a.download = offer.file_name;
      a.click();
      URL.revokeObjectURL(url);
      setHistory((prev) => [
        { name: offer.file_name, size: formatBytes(offer.file_size), status: 'Success', timestamp: formatTimestamp() },
        ...prev,
      ]);
    } catch (error) {
      setErrorMessage((error as Error).message);
    }
  };

  const copyLink = async () => {
    await navigator.clipboard?.writeText(`${window.location.origin}/#receive/${pin}`);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  const handleLeaveRoom = () => {
    leaveRoom();
    setScreen('landing');
    setPin('');
    setMembers([]);
    setMessages([]);
    setFileOffers([]);
    setProgress({});
    setPinDigits(['', '', '', '', '', '']);
    setIsHost(false);
  };

  const myId = getCurrentMemberId();
  const myName = getCurrentDisplayName();
  const supabaseReady = isSupabaseConfigured();

  // --- Landing screen ---
  if (screen === 'landing') {
    return (
      <main className="app-shell">
        <header className="topbar">
          <div className="brand-lockup"><div className="brand-mark"><Zap size={17} strokeWidth={2.7} /></div><span>mesh<span>drop</span></span><small>BETA</small></div>
          <div className="topbar-right"><div className="network-pill"><span className="live-dot" /> {supabaseReady ? 'Network online' : 'Local mode'}</div><div className="divider" /><button className="icon-button" aria-label="More options"><MoreHorizontal size={20} /></button><button className="avatar" aria-label="Session">M</button></div>
        </header>

        <section className="hero-row">
          <div>
            <div className="eyebrow"><span className="eyebrow-line" /> SECURE. DIRECT. EPHEMERAL.</div>
            <h1>Connect. Chat.<br /><em>Share anything.</em></h1>
            <p className="hero-copy">Create a room, share the code, and start chatting and transferring files.<br />No accounts. No uploads. No trace.</p>
          </div>
          <div className="hero-status">
            <div className="status-orbit"><div className="orbit-core"><Radio size={20} /></div><span className="orbit-dot dot-a" /><span className="orbit-dot dot-b" /><span className="orbit-dot dot-c" /></div>
            <div><span className="status-label">SESSION STATUS</span><strong>Ephemeral & private</strong><span className="status-sub"><LockKeyhole size={12} /> End-to-end encrypted</span></div>
          </div>
        </section>

        {errorMessage && <div className="error-banner"><X size={15} /> {errorMessage}</div>}

        <section className="landing-actions">
          <button className="landing-card create-card" onClick={handleCreateRoom}>
            <div className="landing-card-icon"><ArrowUpFromLine size={28} /></div>
            <h2>Create a room</h2>
            <p>Generate a code and QR instantly. Share it with anyone you want to connect with.</p>
            <span className="landing-card-cta">Get started <ChevronRight size={16} /></span>
          </button>

          <div className="landing-card join-card">
            <div className="landing-card-icon"><ArrowDownToLine size={28} /></div>
            <h2>Join a room</h2>
            <p>Have a 6-digit code? Enter it below or scan a QR code to connect.</p>
            <div className="pin-inputs">
              {pinDigits.map((digit, index) => (
                <input key={index} id={`pin-${index}`} inputMode="numeric" maxLength={1} value={digit}
                  onChange={(e) => handlePinDigit(e.target.value, index)}
                  aria-label={`Digit ${index + 1}`} />
              ))}
            </div>
            <div className="join-actions">
              <button className="primary-button" onClick={() => handleJoinRoom(pinDigits.join(''))} disabled={pinDigits.join('').length !== 6}>
                Join room <ChevronRight size={16} />
              </button>
              <button className="secondary-button" onClick={() => setShowScanner(true)}>
                <ScanLine size={16} /> Scan QR
              </button>
            </div>
          </div>
        </section>

        {history.length > 0 && (
          <section className="history-section">
            <div className="history-header"><div><span className="section-kicker">RECENT</span><h2>Transfer history</h2></div></div>
            <div className="history-table">
              <div className="history-row history-heading"><span>FILE</span><span>SIZE</span><span>STATUS</span><span>WHEN</span><span /></div>
              {history.map((entry) => (
                <div className="history-row" key={`${entry.name}-${entry.timestamp}`}>
                  <span className="history-file"><span className="history-file-icon"><FileIcon size={15} /></span><strong>{entry.name}</strong></span>
                  <span>{entry.size}</span>
                  <span className={entry.status === 'Success' ? 'success-status' : 'failed-status'}><span /> {entry.status}</span>
                  <span>{entry.timestamp}</span><button aria-label={`Open ${entry.name}`}><ChevronRight size={16} /></button>
                </div>
              ))}
            </div>
          </section>
        )}

        <footer><span><Zap size={13} /> meshdrop</span><span>Built for direct connections <span className="footer-dot">·</span> No accounts required</span></footer>

        {showScanner && <QrScanner onScan={(code) => { setShowScanner(false); void handleJoinRoom(code); }} onClose={() => setShowScanner(false)} />}
      </main>
    );
  }

  // --- Room screen ---
  const onlineMembers = members.filter((m) => m.is_online);
  const sortedOffers = [...fileOffers].sort((a, b) => a.created_at - b.created_at);

  return (
    <main className="app-shell room-shell">
      <header className="topbar">
        <div className="brand-lockup"><div className="brand-mark"><Zap size={17} strokeWidth={2.7} /></div><span>mesh<span>drop</span></span><small>BETA</small></div>
        <div className="topbar-right">
          <div className="room-pin-pill"><span className="live-dot" /> Room {pin.slice(0, 3)}—{pin.slice(3)}</div>
          <div className="divider" />
          <div className="members-pill"><Users size={14} /> {onlineMembers.length}</div>
          <div className="divider" />
          <button className="secondary-button compact" onClick={copyLink}>{copied ? <Check size={14} /> : <Link2 size={14} />} {copied ? 'Copied' : 'Copy link'}</button>
          <div className="divider" />
          <button className="leave-button" onClick={handleLeaveRoom}><X size={16} /> Leave</button>
        </div>
      </header>

      <div className="room-layout">
        {/* Sidebar: room info + members */}
        <aside className="room-sidebar">
          <div className="sidebar-section">
            <span className="section-kicker">ROOM CODE</span>
            <div className="room-qr-wrapper">
              <QRCodeSVG value={`${window.location.origin}/#receive/${pin}`} size={130} bgColor="#f6f8fa" fgColor="#101820" level="M" />
            </div>
            <div className="room-pin-display">{pin.slice(0, 3)} <span>{pin.slice(3)}</span></div>
            <p className="room-hint">Share this code or QR to invite others</p>
          </div>

          <div className="sidebar-section">
            <span className="section-kicker">MEMBERS ({onlineMembers.length})</span>
            <div className="members-list">
              {onlineMembers.map((m) => (
                <div key={m.member_id} className="member-item">
                  <div className="member-avatar">{m.display_name.charAt(0)}</div>
                  <div className="member-info">
                    <strong>{m.display_name}{m.member_id === myId ? ' (You)' : ''}</strong>
                    <span>{m.role === 'host' ? 'Host' : 'Member'}</span>
                  </div>
                  <span className="member-status online" />
                </div>
              ))}
              {onlineMembers.length === 0 && <p className="no-members">Waiting for others to join...</p>}
            </div>
          </div>

          <div className="sidebar-section">
            <span className="section-kicker">SHARED FILES ({sortedOffers.length})</span>
            <div className="sidebar-files">
              {sortedOffers.map((offer) => {
                const FileIconCmp = fileIconFor(offer.file_type);
                return <div key={offer.file_id} className="sidebar-file-item"><FileIconCmp size={15} /><span>{offer.file_name}</span></div>;
              })}
              {sortedOffers.length === 0 && <p className="no-files">No files shared yet</p>}
            </div>
          </div>
        </aside>

        {/* Main: chat + files */}
        <section className="room-main">
          <div className="chat-container">
            <div className="chat-messages" ref={chatScrollRef}>
              {messages.length === 0 && <div className="chat-empty"><Radio size={28} /><p>No messages yet. Say hello to start the conversation.</p></div>}
              {messages.map((msg) => {
                if (msg.sender === 'system') {
                  return <div key={msg.id} className="chat-system"><span>{msg.message}</span></div>;
                }
                const isMine = msg.sender_name === myName;
                return (
                  <div key={msg.id} className={`chat-message ${isMine ? 'mine' : 'theirs'}`}>
                    {!isMine && <span className="chat-sender">{msg.sender_name}</span>}
                    <span className="chat-bubble">{msg.message}</span>
                    <span className="chat-time">{new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                );
              })}
            </div>

            {/* File offers inline */}
            {sortedOffers.length > 0 && (
              <div className="file-offers-strip">
                {sortedOffers.map((offer) => {
                  const FileIconCmp = fileIconFor(offer.file_type);
                  const p = progress[offer.file_id];
                  const isMine = offer.sender_id === myId;
                  return (
                    <div key={offer.file_id} className="file-offer-card">
                      <div className="file-offer-icon"><FileIconCmp size={22} /></div>
                      <div className="file-offer-info">
                        <strong>{offer.file_name}</strong>
                        <span>{formatBytes(offer.file_size)} · {isMine ? 'You' : offer.sender_name}</span>
                        {p && (offer.status === 'uploading' || offer.status === 'downloading') && (
                          <div className="file-offer-progress">
                            <div className="progress-track"><div className="progress-fill" style={{ width: `${p.percent}%` }} /></div>
                            <span>{p.percent}% · {p.speed} MB/s</span>
                          </div>
                        )}
                        {offer.status === 'uploading' && <span className="file-status uploading">Uploading...</span>}
                        {offer.status === 'ready' && !isMine && (
                          <button className="file-download-btn" onClick={() => handleDownload(offer)}>
                            <ArrowDownToLine size={14} /> Download
                          </button>
                        )}
                        {offer.status === 'ready' && isMine && <span className="file-status ready">Ready to download</span>}
                        {offer.status === 'downloading' && <span className="file-status downloading">Downloading...</span>}
                        {offer.status === 'done' && <span className="file-status done"><Check size={12} /> Downloaded</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Drag overlay */}
            {dragging && <div className="drag-overlay"><UploadCloud size={40} /><p>Drop file to share</p></div>}

            {/* Chat input */}
            <div className="chat-input-row"
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
            >
              <input
                type="file"
                ref={fileInputRef}
                onChange={onFileChange}
                style={{ display: 'none' }}
              />
              <button className="chat-attach-btn" onClick={() => fileInputRef.current?.click()} aria-label="Share file">
                <Plus size={20} />
              </button>
              <input
                type="text"
                className="chat-input"
                placeholder="Type a message or drop a file..."
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void handleSendChat(); } }}
                maxLength={1000}
              />
              <button className="chat-send-button" onClick={handleSendChat} disabled={!chatInput.trim()} aria-label="Send">
                <Send size={16} />
              </button>
            </div>
          </div>
        </section>
      </div>

      {errorMessage && <div className="error-toast"><X size={15} /> {errorMessage} <button onClick={() => setErrorMessage('')}><X size={13} /></button></div>}
    </main>
  );
}

export default App;
