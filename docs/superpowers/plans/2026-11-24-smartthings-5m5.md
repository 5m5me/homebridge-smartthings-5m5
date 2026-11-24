# homebridge-smartthings-5m5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Homebridge plugin, separate from the stock SmartThings plugin, that puts Ned's Samsung TVs, washer, dryer, Family Hub fridge and moisture sensors into Apple Home with as much function as Apple Home can represent.

**Architecture:** A SmartThings cloud client (token provider, rate-limited requests) feeds a poller. Pure device handlers turn SmartThings status into plain state objects and build command payloads. A separate HomeKit layer maps state objects to HomeKit services. A local TV module (HTTP info on port 8001, wake packet, remote key over WebSocket on port 8002) handles TV power-on, which the cloud cannot do for two of the TVs.

**Tech Stack:** Plain ESM JavaScript (no build step), Node 20+, Homebridge 2, `ws` as the only runtime dependency, tests with the built-in `node --test` runner.

## Global Constraints

- Package name `homebridge-smartthings-5m5`. Display name `SmartThings (5m5)`. Platform name `SmartThings5m5`. These exact strings.
- ESM only (`"type": "module"`). No TypeScript, no bundler, no build step. The repository must be installable by `npm install <tarball>` and run as-is.
- Runtime dependencies: `ws` only. Dev dependencies: `homebridge` (for `hap-nodejs` in tests) only.
- `engines`: `"node": ">=20"`, `"homebridge": "^1.8.0 || ^2.0.0"`.
- Tests: `npm test` runs `node --test` (bare; the directory form fails on Node 22). Every source module has a test file. Tests never touch the network: `fetch`, `dgram`, `WebSocket`, timers and clocks are injected.
- Never log or throw a token, client secret or refresh token. Error messages name the HTTP method, path and status only.
- No em dashes anywhere (code comments, logs, README, docs).
- Pure handlers under `src/devices/` and `src/core/` must not import `homebridge` or `hap-nodejs`.
- Fixtures under `test/fixtures/` are real recorded shapes. Do not edit them. Use them in tests.
- SmartThings status shape: `status.components[componentId][capabilityId][attribute].value`.
- Commit after each green step with a short conventional message.

## Verified facts (from the live account, 24 Nov 2026)

Command definitions read from the SmartThings API:

- `switch`: `on()`, `off()`
- `audioVolume`: `volumeUp()`, `volumeDown()`, `setVolume(volume)`
- `audioMute`: `setMute(state=muted/unmuted)`, `mute()`, `unmute()`
- `samsungvd.mediaInputSource`: `setInputSource(id)`
- `samsungvd.remoteControl`: `send(keyValue, keyState)`; keyValue includes `UP DOWN LEFT RIGHT OK BACK EXIT MENU HOME MUTE PLAY PAUSE STOP REWIND FF SOURCE POWER VOLUP VOLDOWN CHUP CHDOWN`; keyState is `PRESSED`, `RELEASED` or `PRESS_AND_RELEASED`
- `custom.launchapp`: `launchApp(appId, appName)`
- `washerOperatingState` and `dryerOperatingState`: `setMachineState(state=pause/run/stop)`
- `thermostatCoolingSetpoint`: `setCoolingSetpoint(setpoint)`
- `refrigeration`: `setRapidCooling(rapidCooling=off/on)`, `setRapidFreezing(rapidFreezing=off/on)`
- `samsungce.fridgeVacationMode`: `setVacationMode(vacationMode=on/off)`
- `samsungce.kidsLock`: no commands (read only)

Behaviour observed:

- The two 85 inch TVs (UA85AU8000) drop off the SmartThings cloud about two minutes after being switched off and report `supportsPowerOnByOcf = false`. The 65 inch TV stays online when off and reports `true`.
- A wake packet sent to an 85 inch TV's IP address brings its network side up (it answers HTTP on port 8001 with an empty `PowerState`) but does not turn the screen on. A second step (power key) is needed and is not yet proven.
- TVs answer `GET http://<ip>:8001/api/v2/` with `{ device: { name, modelName, wifiMac, PowerState, ... } }`. `PowerState` was `"on"` when on.
- The washer and dryer go offline when idle and come back when queried. `remoteControlStatus.remoteControlEnabled` is the string `"false"` or `"true"`.
- The fridge reports `custom.disabledComponents`; only `cooler` and `freezer` carry real values.

## File structure

```
package.json
config.schema.json
README.md
bin/oauth-setup.js            CLI: one-time OAuth sign-in helper
src/index.js                  registers the platform
src/settings.js               PLUGIN_NAME, PLATFORM_NAME, defaults
src/platform.js               discovery, accessory creation, wiring
src/api/tokenProvider.js      PAT or OAuth with refresh and persistence
src/api/oauth.js              authorize URL, code exchange, refresh call
src/api/client.js             SmartThings REST client
src/core/status.js            attr() helper
src/core/classify.js          device -> kind
src/core/poller.js            scheduled status reads
src/devices/moisture.js       pure: state
src/devices/laundry.js        pure: state, commands, FinishTracker
src/devices/fridge.js         pure: state, commands
src/devices/tv.js             pure: state, commands
src/local/samsungTv.js        local info, wake packet, key over WebSocket, power-on sequence
src/local/localTokenStore.js  per-TV WebSocket token file
src/homekit/moistureAccessory.js
src/homekit/laundryAccessory.js
src/homekit/fridgeAccessory.js
src/homekit/tvAccessory.js
test/*.test.js                one per source module
test/fixtures/*.json          recorded data (already present)
```

