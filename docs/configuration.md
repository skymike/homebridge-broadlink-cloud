# Configuration reference

[Back to README](../README.md)

## Manual configuration and legacy setup

The optional `sessionFile` defaults to `broadlink-session.json` in Homebridge storage. Guided setup manages it. Existing protected bootstrap files remain supported:

```json
{"userId":"YOUR_USER_ID","loginSession":"YOUR_SESSION","familyId":"YOUR_FAMILY_ID"}
```

A configurable fan and generic button example:

```json
{
  "platform": "BroadlinkCloud",
  "name": "BroadLink Cloud",
  "fans": [{
    "name": "Bedroom Fan",
    "remoteId": "FAN_REMOTE_ID",
    "hubId": "RM_MAX_ID",
    "exposeLightToggle": true,
    "commands": {"off": "Stop", "speeds": ["Low", "Medium", "High"], "lightToggle": "Light"}
  }],
  "buttons": [{
    "id": "tv-volume-up",
    "name": "TV Volume Up",
    "remoteId": "TV_REMOTE_ID",
    "hubId": "RM_MAX_ID",
    "command": "Volume +"
  }],
  "airConditioners": [{
    "name": "Living Room AC",
    "remoteId": "AC_REMOTE_ID",
    "hubId": "RM_MAX_ID"
  }]
}
```

Command names match exactly, including case. Keep button IDs stable to preserve HomeKit identity. Removing a mapping disables the cached accessory; it does not erase pairing information. A momentary button is an action, not the appliance's actual on/off state.

Without explicit `commands`, legacy fan mapping uses `Fanoff`, contiguous numeric speed labels starting at `1`, and optional `LightOn/Off` (case-insensitive). In the tested template, the internal `on` function toggles the light; it is not reliable as fan On.

The session file is reread each refresh. Email/password enable same-account renewal with a five-minute failed-login cooldown and one read-only discovery retry. No physical command replay occurs. Credentials and codes are not placed in accessory caches or logs. Without credentials, expired sessions must be replaced manually. Never share raw cloud discovery output; it includes device credentials.

Optional standalone `acPresets` require `id`, `name`, `remoteId`, `hubId`, `power`, integer `temperature`16–30, `mode`(auto/cool/dry/fan/heat), `speed`(auto/low/medium/high), and boolean `swing`. They send full-state commands and reset to Off. Choose either presets or thermostat for each AC remote.
