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
5. Create `v0.1.0-alpha.1` at the reviewed main revision, matching package.json.

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

## First publication

A straightforward bootstrap is an interactive first publish by the npm owner. On your
own machine, check out the reviewed version tag, run the checks above, then:

```sh
npm login
npm whoami
npm publish --access public --tag alpha
```

Confirm `npm whoami` reports `modern-software` before publishing and complete npm's
account/2FA prompts. The alpha tag keeps the prerelease off `latest`. npm versions are
immutable: a later fix requires a new package version and matching tag.

## Subsequent releases: GitHub OIDC

In the npm package settings, configure a GitHub Actions trusted publisher:

| Field             | Value                                                    |
| ----------------- | -------------------------------------------------------- |
| GitHub owner      | `ModernSoftware`                                         |
| Repository        | `mcpack`                                                 |
| Workflow filename | `publish.yml`                                            |
| Environment       | Leave blank; the workflow does not currently declare one |

Allow direct publishing for this workflow. It uses GitHub-hosted runners, Node 24 and
`id-token: write`; npm trusted publishing requires npm 11.5.1+ and Node 22.14+.
No npm token or GitHub deploy key is needed for OIDC publishing.

For each release, update package.json and the lockfile through an issue and PR, merge
with green CI, tag the reviewed main revision, then manually dispatch **Publish npm
alpha** against that tag. It checks the matching version and main ancestry, reruns tests,
and publishes with `--tag alpha`. Neither a merge nor a tag push publishes automatically.

After publication, install the exact released version in a clean project and exercise
both transports. Forge can then switch from its local tarball bootstrap to the registry
package in a separate issue and PR.

If a token fallback is ever needed, use an appropriately scoped npm access token in a
GitHub Actions secret, consumed as `NODE_AUTH_TOKEN`. A GitHub deploy key authenticates
Git access, not npm publishing. Never paste credentials into an issue, PR, or chat.

See npm's [trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/)
and [public scoped packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/).
