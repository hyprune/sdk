# Mock daemon and shell development

Build with `npm ci`, then `npm run mock`. The default is real IPC **0.2**, with all 26 methods filtered by grants, seven-key snapshots/deltas and subscribed-reader UI/data/location hints. The same listener accepts 0.1 with frozen method discovery and five-key projections; `--protocol 0.1` makes it legacy-only; `--protocol 0.21`, `0.22`, `0.23`, `0.24`, `0.25` and `0.26` add the quest, object, character, live, companion and debug-tool projections below. `0.1-mock.1` and `--experimental` have been retired.

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

## Objects and libraries (IPC 0.22)

`--protocol 0.22` (or `new MockDaemon({protocol:'0.22'})`) negotiates 0.22 next to 0.21,
0.2 and 0.1. 0.22 peers get the 0.21 projection plus the `objects` key, `editor.gizmo`
(`world`, `centre`, no snapping) and the object pocket items in `editor.unplaced.objects`
(`count` adds them to the windows). Older peers keep their exact projections: no
`objects` key, no object methods, no `rule` in error data and no object notices.
Developer grants may include `objects.control` (`OBJECT_GRANTS`, `grantsFor(protocol)`).

- **Catalog.** The observatory world has two package assets: `armillary` (decorative,
  not placeable) and `reading-chair` (movable), placed as the authored instances
  `observatory-armillary` and `reading-chair`. A system library
  `com.hyprune.starter@0.1.0` lists `server-rack`, `street-lantern`, `wall-clock`,
  `guide` (a character: not placeable) and `mine-cart` (a mover: not placeable). User
  objects are the fixtures `desk-plant` and `broken-lamp` (invalid), or, with
  `--object-dir dir` / `objectDir` (the CLI defaults to `$HYPRUNE_OBJECT_DIR`), the real
  folder: every slug-named directory is checked with `validateObject`, cached by a stat
  fingerprint and rescanned every second; a change bumps `catalogRevision`.
  `objects.catalog` returns `catalogRevision` as its `revision`; library objects appear
  at their highest installed version with the others in `versions`.
- **Placements.** `objects.place` without a pose tries 2, 1.5 and 1 m in front of the
  player, on the zone floor for floor objects, facing the player. The mock's rules are
  boxes: `playable` (inside a scenario zone), `walls` (scenario obstacles), `support`
  (floor objects within 5 cm of the zone floor) and `player` (collidable objects against
  the player capsule); window, approach, zone, keep-clear and reach are core-only.
  Placing a ref that is in the pocket uses that pocket item (the mock has no tool 5).
  `transform`, `hide`, `reset` (authored: drops the override; user: upright with the
  yaw kept, scale 1), `remove` (`{all:true}`: every user placement of the world, locked
  ones included) and `configure {patch:{locked}}` follow the contract; a locked
  instance refuses transform, hide, remove and a user reset.
- **Errors.** -32004 unknown ref or id, -32005 not placeable, not movable, locked,
  removing an authored instance, hiding a user placement, a system library or no
  loaded world; -32007 with `{retryable:false, rule}`; -32008 with rule `budget` (the
  per-world limits, the 16-item pocket); -32602 a scale outside the object's range, a
  non-unit rotation, a hash mismatch or an invalid archive.
- **Libraries.** `libraries.install` hashes the archive, applies the archive member
  rules (one root named by the id, regular files and directories only, no unsafe
  paths, at most 4,000 members, 32 MiB per file, 512 MiB), extracts it to a temporary
  directory, runs `validateLibrary` and keeps only the records in memory (root `user`).
  The same id@version with the same content digest succeeds again; different content is
  `-32007` `library.conflict`. `libraries.remove` refuses system roots; user placements
  of the removed version move to the highest installed version with the same major
  (`object.substituted`) or read `missing` (`object.missing`).

## Characters, paths and interactions (IPC 0.23)

