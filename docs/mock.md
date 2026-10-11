# Mock daemon and shell development

Build with `npm ci`, then `npm run mock`. The default is real IPC **0.2**, with all 26 methods filtered by grants, seven-key snapshots/deltas and subscribed-reader UI/data/location hints. The same listener accepts 0.1 with frozen method discovery and five-key projections; `--protocol 0.1` makes it legacy-only. `0.1-mock.1` and `--experimental` have been retired.

Use a private development socket:

```sh
npm run mock -- --socket "$XDG_RUNTIME_DIR/hyprune/sdk-test/control.sock" \
  --scenario scenarios/observatory.json \
  --client-id org.example.shell \
  --capabilities state.read,shell.control,movement.control,world.control \
  --launch /path/to/shell-executable
```

The child receives a one-use raw hexadecimal token plus newline on FD 3. Environment labels are `HYPRUNE_TOKEN_FD=3`, `HYPRUNE_CLIENT_ID`, `HYPRUNE_SOCKET`, `HYPRUNE_PROTOCOL`. Client hello must request the approved capabilities; only the intersection is granted. Child exit stops a single-launch mock. `MockDaemon.issueToken()` is a private supervisor/test API, never an IPC call. Standalone listeners grant nothing without tokens.

Private directories are 0700 and the socket is 0600. Unsafe files/symlinks and live listeners are never replaced. Node lacks portable SO_PEERCRED, so the mock is trusted developer tooling, not a production authorization boundary or extension sandbox.

## Warp/location-transition scenario

```sh
npm run mock -- --socket "$XDG_RUNTIME_DIR/hyprune/sdk-warp/control.sock" \
  --scenario scenarios/warp.json --demo --duration 4
```

This runs system-pulse and the terminal widget. For wire-level observation, replace `--demo --duration 4` with `--duration 4 --launch node dist/src/cli.js ipc subscribe`.

At 700 ms, `travel.start` warps to the gallery over 550 ms: `departing`, `travelling`, `arrived`, with stable ID, output, destination and monotonic timestamp. At 1700 ms, `world.load` starts the garden's 450 ms simulated load: `loading` with null progress, then atomic world/pose/location activation and `arrived`. State retains the terminal transition. Shell overlays should reconcile hints with `state.location.transition`, hide terminal phases and recover correctly after reconnect/resync; no hint replay is needed.

## Methods and simulation

Camera get/set, waypoint set/clear and route set/clear operate on authoritative state. Zone targets resolve to the zone center at minimum Y + 1.7 m. Camera/navigation commands stop the decorative pose path. Travel start/cancel has the real bounded duration and terminal phases; zero-duration arrival is supported. Autodrive follows route targets and can stop at scenario AABB obstacles. The obstacle model approximates core behavior; it is not the core capsule/triangle solver.

World loads accept installed fake IDs/spawns only. Per-world `loadMs` and `failLoad` exercise loading, atomic success and old-world preservation. Unknown fake IDs/spawns return `-32003`; scripted asset failures return `-32602`. Core's missing-package classification still differs; see [gap notes](https://github.com/hyprune/sdk/blob/main/NOTES-rfc-gaps.md). Requester disconnect cancels pending loads; committed timed travel may continue. Walking remains unsupported by the mock; it simulates free flight. Pointer focus does not grant keyboard focus.

UI open/close requires an owned lease/output. Nonexclusive leases match M1; exclusive input rejects with `-32007`. Private `hold()` / `escape()` input simulation implements the core-owned 350 ms threshold; taps do nothing and release retains an opened panel. Motion/load/exit closes UI and emits matching hints. These input helpers are not wire methods.

Data publishing enforces the separate grant, namespace, connection ownership, increasing sequence, scalar/map/aggregate bounds, 10 Hz rate and TTL. Removal, expiry and disconnect replace `integrations` state. Only subscribed 0.2 readers get hints; publishers do not need read access. See [client details](ipc-client.md).

## Quests and focus sessions (IPC 0.21)

`--protocol 0.21` (or `new MockDaemon({protocol:'0.21'})`) also negotiates IPC 0.21 next
to 0.2 and 0.1. 0.21 peers get the 0.2 keys, fixed neutral values for keys the mock does
not model (spatial, workspaces, mounts, presentation, interaction, apps, keymap, editor)
and the `markers`, `quests` and `focus` keys; 0.2 and 0.1 peers keep their exact
projections and never see the new methods or events. Developer grants may include
`quest.control` (`QUEST_GRANTS`).

- Personal quests live in memory (nothing is written to disk): create (id derived from
  the title, `-2`, `-3`… on collisions), update (progress kept for surviving ids),
  delete, track/untrack, accept/abandon/resume, mark (manual objectives of a current
  step), expiry to `failed`, at most 64. The first active quest is tracked automatically.
  Errors follow the contract: -32003 unknown, -32004 illegal transition, -32007
  non-personal, -32008 over limits.
- `guidance.get`/`guidance.set` keep in-memory overrides over the RFC defaults (`path` is
  empty).
- `markers.reveal` sets `markers.reveal` for `durationMs` (default `markers.reveal_ms`) plus
  a 600 ms fade; in `toggle` mode a second call hides it. Markers come from the waypoint,
  the current steps of active quests (tier 1 when tracked, else 2), the scenario zones
  (tier 4 places) and a workspace focus target. Zone targets resolve; areas, places and
  workspace homes do not exist in the mock, so their position is null.
- Focus sessions run on the real clock with pause/resume/skip/stop, short and long
  breaks, `auto_start_breaks`/`auto_start_work`, `focus.phase` events and an in-memory
  history. Every work second credits (wall mode); a completed interval with enough
  credit advances matching `focus` objectives and emits `quest.progress`.

## Scenario files

`observatory.json` provides surfaces, zones, waypoint, a looping pose path and timed notices. `surface-lifecycle.json` removes/re-adds surfaces. `warp.json` demonstrates navigation and world loading using real methods.

| Field | Meaning |
| --- | --- |
| `state` | Exact seven-key IPC 0.2 state, including `location` and `integrations`. |
| `path` | Finite vec3 points; looped interpolation over 2.5-second segments. Empty disables decorative motion. |
| `worlds` | Installed fake IDs/spawn slugs, optional zones, `loadMs` (0–10000), `failLoad`. |
| `notices` | `{atMs, level, code, message}` transient `runtime.notice`. |
| `transactions` | `{atMs, changes}` whole-key replacements. |
| `actions` | `{atMs, method, params}` real 0.2 commands executed by the private supervisor. |
| `input` | `{atMs, kind: "hold", pressed}` or `{atMs, kind: "escape"}` native-input simulation. |
| `obstacles` | Optional ordered AABBs for approximate autodrive/arrival checks. |
| `tickMs` | Sample interval ≥34 ms, default 100. |

Starting state, targets, transactions, commands and timing are checked before listening. Deltas coalesce to at most 30 Hz, retain each peer's baseline and replace complete keys. Snapshot/subscribe responses precede later deltas. Oversized resource creation rejects before commit.

Programmatic harnesses can use `commit`, `runAction`, `hold`, `escape`, `disconnectClients`, `revokeClients`, `stop`. Restart creates a new session. Scenarios use real timers, not deterministic physics replay. No scenario action installs an extension, loads arbitrary code or injects input into the owner's compositor.
