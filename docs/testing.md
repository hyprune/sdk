# Testing and conformance

```sh
npm ci
npm test
npm run test:bun
HYPRUNE_CORE_BINARY=/path/to/core/build/hypruned npm test
```

The suite exercises real Unix sockets and the actual CLI launcher, not only reducer internals. It covers framing boundaries, UTF-8/duplicate keys/depth, version negotiation, one-use client-bound tokens, filtered methods, lease conflicts/cleanup, snapshots/deltas/resync, reconnect with fresh tokens, daemon restart, revocation, and refusing implicit mutation retries. Tooling tests cover glTF/path/provenance failures, deterministic packing, all scaffold types and `/proc` parsing. The bounded demo test verifies integration values reach the widget.

The optional core test requires Python 3 only as a test harness language. It supplies a private SOCK_SEQPACKET plugin stand-in to independently built `hypruned`, passes the daemon launch-grant FD, and verifies hello/ping/subscribe/snapshot/runtime exit/unsubscribe through the SDK. It starts no compositor and touches no live Hyprland instance. Without `HYPRUNE_CORE_BINARY`, this one test is explicitly skipped; SDK CI needs no sibling checkout.

GitHub Actions runs Node 22.12 and 24, plus Bun 1.4.2, installs zstd, verifies source checksums, checks generated contract drift and inspects package contents. Local results do not imply remote CI already ran. Full compositor integration, sandbox execution, adversarial slow-consumer scheduling and future extension host APIs require core/shell harnesses beyond M0.

## Updating schemas

`vendor/schema/source.json` pins repository commit and SHA-256 for every upstream schema/validator/license file. `npm run check:source` rejects changed bytes. Never edit the vendored contract in place or automatically follow main. After an approved upstream RFC/schema change, import that exact release/commit, update checksums and compatibility notes, regenerate models, and add positive/negative behavior tests.

`scripts/generate.mjs` handles the constructs in the pinned schema and fails on unknown structural constructs. Types do not express every semantic constraint; the exact upstream runtime validator enforces them. `scripts/experimental.mjs` separately derives `contracts/mock.schema.json` with the visibly distinct mock identifier. Mock additions require their own fixtures and documentation and never redefine core `0.1`.

## M0 verification record · 2026-10-07

- Node 26.10.0: **38/38 passing**, including the optional independently built core test.
- Bun 1.4.2: **37/37 protocol/tooling tests passing** (core harness is tested separately under Node).
- Compile-only public API checks passed: method params/results, event params and pose tuples.
- Pinned-source checksums and generated-contract drift checks passed.
- A packed npm tarball installed into a clean temporary consumer; both executable entrypoints and the supervised `/proc`/widget demo ran successfully.
- Local Markdown links resolved; `git diff --check` passed. Remote GitHub Actions remain unrun because this work was not pushed.
