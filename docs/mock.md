# Mock daemon and shell development

Build once with `npm ci`; launch with `npm run mock`. The default speaks real IPC `0.1`, serves synthetic state and accepts all twelve core methods subject to grants. It simulates installed worlds and free flight; walking rejects with `-32007`. Pointer focus does not grant keyboard focus. Shell output leases are exclusive, connection-owned and cleaned up on disconnect.

Select a private development instance to avoid a running core:

```sh
npm run mock -- --socket "$XDG_RUNTIME_DIR/hyprune/sdk-test/control.sock" \
  --scenario scenarios/observatory.json
```

This standalone listener gives no read/control grants without supervisor tokens. To launch a shell or SDK tool with an approved developer identity:

```sh
npm run mock -- --socket "$XDG_RUNTIME_DIR/hyprune/sdk-test/control.sock" \
  --client-id org.example.shell \
  --capabilities state.read,shell.control,world.control \
  --launch /path/to/shell-executable
```

The child inherits FD 3 containing a raw token plus newline. `HYPRUNE_TOKEN_FD=3`, `HYPRUNE_CLIENT_ID`, `HYPRUNE_SOCKET` and `HYPRUNE_PROTOCOL` carry labels, not secrets. The mock consumes a token once, checks identity/expiry and grants only the approved requested intersection. Child exit stops a single-launch mock. The programmatic `MockDaemon.issueToken()` is a private harness/supervisor API, never a public IPC call.

The socket directory is 0700, socket is 0600. Unsafe files/symlinks and live listeners are not replaced; owned stale sockets are probed before removal. Node does not supply portable SO_PEERCRED, so this is trusted developer tooling. It does not launch isolated third-party extensions or replace `hypruned`.

## Scenarios

`scenarios/observatory.json` includes three surfaces, two installed fake worlds, two zones, an interpolated pose path, a waypoint and timed notices. `scenarios/surface-lifecycle.json` removes/re-adds surfaces without motion.

A scenario document contains:

| Field | Meaning |
| --- | --- |
| `state` | Exact IPC state with runtime/world/surfaces/movement/shell. |
| `path` | Finite vec3 control points; interpolated across 2.5-second segments and looped. Empty disables automatic motion. |
| `worlds` | Installed fake IDs with accepted spawn slugs. Unknown loads fail atomically. |
| `zones`, `waypoint` | Development metadata; not extra `0.1` state fields. |
| `notices` | `{atMs, level, code, message}` transient `runtime.notice` events. |
| `transactions` | Optional `{atMs, changes}` whole-key state replacements. |
| `tickMs` | Optional simulation sample interval >=34 ms; default 100 ms. |

Load-time checks validate the starting state, paths, world IDs/spawns, zones, notices and transaction shapes. Deltas coalesce to at most 30 per second per peer, keep each peer's original baseline and deliver the latest whole-key replacements. Subscribe/snapshot responses precede later deltas. Resource creation that would exceed the frame budget rejects.

Programmatic tests can call `commit`, `disconnectClients`, `revokeClients` and `stop`; restarting creates a new session. Real-time timers mean scenarios are scriptable, not deterministic physics replays.

## Explicit experimental demo

```sh
npm run mock -- --socket "$XDG_RUNTIME_DIR/hyprune/sdk-demo/control.sock" --demo
```

`--demo` launches trusted `/proc` integration and terminal widget and selects `0.1-mock.1`. `--experimental` selects the same protocol without launching examples. Both sides must opt in; production `0.1` validation rejects these additions.

| Method/event | Behavior |
| --- | --- |
| `camera.set` | Replaces pose; normalized quaternion required; pauses path for one second. |
| `waypoint.set` | Replaces scenario waypoint and emits metadata. |
| `ui.open` | Requires the caller's lease/output, opens nonexclusive overlay and emits `ui.opened` with panel ID. |
| `data.publish` / `data.updated` | Fixed system-metrics object, cached by source ID and replayed on subscribe/resync. |
| `world.metadata` | Zones and waypoint replayed on subscribe/resync/world load. |

Experimental metadata/data events sit outside the five-key revisioned state. Their methods return the current state revision. New production host APIs require a new RFC/schema/grants; see [the gap record](../NOTES-rfc-gaps.md).
