import assert from 'node:assert/strict';
import { test } from 'node:test';

const session = { userId: 'test-user', loginSession: 'test-session', familyId: 'test-family' };
const hub = { endpointId: 'hub-did', productId: 'hub-pid', mac: 'aa:bb:cc:dd:ee:ff', devicetypeFlag: 0,
  cookie: Buffer.from('{"terminalid":42,"aeskey":"synthetic-key","password":"unused"}').toString('base64') };
const ack = (id: string) => ({ event: { header: { namespace: 'DNA.TransmissionControl', name: 'Response', interfaceVersion: '2', messageId: id }, endpoint: { scope: {}, endpointId: 'hub-did' }, payload: { data: 'AgAAAAAAAAAAAAAAAAAAAA==' } } });
async function implementation() {
  const module = await import('../src/control.ts').catch(() => null);
  assert.ok(module?.BroadlinkCloudControl, 'control implementation is missing');
  return module.BroadlinkCloudControl;
}

test('sends saved code once in the captured hub envelope, deriving the paired cookie from inventory', async () => {
  const Control = await implementation();
  let request: Request | undefined;
  let calls = 0;
  const control = new Control(session, { fetch: async (input, init) => {
    calls++;
    request = new Request(input, init);
    const body = await request.clone().json();
    return Response.json(ack(body.directive.header.messageId));
  } });
  const before = Math.floor(Date.now() / 1000);
  await control.sendCode(hub, 'B2C00102');
  assert.equal(calls, 1);
  assert.equal(request!.method, 'POST');
  assert.equal(request!.redirect, 'error');
  const url = new URL(request!.url);
  assert.equal(url.origin, 'https://app-service-deu-6dc239d5.ibroadlink.com');
  assert.equal(url.pathname, '/device/control/v2/sdkcontrol');
  assert.equal(url.search.slice('?license='.length), 'XtpgACWuUFcYHaqiEk95t2wiEUaVgDbdm0MtQp5owJTWQbqjHLP46QRO/uZNfe0oclcgXAAAAAAygcbadDq9A72sMSyv3i+zUDfIrMkRKPdWOeDfqdEWwCTBt6/f7KAScKhmP5XJhzUJgVPNWb8gShFuD8z4NFgAsEkbxXTfoUSQjDzWcfVjcAAAAAA=');
  for (const [key, value] of Object.entries({ userid: 'test-user', loginsession: 'test-session', familyid: 'test-family', licenseid: '5eda600025ae5057181daaa2124f79b7', lid: '5eda600025ae5057181daaa2124f79b7', appVersion: '1.8.33.1a7fbc2ce', language: 'en-us', 'content-type': 'application/json' })) assert.equal(request!.headers.get(key), value);
  const body = await request!.json();
  const seconds = body.directive.header.timstamp;
  assert.equal(typeof seconds, 'string');
  assert.ok(Number(seconds) >= before && Number(seconds) <= Math.floor(Date.now() / 1000));
  assert.deepEqual(body, { directive: {
    header: { namespace: 'DNA.TransmissionControl', name: 'commonControl', interfaceVersion: '2', messageId: `hub-did-${seconds}`, timstamp: seconds },
    endpoint: { devicePairedInfo: { did: 'hub-did', pid: 'hub-pid', mac: 'aa:bb:cc:dd:ee:ff', devicetypeflag: 0,
      cookie: Buffer.from('{"device":{"id":42,"key":"synthetic-key","aeskey":"synthetic-key","did":"hub-did","pid":"hub-pid","mac":"aa:bb:cc:dd:ee:ff"}}').toString('base64') }, endpointId: 'hub-did', cookie: {} },
    payload: { data: 'AgAAALLAAQI=', notpadding: 0 },
  } });
});

test('rejects malformed hex and malformed hub credentials before sending', async () => {
  const Control = await implementation();
  let calls = 0;
  const control = new Control(session, { fetch: async () => { calls++; throw new Error('must not send'); } });
  for (const code of ['', 'abc', 'xx', 'aa bb', 'aabb\n', '00'.repeat(65537)]) await assert.rejects(control.sendCode(hub, code), /Invalid/);
  for (const bad of [{ ...hub, cookie: 'not-json' }, { ...hub, cookie: Buffer.from('{}').toString('base64') }, { ...hub, productId: '' }, { ...hub, mac: '' }, { ...hub, devicetypeFlag: -1 }]) await assert.rejects(control.sendCode(bad, 'abcd'), /Invalid/);
  assert.equal(calls, 0);
  for (const timeoutMs of [0, -1, Infinity, 1.5, 60001]) assert.throws(() => new Control(session, { timeoutMs }), /Invalid/);
  assert.throws(() => new Control({ ...session, loginSession: '' }), /Invalid/);
});

test('rejects wrong acknowledgments and sanitizes all transport failures without retries', async () => {
  const Control = await implementation();
  const outcomes = [null, {}, { status: 0 }, ack('wrong-message'), { event: { ...ack('id').event, payload: { data: 'AQ==' } } }];
  for (const outcome of outcomes) {
    let calls = 0;
    const control = new Control(session, { fetch: async () => { calls++; return Response.json(outcome); } });
    await assert.rejects(control.sendCode(hub, 'abcd'), { message: 'Cloud control request failed' });
    assert.equal(calls, 1);
  }
  for (const mutate of [
    (value: ReturnType<typeof ack>) => { value.event.header.namespace = 'other'; },
    (value: ReturnType<typeof ack>) => { value.event.header.name = 'ErrorResponse'; },
    (value: ReturnType<typeof ack>) => { value.event.header.interfaceVersion = '1'; },
    (value: ReturnType<typeof ack>) => { value.event.endpoint.endpointId = 'other-hub'; },
    (value: ReturnType<typeof ack>) => { value.event.payload.data = 'AQ=='; },
  ]) {
    const control = new Control(session, { fetch: async (input, init) => {
      const request = await new Request(input, init).json();
      const response = ack(request.directive.header.messageId);
      mutate(response);
      return Response.json(response);
    } });
    await assert.rejects(control.sendCode(hub, 'abcd'), { message: 'Cloud control request failed' });
  }
  for (const fetch of [async () => { throw new Error('SECRET'); }, async () => new Response('SECRET', { status: 500 }), async () => new Response('SECRET')]) {
    await assert.rejects(new Control(session, { fetch }).sendCode(hub, 'abcd'), { message: 'Cloud control request failed' });
  }
});

test('deadline covers both fetch and body reading and aborts without retrying', async () => {
  const Control = await implementation();
  for (const bodyStalls of [false, true]) {
    let signal: AbortSignal | null | undefined;
    let calls = 0;
    const control = new Control(session, { timeoutMs: 15, fetch: async (_input, init) => {
      calls++; signal = init?.signal;
      if (!bodyStalls) return new Promise<Response>(() => {});
      return new Response(new ReadableStream({ start() {} }));
    } });
    await assert.rejects(control.sendCode(hub, 'abcd'), { message: 'Cloud control request timed out' });
    assert.equal(signal?.aborted, true);
    assert.equal(calls, 1);
  }
});
