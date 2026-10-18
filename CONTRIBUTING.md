# Contributing

Contributions are welcome. By submitting a pull request you agree that your
contribution is licensed under the MIT License (see [LICENSE](LICENSE)).

## Getting started

```
npm install
npm run smoke
```

## Pull requests

1. Fork the repo and create a feature branch.
2. Make your changes. Keep commits focused and use conventional commit messages.
3. Run `npm run smoke` locally to verify the tool list is unchanged.
4. Open a pull request against `main`. CI must pass before merge.

## Template dependencies are user-facing

The pinned dependencies under `src/corpus/templates/` ship to builders, who run
them on their own machines. A broken pin does not break this repo's CI; it
breaks a builder's first run. So the bar for a template dependency change is
"a fresh builder can install and run it", not "our checks are green".

For the `semantic-search` Python services, the `template-python` workflow
installs each service's `requirements.txt` on Python 3.12, imports every module,
and checks PDF text extraction against a golden output. If that output changes
after a `pypdf` bump, print the text first
(`.github/scripts/semantic-search-smoke.py <service-dir> --print`) and decide
whether builders should get the change before updating the hash.

## Reporting issues

Open a GitHub issue. For security vulnerabilities see [SECURITY.md](SECURITY.md).
