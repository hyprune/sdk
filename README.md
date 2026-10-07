# Hyprune SDK · M0

Experimental TypeScript/JavaScript client, `hyprune-mock` development daemon, and `hyprune` author/debug CLI. MIT. **Protocol `0.1`, world/extension formats `0.1`, SDK `0.1.0`.** This repository contains no Hyprland ABI bindings or production daemon.

RFC-0007 chooses JavaScript as the first reference client. TypeScript supplies generated types and compiles to JavaScript for **Node >=22.12 and Bun**; Python is not a second reference implementation. Quickshell needs a native socket bridge; Node modules cannot be imported directly into QML.

Schemas and their Node validator are vendored unchanged from [`hyprune/schema`](https://github.com/hyprune/schema/tree/96dad32178b14d0c50f64413430d054133d40425), with SHA-256 verification. Builds never track sibling repositories or fetch schemas. `npm run generate` deterministically derives method, result, event, state and manifest types. The separate mock schema is generated from this pin plus explicit demo additions.

## Run tonight

```sh
cd /home/rick/workspace/hyprune/sdk
npm ci
npm test
npm run mock -- --demo
```

The last command launches a moving observatory, a real `/proc` system-pulse integration and a terminal widget. It uses `$XDG_RUNTIME_DIR/hyprune/$HYPRLAND_INSTANCE_SIGNATURE/control.sock` (instance `mock` when unset). To avoid a running core's socket, select a development socket explicitly:

```sh
npm run mock -- --socket "$XDG_RUNTIME_DIR/hyprune/sdk-demo/control.sock" --demo
```

Ctrl+C stops the supervised examples and daemon. `--duration 5` makes a bounded demo. No socket falls back to `/tmp`; missing/unsafe session environment is an error. Tests use explicitly selected private scratch sockets.

**Default mock protocol is the real `0.1`**: all twelve core methods, grant-filtered advertisement, schema-valid snapshots/deltas and transient `runtime.notice`. The fake scene includes surfaces, outputs and a player moving along a path; world zones/waypoint are in the scenario sidecar. `--demo` / `--experimental` opt into **`0.1-mock.1`** for camera/waypoint/UI commands, world metadata and data publishing. Those APIs do not exist in core `0.1`. The mock and examples are trusted developer tooling, not a sandboxed extension host. See [RFC gaps and proposals](NOTES-rfc-gaps.md).

## CLI

After `npm ci`, use `npm run hyprune -- …`, or `npm link` to expose both executables locally:

```sh
hyprune world validate examples/world-minimal
hyprune world pack examples/world-minimal --output /path/to/minimal.tar.zst
hyprune ext new widget ./my-widget --id org.example.mywidget
hyprune ext new screen-type ./my-screen
hyprune ext new movement-mode ./my-movement
hyprune ext new integration ./my-integration
```

World validation includes the exact schema validator, file/path/attribution checks, Khronos glTF validation, node/UV1 references and deterministic digest. Packing creates one-root, sorted `.tar.zst` with fixed timestamps/ownership; it requires GNU tar and zstd. Runtime collision/spawn clearance and final GPU allocation remain core checks. `examples/world-minimal` is an original empty scene authoring fixture.

Authenticate debug tools using the mock's one-use FD supervisor:

```sh
hyprune-mock --socket "$XDG_RUNTIME_DIR/hyprune/sdk-test/control.sock" \
  --launch hyprune ipc subscribe --count 10
hyprune-mock --socket "$XDG_RUNTIME_DIR/hyprune/sdk-test/control.sock" \
  --launch hyprune ipc call session.ping '{}'
hyprune-mock --socket "$XDG_RUNTIME_DIR/hyprune/sdk-test/control.sock" \
  --launch hyprune doctor
```

Tokens never appear in command arguments or logs. The daemon-side launcher approves `--capabilities` (default `state.read`); CLI independently requests its own `--capabilities`. A standalone `hyprune ipc call session.ping --socket …` needs no grant. Production read/control connections need the core supervisor's token.

## Library

Run this under an authorized supervisor (`HYPRUNE_TOKEN_FD`, `HYPRUNE_SOCKET`, `HYPRUNE_CLIENT_ID`):

```ts
import { clientFromEnvironment } from '@hyprune/sdk';
const client = clientFromEnvironment();
client.on('state', snapshot => console.log(snapshot.state.movement.position));
client.on('runtime.notice', notice => console.log(notice.code, notice.message));
await client.connect();
await client.subscribe();
await client.call('session.ping', {});
// client.close() when finished
```

`HypruneClient` supports a fresh-token `tokenProvider` per connection, bounded calls, method-context result validation, whole-key delta reduction, automatic resync and exponential reconnect with jitter. It takes a fresh subscription/snapshot after reconnect and **never retries mutations**. The one-shot inherited-FD helper disables reconnect; a supervisor callback enables authenticated reconnect. Listen for `fault`, `disconnect` and `ready`.

## Verification and documentation

```sh
npm test                    # independent SDK tests; optional core test skipped
npm run test:bun            # same protocol/tooling tests under Bun
HYPRUNE_CORE_BINARY=/path/to/core/build/hypruned npm test
```

The optional core test supplies a private plugin stand-in and does not start/change Hyprland. Local verification passed on Node 26.10.0 and Bun 1.4.2; core `ff1e7b5` passed the SDK round trip. GitHub Actions tests Node 22.12/24 and Bun. GitHub CI has not been run remotely; nothing was pushed.

- [Client and authentication](docs/ipc-client.md)
- [Mock, scenarios and shell development](docs/mock.md)
- [World validation and packing](docs/world-tools.md)
- [Extension scaffolds and examples](docs/extensions.md)
- [Tests, conformance and schema updates](docs/testing.md)
- [RFC gaps and proposed fixes](NOTES-rfc-gaps.md)