---

### Task 1: Project scaffold and SmartThings API layer

**Files:**
- Create: `package.json`, `README.md` (short stub), `src/settings.js`, `src/api/oauth.js`, `src/api/tokenProvider.js`, `src/api/client.js`, `bin/oauth-setup.js`
- Test: `test/oauth.test.js`, `test/tokenProvider.test.js`, `test/client.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `src/settings.js`: `export const PLUGIN_NAME = 'homebridge-smartthings-5m5'`, `export const PLATFORM_NAME = 'SmartThings5m5'`, `export const API_BASE = 'https://api.smartthings.com/v1'`, `export const TOKEN_URL = 'https://api.smartthings.com/oauth/token'`, `export const AUTHORIZE_URL = 'https://api.smartthings.com/oauth/authorize'`, `export const OAUTH_SCOPES = 'r:devices:* x:devices:* r:locations:*'`.
  - `src/api/oauth.js`:
    - `buildAuthorizeUrl({ clientId, redirectUri })` returns a URL string with `client_id`, `response_type=code`, `redirect_uri`, `scope` (OAUTH_SCOPES).
    - `async exchangeCode({ clientId, clientSecret, code, redirectUri, fetchImpl })` and `async refreshTokens({ clientId, clientSecret, refreshToken, fetchImpl })`. Both POST to TOKEN_URL with header `Authorization: Basic base64(clientId:clientSecret)`, `Content-Type: application/x-www-form-urlencoded`, body `grant_type=authorization_code&client_id=..&code=..&redirect_uri=..` or `grant_type=refresh_token&client_id=..&refresh_token=..`. Both return `{ accessToken, refreshToken, expiresIn }` (from `access_token`, `refresh_token`, `expires_in`). On non-2xx throw `Error('SmartThings token request failed: HTTP <status>')`.
  - `src/api/tokenProvider.js`: `export class TokenProvider` with constructor `({ accessToken, oauth, storagePath, fetchImpl = fetch, now = Date.now, log })` where `oauth` is `{ clientId, clientSecret, refreshToken }` or undefined, and `storagePath` is the full path of a JSON file.
    - `async getToken()`: if `oauth` is set, OAuth mode; else PAT mode returns `accessToken`; if neither, throw `Error('No SmartThings credentials configured')`.
    - OAuth mode: on first use load `{ accessToken, refreshToken, expiresAt }` from `storagePath` if the file exists (a stored refresh token wins over the config one). If there is no access token or `expiresAt - now() < 5 minutes`, call `refreshTokens`, set `expiresAt = now() + expiresIn * 1000`, and save all three values atomically (write `<storagePath>.tmp` then rename). Concurrent `getToken()` calls during a refresh share one request.
    - `invalidate()`: OAuth mode forces a refresh on the next `getToken()`. PAT mode does nothing.
  - `src/api/client.js`: `export class SmartThingsError extends Error` with `.status`; `export class SmartThingsClient` with constructor `({ tokenProvider, fetchImpl = fetch, baseUrl = API_BASE, minIntervalMs = 120, sleep = ms => new Promise(r => setTimeout(r, ms)), log })`.
    - `async listDevices()` returns an array of all device objects, following `_links.next.href` until absent or null.
    - `async getStatus(deviceId)` returns the parsed body of `GET /devices/{id}/status`.
    - `async getHealth(deviceId)` returns `'ONLINE'` or `'OFFLINE'` from the `state` field of `GET /devices/{id}/health` (anything else maps to `'OFFLINE'`).
    - `async sendCommands(deviceId, commands)` POSTs `{ commands }` to `/devices/{id}/commands`; each command is `{ component, capability, command, arguments }`.
    - Requests are serialized, one at a time, with at least `minIntervalMs` between starts.
    - HTTP 401: call `tokenProvider.invalidate()` and retry once. HTTP 429: wait `Retry-After` seconds (default 5, capped at 60) via `sleep` and retry, up to 3 retries. Any other non-2xx: throw `SmartThingsError` with message `SmartThings <METHOD> <path> failed: HTTP <status>`.
  - `bin/oauth-setup.js`: executable CLI. Arguments `--client-id`, `--client-secret`, `--redirect-uri` (default `https://httpbin.org/get`). Prints the authorize URL, reads the code from stdin with `node:readline`, calls `exchangeCode`, prints the refresh token and the config snippet to paste. All logic it needs lives in `src/api/oauth.js`; the CLI file itself has no test.

