/**
 * Independently implemented TCL GYKQ-03_1014 protocol encoder.
 * Protocol facts were inspected in the user's downloaded BroadLink profile;
 * quantization follows the Android SDK's queryRMACIRCodeData conversion.
 * Tests compare against offline output of that SDK, not a second local encoder.
 */
export const TCL_PROFILE_ID = '34f4b835ee8de8ed83e6dc5e7631dcebee5b0d5ed1495e5388875777f4018b31397';
export const TCL_PROFILE_SHA256 = '0d8f871e2671338257d8e71c9b6d954adf18507c59eb1a9bd321183e1a32556e';
export const TCL_MIN_TEMPERATURE = 16;
export const TCL_MAX_TEMPERATURE = 30;
export interface TclState {
  power: boolean;
  mode: 'auto' | 'cool' | 'dry' | 'fan' | 'heat';
  temperature: number;
  speed: 'auto' | 'low' | 'medium' | 'high';
  swing: boolean;
  key: number;
}
const MODE = {auto:8, cool:3, dry:2, fan:7, heat:1} as const;
const SPEED = {auto:0, low:2, medium:3, high:5} as const;

/** Returns the complete raw `irda` hex code; no transport or appliance action. */
export function encodeTcl(state: TclState): string {
  if (!Number.isInteger(state.temperature) || state.temperature < TCL_MIN_TEMPERATURE || state.temperature > TCL_MAX_TEMPERATURE) {
    throw new RangeError('TCL target temperature must be an integer from 16 to 30 Celsius');
  }
  if (typeof state.mode !== 'string' || typeof state.speed !== 'string' || !Object.hasOwn(MODE, state.mode) || !Object.hasOwn(SPEED, state.speed)
      || typeof state.power !== 'boolean' || typeof state.swing !== 'boolean'
      || !Number.isInteger(state.key) || state.key < 0 || state.key > 5) {
    throw new TypeError('Invalid TCL power, mode, speed, swing or key');
  }
  // This profile sends a complete state, regardless of which valid button key caused it.
  const message = Buffer.alloc(14);
  message.set([0x23, 0xcb, 0x26, 0x01, 0x00]);
  message[5] = state.power ? 0x24 : 0x20;
  message[6] = MODE[state.mode];
  message[7] = state.mode === 'dry' || state.mode === 'fan' ? 7 : 31 - state.temperature;
  message[8] = (state.mode === 'fan' && state.speed === 'auto' ? 3 : SPEED[state.speed]) | (state.swing ? 0x38 : 0);
  message[13] = message.subarray(0,13).reduce((sum, byte) => sum + byte, 0) & 0xff;

  const durations = [3300,1300];
  for (const byte of message) {
    for (let bit=0; bit<8; bit++) durations.push(500, byte & (1 << bit) ? 1050 : 350);
  }
  durations.push(500,20000);
  const encoded: number[] = [];
  for (const duration of durations) {
    const ticks = Math.floor((duration * 4 + 61) / 122);
    if (ticks > 255) encoded.push(0, ticks >> 8, ticks & 0xff);
    else encoded.push(ticks);
  }
  const header = Buffer.alloc(4);
  header.writeUInt16LE(38,0);
  header.writeUInt16LE(encoded.length,2);
  return Buffer.concat([header,Buffer.from(encoded)]).toString('hex');
}
