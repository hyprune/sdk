# Testing and conformance

```sh
npm ci
npm test
npm run test:bun
```

SDK tests use real private Unix sockets and the CLI supervisor. Coverage includes strict framing/UTF-8/duplicates/depth, protocol-specific types/validation, one-use bound tokens, filtered discovery, subscription ordering and whole-key reduction, gaps/resync/reconnect, fresh tokens, daemon restart, revocation and lost-reply safety. M1 cases cover camera/targets, routes/autodrive, travel progress/cancel/arrival, loading-before-reply/failure/disconnect, core-style UI hold timing/ownership, source namespace/sequence/rate/TTL/disconnect and stale hints. Tooling checks world formats/material profiles, glTF/provenance/path failures, deterministic packing, all scaffolds, /proc parsing and the supervised publisher/widget.

## Built-core interoperability

Build core following its README (matching Hyprland headers/dependencies are required):

```sh
cd /path/to/hyprune/core
python3 tests/fixtures/materials.py
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=RelWithDebInfo
cmake --build build -j 3
ctest --test-dir build --output-on-failure
cd /path/to/hyprune/sdk
HYPRUNE_CORE_BINARY=/path/to/hyprune/core/build/hypruned npm test
```

Two optional tests launch the **actual built `hypruned`** through a private SOCK_SEQPACKET plugin stand-in. `scripts/core-harness.py` compiles `scripts/core-host.cpp` against core's built `libhyprune_runtime.a`; actual `Control`, simulation, collision and world-loading code execute commands. Tests verify both protocol versions, authentication, camera, waypoint/routes/autodrive, travel hints/state, owned UI and exclusive-input rejection, publish-only grant/namespace/TTL/disconnect, loading before acknowledgement, atomic success/failure, exit and unsubscribe.

Requirements: Python 3, a C++23 compiler, core source/headers/static library and generated atrium fixture. `HYPRUNE_CORE_DIR` can override source location when it differs from the binary's parent build tree. Without `HYPRUNE_CORE_BINARY`, both tests explicitly skip; independent SDK CI needs no sibling checkout.

The test host substitutes plugin scheduling/output publication, not successful method replies. It uses a scratch runtime directory and unique instance; no Wayland, GL or compositor is started, and no desktop session is touched. These tests do not cover full plugin input routing, render/upload ordering or Wayland-client association. Any nested run goes through core's nested controller and its exclusive session lock; none was needed for this verification.

## Schema pin and CI

`vendor/schema/source.json` pins commit and SHA-256 for all unchanged upstream schemas, validator and license. `npm run check:source` rejects changed bytes. Frozen v0 files remain available beside v0.2. Update by importing an exact upstream commit, updating checksums, regenerating types and adding positive/negative compatibility fixtures; never edit a vendored schema to invent an API.

`scripts/generate.mjs` produces both method maps and model families and fails on unknown structural constructs. Runtime validation remains necessary for semantic bounds. `scripts/copy.mjs` removes obsolete generated mock contracts from the build output.

GitHub Actions tests Node 22.12/24 and Bun 1.4.2, installs zstd, verifies source checksums/generated drift and inspects package contents. Optional sibling-core tests run locally; remote CI has not been run for these unpushed commits.

## Verification record · 2026-10-07

- SDK with Node 26.10.0: **52/52 passed**, including both built-core interop tests; compile-only API checks passed.
- SDK with Bun 1.4.2: **50/50 passed**.
- Core CTest: **4/4 passed** (render, IPC, control, core).
- Packed npm tarball installed in a clean consumer: exports, CLI binaries, publishing and warp/loading demo passed. Local Markdown links and whitespace checks passed.
- Schema pin: `c07a923f1f44f48c00daad1662fb19b05047b735`.
- Tested core: `4d53c2d679619e63104aaaa3ca807547288582e2`; migration RFCs: docs `114387dbd13a1a779ffda9e81293814adc94fc85`.

Full compositor integration, production supervisor/sandbox execution and portable extension hosts remain separate acceptance work.
