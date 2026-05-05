'use client';

import { useEffect, useRef, useState, useCallback } from 'react';

interface TrackInfo {
  app: string;
  title: string;
  artist: string;
  album: string;
  artworkUrl: string;
  position: number;
  duration: number;
  isPlaying: boolean;
}

const POLL_INTERVAL = 8000;

async function fetchNowPlaying(): Promise<TrackInfo | null> {
  try {
    const res = await fetch('/api/music');
    const data = await res.json();
    if (data.error) return null;
    return data as TrackInfo;
  } catch {
    return null;
  }
}

async function sendCommand(command: string, value?: number) {
  try {
    await fetch('/api/music', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command, value }),
    });
  } catch { /* silent */ }
}

function formatTime(secs: number) {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function MusicWidget() {
  const [track, setTrack] = useState<TrackInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    const data = await fetchNowPlaying();
    setTrack(data);
    setLoading(false);
  }, []);

  // Initial load + polling
  useEffect(() => {
    refresh();
    pollRef.current = setInterval(refresh, POLL_INTERVAL);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [refresh]);

  // Listen for Jarvis-triggered updates and refreshes
  useEffect(() => {
    const onUpdate = (e: Event) => {
      const data = (e as CustomEvent<TrackInfo>).detail;
      if (data) setTrack(data);
    };
    const onRefresh = () => refresh();
    window.addEventListener('jarvis:music:update', onUpdate);
    window.addEventListener('jarvis:music:refresh', onRefresh);
    return () => {
      window.removeEventListener('jarvis:music:update', onUpdate);
      window.removeEventListener('jarvis:music:refresh', onRefresh);
    };
  }, [refresh]);

  const handleCommand = async (command: string) => {
    await sendCommand(command);
    // Optimistically toggle play state, then re-poll for truth
    if (command === 'playpause' || command === 'play' || command === 'pause') {
      setTrack(prev => prev ? { ...prev, isPlaying: command === 'play' ? true : command === 'pause' ? false : !prev.isPlaying } : prev);
    }
    setTimeout(refresh, 600);
  };

  const progress = track && track.duration > 0
    ? Math.min(100, (track.position / track.duration) * 100)
    : 0;

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2">
        <div className="w-4 h-4 border-2 border-cyan-500/50 border-t-cyan-400 rounded-full animate-spin" />
        <span className="text-[10px] text-cyan-500/50 uppercase tracking-widest">Connecting...</span>
      </div>
    );
  }

  if (!track) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2">
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-cyan-500/30">
          <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
        </svg>
        <span className="text-[10px] text-cyan-500/40 uppercase tracking-widest text-center">Nothing playing</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 h-full">
      {/* Album art + track info */}
      <div className="flex gap-3 items-start">
        {/* Album Art */}
        <div className="flex-shrink-0 w-16 h-16 rounded border border-cyan-500/20 overflow-hidden bg-cyan-950/20 relative">
          {track.artworkUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={track.artworkUrl}
              alt="Album art"
              className="w-full h-full object-cover"
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-cyan-500/30">
                <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
              </svg>
            </div>
          )}
          {/* Playing indicator overlay */}
          {track.isPlaying && (
            <div className="absolute bottom-0 inset-x-0 flex justify-center gap-[2px] pb-1">
              {[0, 1, 2].map(i => (
                <div
                  key={i}
                  className="w-[3px] bg-cyan-400 rounded-full"
                  style={{
                    height: '8px',
                    animation: `music-bar 0.8s ease-in-out infinite`,
                    animationDelay: `${i * 0.15}s`,
                  }}
                />
              ))}
            </div>
          )}
        </div>

        {/* Track details */}
        <div className="flex-1 min-w-0 flex flex-col gap-1 pt-0.5">
          <p className="text-white text-xs font-semibold leading-tight truncate">{track.title}</p>
          <p className="text-cyan-400/80 text-[11px] truncate">{track.artist}</p>
          <p className="text-white/40 text-[10px] truncate">{track.album}</p>
          <span className="text-[9px] uppercase tracking-widest text-cyan-500/40 mt-0.5">{track.app}</span>
        </div>
      </div>

      {/* Progress bar */}
      <div className="flex flex-col gap-1">
        <div className="w-full h-[3px] bg-cyan-950/60 rounded-full overflow-hidden">
          <div
            className="h-full bg-cyan-400 rounded-full transition-all duration-1000"
            style={{ width: `${progress}%` }}
          />
        </div>
        <div className="flex justify-between text-[9px] text-white/30">
          <span>{formatTime(track.position)}</span>
          <span>{formatTime(track.duration)}</span>
        </div>
      </div>

      {/* Playback controls */}
      <div className="flex items-center justify-center gap-4 mt-auto">
        <button
          onClick={() => handleCommand('previous')}
          className="text-cyan-500/60 hover:text-cyan-300 transition-colors"
          title="Previous"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/>
          </svg>
        </button>

        <button
          onClick={() => handleCommand('playpause')}
          className="w-9 h-9 rounded-full bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400 hover:bg-cyan-500/20 hover:border-cyan-400 transition-all"
          title={track.isPlaying ? 'Pause' : 'Play'}
        >
          {track.isPlaying ? (
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>
            </svg>
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z"/>
            </svg>
          )}
        </button>

        <button
          onClick={() => handleCommand('next')}
          className="text-cyan-500/60 hover:text-cyan-300 transition-colors"
          title="Next"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M6 18l8.5-6L6 6v12zm2.5-6 8.5 6V6z" style={{display:'none'}}/>
            <path d="M16 6h2v12h-2zm-3.5 6L4 6v12z"/>
          </svg>
        </button>

        {/* Volume controls */}
        <div className="flex gap-1 ml-2">
          <button
            onClick={() => handleCommand('volume_down')}
            className="text-cyan-500/40 hover:text-cyan-300 transition-colors"
            title="Volume down"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/>
            </svg>
          </button>
          <button
            onClick={() => handleCommand('volume_up')}
            className="text-cyan-500/40 hover:text-cyan-300 transition-colors"
            title="Volume up"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
              <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
