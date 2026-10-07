# System pulse

Customized from `hyprune ext new integration`, with contribution ID `org.example.systempulse.data`. Original MIT code, no external assets. No build step beyond the SDK build.

`main.mjs` samples `/proc/stat`, `/proc/meminfo` and `/proc/net/dev`; publishes CPU utilization since the preceding sample, RAM bytes used/total and cumulative network bytes excluding loopback. Guest CPU time is not counted twice. The widget shows network totals, not transfer rates.

Run from the SDK root:

```sh
npm ci
npm run mock -- --demo
```

This is a trusted, unsandboxed developer demonstration. The distributable manifest still requests the mandatory sandbox. Host `/proc` inspection and data publishing need a future broker contract; production IPC `0.1` does not support them. `data.publish` uses the explicit `0.1-mock.1` schema only. See `../../NOTES-rfc-gaps.md`. It is not automatically discovered or executed by core.
