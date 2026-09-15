import type { ClientOptions, CloudSession, Endpoint } from './client.ts';

const HOST = 'https://app-service-deu-6dc239d5.ibroadlink.com';
const LICENSE_ID = '5eda600025ae5057181daaa2124f79b7';
// Public application license from the observed SDK request, not an account credential.
const SDK_LICENSE = 'XtpgACWuUFcYHaqiEk95t2wiEUaVgDbdm0MtQp5owJTWQbqjHLP46QRO/uZNfe0oclcgXAAAAAAygcbadDq9A72sMSyv3i+zUDfIrMkRKPdWOeDfqdEWwCTBt6/f7KAScKhmP5XJhzUJgVPNWb8gShFuD8z4NFgAsEkbxXTfoUSQjDzWcfVjcAAAAAA=';
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(value);
export interface SensorReading { temperature: number; humidity: number; observedAt: number }

/** Decode only the verified 16-byte RM MAX response. The trailing bytes are opaque. */
export function parseSensorPayload(data: unknown): Omit<SensorReading, 'observedAt'> {
  const invalid = () => new Error('Invalid or unavailable sensor response');
  if (typeof data !== 'string' || data.length !== 24 || !/^[A-Za-z0-9+/]{22}==$/.test(data)) throw invalid();
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length !== 16 || bytes.toString('base64') !== data || bytes.readUInt32LE(0) !== 0x24) throw invalid();
  // RM4 temperature whole/fraction bytes are signed; humidity bytes are unsigned.
  const temperatureFraction = bytes.readInt8(5);
  const humidityFraction = bytes[7];
  const temperature = bytes.readInt8(4) + temperatureFraction / 100;
  const humidity = bytes[6] + humidityFraction / 100;
  if (Math.abs(temperatureFraction) >= 100 || humidityFraction >= 100
      || temperature < -40 || temperature > 100 || humidity > 100
      || (temperature === 0 && humidity === 0)) throw invalid();
  return { temperature, humidity };
}

/** Read-only RM MAX temperature/humidity query; never transmits an IR/RF code. */
export class BroadlinkCloudSensors {
  #session: CloudSession;
  #fetch: typeof globalThis.fetch;
  #timeoutMs: number;

  constructor(session: CloudSession, options: ClientOptions = {}) {
    if (!session || !identifier(session.userId) || !identifier(session.loginSession) || !identifier(session.familyId)) throw new Error('Invalid cloud session');
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('Invalid request timeout');
    this.#session = { ...session }; this.#fetch = options.fetch ?? globalThis.fetch; this.#timeoutMs = timeoutMs;
  }

  async read(hub: Endpoint): Promise<SensorReading> {
    if (!hub || !identifier(hub.endpointId) || !identifier(hub.productId) || !identifier(hub.mac)
        || !Number.isInteger(hub.devicetypeFlag) || (hub.devicetypeFlag as number) < 0 || !identifier(hub.cookie)) throw new Error('Invalid hub endpoint');
    let credentials: unknown;
    try { credentials = JSON.parse(Buffer.from(hub.cookie, 'base64').toString('utf8')); } catch { throw new Error('Invalid hub cookie'); }
    if (!record(credentials) || !Number.isSafeInteger(credentials.terminalid) || (credentials.terminalid as number) < 0 || !identifier(credentials.aeskey)) throw new Error('Invalid hub cookie');
    const cookie = Buffer.from(JSON.stringify({ device: {
      id: credentials.terminalid, key: credentials.aeskey, aeskey: credentials.aeskey,
      did: hub.endpointId, pid: hub.productId, mac: hub.mac,
    } })).toString('base64');
    const seconds = String(Math.floor(Date.now() / 1000));
    const messageId = `${hub.endpointId}-${seconds}`;
    const body = { directive: {
      header: { namespace: 'DNA.TransmissionControl', name: 'commonControl', interfaceVersion: '2', messageId, timstamp: seconds },
      endpoint: { devicePairedInfo: { did: hub.endpointId, pid: hub.productId, mac: hub.mac, devicetypeflag: hub.devicetypeFlag, cookie }, endpointId: hub.endpointId, cookie: {} },
      payload: { data: 'JAAAAA==', notpadding: 0 },
    } };
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, this.#timeoutMs);
    });
    const operation = async (): Promise<SensorReading> => {
      const response = await this.#fetch(`${HOST}/device/control/v2/sdkcontrol?license=${SDK_LICENSE}`, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: {
          userid: this.#session.userId, loginsession: this.#session.loginSession, familyid: this.#session.familyId,
          licenseid: LICENSE_ID, lid: LICENSE_ID, appVersion: '1.8.33.1a7fbc2ce', language: 'en-us', 'content-type': 'application/json',
        }, body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error('http');
      const value: unknown = await response.json();
      if (!record(value) || !record(value.event)) throw new Error('response');
      const event = value.event;
      if (!record(event.header) || event.header.namespace !== 'DNA.TransmissionControl' || event.header.name !== 'Response'
          || event.header.interfaceVersion !== '2' || event.header.messageId !== messageId || !record(event.endpoint)
          || event.endpoint.endpointId !== hub.endpointId || !record(event.payload)) throw new Error('response');
      return { ...parseSensorPayload(event.payload.data), observedAt: Date.now() };
    };
    try { return await Promise.race([operation(), deadline]); }
    catch { throw new Error(controller.signal.aborted ? 'Cloud sensor request timed out' : 'Cloud sensor request failed'); }
    finally { clearTimeout(timer); }
  }
}
