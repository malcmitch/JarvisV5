import path from 'path';
import os from 'os';

export const DYNAMIC_MCP_CONFIG_PATH = path.join(os.homedir(), '.jarvis', 'mcp-dynamic.json');
export const GOOGLE_CALENDAR_CREDENTIALS_DIR = path.join(os.homedir(), '.jarvis', 'google-calendar');
export const GOOGLE_CALENDAR_CREDENTIALS_PATH = path.join(GOOGLE_CALENDAR_CREDENTIALS_DIR, 'credentials.json');
export const GOOGLE_CALENDAR_SERVER_NAME = 'google-calendar';
export const JARVIS_DATA_DIR = path.join(os.homedir(), '.jarvis');
