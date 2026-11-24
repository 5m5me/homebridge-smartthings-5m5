# homebridge-smartthings-5m5

Homebridge platform plugin (`SmartThings5m5`, shown as "SmartThings (5m5)") that brings Samsung SmartThings devices into Apple Home. It talks to the SmartThings cloud API, and for Samsung TVs it also uses the TV's local network interface to switch it on.

## Devices and what they show in Apple Home

| SmartThings device | Apple Home |
| --- | --- |
| Moisture sensor | Leak sensor (with low battery and fault status), temperature sensor, battery |
| Washer and dryer | `<name> Running` occupancy sensor, `<name> Finished` contact sensor (open means finished), and a `<name> Start` switch that appears only while remote control is enabled at the machine |
| Family Hub fridge | A door contact sensor and a thermostat tile (cooling only, target temperature adjustable) for the fridge and freezer sections, plus `Power Cool`, `Power Freeze` and `Vacation Mode` switches |
| Samsung TV | Television tile with power, inputs, configured apps, remote keys, relative volume and mute. Each TV is published as its own accessory and is added in Home separately, using the setup code shown in the Homebridge log or UI for that TV |

Devices the plugin does not handle (hubs, phones and so on) are listed in one info line in the Homebridge log.

## Install

```
npm install --save --omit=dev https://github.com/5m5me/homebridge-smartthings-5m5/archive/refs/heads/release-0.1.0.tar.gz
```

Restart Homebridge, then add the platform in the plugin settings.

## Configuration

Use either a personal access token or OAuth credentials. OAuth is recommended because personal access tokens expire after a day.

```json
{
  "platform": "SmartThings5m5",
  "name": "SmartThings (5m5)",
  "oauth": {
    "clientId": "...",
    "clientSecret": "...",
    "refreshToken": "..."
  },
  "pollSeconds": { "sensors": 30, "appliances": 15, "tvs": 20 },
  "finishedHoldMinutes": 30,
  "ignoreDevices": ["Moisture Sensor 01"],
  "tvs": [
    {
      "label": "Samsung 85 TV - Lounge room",
      "ip": "192.168.1.50",
      "mac": "AA:BB:CC:DD:EE:FF",
      "apps": [{ "name": "Netflix", "appId": "3201907018807" }]
    }
  ]
}
```

- `pollSeconds` defaults are shown above. Moisture sensors use `sensors`; the washer, dryer and fridge use `appliances`; TVs use `tvs`. SmartThings allows each device about 12 requests per minute, so every interval is held to at least 5 seconds and the TV default is 20 seconds.
- `finishedHoldMinutes` is how long the `Finished` sensor stays triggered after a cycle ends (default 30).
- `ignoreDevices` lists SmartThings device labels to leave out.
- `tvs` entries are matched to a TV by `label`. `ip` and `mac` enable local power on and local power state. `apps` adds an input per app that launches it.

## OAuth setup

1. Create a SmartThings API-Access app (for example with the SmartThings CLI) with the scopes `r:devices:* x:devices:* r:locations:*` and a redirect URI.
   The helper's default redirect URI is `https://httpbin.org/get`. Whatever redirect URI you use must match the one registered on the SmartThings app exactly, and you can pass a different one with `--redirect-uri`.
2. Run the helper from this package:

   ```
   npx smartthings-5m5-oauth --client-id <id> --client-secret <secret>
   ```

   The package script is `bin/oauth-setup.js`. Run `--help` for options.
3. Open the printed authorize URL, approve access, and paste the `code` value from the redirected URL back into the helper.
4. Copy the printed config snippet (client ID, client secret and refresh token) into the plugin settings. Refreshed tokens are stored in the Homebridge storage folder, so the config value only seeds the first sign-in.

## How TV power on works

With no `tvs` entry for a TV, switching it on sends the SmartThings cloud `switch on` command. That only works while the TV is reachable from the cloud.

With `ip` and `mac` configured, switching on runs a local sequence and returns to HomeKit at once without waiting for it:

1. Ask the TV for its local state. If it already reports `on`, stop.
2. If it is not reachable, send a Wake-on-LAN packet and wait for it to answer on the network (up to about 30 seconds).
3. Send the power key over the TV's local WebSocket interface, then check again that it reports `on`.

If the sequence does not end with the TV on and the TV reports that the cloud can power it on, the plugin also sends the cloud `switch on` command.

The 85 inch TVs (UA85AU8000) leave the SmartThings cloud about two minutes after switching off and cannot be powered on from the cloud. A wake packet brings their network side up but does not turn the screen on, so the second step (the power key) is needed. That wake-then-power-key step is unproven on the 85 inch TVs. The 65 inch TV stays online when off and supports cloud power on.

### One-time TV "Allow" prompt

The first time the plugin sends a key to a TV over the local interface, the TV shows an "Allow" prompt on screen. Accept it with the TV remote. The token the TV returns is stored in the Homebridge storage folder, so the prompt should not appear again.

## Unproven until live tested

- The power key on the 85 inch TVs.
- Wake after a long time off across subnets.
- The TV "Allow" prompt flow.
- Negative freezer setpoints on a Home thermostat tile.
- App ids for app inputs.

## Limits

- The plugin depends on the SmartThings cloud. If the cloud or your sign-in is down, devices stop updating. Discovery at startup is retried every 60 seconds if it fails. After startup, a device whose poll fails is retried with a growing delay (doubling each time) up to 5 minutes, and returns to the normal interval after the next success.
- State is polled, not pushed, so changes appear after up to one poll interval.
- Apple Home has no washer, dryer or fridge tile, so those appear as sensors, switches and thermostats as described above.
- The washer and dryer `Start` switch is only present while remote control is enabled at the machine itself, and the machines go offline when idle.
- The fridge reports only the fridge and freezer sections with real values; the flex zone is not exposed.
