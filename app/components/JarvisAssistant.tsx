'use client';

import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { AnimatePresence } from 'framer-motion';
import { SettingsModal, JarvisSettings } from './SettingsModal';
import { FUNCTION_REGISTRY, getFunctionByName } from '../lib/functions';
import { XrayWidget } from './XrayWidget';
import { CameraWidget } from './CameraWidget';
import { ArcReactorVisualizer } from './visualizers/ArcReactorVisualizer';
import { PhotoWidget, PhotoEntry } from './PhotoWidget';
import { sfx } from '../lib/sfx';

const FFT_BARS = 64;

const DEFAULT_SETTINGS: JarvisSettings = {
  apiKey: '',
  xaiApiKey: '',
  voice: 'echo',
  initialPrompt: 'You are Jarvis, a helpful AI assistant. You are always helpful, polite, and concise. Subtle British accent. Robotic. Emotionally controlled. Witty and a little bit poking fun at the user.',
  enabledFunctions: [],
  theme: 'arc-reactor',
  grid: 'off',
  visualizer: 'frequency-ring',
  logo: 'logo',
  position: 'center',
  shellPathOverride: '',
  pythonPathOverride: '',
};

export function JarvisAssistant() {
  const [status, setStatus] = useState<'idle' | 'listening' | 'active' | 'error'>('idle');
  const [audioLevel, setAudioLevel] = useState(0);
  const [fftData, setFftData] = useState<number[]>(new Array(FFT_BARS).fill(0));
  const statusRef = useRef(status);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const [ring1Rotation, setRing1Rotation] = useState(0);
  const [ring2Rotation, setRing2Rotation] = useState(0);
  const rotationFrameRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number>(Date.now());
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);

  // Photo context state
  const [photos, setPhotos] = useState<PhotoEntry[]>([]);
  const photosRef = useRef<PhotoEntry[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);

  // Settings State
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<JarvisSettings>(DEFAULT_SETTINGS);
  const [mounted, setMounted] = useState(false);

  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  // Status-change sound effects
  const prevStatusRef = useRef(status);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = status;
    if (prev === status) return;
    if (status === 'listening') sfx('loading', 0.7);
    if (status === 'error')     sfx('error', 0.8);
    if (status === 'idle' && prev !== 'idle') sfx('app_close', 0.6);
  }, [status]);

  // Keep photosRef in sync so the Realtime API injection always sees the latest list
  useEffect(() => {
    photosRef.current = photos;
    injectPhotosIntoSession(photos);

    // Expose current photo context so local tool handlers can reuse on-screen images.
    (window as Window & {
      __jarvisPhotoContext?: { latestDataUrl?: string; photos: string[] };
    }).__jarvisPhotoContext = {
      latestDataUrl: photos.length > 0 ? photos[photos.length - 1].dataUrl : undefined,
      photos: photos.map((p) => p.dataUrl),
    };
  }, [photos]);

  // Compress a dropped image file to a JPEG data URL (max 1024px)
  function compressImage(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = reject;
      reader.onload = (e) => {
        const img = document.createElement('img');
        img.onerror = reject;
        img.onload = () => {
          const MAX = 1024;
          let w = img.width, h = img.height;
          if (w > MAX || h > MAX) {
            if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
            else       { w = Math.round(w * MAX / h); h = MAX; }
          }
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          const ctx2d = canvas.getContext('2d')!;
          ctx2d.drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', 0.85));
        };
        img.src = e.target?.result as string;
      };
      reader.readAsDataURL(file);
    });
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragOver(false);
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
    files.forEach(async (file) => {
      try {
        const dataUrl = await compressImage(file);
        const entry: PhotoEntry = { id: crypto.randomUUID(), dataUrl, name: file.name };
        setPhotos(prev => [...prev, entry]);
      } catch (err) {
        console.error('Failed to load image', err);
      }
    });
  }

  function dismissPhoto(id: string) {
    setPhotos(prev => prev.filter(p => p.id !== id));
  }

  // Send current photos as a conversation item so Jarvis has them in context.
  // Called whenever the photo list changes (if session is live) and on session open.
  function injectPhotosIntoSession(currentPhotos: PhotoEntry[]) {
    const dc = dataChannelRef.current;
    if (!dc || dc.readyState !== 'open') return;
    if (currentPhotos.length === 0) return;

    const content: unknown[] = [
      {
        type: 'input_text',
        text: `The user currently has ${currentPhotos.length} image${currentPhotos.length > 1 ? 's' : ''} on screen. Reference them if they are relevant to the conversation.`,
      },
      ...currentPhotos.map(p => ({
        type: 'input_image',
        image_url: p.dataUrl,
      })),
    ];

    dc.send(JSON.stringify({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content },
    }));
  }

  /** Append plain text from a HUD paste into the realtime conversation so the model sees it. */
  function injectPastedHudTextIntoSession(rawText: string) {
    const dc = dataChannelRef.current;
    if (!dc || dc.readyState !== 'open') return;
    const trimmed = rawText.trim();
    if (!trimmed) return;

    dc.send(
      JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text:
                'The user pasted the following text onto the HUD (it also appears in a TEXT NOTE widget). Treat it as context for what they want to discuss:\n\n' +
                trimmed,
            },
          ],
        },
      })
    );
  }

  // Paste plain text outside inputs → open a TEXT NOTE and inject into realtime session
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('input, textarea, [contenteditable="true"]')) return;

      const text = e.clipboardData?.getData('text/plain');
      const trimmed = text?.trim();
      if (!trimmed) return;

      e.preventDefault();
      window.dispatchEvent(
        new CustomEvent('jarvis:hud', {
          detail: { command: 'open', widget: 'text', text: trimmed },
        })
      );
      injectPastedHudTextIntoSession(trimmed);
    };

    document.addEventListener('paste', onPaste, true);
    return () => document.removeEventListener('paste', onPaste, true);
  }, []);

  // Apply theme + grid to <html> whenever settings change
  useEffect(() => {
    const html = document.documentElement;
    html.setAttribute('data-theme', settings.theme ?? 'arc-reactor');
    if (settings.grid && settings.grid !== 'off') {
      html.setAttribute('data-grid', settings.grid);
    } else {
      html.removeAttribute('data-grid');
    }
  }, [settings.theme, settings.grid]);

  // Load settings from localStorage
  useEffect(() => {
    const stored = localStorage.getItem('jarvis_settings');
    if (stored) {
      try {
        setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(stored) });
      } catch (e) {
        console.error('Failed to parse settings', e);
      }
    } else {
      // Fallback to env var if available
      const envKey = process.env.NEXT_PUBLIC_OPENAI_API_KEY;
      if (envKey) {
        setSettings(prev => ({ ...prev, apiKey: envKey }));
      }
    }
  }, []);

  // Continuous rotation for rings
  useEffect(() => {
    const rotate = () => {
      const now = Date.now();
      const delta = (now - lastTimeRef.current) / 1000;
      lastTimeRef.current = now;

      setRing1Rotation((prev) => (prev + 40 * delta) % 360);
      setRing2Rotation((prev) => (prev - 20 * delta) % 360);

      rotationFrameRef.current = requestAnimationFrame(rotate);
    };
    rotate();

    return () => {
      if (rotationFrameRef.current) {
        cancelAnimationFrame(rotationFrameRef.current);
      }
    };
  }, []);

  // Audio level monitoring with FFT
  useEffect(() => {
    if (status !== 'active') {
      setAudioLevel(0);
      setFftData(new Array(FFT_BARS).fill(0));
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
      }
      return;
    }

    const checkStream = setInterval(() => {
      if (remoteStreamRef.current && statusRef.current === 'active') {
        clearInterval(checkStream);
        setupAudioAnalyzer();
      }
    }, 100);

    function setupAudioAnalyzer() {
      if (!remoteStreamRef.current) return;

      try {
        const audioContext = new AudioContext();
        audioContextRef.current = audioContext;
        
        const source = audioContext.createMediaStreamSource(remoteStreamRef.current);
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.5;
        
        source.connect(analyser);
        analyserRef.current = analyser;

        const dataArray = new Uint8Array(analyser.frequencyBinCount);

        const updateLevel = () => {
          if (analyserRef.current && statusRef.current === 'active') {
            analyserRef.current.getByteFrequencyData(dataArray);
            
            let sum = 0;
            for (let i = 0; i < dataArray.length; i++) {
              sum += dataArray[i];
            }
            const average = sum / dataArray.length;
            
            let normalizedVolume = Math.min(average / 128, 1);
            normalizedVolume = Math.pow(normalizedVolume, 0.6) * 1.5;
            setAudioLevel(Math.min(normalizedVolume, 1));
            
            const barData: number[] = [];
            const usefulBins = Math.floor(dataArray.length / 2);
            const samplesPerBar = usefulBins / FFT_BARS;
            
            for (let i = 0; i < FFT_BARS; i++) {
              let barSum = 0;
              const startIdx = Math.floor(i * samplesPerBar);
              const endIdx = Math.floor((i + 1) * samplesPerBar);
              
              for (let j = startIdx; j < endIdx; j++) {
                barSum += dataArray[j];
              }
              const normalized = (barSum / (endIdx - startIdx)) / 255;
              const scaled = Math.pow(normalized, 0.5) * 1.8;
              barData.push(Math.min(scaled, 1));
            }
            setFftData(barData);
            
            animationFrameRef.current = requestAnimationFrame(updateLevel);
          }
        };

        updateLevel();
      } catch (error) {
        console.error('Failed to setup audio analyzer:', error);
      }
    }

    return () => {
      clearInterval(checkStream);
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
      }
    };
  }, [status]);

  async function startRealtime(currentSettings = settings) {
    try {
      // Don't start if no API key
      if (!currentSettings.apiKey) {
        console.warn('No API key found, skipping connection');
        return;
      }

      disconnect(); // Ensure clean slate
      setStatus('listening');
      
      // Get microphone access
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false 
        }
      });

      const pc = new RTCPeerConnection();
      peerConnectionRef.current = pc;

      // Add local audio track
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));
      
      // Create data channel for events
      const dc = pc.createDataChannel('oai-events');
      dataChannelRef.current = dc;

      // Handle remote audio
      pc.ontrack = (ev) => {
        const [remoteStream] = ev.streams;
        remoteStreamRef.current = remoteStream;
        const audio = remoteAudioRef.current;
        if (audio) {
          audio.srcObject = remoteStream;
          audio.play().catch(e => console.error("Audio play failed", e));
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const model = 'gpt-realtime-1.5';

      const url = new URL('https://api.openai.com/v1/realtime');
      url.searchParams.set('model', model);
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${currentSettings.apiKey}`,
          'Content-Type': 'application/sdp',
        },
        body: offer.sdp
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Failed to create realtime session: ${text}`);
      }

      const answerSdp = await response.text();
      const answer = { type: 'answer', sdp: answerSdp } as RTCSessionDescriptionInit;
      await pc.setRemoteDescription(answer);

      dc.onopen = () => {
        console.log('WebRTC data channel open');

        const enabledTools = FUNCTION_REGISTRY
          .filter((fn) => currentSettings.enabledFunctions.includes(fn.name))
          .map((fn) => fn.tool);

        const sessionConfig = {
          type: 'session.update',
          session: {
            voice: currentSettings.voice,
            instructions: currentSettings.initialPrompt,
            ...(enabledTools.length > 0 && { tools: enabledTools }),
          },
        };

        dc.send(JSON.stringify(sessionConfig));
        setStatus('active');

        // Inject any photos already on the HUD into the fresh session
        if (photosRef.current.length > 0) {
          injectPhotosIntoSession(photosRef.current);
        }
      };

      // Accumulate streamed function call arguments
      const pendingCalls: Record<string, { name: string; args: string }> = {};

      dc.onmessage = async (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.type === 'error') {
            console.error('OpenAI Error:', data.error);
          }

          // Accumulate argument deltas
          if (data.type === 'response.function_call_arguments.delta') {
            const id = data.call_id as string;
            if (!pendingCalls[id]) {
              pendingCalls[id] = { name: data.name ?? '', args: '' };
            }
            pendingCalls[id].args += data.delta ?? '';
          }

          // Execute when fully received
          if (data.type === 'response.function_call_arguments.done') {
            const id = data.call_id as string;
            const fnName = data.name as string;
            const rawArgs = data.arguments as string;

            const fn = getFunctionByName(fnName);
            if (!fn) return;

            let parsedArgs: Record<string, unknown> = {};
            try { parsedArgs = JSON.parse(rawArgs || '{}'); } catch { /* empty args */ }

            const result = await fn.handler(parsedArgs);

            // Extract imageBase64 if present so it's sent as a vision input, not raw text
            const { imageBase64, ...textResult } = (result as Record<string, unknown> & { imageBase64?: string });

            // Send function result back
            dc.send(JSON.stringify({
              type: 'conversation.item.create',
              item: {
                type: 'function_call_output',
                call_id: id,
                output: JSON.stringify(textResult),
              },
            }));

            // If the function returned an image, inject it as a vision message so the model can see it
            if (imageBase64) {
              dc.send(JSON.stringify({
                type: 'conversation.item.create',
                item: {
                  type: 'message',
                  role: 'user',
                  content: [
                    {
                      type: 'input_image',
                      image_url: `data:image/jpeg;base64,${imageBase64}`,
                    },
                  ],
                },
              }));
            }

            // Ask model to continue responding
            dc.send(JSON.stringify({ type: 'response.create' }));

            if (fnName !== 'control_hud' && fnName !== 'show_hud_text') sfx('notification', 0.6);
            delete pendingCalls[id];
          }
        } catch (error) {
          console.error('Error processing message:', error);
        }
      };

      dc.onerror = () => {
        console.error("Data channel error");
        setStatus('error');
      };

    } catch (error) {
      console.error('Error starting realtime:', error);
      setStatus('error');
    }
  }

  function disconnect() {
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    if (dataChannelRef.current) {
      dataChannelRef.current.close();
      dataChannelRef.current = null;
    }
    if (remoteStreamRef.current) {
      remoteStreamRef.current.getTracks().forEach(t => t.stop());
      remoteStreamRef.current = null;
    }
    setStatus('idle');
  }

  // Auto-start on mount if key exists
  useEffect(() => {
    if (settings.apiKey) {
      startRealtime(settings);
    }
    return () => disconnect();
  }, [settings.apiKey]); // Restart if key changes

  const handleSaveSettings = (newSettings: JarvisSettings) => {
    setSettings(newSettings);
    localStorage.setItem('jarvis_settings', JSON.stringify(newSettings));
    setIsSettingsOpen(false);
    
    // Restart connection with new settings
    disconnect();
    setTimeout(() => startRealtime(newSettings), 500);
  };

  const ring1Scale = 1 + audioLevel * 0.08;
  const ring2Scale = 1 + audioLevel * 0.05;
  const logoScale = 1;
  const glowIntensity = 0;

  const gridSize = ({ small: '20px 20px', medium: '40px 40px', large: '80px 80px', off: undefined } as Record<string, string | undefined>)[settings.grid ?? 'off'];

  const pos = settings.position ?? 'center';
  const isCenter = pos === 'center';

  // Flex alignment classes for each position
  const positionClass: Record<string, string> = {
    'center':       'items-center justify-center',
    'top-left':     'items-start justify-start',
    'top-right':    'items-start justify-end',
    'bottom-left':  'items-end justify-start',
    'bottom-right': 'items-end justify-end',
  };
  // Padding so the widget doesn't hug the absolute edge
  const positionPadding: Record<string, string> = {
    'center':       '',
    'top-left':     'pt-12 pl-12',
    'top-right':    'pt-12 pr-12',
    'bottom-left':  'pb-12 pl-12',
    'bottom-right': 'pb-12 pr-12',
  };

  return (
    <div
      className="contents"
      onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsDragOver(false); }}
      onDrop={handleDrop}
    >
      {/* Drag-over overlay */}
      {isDragOver && (
        <div className="fixed inset-0 z-[200] pointer-events-none flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.55)', border: '2px dashed rgba(34,211,238,0.6)' }}>
          <span className="text-cyan-400 text-2xl font-semibold tracking-widest uppercase select-none">
            Drop image to add to context
          </span>
        </div>
      )}

      {/* Grid overlay */}
      {settings.grid && settings.grid !== 'off' && (
        <div
          className="fixed inset-0 pointer-events-none"
          style={{
            zIndex: 1,
            backgroundImage: `
              linear-gradient(rgba(var(--accent-rgb), 0.06) 1px, transparent 1px),
              linear-gradient(90deg, rgba(var(--accent-rgb), 0.06) 1px, transparent 1px)
            `,
            backgroundSize: gridSize,
          }}
        />
      )}

      <div className={`fixed inset-0 flex overflow-hidden pointer-events-none select-none ${positionClass[pos]} ${positionPadding[pos]}`}>
        {/* Background with slight gradient */}
        <div className="absolute inset-0 bg-gradient-to-b from-black/20 via-transparent to-black/20 pointer-events-none" />

        <div className={`relative flex items-center justify-center aspect-square pointer-events-auto transition-all duration-300 ${isCenter ? 'w-[80vw] max-w-[500px]' : 'w-[50vw] max-w-[340px]'}`}>

          {/* ── Frequency Ring visualizer (default) ── */}
          {settings.visualizer !== 'arc-reactor' && (
            <>
              {/* Ring 2 - Outer */}
              <div
                className="absolute inset-0 flex items-center justify-center pointer-events-none"
                style={{
                  transform: `rotate(${ring2Rotation}deg) scale(${ring2Scale})`,
                  opacity: status === 'active' ? 1 : 0.3,
                  transition: 'opacity 300ms'
                }}
              >
                <Image
                  src="/assets/ring2.png"
                  alt=""
                  width={700}
                  height={700}
                  className="w-full h-full object-contain"
                  style={{ filter: 'drop-shadow(0 0 20px rgba(var(--accent-rgb), 0.6))' }}
                  priority
                  draggable={false}
                />
              </div>

              {/* FFT Bars */}
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <svg className="w-2/3 h-2/3" viewBox="0 0 400 400" style={{ overflow: 'visible' }}>
                  {mounted && fftData.map((value, index) => {
                    const angle = (index / FFT_BARS) * Math.PI * 2;
                    const radius = 180;
                    const centerX = 200;
                    const centerY = 200;
                    const x = centerX + Math.cos(angle) * radius;
                    const y = centerY + Math.sin(angle) * radius;
                    const barWidth = 5;
                    const baseHeight = 6;
                    const barHeight = baseHeight + value * 25;
                    const opacity = status === 'active' ? 0.4 + value * 0.6 : 0.1;
                    const rotation = (angle * 180) / Math.PI + 90;
                    return (
                      <g key={index} transform={`translate(${x}, ${y}) rotate(${rotation})`}>
                        <rect
                          x={-barWidth / 2}
                          y={-barHeight / 2}
                          width={barWidth}
                          height={barHeight}
                          fill="var(--accent-hex)"
                          opacity={opacity}
                          rx={2.5}
                        />
                      </g>
                    );
                  })}
                </svg>
              </div>

              {/* Ring 1 - Middle */}
              <div
                className="absolute inset-0 flex items-center justify-center pointer-events-none"
                style={{
                  transform: `rotate(${ring1Rotation}deg) scale(${ring1Scale})`,
                  opacity: status === 'active' ? 1 : 0.5,
                  transition: 'opacity 200ms'
                }}
              >
                <Image
                  src="/assets/ring1.png"
                  alt=""
                  width={600}
                  height={600}
                  className="w-4/5 h-4/5 object-contain"
                  style={{ filter: 'drop-shadow(0 0 25px rgba(var(--accent-rgb), 0.8))' }}
                  priority
                  draggable={false}
                />
              </div>
            </>
          )}

          {/* ── Arc Reactor visualizer ── */}
          {settings.visualizer === 'arc-reactor' && (
            <div className="absolute inset-0 pointer-events-none">
              <ArcReactorVisualizer
                fftData={fftData}
                status={status}
              />
            </div>
          )}

          {/* Logo - Center (Clickable for Settings) */}
          <div
            className="relative z-10 w-[55%] h-[55%] cursor-pointer group"
            onClick={() => { sfx('sfx_settings_open', 0.7); setIsSettingsOpen(true); }}
            style={{
              transform: `scale(${logoScale})`,
              filter: `drop-shadow(0 0 ${glowIntensity}px rgba(var(--accent-rgb), 0.9))`
            }}
          >
            <Image
              src={`/assets/${settings.logo ?? 'logo'}.png`}
              alt="Jarvis Logo"
              width={300}
              height={300}
              className="w-full h-full object-contain group-hover:drop-shadow-[0_0_15px_rgba(34,211,238,0.6)] transition-all"
              priority
              draggable={false}
            />
          </div>

          {/* Status Info */}
          <div className="absolute bottom-[-100px] left-1/2 -translate-x-1/2 text-center space-y-4 w-full">
            <button 
              onClick={() => {
                sfx('click', 0.6);
                if (status === 'active' || status === 'listening') {
                  disconnect();
                } else {
                  startRealtime();
                }
              }}
              className="flex items-center justify-center gap-3 mx-auto hover:scale-105 transition-transform cursor-pointer group"
            >
              <div
                className={`w-3 h-3 rounded-full transition-all duration-300 ${
                  status === 'idle'
                    ? 'bg-gray-500 group-hover:bg-cyan-400'
                    : status === 'listening'
                    ? 'bg-yellow-400 animate-pulse'
                    : status === 'active'
                    ? 'bg-cyan-400 animate-pulse'
                    : 'bg-red-500'
                }`}
              />
              <span className="text-xl font-semibold text-cyan-400 uppercase tracking-wider group-hover:text-cyan-300 transition-colors">
                {status === 'idle' ? 'OFFLINE' : status}
              </span>
            </button>

            <p className="text-sm text-white/60 max-w-md px-4 mx-auto">
              {status === 'listening' ? (
                'Establishing connection...'
              ) : status === 'active' ? (
                'J.A.R.V.I.S. is online. Click status to disconnect.'
              ) : status === 'error' ? (
                'Connection error. Check Settings.'
              ) : status === 'idle' ? (
                'Click status to activate'
              ) : !settings.apiKey ? (
                'Click logo to configure API Key'
              ) : null}
            </p>
            
            {status === 'error' && (
               <button 
                 onClick={() => startRealtime()}
                 className="px-4 py-2 bg-cyan-900/50 text-cyan-300 rounded hover:bg-cyan-900/80 transition-colors pointer-events-auto"
               >
                 Retry
               </button>
            )}
          </div>
        </div>

        {/* Hidden Audio Element */}
        <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />
      </div>

      {/* X-Ray Widget */}
      <XrayWidget />

      {/* Camera Widget */}
      <CameraWidget />

      {/* Photo Widgets */}
      <AnimatePresence>
        {photos.map((photo, i) => (
          <PhotoWidget
            key={photo.id}
            photo={photo}
            index={i}
            onDismiss={dismissPhoto}
          />
        ))}
      </AnimatePresence>

      {/* Settings Modal */}
      <AnimatePresence>
        {isSettingsOpen && (
          <SettingsModal
            isOpen={isSettingsOpen}
            onClose={() => setIsSettingsOpen(false)}
            onSave={handleSaveSettings}
            initialSettings={settings}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
