# Flexible RM MAX Cloud Setup Implementation Plan

Approved scope: guided sign-in, hub/remote discovery, configurable fan mappings, generic momentary command buttons. Preserve existing config and verified TCL controls. EU cloud only. No claim of arbitrary AC profile support.

Architecture: existing cloud client and protected session store remain transport boundaries. Add account bootstrap/family discovery without Android dependency. Homebridge custom UI backend returns sanitized discovery metadata and writes only a protected session. UI edits plugin config through Homebridge APIs. Runtime mappings choose explicit command names, reject ambiguity/sequences, and share existing per-hub queues. Commands never retried. Secrets stay out of discovery output/cache/logs.

- [x] Account backend: inspect APK protocol for family listing; factor password sign-in for bootstrap; list family options; explicit family selection; securely persist only after selection. Tests for malformed responses, timeout, redaction, existing renewal compatibility. No guessed endpoints.
- [x] Runtime: explicit fan mappings with legacy fallback; generic momentary button coordinator; stable cache IDs; queued commands and availability/error handling; tests for custom names, ambiguous names, cache, no duplicate actions or replay.
- [x] Guided custom UI: login/family/hub/remote picker and command selectors; preserve existing settings, disable unsupported commands, readable errors; backend sanitized endpoints and no arbitrary outbound URLs or file paths. Homebridge UI server library dependency, package files/build integrated.
- [ ] End-to-end integration: mock setup flow + real read-only existing-account discovery; npm/package compatibility matrix, typecheck/build and package secret scan; independent review.
- [ ] Backed-up production deployment on homebridge.local preserving config/pairing/session. Verify UI endpoints, live discovery, all existing HAP accessories, persistence and one polling window. Do not physically operate appliances without specific test intent.

Rulings: user approved scope and existing private GitHub pushes/install workflow. Continue implementation without repeated approval. Use same isolated nested repo; parent AUX repository unchanged. New setup must not replace an existing session on mere Login or Discover. Account/family changes require explicit final save. Remote-owned names rendered as text only. Generic controls are momentary because remote actions have no readable state.

Validation: 134 tests pass, TypeScript build clean, package secret scan clean, independent review closed all findings. Real EU password login and same-account renewal succeeded. Family listing/live metadata discovery and staged UI IPC handshake pass. No appliance commands sent.
