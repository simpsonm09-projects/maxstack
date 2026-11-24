#!/usr/bin/env node
// Prove scripts/verify-manifests.py accepts the shipped layers.json and refuses each
// broken shape the installer relies on. Each case copies the manifests into a throwaway
// repository layout, changes one thing, and runs the real script there. No network.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const verifier = join(repoRoot, 'scripts', 'verify-manifests.py');

function findPython() {
  for (const name of ['python', 'python3']) {
    if (spawnSync(name, ['--version'], { windowsHide: true }).status === 0) return name;
  }
  return null;
}

const python = findPython();
const skip = python ? false : 'python is not available';

function shipped(path) {
  return JSON.parse(readFileSync(join(repoRoot, path), 'utf8'));
}

// Copies the manifests and the files the verifier reads into a temporary repository
// layout, applies the change, and runs the verifier there.
// tracked maps a path to content for files the temporary repository commits to its index; it makes the root a git repository.
function runVerifier({
  layers = (manifest) => manifest,
  pinLock = null,
  omitPinLock = false,
  extraFiles = {},
  lock = null,
  tracked = {},
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'maxstack-manifests-'));
  try {
    const manifest = layers(shipped('layers.json'));
    writeFileSync(join(root, 'layers.json'), JSON.stringify(manifest));
    if (!omitPinLock)
      writeFileSync(
        join(root, 'pstack.lock.json'),
        JSON.stringify(pinLock ?? shipped('pstack.lock.json')),
      );
    mkdirSync(join(root, 'workspace'));
    copyFileSync(
      join(repoRoot, 'workspace', 'opencode.jsonc'),
      join(root, 'workspace', 'opencode.jsonc'),
    );
    copyFileSync(
      join(repoRoot, 'workspace', 'maxstack.settings.json'),
      join(root, 'workspace', 'maxstack.settings.json'),
    );
    mkdirSync(join(root, 'schemas'));
    copyFileSync(
      join(repoRoot, 'schemas', 'maxstack.settings.schema.json'),
      join(root, 'schemas', 'maxstack.settings.schema.json'),
    );
    mkdirSync(join(root, 't3'));
    copyFileSync(join(repoRoot, 't3', 'allowlist.json'), join(root, 't3', 'allowlist.json'));
    copyFileSync(join(repoRoot, 't3', 'defaults.json'), join(root, 't3', 'defaults.json'));
    copyFileSync(join(repoRoot, 'README.md'), join(root, 'README.md'));
    mkdirSync(join(root, 'docs'));
    copyFileSync(join(repoRoot, 'docs', 'layout.md'), join(root, 'docs', 'layout.md'));
    writeFileSync(join(root, 'docs', 'plugin-publishing.md'), '# plugin publishing\n');
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'scripts', 'fixtures', 't3'), { recursive: true });
    copyFileSync(
      join(repoRoot, 'scripts', 'fixtures', 't3', 'server-settings-keys.json'),
      join(root, 'scripts', 'fixtures', 't3', 'server-settings-keys.json'),
    );
    mkdirSync(join(root, 'scripts', 'install'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'install', 'main.ts'), '// installer\n');
    copyFileSync(
      join(repoRoot, 'scripts', 'install', 'settings.ts'),
      join(root, 'scripts', 'install', 'settings.ts'),
    );
    copyFileSync(verifier, join(root, 'scripts', 'verify-manifests.py'));
    copyFileSync(
      join(repoRoot, 'scripts', 'verify_settings.py'),
      join(root, 'scripts', 'verify_settings.py'),
    );
    copyFileSync(
      join(repoRoot, 'scripts', 'settings_document.py'),
      join(root, 'scripts', 'settings_document.py'),
    );
    copyFileSync(
      join(repoRoot, 'scripts', 'verify_ownership.py'),
      join(root, 'scripts', 'verify_ownership.py'),
    );
    for (const [rel, content] of Object.entries(extraFiles)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), content);
    }
    if (Object.keys(tracked).length > 0) {
      spawnSync('git', ['init', '-q'], { windowsHide: true, cwd: root });
      for (const [rel, content] of Object.entries(tracked)) {
        mkdirSync(dirname(join(root, rel)), { recursive: true });
        writeFileSync(join(root, rel), content);
        spawnSync('git', ['add', '--', rel], { windowsHide: true, cwd: root });
      }
    }
    const args = [join(root, 'scripts', 'verify-manifests.py')];
    if (lock !== null) {
      writeFileSync(join(root, 'stack.lock.json'), JSON.stringify(lock));
      args.push('--lock', join(root, 'stack.lock.json'));
    }
    return spawnSync(python, args, { windowsHide: true, encoding: 'utf8' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function pstackOf(manifest) {
  return manifest.layers.find((layer) => layer.name === 'pstack');
}

function failureOf(run) {
  return `${run.stdout}\n${run.stderr}`;
}

test('the shipped manifests pass the verifier', { skip }, () => {
  const run = spawnSync(python, [verifier], { windowsHide: true, encoding: 'utf8' });
  assert.equal(run.status, 0, failureOf(run));
  assert.match(run.stdout, /^PASS:/);
});

test('the settings seed is valid and schema keys match the TypeScript validator', { skip }, () => {
  const run = spawnSync(python, [verifier], { windowsHide: true, encoding: 'utf8' });
  assert.equal(run.status, 0, failureOf(run));
  assert.deepEqual(shipped('workspace/maxstack.settings.json'), {
    version: 1,
    t3: { gatedInstances: [], readOnlyInstances: [] },
  });
});

test('the manifest verifier rejects settings schema and validator key drift', { skip }, () => {
  const validator = readFileSync(join(repoRoot, 'scripts', 'install', 'settings.ts'), 'utf8');
  // Anchor on the declaration, read the same way the verifier reads it, so a change to the ids cannot leave this fixture
  // matching nothing. The mutation appends one id the schema does not declare, which is real schema-validator drift.
  const runtimeIds = /export const SETTINGS_RUNTIME_IDS\s*=\s*\[([^\]]*)\]/g;
  assert.equal(
    [...validator.matchAll(runtimeIds)].length,
    1,
    'the fixture anchor found the validator runtime list once',
  );
  const altered = validator.replace(
    runtimeIds,
    (_list, ids) => `export const SETTINGS_RUNTIME_IDS = [${ids}, 'new-harness']`,
  );
  assert.notEqual(altered, validator, 'the fixture replacement found the validator list');
  const run = runVerifier({
    extraFiles: { 'scripts/install/settings.ts': altered },
  });
  assert.equal(run.status, 1, failureOf(run));
  assert.match(failureOf(run), /schema runtime ids differ/);
});

test(
  'the manifest verifier compares settings enums and structural constraints from the shipped schema',
  { skip },
  () => {
    const schema = shipped('schemas/maxstack.settings.schema.json');
    schema.properties.runtimes.propertyNames.enum = ['claude', 'copilot', 'opencode', 'changed'];
    const run = runVerifier({
      extraFiles: { 'schemas/maxstack.settings.schema.json': JSON.stringify(schema) },
    });
    assert.equal(run.status, 1, failureOf(run));
    assert.match(failureOf(run), /schema runtime ids differ/);
  },
);

test(
  'the manifest verifier reports malformed settings schema shapes without a traceback',
  { skip },
  () => {
    const cases = [
      [
        (schema) => {
          schema.properties.runtimes = [];
        },
        /settings schema runtimes must be an object/,
      ],
      [
        (schema) => {
          schema.properties.runtimes.propertyNames.enum = 'claude';
        },
        /propertyNames must have an enum list/,
      ],
      [
        (schema) => {
          schema.properties.runtimes.additionalProperties.properties.cli.enum = 'detect';
        },
        /SETTINGS_CLI_MODES enum must have an enum list/,
      ],
      [
        (schema) => {
          schema.properties.layers.additionalProperties = 'object';
        },
        /settings schema layer entries must be objects/,
      ],
      [
        (schema) => {
          schema.properties.t3.properties = [];
        },
        /settings schema T3 entries need an object properties field/,
      ],
      [
        (schema) => {
          schema.properties.t3.properties.gatedInstances.uniqueItems = false;
        },
        /t3\.gatedInstances must match the installer id rules/,
      ],
    ];
    for (const [mutate, expected] of cases) {
      const schema = shipped('schemas/maxstack.settings.schema.json');
      mutate(schema);
      const run = runVerifier({
        extraFiles: { 'schemas/maxstack.settings.schema.json': JSON.stringify(schema) },
      });
      assert.equal(run.status, 1, failureOf(run));
      assert.match(failureOf(run), expected);
      assert.doesNotMatch(failureOf(run), /Traceback/);
    }
  },
);

test(
  'the T3 verifier rejects missing version and provider envelope data without a traceback',
  { skip },
  () => {
    const allowlist = shipped('t3/allowlist.json');
    delete allowlist.verifiedAgainst;
    const missingVersion = runVerifier({
      extraFiles: { 't3/allowlist.json': JSON.stringify(allowlist) },
    });
    assert.equal(missingVersion.status, 1, failureOf(missingVersion));
    assert.match(failureOf(missingVersion), /allowlist needs a verifiedAgainst\.t3 version/);
    assert.doesNotMatch(failureOf(missingVersion), /Traceback/);

    const defaults = shipped('t3/defaults.json');
    delete defaults.instances['claude{Workspace}'].envelope;
    const missingEnvelope = runVerifier({
      extraFiles: { 't3/defaults.json': JSON.stringify(defaults) },
    });
    assert.equal(missingEnvelope.status, 1, failureOf(missingEnvelope));
    assert.match(failureOf(missingEnvelope), /claude\{Workspace\}\.envelope must be an object/);
    assert.doesNotMatch(failureOf(missingEnvelope), /Traceback/);
  },
);

test(
  'the manifest verifier reports invalid UTF-8 settings files without a traceback',
  { skip },
  () => {
    const run = runVerifier({
      extraFiles: { 'schemas/maxstack.settings.schema.json': Buffer.from([0xff]) },
    });
    assert.equal(run.status, 1, failureOf(run));
    assert.match(failureOf(run), /maxstack\.settings\.schema\.json is not valid UTF-8/);
    assert.doesNotMatch(failureOf(run), /Traceback|UnicodeDecodeError/);
  },
);

test(
  'the settings seed and schema must each hold one strict JSON object, with version an integer 1',
  { skip },
  () => {
    const seedCases = [
      ['null', 'null', /workspace\/maxstack\.settings\.json must hold one JSON object/],
      ['boolean version', '{"version":true}', /needs "version": 1/],
      ['float version', '{"version":1.0}', /needs "version": 1/],
      ['exponent version', '{"version":1e0}', /needs "version": 1/],
      ['escaped duplicate key', '{"version":1,"\\u0076ersion":1}', /duplicate key 'version'/],
      [
        'deep nesting',
        `{"version":1,"x":${'['.repeat(40)}0${']'.repeat(40)}}`,
        /nested deeper than 32/,
      ],
      ['NaN', '{"version":NaN}', /not strict JSON/],
    ];
    for (const [label, text, expected] of seedCases) {
      const run = runVerifier({ extraFiles: { 'workspace/maxstack.settings.json': text } });
      assert.equal(run.status, 1, `${label}: ${failureOf(run)}`);
      assert.match(failureOf(run), expected, label);
      assert.doesNotMatch(failureOf(run), /Traceback/, label);
    }
    const bom = runVerifier({
      extraFiles: {
        'workspace/maxstack.settings.json': Buffer.concat([
          Buffer.from([0xef, 0xbb, 0xbf]),
          Buffer.from('{"version":1}'),
        ]),
      },
    });
    assert.equal(bom.status, 0, failureOf(bom));
    const nullSchema = runVerifier({
      extraFiles: { 'schemas/maxstack.settings.schema.json': 'null' },
    });
    assert.equal(nullSchema.status, 1, failureOf(nullSchema));
    assert.match(failureOf(nullSchema), /maxstack\.settings\.schema\.json must be an object/);
  },
);

test('the shipped pstack layer is one git source with all four runtimes', { skip }, () => {
  const pstack = pstackOf(shipped('layers.json'));
  assert.equal(pstack.kind, 'plugin');
  assert.equal(typeof pstack.source, 'object', 'pstack is pinned to a git source');
  assert.deepEqual(Object.keys(pstack.runtimes).sort(), ['claude', 'copilot', 'opencode', 'pi']);
  assert.equal(pstack.runtimes.opencode.entry, 'opencode/index.ts');
  assert.equal(pstack.runtimes.opencode.agents, 'opencode/agents');
});

test('a copilot runtime without claude is refused', { skip }, () => {
  const run = runVerifier({
    layers: (manifest) => {
      manifest.layers[2].runtimes = { opencode: {}, copilot: {} };
      return manifest;
    },
  });
  assert.equal(run.status, 1, failureOf(run));
  assert.match(
    failureOf(run),
    /declares copilot, which loads the Claude plugin folder, so it also needs claude/,
  );
});

test('a pi runtime without claude is refused', { skip }, () => {
  const run = runVerifier({
    layers: (manifest) => {
      manifest.layers[1].runtimes = { opencode: {}, pi: {} };
      return manifest;
    },
  });
  assert.equal(run.status, 1, failureOf(run));
  assert.match(
    failureOf(run),
    /declares pi, which lists the Claude plugin folder's skills, so it also needs claude/,
  );
});

test('a local layer that declares claude without opencode is refused', { skip }, () => {
  const run = runVerifier({
    layers: (manifest) => {
      manifest.layers[1].runtimes = { claude: {} };
      return manifest;
    },
  });
  assert.equal(run.status, 1, failureOf(run));
  assert.match(
    failureOf(run),
    /declares claude from a local checkout, which links to its OpenCode copy/,
  );
});

test('an unknown runtime name is refused', { skip }, () => {
  const run = runVerifier({
    layers: (manifest) => {
      manifest.layers[1].runtimes.gemini = {};
      return manifest;
    },
  });
  assert.equal(run.status, 1, failureOf(run));
  assert.match(failureOf(run), /unknown runtime 'gemini'/);
});

test('an OpenCode entry at the folder root, other than index.ts, is refused', { skip }, () => {
  const run = runVerifier({
    layers: (manifest) => {
      pstackOf(manifest).runtimes.opencode.entry = 'plugin.ts';
      return manifest;
    },
  });
  assert.equal(run.status, 1, failureOf(run));
  assert.match(failureOf(run), /names the root file plugin\.ts/);
});

test('a git source with a short commit is refused', { skip }, () => {
  const run = runVerifier({
    layers: (manifest) => {
      pstackOf(manifest).source.commit = 'fd8038';
      return manifest;
    },
  });
  assert.equal(run.status, 1, failureOf(run));
  assert.match(failureOf(run), /source\.commit must be a 40-character lowercase commit SHA/);
});

test('a layer with both a checkout path and a git source is refused', { skip }, () => {
  const run = runVerifier({
    layers: (manifest) => {
      pstackOf(manifest).path = 'projects/repos/pstack';
      return manifest;
    },
  });
  assert.equal(run.status, 1, failureOf(run));
  assert.match(failureOf(run), /carries its own path/);
});

test('a pin lock that names another commit than layers.json is refused', { skip }, () => {
  const lock = shipped('pstack.lock.json');
  lock.commit = 'a'.repeat(40);
  const run = runVerifier({ pinLock: lock });
  assert.equal(run.status, 1, failureOf(run));
  assert.match(failureOf(run), /pstack\.lock\.json: commit does not match layers\.json/);
});

test('a git source with no pin lock is refused', { skip }, () => {
  const run = runVerifier({ omitPinLock: true });
  assert.equal(run.status, 1, failureOf(run));
  assert.match(failureOf(run), /pstack\.lock\.json is required by the git source/);
});

test('the retired OpenCode port lock is refused while it exists', { skip }, () => {
  const run = runVerifier({ extraFiles: { 'pstack-opencode.lock.json': '{}' } });
  assert.equal(run.status, 1, failureOf(run));
  assert.match(failureOf(run), /pstack-opencode\.lock\.json is retired/);
});

const git = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;

test(
  'a tracked Python bytecode file is refused, and the message names it',
  { skip: python ? (git ? false : 'git is not available') : skip },
  () => {
    const run = runVerifier({
      tracked: { 'scripts/__pycache__/verify_ownership.cpython-312.pyc': 'bytecode\n' },
    });
    assert.equal(run.status, 1, failureOf(run));
    assert.match(
      failureOf(run),
      /scripts\/__pycache__\/verify_ownership\.cpython-312\.pyc is tracked/,
    );
  },
);

test(
  'a tracked .pyc outside a __pycache__ folder is refused too',
  { skip: python ? (git ? false : 'git is not available') : skip },
  () => {
    const run = runVerifier({ tracked: { 'scripts/stale.pyc': 'bytecode\n' } });
    assert.equal(run.status, 1, failureOf(run));
    assert.match(failureOf(run), /scripts\/stale\.pyc is tracked/);
  },
);

test(
  'tracked source files pass the bytecode check',
  { skip: python ? (git ? false : 'git is not available') : skip },
  () => {
    const run = runVerifier({
      tracked: { 'scripts/helper.py': 'x = 1\n', 'scripts/__pycache_notes.txt': 'kept\n' },
    });
    assert.equal(run.status, 0, failureOf(run));
  },
);

test('the layer names and the single plugin layer are checked', { skip }, () => {
  const run = runVerifier({
    layers: (manifest) => {
      manifest.layers[1].name = 'pstack';
      return manifest;
    },
  });
  assert.equal(run.status, 1, failureOf(run));
  assert.match(failureOf(run), /two layers share a name/);
});

// An ownership record in the order the installer writes it: by path, then kind, then key.
const OWNED = [
  {
    path: '.claude/cache/pstack',
    kind: 'dir',
    sha256: 'A'.repeat(64),
    runtime: null,
    layers: ['pstack'],
  },
  {
    path: '.claude/plugins/org-ai-plugin',
    kind: 'link',
    target: '.opencode/plugins/org-ai-plugin',
    runtime: 'claude',
    layers: ['org-ai-plugin'],
  },
  {
    path: '.claude/plugins/pstack',
    kind: 'dir',
    sha256: 'B'.repeat(64),
    runtime: 'claude',
    layers: ['pstack'],
  },
  { path: '.maxstack/bin/pi.cmd', kind: 'file', sha256: 'C'.repeat(64), runtime: 'pi', layers: [] },
  {
    path: '.pi/agent/settings.json',
    kind: 'json-entries',
    key: 'packages',
    entries: ['../../.claude/cache/pstack'],
    runtime: 'pi',
    layers: ['pstack'],
  },
  {
    path: '.pi/agent/settings.json',
    kind: 'json-entries',
    key: 'skills',
    entries: ['../../.claude/plugins/pstack/skills'],
    runtime: 'pi',
    layers: ['pstack'],
  },
  { path: 'opencode.jsonc', kind: 'file', sha256: 'D'.repeat(64), runtime: 'opencode', layers: [] },
];

function lockWith(owned, extra = {}) {
  return { ownedSchema: 2, layers: [], owned, ...extra };
}

test('a well-formed ownership record passes --lock', { skip }, () => {
  const run = runVerifier({ lock: lockWith(OWNED) });
  assert.equal(run.status, 0, failureOf(run));
  assert.match(run.stdout, /^PASS:/);
});

test('an ownership record with no schema version, or no owned list, is refused', { skip }, () => {
  const noSchema = runVerifier({ lock: { owned: OWNED, layers: [] } });
  assert.equal(noSchema.status, 1, failureOf(noSchema));
  assert.match(
    failureOf(noSchema),
    /ownedSchema must be 2; run bun scripts\/install\/main\.ts -Apply once/,
  );

  const noOwned = runVerifier({ lock: { ownedSchema: 2, layers: [] } });
  assert.equal(noOwned.status, 1, failureOf(noOwned));
  assert.match(failureOf(noOwned), /has no owned list/);
});

test(
  'an owned path that is not a workspace-relative forward-slash path is refused',
  { skip },
  () => {
    for (const path of [
      '.maxstack\\bin\\pi.cmd',
      'C:/dev/x',
      '/etc/passwd',
      '../outside',
      'stack.lock.json',
    ]) {
      const owned = OWNED.map((record, index) => (index === 0 ? { ...record, path } : record));
      const run = runVerifier({ lock: lockWith(owned) });
      assert.equal(run.status, 1, `${path}: ${failureOf(run)}`);
      assert.match(
        failureOf(run),
        /path must be a workspace-relative path with forward slashes/,
        path,
      );
    }
  },
);

test(
  'an owned record with a short hash, an unknown kind, or an extra field is refused',
  { skip },
  () => {
    const cases = [
      [{ ...OWNED[0], sha256: 'abc' }, /sha256 must be 64 upper-case hex digits/],
      [{ ...OWNED[0], sha256: 'a'.repeat(64) }, /sha256 must be 64 upper-case hex digits/],
      [{ ...OWNED[0], kind: 'folder' }, /kind must be one of/],
      [{ ...OWNED[0], note: 'extra' }, /must hold exactly/],
      [{ ...OWNED[1], target: '' }, /target must be a workspace-relative path/],
    ];
    for (const [record, pattern] of cases) {
      const owned = OWNED.map((existing, index) => (index === 0 ? record : existing));
      const run = runVerifier({ lock: lockWith(owned) });
      assert.equal(run.status, 1, failureOf(run));
      assert.match(failureOf(run), pattern);
    }
  },
);

test('a json-entries record with an unknown key, or no entries, is refused', { skip }, () => {
  const unknownKey = OWNED.map((record) =>
    record.key === 'skills' ? { ...record, key: 'extensions' } : record,
  );
  const unknown = runVerifier({ lock: lockWith(unknownKey) });
  assert.equal(unknown.status, 1, failureOf(unknown));
  assert.match(failureOf(unknown), /key must be one of \[/);

  const empty = OWNED.map((record) =>
    record.key === 'skills' ? { ...record, entries: [] } : record,
  );
  const none = runVerifier({ lock: lockWith(empty) });
  assert.equal(none.status, 1, failureOf(none));
  assert.match(failureOf(none), /entries must be a non-empty list/);
});

test('owned records out of order, or named twice, are refused', { skip }, () => {
  const reversed = runVerifier({ lock: lockWith([...OWNED].reverse()) });
  assert.equal(reversed.status, 1, failureOf(reversed));
  assert.match(failureOf(reversed), /owned is not sorted by path, kind, and key/);

  const twice = runVerifier({ lock: lockWith([OWNED[0], OWNED[0], ...OWNED.slice(1)]) });
  assert.equal(twice.status, 1, failureOf(twice));
  assert.match(failureOf(twice), /names one path, kind, and key twice/);
});

test(
  'the owned list is sorted by UTF-8 bytes, so a fullwidth name comes before an emoji name',
  { skip },
  () => {
    // Code point order and UTF-8 order agree; UTF-16 would put the emoji (a surrogate pair) first.
    const fullwidth = {
      path: 'Ａ-fullwidth/x',
      kind: 'dir',
      sha256: 'A'.repeat(64),
      runtime: null,
      layers: [],
    };
    const emoji = {
      path: '\u{1F642}-emoji/x',
      kind: 'dir',
      sha256: 'B'.repeat(64),
      runtime: null,
      layers: [],
    };
    const sorted = runVerifier({ lock: lockWith([fullwidth, emoji]) });
    assert.equal(sorted.status, 0, failureOf(sorted));
    const reversed = runVerifier({ lock: lockWith([emoji, fullwidth]) });
    assert.equal(reversed.status, 1, failureOf(reversed));
    assert.match(failureOf(reversed), /owned is not sorted by path, kind, and key/);
  },
);

test(
  'a json-entries record may carry createdKey true, and createdKey is refused in any other value',
  { skip },
  () => {
    const created = OWNED.map((record) =>
      record.key === 'skills' ? { ...record, createdKey: true } : record,
    );
    const passed = runVerifier({
      lock: lockWith(created, { createdDirs: ['.claude', '.claude/plugins'], createdFiles: [] }),
    });
    assert.equal(passed.status, 0, failureOf(passed));

    const falsy = OWNED.map((record) =>
      record.key === 'skills' ? { ...record, createdKey: false } : record,
    );
    const refused = runVerifier({ lock: lockWith(falsy) });
    assert.equal(refused.status, 1, failureOf(refused));
    assert.match(failureOf(refused), /createdKey, when present, must be true/);
  },
);

test(
  'createdDirs and createdFiles are lists of workspace paths, sorted once each',
  { skip },
  () => {
    const backslash = runVerifier({ lock: lockWith(OWNED, { createdDirs: ['.maxstack\\bin'] }) });
    assert.equal(backslash.status, 1, failureOf(backslash));
    assert.match(failureOf(backslash), /createdDirs must be a list of workspace-relative paths/);

    const twice = runVerifier({
      lock: lockWith(OWNED, {
        createdFiles: ['.pi/agent/settings.json', '.pi/agent/settings.json'],
      }),
    });
    assert.equal(twice.status, 1, failureOf(twice));
    assert.match(failureOf(twice), /createdFiles names a path twice/);
  },
);

test('a backup record is an ordinary file record, and it is accepted', { skip }, () => {
  const backup = [
    ...OWNED,
    {
      path: 'opencode.jsonc.bak',
      kind: 'file',
      sha256: 'E'.repeat(64),
      runtime: 'opencode',
      layers: [],
    },
  ];
  const run = runVerifier({ lock: lockWith(backup) });
  assert.equal(run.status, 0, failureOf(run));
});

test(
  'a record whose runtime does not match its path, or whose layers are unsorted, is refused',
  { skip },
  () => {
    const wrongRuntime = OWNED.map((record) =>
      record.path === 'opencode.jsonc' ? { ...record, runtime: 'pi' } : record,
    );
    const mismatch = runVerifier({ lock: lockWith(wrongRuntime) });
    assert.equal(mismatch.status, 1, failureOf(mismatch));
    assert.match(failureOf(mismatch), /runtime is pi, but its path belongs to opencode/);

    const unsorted = OWNED.map((record) =>
      record.path === '.claude/plugins/pstack' ? { ...record, layers: ['pstack', 'org'] } : record,
    );
    const order = runVerifier({ lock: lockWith(unsorted) });
    assert.equal(order.status, 1, failureOf(order));
    assert.match(failureOf(order), /layers must be sorted by UTF-8 bytes, once each/);
  },
);

test(
  'an ownership record at ownedSchema 1 is refused, and the message says to run -Apply once',
  { skip },
  () => {
    const run = runVerifier({ lock: { ...lockWith(OWNED), ownedSchema: 1 } });
    assert.equal(run.status, 1, failureOf(run));
    assert.match(
      failureOf(run),
      /ownedSchema must be 2; run bun scripts\/install\/main\.ts -Apply once/,
    );
  },
);

// The source block each layer keeps in stack.lock.json. The shape check is shared with the workspace verifier, so these
// cases run the manifest verifier's --lock check on a lock that holds one layer's source.
const COMMIT = 'a'.repeat(40);
const GIT_SOURCE = {
  kind: 'git',
  url: 'https://github.com/simpsonm09/pstack-max.git',
  ref: 'feat',
  commit: COMMIT,
  override: true,
};
const LOCAL_SOURCE = {
  kind: 'local',
  url: null,
  ref: null,
  commit: COMMIT,
  dirty: false,
  override: true,
  path: 'projects/repos/checkout',
};

function lockWithSource(source) {
  return { ownedSchema: 2, owned: [], layers: [{ name: 'pstack', source }] };
}

test(
  'a git or local source block passes the lock shape check, and a legacy source string passes too',
  { skip },
  () => {
    for (const source of [
      GIT_SOURCE,
      LOCAL_SOURCE,
      'https://github.com/simpsonm09/pstack-max.git',
    ]) {
      const run = runVerifier({ lock: lockWithSource(source) });
      assert.equal(run.status, 0, `${JSON.stringify(source)}: ${failureOf(run)}`);
    }
  },
);

test('a malformed source block is refused, with the rule it breaks', { skip }, () => {
  const { ref: _ref, ...withoutRef } = GIT_SOURCE;
  const cases = [
    [{ ...GIT_SOURCE, kind: 'svn' }, /source kind must be one of/],
    [{ ...GIT_SOURCE, commit: 'ABC' }, /commit must be a 40-character lowercase commit SHA/],
    [{ ...GIT_SOURCE, override: 'yes' }, /source override must be true or false/],
    [withoutRef, /must hold exactly/],
    [
      { ...GIT_SOURCE, url: 'https://github.com/simpsonm09/pstack-max .git' },
      /url must be a source URL with no spaces/,
    ],
    [{ ...LOCAL_SOURCE, dirty: null }, /dirty must be true or false where there is a commit/],
    [{ ...LOCAL_SOURCE, commit: null }, /dirty must be null where there is no commit/],
    [{ ...LOCAL_SOURCE, path: '' }, /path must name the checkout folder/],
    [{ ...LOCAL_SOURCE, extra: 1 }, /must hold exactly/],
    [null, /source must be an object, or the legacy string/],
  ];
  for (const [source, reason] of cases) {
    const run = runVerifier({ lock: lockWithSource(source) });
    assert.equal(run.status, 1, `${JSON.stringify(source)} passed`);
    assert.match(failureOf(run), reason, JSON.stringify(source));
  }
});

// The decision log is read as lines, so a carriage return inside a field or a line with other than six tab-separated fields
// changes what every reader sees. The verifier refuses both.
test(
  'the decision log has exactly six tab-separated fields per line and no carriage return',
  { skip },
  () => {
    const header = ['ts', 'phase', 'decision', 'why', 'evidence', 'result'].join('\t');
    const row = [
      '2026-10-11T05:47:28-04:00',
      'phase',
      'a decision',
      'a reason',
      'evidence',
      'verified',
    ].join('\t');
    const good = `${header}\n${row}\n`;
    let run = runVerifier({ extraFiles: { 'docs/decisions.tsv': good } });
    assert.equal(run.status, 0, failureOf(run));

    const carriage = `${header}\n${row.replace('a decision', `a deci${String.fromCharCode(13)}sion`)}\n`;
    run = runVerifier({ extraFiles: { 'docs/decisions.tsv': carriage } });
    assert.equal(run.status, 1, failureOf(run));
    assert.match(failureOf(run), /decisions\.tsv.*carriage return/);

    const short = `${header}\na\tb\tc\td\te\n`;
    run = runVerifier({ extraFiles: { 'docs/decisions.tsv': short } });
    assert.equal(run.status, 1, failureOf(run));
    assert.match(
      failureOf(run),
      /decisions\.tsv line 2 has 5 tab-separated fields; each line has six/,
    );
  },
);

// A device prefix and a UNC path are written with their full leading backslashes in the docs. A single backslash is a different,
// relative path, so the example would not say what the installer refuses. The form \\?\UNC\server\share is correct, so a bare
// \server\share counts only where it starts a token, not after the UNC separator.
test('the docs write device prefixes and UNC paths with their two leading backslashes', () => {
  const singleBackslashPrefix = /(?:^|[^\\])\\(?:\?\\|\.\\)/m;
  const singleBackslashShare = /(?:^|[\s`(])\\server\\share/m;
  for (const doc of ['docs/features/settings.md', 'docs/install.md']) {
    const text = readFileSync(join(repoRoot, doc), 'utf8');
    assert.doesNotMatch(
      text,
      singleBackslashPrefix,
      `${doc} writes a device prefix with one leading backslash`,
    );
    assert.doesNotMatch(
      text,
      singleBackslashShare,
      `${doc} writes a UNC share with one leading backslash`,
    );
  }
});

// Finding 18: the settings doc states the os and t3 rules once. A repeated paragraph is a second copy that drifts.
test('the settings doc states the os and t3 rules once', { skip }, () => {
  const text = readFileSync(join(repoRoot, 'docs', 'features', 'settings.md'), 'utf8');
  assert.equal(
    text.split('`os` accepts').length - 1,
    1,
    'the os and t3 paragraph appears more than once in docs/features/settings.md',
  );
});
