# Exceptions

One row per rule this repository cannot meet yet. The reason and the revisit date
are required. The shared `standard` job reads this file.

| Rule | Reason | Revisit |
| --- | --- | --- |
| `ci/coverage` | The shared coverage workflow does not instrument the TypeScript installer or the Node scripts. The installer suites run it as a subprocess, so the line gate cannot see the installer's own lines. | 2027-05-31 |
| `C7.3` | The test suites are `node:test` and Bun over `.mjs`, and Bun runs the installer suites. There is no `typecheck` recipe because the TypeScript installer has no `@types/node`; `bun check` reports missing Node globals rather than type errors. | 2027-05-31 |
| `C7.4` | Five Python files (about 2,450 lines) verify the workspace manifests, the settings file, and the ownership records. They stay on Python. | 2027-05-31 |
