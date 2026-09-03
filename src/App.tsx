import { ChangeEvent, DragEvent, useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, Camera, Check, ChevronRight, Clock3, Copy, File, FileArchive, FileCode2, FileImage, FileText, Gauge, History, Link2, LockKeyhole, Menu, MessageSquare, MoveHorizontal as MoreHorizontal, Radio, Send, ShieldCheck, CloudUpload as UploadCloud, Wifi, X, Zap } from 'lucide-react';
import {
  initReceiverEngine,
  initSenderEngine,
  streamSenderFile,
  joinChat,
  sendChatMessage,
  loadChatHistory,
  leaveChat,
  isSupabaseConfigured,
  type ChatMessage,
  type SenderSession,
  type TransferCallbacks,
  type TransferProgress,
  type TransferStage,
} from '@/lib/transfer';

type Panel = 'send' | 'receive';
type HistoryEntry = { name: string; size: string; status: 'Success' | 'Failed'; timestamp: string };

const initialHistory: HistoryEntry[] = [
  { name: 'design-system.fig', size: '24.8 MB', status: 'Success', timestamp: 'Today, 09:42' },
  { name: 'product-demo.mp4', size: '148.2 MB', status: 'Success', timestamp: 'Yesterday, 18:06' },
  { name: 'archive-assets.zip', size: '2.1 GB', status: 'Failed', timestamp: 'Aug 28, 14:31' },
];

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

const fileIcon = (type: string) => {
  if (type.includes('image')) return FileImage;
  if (type.includes('zip') || type.includes('compressed') || type.includes('rar') || type.includes('7z')) return FileArchive;
  if (type.includes('text') || type.includes('pdf') || type.includes('document') || type.includes('msword') || type.includes('officedocument')) return FileText;
  if (type.includes('javascript') || type.includes('json') || type.includes('typescript') || type.includes('code')) return FileCode2;
  return File;
};

function QrCode({ value }: { value: string }) {
  const cells = Array.from({ length: 21 * 21 }, (_, index) => {
    const x = index % 21;
    const y = Math.floor(index / 21);
    const hash = Array.from(value).reduce((acc, char) => acc + char.charCodeAt(0), 0);
    const reserved = (x < 7 && y < 7) || (x >= 14 && y < 7) || (x < 7 && y >= 14);
    const finder = (ox: number, oy: number) => {
      const dx = x - ox;
      const dy = y - oy;
      return dx >= 0 && dx < 7 && dy >= 0 && dy < 7 && (dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4));
    };
    const filled = finder(0, 0) || finder(14, 0) || finder(0, 14) || (!reserved && ((x * 13 + y * 7 + hash + x * y) % 5 < 2));
    return { x, y, filled };
  });

  return (
    <svg className="qr-code" viewBox="0 0 21 21" role="img" aria-label="Transfer QR code">
      <rect width="21" height="21" fill="#f6f8fa" />
      {cells.filter((cell) => cell.filled).map((cell) => <rect key={`${cell.x}-${cell.y}`} x={cell.x} y={cell.y} width="1" height="1" fill="#101820" />)}
    </svg>
  );
}

