# System pulse

Customized from `hyprune ext new integration`, contribution `org.example.systempulse.data`. Original MIT code, no external assets or extra build step.

`main.mjs` samples `/proc/stat`, `/proc/meminfo` and `/proc/net/dev`; publishes CPU utilization between samples, RAM used/total and cumulative network bytes excluding loopback. Guest CPU time is not counted twice. Network values are totals, not rates.

```sh
npm ci
npm run mock -- --socket "$XDG_RUNTIME_DIR/hyprune/sdk-demo/control.sock" --demo
```

It uses real IPC **0.2 `data.publish`**, requiring only its explicit publishing grant. Sequence increases per publication; TTL is 5000 ms; shutdown removes the source. A denied grant or legacy protocol fails clearly.

This is trusted, unsandboxed developer execution. `/proc` still needs a broker for sandboxed use. The frozen extension manifest cannot declare `data.publish`, so the valid `extension.json` keeps its legacy metadata; the separate `launch.json` records the publishing grant consumed by `--demo`. It is not a distribution/installation contract. See [remaining gaps](../../NOTES-rfc-gaps.md). Core does not discover or execute this example automatically.
