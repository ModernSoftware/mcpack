# Staging and approving an npm alpha

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
   pushing a matching numbered alpha tag automatically stages a release candidate.

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

## First publication (already completed)

The npm registry is `https://registry.npmjs.org/`; your account owns the
`@modern-software` scope. There is no separate feed to create in GitHub.

Version `0.1.0-alpha.1` has already been published interactively by the owner. Do not
publish or stage it again. The first staged release should use a new version, such as
`0.1.0-alpha.2`, committed through a version PR. Staging requires an existing package,
so the one-time bootstrap is complete.

## One-time setup: authorize GitHub on npm

Sign in to npmjs.com, open **Packages → @modern-software/mcpack → Settings → Trusted
publishing**, and select **GitHub Actions**. Fill in:

| Field                | Value                                                          |
| -------------------- | -------------------------------------------------------------- |
| Organization or user | `ModernSoftware`                                               |
| Repository           | `mcpack`                                                       |
| Workflow filename    | `publish.yml`                                                  |
| Environment          | Leave blank; the workflow does not declare one                 |
| Allowed actions      | Leave **Allow npm publish** unchecked; staging remains allowed |

Save the configuration. This grants this particular GitHub workflow permission to
stage candidates for this npm package. The workflow already uses `id-token: write` and GitHub-hosted
runners to request short-lived OIDC credentials. There is no npm token or deploy key to
add to GitHub Secrets. The workflow installs npm 11.15.0 explicitly; staged publishing
requires npm 11.15.0+ and Node 22.14+. Maintainer approval requires account 2FA.

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

Watch **Actions → Stage npm alpha**. The workflow triggers on pushed `v*-alpha.*`
tags, requires an exact match with the numbered alpha package version and a commit
contained in main, reruns tests and clean-package checks, and stages a candidate with
npm's `alpha` dist-tag. The package becomes public only after you approve it with 2FA. A merge or ordinary branch push never publishes. Stable/beta releases are
not enabled by this alpha workflow. Do not use `v0.1.0-alpha` with our current numbered
alpha version convention.

Publication attempts share a concurrency group so they cannot publish simultaneously.
Push one release tag at a time and wait for completion before starting another release.

## Approve the staged release

In npmjs.com, open **Staged Packages**, select the candidate, and review its version,
source/provenance information and contents before clicking **Approve** and completing
2FA. A green GitHub workflow means staging succeeded, not that publication is complete.
You can also review and approve on your own machine with npm 11.15.0+:

```sh
npm login
npm stage list @modern-software/mcpack
npm stage view <stage-id>
npm stage download <stage-id>
# Inspect the candidate before approving:
npm stage approve <stage-id>
```

The `alpha` dist-tag is recorded when staging and cannot be changed during approval.
No approval credential or automatic approval command belongs in GitHub Actions.

If staging fails, check npm's staged and published versions before retrying: a candidate
may have been accepted even if the workflow later failed. A staged version reserves its
version number. Review/approve the existing candidate rather than blindly re-staging it.
To discard a bad candidate, use npm's rejection flow (also requires 2FA); source fixes
should use a new version PR and tag. Never move a release tag or retry an already
published version.

## Switch the existing trusted publisher to staging only

After merging this workflow change, and before creating another release tag, uncheck
**Allow npm publish** in the existing npm trusted publisher and save. Keep the same
owner, repository, workflow filename (`publish.yml`), and blank environment. There is no
need to create a new trust relationship. Avoid running older tags whose workflow still
uses direct `npm publish`; the staging-only permission will reject them.

After publication, install the exact released version in a clean project and exercise
both transports. Upgrade Forge's exact package pin and lockfile in a separate issue and PR.

If a token fallback is ever needed, use an appropriately scoped npm access token in a
GitHub Actions secret, consumed as `NODE_AUTH_TOKEN`. A GitHub deploy key authenticates
Git access, not npm publishing. Never paste credentials into an issue, PR, or chat.

See npm's [trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/), [staged publishing](https://docs.npmjs.com/staged-publishing/),
and [public scoped packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/).
