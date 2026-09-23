# Release notes

## 0.4.0 — 2026-09-23

- All 23 BroadLink appliance categories available in setup, with category-specific control mappings.
- One accessory per mapped device: native light/covering services where applicable, grouped remote actions for other categories.
- Detect known fan/projector/AC cloud product types; manual selection remains available.
- Empty remotes clearly require commands and cannot be added.
- Full-display AC encoding remains limited to the verified TCL profile; remote categories do not imply video, measured positions or automatic climate regulation.

## 0.3.5 — 2026-09-23

Replace bulk command-switch import with device-category discovery. Recognized fan remotes populate one fan accessory with speed/Off/light mappings; unknown remotes require manual category selection. Existing fan mappings are preserved.

## 0.3.4 — 2026-09-23

- Whole-remote import adds every supported command in one action, with fan controls for recognized speed/Off patterns.
- Fix Add on HTTP Homebridge pages without crypto.randomUUID; stable command IDs prevent duplicate imports.

## 0.3.3 — 2026-09-23

Fix command discovery for template remotes with blank custom names: use the cloud function identifier as the selector. Existing named commands remain unchanged.

## 0.3.2 — 2026-09-16

Documentation-only update: adds a GitHub repository badge and the improved BroadLink app logo to the npm README. Runtime behavior is unchanged.

## 0.3.1 — 2026-09-16

First public release. Adds the MIT license, public package metadata and documentation. Runtime behavior is unchanged from 0.3.0.

## 0.3.0 — 2026-09-16

- Guided account login, home selection and remote discovery.
- Configurable fan Off, ordered speeds and optional light toggle.
- Learned IR/RF command buttons; legacy mappings preserved.

## 0.2.1 — 2026-09-16

- Persists added AC services when migrating cached accessories.

## 0.2.0 — 2026-09-16

- Grouped TCL fan-speed, swing, Dry and Fan Only controls.

## 0.1.0 — 2026-09-16

- Initial private release: cloud fans, TCL thermostat, RM MAX sensors and session renewal.
