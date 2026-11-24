import { attr } from '../core/status.js';

export function laundryState(kind, { status, online }) {
  const machineState = attr(status, 'main', `${kind}OperatingState`, 'machineState') ?? null;
  if (!online) {
    return { machineState, running: false, paused: false, remoteEnabled: false };
  }
  const remote = attr(status, 'main', 'remoteControlStatus', 'remoteControlEnabled');
  return {
    machineState,
    running: machineState === 'run',
    paused: machineState === 'pause',
    remoteEnabled: remote === 'true' || remote === true,
  };
}

export function laundryCommand(kind, action) {
  return [
    {
      component: 'main',
      capability: `${kind}OperatingState`,
      command: 'setMachineState',
      arguments: [action === 'start' ? 'run' : 'pause'],
    },
  ];
}

export class FinishTracker {
  constructor({ holdMs = 30 * 60 * 1000, now = Date.now } = {}) {
    this.holdMs = holdMs;
    this.now = now;
    this.seenRunning = false;
    this.falseCount = 0;
    this.finishedAt = null;
  }

  update(running) {
    if (running) {
      this.seenRunning = true;
      this.falseCount = 0;
      this.finishedAt = null;
      return false;
    }
    if (this.finishedAt !== null) {
      if (this.now() - this.finishedAt >= this.holdMs) {
        // Hold expired: this cycle is consumed until running is seen again.
        this.finishedAt = null;
        this.seenRunning = false;
        this.falseCount = 0;
        return false;
      }
      return true;
    }
    if (!this.seenRunning) return false;
    this.falseCount += 1;
    if (this.falseCount >= 2) {
      this.finishedAt = this.now();
      return true;
    }
    return false;
  }
}
