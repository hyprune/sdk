# RFC and schema gaps found during SDK M0

Read against docs RFC-0001/0003/0004/0005/0006/0007 (proposed 2026-10-07) and schema commit **96dad32178b14d0c50f64413430d054133d40425**. No upstream contracts or core files were changed. Proposals below require owner review and matching schema/changelog/negative fixtures before implementation in core.

## Missing control methods and world metadata

Tonight's requested mock includes camera, waypoint, `ui.open`, zones and notifications. IPC `0.1` permits exactly five state keys and twelve methods; zones, waypoint and camera commands are absent. `runtime.notice` supplies transient notifications but has no persisted notification center. RFC-0006 explicitly keeps movement proposal APIs out of `0.1`.

SDK default: exact `0.1`; pose in `movement`, notifications through `runtime.notice`. Zones and waypoint live in the scenario file. Opt-in **`0.1-mock.1`** adds `camera.set`, `waypoint.set`, `ui.open`, `world.metadata`, and `ui.opened`. It has a distinct generated JSON Schema; these messages are never accepted/advertised as core `0.1`. `ui.open` requires an owned shell lease and creates a visible, nonexclusive overlay, then emits the selected panel. It does not load a shell module. Metadata events replay on subscribe/resync; they are outside revisioned core state. `waypoint.set` returns the current core-state revision, not a fictitious waypoint transaction revision.

Proposed fix: a new protocol identifier with revisioned world metadata/waypoint state, explicit user-intent camera/navigation commands with distinct grants and bounds, and an approved shell panel registry. Specify whether notifications are transient or persisted. Keep motion intents separate from direct authoritative pose assignment; `camera.set` is a mock testing convenience.

## Integration publishing and host metrics

RFC-0007 reserves integration IDs but defines no data-source registration, value schema, publishing/subscription method or grant. RFC-0003's six capabilities do not authorize host process inspection. RFC-0007's required sandbox denies host `/proc`, so an isolated extension cannot implement tonight's `/proc` metrics example as requested.

SDK default: no production publishing API. Mock `data.publish`/`data.updated` are explicit `0.1-mock.1` demonstrations, gated by `state.read` only for local developer testing. This is **not** a proposed production authorization mapping. The system-pulse example runs as trusted local code, outside the distributable sandbox contract; manifests are not automatically launched by core or this SDK.

Proposed fix: core-owned metrics broker with a narrow `metrics.system.read` grant, source registration tied to approved contribution IDs, typed value schemas, sequence/timestamp/staleness/rate limits and per-source publish/read grants. Sandbox clients consume approved broker data rather than host `/proc`. Define lifetimes, revocation and reconnect replay before enabling installed integrations.

## Widget, movement and screen provider hosts

RFC-0007 explicitly leaves rendering shell-specific; RFC-0006 leaves third-party motion fast paths unspecified; RFC-0005 stages custom screen capture for M2. The current extension schema can reserve all four contribution types without an executable host contract.

SDK supplies valid manifests and runnable state-subscriber scaffolds for all four types. The widget is a terminal presentation. Screen scaffolds supply a validated planar descriptor, not pixels. Movement scaffolds do not submit motion or register a controller. No isolated install/launch functionality is claimed.

Proposed fix: host contracts and independent API identifiers, with capability/error/lifecycle fixtures, before the reserved contributions can be enabled. Specify a shell-supported widget entrypoint rather than assuming arbitrary QML injection.

## Launch and reconnect bootstrap

RFC-0003 requires a new one-use token from the supervisor for reconnect, but specifies no portable bootstrap channel, FD payload or environment names. Implementing transparent reconnect by reusing a token would violate the RFC.

SDK uses a `tokenProvider` callback for every connection and never retries mutations. Developer launcher supplies one raw hexadecimal token plus newline on FD 3, advertised only by `HYPRUNE_TOKEN_FD`; socket/client/protocol labels are `HYPRUNE_SOCKET`, `HYPRUNE_CLIENT_ID`, `HYPRUNE_PROTOCOL`. The one-shot FD helper disables reconnect. Library users must provide a real supervisor callback for authenticated reconnect. Core currently takes a JSON grant array via its separate `HYPRUNE_LAUNCH_FD`; that is daemon bootstrap, not the SDK client-token FD.

Proposed fix: ratify bounded bootstrap payloads and a private supervisor reissue channel (or a pre-authenticated inherited connection). Define expiry, restart binding, error handling and the shell's restart policy. Never add a persistent blanket token file or public token-issuance method.

## Node/Bun and Quickshell transport

RFC-0007 picks JavaScript, but does not choose a socket bridge for QML. Node's `net` and filesystem modules are unavailable inside Quickshell's JavaScript engine.

M0 SDK targets TypeScript with generated JavaScript on Node/Bun. Shell may consume fixtures/contracts through its own native AF_UNIX bridge; this package is not directly importable as QML. Proposed fix: specify/implement the Quickshell native socket bridge and expose the same state/call behavior, then run shared conformance fixtures. Python is not added because the RFC already chose the first client language.

## Schema semantic limits and validation naming

The schema validator intentionally does not check transport JSON duplicates/depth, files, archives, glTF, collision or GPU resources. RFC-0004 calls the future SDK author tool `world check`; tonight's requested CLI calls it `world validate`.

SDK's `world validate` combines the exact upstream validator with path/file/provenance coverage, Khronos glTF checks, graph/index/UV1 and codec-header checks, preliminary resource limits and deterministic digest. A passing result is not an authoritative collision/spawn-clearance, decoded image/GPU allocation, copyright or malicious-content audit. `world pack` snapshots and revalidates files before producing a deterministic `.tar.zst`; archive installation/extraction is not implemented.

Proposed fix: standardize the command name and publish separate authoring/runtime validation levels. Extend world/schema conformance with references and asset fixtures as appropriate; collision clearance and renderer allocation stay core-owned. Explicitly label schema-only validation wherever presented.

## Mock authorization boundary

RFC-0003 mandates SO_PEERCRED. Node's portable `net.Socket` API does not expose it. The SDK mock enforces private socket directories, mode 0600, one-use token/client/subset/expiry matching and refuses unsafe/live socket replacement, but cannot claim the production peer-credential boundary or sandbox isolation. Same-UID processes are already trusted developer code here.

Proposed fix: keep the mock scoped to development, or add a reviewed Linux transport adapter exposing SO_PEERCRED before production use. Production authorization remains in core.

## Current core interoperability observation

SDK conformance exercised independently built `core/build/hypruned` after core commit `ff1e7b5`: hello/token, ping, subscribe/snapshot/delta, advertised runtime exit and unsubscribe succeeded. A test-only private-plugin stand-in supplied schema-valid state; this did not start or modify Hyprland. Core's hello name limit is currently 128 bytes while the pinned schema permits 256 characters; SDK default names fit both. Proposed fix: align implementation bounds with the exact schema and add boundary/Unicode fixtures. Recheck after core changes; this observation is not a release compatibility guarantee.
