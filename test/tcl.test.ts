import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encodeTcl, type TclState } from '../src/tcl.ts';

// Generated offline by the actual BroadLink Android SDK from this exact profile.
const fixtures = JSON.parse(readFileSync(new URL('./tcl-fixtures.json', import.meta.url), 'utf8'));
const modes = ['auto', 'cool', 'dry', 'fan', 'heat'] as const;
const speeds = ['auto', 'low', 'medium', 'high'] as const;
for (const fixture of fixtures) {
  test(`TCL actual SDK fixture: ${fixture.name}`, () => {
    const state: TclState = { power: !!fixture.state, mode: modes[fixture.mode],
      speed: speeds[fixture.speed], swing: !!fixture.direct, temperature: fixture.temperature, key: fixture.key };
    assert.equal(encodeTcl(state), fixture.ircode);
    assert.equal(encodeTcl({...state, key: 4}), fixture.ircode);
  });
}
const valid: TclState = {power:true,mode:'cool',speed:'auto',swing:false,temperature:25,key:0};
for (const temperature of [15,31,25.5,NaN,Infinity]) {
  test(`TCL rejects invalid target ${temperature}`, () => assert.throws(() => encodeTcl({...valid,temperature})));
}
test('TCL rejects unrecognized state values', () => {
  assert.throws(() => encodeTcl({...valid,mode:'unknown' as TclState['mode']}));
  assert.throws(() => encodeTcl({...valid,speed:'unknown' as TclState['speed']}));
  assert.throws(() => encodeTcl({...valid,key:6}));
});
test('TCL rejects coerced mode and speed lookup keys',()=>{
 for(const value of [['cool'],{toString:()=> 'cool'}])assert.throws(()=>encodeTcl({...valid,mode:value as any}));
 for(const value of [['auto'],{toString:()=> 'auto'}])assert.throws(()=>encodeTcl({...valid,speed:value as any}));
});
