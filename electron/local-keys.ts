import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Local mode — the owner's own API keys, read once from
 * ~/.jarvis/local-keys.json. When this file exists with at least one key,
 * Camille routes AI traffic directly to the providers and never touches the
 * jarvisdesktop.com account server: no sign-in, no credits, no middleman.
 *
 * {
 *   "openrouter_api_key": "sk-or-…",   // chat brain (OpenAI-compatible)
 *   "openai_api_key": "sk-…",          // optional; enables Realtime voice + OpenAI TTS
 *   "elevenlabs_api_key": "sk_…",      // voice conversations + speech
 *   "elevenlabs_agent_id": "…",        // the owner's own ElevenLabs agent
 *   "elevenlabs_voice_id": "…"         // default voice for /tts (optional)
 * }
 */
export interface LocalKeys {
  openai_api_key?: string;
  openrouter_api_key?: string;
  elevenlabs_api_key?: string;
  elevenlabs_agent_id?: string;
  elevenlabs_voice_id?: string;
}

let cached: LocalKeys | null | undefined;

export function localKeys(): LocalKeys | null {
  if (cached !== undefined) return cached;
  try {
    const p = path.join(os.homedir(), '.jarvis', 'local-keys.json');
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8')) as LocalKeys;
    const usable = Boolean(
      parsed.openai_api_key || parsed.openrouter_api_key || parsed.elevenlabs_api_key,
    );
    cached = usable ? parsed : null;
  } catch {
    cached = null;
  }
  return cached;
}

export function localMode(): boolean {
  return localKeys() !== null;
}
