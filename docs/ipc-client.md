# IPC client · 0.2 migration

The Node/Bun client implements RFC-0003's `0.2` control plane and preserves explicit `0.1` compatibility. Exports include `HypruneClient`, `RpcError`, `StateStore`, `FrameDecoder`, `encodeFrame`, `parseJson`, `validateWire`, `socketPath`, `clientFromEnvironment` and generated types. Default socket resolution requires an absolute `XDG_RUNTIME_DIR` and safe `HYPRLAND_INSTANCE_SIGNATURE`.

## Authentication and versions

An unauthenticated connection gets hello and ping only. Requested capabilities are not authority: hello reports the approved subset and filters methods by grants. Calls to unadvertised methods reject locally with `RpcError(-32601)`.

```ts
import { HypruneClient } from '@hyprune/sdk';
const client = new HypruneClient({
  protocol: '0.2',
  socket: '/run/user/1000/hyprune/development/control.sock',
  client: { id: 'org.example.navigator', name: 'Navigator' },
  capabilities: ['state.read', 'movement.control', 'world.control'],
  tokenProvider: () => supervisor.issueFreshLaunchToken(),
});
client.on('fault', error => console.error(error.message));
await client.connect();
await client.subscribe();
await client.call('waypoint.set', { id: 'desk', target: { position: [2, 1.7, -4] }, label: 'Desk' });
await client.call('travel.start', { to: { position: [2, 1.7, -4] }, durationMs: 600 });
```

`supervisor` represents a private host bootstrap, not an IPC method. Tokens are exactly 64 lowercase hexadecimal characters, consumed once and bound to client/session/subset/expiry. `clientFromEnvironment({protocol: '0.2'})` consumes `HYPRUNE_TOKEN_FD` containing the raw token plus one newline, closes the FD and removes its environment label. Socket/client/protocol labels are `HYPRUNE_SOCKET`, `HYPRUNE_CLIENT_ID`, `HYPRUNE_PROTOCOL`. Core's separate daemon-side `HYPRUNE_LAUNCH_FD` carries JSON grants, not a client token.

The one-shot FD helper disables reconnect. Long-lived clients must supply a fresh-token callback and enable reconnect. Bootstrap labels/payload are ratified in 0.2; the portable supervisor renewal channel remains unspecified.

`new HypruneClient({protocol: '0.1'})` selects frozen legacy method/state types. Negotiation requests exactly the configured version; there is no silent fallback. Default `HypruneClient` uses `0.2`; the environment helper can select either and returns a protocol union unless explicitly typed/configured. `MethodMap`/`Ipc02_*` describe 0.2; `LegacyMethodMap`/`Ipc_*` retain 0.1. The retired mock protocol and `mockCall()` are removed.

## Authoritative state and hints

State contains `runtime`, `world`, `surfaces`, `movement`, `shell`, `location`, `integrations`. Location holds zones, waypoint, route, autodrive and transition; integrations hold live sources. A delta replaces every included key completely, including source removal/expiry. Legacy peers receive only the original five keys.

`subscribe()` installs its response snapshot before processing later frames in the same read. `StateStore` requires matching subscription/session/base revision, strictly advancing revisions and valid merged state. Gaps suspend deltas until a fresh `state.snapshot`; earlier frames during resync are discarded. Reconnect authenticates with a new token, re-subscribes and installs a fresh snapshot. Backoff starts at 250 ms, includes jitter and caps at ten seconds; revocation stops reconnect.

Typed `location.transition`, `ui.opened`, `ui.closed`, `data.updated` callbacks are subscribed-reader presentation hints. They carry session/revision and are not replayed. The client drops hints from another session, during resync, or older than its snapshot/latest accepted hint revision. Hints never mutate the state reducer. `notification` exposes the full typed envelope; only advertised events are accepted. `runtime.notice` remains a transient notice when advertised.

A warp overlay uses `location.transition` hints for prompt presentation and reconciles with snapshots/deltas. Transition IDs remain stable across phases; fields include output, destination, progress and monotonic timestamp. `loading` has unknown progress (`null`); `arrived` is 1. Terminal phases (`arrived`, `cancelled`, `failed`) remain in snapshots, so reconnect must not reopen a completed warp. `world.load` emits loading before its RPC reply and commits activation atomically; failure preserves the old world.

Targets are either `{position: [x,y,z]}` in eye coordinates or `{zoneId}`. Camera set rejects roll/unsupported vertical pitch. Travel intentionally warps through geometry; core validates arrival. Autodrive remains core-owned route following, not an extension motion fast path.

## UI and data

UI operations require an owned output lease and `shell.control`. Core owns the 350 ms hold timing: tap does nothing, release leaves the panel open, Escape dismisses, F12 exits. The shell renders requests; it does not invent a competing hold timer. M1 supports nonexclusive leases only; `exclusiveInput: true` returns `-32007` pending trusted Wayland association. Motion and loading dismiss overlays.

Publishing uses its own `data.publish` capability, without requiring `state.read`. Source IDs equal or descend from the authenticated client namespace; a connection owns its sources. Sequences are nonnegative safe integers and must increase during a live source lifetime. Values are complete scalar maps, at most 32 properties, strings up to 256 characters, at most 16 KiB per map / 64 KiB aggregate; at most 32 live sources. TTL is 100–60000 ms (default 5000), rate at most 10 Hz per source. TTL, removal and disconnect remove authoritative state; hints are never a metrics cache.

## Transport and call safety

Length framing is four-byte big-endian followed by 1–1048576 UTF-8 bytes. The decoder handles split/coalesced frames and rejects invalid lengths, UTF-8, duplicate keys (including escaped equivalents), nonfinite numbers and depth beyond 64. Partial frames expire after ten seconds; batches and client notifications are rejected.

Calls use generated parameter/result types and method-context response validation. Unknown/duplicate IDs or malformed payloads close the connection. Limits are 64 pending calls, 4 MiB local output, default 30-second call deadline. Ping runs every ten seconds. Lifecycle events include `ready`, `disconnect`, `reconnecting`, `fault`.

Never retry a mutation automatically after disconnect/deadline: its reply may have been lost after commit. Inspect fresh state and obtain new resource IDs before deciding whether another user action is needed. Quickshell must implement its native socket bridge against these contracts; Node's transport cannot run inside QML.