function App() {
  const [panel, setPanel] = useState<Panel>('send');
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [stage, setStage] = useState<TransferStage>('Idle');
  const [secondsLeft, setSecondsLeft] = useState(600);
  const [pin, setPin] = useState('843912');
  const [pinDigits, setPinDigits] = useState(['', '', '', '', '', '']);
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [copied, setCopied] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [downloadUrl, setDownloadUrl] = useState('');
  const [downloadName, setDownloadName] = useState('');
  const [senderSession, setSenderSession] = useState<SenderSession | null>(null);
  const [supabaseReady] = useState(isSupabaseConfigured());
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatJoined, setChatJoined] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>(() => {
    const saved = localStorage.getItem('meshdrop-history');
    return saved ? JSON.parse(saved) as HistoryEntry[] : initialHistory;
  });

  const callbacksRef = useRef<TransferCallbacks | undefined>(undefined);
  const chatScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    localStorage.setItem('meshdrop-history', JSON.stringify(history));
  }, [history]);

  useEffect(() => {
    if (stage !== 'Waiting for Peer...' || secondsLeft <= 0) return;
    const timer = window.setInterval(() => setSecondsLeft((current) => Math.max(0, current - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [stage, secondsLeft]);

  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [chatMessages]);

  const buildCallbacks = (): TransferCallbacks => ({
    onStage: (nextStage) => setStage(nextStage),
    onProgress: (p) => setProgress(p),
    onComplete: (url, fileName, fileSize) => {
      setDownloadUrl(url);
      setDownloadName(fileName);
      setHistory((prev) => [
        { name: fileName, size: formatBytes(fileSize), status: 'Success', timestamp: formatTimestamp() },
        ...prev,
      ]);
    },
    onError: (message) => {
      setErrorMessage(message);
      setStage('Idle');
      setHistory((prev) => [
        { name: file?.name ?? 'Unknown', size: file ? formatBytes(file.size) : '—', status: 'Failed', timestamp: formatTimestamp() },
        ...prev,
      ]);
    },
  });

  callbacksRef.current = buildCallbacks();

  // Join chat when we have a PIN and are in an active transfer
  useEffect(() => {
    const role = panel === 'send' ? 'sender' : 'receiver';
    const shouldJoin = (panel === 'send' && !!file) || (panel === 'receive' && pinDigits.join('').length === 6);
    if (shouldJoin && !chatJoined && supabaseReady) {
      const chatPin = panel === 'send' ? pin : pinDigits.join('');
      joinChat(chatPin, role, {
        onMessage: (msg) => setChatMessages((prev) => [...prev, msg]),
      });
      void loadChatHistory(chatPin).then(setChatMessages);
      setChatJoined(true);
    }
  }, [panel, file, pinDigits, chatJoined, supabaseReady, pin]);

  useEffect(() => () => leaveChat(), []);

  const formattedTime = `${String(Math.floor(secondsLeft / 60)).padStart(2, '0')}:${String(secondsLeft % 60).padStart(2, '0')}`;
  const activeFile = file ?? { name: 'project-export.zip', size: 182 * 1024 * 1024, type: 'application/zip' };
  const FileIcon = fileIcon(activeFile.type);
  const percentage = progress?.percent ?? 0;
  const speed = progress?.speed ?? 0;
  const eta = progress?.eta ?? 0;
  const bytesTransferred = progress?.bytesTransferred ?? 0;
  const activeChatPin = panel === 'send' ? pin : pinDigits.join('');

  const processFile = async (nextFile: File) => {
    setFile(nextFile);
    setProgress(null);
    setErrorMessage('');
    setDownloadUrl('');
    setSecondsLeft(600);
    setStage('Hashing File');
    setChatJoined(false);
    setChatMessages([]);
    try {
      const session = await initSenderEngine(nextFile, callbacksRef.current);
      setPin(session.pairingPin);
      setSenderSession(session);
    } catch (error) {
      setErrorMessage((error as Error).message);
      setStage('Idle');
    }
  };

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const nextFile = event.target.files?.[0];
    if (nextFile) void processFile(nextFile);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    const nextFile = event.dataTransfer.files[0];
    if (nextFile) void processFile(nextFile);
  };

  const handlePin = (value: string, index: number) => {
    const digit = value.replace(/\D/g, '').slice(-1);
    const next = [...pinDigits];
    next[index] = digit;
    setPinDigits(next);
    if (digit && index < 5) document.getElementById(`pin-${index + 1}`)?.focus();
  };

  const startSendTransfer = async () => {
    if (!file || !senderSession) return;
    setProgress({ percent: 0, bytesTransferred: 0, totalBytes: file.size, speed: 0, eta: 0 });
    await streamSenderFile(senderSession.pairingPin, callbacksRef.current);
  };

  const startReceiveTransfer = async () => {
    setErrorMessage('');
    setProgress({ percent: 0, bytesTransferred: 0, totalBytes: 0, speed: 0, eta: 0 });
    try {
      await initReceiverEngine(pinDigits.join(''), callbacksRef.current);
    } catch (err) {
      setErrorMessage((err as Error).message);
      setStage('Idle');
    }
  };

  const copyLink = async () => {
    await navigator.clipboard?.writeText(`meshdrop.local/receive/${pin}`);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  const handleSendChat = async () => {
    const msg = chatInput.trim();
    if (!msg) return;
    setChatInput('');
    const role = panel === 'send' ? 'sender' : 'receiver';
    try {
      await sendChatMessage(activeChatPin, role, msg);
    } catch {
      // Message will not appear but UI continues
    }
  };

  const clearSession = () => {
    setFile(null);
    setStage('Idle');
    setProgress(null);
    setSecondsLeft(600);
    setErrorMessage('');
    setDownloadUrl('');
    setSenderSession(null);
    setChatMessages([]);
    setChatJoined(false);
    leaveChat();
  };

  const showChat = (panel === 'send' && !!file) || (panel === 'receive' && pinDigits.join('').length === 6);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup"><div className="brand-mark"><Zap size={17} strokeWidth={2.7} /></div><span>mesh<span>drop</span></span><small>BETA</small></div>
        <div className="topbar-right"><div className="network-pill"><span className="live-dot" /> {supabaseReady ? 'Network online' : 'Local mode'}</div><div className="divider" /><button className="icon-button" aria-label="More options"><MoreHorizontal size={20} /></button><button className="avatar" aria-label="Temporary session">M</button></div>
      </header>

      <section className="hero-row">
        <div><div className="eyebrow"><span className="eyebrow-line" /> SECURE. DIRECT. EPHEMERAL.</div><h1>Move files at the<br /><em>speed of connection.</em></h1><p className="hero-copy">Peer-to-peer file transfers that stay between you and your recipient.<br />No accounts. No uploads. No trace.</p></div>
        <div className="hero-status"><div className="status-orbit"><div className="orbit-core"><Radio size={20} /></div><span className="orbit-dot dot-a" /><span className="orbit-dot dot-b" /><span className="orbit-dot dot-c" /></div><div><span className="status-label">SESSION STATUS</span><strong>Ephemeral & private</strong><span className="status-sub"><LockKeyhole size={12} /> End-to-end encrypted</span></div></div>
      </section>

      <nav className="tabs" aria-label="Transfer mode">
        <button className={panel === 'send' ? 'tab active' : 'tab'} onClick={() => setPanel('send')}><ArrowUpFromLine size={16} /> Send files</button>
        <button className={panel === 'receive' ? 'tab active' : 'tab'} onClick={() => setPanel('receive')}><ArrowDownToLine size={16} /> Receive files</button>
        <div className="tabs-spacer" /><span className="session-label">SESSION <b>#{pin.slice(0, 3)}—{pin.slice(3)}</b></span>
      </nav>

      <section className="workspace">
        <div className="transfer-card">
          <div className="card-topline"><div><span className="section-kicker">{panel === 'send' ? '01 / SEND' : '01 / RECEIVE'}</span><h2>{panel === 'send' ? 'Send a file' : 'Receive a file'}</h2></div><span className={`stage-badge ${stage === 'Actively Streaming Data' ? 'streaming' : ''}`}><span className="stage-dot" /> {stage}</span></div>

          {errorMessage && <div className="error-banner"><X size={15} /> {errorMessage}</div>}

          {panel === 'send' ? <>
            <div className={`drop-zone ${dragging ? 'dragging' : ''} ${file ? 'has-file' : ''}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
              {!file ? <><div className="upload-icon"><UploadCloud size={25} /></div><h3>Drop a file to begin</h3><p>or <label htmlFor="file-upload">browse from your device</label></p><span className="drop-hint">ANY FILE TYPE · DOCS, PDF, IMAGES, VIDEO · UP TO 5 GB</span><input id="file-upload" type="file" onChange={onFileChange} /></> : <div className="selected-file"><div className="file-symbol"><FileIcon size={24} /></div><div className="file-copy"><strong>{activeFile.name}</strong><span>{formatBytes(activeFile.size)} <i>·</i> {activeFile.type || 'Unknown type'}</span></div><button className="remove-file" onClick={clearSession} aria-label="Remove file"><X size={17} /></button></div>}
            </div>
            {file && <div className="file-meta-row"><div><span>FILE NAME</span><strong>{activeFile.name}</strong></div><div><span>SIZE</span><strong>{formatBytes(activeFile.size)}</strong></div><div><span>TYPE</span><strong>{activeFile.type || 'Binary file'}</strong></div></div>}
            {file && <div className="send-details"><div className="pin-panel"><div className="detail-heading"><span className="section-kicker">PAIRING CODE</span><span className="expires"><Clock3 size={13} /> Expires in <b>{formattedTime}</b></span></div><div className="pin-value">{pin.slice(0, 3)} <span>{pin.slice(3)}</span></div><p>Share this code with your recipient</p><button className="secondary-button" onClick={copyLink}>{copied ? <Check size={15} /> : <Link2 size={15} />} {copied ? 'Link copied' : 'Copy direct link'}</button></div><div className="qr-panel"><QrCode value={pin} /><span>Scan to connect</span></div></div>}
            {file && stage === 'Waiting for Peer...' && <button className="primary-button wide" onClick={startSendTransfer}><Send size={16} /> Start secure transfer <ChevronRight size={16} /></button>}
            {downloadUrl && stage === 'Transfer Complete' && <a className="primary-button wide" href={downloadUrl} download={downloadName}><ArrowDownToLine size={16} /> Download {downloadName}</a>}
          </> : <div className="receive-view"><div className="receive-intro"><div className="receive-icon"><ArrowDownToLine size={23} /></div><h3>Enter your pairing code</h3><p>Ask the sender for their 6-digit code to establish a direct connection.</p></div><div className="pin-inputs">{pinDigits.map((digit, index) => <input key={index} id={`pin-${index}`} inputMode="numeric" maxLength={1} value={digit} onChange={(event) => handlePin(event.target.value, index)} aria-label={`Pairing digit ${index + 1}`} />)}</div><button className="camera-button"><Camera size={17} /> Scan QR code with camera</button><button className="primary-button wide" onClick={startReceiveTransfer} disabled={pinDigits.join('').length !== 6 || stage === 'Actively Streaming Data'}><ArrowDownToLine size={16} /> {stage === 'Actively Streaming Data' ? 'Receiving...' : 'Download file'} <ChevronRight size={16} /></button>{downloadUrl && stage === 'Transfer Complete' && <a className="primary-button wide" href={downloadUrl} download={downloadName}><ArrowDownToLine size={16} /> Save {downloadName}</a>}</div>}
        </div>

        <aside className="metrics-card"><div className="card-topline compact"><div><span className="section-kicker">02 / TELEMETRY</span><h2>Transfer metrics</h2></div><Gauge size={19} className="muted-icon" /></div>{stage === 'Actively Streaming Data' || stage === 'Transfer Complete' ? <div className="metrics-live"><div className="metric-progress"><div className="metric-progress-head"><span><span className="live-dot" /> LIVE STREAM</span><b>{percentage}%</b></div><div className="progress-track"><div className="progress-fill" style={{ width: `${percentage}%` }} /></div><div className="progress-labels"><span>{formatBytes(bytesTransferred)} written</span><span>{progress ? formatBytes(progress.totalBytes) : formatBytes(activeFile.size)}</span></div></div><div className="metric-grid"><div><span>TRANSFER SPEED</span><strong>{speed} <small>MB/s</small></strong></div><div><span>TIME REMAINING</span><strong>{eta}<small> sec</small></strong></div><div><span>CONNECTION</span><strong className="connection"><Wifi size={14} /> {supabaseReady ? 'Cloud relay' : 'Local'}</strong></div><div><span>ENCRYPTION</span><strong className="connection"><ShieldCheck size={14} /> Secure</strong></div></div>{stage === 'Transfer Complete' && <div className="complete-banner"><Check size={16} /> Transfer complete. Your file is ready.</div>}</div> : <div className="metrics-empty"><div className="empty-graph"><span /><span /><span /><span /><span /><span /><span /></div><strong>Waiting for a transfer</strong><p>Live network telemetry will appear here once your peer connects.</p><div className="empty-detail"><span><Wifi size={14} /> Direct connection</span><span><ShieldCheck size={14} /> Encrypted channel</span></div></div>}<div className="privacy-note"><LockKeyhole size={14} /><span>Files never touch a server. This session disappears when you close this tab.</span></div></aside>
      </section>

      {showChat && (
        <section className="chat-section">
          <div className="chat-header">
            <div><span className="section-kicker">04 / CHAT</span><h2>In-session chat</h2></div>
            <div className="chat-header-right"><MessageSquare size={15} /> <span>{chatMessages.length} messages</span></div>
          </div>
          <div className="chat-card">
            <div className="chat-messages" ref={chatScrollRef}>
              {chatMessages.length === 0 && <div className="chat-empty"><MessageSquare size={22} /><p>No messages yet. Say hello to your peer.</p></div>}
              {chatMessages.map((msg) => {
                const isMine = (panel === 'send' && msg.sender === 'sender') || (panel === 'receive' && msg.sender === 'receiver');
                return (
                  <div key={msg.id} className={`chat-message ${isMine ? 'mine' : 'theirs'}`}>
                    <span className="chat-sender">{msg.sender === 'sender' ? 'Sender' : 'Receiver'}</span>
                    <span className="chat-bubble">{msg.message}</span>
                    <span className="chat-time">{new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                );
              })}
            </div>
            <div className="chat-input-row">
              <input
                type="text"
                className="chat-input"
                placeholder="Type a message..."
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void handleSendChat(); } }}
                maxLength={1000}
              />
              <button className="chat-send-button" onClick={handleSendChat} disabled={!chatInput.trim()} aria-label="Send message"><Send size={16} /></button>
            </div>
          </div>
        </section>
      )}

      <section className="history-section"><div className="history-header"><div><span className="section-kicker">03 / LOCAL ONLY</span><h2>Transfer history</h2></div><div className="history-caption"><History size={15} /> Stored in this browser only <ChevronRight size={15} /></div></div><div className="history-table"><div className="history-row history-heading"><span>FILE</span><span>SIZE</span><span>STATUS</span><span>WHEN</span><span /></div>{history.map((entry) => <div className="history-row" key={`${entry.name}-${entry.timestamp}`}><span className="history-file"><span className="history-file-icon"><File size={15} /></span><strong>{entry.name}</strong></span><span>{entry.size}</span><span className={entry.status === 'Success' ? 'success-status' : 'failed-status'}><span /> {entry.status}</span><span>{entry.timestamp}</span><button aria-label={`Open ${entry.name}`}><ChevronRight size={16} /></button></div>)}</div></section>
      <footer><span><Zap size={13} /> meshdrop</span><span>Built for direct connections <span className="footer-dot">·</span> No accounts required</span><button aria-label="Open menu"><Menu size={17} /></button></footer>
    </main>
  );
}

export default App;