- [ ] **Step 1:** Write `package.json`: name, version `0.1.0`, displayName, `"type": "module"`, `"main": "src/index.js"`, keywords including `homebridge-plugin`, engines, `"scripts": { "test": "node --test test/" }`, dependencies `ws`, devDependencies `homebridge`, `"bin": { "smartthings-5m5-oauth": "bin/oauth-setup.js" }`, `"files": ["src", "bin", "config.schema.json", "README.md"]`. Run `npm install`. Create `src/settings.js`.
- [ ] **Step 2:** Write failing tests in `test/oauth.test.js`: authorize URL contains all four query parameters URL-encoded; `exchangeCode` sends the Basic header and exact form body (assert on the captured request of a fake `fetchImpl`); `refreshTokens` likewise; a 400 response throws the exact message and the message does not contain the secret.
- [ ] **Step 3:** Run `npm test`, confirm failures, implement `src/api/oauth.js`, confirm pass, commit.
- [ ] **Step 4:** Write failing tests in `test/tokenProvider.test.js` (use `fs.mkdtempSync` for `storagePath`): PAT mode returns the token and never calls fetch; no credentials throws; OAuth first call refreshes and writes the file with all three fields; second call within validity makes no request; a call when `expiresAt - now < 5 min` refreshes; the rotated refresh token from the response is the one used next time; a stored file's refresh token wins over config on a fresh instance; two concurrent `getToken()` calls make one request; `invalidate()` forces a refresh; a failed refresh rejects and leaves the file unchanged.
- [ ] **Step 5:** Confirm failures, implement `src/api/tokenProvider.js`, confirm pass, commit.
- [ ] **Step 6:** Write failing tests in `test/client.test.js` with a scripted fake `fetchImpl` and a fake `sleep` that records waits: `listDevices` follows two pages (use `test/fixtures/devices.json` split in two); `getStatus` hits the right URL with `Authorization: Bearer <token>`; `getHealth` maps `ONLINE`, `OFFLINE` and an unknown state; `sendCommands` posts the exact JSON body; 401 then 200 calls `invalidate()` once and succeeds; 401 twice throws `SmartThingsError` status 401; 429 with `Retry-After: 2` sleeps 2000 then succeeds; 429 four times throws; 500 throws with the exact message format; two calls started together run one after the other.
- [ ] **Step 7:** Confirm failures, implement `src/api/client.js`, confirm pass, commit.
- [ ] **Step 8:** Write `bin/oauth-setup.js` (with `#!/usr/bin/env node`) and a README stub with the plugin name and one paragraph. Run `node bin/oauth-setup.js --help` and confirm it prints usage and exits 0. Commit.

---

### Task 2: Classification, poller and pure device handlers

**Files:**
- Create: `src/core/status.js`, `src/core/classify.js`, `src/core/poller.js`, `src/devices/moisture.js`, `src/devices/laundry.js`, `src/devices/fridge.js`, `src/devices/tv.js`
- Test: `test/status.test.js`, `test/classify.test.js`, `test/poller.test.js`, `test/moisture.test.js`, `test/laundry.test.js`, `test/fridge.test.js`, `test/tv.test.js`

