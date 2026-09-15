import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BroadlinkCloudClient } from '../src/client.ts';

const session = { userId: 'test-user', loginSession: 'test-session', familyId: 'test-family' };
const profile = { endpointId: 'remote-1', familyid: 'test-family', userid: 'test-user', irData: null, ircodeDesc: '{"profile":"ac","opaque":42}', channelList: null };
const fixtureClient = (payload: unknown) => new BroadlinkCloudClient(session, { fetch: async () => Response.json(payload) });

test('known account-session statuses produce a typed sanitized expiry error', async () => {
  for (const status of [-1012, -1009, -1000, 10011, -30129]) {
    await assert.rejects(fixtureClient({ status, msg: 'PRIVATE credentials' }).listDevices(), error => {
      assert.equal((error as Error).constructor.name, 'CloudSessionExpiredError');
      assert.ok(!(error as Error).message.includes('PRIVATE'));
      return true;
    });
  }
});
test('HTTP, network, malformed and unrelated cloud errors are never session expiry', async () => {
  const clients = [
    fixtureClient({ status: -1 }), fixtureClient({ status: '-1012' }), fixtureClient({ status: 0, data: null }),
    new BroadlinkCloudClient(session, { fetch: async () => new Response('PRIVATE', { status: 401 }) }),
    new BroadlinkCloudClient(session, { fetch: async () => { throw Error('PRIVATE'); } }),
  ];
  for (const client of clients) await assert.rejects(client.listDevices(), error => {
    assert.notEqual((error as Error).constructor.name, 'CloudSessionExpiredError');
    assert.ok(!(error as Error).message.includes('PRIVATE')); return true;
  });
});

test('discovery emits the verified EU request and preserves endpoint extensions', async () => {
  const module = await import('../src/client.ts').catch(() => null);
  assert.ok(module?.BroadlinkCloudClient, 'client implementation is missing');
  const requests: Request[] = [];
  const client = new module.BroadlinkCloudClient({ userId: 'test-user', loginSession: 'test-session', familyId: 'test-family' }, {
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json({ status: 0, msg: 'ok', data: { endpoints: [{ endpointId: 'remote-1', friendlyName: 'Fan', cookie: 'opaque', futureField: { retained: true } }] } });
    },
  });
  assert.deepEqual(await client.listDevices(), [{ endpointId: 'remote-1', friendlyName: 'Fan', cookie: 'opaque', futureField: { retained: true } }]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://app-service-deu-6dc239d5.ibroadlink.com/appsync/group/dev/query?action=select');
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].redirect, 'error');
  assert.deepEqual(await requests[0].json(), { pids: [] });
  for (const [key, value] of Object.entries({ userid: 'test-user', loginsession: 'test-session', familyid: 'test-family', licenseid: '5eda600025ae5057181daaa2124f79b7', lid: '5eda600025ae5057181daaa2124f79b7', appVersion: '1.8.33.1a7fbc2ce', language: 'en-us', 'content-type': 'application/json' })) {
    assert.equal(requests[0].headers.get(key), value);
  }
});

test('remote lookup sends endpoint ID and normalizes a null AC command list', async () => {
  let request: Request | undefined;
  const client = new BroadlinkCloudClient(session, { fetch: async (input, init) => {
    request = new Request(input, init);
    return Response.json({ status: 0, data: { ...profile, futureField: 'keep' } });
  } });
  const result = await client.getRemote('remote-1');
  assert.equal(request!.url, 'https://app-service-deu-6dc239d5.ibroadlink.com/appsync/group/ircode/query');
  assert.deepEqual(await request!.json(), { endpointId: 'remote-1' });
  assert.deepEqual(result.irData, []);
  assert.deepEqual(result.description, { profile: 'ac', opaque: 42 });
  assert.equal(result.ircodeDesc, profile.ircodeDesc);
  assert.equal(result.futureField, 'keep');
  assert.equal(result.channelList, null);
});

test('remote lookup retains every code and unknown command field', async () => {
  const commands = [{ function: 'power', extend: 'opaque', type: 'rf', icon: 1, name: 'Power', orderIndex: 0, codeList: [{ code: 'code-one', future: 1 }, { code: 'code-two' }], futureField: true }];
  const result = await fixtureClient({ status: 0, data: { ...profile, irData: commands, channelList: [{ unknown: true }] } }).getRemote('remote-1');
  assert.deepEqual(result.irData, commands);
  assert.deepEqual(result.channelList, [{ unknown: true }]);
});

test('invalid session fields and unbounded timeouts are rejected before requests', () => {
  for (const key of ['userId', 'loginSession', 'familyId']) {
    for (const invalid of ['', ' ', null, 42, 'bad\r\nvalue']) {
      assert.throws(() => new BroadlinkCloudClient({ ...session, [key]: invalid } as never), /Invalid/);
    }
  }
  for (const timeoutMs of [0, -1, Infinity, NaN, 60_001, 1.5]) {
    assert.throws(() => new BroadlinkCloudClient(session, { timeoutMs }), /Invalid/);
  }
});

test('blank remote IDs are rejected without sending requests', async () => {
  const client = new BroadlinkCloudClient(session, { fetch: async () => { assert.fail('must not fetch'); } });
  for (const id of ['', ' ', null, 42]) await assert.rejects(client.getRemote(id as never), /Invalid/);
});

test('malformed envelopes and endpoint shapes are rejected with sanitized errors', async () => {
  for (const payload of [null, [], { status: 9, msg: 'test-session raw-payload' }, { data: { endpoints: [] } }, { status: '0', data: {} }, { status: 0, data: null }, { status: 0, data: { endpoints: null } }, { status: 0, data: { endpoints: [{}] } }, { status: 0, data: { endpoints: [null] } }]) {
    await assert.rejects(fixtureClient(payload).listDevices(), (error: Error) => {
      assert.doesNotMatch(String(error), /test-session|raw-payload/);
      return true;
    });
  }
});

test('malformed remote data is rejected rather than silently dropping commands', async () => {
  for (const changes of [{ ircodeDesc: '{raw-payload' }, { ircodeDesc: '[]' }, { ircodeDesc: 'null' }, { ircodeDesc: {} }, { irData: {} }, { irData: [null] }, { irData: [{ codeList: null }] }, { irData: [{ codeList: [{}] }] }, { channelList: {} }, { endpointId: '' }, { endpointId: 'different-remote' }]) {
    await assert.rejects(fixtureClient({ status: 0, data: { ...profile, ...changes } }).getRemote('remote-1'), (error: Error) => {
      assert.doesNotMatch(String(error), /raw-payload/);
      return true;
    });
  }
});

test('HTTP, invalid JSON and network failures are sanitized and never retried', async () => {
  for (const respond of [() => new Response('test-session raw-payload', { status: 503 }), () => new Response('test-session raw-payload'), () => { throw new Error('test-session raw-payload'); }]) {
    let calls = 0;
    const client = new BroadlinkCloudClient(session, { fetch: async () => { calls++; return respond(); } });
    await assert.rejects(client.listDevices(), (error: Error) => {
      assert.doesNotMatch(String(error), /test-session|raw-payload/);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('timeout bounds a fetch that ignores cancellation and aborts its signal', { timeout: 1000 }, async () => {
  let signal: AbortSignal | null | undefined;
  let calls = 0;
  const client = new BroadlinkCloudClient(session, { timeoutMs: 20, fetch: async (_input, init) => {
    calls++;
    signal = init?.signal;
    return new Promise<Response>(() => {});
  } });
  await assert.rejects(client.listDevices(), /timed out/i);
  assert.equal(signal?.aborted, true);
  assert.equal(calls, 1);
});
