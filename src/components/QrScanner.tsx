import { useCallback, useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { Camera, CameraOff, X, ScanLine } from 'lucide-react';

type QrScannerProps = {
  onScan: (code: string) => void;
  onClose: () => void;
};

export default function QrScanner({ onScan, onClose }: QrScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');

  const stopCamera = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, []);

  const scanLoop = useCallback(() => {
    if (!videoRef.current || !canvasRef.current) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;

    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      const width = video.videoWidth;
      const height = video.videoHeight;

      canvas.width = width;
      canvas.height = height;

      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (ctx) {
        ctx.drawImage(video, 0, 0, width, height);
        const imageData = ctx.getImageData(0, 0, width, height);
        const code = jsQR(imageData.data, imageData.width, imageData.height, {
          inversionAttempts: 'dontInvert',
        });

        if (code && code.data) {
          const pinMatch = code.data.match(/(\d{6})/);
          if (pinMatch) {
            setScanned(true);
            stopCamera();
            onScanRef.current(pinMatch[1]);
            return;
          }
        }
      }
    }

    rafRef.current = requestAnimationFrame(scanLoop);
  }, [stopCamera]);

  const startCamera = useCallback(async () => {
    setError('');
    setReady(false);
    stopCamera();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.setAttribute('playsinline', 'true');
        await videoRef.current.play();
        setReady(true);
        scanLoop();
      }
    } catch (err) {
      const msg = (err as Error).message || '';
      if (msg.includes('Permission') || msg.includes('NotAllowed')) {
        setError('Camera access denied. Please allow camera permissions in your browser settings and try again.');
      } else if (msg.includes('NotFound') || msg.includes('DevicesNotFound')) {
        setError('No camera found on this device.');
      } else {
        setError(`Could not start camera: ${msg}`);
      }
    }
  }, [facingMode, stopCamera, scanLoop]);

  const toggleTorch = useCallback(async () => {
    if (!streamRef.current) return;
    const track = streamRef.current.getVideoTracks()[0];
    if (!track) return;

    try {
      const capabilities = track.getCapabilities() as MediaTrackCapabilities & { torch?: boolean };
      if (capabilities.torch) {
        const next = !torchOn;
        await track.applyConstraints({
          advanced: [{ torch: next } as MediaTrackConstraintSet],
        });
        setTorchOn(next);
      }
    } catch {
      /* torch not supported */
    }
  }, [torchOn]);

  const switchCamera = useCallback(() => {
    setFacingMode((prev) => (prev === 'environment' ? 'user' : 'environment'));
  }, []);

  useEffect(() => {
    void startCamera();
    return () => stopCamera();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facingMode]);

  return (
    <div className="qr-scanner-overlay" role="dialog" aria-label="QR code scanner">
      <div className="qr-scanner-modal">
        <div className="qr-scanner-header">
          <h3>Scan QR Code</h3>
          <button className="qr-scanner-close" onClick={() => { stopCamera(); onClose(); }} aria-label="Close scanner">
            <X size={20} />
          </button>
        </div>

        <div className="qr-scanner-viewfinder">
          <video ref={videoRef} className="qr-scanner-video" playsInline muted />
          <canvas ref={canvasRef} className="qr-scanner-canvas" />

          {!ready && !error && (
            <div className="qr-scanner-loading">
              <Camera size={32} />
              <p>Starting camera...</p>
            </div>
          )}

          {error && (
            <div className="qr-scanner-error">
              <CameraOff size={32} />
              <p>{error}</p>
              <button className="qr-scanner-retry" onClick={() => void startCamera()}>Try again</button>
            </div>
          )}

          {ready && !scanned && (
            <>
              <div className="qr-scanner-frame">
                <span className="frame-corner tl" />
                <span className="frame-corner tr" />
                <span className="frame-corner bl" />
                <span className="frame-corner br" />
                <div className="scan-beam" />
              </div>
              <p className="qr-scanner-hint">Point your camera at the QR code</p>
            </>
          )}

          {scanned && (
            <div className="qr-scanner-success">
              <div className="scan-success-icon" />
              <p>Code detected!</p>
            </div>
          )}
        </div>

        <div className="qr-scanner-controls">
          <button className="qr-scanner-control-btn" onClick={switchCamera} aria-label="Switch camera">
            <Camera size={18} />
            <span>Flip camera</span>
          </button>
          <button className="qr-scanner-control-btn" onClick={toggleTorch} aria-label="Toggle flashlight">
            <ScanLine size={18} />
            <span>{torchOn ? 'Flashlight on' : 'Flashlight'}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
