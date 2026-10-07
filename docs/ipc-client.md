# IPC client

The Node/Bun client implements RFC-0003's exact `0.1` control plane. `@hyprune/sdk` exports `HypruneClient`, `RpcError`, `StateStore`, `FrameDecoder`, `encodeFrame`, `parseJson`, `validateWire`, `socketPath` and generated types. Default socket resolution requires an absolute `XDG_RUNTIME_DIR` and a safe `HYPRLAND_INSTANCE_SIGNATURE`.

## Authentication

An unauthenticated connection gets hello and ping only. `ClientOptions.capabilities` is a request, not authority. `hello.capabilities` contains the actual approved subset, and `hello.methods` filters operations by grants. Calls to unadvertised methods reject with `RpcError(-32601)` before sending.

```ts
const client = new HypruneClient({
  socket: '/run/user/1000/hyprune/development/control.sock',
  client: { id: 'org.example.viewer', name: 'Viewer' },
  capabilities: ['state.read'],
  tokenProvider: () => supervisor.issueFreshLaunchToken(),
});
client.on('fault', error => console.error(error.message));
await client.connect();
await client.subscribe();
```

`supervisor` above represents the host-owned private bootstrap, not a public IPC method. A token is exactly 64 lowercase hexadecimal characters, consumed once and bound to client/session/subset/expiry. Never use a cached token for reconnect. `clientFromEnvironment()` consumes one inherited token FD, closes it and removes its environment label. It disables reconnect because the RFC has no reissuance bootstrap contract; supply a callback for long-lived connections.

## State and events

`subscribe()` atomically installs the response snapshot before processing later frames from the same socket read. Listen for typed `state` callbacks or inspect `client.snapshot`. `StateStore` replaces entire changed keys, validates the merged state, requires matching subscription/session/base revision, and accepts strictly advancing revisions (including coalesced jumps).

A gap suspends delta application and requests `state.snapshot`. Frames preceding that response are discarded during resync. Session-scoped IDs disappear on connection loss. Reconnect requests a new token, authenticates, re-subscribes and publishes a fresh snapshot. Backoff starts at 250 ms, includes jitter and caps at 10 seconds. Revocation stops automatic reconnect.

`runtime.notice` and `session.revoked` callbacks receive generated params types. `notification` exposes the full typed envelope; only advertised events are accepted. `ready`, `disconnect`, `reconnecting` and `fault` describe transport lifecycle.

`call()` derives parameter/result types from the pinned schema. Response IDs must match an outstanding call, and validation uses that call's method. Unknown/duplicate responses, invalid payloads or malformed transport close the connection. Calls are bounded to 64 pending operations; local output is bounded to 4 MiB. Default call deadline is 30 seconds. Ping is every ten seconds, with failure disconnecting by its deadline.

**Never automatically retry a mutation after disconnect/deadline.** Its response may have been lost after commit. Inspect fresh state and obtain new resource IDs before deciding whether another user action is needed.

## Framing and compatibility

Frame length is four-byte big-endian, followed by 1..1,048,576 UTF-8 bytes. Decoder handles split prefixes/bodies and coalesced frames; rejects invalid lengths, UTF-8, duplicate keys (including escaped equivalents), nonfinite numbers and nesting beyond 64. Partial frames expire after ten seconds. Server rejects batch envelopes and client notifications.

Node/Bun transport uses `net.Socket`. Quickshell must provide its native socket bridge and validate against the same fixtures/contracts; no direct Node API is assumed in QML. `mockCall()` is available only on explicitly negotiated `0.1-mock.1`; it cannot add methods to core `0.1`.
