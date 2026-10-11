# Releasing @hyprune/sdk

`@hyprune/sdk` is published to npm by [`.github/workflows/release.yml`](.github/workflows/release.yml) when a `vX.Y.Z` tag is pushed. The workflow runs the tests, checks that the tag matches `package.json`, skips versions that are already on npm, and publishes with `--access public`.

## First publish (once)

npm only lets you configure a trusted publisher for a package that already exists, so the first version has to be published with a credential. Use either option. Your npm account must be a member of the `hyprune` org with publish rights.

**A. Locally**

From a clean, up-to-date checkout of `main` at the version you're releasing (0.3.0 today):

```sh
npm ci
npm test
npm login                    # account in the hyprune org; 2FA prompts as configured
npm publish --access public  # no --provenance: provenance only works from CI
git tag v0.3.0 && git push origin v0.3.0
```

Pushing the tag afterwards is fine: the workflow sees the version is already on npm and skips publishing.

**B. From CI with a temporary token**

1. On npmjs.com: Access Tokens → Generate New Token → Granular Access Token. Give it **read and write** permission for packages, limited to the `hyprune` organisation (new packages can't be selected individually yet), with a short expiry.
2. In GitHub: hyprune/sdk → Settings → Secrets and variables → Actions → New repository secret named `NPM_TOKEN`.
3. Tag and push (see [Releasing a version](#releasing-a-version)). The workflow sees `NPM_TOKEN` and publishes with it.

## Switch to trusted publishing (after the first publish)

1. On npmjs.com, open the package `@hyprune/sdk` → **Settings** → **Trusted Publisher** → **GitHub Actions**, and enter:
   - Organization or user: `hyprune`
   - Repository: `sdk`
   - Workflow filename: `release.yml`
   - Environment: leave empty
2. Delete the `NPM_TOKEN` repository secret and revoke the token on npmjs.com. The workflow then authenticates with GitHub's OIDC token (`permissions: id-token: write`); no long-lived secret is stored. It installs npm 11.5.1 or newer, which trusted publishing needs.
3. Optional: in the package's **Settings → Publishing access**, choose "Require two-factor authentication and disallow tokens" so that only trusted publishing can publish.

## Provenance

npm can only attach provenance attestations to builds from **public** repositories. While hyprune/sdk is private, the workflow publishes with `--provenance=false`; once the repository is public it passes `--provenance` automatically (it reads the repository's visibility from the event). Nothing needs to change when the repository goes public. Local publishes never carry provenance.

## Releasing a version

1. Set the new version in `package.json` (`npm version X.Y.Z --no-git-tag-version`).
2. Run `npm test`. It regenerates `src/generated.ts` and the README header from the vendored schemas and `package.json`, and builds `dist/`. Commit any regenerated files.
3. Update the README's notes for the release if behaviour changed.

```sh
git commit -am "Release @hyprune/sdk X.Y.Z"
git tag vX.Y.Z
git push origin main vX.Y.Z
```

Watch the **Release** workflow in the Actions tab. If the tag doesn't match `package.json`, it fails before publishing. To rehearse, run the workflow by hand (Actions → Release → Run workflow): it defaults to a dry run that runs every check and `npm publish --dry-run`.

A version can't be republished after it's on npm. Fix forward with a new patch version; `npm deprecate @hyprune/sdk@X.Y.Z "reason"` marks a bad one.
