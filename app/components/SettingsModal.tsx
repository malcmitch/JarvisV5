'use client';

import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { FUNCTION_REGISTRY, JarvisFunction } from '../lib/functions';
import { sfx } from '../lib/sfx';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (settings: JarvisSettings) => void;
  initialSettings: JarvisSettings;
  dynamicFunctions?: JarvisFunction[];
}

export type JarvisTheme = 'arc-reactor' | 'midnight' | 'crimson' | 'matrix';
export type JarvisGrid = 'off' | 'small' | 'medium' | 'large';
export type JarvisVisualizer = 'frequency-ring' | 'arc-reactor' | 'sphere-nodes';
export type JarvisLogo = 'logo' | 'logo2';
export type JarvisPosition = 'center' | 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right';

export type RealtimeModel = 'gpt-realtime-2' | 'gpt-realtime-1.5' | 'gpt-realtime-mini';

export interface JarvisSettings {
  apiMode: 'openai' | 'elevenlabs';
  apiKey: string;
  realtimeModel?: RealtimeModel;
  elevenLabsAgentId?: string;
  elevenLabsFirstMessage?: string;
  voice: 'alloy' | 'echo' | 'shimmer';
  initialPrompt: string;
  enabledFunctions: string[];
  theme: JarvisTheme;
  grid: JarvisGrid;
  visualizer: JarvisVisualizer;
  logo: JarvisLogo;
  position: JarvisPosition;
  /** Full path to shell (cmd.exe, PowerShell, /bin/zsh). Empty = auto-detect. */
  shellPathOverride?: string;
  /** Full path to python.exe for Computer Use. Empty = bundled binary or PATH. */
  pythonPathOverride?: string;
}

const VISUALIZERS: { id: JarvisVisualizer; name: string; desc: string }[] = [
  { id: 'frequency-ring', name: 'Frequency Ring', desc: 'FFT bars radiating from the logo rings' },
  { id: 'arc-reactor',    name: 'Arc Reactor',    desc: 'Polar wave + segmented reactor rings' },
  {
    id: 'sphere-nodes',
    name: 'Sphere Nodes',
    desc: '3D orbiting nodes + FFT glitch; logo built from particles',
  },
];

const LOGOS: { id: JarvisLogo; name: string; src: string }[] = [
  { id: 'logo',  name: 'Classic',  src: '/assets/logo.png'  },
  { id: 'logo2', name: 'Variant',  src: '/assets/logo2.png' },
];

const POSITIONS: { id: JarvisPosition; label: string; icon: string }[] = [
  { id: 'top-left',     label: 'Top Left',     icon: '↖' },
  { id: 'top-right',    label: 'Top Right',    icon: '↗' },
  { id: 'center',       label: 'Center',       icon: '⊙' },
  { id: 'bottom-left',  label: 'Bottom Left',  icon: '↙' },
  { id: 'bottom-right', label: 'Bottom Right', icon: '↘' },
];

type Tab = 'jarvis' | 'abilities' | 'ui' | 'system';

const THEMES: { id: JarvisTheme; name: string; accent: string; glow: string }[] = [
  { id: 'arc-reactor', name: 'Arc Reactor', accent: '#22d3ee', glow: 'rgba(34,211,238,0.4)' },
  { id: 'midnight',    name: 'Midnight',    accent: '#a855f7', glow: 'rgba(168,85,247,0.4)'  },
  { id: 'crimson',     name: 'Crimson',     accent: '#ef4444', glow: 'rgba(239,68,68,0.4)'   },
  { id: 'matrix',      name: 'Matrix',      accent: '#22c55e', glow: 'rgba(34,197,94,0.4)'   },
];

const GRID_OPTIONS: { id: JarvisGrid; label: string }[] = [
  { id: 'off',    label: 'Off'    },
  { id: 'small',  label: 'Small'  },
  { id: 'medium', label: 'Medium' },
  { id: 'large',  label: 'Large'  },
];

