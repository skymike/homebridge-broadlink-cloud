import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFanMapping } from '../src/fan-mapping.ts';
import type { Remote, RemoteCommand } from '../src/client.ts';

const command = (name: string, fn = 'unused'): RemoteCommand => ({ name, function: fn, codeList: [{ code: `fixture-${name}`, delay: 0 }] });
const remote = (irData: RemoteCommand[]): Remote => ({ endpointId: 'fixture', irData, ircodeDesc: '{}', description: {}, channelList: null });

test('uses explicit renamed buttons despite misleading stock functions and preserves all codes', () => {
  const mapping = buildFanMapping(remote([
    command('LightOn/Off', 'on'), command('3', 'timer_15'), command('Fanoff', 'off'),
    { ...command('1', 'wind_speed_increase'), codeList: [{ code: 'first', delay: 7 }, { code: 'second', delay: 9 }] },
    command('2', 'wind_speed_decrease'), command('6', 'wind_type'), command('4', 'timer_30'), command('5', 'timer_60'),
    command('1H', 'timer1'), command('Direction', 'oscillating'), command('', 'windspeed'),
  ]));
  assert.deepEqual(mapping.speeds.map(item => item.name), ['1', '2', '3', '4', '5', '6']);
  assert.deepEqual(mapping.speeds[0].codeList, [{ code: 'first', delay: 7 }, { code: 'second', delay: 9 }]);
  assert.equal(mapping.off.name, 'Fanoff');
  assert.equal(mapping.lightToggle?.name, 'LightOn/Off');
  assert.ok(!mapping.speeds.includes(mapping.lightToggle!));
});

test('rejects stock off or on without an explicit fan off label', () => {
  assert.throws(() => buildFanMapping(remote([command('Off', 'off'), command('On', 'on'), command('1')])));
});

test('requires speeds beginning at one with no gaps', () => {
  for (const labels of [[], ['2'], ['1', '3'], ['0', '1'], ['01', '1']]) {
    assert.throws(() => buildFanMapping(remote([command('Fanoff'), ...labels.map(label => command(label))])));
  }
});

test('rejects ambiguous duplicate fan off, speed or light commands', () => {
  for (const duplicate of ['Fanoff', '1', 'LightOn/Off']) {
    assert.throws(() => buildFanMapping(remote([command('Fanoff'), command('1'), command('LightOn/Off'), command(duplicate)])));
  }
});

test('light is optional and label matching tolerates casing and surrounding spaces', () => {
  const mapping = buildFanMapping(remote([command(' FANOFF '), command(' 1 ')]));
  assert.equal(mapping.speeds.length, 1);
  assert.equal(mapping.lightToggle, undefined);
});

test('rejects empty or malformed codes for each mapped action', () => {
  for (const name of ['Fanoff', '1', 'LightOn/Off']) {
    for (const codeList of [[], [{ code: '' }], [{ code: 'ok' }, { code: ' ' }]]) {
      const commands = [command('Fanoff'), command('1'), command('LightOn/Off')];
      commands.find(item => item.name === name)!.codeList = codeList;
      assert.throws(() => buildFanMapping(remote(commands)));
    }
  }
});
