# Registry: sources, installs, releases and checks

The SDK implements phase 1 of [RFC-0015](https://hyprune.com/rfcs/0015-registry/): the
`hyprune` CLI runs the whole install pipeline itself under the content lock, and the API is
exported as `registry` from `@hyprune/sdk`. Core never touches the network; neither does
anything here except the fetch helper.

## State

| What | Where |
| --- | --- |
| Worlds | `$HYPRUNE_WORLD_DIR`, else `$XDG_DATA_HOME/hyprune/worlds/<id>/`; the replaced install in `.previous/<id>/` |
| User libraries | `$XDG_DATA_HOME/hyprune/libraries/<id>@<version>/` |
| System libraries | each directory of `$HYPRUNE_LIBRARY_DIR` (read-only, `managed: "system"`) |
| Install records | `$XDG_STATE_HOME/hyprune/content.json` (`version: 1`), lock `content.lock` |
| Sources | `$XDG_CONFIG_HOME/hyprune/sources.json`; read-only files in `$HYPRUNE_SOURCES_FILES` |
| Index cache | `$XDG_CACHE_HOME/hyprune/sources/<id>/{index.json,meta.json}` |
| Downloads | `$XDG_CACHE_HOME/hyprune/downloads/<sha256>.tar.zst` (`.part` while downloading; pruned after commit, leftovers after 7 days) |
| Thumbnails | `$XDG_CACHE_HOME/hyprune/thumbnails/<sha256>.png|.jpg` (verified) |

JSON files are replaced atomically with mode 0600. The lock is `content.lock`, created with
`O_EXCL` and holding the pid; a lock whose process is gone is taken over. A world commit is
journalled in `content.json` first and completed or undone by the next content operation.
A world symlinked into the world root is treated as system-managed. A world directory
without a record is listed as `local`.

Environment overrides: `HYPRUNE_REGISTRY_OFFICIAL_URL`, `HYPRUNE_REGISTRY_COMMUNITY_URL`
(defaults `https://hyprune.github.io/registry/v0.1/official.json` and `…/community.json`),
`HYPRUNE_GITHUB_API` (`https://api.github.com`), `HYPRUNE_GITHUB_DOWNLOAD`
(`https://github.com`), `GITHUB_TOKEN` (sent only to URLs under the API base, never
stored) and, for tests only, `HYPRUNE_FETCH_ALLOW_LOOPBACK_HTTP=1`, which allows
`http://127.0.0.1`, `localhost` and `[::1]`.

## Sources

`official` and `community` are built in: they can be disabled, never removed or
relabelled. Up to 32 custom sources:

| Added as | Kind | Reads |
| --- | --- | --- |
| `https://…/index.json` | `index` | The index document (0.1 schema, at most 16 MiB, no duplicate keys). |
| `github:owner/repo` or `github:owner/repo/name` | `github` | The release list through the REST API (never the repository): each release with exactly one valid `<id>-<version>.release.json`, its archive and `.sha256` assets, the tag naming the version and the pre-release flag matching it. Others are skipped (`skipped` in the result). With `/name`, only `<name>-v<version>` tags. |
| `https://…/x.tar.zst --sha256 HEX` | `url` | The archive (downloaded once, verified, inspected; it stays cached for the install). |
| `https://…/x.release.json` | `url` | The record; assets resolve next to it. |

A source is fetched and validated when it is added; one that fails is not added. Labels
are 1-48 printable characters; the default is the index `name`, else `owner/repo`, else
the host. The display is always `Official`, `Community registry` or `Custom: <label>`.
A refresh refuses an index whose `serial` is lower than the cached one and keeps the
cache (`error` in `source list`); `successor` is shown, never followed.

## Install pipeline

1. **Resolve**: an id in the enabled sources (official, community, custom in order; several
   matches need `--from`, unless one is the install's own source), `github:…[@tag]`, a
   record URL, an archive URL with `--sha256`, or a local `.tar.zst`. `@1.2.0` matches
   `v1.2.0` or `<name>-v1.2.0`. Without a tag: the newest available, non-pre-release
   version whose format this SDK knows (`--pre-release` includes pre-releases).
2. **Plan**: required libraries (`requires.libraries`) that are not installed come from
   the same source, then official, then community, else `requirement.missing`. The action
   is `install`, `update`, `downgrade` or `already-installed`.
3. **Confirm**: `--yes`, or a terminal prompt. A source change (the id is installed from
   another source, or found on disk without a record) needs `--accept-source-change`;
   replacing system-managed content needs `--override`. Neither is implied by `--yes`.
4. **Download** into the cache, never more than the pinned bytes, resumed with `Range`.
5. **Verify** the sha256 before reading anything (`hash.mismatch` deletes the file).
6. **Extract** into a `.staging-*` directory under the target root (rules below).
7. **Validate** with `validateWorld`/`validateLibrary`; id, version and format must equal
   the entry's; `requiredExtensions` only `com.hyprune.map` and `com.hyprune.blueprint`.
8. **Commit**: worlds replace `.previous/<id>/` and move the current install there;
   libraries become `<id>@<version>/`, handed to core's `libraries.install {archive,
   sha256}` when a session grants `objects.control`, else renamed by the CLI. The old
   previous library version is deleted unless an installed world requires it.

The same tag with the same hash is a no-op. A recorded tag whose source now pins another
hash is refused as a replaced asset (`content.conflict`). An offline archive is checked
against `--sha256`, else against a cached entry with the same id and version (whose
source and tag are recorded), else recorded as `{source: "file"}`; it is extracted and
validated before the plan, since only the archive names the package.

**Update** installs the newest installable tag from the install's own source (after a
refresh); pinned installs are skipped and report the newer tag. **Rollback** swaps the
current and previous installs and pins the restored tag. **Remove** deletes the current
and previous installs and the record; `library remove <id>@<version>` removes one
version. With a running session the loaded world can't be updated, rolled back or removed
(`world.active`: load another world first). System-managed content is refused
(`managed.system`); a library version an installed world requires needs `--force`.

### Safe extractor and data only

`zstd -dc --memory=128MB` (window log at most 27) feeds a streaming ustar parser that
writes with `O_EXCL|O_NOFOLLOW` into the staging directory and refuses: anything but
regular files and directories (links, devices, FIFOs, pax and GNU headers), absolute
paths, `..`, empty or `.` segments, backslashes, `%`, `?`, `#`, `:` and control
characters, more than one root or a root other than the id, executable mode bits, files
starting with an ELF, PE (`MZ`), Mach-O, `#!` or WebAssembly signature, files outside the
allowlist (`.json`, `.glb`, `.gltf`, `.bin`, `.png`, `.jpg`, `.jpeg`, `.ktx2`, `.svg`,
`.ogg`, `.wav`, `.md`, `.txt`, `LICENSE`, `NOTICE`, `COPYING`, `ATTRIBUTION`), SVG with
scripts, event attributes, external references, `foreignObject` or entities, and data
after the end-of-archive blocks other than zero padding. Limits:

| | World | Library |
| --- | --- | --- |
| Archive | 512 MiB | 256 MiB |
| Expanded | 1 GiB | 512 MiB |
| Files | 10,000 | 4,000 |
| Single file | 128 MiB | 32 MiB |

## CLI JSON contract

Jobs (`add|install|update|rollback|remove|pin|unpin`, `source add|refresh`) with `--json`
print JSON lines on stdout and nothing else:

```text
{"event":"stage","stage":"resolving"}
{"event":"plan","plan":{"packages":[…],"sourceChange":null,"override":false,"diskFreeAfter":182536110080}}
{"event":"stage","stage":"downloading"}
{"event":"progress","bytes":123,"total":456}
{"event":"stage","stage":"verifying"}            … extracting, validating, committing
{"event":"done","result":{"id":"…","type":"library","tag":"v1.0.0","version":"1.0.0","action":"install","sourceId":"…","pinned":false}}
{"event":"error","error":{"rule":"hash.mismatch","message":"…"}}
```

`--plan` stops after the plan event. `update --all` (or several ids) ends with one
`{"event":"done","result":{"action":"update","results":[{id,type,status,tag,newerTag,…}]}}`,
status `updated`, `current`, `pinned` or `skipped`. Rollback, pin, unpin and remove print
one `done` line. Listings: `source list --json` (`{sources}`), `browse --json`
(`{entries}`, from the cache; `--refresh` refreshes first), `content list --json` /
`installed --json` (`{installs}`, with `sourceState`, `pending`, `managed`,
`removedFromSource`, `newerTag`, `path`). Rules: `fetch.failed`, `hash.mismatch`,
`archive.unsafe`, `archive.limit`, `data.executable`, `format.unsupported`,
`package.invalid`, `content.conflict`, `requirement.missing`, `disk.full`,
`managed.system`, `source.invalid`, `world.active`, `source.change`, `confirm.required`,
`not.found`. `fetch.failed`, `disk.full` and `not.found` exit 1; the other rules exit 3.

## Publishing

```sh
hyprune world pack ./tidepool --release [--tag v1.2.0] [--repo https://github.com/ada/tidepool-world] \
  [--commit SHA] [--thumbnail cover.png]… [--output dist]
```

writes `<id>-<version>.tar.zst`, `<id>-<version>.tar.zst.sha256` (one `sha256sum` line),
`<id>-<version>.release.json` and `<id>-<version>.thumb-<n>.png|jpg` (PNG or JPEG, at most
1280x720 and 512 KiB). The tag defaults to `v<version>` and must name the manifest version
(`<name>-v<version>` in a repository with several packages); `--repo` defaults to the
`origin` remote and `--commit` to the tag's commit or `HEAD`. `library pack` works the same
(and without `--release` writes just the archive). Upload all files as the assets of the
release for that tag.

`hyprune registry entry <release-dir | github:owner/repo[/name]@tag>` prints the
community registry entry (`--existing entry.json` merges a new version into an existing
entry; `--summary`, `--description`, `--tags`). `hyprune registry check <entry.json>`
runs the registry checks 1-14 (`--existing`, `--removed DIR` of tombstones, `--indexes
official.json,community.json`, `--author LOGIN`, `--official`); the repository-naming
recommendation (`<owner>/hyprune-<kind>-<name>`, topics `hyprune` and `hyprune-<kind>`;
monorepos exempt) is a warning only. The check functions (`checkEntry`, `checkSchema`,
`checkOwnership`, …) take an injectable `GithubClient`; `test/fake-github.mjs` is a
local stand-in for tests.