export function SettingsModal({ isOpen, onClose, onSave, initialSettings, dynamicFunctions = [] }: SettingsModalProps) {
  const [settings, setSettings] = useState<JarvisSettings>(initialSettings);
  const [activeTab, setActiveTab] = useState<Tab>('jarvis');
  const [diagLoading, setDiagLoading] = useState(false);
  const [diagOutput, setDiagOutput] = useState<string | null>(null);
  const [diagError, setDiagError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setSettings(initialSettings);
      setActiveTab('jarvis');
      setDiagOutput(null);
      setDiagError(null);
    }
  }, [isOpen, initialSettings]);

  async function runDiagnostics() {
    sfx('click_sfx', 0.5);
    setDiagLoading(true);
    setDiagError(null);
    setDiagOutput(null);
    try {
      const res = await fetch('/api/system-diagnostics');
      if (!res.ok) {
        setDiagError(`HTTP ${res.status}`);
        return;
      }
      const data = await res.json();
      setDiagOutput(JSON.stringify(data, null, 2));
    } catch (e) {
      setDiagError(e instanceof Error ? e.message : String(e));
    } finally {
      setDiagLoading(false);
    }
  }

  if (!isOpen) return null;

  const tabs: { id: Tab; label: string }[] = [
    { id: 'jarvis',    label: 'Jarvis'     },
    { id: 'abilities', label: 'Abilities'  },
    { id: 'ui',        label: 'UI'         },
    { id: 'system',    label: 'System'     },
  ];

  const panelMaxWidth = activeTab === 'system' ? 'max-w-2xl' : 'max-w-md';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.9 }}
        className={`w-full ${panelMaxWidth} bg-black/90 border border-cyan-500/50 rounded-lg shadow-[0_0_30px_rgba(34,211,238,0.2)] overflow-hidden`}
        style={{ boxShadow: `0 0 30px var(--accent-glow)` }}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-cyan-500/30 bg-cyan-950/30 flex items-center justify-between">
          <h2 className="text-xl font-bold text-cyan-400 tracking-wider">SYSTEM CONFIGURATION</h2>
          <button onClick={onClose} className="text-cyan-500 hover:text-cyan-300">✕</button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-cyan-500/20 bg-cyan-950/10">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => { sfx('switch_interface', 0.5, 2); setActiveTab(tab.id); }}
              className={`flex-1 px-4 py-3 text-xs font-bold uppercase tracking-widest transition-all ${
                activeTab === tab.id
                  ? 'text-cyan-300 border-b-2 border-cyan-400 bg-cyan-950/30'
                  : 'text-cyan-600 hover:text-cyan-400'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className={`p-6 space-y-6 overflow-y-auto ${activeTab === 'system' ? 'max-h-[65vh]' : 'max-h-[55vh]'}`}>

          {/* Jarvis Tab */}
          {activeTab === 'jarvis' && (
            <>
              {/* API Mode switcher */}
              <div className="space-y-2">
                <label className="text-xs font-bold text-cyan-500 uppercase tracking-widest">Voice Engine</label>
                <div className="grid grid-cols-2 gap-2">
                  {(['openai', 'elevenlabs'] as const).map((mode) => {
                    const active = (settings.apiMode ?? 'openai') === mode;
                    const labels = { openai: 'OpenAI Realtime', elevenlabs: 'ElevenLabs' };
                    const descs  = { openai: 'GPT-4o via WebRTC', elevenlabs: 'Jarvis Agent via WebRTC' };
                    return (
                      <button
                        key={mode}
                        onClick={() => { sfx('select', 0.5); setSettings({ ...settings, apiMode: mode }); }}
                        className={`flex flex-col items-start px-3 py-2.5 border rounded text-left transition-all ${
                          active
                            ? 'bg-cyan-500/20 border-cyan-400 shadow-[0_0_10px_rgba(34,211,238,0.2)]'
                            : 'bg-transparent border-cyan-500/20 hover:border-cyan-500/50'
                        }`}
                      >
                        <span className={`text-xs font-bold uppercase tracking-wide ${active ? 'text-cyan-300' : 'text-cyan-600'}`}>
                          {labels[mode]}
                        </span>
                        <span className="text-[10px] text-white/30 mt-0.5">{descs[mode]}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* OpenAI fields */}
              {(settings.apiMode ?? 'openai') === 'openai' && (
                <div className="space-y-2">
                  <label className="text-xs font-bold text-cyan-500 uppercase tracking-widest">OpenAI API Key</label>
                  <input
                    type="password"
                    value={settings.apiKey}
                    onChange={(e) => setSettings({ ...settings, apiKey: e.target.value })}
                    placeholder="sk-..."
                    className="w-full bg-cyan-950/20 border border-cyan-500/30 rounded px-3 py-2 text-cyan-100 focus:outline-none focus:border-cyan-400 focus:shadow-[0_0_10px_rgba(34,211,238,0.3)] transition-all font-mono text-sm"
                  />
                </div>
              )}

              {(settings.apiMode ?? 'openai') === 'openai' && (
                <div className="space-y-2">
                  <label className="text-xs font-bold text-cyan-500 uppercase tracking-widest">Realtime Model</label>
                  <div className="grid grid-cols-3 gap-2">
                    {([
                      { id: 'gpt-realtime-2',    label: 'Realtime 2',    desc: 'Reasoning' },
                      { id: 'gpt-realtime-1.5',  label: 'Realtime 1.5',  desc: 'Best voice' },
                      { id: 'gpt-realtime-mini', label: 'Realtime Mini', desc: 'Cost-efficient' },
                    ] as { id: RealtimeModel; label: string; desc: string }[]).map((m) => {
                      const active = (settings.realtimeModel ?? 'gpt-realtime-1.5') === m.id;
                      return (
                        <button
                          key={m.id}
                          onClick={() => { sfx('select', 0.5); setSettings({ ...settings, realtimeModel: m.id }); }}
                          className={`flex flex-col items-center px-2 py-2 border rounded text-xs transition-all ${
                            active
                              ? 'bg-cyan-500/20 border-cyan-400 text-cyan-300 shadow-[0_0_10px_rgba(34,211,238,0.2)]'
                              : 'bg-transparent border-cyan-500/20 text-cyan-600 hover:border-cyan-500/50 hover:text-cyan-400'
                          }`}
                        >
                          <span className="font-bold uppercase tracking-wide">{m.label}</span>
                          <span className="text-[10px] opacity-70 mt-0.5">{m.desc}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* ElevenLabs fields */}
              {(settings.apiMode ?? 'openai') === 'elevenlabs' && (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <label className="text-xs font-bold text-cyan-500 uppercase tracking-widest">Agent ID</label>
                    <input
                      type="text"
                      value={settings.elevenLabsAgentId ?? ''}
                      onChange={(e) => setSettings({ ...settings, elevenLabsAgentId: e.target.value })}
                      placeholder="agent_..."
                      className="w-full bg-cyan-950/20 border border-cyan-500/30 rounded px-3 py-2 text-cyan-100 focus:outline-none focus:border-cyan-400 focus:shadow-[0_0_10px_rgba(34,211,238,0.3)] transition-all font-mono text-sm"
                    />
                    <p className="text-xs text-cyan-700">Found in your ElevenLabs agent dashboard.</p>
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-bold text-cyan-500 uppercase tracking-widest">First Message <span className="text-cyan-700 normal-case font-normal">(optional override)</span></label>
                    <input
                      type="text"
                      value={settings.elevenLabsFirstMessage ?? ''}
                      onChange={(e) => setSettings({ ...settings, elevenLabsFirstMessage: e.target.value })}
                      placeholder="Good evening, sir. All systems online."
                      className="w-full bg-cyan-950/20 border border-cyan-500/30 rounded px-3 py-2 text-cyan-100 focus:outline-none focus:border-cyan-400 focus:shadow-[0_0_10px_rgba(34,211,238,0.3)] transition-all font-mono text-sm"
                    />
                    <p className="text-xs text-cyan-700">Leave empty to use the agent&apos;s default greeting.</p>
                  </div>
                </div>
              )}

              {/* Voice Interface — OpenAI only */}
              {(settings.apiMode ?? 'openai') === 'openai' && (
                <div className="space-y-2">
                  <label className="text-xs font-bold text-cyan-500 uppercase tracking-widest">Voice Interface</label>
                  <div className="grid grid-cols-3 gap-2">
                    {(['alloy', 'echo', 'shimmer'] as const).map((voice) => (
                      <button
                        key={voice}
                        onClick={() => { sfx('select', 0.5); setSettings({ ...settings, voice }); }}
                        className={`px-3 py-2 border rounded text-sm uppercase tracking-wide transition-all ${
                          settings.voice === voice
                            ? 'bg-cyan-500/20 border-cyan-400 text-cyan-300 shadow-[0_0_10px_rgba(34,211,238,0.2)]'
                            : 'bg-transparent border-cyan-500/20 text-cyan-600 hover:border-cyan-500/50 hover:text-cyan-400'
                        }`}
                      >
                        {voice}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="space-y-2">
                <label className="text-xs font-bold text-cyan-500 uppercase tracking-widest">Voice Visualizer</label>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  {VISUALIZERS.map((v) => {
                    const active = settings.visualizer === v.id;
                    return (
                      <button
                        key={v.id}
                        onClick={() => { sfx('select', 0.5); setSettings({ ...settings, visualizer: v.id }); }}
                        className={`flex flex-col items-start px-3 py-2.5 border rounded text-left transition-all ${
                          active
                            ? 'bg-cyan-500/20 border-cyan-400 shadow-[0_0_10px_rgba(34,211,238,0.2)]'
                            : 'bg-transparent border-cyan-500/20 hover:border-cyan-500/50'
                        }`}
                      >
                        <span className={`text-xs font-bold uppercase tracking-wide ${active ? 'text-cyan-300' : 'text-cyan-600'}`}>
                          {v.name}
                        </span>
                        <span className="text-[10px] text-white/30 mt-0.5 leading-tight">{v.desc}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-xs font-bold text-cyan-500 uppercase tracking-widest">Center Logo</label>
                <div className="grid grid-cols-2 gap-2">
                  {LOGOS.map((l) => {
                    const active = (settings.logo ?? 'logo') === l.id;
                    return (
                      <button
                        key={l.id}
                        onClick={() => { sfx('select', 0.5); setSettings({ ...settings, logo: l.id }); }}
                        className={`flex flex-col items-center gap-2 px-3 py-3 border rounded transition-all ${
                          active
                            ? 'bg-cyan-500/20 border-cyan-400 shadow-[0_0_10px_rgba(34,211,238,0.2)]'
                            : 'bg-transparent border-cyan-500/20 hover:border-cyan-500/50'
                        }`}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={l.src} alt={l.name} className="w-24 h-24 object-contain opacity-90" />
                        <span className={`text-xs font-bold uppercase tracking-wide ${active ? 'text-cyan-300' : 'text-cyan-600'}`}>
                          {l.name}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-xs font-bold text-cyan-500 uppercase tracking-widest">Position</label>
                <div className="grid grid-cols-3 gap-2">
                  {POSITIONS.map((p) => {
                    const active = (settings.position ?? 'center') === p.id;
                    return (
                      <button
                        key={p.id}
                        onClick={() => { sfx('select', 0.5); setSettings({ ...settings, position: p.id }); }}
                        className={`flex flex-col items-center gap-1 px-2 py-2.5 border rounded transition-all ${
                          active
                            ? 'bg-cyan-500/20 border-cyan-400 shadow-[0_0_10px_rgba(34,211,238,0.2)]'
                            : 'bg-transparent border-cyan-500/20 hover:border-cyan-500/50'
                        } ${p.id === 'center' ? 'col-start-2' : ''}`}
                      >
                        <span className={`text-base leading-none ${active ? 'text-cyan-300' : 'text-cyan-600'}`}>{p.icon}</span>
                        <span className={`text-[10px] font-bold uppercase tracking-wide leading-tight text-center ${active ? 'text-cyan-300' : 'text-cyan-600'}`}>
                          {p.label}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-xs font-bold text-cyan-500 uppercase tracking-widest">Initial Protocol (Prompt)</label>
                <textarea
                  value={settings.initialPrompt}
                  onChange={(e) => setSettings({ ...settings, initialPrompt: e.target.value })}
                  rows={4}
                  className="w-full bg-cyan-950/20 border border-cyan-500/30 rounded px-3 py-2 text-cyan-100 focus:outline-none focus:border-cyan-400 focus:shadow-[0_0_10px_rgba(34,211,238,0.3)] transition-all font-mono text-sm resize-none"
                />
              </div>
            </>
          )}

          {/* Abilities Tab */}
          {activeTab === 'abilities' && (
            <div className="space-y-3">
              <p className="text-xs text-cyan-600">
                Enable modules to give Jarvis access to real-time data and actions.
              </p>
              <div className="space-y-2">
                {FUNCTION_REGISTRY.map((fn) => {
                  const enabled = settings.enabledFunctions.includes(fn.name);
                  return (
                    <div
                      key={fn.name}
                      className="flex items-center justify-between px-4 py-3 rounded border border-cyan-500/20 bg-cyan-950/10"
                    >
                      <div>
                        <p className="text-sm text-cyan-300 font-semibold">{fn.label}</p>
                        <p className="text-xs text-cyan-600 mt-0.5">{fn.description}</p>
                      </div>
                      <button
                        onClick={() => {
                          sfx('click_sfx', 0.5);
                          setSettings({
                            ...settings,
                            enabledFunctions: enabled
                              ? settings.enabledFunctions.filter((n) => n !== fn.name)
                              : [...settings.enabledFunctions, fn.name],
                          });
                        }}
                        className={`relative flex-shrink-0 w-11 h-6 rounded-full transition-colors duration-200 focus:outline-none ml-4 ${
                          enabled ? 'bg-cyan-500' : 'bg-cyan-900/60'
                        }`}
                      >
                        <span
                          className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${
                            enabled ? 'translate-x-5' : 'translate-x-0'
                          }`}
                        />
                      </button>
                    </div>
                  );
                })}
              </div>

              {dynamicFunctions.length > 0 && (
                <>
                  <div className="mt-4 mb-2 border-t border-cyan-500/20 pt-4">
                    <p className="text-xs font-bold text-cyan-500 uppercase tracking-widest">MCP &amp; Skills</p>
                    <p className="text-[10px] text-cyan-700 mt-1">External tools loaded from configuration.</p>
                  </div>
                  {dynamicFunctions.map((fn) => {
                    const enabled = settings.enabledFunctions.includes(fn.name);
                    const isMcp = fn.description.includes('MCP');
                    return (
                      <div key={fn.name} className="flex items-center justify-between px-4 py-3 rounded border border-cyan-500/20 bg-cyan-950/10">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="text-sm text-cyan-300 font-semibold">{fn.label}</p>
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-500 border border-cyan-500/30 uppercase font-mono">
                              {isMcp ? 'MCP' : 'Skill'}
                            </span>
                          </div>
                          <p className="text-xs text-cyan-600 mt-0.5 truncate">{fn.description}</p>
                        </div>
                        <button
                          onClick={() => {
                            sfx('click_sfx', 0.5);
                            setSettings({
                              ...settings,
                              enabledFunctions: enabled
                                ? settings.enabledFunctions.filter((n) => n !== fn.name)
                                : [...settings.enabledFunctions, fn.name],
                            });
                          }}
                          className={`relative flex-shrink-0 w-11 h-6 rounded-full transition-colors duration-200 focus:outline-none ml-4 ${
                            enabled ? 'bg-cyan-500' : 'bg-cyan-900/60'
                          }`}
                        >
                          <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${
                            enabled ? 'translate-x-5' : 'translate-x-0'
                          }`} />
                        </button>
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          )}

          {/* System — terminal & computer use diagnostics / overrides */}
          {activeTab === 'system' && (
            <div className="space-y-5">
              <p className="text-xs text-cyan-600 leading-relaxed">
                Jarvis usually detects your shell and Python automatically. Use overrides only if Terminal or Computer Use
                fail after a restart. Run diagnostics and share the JSON if you need support.
              </p>

              <div className="space-y-2">
                <label className="text-xs font-bold text-cyan-500 uppercase tracking-widest">
                  Shell path override
                </label>
                <input
                  type="text"
                  value={settings.shellPathOverride ?? ''}
                  onChange={(e) => setSettings({ ...settings, shellPathOverride: e.target.value })}
                  placeholder="Auto — e.g. C:\Windows\System32\cmd.exe or /bin/zsh"
                  className="w-full bg-cyan-950/20 border border-cyan-500/30 rounded px-3 py-2 text-cyan-100 focus:outline-none focus:border-cyan-400 font-mono text-xs"
                />
                <p className="text-[10px] text-cyan-700">
                  Windows: <span className="text-cyan-500">cmd.exe</span> or <span className="text-cyan-500">powershell.exe</span>.
                  macOS: e.g. <span className="text-cyan-500">/bin/zsh</span>. Leave empty for default.
                </p>
              </div>

              <div className="space-y-2">
                <label className="text-xs font-bold text-cyan-500 uppercase tracking-widest">
                  Python for Computer Use
                </label>
                <input
                  type="text"
                  value={settings.pythonPathOverride ?? ''}
                  onChange={(e) => setSettings({ ...settings, pythonPathOverride: e.target.value })}
                  placeholder="Auto — e.g. C:\Users\you\AppData\Local\Programs\Python\Python312\python.exe"
                  className="w-full bg-cyan-950/20 border border-cyan-500/30 rounded px-3 py-2 text-cyan-100 focus:outline-none focus:border-cyan-400 font-mono text-xs"
                />
                <p className="text-[10px] text-cyan-700">
                  Forces <span className="text-cyan-500">computer_use.py</span> to run with this interpreter. Overrides the bundled
                  helper binary if set (useful for debugging). Leave empty when the bundled <span className="text-cyan-500">.exe</span> works.
                </p>
              </div>

              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => void runDiagnostics()}
                  disabled={diagLoading}
                  className="px-4 py-2 text-xs font-bold uppercase tracking-widest rounded border border-cyan-500/50 bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/20 disabled:opacity-50"
                >
                  {diagLoading ? 'Running…' : 'Run system diagnostics'}
                </button>
                {diagError && (
                  <p className="text-xs text-red-400 font-mono">{diagError}</p>
                )}
                {diagOutput && (
                  <pre className="text-[10px] leading-snug text-cyan-200/90 bg-black/50 border border-cyan-500/20 rounded p-3 overflow-x-auto max-h-64 overflow-y-auto font-mono whitespace-pre">
                    {diagOutput}
                  </pre>
                )}
              </div>
            </div>
          )}

          {/* UI Tab */}
          {activeTab === 'ui' && (
            <div className="space-y-7">

              {/* Theme */}
              <div className="space-y-3">
                <label className="text-xs font-bold text-cyan-500 uppercase tracking-widest">Theme</label>
                <div className="grid grid-cols-2 gap-3">
                  {THEMES.map((theme) => {
                    const active = settings.theme === theme.id;
                    return (
                      <button
                        key={theme.id}
                        onClick={() => { sfx('select', 0.5); setSettings({ ...settings, theme: theme.id }); }}
                        className={`relative flex items-center gap-3 px-4 py-3 rounded border transition-all text-left ${
                          active
                            ? 'border-white/30 bg-white/5'
                            : 'border-white/10 bg-transparent hover:border-white/20'
                        }`}
                        style={active ? { boxShadow: `0 0 12px ${theme.glow}` } : {}}
                      >
                        {/* Color swatch */}
                        <div
                          className="w-4 h-4 rounded-full flex-shrink-0"
                          style={{
                            backgroundColor: theme.accent,
                            boxShadow: `0 0 8px ${theme.glow}`,
                          }}
                        />
                        <span className={`text-sm font-semibold tracking-wide ${active ? 'text-white' : 'text-white/50'}`}>
                          {theme.name}
                        </span>
                        {active && (
                          <span className="absolute top-1.5 right-2 text-[10px] text-white/40 font-mono uppercase">
                            Active
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Grid */}
              <div className="space-y-3">
                <label className="text-xs font-bold text-cyan-500 uppercase tracking-widest">Background Grid</label>
                <div className="grid grid-cols-4 gap-2">
                  {GRID_OPTIONS.map((opt) => {
                    const active = settings.grid === opt.id;
                    return (
                      <button
                        key={opt.id}
                        onClick={() => { sfx('click_sfx', 0.4); setSettings({ ...settings, grid: opt.id }); }}
                        className={`px-3 py-2 border rounded text-xs uppercase tracking-wide transition-all ${
                          active
                            ? 'bg-cyan-500/20 border-cyan-400 text-cyan-300'
                            : 'bg-transparent border-cyan-500/20 text-cyan-600 hover:border-cyan-500/50 hover:text-cyan-400'
                        }`}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </div>

            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-cyan-500/30 bg-cyan-950/30 flex justify-end gap-3">
          <button
            onClick={() => { sfx('click', 0.5); onClose(); }}
            className="px-4 py-2 text-sm text-cyan-500 hover:text-cyan-300 transition-colors uppercase tracking-wider"
          >
            Cancel
          </button>
          <button
            onClick={() => { sfx('select_confirm', 0.6); onSave(settings); }}
            className="px-6 py-2 bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/50 rounded text-cyan-300 uppercase tracking-wider font-bold shadow-[0_0_15px_rgba(34,211,238,0.1)] hover:shadow-[0_0_20px_rgba(34,211,238,0.3)] transition-all"
          >
            Save Configuration
          </button>
        </div>
      </motion.div>
    </div>
  );
}
