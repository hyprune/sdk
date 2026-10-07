# Hyprune sdk

Tools and APIs for building on Hyprune. **Early, building in the open.**

> What if the computer itself were an explorable world?

SDK owns client libraries, typed IPC helpers, extension scaffolding, world authoring/export/validation tools, packaging and conformance harnesses. Schemas remain owned by [hyprune/schema](https://github.com/hyprune/schema); SDK consumes pinned versions rather than forking definitions.

It excludes Hyprland ABI bindings, runtime authority, the helper daemon and reference shell implementation. A third-party provider must use supported host APIs and approved grants. A manifest contribution does not imply that its host API is implemented.

First target: JavaScript control-plane client and snapshot reducer, followed by world checks and process-extension tooling. Native consumers can implement the same compact protocol independently. There is no functioning SDK package in this initial repository. See [RFC-0007](https://hyprune.com/rfcs/0007-extensions/).

## Boundaries and contracts

- [RFC-0001: umbrella architecture](https://hyprune.com/rfcs/0001-umbrella/)
- [RFC-0003: IPC `0.1`](https://hyprune.com/rfcs/0003-ipc/)
- [RFC-0004: world format `0.1`](https://hyprune.com/rfcs/0004-world-format/)
- [Machine-readable schemas and fixtures](https://github.com/hyprune/schema)
- [Roadmap M0–M3](https://hyprune.com/roadmap/)

RFCs are proposed implementation targets pending owner review. Read them now in [the docs source](https://github.com/hyprune/docs/tree/main/src/content/docs/rfcs) if the site is not deployed. Each core release must publish its exact Hyprland compatibility target and supported contract versions. Hyprune is new code; Hypr3D is a lessons-only historical reference.

## Contributing

See the [organization guide](https://github.com/hyprune/.github/blob/main/CONTRIBUTING.md) and [Code of Conduct](https://github.com/hyprune/.github/blob/main/CODE_OF_CONDUCT.md). Contract changes begin with an RFC amendment and schema fixtures. Keep provenance and failure evidence with your PR.

License: MIT; see [LICENSE](LICENSE).
