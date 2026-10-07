# Extension scaffolds and examples

```sh
hyprune ext new screen-type ./screen --id org.example.screen
hyprune ext new widget ./widget --id org.example.widget
hyprune ext new movement-mode ./movement --id org.example.movement
hyprune ext new integration ./integration --id org.example.integration
```

Scaffolding refuses existing destinations, validates the extension manifest and reserves namespaced contribution IDs. Screen scaffolds also generate/validate a planar descriptor whose provider matches the extension. Each contains `extension.json`, executable `main.mjs`, dependency metadata, MIT license and build/provenance instructions. The entrypoint is a working IPC state subscriber. Install the local SDK with `npm install /path/to/hyprune/sdk` until packages are published.

```sh
hyprune-mock --client-id org.example.widget --launch node /path/to/widget/main.mjs
```

Developer launch is trusted local execution. All generated distributable manifests retain `sandbox.required: true` and `network: false`; no isolation claim is made by running them directly. Validation/discovery never executes an extension, and core M0 does not load third-party executable extensions.

| Type | M0 scaffold | Pending host contract |
| --- | --- | --- |
| Screen type | Valid planar custom-source descriptor + subscriber. | Approved Wayland capture/provider registration. |
| Widget | Terminal JSON presentation of state. | Shell rendering/entrypoint API. |
| Movement mode | Reserved mode ID + subscriber. | Timestamped intent/collision/deadline fast path; no direct pose authority. |
| Integration/data source | Reserved integration ID + subscriber. | Data registration/publish/read grants and brokered host data. |

`examples/system-pulse` and `examples/pulse-widget` customize the integration/widget scaffolds. Run `hyprune-mock --demo` to connect both to the mock. Pulse publishes CPU percentage over sample deltas, memory bytes and cumulative network counters; widget combines these with authoritative world/pose state. The widget uses terminal presentation because portable widget rendering is explicitly unratified.

System-pulse's `/proc` access requires trusted unsandboxed developer mode. Mock-only `data.publish` is not a production capability; the gap record proposes a narrow core metrics broker and new grants. Screen/movement scaffolds reserve metadata and do not claim to provide pixels or control motion.
