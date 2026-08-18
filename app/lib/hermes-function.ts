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
      return result;
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  },
};