`--protocol 0.23` (or `new MockDaemon({protocol:'0.23'})`) negotiates 0.23 next to every
older version. 0.23 peers get the 0.22 projection plus the `npcs` key, the 0.23 object
instance fields (`character`, `accent`, `path`, `activity`, `seat`), the 0.23
`editor.paths` (user paths with `use`, `name`, `speed`, `stops`) and the reticle action
`interact` on an aimed character. 0.22 peers of a 0.23 listener see the characters as
plain instances (null `path`, `activity` and `seat`, no `character` or `accent`) and a
`click` reticle; 0.21 peers see user paths in their editor shape. Character and path
notices (`npc.*`, `path.*`) reach 0.23 peers only. No new grant: `NPC_GRANTS` equals
`OBJECT_GRANTS`. A 0.22 listener keeps its 0.22 world (no characters).

- **Fixtures.** The observatory gains the package character assets `keeper` and
  `astronomer`, the authored characters `keeper` (walking the closed package route
  `gallery-loop` with the interactions `chat` (`say`, three lines) and `desk`
  (`waypoint` to the work zone)) and `astronomer` (standing in the work zone with
  `hello`, a two-line `say`), and the generic package path `survey-line`. The starter
  library's `guide` is the user-spawnable character.
- **Characters.** `npcs.spawn` takes a character ref and a route (`path`; a bare id is
  `package/<id>`), a standing spot (`pose`, checked by the 0.22 box rules) or neither (in
  front of the player). User characters are placements (`u-xxxxxx`, scale 1, not
  movable) and count against the 0.22 object budgets and the 8 user characters per world;
  a path carries at most 8 characters. `npcs.bind` changes a user character's route,
  standing spot, phase, speed, accent or direction; `npcs.disable` hides authored and
  user characters (`objects.hide` on an authored character does the same);
  `npcs.remove` removes user characters (`{all:true}` leaves other placements;
  `objects.remove` on a user character does the same). `objects.place` with a character
  refuses (`use npcs.spawn`); `objects.transform`, `configure`, `pocket` and a user
  `reset` refuse characters (`characters are protected`).
