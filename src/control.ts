import type { ClientOptions, CloudSession, Endpoint } from './client.ts';

const HOST = 'https://app-service-deu-6dc239d5.ibroadlink.com';
const LICENSE_ID = '5eda600025ae5057181daaa2124f79b7';
// Application license from the captured EU SDK request; not an account credential.
const SDK_LICENSE = 'XtpgACWuUFcYHaqiEk95t2wiEUaVgDbdm0MtQp5owJTWQbqjHLP46QRO/uZNfe0oclcgXAAAAAAygcbadDq9A72sMSyv3i+zUDfIrMkRKPdWOeDfqdEWwCTBt6/f7KAScKhmP5XJhzUJgVPNWb8gShFuD8z4NFgAsEkbxXTfoUSQjDzWcfVjcAAAAAA=';
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(value);

/** Sends one saved RF/IR code. An SDK acknowledgment is not physical device-state feedback. */
export class BroadlinkCloudControl {
  #session: CloudSession;
  #fetch: typeof globalThis.fetch;
  #timeoutMs: number;

  constructor(session: CloudSession, options: ClientOptions = {}) {
    if (!session || !identifier(session.userId) || !identifier(session.loginSession) || !identifier(session.familyId)) throw new Error('Invalid cloud session');
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('Invalid request timeout');
    this.#session = { ...session };
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = timeoutMs;
  }

  async sendCode(hub: Endpoint, hexCode: string): Promise<void> {
    if (typeof hexCode !== 'string' || hexCode.length === 0 || hexCode.length > 131072 || hexCode.length % 2 !== 0 || /[^a-fA-F0-9]/.test(hexCode)) throw new Error('Invalid saved code');
    if (!hub || !identifier(hub.endpointId) || !identifier(hub.productId) || !identifier(hub.mac) ||
        !Number.isInteger(hub.devicetypeFlag) || (hub.devicetypeFlag as number) < 0 || !identifier(hub.cookie)) throw new Error('Invalid hub endpoint');
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
      endpoint: {
        devicePairedInfo: { did: hub.endpointId, pid: hub.productId, mac: hub.mac, devicetypeflag: hub.devicetypeFlag, cookie },
        endpointId: hub.endpointId, cookie: {},
      },
      payload: { data: Buffer.concat([Buffer.from('02000000', 'hex'), Buffer.from(hexCode, 'hex')]).toString('base64'), notpadding: 0 },
    } };
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, this.#timeoutMs);
    });
    const operation = async (): Promise<void> => {
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
      if (!record(event.header) || event.header.namespace !== 'DNA.TransmissionControl' || event.header.name !== 'Response' ||
          event.header.interfaceVersion !== '2' || event.header.messageId !== messageId || !record(event.endpoint) || event.endpoint.endpointId !== hub.endpointId ||
          !record(event.payload) || event.payload.data !== 'AgAAAAAAAAAAAAAAAAAAAA==') throw new Error('acknowledgment');
    };
    try { await Promise.race([operation(), deadline]); }
    catch { throw new Error(controller.signal.aborted ? 'Cloud control request timed out' : 'Cloud control request failed'); }
    finally { clearTimeout(timer); }
  }
}
