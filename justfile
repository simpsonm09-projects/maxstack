# Local task runner. Recipes mirror .github/workflows/ci.yml and the
# repo-standard local-run commands.
set windows-shell := ["pwsh", "-NoLogo", "-Command"]

default:
    @just --list

# Install the pinned tools.
install:
    mise install

# Format the JavaScript with Bun.
fmt *files:
    mise exec -- node scripts/fmt.mjs {{files}}

# Check the JavaScript formatting with Bun.
fmt-check:
    mise exec -- bun fmt --check "scripts/**/*.mjs"

# Lint the JavaScript, through Bun with an oxlint fallback. The shared lint
# workflow runs flint over the non-JavaScript files.
lint *files:
    mise exec -- bun scripts/lint.ts

# Run the AI-slop gate at the version CI pins.
aislop:
    npx --yes aislop@0.16.1 ci

# Scan the filesystem with Trivy.
security:
    trivy fs --scanners vuln,secret,misconfig --severity HIGH,CRITICAL .

# Validate the workspace manifests the installer consumes.
validate:
    mise exec -- python scripts/verify-manifests.py

# Validate the manifests and check the Claude pin against GitHub. Needs gh and network.
validate-online:
    mise exec -- python scripts/verify-manifests.py --online

# Run the node test suite under scripts/. The installer tests need PowerShell 7 and git; a missing program skips its test.
test-node:
    mise exec -- node --test --test-concurrency=4 scripts/*.test.mjs

# Run one shard of the node test suite. The portable workflow runs four shards on separate Windows runners.
test-node-shard index total:
    mise exec -- node --test --test-concurrency=4 --test-shard={{index}}/{{total}} scripts/*.test.mjs

# The installer suite stays in test-node, because it drives Install-Workspace.ps1 under PowerShell 7.

# Run the checks that need no Windows: the manifest verifier and the Node tests that run on any OS.
test:
    mise exec -- python scripts/verify-manifests.py
    mise exec -- node --test scripts/ordinal-guard.test.mjs scripts/generate-layers.test.mjs scripts/verify-manifests.test.mjs scripts/verify-pi-harness.test.mjs

# The focused POSIX portability set. The portable workflow runs it on macOS and Linux.
test-posix:
    mise exec -- node --test scripts/ordinal-guard.test.mjs
    mise exec -- node --test scripts/Install-Paths.test.mjs
    mise exec -- node --test scripts/Install-Links.test.mjs
    mise exec -- node --test scripts/verify-manifests.test.mjs
    mise exec -- node --test scripts/Install-Workspace.macos.test.mjs

# Keep the existing macOS recipe name for local callers.
test-macos:
    just test-posix

# Run the lint, test, and AI-slop gates.
verify: lint test aislop

# Run the same checks CI requires.
check: fmt-check lint test

# Check that the agent tool set covers the service owners. Workspace-local: it
# reads the dev-setup and org plugin checkouts, which CI does not have.
check-agent-tools:
    mise exec -- node scripts/check-agent-tools.mjs

# Project layer sources into a dedicated runtime bundle. Arguments: runtime, output directory,
# layer roots separated by ';' (name=path allowed), then optionally --check. Each value is quoted
# for the shell the recipe runs in: PowerShell on Windows doubles an apostrophe, POSIX sh uses quote().
generate-layers runtime out layers check="":
    mise exec -- node scripts/generate-layers.mjs --runtime {{ if os_family() == "windows" { "'" + replace(runtime, "'", "''") + "'" } else { quote(runtime) } }} --out {{ if os_family() == "windows" { "'" + replace(out, "'", "''") + "'" } else { quote(out) } }} --layers {{ if os_family() == "windows" { "'" + replace(layers, "'", "''") + "'" } else { quote(layers) } }} {{ if check == "" { "" } else if os_family() == "windows" { "'" + replace(check, "'", "''") + "'" } else { quote(check) } }}

# Run the model-free Pi smoke check against the resolved workspace: a stub model on loopback, no GPU, no
# download. It reads the workspace's Pi settings and wrapper and writes nothing to the workspace.
verify-pi:
    mise exec -- node scripts/verify-pi-harness.mjs

# Check local Codex project-root marker behavior without a model request. Pass the native Codex executable.
verify-codex-discovery codex:
    mise exec -- node scripts/verify-codex-discovery.mjs --codex {{ if os_family() == "windows" { "'" + replace(codex, "'", "''") + "'" } else { quote(codex) } }}

# Install the shared Lefthook hooks and assert the merged jobs (C7.8).
hooks:
    mise exec -- node scripts/hooks.ts

# Check the .agents/skills tree and its .claude/skills links.
agent-files:
    mise exec -- node scripts/agent-files.mjs

# Staged secret scan (C7.10).
secrets-staged:
    mise exec -- gitleaks git --staged --redact --no-banner

# Reject env files, private keys, kubeconfigs and files over 5 MB (C7.10).
forbidden-files *files:
    mise exec -- node scripts/forbidden-files.ts {{files}}

# actionlint and zizmor over the given workflows, or every workflow (C7.10).
workflows *files:
    {{ if files == "" { "mise exec -- actionlint" } else { "mise exec -- actionlint -- " + files } }}
    {{ if files == "" { "mise exec -- zizmor --quiet .github/workflows" } else { "mise exec -- zizmor --quiet " + files } }}

# shellcheck over the given scripts; nothing to do when none are given (C7.10).
shellcheck *files:
    {{ if files == "" { "echo shellcheck: no files to check" } else { "mise exec -- shellcheck -- " + files } }}

# Advisory Conventional Commit check (C2.4); never fails the commit (C7.10).
commit-msg file:
    mise exec -- node scripts/commit-msg.ts {{quote(file)}}

# Read the pushed refs from stdin, refuse main, and scan the range (C7.10).
hook-pre-push:
    mise exec -- node scripts/git-hook.ts pre-push

# Fast pre-push subset, under 30 seconds (C7.10).
pre-push-check:
    just fmt-check
    just test

# Refresh locked dependencies when a manifest changed (C7.10).
deps-refresh *files:
    {{ if files == "" { "mise exec -- node scripts/deps-refresh.ts mise.toml" } else { "mise exec -- node scripts/deps-refresh.ts " + files } }}

# Owner hook: fail when this checkout cannot sign commits (C2.7).
signing-check:
    mise exec -- node scripts/signing-check.mjs

# Prune remote-tracking refs and delete local branches merged into main.
prune:
    mise exec -- node scripts/prune.mjs
