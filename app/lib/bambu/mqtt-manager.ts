/**
 * Bambu Lab Cloud MQTT manager — module-level singleton so the connection
 * persists across hot-reloads in Next.js dev and across route invocations.
 */

const BAMBU_API = 'https://api.bambulab.com';

export interface BambuToken {
  accessToken: string;
  refreshToken: string;
  tokenExpiration: number;
}

export interface PrinterInfo {
  deviceId: string;
  name: string;
  model?: string;
}

// ── Global module-level state ─────────────────────────────────────────────────

const g = globalThis as typeof globalThis & {
  _bambuToken?: BambuToken | null;
  _bambuPrinters?: PrinterInfo[];
  _bambuTelemetry?: Record<string, Record<string, unknown>>;
  _bambuMqttConnected?: boolean;
  _bambuMqttClient?: import('mqtt').MqttClient | null;
};

g._bambuToken        ??= null;
g._bambuPrinters     ??= [];
g._bambuTelemetry    ??= {};
g._bambuMqttConnected ??= false;
g._bambuMqttClient   ??= null;

export const getToken   = (): BambuToken | null     => g._bambuToken ?? null;
export const getPrinters = (): PrinterInfo[]         => g._bambuPrinters ?? [];
export const getTelemetry = (): Record<string, Record<string, unknown>> => g._bambuTelemetry ?? {};
export const isMqttConnected = (): boolean           => g._bambuMqttConnected ?? false;

export function setToken(t: BambuToken | null) { g._bambuToken = t; }

export function isTokenValid(): boolean {
  return !!(g._bambuToken?.accessToken && (g._bambuToken.tokenExpiration ?? 0) > Date.now());
}

// ── Cloud MQTT ────────────────────────────────────────────────────────────────

export async function connectMqtt(token: BambuToken): Promise<void> {
  if (g._bambuMqttConnected && g._bambuMqttClient?.connected) return;

  // Fetch bound printers
  const bindRes = await fetch(`${BAMBU_API}/v1/iot-service/api/user/bind`, {
    headers: { Authorization: `Bearer ${token.accessToken}`, Accept: 'application/json' },
  });
  if (!bindRes.ok) throw new Error(`Bind failed: ${bindRes.status}`);
  const bindData = await bindRes.json() as { devices?: Array<{ dev_id: string; name: string; dev_product_name?: string }> };
  const printers: PrinterInfo[] = (bindData.devices ?? []).map((d) => ({
    deviceId: d.dev_id,
    name: d.name,
    model: d.dev_product_name,
  }));
  g._bambuPrinters = printers;

  if (!printers.length) return;

  // Resolve username from preferences
  let username = '';
  try {
    const prefRes = await fetch(`${BAMBU_API}/v1/design-user-service/my/preference`, {
      headers: { Authorization: `Bearer ${token.accessToken}` },
    });
    if (prefRes.ok) {
      const pref = await prefRes.json() as { uid?: string | number };
      if (pref.uid) username = `u_${pref.uid}`;
    }
  } catch {}
  if (!username) username = `u_${Math.random().toString(16).slice(2)}`;

  // Dynamic import to avoid bundler issues
  const mqtt = await import('mqtt');
  const brokerUrl = 'mqtts://us.mqtt.bambulab.com:8883';
  const client = mqtt.connect(brokerUrl, {
    clientId: username,
    username,
    password: token.accessToken,
    clean: true,
    reconnectPeriod: 5000,
    protocol: 'mqtts',
  });

  client.on('connect', () => {
    g._bambuMqttConnected = true;
    printers.forEach(({ deviceId }) => {
      client.subscribe(`device/${deviceId}/report`, () => {
        const seq = Date.now().toString();
        client.publish(`device/${deviceId}/request`, JSON.stringify({
          pushing: { sequence_id: seq, command: 'pushall', version: 1, push_target: 1 },
        }));
      });
    });
  });

  client.on('message', (topic: string, buf: Buffer) => {
    try {
      const msg = JSON.parse(buf.toString()) as Record<string, unknown>;
      const id = topic.split('/')[1];
      const update = (msg.print ?? msg) as Record<string, unknown>;
      g._bambuTelemetry![id] = Object.assign({}, g._bambuTelemetry![id] ?? {}, update);
    } catch {}
  });

  client.on('error', (err: Error) => console.error('[Bambu MQTT]', err.message));
  client.on('close', () => { g._bambuMqttConnected = false; });

  g._bambuMqttClient = client;
}

export function sendCommand(deviceId: string, command: 'pause' | 'resume' | 'stop'): boolean {
  const client = g._bambuMqttClient;
  if (!client?.connected) return false;
  const seq = Date.now().toString();
  client.publish(`device/${deviceId}/request`, JSON.stringify({
    print: { sequence_id: seq, command, param: '' },
  }), { qos: 1 });
  return true;
}

export async function fetchPrintersRest(token: BambuToken): Promise<PrinterInfo[]> {
  const res = await fetch(`${BAMBU_API}/v1/iot-service/api/user/bind`, {
    headers: { Authorization: `Bearer ${token.accessToken}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`${res.status}`);
  const data = await res.json() as { devices?: Array<{ dev_id: string; name: string; dev_product_name?: string }> };
  return (data.devices ?? []).map((d) => ({ deviceId: d.dev_id, name: d.name, model: d.dev_product_name }));
}
