# AGENTS.md

## Shared brain context — read this first

**Before doing anything in this repo, read [`cloudgrid-io/pm-brain`](https://github.com/cloudgrid-io/pm-brain).**
It is the single source of truth for how we work across all repos: work tracking, review discipline,
verification standards, and dated decisions. Several people run brain sessions in parallel, so a rule
written into one repo is invisible to the others — `pm-brain` is where cross-repo decisions live.

Start with `decisions.md` (newest first), then the reference document for what you are about to do.

Two rules that catch people immediately:

- **Ownership.** Every actively-worked issue carries a `by:` label — `by:michal`, `by:hanzo`, `by:gilad`,
  `by:miyagi`. **A `by:` label that is not yours means hands off**; ask the named actor first. Apply your
  own when you start, remove it when the work is verified — not at merge.
- **Merge is not `Done`.** `Done` means merged **and** verified in the environment it ships to. If a
  deploy, release or QA is still outstanding, the PR uses `Part of #N`, never a closing keyword.

When `pm-brain` and this file disagree: `pm-brain` owns *how we work*; this file owns *what this code is*.
A cross-repo process rule found here belongs in `pm-brain`.
