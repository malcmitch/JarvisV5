'use client';

import { useState, useEffect } from 'react';
import { AnimatePresence } from 'framer-motion';
import { sfx } from '../../lib/sfx';
import { HUDModule } from './HUDModule';
import { SystemStatusWidget } from './widgets/SystemStatusWidget';
import { NetworkGraphWidget } from './widgets/NetworkGraphWidget';
import { MapWidget } from './widgets/MapWidget';
import { ClockWidget } from './widgets/ClockWidget';
import { SuitWidget } from './widgets/SuitWidget';
import { MusicWidget } from './widgets/MusicWidget';
import { TextWidget } from './widgets/TextWidget';
import { PdfWidget } from './widgets/PdfWidget';
import { ImageWidget } from './widgets/ImageWidget';

type WidgetType = 'system' | 'network' | 'map' | 'clock' | 'suit' | 'music' | 'text' | 'pdf' | 'image';

interface ModuleData {
  id: string;
  type: WidgetType;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Body copy for the text note widget */
  textContent?: string;
  /** URL or filesystem path for the PDF viewer */
  pdfSource?: string;
  /** PNG base64 from image generation */
  imageBase64?: string;
  imageLoading?: boolean;
  imageError?: string;
  /** Short prompt preview */
  imageCaption?: string;
  /** If set, x is recomputed as (windowWidth - rightOffset) on resize */
  rightOffset?: number;
}

const WIDGET_META: Record<WidgetType, { title: string; width: number; height: number }> = {
  clock:   { title: 'LOCAL TIME',      width: 300, height: 180 },
  system:  { title: 'SYSTEM STATUS',   width: 300, height: 250 },
  network: { title: 'NETWORK TRAFFIC', width: 300, height: 200 },
  map:     { title: 'GEO-LOCATION',    width: 400, height: 250 },
  suit:    { title: 'MK.2 ARMOR',      width: 240, height: 500 },
  music:   { title: 'NOW PLAYING',     width: 300, height: 230 },
  text:    { title: 'TEXT NOTE',       width: 380, height: 280 },
  pdf:     { title: 'DOCUMENT',        width: 440, height: 340 },
  image:   { title: 'IMAGE',           width: 400, height: 360 },
};

function buildDefaultModules(w: number): ModuleData[] {
  return [
    { id: '1', type: 'clock',   ...WIDGET_META.clock,   x: 50,       y: 50  },
    { id: '2', type: 'system',  ...WIDGET_META.system,  x: 50,       y: 250 },
    { id: '3', type: 'network', ...WIDGET_META.network, x: 50,       y: 520 },
    { id: '4', type: 'map',     ...WIDGET_META.map,     x: w - 450,  y: 50,  rightOffset: 450 },
    { id: '5', type: 'suit',    ...WIDGET_META.suit,    x: w - 300,  y: 320, rightOffset: 300 },
  ];
}

