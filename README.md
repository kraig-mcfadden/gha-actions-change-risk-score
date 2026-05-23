# gha-actions-change-risk-score

GitHub Actions that compute the [CRAP](https://www.artima.com/weblogs/viewpost.jsp?thread=215899) change-risk score per function and can fail a build above a chosen threshold. Each action also renders a markdown report, appends it to the job summary, and (optionally) posts it as a PR comment ordered from highest score to lowest.

```
CRAP(m) = complexity(m)² × (1 − coverage(m)/100)³ + complexity(m)
```

## Actions in this repo

| Action | Language | Underlying tools |
|---|---|---|
| [`change-risk-score-rs`](./change-risk-score-rs) | Rust | [`cargo-crap`](https://github.com/minikin/cargo-crap), `cargo-llvm-cov` |
| [`change-risk-score-py`](./change-risk-score-py) | Python | `radon` + a Cobertura `coverage.xml` produced by the caller |
| [`change-risk-score-js`](./change-risk-score-js) | JavaScript / TypeScript / Svelte | ESLint `complexity` rule + an `lcov.info` produced by the caller |

Helm is intentionally out of scope for now — CRAP doesn't translate cleanly to Helm templates (no functions, no real coverage concept).

## Rust usage

```yaml
permissions:
  contents: read
  pull-requests: write

jobs:
  change-risk:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: kraigmcfadden/gha-actions-change-risk-score/change-risk-score-rs@v1
        with:
          threshold: '30'
          fail-above: 'true'
          post-pr-comment: 'true'
```

Inputs: `rust-toolchain`, `working-directory`, `threshold`, `top`, `workspace`, `fail-above`, `post-pr-comment`, `github-token`.

## Python usage

The caller is responsible for producing `coverage.xml` (Cobertura format) before invoking the action — this keeps it framework-agnostic. Any test runner works as long as `coverage.py` produced the XML.

```yaml
permissions:
  contents: read
  pull-requests: write

jobs:
  change-risk:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.11'
      - run: pip install coverage pytest
      - run: coverage run -m pytest && coverage xml
      - uses: kraigmcfadden/gha-actions-change-risk-score/change-risk-score-py@v1
        with:
          source-path: 'src'
          coverage-xml-path: 'coverage.xml'
          threshold: '30'
          fail-above: 'true'
          post-pr-comment: 'true'
```

Inputs: `python-version`, `working-directory`, `source-path`, `coverage-xml-path`, `threshold`, `top`, `missing-coverage-policy` (`pessimistic` / `optimistic` / `skip`), `fail-above`, `post-pr-comment`, `github-token`.

## JavaScript / TypeScript usage

The caller produces an `lcov.info` before invoking the action — c8, Vitest `--coverage`, Jest, and nyc all emit this format. By default the action analyzes `.js`/`.jsx`/`.mjs`/`.cjs`/`.ts`/`.tsx`/`.mts`/`.cts`. Set `svelte: 'true'` to also analyze `.svelte` files via [svelte-eslint-parser](https://github.com/sveltejs/svelte-eslint-parser).

```yaml
permissions:
  contents: read
  pull-requests: write

jobs:
  change-risk:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci
      - run: npx vitest run --coverage --coverage.reporter=lcov
      - uses: kraigmcfadden/gha-actions-change-risk-score/change-risk-score-js@v1
        with:
          source-path: 'src'
          coverage-lcov-path: 'coverage/lcov.info'
          svelte: 'true'   # set for SvelteKit / Svelte apps
          threshold: '30'
          fail-above: 'true'
          post-pr-comment: 'true'
```

Inputs: `node-version`, `working-directory`, `source-path`, `coverage-lcov-path`, `extensions`, `svelte`, `threshold`, `top`, `missing-coverage-policy`, `fail-above`, `post-pr-comment`, `github-token`.

## Posting PR comments

Both actions post their own comment when `post-pr-comment: true` and the workflow runs on a `pull_request` event. The comment is a single markdown table ordered highest CRAP first. If you run multiple language actions on the same PR you'll get one comment per language; aggregation across languages is not currently provided.

The job needs `pull-requests: write` for the comment step to succeed.
