export interface CloudSession { userId: string; loginSession: string; familyId: string }
export interface ClientOptions { fetch?: typeof globalThis.fetch; timeoutMs?: number }
export type Endpoint = Record<string, unknown> & { endpointId: string };
export type RemoteCommand = Record<string, unknown> & { codeList: Array<Record<string, unknown> & { code: string }> };
export type Remote = Record<string, unknown> & {
  endpointId: string; irData: RemoteCommand[]; ircodeDesc: string;
  description: Record<string, unknown>; channelList: unknown[] | null;
};

const HOST = 'https://app-service-deu-6dc239d5.ibroadlink.com';
const LICENSE = '5eda600025ae5057181daaa2124f79b7';
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(value);
const malformed = () => new Error('Invalid cloud response');

export class BroadlinkCloudClient {
  #session: CloudSession;
  #fetch: typeof globalThis.fetch;
  #timeoutMs: number;

  constructor(session: CloudSession, options: ClientOptions = {}) {
    if (!session || !identifier(session.userId) || !identifier(session.loginSession) || !identifier(session.familyId)) {
      throw new Error('Invalid cloud session');
    }
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('Invalid request timeout');
    this.#timeoutMs = timeoutMs;
    this.#session = { ...session };
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async listDevices(): Promise<Endpoint[]> {
    const data = await this.#request('/appsync/group/dev/query?action=select', { pids: [] });
    if (!Array.isArray(data.endpoints) || !data.endpoints.every(item => record(item) && identifier(item.endpointId))) throw malformed();
    return data.endpoints as Endpoint[];
  }

  async getRemote(endpointId: string): Promise<Remote> {
    if (!identifier(endpointId)) throw new Error('Invalid endpoint ID');
    const data = await this.#request('/appsync/group/ircode/query', { endpointId });
    if (data.endpointId !== endpointId || typeof data.ircodeDesc !== 'string' ||
        !(data.channelList === null || Array.isArray(data.channelList)) ||
        !(data.irData === null || (Array.isArray(data.irData) && data.irData.every(command =>
          record(command) && Array.isArray(command.codeList) && command.codeList.every(code => record(code) && identifier(code.code)))))) {
      throw malformed();
    }
    let description: unknown;
    try { description = JSON.parse(data.ircodeDesc); } catch { throw malformed(); }
    if (!record(description)) throw malformed();
    return { ...data, endpointId, irData: (data.irData ?? []) as RemoteCommand[], ircodeDesc: data.ircodeDesc, description, channelList: data.channelList as unknown[] | null };
  }

  async #request(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('Cloud request timed out')); }, this.#timeoutMs);
    });
    const operation = async (): Promise<Record<string, unknown>> => {
      const response = await this.#fetch(HOST + path, {
        method: 'POST', redirect: 'error',
        signal: controller.signal,
        headers: {
          userid: this.#session.userId, loginsession: this.#session.loginSession,
          familyid: this.#session.familyId, licenseid: LICENSE, lid: LICENSE,
          appVersion: '1.8.33.1a7fbc2ce', language: 'en-us', 'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error('Cloud HTTP request failed');
      const payload: unknown = await response.json();
      if (!record(payload) || payload.status !== 0 || !record(payload.data)) throw malformed();
      return payload.data;
    };
    try {
      return await Promise.race([operation(), deadline]);
    } catch {
      // Deliberately exclude upstream text, payloads and error causes (which may contain credentials).
      throw new Error(controller.signal.aborted ? 'Cloud request timed out' : 'Cloud request failed');
    } finally {
      clearTimeout(timer);
    }
  }
}