**Interfaces:**
- Consumes: a client object with `getStatus(deviceId)`, `getHealth(deviceId)` (from Task 1; tests use a fake).
- Produces (a "snapshot" everywhere below is `{ status, online }` where `status` is the SmartThings status body or `{}` and `online` is a boolean):
  - `src/core/status.js`: `export function attr(status, component, capability, attribute)` returns the `.value` or `undefined` when any level is missing. `export function attrUnit(status, component, capability, attribute)` returns the `.unit` or `undefined`. `export function toCelsius(value, unit)` returns `value` unchanged unless unit is `'F'`, then `(value - 32) * 5 / 9` rounded to one decimal; returns `null` for null or undefined value.
  - `src/core/classify.js`: `export function classify(device)` returns `'tv' | 'washer' | 'dryer' | 'fridge' | 'moisture' | null`. Rules in order: `deviceTypeName` `'Samsung OCF TV'` is tv, `'Samsung OCF Washer'` is washer, `'Samsung OCF Dryer'` is dryer, `'Samsung OCF Refrigerator'` is fridge; else if the `main` component lists capability `waterSensor`, moisture; else null.
  - `src/devices/moisture.js`: `export function moistureState(snapshot)` returns `{ leak, temperatureC, batteryPercent, lowBattery, fault }`. `leak` is true only when `waterSensor.water === 'wet'`. `temperatureC` via `toCelsius` or null. `batteryPercent` number or null. `lowBattery` true when batteryPercent is a number below 20. `fault` is `!online`.
  - `src/devices/laundry.js`:
    - `export function laundryState(kind, snapshot)` with `kind` `'washer'` or `'dryer'` returns `{ machineState, running, paused, remoteEnabled }`. `machineState` is the `machineState` attribute of `washerOperatingState` or `dryerOperatingState`, or `null`. When `online` is false: `running` false, `paused` false, `remoteEnabled` false (an offline appliance is idle, not an error). When online: `running` is `machineState === 'run'`, `paused` is `machineState === 'pause'`, `remoteEnabled` is true when `remoteControlStatus.remoteControlEnabled` is `'true'` or `true`.
    - `export function laundryCommand(kind, action)` with action `'start'` or `'pause'` returns `[{ component: 'main', capability: 'washerOperatingState' | 'dryerOperatingState', command: 'setMachineState', arguments: ['run' | 'pause'] }]`.
    - `export class FinishTracker` constructor `({ holdMs = 30 * 60 * 1000, now = Date.now })`; `update(running)` returns the current `finished` boolean. Rules: `finished` becomes true when `running` has been true on at least one earlier update and is then false on two consecutive updates. It stays true until `holdMs` has elapsed since it became true, or until `running` is true again, whichever comes first. A tracker that has never seen `running` true never reports finished.
  - `src/devices/fridge.js`:
    - `export function fridgeState(snapshot)` returns `{ sections, powerCool, powerFreeze, vacation, fault }`. `sections` is an array built from the candidates `[{ id: 'cooler', name: 'Fridge' }, { id: 'freezer', name: 'Freezer' }, { id: 'cvroom', name: 'Flex Zone' }]`, keeping a candidate only if its id is not in `main/custom.disabledComponents/disabledComponents` and it has a non-null `contactSensor.contact` or a non-null `temperatureMeasurement.temperature`. Each section: `{ id, name, doorOpen, temperatureC, setpointC, min, max, step }` where `doorOpen` is `contact === 'open'`, temperatures go through `toCelsius`, and `min`, `max`, `step` come from `thermostatCoolingSetpoint.coolingSetpointRange` (null when absent). `powerCool` is `refrigeration.rapidCooling === 'on'`, `powerFreeze` is `refrigeration.rapidFreezing === 'on'`, `vacation` is `samsungce.fridgeVacationMode.vacationMode === 'on'`, `fault` is `!online`. When offline, sections keep whatever the last status holds.
    - `export function setpointCommand(sectionId, valueC)` returns `[{ component: sectionId, capability: 'thermostatCoolingSetpoint', command: 'setCoolingSetpoint', arguments: [valueC] }]`.
    - `export function powerCoolCommand(on)` returns `[{ component: 'main', capability: 'refrigeration', command: 'setRapidCooling', arguments: [on ? 'on' : 'off'] }]`; `powerFreezeCommand(on)` the same with `setRapidFreezing`; `vacationCommand(on)` returns `[{ component: 'main', capability: 'samsungce.fridgeVacationMode', command: 'setVacationMode', arguments: [on ? 'on' : 'off'] }]`.
  - `src/devices/tv.js`:
    - `export function tvState(snapshot, localPower)` where `localPower` is `'on' | 'standby' | null | undefined`. Returns `{ on, volume, muted, inputs, currentInputId, cloudPowerOn }`. `on`: if `localPower` is `'on'` true; if `'standby'` false; otherwise `online && switch === 'on'`. `volume` number or null. `muted` is `audioMute.mute === 'muted'`. `inputs` is `samsungvd.mediaInputSource.supportedInputSourcesMap` mapped to `{ id, name }` (empty array when missing). `currentInputId` is `samsungvd.mediaInputSource.inputSource` or null. `cloudPowerOn` is true when `samsungvd.supportsPowerOnByOcf.supportsPowerOnByOcf` is `'true'` or `true`.
    - Command builders, each returning a one-element array on component `main`: `powerOffCommand()` (`switch` `off`, arguments `[]`), `powerOnCommand()` (`switch` `on`), `inputCommand(id)` (`samsungvd.mediaInputSource` `setInputSource` `[id]`), `volumeUpCommand()`, `volumeDownCommand()` (`audioVolume`), `setVolumeCommand(n)` (`audioVolume` `setVolume` `[n]`), `muteCommand(muted)` (`audioMute` `setMute` `['muted' | 'unmuted']`), `keyCommand(key)` (`samsungvd.remoteControl` `send` `[key, 'PRESS_AND_RELEASED']`), `launchAppCommand(appId)` (`custom.launchapp` `launchApp` `[appId]`).
  - `src/core/poller.js`: `export class Poller` constructor `({ client, onSnapshot, onError = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now, log })`.
    - `add(deviceId, intervalMs)`, `start()`, `stop()`, `async pollNow(deviceId)`.
    - A poll calls `client.getHealth`; if `'ONLINE'` it calls `client.getStatus` and stores it; if offline it reuses the last stored status (or `{}`), without calling `getStatus`. It then calls `onSnapshot(deviceId, { status, online })`.
    - After each poll finishes (success or failure) the next one for that device is scheduled `intervalMs` later. Polls for one device never overlap. `stop()` cancels all timers.
    - A failed poll calls `onError(deviceId, error)` and does not call `onSnapshot`. The poller logs a failure for a given device at most once per 60 seconds (`log.warn`).

- [ ] **Step 1:** Write failing tests for `status.js` and `classify.js`. For classify, load `test/fixtures/devices.json` and assert the kind of every one of the 14 devices: three tv, one washer, one dryer, one fridge, four moisture, four null (two iPhone, two hubs). Implement, pass, commit.
- [ ] **Step 2:** Write failing tests for `moisture.js` using `moisture.status.json`: online gives `{ leak: false, temperatureC: 25.1, batteryPercent: 15, lowBattery: true, fault: false }`; a copy with `water: 'wet'` gives leak true; offline with `{}` status gives `{ leak: false, temperatureC: null, batteryPercent: null, lowBattery: false, fault: true }`; a Fahrenheit temperature converts. Implement, pass, commit.
- [ ] **Step 3:** Write failing tests for `laundry.js` using `washer.status.json` and `dryer.status.json`: recorded washer online gives `{ machineState: 'stop', running: false, paused: false, remoteEnabled: false }`; a copy with `machineState: 'run'` and `remoteControlEnabled: 'true'` gives running and remoteEnabled true; boolean `true` also counts; `'pause'` gives paused; offline gives all false; dryer reads `dryerOperatingState`; both command builders for both kinds match the exact arrays above. FinishTracker cases with an injected clock: never running then false stays false; true, false gives false (only one false so far); true, false, false gives true; stays true before `holdMs`; false after `holdMs`; true, false, false, true gives false at once; a second cycle can finish again. Implement, pass, commit.
- [ ] **Step 4:** Write failing tests for `fridge.js` using `fridge.status.json`: exactly two sections, ids `cooler` and `freezer`, names `Fridge` and `Freezer`; cooler is `{ doorOpen: false, temperatureC: 5, setpointC: 5, min: 1, max: 7, step: 1 }`; freezer `-19`, `-19`, `-23`, `-15`, `1`; `powerCool`, `powerFreeze`, `vacation` all false, `fault` false; a copy with `cooler` contact `open` gives doorOpen true; a copy with `cvroom` removed from the disabled list still excludes it (its values are null); offline gives fault true and keeps sections; all four command builders match exactly. Implement, pass, commit.
- [ ] **Step 5:** Write failing tests for `tv.js` using `tv-bedroom.status.json`: online with no local power gives `{ on: false, volume: 15, muted: true, inputs: [{ id: 'dtv', name: 'TV' }, { id: 'HDMI1', name: 'XBOX Series X|S' }, { id: 'HDMI2', name: 'Bedroom TV' }], currentInputId: 'HDMI2', cloudPowerOn: true }`; a copy with switch `on` gives on true; offline with switch `on` in the last status gives on false; `localPower: 'on'` gives on true even when offline; `localPower: 'standby'` gives on false even when the cloud says on; missing input map gives `inputs: []`; every command builder matches exactly. Implement, pass, commit.
- [ ] **Step 6:** Write failing tests for `poller.js` with a fake client and manual fake timers: online device calls health then status and delivers the snapshot; offline device does not call `getStatus` and delivers the last status with `online: false`; first-ever offline poll delivers `{ status: {}, online: false }`; the next poll is scheduled only after the previous finished, `intervalMs` later; a rejected `getHealth` calls `onError`, not `onSnapshot`, and still schedules the next poll; two failures within 60 seconds log one warning, a third after 60 seconds logs again; `stop()` clears timers and no further polls run; `pollNow` works without `start()`. Implement, pass, commit.

