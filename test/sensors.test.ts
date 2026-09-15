import assert from 'node:assert/strict';
import test from 'node:test';

const session = { userId: 'user', loginSession: 'session', familyId: 'family' };
const hub = { endpointId: 'hub', productId: 'product', mac: 'aabbccddeeff', devicetypeFlag: 0,
  cookie: Buffer.from(JSON.stringify({ terminalid: 42, aeskey: 'synthetic-key' })).toString('base64') };
const data = Buffer.from('240000001b0d2e4d0500000000000000', 'hex').toString('base64');
const ack = (id: string) => ({ event: { header: { namespace: 'DNA.TransmissionControl', name: 'Response', interfaceVersion: '2', messageId: id }, endpoint: { endpointId: 'hub' }, payload: { data } } });
async function implementation() {
  const module = await import('../src/sensors.ts').catch(() => null);
  assert.ok(module?.BroadlinkCloudSensors, 'sensor implementation is missing');
  return module;
}

test('sensor read emits only read command and returns measured precision and local timestamp', async () => {
  const { BroadlinkCloudSensors } = await implementation();
  let calls = 0;
  const before = Date.now();
  const result = await new BroadlinkCloudSensors(session, { fetch: async (input, init) => {
    calls++;
    const request = new Request(input, init);
    assert.equal(request.method, 'POST'); assert.equal(request.redirect, 'error');
    assert.equal(new URL(request.url).pathname, '/device/control/v2/sdkcontrol');
    for (const [name, value] of Object.entries({ userid: 'user', loginsession: 'session', familyid: 'family', licenseid: '5eda600025ae5057181daaa2124f79b7', lid: '5eda600025ae5057181daaa2124f79b7' })) assert.equal(request.headers.get(name), value);
    const body = await request.json();
    assert.deepEqual(body.directive.payload, { data: 'JAAAAA==', notpadding: 0 });
    const device = JSON.parse(Buffer.from(body.directive.endpoint.devicePairedInfo.cookie, 'base64').toString()).device;
    assert.deepEqual(device, { id: 42, key: 'synthetic-key', aeskey: 'synthetic-key', did: 'hub', pid: 'product', mac: 'aabbccddeeff' });
    return Response.json(ack(body.directive.header.messageId));
  } }).read(hub);
  assert.equal(calls, 1); assert.equal(result.temperature, 27.13); assert.equal(result.humidity, 46.77);
  assert.ok(result.observedAt >= before && result.observedAt <= Date.now());
});

test('sensor parser handles signed temperature and refuses invalid or unavailable payloads', async () => {
  const { parseSensorPayload } = await implementation();
  const negative = Buffer.from(data, 'base64'); negative.writeInt8(-5, 4); negative.writeInt8(-25, 5);
  assert.deepEqual(parseSensorPayload(negative.toString('base64')), { temperature: -5.25, humidity: 46.77 });
  const invalid: unknown[] = [null, 42, '', 'secret', data + '\n', data.slice(0, -2), Buffer.alloc(16).toString('base64')];
  for (const [index, value] of [[0, 2], [5, 100], [5, 156], [6, 101], [7, 100], [4, 101], [4, 215]] as const) {
    const bytes = Buffer.from(data, 'base64'); bytes[index] = value; invalid.push(bytes.toString('base64'));
  }
  const zero = Buffer.from(data, 'base64'); zero.fill(0, 4, 8); invalid.push(zero.toString('base64'));
  invalid.push(Buffer.from(data, 'base64').subarray(0, 8).toString('base64'));
  invalid.push(Buffer.concat([Buffer.from(data, 'base64'), Buffer.alloc(1)]).toString('base64'));
  for (const value of invalid) assert.throws(() => parseSensorPayload(value), /Invalid|unavailable/);
});

test('sensor read rejects mismatched response, sanitizes upstream errors and never retries', async () => {
  const { BroadlinkCloudSensors } = await implementation();
  for (const mutate of [
    (a: any) => { a.event.header.namespace = 'wrong'; }, (a: any) => { a.event.header.name = 'ErrorResponse'; },
    (a: any) => { a.event.header.interfaceVersion = '1'; }, (a: any) => { a.event.header.messageId = 'wrong'; },
    (a: any) => { a.event.endpoint.endpointId = 'other'; }, (a: any) => { a.event.payload.data = 'SECRET'; },
    (a: any) => { delete a.event; },
  ]) {
    let calls = 0;
    const sensors = new BroadlinkCloudSensors(session, { fetch: async (input, init) => {
      calls++; const body = await new Request(input, init).json(); const response = ack(body.directive.header.messageId); mutate(response); return Response.json(response);
    } });
    await assert.rejects(sensors.read(hub), { message: 'Cloud sensor request failed' }); assert.equal(calls, 1);
  }
  for (const fetch of [async () => { throw Error('SECRET'); }, async () => new Response('SECRET', { status: 500 }), async () => new Response('SECRET')]) {
    await assert.rejects(new BroadlinkCloudSensors(session, { fetch }).read(hub), { message: 'Cloud sensor request failed' });
  }
});

test('sensor validation blocks malformed credentials before transport', async () => {
  const { BroadlinkCloudSensors } = await implementation();
  for (const timeoutMs of [0, -1, 60001, NaN, 1.5]) assert.throws(() => new BroadlinkCloudSensors(session, { timeoutMs }));
  assert.throws(() => new BroadlinkCloudSensors({ ...session, loginSession: '' }));
  let calls = 0;
  const sensors = new BroadlinkCloudSensors(session, { fetch: async () => { calls++; throw Error('SECRET'); } });
  for (const bad of [{ ...hub, cookie: 'SECRET' }, { ...hub, cookie: Buffer.from('{}').toString('base64') }, { ...hub, endpointId: '' }, { ...hub, productId: '' }, { ...hub, mac: '' }, { ...hub, devicetypeFlag: -1 }]) await assert.rejects(sensors.read(bad), /Invalid/);
  assert.equal(calls, 0);
});

test('sensor deadline covers transport and body stalls and aborts without retry', async () => {
  const { BroadlinkCloudSensors } = await implementation();
  for (const bodyStalls of [false, true]) {
    let calls = 0; let signal: AbortSignal | null | undefined;
    const sensors = new BroadlinkCloudSensors(session, { timeoutMs: 15, fetch: async (_input, init) => {
      calls++; signal = init?.signal;
      return bodyStalls ? new Response(new ReadableStream({ start() {} })) : new Promise<Response>(() => {});
    } });
    await assert.rejects(sensors.read(hub), { message: 'Cloud sensor request timed out' });
    assert.equal(calls, 1); assert.equal(signal?.aborted, true);
  }
});
