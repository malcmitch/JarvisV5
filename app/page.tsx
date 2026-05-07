'use client';

import { useState, useEffect } from 'react';
import { ConversationProvider } from '@elevenlabs/react';
import { JarvisAssistant } from "./components/JarvisAssistant";
import { HUDLayer } from "./components/HUD/HUDLayer";
import { IntroAnimation } from "./components/IntroAnimation";
import { AnimatePresence } from 'framer-motion';

export default function Home() {
  const [showIntro, setShowIntro]       = useState(false);
  // Hidden until the intro starts its exit fade — prevents the real content
  // from being visible while the intro Jarvis is on screen.
  const [contentReady, setContentReady] = useState(false);

  useEffect(() => {
    const seen = sessionStorage.getItem('jarvis_intro_done');
    if (!seen) {
      setShowIntro(true);
    } else {
      setContentReady(true); // no intro this session — show immediately
    }
  }, []);

  const handleIntroComplete = () => {
    sessionStorage.setItem('jarvis_intro_done', '1');
    setShowIntro(false);
  };

  return (
    <main className="min-h-screen bg-black text-white overflow-hidden relative">
      {/* JarvisAssistant hidden until intro ends (ring sync still runs underneath) */}
      <div style={{ opacity: contentReady ? 1 : 0, transition: 'none' }}>
        <ConversationProvider>
          <JarvisAssistant />
        </ConversationProvider>
      </div>

      {/* HUDLayer always rendered so widgets are in place behind the intro overlay.
          scanReady triggers the per-widget scan animation at the right moment. */}
      <HUDLayer scanReady={contentReady} />

      {/* Intro — sits on top; calls onFadeStart the moment it begins fading */}
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
