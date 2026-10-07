# Pulse widget

Customized from `hyprune ext new widget`, with contribution ID `org.example.pulsewidget.widget`. Original MIT code, no external assets. No build step beyond the SDK build.

Run `npm run mock -- --demo` from the SDK root. This small terminal widget subscribes to authoritative world/pose state and mock-only `data.updated` events, and renders once a second. Against production IPC `0.1` it still shows the world and pose, with a waiting message for metrics. Presentation is intentionally terminal-specific; RFC-0007 leaves portable widget rendering undefined.

It is a trusted developer process. Its manifest requests a sandbox for eventual distributable execution; this demo does not claim to implement that launcher. There is no QML injection or compositor access.
