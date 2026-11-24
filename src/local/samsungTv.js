import dgram from 'node:dgram';
import WebSocket from 'ws';

const UNREACHABLE = () => ({ reachable: false, powerState: null, name: null, wifiMac: null });

export async function getLocalInfo(ip, { fetchImpl = fetch, timeoutMs = 2000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`http://${ip}:8001/api/v2/`, { signal: controller.signal });
    if (!res.ok) return UNREACHABLE();
    const body = await res.json();
    const device = (body && body.device) || {};
    const raw = typeof device.PowerState === 'string' ? device.PowerState.toLowerCase() : '';
    return {
      reachable: true,
      powerState: raw === 'on' || raw === 'standby' ? raw : null,
      name: device.name ?? null,
      wifiMac: device.wifiMac ?? null,
    };
  } catch {
    return UNREACHABLE();
  } finally {
    clearTimeout(timer);
  }
}

export function buildMagicPacket(mac) {
  if (typeof mac !== 'string' || !/^([0-9a-f]{2}([:-]?)){5}[0-9a-f]{2}$/i.test(mac)) {
    throw new Error('Invalid MAC address');
  }
  const bytes = Buffer.from(mac.replace(/[:-]/g, ''), 'hex');
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(bytes)]);
}

export function broadcastAddress(ip) {
  const parts = ip.split('.');
  parts[3] = '255';
  return parts.join('.');
}
export async function sendWake(mac, ip, { dgramImpl = dgram, repeats = 3, ports = [9, 7] } = {}) {
  const packet = buildMagicPacket(mac);
  const targets = [ip, broadcastAddress(ip)];
  const socket = dgramImpl.createSocket('udp4');
  try {
    await new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(() => {
        try {
          socket.setBroadcast(true);
        } catch (err) {
          reject(err);
          return;
        }
        const sends = [];
        for (let i = 0; i < repeats; i += 1) {
          for (const port of ports) {
            for (const addr of targets) {
              sends.push(new Promise((res, rej) => {
                socket.send(packet, port, addr, (err) => (err ? rej(err) : res()));
              }));
            }
          }
        }
        Promise.all(sends).then(resolve, reject);
      });
    });
  } finally {
    try { socket.close(); } catch { /* already closed */ }
  }
}
export async function sendKey(ip, key, {
  tokenStore,
  name = 'Homebridge',
  WebSocketImpl = WebSocket,
  timeoutMs = 8000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const saved = tokenStore ? tokenStore.get(ip) : undefined;
  let url = `wss://${ip}:8002/api/v2/channels/samsung.remote.control?name=${Buffer.from(name).toString('base64')}`;
  if (saved) url += `&token=${encodeURIComponent(saved)}`;

  let ws;
  let timer;
  try {
    await new Promise((resolve, reject) => {
      let done = false;
      const finish = (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (err) reject(err); else resolve();
      };
      try {
        ws = new WebSocketImpl(url, { rejectUnauthorized: false });
      } catch {
        finish(new Error('TV did not respond'));
        return;
      }
      timer = setTimeout(() => finish(new Error('TV did not respond')), timeoutMs);
      ws.on('error', () => finish(new Error('TV did not respond')));
      ws.on('message', async (raw) => {
        if (done) return;
        let m;
        try {
          m = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (m.event === 'ms.channel.unauthorized') {
          finish(new Error('TV denied the connection'));
        } else if (m.event === 'ms.channel.connect') {
          clearTimeout(timer);
          try {
            const token = m.data && m.data.token;
            if (token && tokenStore) {
              try {
                tokenStore.set(ip, String(token));
              } catch {
                // A disk error must not stop the key being sent.
              }
            }
            ws.send(JSON.stringify({
              method: 'ms.remote.control',
              params: { Cmd: 'Click', DataOfCmd: key, Option: 'false', TypeOfRemote: 'SendRemoteKey' },
            }));
            await sleep(300);
            finish();
          } catch {
            finish(new Error('TV did not respond'));
          }
        }
      });
    });
  } finally {
    clearTimeout(timer);
    try { if (ws) ws.close(); } catch { /* ignore */ }
  }
}
export async function powerOnSequence({
  mac,
  ip,
  tokenStore,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  deps = {},
}) {
  const info = deps.getLocalInfo || getLocalInfo;
  const wake = deps.sendWake || sendWake;
  const key = deps.sendKey || sendKey;
  try {
    let state = await info(ip);
    if (state.powerState === 'on') return 'on';

    if (!state.reachable) {
      try {
        await wake(mac, ip);
      } catch {
        // keep polling anyway; the TV may already be coming up
      }
      for (let i = 0; i < 15 && !state.reachable; i += 1) {
        await sleep(2000);
        state = await info(ip);
      }
      if (!state.reachable) return 'unreachable';
      if (state.powerState === 'on') return 'on';
    }

    try {
      await key(ip, 'KEY_POWER', { tokenStore });
    } catch {
      return 'standby';
    }

    for (let i = 0; i < 8; i += 1) {
      await sleep(2000);
      state = await info(ip);
      if (state.powerState === 'on') return 'on';
    }
    return 'standby';
  } catch {
    return 'unreachable';
  }
}
