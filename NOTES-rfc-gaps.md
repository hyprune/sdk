# RFC/schema gaps · IPC 0.2 update

Reviewed amended RFC-0003 and RFC-0001/0005/0006/0007 at docs commit `114387dbd13a1a779ffda9e81293814adc94fc85`, schema `c07a923f1f44f48c00daad1662fb19b05047b735`, and built core `4d53c2d679619e63104aaaa3ca807547288582e2`. Upstream repositories were pulled; no upstream contract/core files were modified. The SDK vendors unchanged schema bytes and uses the real versioned contract.

## Closed by IPC 0.2

| M0 observation | Ratified resolution / SDK behavior |
| --- | --- |
| Missing camera and world/location metadata. | `camera.get/set`; revisioned `location` contains zones, waypoint, routes, autodrive, transition. SDK and mock use exact schema. |
| No waypoint/navigation control. | Waypoint/route set/clear, travel start/cancel, autodrive start/stop with documented targets, grants, bounds and authoritative pose. |
| No warp/loading contract for shell overlays. | Stable transition IDs, output, phases/progress, destinations, monotonic timestamps; subscribed hints plus recoverable revisioned state. Loading precedes reply, failed loads preserve the old world. Warp scenario and core interop cover it. |
| Missing owned UI open/close and hold timing. | `ui.open/close`, lease-bound requests, `ui.opened/closed`; core owns 350 ms hold, release retention, Escape dismissal and F12 exit. Exclusive association is still pending below. |
| No integration publish/grant/lifetime. | Separate `data.publish` grant, `data.publish/remove`, namespace/ownership, increasing sequence, bounded scalar values/rate/TTL; authoritative `integrations.sources`, nonreplayed hints. Pulse now uses this API. |
| Unspecified client bootstrap labels/FD payload. | `HYPRUNE_SOCKET`, `HYPRUNE_CLIENT_ID`, `HYPRUNE_PROTOCOL`, `HYPRUNE_TOKEN_FD` with raw 64-hex token + newline are ratified. Daemon `HYPRUNE_LAUNCH_FD` remains separate JSON bootstrap. Renewal channel remains pending. |
| Required glTF extension profile too narrow. | World 0.2 / core M1 ratify `KHR_texture_transform` alongside `KHR_materials_unlit`; SDK accepts both world versions and tests the new profile. |
| Core hello-name ASCII limit 128 versus schema 256. | Core now checks 256 bytes. ASCII boundary is aligned; Unicode length units still need clarification below. |

`0.1-mock.1`, its sidecar metadata events, mock-only publishing and generated experimental schema have been removed. Explicit 0.1 clients still receive the frozen contract. Presentation events are not authoritative caches and never substitute for snapshot/delta recovery.

## Remaining: extension manifest cannot request publishing

The IPC 0.2 capability enum includes `data.publish`, but `v0/extension.schema.json` still references `v0/common.schema.json`'s six older grants. There is no versioned 0.2 extension schema; adding `data.publish` to `capabilities` fails the upstream validator. A distributable integration therefore cannot express its newly ratified IPC publishing requirement.

SDK workaround is explicit trusted development: pulse's valid legacy `extension.json` is preserved; `launch.json` separately records `data.publish` for the mock supervisor. It is not a new package format, sandbox exemption or automatic approval. Core interop tests grant publishing through the existing private launcher channel.

Proposed fix: version an extension schema/common capability reference (preserving frozen 0.1), amend RFC-0007's protocol/API compatibility and capability declaration rules, and add valid/invalid publishing-manifest fixtures. Specify how approved contribution IDs map to source namespaces, rather than treating a developer launch file as distributable policy.

## Remaining: host metrics and executable extension hosts

Publishing grants no host filesystem/process access. Required sandboxing still prevents direct `/proc` metrics, so pulse is trusted unsandboxed tooling. A production integration needs a narrow core-owned metrics broker with a dedicated read grant and bounded, privacy-reviewed fields; sandboxed publishers consume broker results.

Widget rendering remains shell-specific; screen capture/provider registration and third-party movement intent/deadline/collision fast paths remain unratified host contracts. SDK scaffolds reserve all four contribution types and run subscribers; pulse specializes one into a publisher and the widget renders in a terminal. Camera/navigation commands do not establish a custom movement-mode host.

