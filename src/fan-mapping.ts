import type { Remote, RemoteCommand } from './client.ts';

export interface FanMapping {
  off: RemoteCommand;
  /** Index zero is explicitly labelled speed 1. */
  speeds: RemoteCommand[];
  /** A stateless toggle, never a known on/off state. */
  lightToggle?: RemoteCommand;
}

export interface FanCommands { off: string; speeds: string[]; lightToggle?: string }
export const validCommandName = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && !/[\x00-\x1f\x7f]/.test(value);

export function validateFanCommands(value: unknown): asserts value is FanCommands {
  const c = value as FanCommands;
  if (!c || typeof c !== 'object' || Array.isArray(c) || !validCommandName(c.off)
      || !Array.isArray(c.speeds) || !c.speeds.length || !c.speeds.every(validCommandName)
      || (c.lightToggle !== undefined && !validCommandName(c.lightToggle))) throw new Error('Invalid fan commands');
  const names = [c.off, ...c.speeds, ...(c.lightToggle === undefined ? [] : [c.lightToggle])];
  if (new Set(names).size !== names.length) throw new Error('Duplicate fan command selectors');
}

/** Exact names only; ambiguous names and sequences cannot safely select one action. */
export function selectCommand(remote: Remote, name: string): RemoteCommand {
  if (!validCommandName(name) || !Array.isArray(remote?.irData)) throw new Error('Invalid command selector');
  const matches = remote.irData.filter(c => c?.name === name);
  const command = matches[0];
  if (matches.length !== 1 || !Array.isArray(command.codeList) || command.codeList.length !== 1
      || !validCommandName(command.codeList[0]?.code)) throw new Error('Invalid or ambiguous command');
  return command;
}

export function buildFanMapping(remote: Remote, commands?: FanCommands): FanMapping {
  if (commands !== undefined) {
    validateFanCommands(commands);
    return { off: selectCommand(remote, commands.off), speeds: commands.speeds.map(name => selectCommand(remote, name)),
      ...(commands.lightToggle === undefined ? {} : { lightToggle: selectCommand(remote, commands.lightToggle) }) };
  }
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
