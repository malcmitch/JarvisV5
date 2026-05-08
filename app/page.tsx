'use client';

import { useState, useEffect } from 'react';
import dynamic from 'next/dynamic';
import { ConversationProvider } from '@elevenlabs/react';
import { JarvisAssistant } from "./components/JarvisAssistant";
import { HUDLayer } from "./components/HUD/HUDLayer";
import { IntroAnimation } from "./components/IntroAnimation";
import { NewsPage } from "./components/pages/NewsPage";
import { AnimatePresence } from 'framer-motion';

// MapLibre GL JS accesses browser APIs on import — must be client-only (no SSR)
const MapPage = dynamic(
  () => import('./components/pages/MapPage').then((m) => ({ default: m.MapPage })),
  { ssr: false }
);

type JarvisPage = 'home' | 'news' | 'map';

export default function Home() {
  const [showIntro, setShowIntro]         = useState(false);
  const [contentReady, setContentReady]   = useState(false);
  const [currentPage, setCurrentPage]     = useState<JarvisPage>('home');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [pendingMapCmd, setPendingMapCmd] = useState<Record<string, any> | null>(null);

  useEffect(() => {
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
      if (page === 'home' || page === 'news' || page === 'map') {
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
