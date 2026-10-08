# Hyprune SDK · IPC 0.1–0.5

TypeScript/JavaScript client, `hyprune-mock` development daemon, and `hyprune` author/debug CLI. MIT. **SDK `0.3.0`, default IPC `0.2`, explicit IPC `0.1` compatibility.** World formats `0.1`/`0.2`/`0.3` are supported; extension and screen manifests remain `0.1`.

RFC-0007 chooses JavaScript as the first reference client. TypeScript supplies generated types and compiles to JavaScript for **Node >=22.12 and Bun**; Python is used only by the core test harness. Quickshell needs its own native socket bridge; Node modules cannot be imported directly into QML.

Schemas and their Node validator are vendored unchanged from [hyprune/schema at 2f8e80e](https://github.com/hyprune/schema/tree/2f8e80e458a930550034206da4458d857a1b1a4a), with SHA-256 verification. Builds neither follow sibling repositories nor fetch schemas. `npm run generate` derives method, result, event, state and manifest types for all five protocols. The former `0.1-mock.1` contract has been removed.

## First real session

SDK 0.3.0 adds explicit IPC `0.3` clients and generated spatial/workspace/binding
types. Existing default clients and the mock remain IPC 0.2. Use
`new HypruneClient({protocol:'0.3', ...})` for core's first-session contract.
`../core/dev/hyprune-dev up|smoke|record` starts the locked nested real session.
The core launcher consumes the built Switchyard package, starts core and shell
with one-use FD tokens, and supplies terminal/btop/browser apps. It never uses
the SDK mock. See core/docs/FIRST-SESSION.md for reproduction and evidence.

## Run the mock

```sh
cd /home/rick/workspace/hyprune/sdk
npm ci
npm test
npm run mock -- --socket "$XDG_RUNTIME_DIR/hyprune/sdk-demo/control.sock" --demo
```

This launches the moving observatory, a real `/proc` system-pulse publisher and a terminal widget. Use a private development socket. Ctrl+C stops the supervised examples and daemon; `--duration 5` bounds a demo. Socket defaults require a valid session environment; there is no fallback to `/tmp`.

For shell warp-overlay development:

```sh
npm run mock -- --socket "$XDG_RUNTIME_DIR/hyprune/sdk-warp/control.sock" \
  --scenario scenarios/warp.json --demo --duration 4
```

The scenario starts a timed warp at 700 ms and a world load at 1700 ms. Both use real `0.2` methods and `location.transition` state/events. Replace `--demo --duration 4` with `--client-id org.example.shell --capabilities state.read,shell.control,movement.control,world.control --launch /path/to/shell-executable` to supervise a shell instead. The child must request the granted capabilities through its own hello.

The mock supports all 26 methods: camera, waypoint/routes, travel/autodrive, owned UI leases, world loading and data publication, plus the original methods. It serves seven revisioned state keys and exact five-key legacy projections. `--protocol 0.1` selects a legacy-only listener. It is trusted developer tooling; simulation does not replace core collision, rendering or authorization.

## CLI

After `npm ci`, use `npm run hyprune -- …`, or `npm link` to expose both executables:

```sh
hyprune world validate examples/world-minimal
hyprune world pack examples/world-minimal --output /path/to/minimal.tar.zst
hyprune ext new widget ./my-widget --id org.example.mywidget
hyprune ext new screen-type ./my-screen
hyprune ext new movement-mode ./my-movement
hyprune ext new integration ./my-integration
hyprune-mock --socket "$XDG_RUNTIME_DIR/hyprune/sdk-test/control.sock" \
  --launch hyprune ipc subscribe --count 10
hyprune-mock --socket "$XDG_RUNTIME_DIR/hyprune/sdk-test/control.sock" \
  --launch hyprune ipc call session.ping '{}'
hyprune-mock --socket "$XDG_RUNTIME_DIR/hyprune/sdk-test/control.sock" \
  --launch hyprune doctor
```

World validation combines the upstream schema/semantic validator with file, provenance and Khronos glTF checks. Packing produces a deterministic single-root `.tar.zst`; GNU tar and zstd are required. Runtime collision/spawn clearance and final GPU allocation remain core checks.

Tokens are passed through a one-use inherited FD, never command arguments or logs. The mock supervisor approves `--capabilities`; the CLI independently requests its `--capabilities`. Debug commands accept `--protocol 0.1` for a legacy daemon; default is `0.2`. An unauthenticated connection may hello/ping only.

## Library

Run under an authorized supervisor supplying `HYPRUNE_TOKEN_FD`, `HYPRUNE_SOCKET`, `HYPRUNE_CLIENT_ID` and `HYPRUNE_PROTOCOL`:

```ts
import { clientFromEnvironment } from '@hyprune/sdk';
const client = clientFromEnvironment({ protocol: '0.2', capabilities: ['state.read'] });
client.on('state', snapshot => console.log(snapshot.state.location.transition));
client.on('location.transition', event => console.log(event.phase, event.progress));
await client.connect();
await client.subscribe();
console.log(await client.call('camera.get', {}));
client.close();
```

`HypruneClient` validates against the negotiated schema, reduces whole-key deltas, resyncs gaps and reconnects with exponential backoff and a fresh-token callback. It takes a fresh snapshot after reconnect and **never retries mutations**. The inherited-FD helper disables reconnect; long-lived callers must supply a supervisor callback and enable reconnect. Presentation events are hints; revisioned state is authoritative.

System-pulse now uses the real `data.publish` grant/method, increasing sequences and TTL. The widget reads `state.integrations.sources`. The extension manifest schema cannot yet declare `data.publish`: the demo uses a separate, explicitly trusted `launch.json`. This is documented in [the remaining RFC gaps](NOTES-rfc-gaps.md), alongside the sandbox metrics broker and production supervisor work.

## Verification and documentation

```sh
npm test                    # 50 SDK tests; two optional core tests skipped
npm run test:bun            # 50 protocol/tooling/mock tests
HYPRUNE_CORE_BINARY=/path/to/core/build/hypruned npm test
```

Local verification: **52/52 Node tests with built core**, **50/50 Bun tests**, and **4/4 core CTest tests**. The core harness launches real `hypruned` and links actual core `Control`, simulation and world-loading code behind a private plugin stand-in. It starts no compositor and touches no owner session. See [scope and reproduction](docs/testing.md).

- [Client and authentication](docs/ipc-client.md)
- [Mock, scenarios and shell development](docs/mock.md)
- [World validation and packing](docs/world-tools.md)
- [Extension scaffolds and examples](docs/extensions.md)
- [Tests, conformance and schema updates](docs/testing.md)
- [RFC gaps and proposed fixes](NOTES-rfc-gaps.md)

## M3A hands-on desktop contract

Use `new HypruneClient({protocol:'0.5', ...})` for revisioned `interaction` mode,
selected tool, five slots, noclip and cursor state, plus workspace `apps` metadata.
Custom mounts include metre pose/size with an empty authored anchor ID. IPC 0.4
mount methods and generated types are also available. StateStore validates the
negotiated exact snapshot/delta before installation; old contracts remain isolated.
The mock continues to implement IPC 0.1/0.2 only. Rendering, hand input, cursor
ownership and Lua config validation belong to core; see core/docs/M3A.md.
