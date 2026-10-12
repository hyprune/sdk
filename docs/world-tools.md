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

World format 0.9 adds characters, paths, seats and `keepClear` (RFC-0004 "world 0.9"). An object asset has exactly one source: inline (`scene`, with optional `traits` and `slots`), `dir` (a package directory holding `object.json` and its scene) or `library` + `object`. `world validate` checks each `dir` asset like `hyprune object check` (without the id-equals-directory rule, which applies to libraries and the user folder) and passes its `object.json` to the validator as `options.assets`, so character-only fields (`path`, `seat`, `accent`, `interactions`), seat anchors and `locked` are checked against its traits. `library` assets resolve against the installed libraries when core activates the world; the SDK has no library roots, so it reports them as a warning. Inline assets keep the 0.8 glTF checks, including a character trait's skin and clips. Route walkability, seat reachability and stops outside `keepClear` need collision and navigation data: core and `hyprune-world-check` own them.

`examples/world-minimal` is a public-domain synthetic empty glTF and valid spawn metadata. It is a lightweight test fixture, not a rendered room or claim of safe walking.

## Objects and libraries

```sh
hyprune object check ./street-lantern [--measured measured.json]
hyprune library check ./com.example.street
```

To make a checked object available to core, `hyprune object add` copies it into the
user object folder, and `hyprune library install` hands core a library archive; see
[User objects and libraries](../README.md#user-objects-and-libraries-ipc-022).
`gltfBounds(gltf)` is the accessor-bounds measurement `object add` uses for a bare `.glb`.

`object check` validates an RFC-0011 object directory: `object.json` next to its `.gltf`/`.glb`, an optional `thumbnail.png` and any files the scene references. The directory must be plain (no symlinks, devices or executable content) and within the object limits (64 files, 64 MiB, 32 MiB per file); these limits and the budgets below come from the pinned validator's `objectLimits`. The manifest is at most 1 MiB and its `id` must equal the directory name. Every external glTF URI follows the world package rules and must name a file of the directory; the Khronos glTF validator then runs on the scene.

The SDK reads the thumbnail's PNG header (256 x 256, at most 256 KiB) and each texture's header (PNG IHDR, JPEG start-of-frame, KTX2 pixel size) for the largest texture dimension, and estimates GPU memory: PNG and JPEG textures at 4 bytes per pixel, KTX2 at 1 byte per pixel, each times 4/3 for mips, plus every glTF buffer's `byteLength`. The pinned validator then checks the manifest, traits, slots, attribution coverage, the glTF cross-references (node names, collision proxy, states-slot materials, variants, character skins and clips), triangle budgets and bounds. `--measured` takes a JSON object `{bounds, maxTextureSize, gpuBytes}` from an import tool that decoded the assets; its values replace the SDK's estimates and `bounds` enables the exact 1 cm check.

Output is JSON with the manifest, sorted inventory, digest (as for worlds), warnings, the drawn `triangles` and the `measured` texture size and GPU bytes. Failure prints every error and exits 1.

`library check` validates a library: `library.json`, `LICENSE`, `ATTRIBUTION.md` and one directory per object under `objects/`. Every object directory is checked as above; then the library rules apply: each listed id has `objects/<id>/object.json` with that id and a `formatVersion` no newer than the library's, every directory is listed, files outside `objects/` are covered by the library's attribution, and the library stays within 4,000 files and 512 MiB. Output lists the objects in catalog order with their versions, digests and triangles.

Object formats follow the world format numbering: `0.9` is current, `0.10` is a draft (the `mover` and `machine` traits). The library API is `validateObject(dir, {measured})` and `validateLibrary(dir)` from `@hyprune/sdk`, with generated `Object09_Document`, `Object10_Document`, `Library09_Document` and `LibraryReleases09_Document` types.