Proposed fix: independently versioned host APIs with lifecycle/error/grant fixtures, an approved widget entrypoint and screen-source registration, plus sandbox install/launch/revocation tests before enabling installed executable contributions.

## Remaining: production supervisor and reconnect renewal

Bootstrap payload/labels are now fixed, but portable private token reissuance, production policy manager and extension launcher are still absent. Reusing a consumed token would violate the contract. SDK calls a fresh `tokenProvider` on each reconnect and never retries mutations; the one-shot FD helper disables reconnect without a callback.

Proposed fix: specify private renewal/restart binding, expiry/revocation errors and shell restart policy. Do not introduce blanket persistent token files or public token issuance.

## Remaining: shell association and output capabilities

Core M1 supports nonexclusive leases only. Exclusive input returns `-32007` until a trusted Wayland-client association exists. Core hold timing is resolved; full shell conformance, panel registry/approval flow, output mapping/projection descriptors and catalog/workspace/settings contracts remain later host work. A scalar output ID in transition events does not define transforms or rendering geometry.

Proposed fix: ratify trusted shell-surface association and bounded output descriptors, then test routing/ownership/revocation in an isolated nested compositor. Keep panel IDs approved data, not code paths or arbitrary module loading.

## Remaining: load/limit error classification

RFC-0003 defines `-32003` for unknown resources and the migration guide says limits return `-32008`. Core's plugin currently maps generic world-loader exceptions to `-32602`; a missing installed directory therefore reports invalid params. The real-loader interop fixture records this behavior while verifying failed transition/old-world preservation. The mock uses `-32003` for unknown fake IDs/spawns and `-32602` for a scripted asset-load failure.

Core also classifies a value map above 16 KiB as `-32602`, while aggregate/source/rate limits use `-32008`. The mock matches this per-map behavior; neither client retries based on an error code alone. Proposed fix: define missing-package versus invalid-asset errors, distinguish malformed value maps from byte-budget exhaustion, and align core, mock, RFC and negative fixtures.

## Remaining: Unicode bounds and transient notices

Core's JSON string limits use UTF-8 byte length in several places (for example hello client names and integration value strings), while JSON Schema `maxLength` counts Unicode code points. ASCII limits align, but non-ASCII strings near the boundary may validate in schema and reject in core. SDK/mock use upstream schema limits and do not silently redefine the wire schema.

Proposed fix: choose and document units per bounded field, align core and schema validation, and add multibyte boundary fixtures. Byte budgets for whole frames/maps remain distinct from character limits.

`runtime.notice` remains a transient RFC/schema event; no persisted notification-center state or replay is ratified. Core M1 discovery currently advertises delta and new location/UI/data hints, without `runtime.notice`; the mock advertises notices for development. SDK accepts events only when advertised. If a persisted notification center is wanted, version its state/lifetime/dismissal contract separately.

## Remaining: Quickshell transport and mock boundary

RFC-0007 chooses JavaScript, but Node's socket/filesystem modules cannot run in QML. The shell needs its native AF_UNIX bridge and shared conformance fixtures; TypeScript/Node/Bun remains the reference SDK, with Python only a test harness.

RFC-0003 mandates SO_PEERCRED; portable Node `net.Socket` does not expose it. The mock enforces private directories, 0600 sockets, one-use identity-bound grants and safe listener replacement, but is not the production credential boundary or extension sandbox. Proposed fix: keep it development-only or use a reviewed Linux credential adapter before any production claim.

## Remaining: authoring/runtime validation and naming

`world validate` includes the upstream validator plus path/file/provenance, Khronos glTF, reference/UV1, preliminary resource and header checks. It cannot certify authoritative capsule clearance, decoded-image/GPU budgets, rights ownership or malicious-content safety. Packing is deterministic on the tested toolchain; safe installation/extraction and the core approval-digest algorithm remain separate work. RFC-0004's `world check` naming still differs from the requested `world validate` CLI.

Proposed fix: standardize command naming, publish schema/authoring/runtime validation levels and extend asset/reference fixtures while keeping final collision and renderer allocation core-owned.

## Interoperability evidence and limits

Both optional SDK tests pass against built `hypruned` with real core `Control`, simulation/collision and world loading behind a private CPU-only plugin stand-in. Core's four CTest suites also pass. This verifies daemon/controller IPC behavior, not full Hyprland input routing, Wayland association, GPU upload or output rendering. No nested or owner compositor session was accessed. See [test reproduction and scope](docs/testing.md).