---

### Task 3: Local TV control

**Files:**
- Create: `src/local/localTokenStore.js`, `src/local/samsungTv.js`
- Test: `test/localTokenStore.test.js`, `test/samsungTv.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `src/local/localTokenStore.js`: `export class LocalTokenStore` constructor `(filePath)`; `get(ip)` returns the saved token string or `undefined`; `set(ip, token)` saves it (JSON object keyed by IP, written atomically with a `.tmp` file and rename). A missing or unreadable file behaves as empty.
  - `src/local/samsungTv.js`:
    - `export async function getLocalInfo(ip, { fetchImpl = fetch, timeoutMs = 2000 } = {})` requests `http://<ip>:8001/api/v2/` with an abort after `timeoutMs`. Returns `{ reachable: true, powerState, name, wifiMac }` where `powerState` is the lower-cased `device.PowerState` when it is `on` or `standby`, otherwise `null`. Any error or non-2xx returns `{ reachable: false, powerState: null, name: null, wifiMac: null }`. Never throws.
    - `export function buildMagicPacket(mac)` accepts `02:00:5E:10:20:30`, `02-00-5E-10-20-30` or `02005E102030` in any case; returns a 102 byte Buffer (6 bytes of 0xFF then the MAC 16 times). Throws `Error('Invalid MAC address')` otherwise.
    - `export function broadcastAddress(ip)` returns the `/24` broadcast address (`192.168.1.42` gives `192.168.1.255`).
    - `export async function sendWake(mac, ip, { dgramImpl = dgram, repeats = 3, ports = [9, 7] } = {})` creates one `udp4` socket, calls `setBroadcast(true)` after binding, sends the packet `repeats` times to each port at both `ip` and `broadcastAddress(ip)`, then closes the socket. Resolves when done; rejects on a socket error.
    - `export async function sendKey(ip, key, { tokenStore, name = 'Homebridge', WebSocketImpl = WebSocket (from ws), timeoutMs = 8000 } = {})`. Opens `wss://<ip>:8002/api/v2/channels/samsung.remote.control?name=<base64 of name>` plus `&token=<token>` when `tokenStore.get(ip)` returns one, with option `{ rejectUnauthorized: false }` (the TV uses a self-signed certificate). Waits for a message whose JSON `event` is `ms.channel.connect`; if it carries `data.token`, saves it with `tokenStore.set(ip, String(token))`. Then sends `{"method":"ms.remote.control","params":{"Cmd":"Click","DataOfCmd":"<key>","Option":"false","TypeOfRemote":"SendRemoteKey"}}`, waits 300 ms, closes, resolves. If the event is `ms.channel.unauthorized`, rejects with `Error('TV denied the connection')`. If nothing arrives within `timeoutMs`, or the socket errors, rejects with `Error('TV did not respond')`. Always closes the socket. `key` values are Samsung key codes such as `KEY_POWER`.
    - `export async function powerOnSequence({ mac, ip, tokenStore, sleep = ms => new Promise(r => setTimeout(r, ms)), deps = {} })` where `deps` may override `getLocalInfo`, `sendWake`, `sendKey` for tests. Steps: (1) `getLocalInfo`; if `powerState === 'on'` return `'on'`. (2) If not reachable: `sendWake`, then poll `getLocalInfo` every 2000 ms, at most 15 times, until reachable; if never reachable return `'unreachable'`. (3) If now `powerState === 'on'` return `'on'`. (4) `sendKey(ip, 'KEY_POWER', { tokenStore })`; if it rejects return `'standby'`. (5) Poll `getLocalInfo` every 2000 ms, at most 8 times, until `powerState === 'on'`; return `'on'` if seen, otherwise `'standby'`. Never throws.