- **Routes and motion.** Paths are sampled with the world 0.9 segment geometry (24
  samples per segment: `line`, the Hermite `curve`, the bowed `arc`; `samplePath`). A
  route is walkable when it has at least 2 points and every sample lies inside a zone,
  within 0.35 m above its floor and clear of the scenario obstacles (grown by 0.35 m);
  `problems` name the first failures with their positions. There is no collision mesh,
  navmesh, keepClear or seat check. While `npcs.state` is `animating`, route characters
  walk at 1.2 m/s (or the path's `speed`) times their own speed, turning at the ends of
  open routes; positions publish at most twice a second. Stops and seats are listed but
  not acted out.
- **Paths.** `paths.list` returns the package and user paths of the world with
  `walkable` (null when not a route), `problems` and `bound`. `paths.set` creates
  `path-<n>` or replaces a user path, checking stop indices, track and generic stop rules
  and walkability (`-32007` rule `walkable`); package ids are protected (`-32005`) and a
  bound path must stay a walkable route. `paths.remove` refuses package paths and, unless
  `unbind`, paths with characters (they then stand where they are). `paths.draw`
  creates an empty user path, selects tool 3 (`editor.tool`, `interaction.tool`) and shows
  `npcs.drawing`; `drawPoint(position, type)` simulates a tool-3 click. `paths.finish`
  saves it and, for a `spawn` or `bind` draw, places the character on it, or keeps the
  path and sends `path.unwalkable` when it is too short or unwalkable. A second draw
  replaces the first (an empty earlier path goes away).
- **Interactions.** `aimed` is the nearest active character with interactions within
  3 m of the player (the mock has no reticle ray); `use()` simulates E: it advances a
  running `say`, runs a single interaction or offers the `choose` list.
  `interaction.choose` runs `say` (each call shows the next line; past the last one the
  interaction ends), `waypoint` (sets `location.waypoint`), `guide` and `panel` (shown
  until ended), and `interactionId: null` ends it. The character's activity is
  `interacting` (or `guiding`) meanwhile. Disabled characters and `npc_motion: off`
  offer none (`-32005`).
- **Graphics and power.** `graphics.get/set` (state.read/world.control; 0.23 peers of the
  mock only) return a fixed configuration with `npc_motion` (default `auto`) and
  `reduced_motion` honoured. `npcs.state` is `none` without active characters, `off` or
  `still` from the setting, `paused` with reason `inactive` when world mode is off,
  `reduced motion`, or the power profile under `auto`: `setPowerProfile(profile)`
  simulates the offload power profile (`full-ac` and `limited-ac` animate; `battery`,
  `usb-c` and `unknown` pause with `battery`, `usb-c power`, `power unknown`).
- **Errors.** -32004 unknown ref, id, path or interaction; -32005 not a character,
  authored characters (bind, remove), package paths, bound paths without `unbind`,
  disabled characters or no world; -32007 with rule `walkable` (or a 0.22 placement rule
  for a standing spot); -32008 rule `budget` with an `npc.budget` notice; -32602 stop
  indices, `reverse` without a path, spawn or bind on a non-route draw.

## Live machines (IPC 0.24)

`--protocol 0.24` negotiates 0.24 next to every older version. 0.24 peers get the 0.23
projection plus the `live` key, and `objects.catalog` entries carry `machine` (the
fixture `server-rack` declares `health` (enum, repeat 4) and `load` (number 0–1);
manifests from the user folder or installed libraries keep their `traits.machine`
inputs; every other entry has `machine: null`). Peers below 0.24 see neither. No new
grant: `LIVE_GRANTS` equals `NPC_GRANTS`.

Every active user placement of a machine entry is bound by default, at most 64: input
`<id>` reads source `com.hyprune.sources.<instance id>`, key `<id>` (`<id>.N` for a
repeated input), from the mock's integrations state, so a client with id
`com.hyprune.sources` and `data.publish` can feed it. A value whose type fits passes
through (numbers clamped to `min`/`max`, text cut to `maxLength`) as `fresh`; a mismatch
is `error` and shows the input's default; no value is `missing` with the default, `raw`
and `publishedAt` null. `_status` and `_error` become the instance's `status` and `error`
(`_status: "error"` makes every published input `error`); `stale` is true while any
input is in error. The mock has no stale threshold and applies no mappings.
`publishedAt` is the publication's wall-clock time.

## Companions (IPC 0.25, draft)

`--protocol 0.25` negotiates 0.25 next to every older version. 0.25 peers get the 0.24
projection plus the `companion` key, and `objects.catalog` entries carry `companion`: null
for non-characters, else `{capable, name, reason}`. Library and user characters are
capable up to 2.0 m tall and 16,000 triangles (core also checks the width, GPU memory and walk speed); a world's own characters (`package/` refs)
are not (they stay in their world). The fixture starter library's `guide` is capable.
No new grant: `COMPANION_GRANTS` equals `LIVE_GRANTS`.

The mock does not walk, plan or check the view: following, the companion stands 2 m
behind the player along their view; `companion.mode {mode: "stay"}` (or the `stay`
interaction) keeps it where it stands; bound to a route (`npcs.bind {id: "companion",
path}` or `paths.draw {bind: "companion"}` then `paths.finish`, which returns `bound:
"companion"`), it stands at the route's first point with activity `walking` and
`paths.list` lists it in `bound`. `npcs.bind {pose}` puts it on a spot. Bindings are per
world and not persisted; `companion.clear` forgets the choice. Notices `companion.*` reach
0.25 peers only.

## Debug tool, pace and pocket (IPC 0.26)

`--protocol 0.26` negotiates 0.26 next to every older version. 0.26 peers get the 0.25
projection plus: `editor.toolDefinitions` with slot 9 (`DEBUG_TOOL_DEFINITION`: Inspect,
Close info card, Debug layer) after slots 1–5, the world action `tool9` bound to `9`,
`editor.debugTool: null` (the mock never takes out the debug tool) and `companion.pace`.
`companion.mode {mode, pace}` and the companion's `walk`/`run` interactions set the pace;
it stays across modes and companions. The mock pockets no windows, so the 128-item pocket
list only shows in validation. No new grant: `DEBUG_TOOL_GRANTS` equals
`COMPANION_GRANTS`.

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

Programmatic harnesses can use `commit`, `runAction`, `objects` (the 0.22 engine), `npcs` (the 0.23 engine), `project(snapshot, protocol)` (0.24: `liveView`, 0.25: `companionView`, 0.26: `debugToolView`), `companion` (the 0.25 engine), `hold`, `escape`, `use`, `drawPoint`, `setPowerProfile`, `disconnectClients`, `revokeClients`, `stop`. Restart creates a new session. Scenarios use real timers, not deterministic physics replay. No scenario action installs an extension, loads arbitrary code or injects input into the owner's compositor.
