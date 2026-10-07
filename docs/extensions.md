# Extension scaffolds and examples

```sh
hyprune ext new screen-type ./screen --id org.example.screen
hyprune ext new widget ./widget --id org.example.widget
hyprune ext new movement-mode ./movement --id org.example.movement
hyprune ext new integration ./integration --id org.example.integration
```

Scaffolding refuses existing destinations, validates manifests and reserves namespaced contributions. Screen scaffolds also generate a planar descriptor with matching provider identity. Each scaffold contains `extension.json`, executable state-subscriber `main.mjs`, SDK 0.2 dependency metadata, MIT license and provenance instructions. Install the local SDK with `npm install /path/to/hyprune/sdk` until published.

```sh
hyprune-mock --client-id org.example.widget --launch node /path/to/widget/main.mjs
```

Launch is trusted local execution. Manifests retain `sandbox.required: true`, `network: false`, and format `0.1`, the only ratified extension format. Validation/discovery never executes extensions; the demo does not implement a distributable sandbox or host.

| Type | Runnable scaffold | Remaining host contract |
| --- | --- | --- |
| Screen type | Valid planar descriptor and subscriber. | Approved capture/provider registration. |
| Widget | Terminal state presentation. | Portable shell rendering/entrypoint API. |
| Movement mode | Reserved mode ID and subscriber. | Timestamped intent/collision/deadline fast path. |
| Integration/data source | Reserved integration ID and subscriber; pulse customizes it into a publisher. | Sandboxed host metrics broker and manifest grant declaration. |

## Real system-pulse publishing

`examples/system-pulse` samples `/proc/stat`, `/proc/meminfo`, `/proc/net/dev`. It publishes CPU percentage since the preceding sample, RAM bytes and cumulative non-loopback network counters using real `data.publish`. It requests **only** `data.publish`, with source ID `org.example.systempulse.data`, increasing sequence and 5000 ms TTL. Shutdown requests `data.remove`; disconnect cleanup/TTL also removes the source.

`examples/pulse-widget` needs only `state.read`. It reads authoritative `state.integrations.sources` and renders world/pose, metrics and optional warp phase. It clears naturally when a source expires/disconnects; it does not cache/replay `data.updated` hints. Under legacy 0.1 it shows world/pose and waits for metrics.

```sh
npm run mock -- --socket "$XDG_RUNTIME_DIR/hyprune/sdk-demo/control.sock" --demo
```

IPC 0.2 ratifies publishing, but **the extension manifest schema still rejects `data.publish`** in `capabilities`. We keep `extension.json` valid against the frozen schema and record the separate trusted developer grant in `examples/system-pulse/launch.json`; `--demo` reads that launch file. It is not an installable authorization format. A production launcher must approve publishing independently until an amended extension schema exists.

Host `/proc` access remains trusted and unsandboxed. IPC publishing grants no filesystem inspection; required extension isolation still needs a narrow metrics broker. Screen/movement scaffolds reserve metadata without supplying pixels or a custom motion controller. See [remaining proposals](../NOTES-rfc-gaps.md).
