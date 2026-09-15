import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const entry = pathToFileURL(require.resolve('homebridge'));
const publicRuntime = await import(entry.href);
// Homebridge 1 and 2 keep api.js beside their entry point, but v2 no longer
// exports the package subpath. Resolve from the installed entry, not a layout
// guessed from the project directory. Missing modules must fail the tests.
export const HomebridgeAPI = publicRuntime.HomebridgeAPI
  ?? (await import(new URL('./api.js', entry).href)).HomebridgeAPI;
const api = new HomebridgeAPI();
// Obtain the exact HAP implementation used by this Homebridge version (v2
// renamed its dependency); never load a second or mismatched HAP installation.
export const hap = api.hap;
export const PlatformAccessory = api.platformAccessory;
