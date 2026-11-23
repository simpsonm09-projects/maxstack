# Exceptions

One row per rule this repository cannot meet yet. The reason and the revisit date
are required. The shared `standard` job reads this file.

| Rule | Reason | Revisit |
| --- | --- | --- |
| `ci/coverage` | Not measurable by the shared coverage workflow, in part. The installer is PowerShell, about 5,900 lines in `scripts/*.ps1`, and the Node suite runs it as a subprocess on the Windows test job. The Node code is also run through subprocesses. The shared line gate does not instrument the installer. | 2027-05-31 |
| `C7.3` | The suite is `node:test` over `.mjs` and Node runs it. Bun formats and lints. There is no `typecheck` recipe because the repository has no TypeScript. The 54 `.mjs` scripts and their tests port to Bun TypeScript as one migration. | 2027-05-31 |
| `C7.4` | The installer is 14 PowerShell files (about 5,900 lines) and the manifest verifier and generator tests are five Python files. Both stay on their runtimes until the migration: PowerShell for the Windows target, Python for the manifest tooling TypeScript cannot replace yet. | 2027-05-31 |
| `C5.1` | The audit snapshot's median pull request run was 848 s, dominated by the four Windows installer shards and the macOS and Linux portability jobs. Those moved to the `portable` workflow on `main` and weekly. The remaining required work is the manifest verifier and the OS-independent node tests; the measured median after this change is recorded in the pull request. | 2027-02-28 |
