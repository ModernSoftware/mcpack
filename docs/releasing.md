# Publishing an npm alpha

The approved package is `@modern-software/mcpack`, public, under Apache-2.0.
The npm account is `modern-software`; the GitHub organization is `ModernSoftware`.
These names intentionally differ. No credential belongs in source control.

## Prepare the release

1. Merge the preparation PR after CI and the Forge integration checks pass.
2. Review repository history and contents before making the repository public. Public
   GitHub visibility is optional for public npm publication, but required for npm's
   public provenance attestations. Repository visibility is an owner-controlled setting.
3. Activate the [main ruleset](repository-governance.md).
4. Run **Release candidate** on the intended main revision. Review its tarball,
   SHA256SUMS and benchmark artifact. This workflow never publishes.
5. Complete the one-time bootstrap below before pushing a release tag. After setup,
   pushing a matching numbered alpha tag automatically starts publication.

Local release checks:

```sh
npm ci
npm test
npm run test:package
npm run release:check
npm run benchmark -- --iterations 100
npm pack
```

The tarball includes compiled JavaScript/types, the standard-library Python runner,
examples, documentation, LICENSE and NOTICE. It does not bundle Node/Python interpreters
or application dependencies. The installed-package smoke test checks both transports
and both languages from a clean installation.

## One-time bootstrap: first publication from your machine

The npm registry is `https://registry.npmjs.org/`; your account owns the
`@modern-software` scope. There is no separate feed to create in GitHub.

The simplest initial setup is to create the package with an interactive publication,
then configure its package-level trusted publisher. Use your own machine and the
reviewed main commit containing version `0.1.0-alpha.1`:

```sh
git switch main
git pull --ff-only
npm ci
npm test
npm run test:package
npm run release:check
npm login
npm whoami
```

Check that `npm whoami` reports `modern-software` and that package.json still contains
the intended version. Then publish, completing npm's account/2FA prompts:

```sh
npm publish --access public --tag alpha
```

This is the one-time bootstrap. Do not then push `v0.1.0-alpha.1` to trigger the same
publication again: that version already exists on npm. Start automated releases with
`0.1.0-alpha.2` after the trusted publisher is configured. npm versions cannot be reused.

## One-time setup: authorize GitHub on npm

Sign in to npmjs.com, open **Packages → @modern-software/mcpack → Settings → Trusted
publishing**, and select **GitHub Actions**. Fill in:

| Field                | Value                                          |
| -------------------- | ---------------------------------------------- |
| Organization or user | `ModernSoftware`                               |
| Repository           | `mcpack`                                       |
| Workflow filename    | `publish.yml`                                  |
| Environment          | Leave blank; the workflow does not declare one |
| Allowed actions      | Allow direct publication with `npm publish`    |

Save the configuration. This grants this particular GitHub workflow permission to
publish this npm package. The workflow already uses `id-token: write` and GitHub-hosted
runners to request short-lived OIDC credentials. There is no npm token or deploy key to
add to GitHub Secrets. Node 24 supplies a compatible npm; trusted publishing requires
npm 11.5.1+ and Node 22.14+.

## Each subsequent release: version PR, then tag

The workflow deliberately checks the version rather than rewriting it from the tag:

| Name            | Example          | Meaning                                                            |
| --------------- | ---------------- | ------------------------------------------------------------------ |
| Package version | `0.1.0-alpha.2`  | Version committed in package.json and package-lock.json            |
| Git tag         | `v0.1.0-alpha.2` | Points to the reviewed source commit to publish                    |
| npm dist-tag    | `alpha`          | Moving pointer used by `npm install @modern-software/mcpack@alpha` |

For the next release, open an issue and branch, then update both version files without
creating a tag:

```sh
npm version 0.1.0-alpha.2 --no-git-tag-version
```

Commit the version change and submit a PR. After merge, wait for the main CI and Forge
integration checks to pass. From an updated main checkout:

```sh
git switch main
git pull --ff-only
git tag -a v0.1.0-alpha.2 -m "MCPack 0.1.0-alpha.2"
git push origin v0.1.0-alpha.2
```

Watch **Actions → Publish npm alpha**. The workflow triggers on pushed `v*-alpha.*`
tags, requires an exact match with the numbered alpha package version and a commit
contained in main, reruns tests and clean-package checks, and publishes to npm's `alpha`
dist-tag. A merge or ordinary branch push never publishes. Stable/beta releases are
not enabled by this alpha workflow. Do not use `v0.1.0-alpha` with our current numbered
alpha version convention.

Publication attempts share a concurrency group so they cannot publish simultaneously.
Push one release tag at a time and wait for completion before starting another release.

If publication fails before the version exists on npm, correct the external setup and
rerun the failed job, or manually dispatch the workflow against the same tag. Do not
move release tags or retry publication of an already published version. Source fixes
require a new version PR and tag.

After publication, install the exact released version in a clean project and exercise
both transports. Forge can then switch from its local tarball bootstrap to the registry
package in a separate issue and PR.

If a token fallback is ever needed, use an appropriately scoped npm access token in a
GitHub Actions secret, consumed as `NODE_AUTH_TOKEN`. A GitHub deploy key authenticates
Git access, not npm publishing. Never paste credentials into an issue, PR, or chat.

See npm's [trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/)
and [public scoped packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/).
