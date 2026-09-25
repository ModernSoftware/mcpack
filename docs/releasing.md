# Preparing an npm alpha

The package remains `private: true` and `UNLICENSED`. No registry publication or repository
visibility change is performed by this increment. Tarball installation still works.

## Reviewable candidate

After reviewing/merging the implementation, run the **Release candidate** GitHub workflow
on the intended revision. It runs tests, installed-package checks, release-file checks,
and the benchmark, then uploads a tarball, SHA256SUMS, and measurement JSON. It never
publishes. Local equivalents are:

```sh
npm ci
npm test
npm run test:package
npm run release:check
npm run benchmark -- --iterations 100
npm pack
```

The package contains compiled JavaScript/types, the standard-library Python runner,
examples and docs. Node/Python application runtimes and dependencies are not bundled.
`prepack` builds TypeScript; consumers do not need a TypeScript compiler to run the CLI.
The installed-package smoke test exercises stdio and authenticated HTTP from a fresh
installation, including Python tools/resources/prompts.

## Distribution decisions

Before a registry release, the owner must confirm:

1. The npm account/organization owns `@modernsoftware` and the package name is available.
2. Public (`publishConfig.access: "public"`) or restricted distribution.
3. The intended license; public distribution requires a LICENSE file and matching metadata.
4. The version for the first alpha. Keep prereleases on the `alpha` dist-tag, not `latest`.

Then remove `private: true`, set the chosen access/license metadata, update the version
and lockfile together, review the tarball contents, and commit those decisions in a PR.
Changing npm visibility does not change GitHub repository visibility. Keep the repository
private unless the owner separately chooses otherwise.

## Publishing setup

The prepared **Publish npm alpha** workflow (`publish.yml`) runs manually against a
`v<package-version>` tag whose commit belongs to main. Its release check refuses to
publish the current private package, an unconfigured access level, or a mismatched tag.
It reruns tests/package checks and publishes with the `alpha` tag using npm OIDC trusted
publishing. It is not triggered by merging a PR or pushing a tag.

Configure the npm trusted publisher for GitHub owner `ModernSoftware`, repository
`mcpack`, workflow `publish.yml`, with direct publish allowed. Node 24 supplies a suitable
npm version (OIDC requires npm 11.5.1+). If the package does not yet exist, the owner may
need an authenticated first publish before configuring its package-level publisher.
Do not paste npm credentials into chat or commit them to the repository.

Public-package provenance requires a public source repository; a private repository does
not gain provenance merely by using OIDC. The workflow does not force `--provenance`.
See npm's [trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/)
for account setup and the repository visibility limitation.

Before dispatching a publish, verify the full Windows/Linux CI and pinned Forge integration
checks for the tagged commit. After publishing, install that exact version in a clean
project, test both transports, and only then change Forge's installation strategy from a
local tarball to the registry package. Docker images and the full Forge project UI are
separate increments.
