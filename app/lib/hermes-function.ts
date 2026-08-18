/**
 * Roughly the longest reply that's still comfortable to listen to — about
 * 20 seconds of speech. Past this, Hermes output is almost always a terminal
 * dump or a file listing, which is far better read than heard.
 */
const SPEAKABLE_LIMIT = 500;

/**
 * Trims to the last sentence boundary at or before the limit so the spoken
 * reply never stops mid-word. Falls back to a word boundary, then to a hard
 * cut, for output with no punctuation at all (command output often has none).
 */
export function trimForSpeech(text: string, limit = SPEAKABLE_LIMIT): string {
  const clean = text.trim();
  if (clean.length <= limit) return clean;

  const window = clean.slice(0, limit);
  const sentenceEnd = Math.max(
    window.lastIndexOf('. '),
    window.lastIndexOf('! '),
    window.lastIndexOf('? '),
    window.lastIndexOf('\n'),
  );
  // Only honour a sentence break if it isn't so early that we lose the answer.
  if (sentenceEnd > limit * 0.4) return window.slice(0, sentenceEnd + 1).trim();

  const wordEnd = window.lastIndexOf(' ');
  return (wordEnd > limit * 0.4 ? window.slice(0, wordEnd) : window).trim();
}

/** Opens the HUD widget holding the full text, so "on screen" is true. */
function showFullOutputOnHud(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent('jarvis:hud', { detail: { command: 'open', widget: 'hermes-bot' } }),
  );
}

export const HERMES_COMMAND_FUNCTION = {
  name: 'hermes_command',
  label: 'Hermes Command',
  description: 'Let Camille delegate a task to Hermes Agent and speak back the result',
  tool: {
    type: 'function' as const,
    name: 'hermes_command',
    description:
      'Send a task or instruction to Hermes Agent, which can use its terminal, files, browser, desktop controls, skills, and other tools. Use this whenever the user asks Camille to ask, tell, use, or control Hermes. Return Hermes\'s result to the user.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The task or instruction Hermes Agent should carry out.',
        },
      },
      required: ['command'],
    },
  },
  handler: async (args: Record<string, unknown>) => {
    const command = typeof args.command === 'string' ? args.command.trim() : '';
    if (!command) return { error: 'No Hermes command was provided.' };

    try {
      const response = await fetch('/api/hermes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command }),
      });
      const result = await response.json() as Record<string, unknown>;
      if (!response.ok) {
        return { error: typeof result.error === 'string' ? result.error : `Hermes failed (${response.status}).` };
      }

      // Long Hermes replies are usually command output. Speaking them in full
      // is unusable, so hand the agent a trimmed version plus an explicit
      // instruction about what to say, and put the whole thing on the HUD.
      // runHermesCommand returns the agent's text under `response`.
      const reply = typeof result.response === 'string' ? result.response : '';

      if (reply.length > SPEAKABLE_LIMIT) {
        showFullOutputOnHud();
        return {
          ...result,
          response: trimForSpeech(reply),
          truncated: true,
          full_length: reply.length,
          speak_instruction:
            'Read the response field aloud, then tell the user the full output is on the HUD. Do not attempt to read the rest.',
        };
      }

      return result;
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  },
};
