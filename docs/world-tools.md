# World authoring tools

```sh
hyprune world validate ./org.example.room
hyprune world pack ./org.example.room --output ./room-0.1.0.tar.zst
```

`world validate` calls the unchanged pinned schema validator, including manifest-local semantics, and then checks files and glTF. Output is JSON containing manifest, sorted inventory, package digest and warnings. Failure exits 1. No remote asset or schema is fetched, and no install script is run.

Checks include unique IDs/default spawn, normalized poses, ordered zone AABBs, SPDX syntax, attribution coverage, required features, package containment, symlinks/devices/executable content, external glTF URI safety, Khronos glTF structural/accessor validation, node references/cycles/multiple parents, triangular collision/navigation nodes, lightmap material/texture/PNG/UV1 references and WAV/Ogg header checks.

World formats `0.1` and `0.2` select their exact upstream schemas automatically. The ratified core material profile supports required `KHR_materials_unlit` and `KHR_texture_transform`; other required glTF extensions reject. Unknown required Hyprune metadata is rejected. Optional metadata remains subject to the pinned format.

Package caps: 10,000 files, 128 MiB single file, 1 GiB total, one MiB manifest. Preliminary world buffer/asset budget is 512 MiB. This does not replace decoded-image/GPU resource validation, authoritative collision/nav building or spawn capsule clearance in core. Passing attribution syntax/coverage is not a rights audit. Audio checks are container/header checks, not a complete decode audit.

A package needs `world.json`, referenced scene/resources, `LICENSE` and `ATTRIBUTION.md`. `path: "."` in attribution covers every file; narrower paths override it. Plain POSIX relative paths only: reject URI schemes, percent escapes, query/fragment, backslashes, empty/dot segments and symlinks. All glTF resources must remain local; embedded GLB BIN/image bufferViews are permitted, data URIs are rejected.

## Packing and digests

Packing validates the source, copies regular files through no-follow reads into a private staging directory, revalidates the staged copy and compares its digest. Source changes abort. The archive has exactly one root named by world ID, sorted entries, fixed epoch timestamps, numeric owner/group zero and normalized file modes. GNU tar plus zstd are required. It refuses overwriting an existing archive or writing inside the source package.

`packageDigest` hashes sorted path, size and file bytes with explicit NUL separators. `sha256` hashes archive bytes. The same package produces the same archive on the tested toolchain; compression-tool version changes can change archive bytes. These are SDK authoring digests; core has not ratified them as its approval-digest algorithm.

Archive extraction/installation is not implemented. Do not extract untrusted packages with a generic tar command as a substitute for the future safe installer.

`examples/world-minimal` is a public-domain synthetic empty glTF and valid spawn metadata. It is a lightweight test fixture, not a rendered room or claim of safe walking.