export function HUDLayer({ scanReady = true }: { scanReady?: boolean }) {
  const [modules, setModules] = useState<ModuleData[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    setModules(buildDefaultModules(window.innerWidth));

    const handleResize = () => {
      const w = window.innerWidth;
      setModules(prev => prev.map(m =>
        m.rightOffset !== undefined ? { ...m, x: w - m.rightOffset } : m
      ));
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Listen for Jarvis HUD control events
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{
        command: string;
        widget?: string;
        text?: string;
        title?: string;
        pdf_source?: string;
        module_id?: string;
        image_loading?: boolean;
        image_base64?: string;
        image_caption?: string;
        image_error?: string;
        id?: string;
      }>).detail;

      const { command, widget, text, title, pdf_source, module_id, image_loading, image_base64, image_caption } =
        detail;

      if (command === 'set_image') {
        const targetId = detail.id;
        if (!targetId) return;
        setModules((prev) =>
          prev.map((m) =>
            m.id === targetId
              ? {
                  ...m,
                  imageBase64: detail.image_base64,
                  imageLoading: false,
                  imageError: detail.image_error,
                  ...(detail.title?.trim()
                    ? { title: detail.title.trim().toUpperCase() }
                    : {}),
                }
              : m
          )
        );
        return;
      }

      if (command === 'clear') {
        setModules([]);
        setExpandedId(null);
        return;
      }

      if (command === 'reset') {
        setModules(buildDefaultModules(window.innerWidth));
        setExpandedId(null);
        return;
      }

      const type = widget as WidgetType;
      if (!type || !WIDGET_META[type]) return;

      if (command === 'open') {
        if (type === 'pdf' && !(pdf_source ?? '').trim()) return;

        const newModuleId =
          type === 'image' && module_id?.trim() ? module_id.trim() : String(Date.now());
        setModules(prev => {
          if (type !== 'text' && type !== 'pdf' && type !== 'image' && prev.some(m => m.type === type)) return prev;
          const meta = WIDGET_META[type];
          const stagger =
            (prev.filter(m => m.type === 'text' || m.type === 'pdf' || m.type === 'image').length % 6) * 28;
          const moduleTitle =
            type === 'text' && title?.trim()
              ? title.trim().toUpperCase()
              : type === 'pdf' && title?.trim()
                ? title.trim().toUpperCase()
                : type === 'image' && title?.trim()
                  ? title.trim().toUpperCase()
                  : meta.title;
          const textContent = type === 'text' ? (text ?? '') : undefined;
          const pdfSource = type === 'pdf' ? (pdf_source ?? '').trim() : undefined;
          if (type === 'pdf' && !pdfSource) return prev;

          const imageCaption =
            type === 'image' && typeof image_caption === 'string' ? image_caption : undefined;

          return [
            ...prev,
            {
              id: newModuleId,
              type,
              title: moduleTitle,
              width: meta.width,
              height: meta.height,
              textContent,
              pdfSource,
              ...(type === 'image'
                ? {
                    imageLoading: !!image_loading,
                    imageBase64: typeof image_base64 === 'string' ? image_base64 : undefined,
                    imageCaption,
                    imageError: undefined,
                  }
                : {}),
              x: 100 + stagger,
              y: 100 + stagger,
            },
          ];
        });
        if (type === 'pdf') setExpandedId(newModuleId);
      }

      if (command === 'close') {
        setModules(prev => {
          const targets = prev.filter(m => m.type === type);
          if (targets.length === 0) return prev;
          const closingExpanded = targets.some(m => m.id === expandedId);
          if (closingExpanded) setExpandedId(null);
          sfx('app_close', 0.6);
          return prev.filter(m => m.type !== type);
        });
      }
    };

    window.addEventListener('jarvis:hud', handler);
    return () => window.removeEventListener('jarvis:hud', handler);
  }, [expandedId]);

  const removeModule = (id: string) => {
    setModules(prev => prev.filter(m => m.id !== id));
    if (expandedId === id) setExpandedId(null);
  };

  const toggleExpand = (id: string) => {
    setExpandedId(prev => prev === id ? null : id);
  };

  const handleResize = (id: string, width: number, height: number) => {
    setModules(prev => prev.map(m => 
      m.id === id ? { ...m, width, height } : m
    ));
  };

  return (
    <div className="fixed inset-0 pointer-events-none z-10 overflow-hidden">
      {/* Backdrop when expanded - Blurs background */}
      <AnimatePresence>
        {expandedId && (
          <div 
            className="absolute inset-0 bg-black/80 backdrop-blur-md pointer-events-auto z-40 transition-all duration-300"
            onClick={() => setExpandedId(null)}
          />
        )}
      </AnimatePresence>

      {modules.map(module => (
        <HUDModule
          key={module.id}
          id={module.id}
          title={module.title}
          initialX={module.x}
          initialY={module.y}
          width={module.width}
          height={module.height}
          onDelete={removeModule}
          isExpanded={expandedId === module.id}
          onToggleExpand={toggleExpand}
          onResize={handleResize}
          scanReady={scanReady}
          expandedSize={module.type === 'pdf' ? 'large' : 'standard'}
          embedContent={module.type === 'image'}
        >
          {module.type === 'clock' && <ClockWidget />}
          {module.type === 'system' && <SystemStatusWidget />}
          {module.type === 'network' && <NetworkGraphWidget />}
          {module.type === 'map' && <MapWidget />}
          {module.type === 'suit' && <SuitWidget />}
          {module.type === 'music' && <MusicWidget />}
          {module.type === 'text' && (
            <TextWidget content={module.textContent ?? ''} />
          )}
          {module.type === 'pdf' && (
            <PdfWidget source={module.pdfSource ?? ''} />
          )}
          {module.type === 'image' && (
            <ImageWidget
              imageBase64={module.imageBase64}
              loading={module.imageLoading ?? false}
              error={module.imageError}
              caption={module.imageCaption}
            />
          )}
        </HUDModule>
      ))}
    </div>
  );
}
