<p align="center">
  <img src="https://raw.githubusercontent.com/skymike/homebridge-broadlink-cloud/main/assets/broadlink-app.jpg?v=2" alt="BroadLink international app logo" width="140" height="140">
</p>

# Homebridge BroadLink Cloud

Control BroadLink RM MAX remotes from Apple Home through the BroadLink cloud.

[![npm](https://img.shields.io/npm/v/homebridge-broadlink-cloud?cacheSeconds=300&refresh=1)](https://www.npmjs.com/package/homebridge-broadlink-cloud)
[![GitHub](https://img.shields.io/badge/GitHub-skymike%2Fhomebridge--broadlink--cloud-181717?logo=github)](https://github.com/skymike/homebridge-broadlink-cloud)
[![Build](https://github.com/skymike/homebridge-broadlink-cloud/actions/workflows/ci.yml/badge.svg)](https://github.com/skymike/homebridge-broadlink-cloud/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[Installation](#installation) · [Setup](#setup) · [Configuration](docs/configuration.md) · [Troubleshooting](#troubleshooting) · [Release notes](CHANGELOG.md)

## Introduction

Homebridge BroadLink Cloud exposes remotes configured in the BroadLink app to Apple Home. Use the guided settings screen to sign in, select a home, discover your RM MAX and map remote commands to HomeKit controls. No Android emulator or running phone app is needed after setup.

This independent, unofficial integration is not affiliated with BroadLink, Apple or the Homebridge project. It is not a Homebridge Verified plugin.

## Supported devices and features

| Device or feature | Apple Home control | Support |
| --- | --- | --- |
| RM MAX ceiling fan remotes | Power, configurable speeds, optional light-toggle button | Single-code commands with configurable names |
| Learned IR/RF commands | Momentary switches | One supported command per button |
| TCL GYKQ-03_1014 AC profile | Thermostat, fan speeds, swing, Dry and Fan Only | This specific profile only |
| RM MAX room sensors | AC current temperature and humidity | Hub must be in the AC's room |
| Cloud account | Guided login, home selection and session renewal | EU region only |

Other RM models, regions and arbitrary AC profiles are not currently validated. Multi-code sequences and ambiguous duplicate names cannot be mapped. Pairing and IR/RF learning remain in the BroadLink app.

**Remote-controlled appliance state is estimated.** Fan and AC settings track acknowledged commands, not physical feedback. Other remotes may leave HomeKit state out of date. Sensor readings are measured; the AC regulates itself using its own sensor.

## Prerequisites

- A running Homebridge installation and current Homebridge UI for guided setup.
- Node.js 22.18+; tested on Node.js 22 and 24.
- Homebridge 1.8+ or 2; CI covers 1.11.4 and 2.4.0.
- A BroadLink EU account with an online RM MAX and configured remotes.
- Internet access from Homebridge and the RM MAX.

## Installation

In **Homebridge UI → Plugins**, search for `homebridge-broadlink-cloud` and install it.

For a manually managed installation:

```sh
npm install -g homebridge-broadlink-cloud
```

Follow your installation's normal plugin permissions and update procedure. Check the [release notes](CHANGELOG.md) before upgrading.

## Setup

1. Open **Plugins → Homebridge Broadlink Cloud → Plugin Config**.
2. Expand **Sign in or reconnect** and enter your BroadLink email/password.
3. Select your home, discover its devices, then choose **Save selected account**.
4. Choose the RM hub and remote, then **Load remote commands**.
5. Review the detected **Device category** and its controls. Recognized fan remotes load power, speed levels and optional light control into one fan accessory; supported TCL profiles load AC controls. If detection is unavailable, choose the category and map its controls manually. Single-command buttons are an advanced option.
6. Add the mapping, review the list, select **Save mappings**, and restart Homebridge.

For an existing installation, choose **Discover saved account**. Discovery and mapping do not operate appliances. Signing in alone does not replace the saved account.

See the [configuration reference](docs/configuration.md) for examples, stable button IDs, legacy mappings and session management. See [TCL AC controls](docs/ac-controls.md) for grouped fan, swing and special-mode switches.

## Behavior and limitations

- Fans initially display Off after restart until a command is acknowledged; this sends nothing.
- AC power initially appears Off/unknown, with staged defaults of 25°C, Auto fan and swing off. Select an explicit AC mode before a temperature-only command.
- AC fan/swing choices while power is off prepare the next command.
- Momentary switches reset to Off; they represent actions, not appliance state.
- Sensors are polled every minute; readings older than three minutes become unavailable.
- Failed physical commands are never automatically replayed.
- Cloud availability and changes to BroadLink's unofficial protocol may affect operation.

Fan speed 1/Off and TCL Cool 25°C/Off have been physically verified on one RM MAX installation. Other commands have automated coverage but are not all physically verified. The TCL encoder is checked against eleven SDK-generated reference outputs. Broader device reports are welcome.

## Troubleshooting

### Devices do not appear

Confirm they are online in the BroadLink app, you selected the correct home, and the account uses the EU region. Try **Discover saved account** again. The remote must belong to the selected hub.

### An accessory is not responding

Check Homebridge logs for BroadLink errors and confirm the hub is online in the app. Reconnect in Plugin Config if the session expired. Configured credentials enable automatic same-account login.

### A command cannot be mapped

Explicit command names are case-sensitive. Duplicate names and multi-code sequences are rejected. Generic buttons do not provide full thermostat support for an unsupported AC profile.

### AC fan speed is missing from the thermostat dial

Open the AC accessory group for its named fan-speed switches. You can show grouped controls as separate tiles. [Read the AC control guide](docs/ac-controls.md).

### Getting help

Search [existing issues](https://github.com/skymike/homebridge-broadlink-cloud/issues) first. Include plugin, Node.js and Homebridge versions, hub model, region, expected behavior and a short redacted log excerpt. Never attach full configuration, sessions or raw discovery responses.

## Privacy and security

Credentials for automatic login are stored in Homebridge configuration. Protect that file and its backups. Sessions use a separate owner-only file on supported systems. Discovery exposes selected metadata to the settings UI, not device keys or learned-code payloads.

Never post passwords, session tokens, device cookies or raw cloud responses. See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## Development

```sh
npm install --ignore-scripts
npm test
npm run check
npm run build
npm pack --dry-run
```

CI checks Node.js 22/24 against Homebridge 1/2. Tests cover protocol handling, renewal, HomeKit behavior, command mapping and the setup UI. Packages exclude tests, APKs and account captures.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines.

## License

Copyright © 2026 skymike. Released under the [MIT License](LICENSE).

The BroadLink app logo is a trademark of its respective owner and is used for identification. It is not covered by this project’s MIT license.