- [ ] **Step 1:** Write failing tests for `localTokenStore.js` (temp dir): get on a missing file is undefined; set then get returns the token; a second instance on the same file reads it; two IPs are kept separately; a corrupt file behaves as empty and is overwritten by the next set. Implement, pass, commit.
- [ ] **Step 2:** Write failing tests for `getLocalInfo`, `buildMagicPacket`, `broadcastAddress`: fake fetch returning `PowerState: 'on'` gives `{ reachable: true, powerState: 'on', ... }` with name and wifiMac passed through; `PowerState: ''` and a missing field give powerState null with reachable true; a rejected fetch and a 500 give the unreachable object; the magic packet for `02:00:5E:10:20:30` is 102 bytes, starts with six 0xFF and bytes 6 to 11 are `02 00 5e 10 20 30`; the three MAC formats give identical buffers; `'nope'` throws. Implement, pass, commit.
- [ ] **Step 3:** Write failing tests for `sendWake` with a fake `dgramImpl` whose socket records `send(buffer, port, address, cb)` calls: with defaults there are 12 sends (3 repeats x 2 ports x 2 addresses), every buffer is the magic packet, `setBroadcast(true)` was called, and the socket was closed. Implement, pass, commit.
- [ ] **Step 4:** Write failing tests for `sendKey` with a fake `WebSocketImpl` class (an EventEmitter with `send` and `close`, recording the URL and options): no stored token gives a URL without `token=` and with the base64 name; a stored token is appended; on `ms.channel.connect` with `data.token` the token is saved and the exact key payload is sent; `rejectUnauthorized` is false; `ms.channel.unauthorized` rejects with the exact message and closes; no message within the timeout rejects with `TV did not respond` (use a small `timeoutMs`); a socket `error` event rejects. Implement, pass, commit.
- [ ] **Step 5:** Write failing tests for `powerOnSequence` with scripted fakes and a `sleep` that resolves at once: already on returns `'on'` with no wake or key; unreachable, wake, reachable with null power, key, then on returns `'on'` and the calls happened in that order; never reachable returns `'unreachable'` after exactly 15 polls and sends no key; reachable in standby skips the wake and sends the key; key rejects returns `'standby'`; key accepted but never on returns `'standby'` after 8 polls; a throwing `sendWake` still returns a string, not a rejection. Implement, pass, commit.

---

### Task 4: HomeKit accessories, platform, config schema and README

**Files:**
- Create: `src/homekit/moistureAccessory.js`, `src/homekit/laundryAccessory.js`, `src/homekit/fridgeAccessory.js`, `src/homekit/tvAccessory.js`, `src/platform.js`, `src/index.js`, `config.schema.json`
- Modify: `README.md` (replace the stub)
- Test: `test/moistureAccessory.test.js`, `test/laundryAccessory.test.js`, `test/fridgeAccessory.test.js`, `test/tvAccessory.test.js`, `test/platform.test.js`

**Interfaces:**
- Consumes (all already implemented, import them, do not rewrite them):
  - `PLUGIN_NAME`, `PLATFORM_NAME` from `src/settings.js`
  - `TokenProvider` from `src/api/tokenProvider.js`, `SmartThingsClient` from `src/api/client.js`
  - `classify` from `src/core/classify.js`, `Poller` from `src/core/poller.js`
  - `moistureState` from `src/devices/moisture.js`
  - `laundryState`, `laundryCommand`, `FinishTracker` from `src/devices/laundry.js`
  - `fridgeState`, `setpointCommand`, `powerCoolCommand`, `powerFreezeCommand`, `vacationCommand` from `src/devices/fridge.js`
  - `tvState`, `powerOffCommand`, `powerOnCommand`, `inputCommand`, `volumeUpCommand`, `volumeDownCommand`, `muteCommand`, `keyCommand`, `launchAppCommand` from `src/devices/tv.js`
  - `getLocalInfo`, `powerOnSequence` from `src/local/samsungTv.js`, `LocalTokenStore` from `src/local/localTokenStore.js`
  - Read each of those files for the exact signatures before writing code.
