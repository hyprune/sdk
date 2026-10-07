# Pulse widget

Customized from `hyprune ext new widget`, contribution `org.example.pulsewidget.widget`. Original MIT code, no external assets or extra build step.

Run `npm run mock -- --demo` from the SDK root, preferably with an explicit private `--socket`. This terminal widget requests only `state.read`, subscribes to authoritative world/pose and `integrations.sources`, and renders once per second. Source expiry/remove/disconnect clears metrics through state; no cached event replay is used. It also displays current warp phase/progress. Legacy IPC 0.1 still shows world/pose with a waiting message.

Presentation is terminal-specific; RFC-0007 leaves portable widget rendering undefined. Its manifest requests the sandbox required for eventual distributable execution, but this demo is a trusted developer process and does not implement that launcher.
