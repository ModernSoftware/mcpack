# Stage and approve an npm release

Package: [`@modern-software/mcpack`](https://www.npmjs.com/package/@modern-software/mcpack),
public under Apache-2.0. GitHub organization: `ModernSoftware`; npm scope/account:
`modern-software`. Release commits go through a PR and CI. Merging does not publish.

## Prepare v0.9.0

The release PR sets `package.json` and both root version fields in `package-lock.json`
to `0.9.0`, updates the changelog and enables non-prerelease staging. After merge:

1. Wait for main CI, Support Desk, container and Forge integration checks to pass.
2. Run **Release candidate** on the intended main revision. Inspect the installed-package
   test, tarball, SHA256SUMS and benchmark artifact. This workflow never publishes.
3. Confirm the intended version is not already published or staged on npm. The initial
   `0.1.0-alpha.1` already exists; never overwrite or re-stage it.
4. Tag the reviewed main commit:

```sh
git switch main
git pull --ff-only
git tag -a v0.9.0 -m "MCPack 0.9.0"
git push origin v0.9.0
```

Watch **Actions → Stage npm release**. Pushed `v*` tags trigger validation; only the
following version forms are accepted:

| Package version | Required Git tag | npm dist-tag |
| --------------- | ---------------- | ------------ |
| `0.9.0`         | `v0.9.0`         | `latest`     |
| `0.9.1-alpha.1` | `v0.9.1-alpha.1` | `alpha`      |

Other prerelease forms (beta/rc), build metadata, mismatches and publication from a
branch are rejected. The commit must be contained in `origin/main`. Lockfile versions
must match the package. The validator selects the channel; the tag is never used to
rewrite package metadata. Manual workflow dispatch is useful only when run against
the exact version tag; dispatching main cannot publish.

For subsequent versions, use a new preparation branch and `npm version VERSION
--no-git-tag-version`, update release notes, then merge the PR before tagging.
A non-prerelease version is routed to `latest`; 0.x does not promise 1.0 API stability.

## Trusted publisher configuration

The existing npm trusted publisher continues to use:

| Field             | Value                                       |
| ----------------- | ------------------------------------------- |
| Organization/user | `ModernSoftware`                            |
| Repository        | `mcpack`                                    |
| Workflow filename | `publish.yml`                               |
| Environment       | Blank; the workflow declares no environment |
| Allow npm publish | **Unchecked**; staging remains allowed      |

Do not enable direct publishing or add an npm token just for this release. The
workflow retains short-lived OIDC credentials (`id-token: write`) and pins npm
11.15.0 for staging. Updating the workflow display name does not change its filename
or the trust configuration. Publication jobs are serialized and not cancelled midway.

## Approve the staged package

A green staging run means **staged, not published**. Open npm's **Staged Packages**,
verify version, `latest`/`alpha` channel, contents and source/provenance information,
then approve with maintainer 2FA. Alternatively, using npm 11.15.0+ locally:

```sh
npm login
npm stage list @modern-software/mcpack
npm stage view <stage-id>
npm stage download <stage-id>
# Review before approving:
npm stage approve <stage-id>
```

The channel is selected when staged, not changed during approval. Keep approval
credentials and commands out of CI. If a workflow fails after staging may have
succeeded, inspect staged/published versions before retrying. A staged version
reserves its number; do not move a tag or approve an unrelated artifact to unblock CI.
Reject a bad candidate through npm's review flow and use a new version for fixes.

After approval:

```sh
npm view @modern-software/mcpack@0.9.0 version
npm view @modern-software/mcpack dist-tags --json
```

Install the exact version in a clean consumer and exercise Node/Python and both
transports. Update Support Desk and Forge pins/lockfiles in separate PRs. Keep a
source-built integration path to validate future library changes before publication.
An npm release does not deploy your AWS service; rebuild and deploy the reviewed
application image separately.

## Documentation and artifacts

npm renders the packaged README. Its package and Forge links, security/capacity
summary and roadmap therefore also reach registry readers. The tarball includes
compiled JS/types, the Python runner, small examples, docs, CHANGELOG, SECURITY,
LICENSE and NOTICE. The Support Desk lab is repository-only. Interpreters and
application dependencies are not bundled. Source documentation can evolve after
publication; the approved tarball remains immutable.

References: [trusted publishing](https://docs.npmjs.com/trusted-publishers/),
[staged publishing](https://docs.npmjs.com/staged-publishing/).