- Produces:
  - Every accessory module exports a class with constructor `({ accessory, hap, device, client, log, ...extras })` where `accessory` is a HomeKit accessory object (`getService`, `getServiceById`, `addService`, `removeService`), `hap` is the HAP namespace (`hap.Service`, `hap.Characteristic`), `device` is the SmartThings device object, `client` has `sendCommands(deviceId, commands)`. Each class has `update(snapshot)` which recomputes state and pushes values with `updateCharacteristic`. Set handlers call `client.sendCommands(device.deviceId, <commands>)`; if that rejects they log a warning and throw `new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE)`. Services are found or created by subtype so restarts reuse them. Every accessory sets AccessoryInformation Manufacturer `Samsung`, Model from `device.deviceTypeName || device.type`, SerialNumber `device.deviceId`.
  - `MoistureAccessory`: `LeakSensor` (LeakDetected, StatusLowBattery, StatusFault 1 when fault), `TemperatureSensor` (CurrentTemperature, only updated when temperatureC is not null), `Battery` (BatteryLevel, StatusLowBattery).
  - `LaundryAccessory` (extras: `kind`, `finishTracker`): `OccupancySensor` subtype `running` named `<label> Running` (OccupancyDetected 1 when running), `ContactSensor` subtype `finished` named `<label> Finished` (ContactSensorState 1 when finished, else 0), and a `Switch` subtype `startpause` named `<label> Start` that exists only while `remoteEnabled` is true: `update` adds it when remoteEnabled becomes true and removes it when it becomes false. Switch On reflects `running`; set true sends `laundryCommand(kind, 'start')`, set false sends `laundryCommand(kind, 'pause')`. `update` calls `finishTracker.update(state.running)` once per call.
  - `FridgeAccessory`: for each section a `ContactSensor` subtype `door-<id>` named `<section name> Door` (state 1 when doorOpen) and a `Thermostat` subtype `temp-<id>` named `<section name>`: CurrentTemperature and TargetTemperature with props `minValue`, `maxValue`, `minStep` from the section range (CurrentTemperature props widened to `minValue: -40, maxValue: 40`), TargetHeatingCoolingState fixed to COOL with `validValues: [COOL]`, CurrentHeatingCoolingState COOL, TemperatureDisplayUnits Celsius; setting TargetTemperature sends `setpointCommand(id, value)`. A section without a range gets only the door sensor. Three `Switch` services with subtypes `powercool`, `powerfreeze`, `vacation` named `Power Cool`, `Power Freeze`, `Vacation Mode`, sending the matching commands.
  - `TvAccessory` (extras: `tvConfig` which is `{ ip, mac, apps }` or undefined, `tokenStore`, `deps` for overriding `getLocalInfo` and `powerOnSequence` in tests): a `Television` service (Active, ActiveIdentifier, ConfiguredName, SleepDiscoveryMode ALWAYS_DISCOVERABLE, RemoteKey), a `TelevisionSpeaker` (Mute, VolumeSelector, VolumeControlType RELATIVE, Active), and one `InputSource` per input and per configured app, linked to the Television service. Input identifiers are assigned 1..n in order: SmartThings inputs first, then apps. Inputs are built on the first `update` that has a non-empty input list and are not rebuilt afterwards.
    - Active set 0 sends `powerOffCommand()`.
    - Active set 1: if `tvConfig` has both `ip` and `mac`, run `powerOnSequence({ mac, ip, tokenStore })` without making HomeKit wait for it (return at once; log the result; if the result is not `'on'` and `state.cloudPowerOn` is true, also send `powerOnCommand()`). If there is no `tvConfig`, send `powerOnCommand()`.
    - ActiveIdentifier set: an input sends `inputCommand(id)`; an app sends `launchAppCommand(appId)`.
    - RemoteKey set maps HomeKit keys to `keyCommand`: ARROW_UP `UP`, ARROW_DOWN `DOWN`, ARROW_LEFT `LEFT`, ARROW_RIGHT `RIGHT`, SELECT `OK`, BACK `BACK`, EXIT `EXIT`, PLAY_PAUSE `PLAY`, INFORMATION `MENU`. Unmapped keys do nothing.
    - VolumeSelector set: INCREMENT sends `volumeUpCommand()`, DECREMENT `volumeDownCommand()`. Mute set sends `muteCommand(value)`.
    - `update(snapshot, localPower)` uses `tvState(snapshot, localPower)`; Active is 1 when `on`; an offline TV therefore shows as off, never as an error.
  - `src/platform.js`: `export class SmartThings5m5Platform` constructor `(log, config, api)`. Implements `configureAccessory(accessory)` (collect cached accessories in a Map by UUID). On `didFinishLaunching` it calls `async discover()`:
    1. Build `TokenProvider` (storagePath `<api.user.storagePath()>/smartthings-5m5-tokens.json`), `SmartThingsClient`, `LocalTokenStore` (`<storagePath>/smartthings-5m5-tv-tokens.json`), `Poller`.
    2. `client.listDevices()`. For each device: skip if its label is in `config.ignoreDevices`; `classify`; if null, add to an "unhandled" list. Log one info line listing unhandled labels.
    3. UUID is `api.hap.uuid.generate('smartthings-5m5:' + device.deviceId)`.
    4. Moisture, washer, dryer, fridge: reuse the cached accessory or create `new api.platformAccessory(label, uuid)` and `api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory])`.
    5. TV: `new api.platformAccessory(label, uuid, api.hap.Categories.TELEVISION)` published with `api.publishExternalAccessories(PLUGIN_NAME, [accessory])`. TV config is the entry of `config.tvs` whose `label` equals the device label.
    6. Poll intervals from `config.pollSeconds` with defaults `{ sensors: 30, appliances: 15, tvs: 10 }` (moisture uses sensors; washer, dryer, fridge use appliances; tv uses tvs), multiplied by 1000.
    7. `onSnapshot` calls the accessory's `update`. For a TV with a configured `ip`, first call `getLocalInfo(ip)` and pass its `powerState` as `localPower`.
    8. Cached accessories that no longer match a device are kept, and one warning line names them. Nothing is unregistered.
    9. If `discover()` fails (for example sign-in), log an error and retry after 60 seconds. It must not throw out of the event handler.
    - `finishedHoldMinutes` (default 30) sets `FinishTracker` `holdMs`.
  - `src/index.js`: `export default (api) => { api.registerPlatform(PLATFORM_NAME, SmartThings5m5Platform); }`.
  - `config.schema.json`: `pluginAlias` `SmartThings5m5`, `pluginType` `platform`, `singular` true. Properties: `name` (default `SmartThings (5m5)`), `accessToken` (string), `oauth` object (`clientId`, `clientSecret`, `refreshToken`), `pollSeconds` object (`sensors`, `appliances`, `tvs`), `finishedHoldMinutes` (integer, default 30), `ignoreDevices` (array of strings), `tvs` (array of `{ label, ip, mac, apps: [{ name, appId }] }`).
  - `README.md`: what the plugin is, the device list and what each shows in Apple Home, config example, how TV power-on works and that the wake-then-power-key step is unproven on the 85 inch TVs, the one-time TV "Allow" prompt, OAuth setup using `bin/oauth-setup.js`, install command pattern `npm install --save --omit=dev https://github.com/5m5me/homebridge-smartthings-5m5/archive/refs/heads/release-0.1.0.tar.gz`, and the limits (cloud dependence, polling delay, no washer or fridge tile in Apple Home, remote control must be enabled at the machine).

