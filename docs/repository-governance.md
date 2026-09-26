# Repository workflow and main protection

Every change starts with an issue, continues on a branch and is reviewed through a pull
request. Repository publication, npm publication and branch protection are separate
operations. Committing a ruleset file does not activate protection.

## Apply the prepared ruleset

A repository administrator can open **Settings → Rules → Rulesets → New ruleset → Import
a ruleset**, select [main.json](../.github/rulesets/main.json), inspect it and save it with
Active enforcement. If the current GitHub plan does not support enforced rulesets for
this private repository, activate it after making the repository public.

The ruleset targets main, requires a PR, resolved review conversations and an up-to-date
branch with these checks passing:

- `test (ubuntu-latest, 22)`
- `test (ubuntu-latest, 24)`
- `test (windows-latest, 22)`
- `test (windows-latest, 24)`
- `Native integration (ubuntu-latest)`
- `Native integration (windows-latest)`
- `Native integration (macos-latest)`

It blocks branch deletion and force pushes and has no bypass actors. Review the selected
checks in GitHub after import, particularly if workflow job names change.

Approval count starts at **zero** because a sole maintainer cannot approve their own PR,
including PRs created through their connected account. The PR and CI requirements still
apply. Once a second maintainer can review changes, set the required approval count to
one. This avoids making the repository impossible for its sole maintainer to maintain.

## Verify enforcement

Check that the ruleset is Active and main appears as a targeted branch. Open a normal
issue-linked PR and confirm GitHub requires all seven checks and resolved conversations
before merging. Do not test protection by attempting destructive updates.

The prepared JSON is a proposed configuration; importing and activating it requires an
administrator. See [GitHub rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets).
