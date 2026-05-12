'use client';

import { useState, useEffect } from 'react';
import dynamic from 'next/dynamic';
import { ConversationProvider } from '@elevenlabs/react';
import { JarvisAssistant } from "./components/JarvisAssistant";
import { HUDLayer } from "./components/HUD/HUDLayer";
import { IntroAnimation } from "./components/IntroAnimation";
import { NewsPage } from "./components/pages/NewsPage";
import { CalendarPage } from "./components/pages/CalendarPage";
import { HomeAssistantPage } from "./components/pages/HomeAssistantPage";
import { PrinterPage } from "./components/pages/PrinterPage";
import { MusicPage } from "./components/pages/MusicPage";
import { AnimatePresence } from 'framer-motion';
import { loadServerSettings } from './lib/serverSettings';

// MapLibre GL JS accesses browser APIs on import — must be client-only (no SSR)
const MapPage = dynamic(
  () => import('./components/pages/MapPage').then((m) => ({ default: m.MapPage })),
  { ssr: false }
);

type JarvisPage = 'home' | 'news' | 'map' | 'calendar' | 'home-assistant' | '3d-printers' | 'music';

const VALID_PAGES: JarvisPage[] = ['home', 'news', 'map', 'calendar', 'home-assistant', '3d-printers', 'music'];

export default function Home() {
  const [showIntro, setShowIntro]         = useState(false);
  const [contentReady, setContentReady]   = useState(false);
  // Always start on 'home' so server and client render the same HTML (no
  // hydration mismatch). The saved page is restored in a useEffect after
  // hydration — this avoids the typeof window SSR/client branch error.
  const [currentPage, setCurrentPage]     = useState<JarvisPage>('home');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [pendingMapCmd, setPendingMapCmd] = useState<Record<string, any> | null>(null);

  // Persist current page so it survives full tab reloads (iOS Safari jettisoning,
  // Next.js HMR reconnects, etc.)
  useEffect(() => {
    localStorage.setItem('jarvis_current_page', currentPage);
  }, [currentPage]);

  useEffect(() => {
    // Log the reason for this page mount — critical for diagnosing unexpected reloads.
    const nav = (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined);
    const navType = nav?.type ?? 'unknown'; // 'navigate' | 'reload' | 'back_forward' | 'prerender'
    const restored = localStorage.getItem('jarvis_current_page');
    console.log(
      `%c[Jarvis Page] MOUNTED — nav type: "${navType}" | restored page: "${restored ?? 'none'}" | timestamp: ${new Date().toLocaleTimeString()}`,
      'background:#1a1a2e;color:#00d4ff;font-weight:bold;padding:2px 6px;border-radius:3px'
    );
    if (navType === 'reload') {
      console.warn('[Jarvis Page] ⚠️  This was a hard browser reload (F5 or programmatic window.location.reload).');
    } else if (navType === 'navigate') {
      console.warn('[Jarvis Page] ⚠️  This was a fresh navigation — likely Next.js HMR reconnect or iOS/Android tab jettison (browser killed the tab due to memory pressure).');
    }
  }, []);

  useEffect(() => {
    // Restore the last page the user was on after hydration completes.
    const saved = localStorage.getItem('jarvis_current_page') as JarvisPage | null;
    if (saved && VALID_PAGES.includes(saved) && saved !== 'home') {
      setCurrentPage(saved);
    }

    // Pre-warm the server settings cache so all child components can read
    // getCachedSetting() synchronously before their own effects run.
    loadServerSettings();

    const seen = sessionStorage.getItem('jarvis_intro_done');
    if (!seen) {
      setShowIntro(true);
    } else {
      setContentReady(true);
    }
  }, []);

  // Listen for navigate events dispatched by Jarvis functions
  useEffect(() => {
    const handler = (e: Event) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const detail = (e as CustomEvent<any>).detail ?? {};
      const page: JarvisPage = detail.page;
      if (page === 'home' || page === 'news' || page === 'map' || page === 'calendar' || page === 'home-assistant' || page === '3d-printers' || page === 'music') {
        setCurrentPage(page);
        if (page === 'map' && detail.mapCommand) {
          setPendingMapCmd(detail.mapCommand);
        }
      }
    };
    window.addEventListener('jarvis:navigate', handler);
    return () => window.removeEventListener('jarvis:navigate', handler);
  }, []);

  const handleIntroComplete = () => {
    sessionStorage.setItem('jarvis_intro_done', '1');
    setShowIntro(false);
  };

  return (
    <main className="min-h-screen bg-black text-white overflow-hidden relative">
      {/* Home layer — always mounted so audio/AI session persists across pages.
          JarvisAssistant becomes a compact corner visualizer when on other pages. */}
      <div style={{ opacity: contentReady ? 1 : 0, transition: 'none' }}>
        <ConversationProvider>
          <JarvisAssistant compact={currentPage !== 'home'} />
        </ConversationProvider>
      </div>

      {/* HUD widgets — sit behind page overlays */}
      <HUDLayer scanReady={contentReady} />

      {/* Page overlays — slide in over the home layer */}
      <AnimatePresence mode="wait">
        {currentPage === 'news' && (
          <NewsPage key="news" onNavigateHome={() => setCurrentPage('home')} />
        )}
        {currentPage === 'map' && (
          <MapPage
            key="map"
            onNavigateHome={() => setCurrentPage('home')}
            pendingCommand={pendingMapCmd}
            onPendingCommandConsumed={() => setPendingMapCmd(null)}
          />
        )}
        {currentPage === 'calendar' && (
          <CalendarPage key="calendar" onNavigateHome={() => setCurrentPage('home')} />
        )}
        {currentPage === 'home-assistant' && (
          <HomeAssistantPage key="home-assistant" onNavigateHome={() => setCurrentPage('home')} />
        )}
        {currentPage === '3d-printers' && (
          <PrinterPage key="3d-printers" onNavigateHome={() => setCurrentPage('home')} />
        )}
        {currentPage === 'music' && (
          <MusicPage key="music" onNavigateHome={() => setCurrentPage('home')} />
        )}
      </AnimatePresence>

      {/* Intro overlay */}
      <AnimatePresence>
        {showIntro && (
          <IntroAnimation
            onComplete={handleIntroComplete}
            onFadeStart={() => setContentReady(true)}
          />
        )}
      </AnimatePresence>
    </main>
  );
}