**Testing approach:** import `hap-nodejs` through the `homebridge` dev dependency (`import { HAPStorage, Accessory, Service, Characteristic, uuid, Categories, HapStatusError, HAPStatus } from 'hap-nodejs'`, which homebridge installs). Build a real `new Accessory(name, uuid.generate(name))` for accessory tests and pass `hap = { Service, Characteristic, HapStatusError, HAPStatus }`. Read characteristic values with `service.getCharacteristic(X).value`. Trigger set handlers with `await characteristic.handleSetRequest(value)` or by calling the registered `onSet` handler through `characteristic.setValue(value)` and awaiting a tick. If `hap-nodejs` is not directly importable, import it from `homebridge`'s own `node_modules` path via `createRequire`. For `platform.test.js` use a small fake `api` object: `{ hap, user: { storagePath: () => tmpDir }, platformAccessory: class wrapping Accessory, registerPlatformAccessories: recorder, publishExternalAccessories: recorder, on(event, cb) }`, and let the platform accept an optional fourth constructor argument `deps` (`{ createClient, createPoller, getLocalInfo }`) so the test injects fakes. Homebridge only passes three arguments, so production behaviour is unchanged.

- [ ] **Step 1:** Confirm how `hap-nodejs` can be imported in tests (try the plain import first). Write failing tests for `MoistureAccessory` using `moisture.status.json`: after `update` LeakDetected is 0, CurrentTemperature 25.1, BatteryLevel 15, StatusLowBattery 1, StatusFault 0; wet gives LeakDetected 1; offline with empty status gives StatusFault 1 and leaves CurrentTemperature unchanged; creating the class twice on the same accessory does not duplicate services. Implement, pass, commit.
- [ ] **Step 2:** Write failing tests for `LaundryAccessory`: recorded washer gives OccupancyDetected 0, ContactSensorState 0 and no `startpause` switch; a running snapshot with remote enabled adds the switch with On true; a later snapshot with remote disabled removes it; setting the switch true sends the start command and false the pause command to the fake client with the washer's deviceId; run then two stopped updates gives ContactSensorState 1; a rejected `sendCommands` makes the set handler throw a HapStatusError. Implement, pass, commit.
- [ ] **Step 3:** Write failing tests for `FridgeAccessory` using `fridge.status.json`: door sensors `door-cooler` and `door-freezer` exist and read 0; thermostats `temp-cooler` and `temp-freezer` read CurrentTemperature 5 and -19, TargetTemperature 5 and -19, with TargetTemperature props 1..7 and -23..-15 step 1; no services for `cvroom`; setting the freezer target to -18 sends the exact setpoint command; each of the three switches sends its exact command for on and off; an open cooler door reads 1. Implement, pass, commit.
- [ ] **Step 4:** Write failing tests for `TvAccessory` using `tv-bedroom.status.json`: after `update` there are three InputSource services with ConfiguredName `TV`, `XBOX Series X|S`, `Bedroom TV` and identifiers 1, 2, 3; ActiveIdentifier is 3; Active is 0; with one configured app there is a fourth input and selecting it sends the launch command; selecting identifier 2 sends the input command for `HDMI1`; Active 0 sends power off; Active 1 without tvConfig sends cloud power on; Active 1 with ip and mac calls the injected `powerOnSequence` with that mac and ip and returns without waiting for it; when the sequence resolves `'standby'` and cloudPowerOn is true the cloud power on is also sent; when it resolves `'on'` it is not; each RemoteKey mapping sends the right key; VolumeSelector and Mute send the right commands; `update(snapshot, 'on')` gives Active 1 even when the snapshot is offline; a second `update` does not add more inputs. Implement, pass, commit.
- [ ] **Step 5:** Write failing tests for the platform with injected fakes and `devices.json`: discovery registers 7 platform accessories (4 moisture, washer, dryer, fridge) and publishes 3 external accessories; with `ignoreDevices: ['Moisture Sensor 01']` it registers 6; the unhandled log line names both hubs and the iPhones; a cached accessory with a matching UUID is reused and not registered again; a cached accessory with no matching device is kept and named in a warning; the poller gets 10 devices with intervals 30000 for moisture, 15000 for washer, dryer and fridge, 10000 for tvs; `pollSeconds` overrides apply; a snapshot delivered for the washer reaches its accessory; a TV with a configured ip has `getLocalInfo` called and its power state passed on; a failing `listDevices` logs an error, does not throw, and schedules a retry. Implement `src/platform.js` and `src/index.js`, pass, commit.
- [ ] **Step 6:** Write `config.schema.json` and the full `README.md`. Add a test in `test/platform.test.js` that parses `config.schema.json`, and checks `pluginAlias === 'SmartThings5m5'` and that `package.json` `name` and `main` are correct and `main` exists. Run the whole suite, confirm all green, run `grep -rn $'—' . --include=*.js --include=*.md --include=*.json --exclude-dir=node_modules` and confirm no output. Commit.

---

## Not in this plan

Robot vacuum, Matter presentation, SmartThings webhooks, TV picture and sound modes, ambient mode, washer and dryer child lock (read only on these machines), dryer wrinkle prevent, fridge filter alerts (this fridge reports no filter data), detergent low alerts (the washer reports zero for all tank values), publishing to npm, installing on the Homebridge server.
