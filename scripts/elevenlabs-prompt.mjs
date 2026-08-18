export const VOICE_BEHAVIOR_HEADING = '# Voice behavior';

export const VOICE_BEHAVIOR_SECTION = `${VOICE_BEHAVIOR_HEADING}
- Keep spoken responses brief: one sentence by default, and only add detail when the user asks for it.
- Never re-engage the user because of silence. Silence means wait and listen quietly.
- Do not ask "what next?", "anything else?", or similar follow-up questions after completing a request.
- If the input is an acknowledgement with no request, or appears to describe ambient sounds, music, chimes, coughing, or background speech, call \`skip_turn\` and do not speak.
- Ask a question only when missing information genuinely prevents you from carrying out the request.
- After reporting a tool result or completed action once, stop speaking and listen.`;

export const QUIET_BUILT_IN_TOOLS = {
  skip_turn: {
    type: 'system',
    name: 'skip_turn',
    description:
      'Use when there is no actionable request, including silence, acknowledgements, ambient sounds, music, chimes, coughing, or background speech. Skip the turn without speaking.',
    params: { system_tool_type: 'skip_turn' },
  },
};

export const QUIET_TURN_CONFIG = {
  turn_model: 'turn_v3',
  turn_eagerness: 'patient',
  turn_timeout: -1,
  silence_end_call_timeout: -1,
  speculative_turn: false,
  retranscribe_on_turn_timeout: false,
  soft_timeout_config: {
    timeout_seconds: -1,
    message: 'One moment.',
    additional_soft_timeout_messages: [],
    randomize_fillers: false,
    max_soft_timeouts_per_generation: 1,
  },
};

export function withVoiceBehaviorSection(prompt) {
  if (prompt.includes(VOICE_BEHAVIOR_HEADING)) {
    return prompt.replace(
      new RegExp(`${VOICE_BEHAVIOR_HEADING}[\\s\\S]*?(?=\\n# |$)`),
      `${VOICE_BEHAVIOR_SECTION}\n`,
    );
  }
  if (prompt.includes('\n# Goal')) {
    return prompt.replace('\n# Goal', `\n${VOICE_BEHAVIOR_SECTION}\n\n# Goal`);
  }
  return `${prompt.trimEnd()}\n\n${VOICE_BEHAVIOR_SECTION}\n`;
}
