import type { Remote, RemoteCommand } from './client.ts';

export interface FanMapping {
  off: RemoteCommand;
  /** Index zero is explicitly labelled speed 1. */
  speeds: RemoteCommand[];
  /** A stateless toggle, never a known on/off state. */
  lightToggle?: RemoteCommand;
}

export function buildFanMapping(remote: Remote): FanMapping {
  const invalid = () => new Error('Invalid or ambiguous fan command mapping');
  if (!remote || !Array.isArray(remote.irData)) throw invalid();
  let off: RemoteCommand | undefined;
  let lightToggle: RemoteCommand | undefined;
  const speeds = new Map<number, RemoteCommand>();
  for (const command of remote.irData) {
    const name = typeof command?.name === 'string' ? command.name.trim().toLowerCase() : '';
    const numeric = /^\d+$/.test(name);
    // Stock function names describe the original template, not the learned action.
    if (name !== 'fanoff' && name !== 'lighton/off' && !numeric) continue;
    if (!Array.isArray(command.codeList) || command.codeList.length === 0 || command.codeList.some(entry =>
      !entry || typeof entry.code !== 'string' || !entry.code.trim() || /[\x00-\x1f\x7f]/.test(entry.code))) throw invalid();
    if (name === 'fanoff') {
      if (off) throw invalid();
      off = command;
    } else if (name === 'lighton/off') {
      if (lightToggle) throw invalid();
      lightToggle = command;
    } else {
      const speed = Number(name);
      if (!/^[1-9]\d*$/.test(name) || !Number.isSafeInteger(speed) || speeds.has(speed)) throw invalid();
      speeds.set(speed, command);
    }
  }
  const ordered = [...speeds.entries()].sort(([a], [b]) => a - b);
  if (!off || !ordered.length || ordered.some(([speed], index) => speed !== index + 1)) throw invalid();
  return { off, speeds: ordered.map(([, command]) => command), ...(lightToggle ? { lightToggle } : {}) };
}
