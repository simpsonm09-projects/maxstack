// maxstack.settings.json: the reader, its notes, and the -InitSettings seed. The file is strict JSON, and its hash is
// taken over a canonical form with each object key sorted ordinally.
import { lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertSurrogateEscapes, assertTextBoundaryTree, compareUtf8Bytes, isTrue, ordinalEqual, ordinalIn, ordinalSorted, ordinalUnique, safeName } from './ordinal.ts';
import { convertToMaxstackPath, joinMaxstackPath, maxstackPathEqual, maxstackPathInside, trimMaxstackPathEndingSeparator, type Platform } from './paths.ts';
import { isMaxstackLink } from './links.ts';
import { isMaxstackCheckoutLocation } from './discovery.ts';
import {
  fullFolderPath,
  githubRemoteUrl,
  isCommitRef,
  isHttpsGitUrl,
  localCheckoutState,
  localPathFault,
  localPathTextFault,
  normalPath,
  readSourceGrammar,
  safeRefNameSyntax,
  specFault,
  type SourceChoice,
} from './layer-sources.ts';
import { getField, hasField, isDirectory, sha256Text, writeHost, writeWarning } from './util.ts';
import { canonicalJsonValue, parseStrictJsonText } from './json.ts';

export const SETTINGS_TOP_LEVEL_KEYS = ['$schema', 'version', 'os', 'runtimes', 'layers', 't3'];
export const SETTINGS_RUNTIME_IDS = ['antigravity', 'claude', 'codex', 'copilot', 'cursor', 'opencode', 'pi'];
export const SETTINGS_CLI_MODES = ['detect', 'install'];
export const SETTINGS_OS_MODES = ['auto', 'windows', 'macos', 'linux'];
export const SETTINGS_T3_DEFAULTS = ['leave-alone', 'apply-defaults'];
export const SETTINGS_SOURCE_MAX_LENGTH = 2048;
export const SETTINGS_MAX_DEPTH = 32;

export interface SettingsDocument {
  present: boolean;
  value: Record<string, unknown> | null;
  hash: string | null;
}

export interface SettingsChoice {
  kind: string;
  path: string | null;
  reason: string | null;
  url: string | null;
  ref: string | null;
}

const ABSENT: SettingsDocument = { present: false, value: null, hash: null };

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertSettingsObjectKeys(value: unknown, allowed: readonly string[], where: string): void {
  if (!isObject(value)) throw new Error(`maxstack.settings.json: ${where} must be an object.`);
  for (const key of Object.keys(value)) {
    if (!ordinalIn(key, allowed)) {
      throw new Error(
        `maxstack.settings.json: unknown key '${safeName(key)}' in ${where}. Valid keys: ${allowed.join(', ')}.`,
      );
    }
  }
}

function assertSettingsSource(name: string, value: unknown, platform?: Platform): void {
  const where = `maxstack.settings.json: layers.${name}.source`;
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > SETTINGS_SOURCE_MAX_LENGTH) {
    throw new Error(
      `${where} must be a non-empty source string of at most ${SETTINGS_SOURCE_MAX_LENGTH} characters.`,
    );
  }
  const grammar = readSourceGrammar(value, { settings: true, noGit: true, platform });
  switch (grammar.code) {
    case null:
    case undefined:
      break;
    case 'forbidden':
      throw new Error(`${where}${grammar.reason}`);
    case 'unsafe-local':
      throw new Error(`${where} has an unsafe local path. Use local:<workspace-relative-path>.`);
    case 'local-text':
      throw new Error(`${where}${grammar.reason}`);
    default:
      throw new Error(
        `${where} is not a supported source. Use owner/repo@ref, https://host/path.git@ref, local:<path>, or default.`,
      );
  }
  if (ordinalEqual(grammar.kind, 'local') && grammar.absolute) writeSettingsMachinePathWarning(name);
}

function testSettingsLocalReadable(path: string): boolean {
  try {
    readdirSync(path);
    return true;
  } catch {
    return false;
  }
}

function newSettingsLocalChoice(path: string, reason: string): SettingsChoice {
  return { kind: 'unavailable', path, reason, url: null, ref: null };
}

function getSettingsLocalSource(
  _name: string,
  path: string,
  absolute: boolean,
  workspaceRoot: string,
  repoRoot: string,
): SettingsChoice {
  const written = absolute ? path : joinMaxstackPath(workspaceRoot, convertToMaxstackPath(path));
  const fault = localPathFault(written);
  const candidate = fullFolderPath(written);
  if (fault) return newSettingsLocalChoice(candidate, `local path ${fault}`);
  if (!absolute) {
    const normal = normalPath(candidate);
    if (!maxstackPathInside(normal, normalPath(workspaceRoot))) {
      return newSettingsLocalChoice(
        candidate,
        'local path resolves outside the workspace through a link, which cannot be a layer source.',
      );
    }
    if (isMaxstackCheckoutLocation(normal, repoRoot)) {
      return newSettingsLocalChoice(candidate, 'local path is a maxstack checkout, which cannot be a layer source.');
    }
  }
  if (!isDirectory(candidate)) {
    return newSettingsLocalChoice(candidate, `resolves to no folder at ${safeName(candidate)}.`);
  }
  if (!testSettingsLocalReadable(candidate)) {
    return newSettingsLocalChoice(
      candidate,
      `cannot be read at ${safeName(candidate)}: the folder could not be listed.`,
    );
  }
  const state = localCheckoutState(candidate);
  if (state.unreadable) {
    return newSettingsLocalChoice(
      candidate,
      `cannot be read at ${safeName(candidate)}: ${safeName(String(state.unreadable))}.`,
    );
  }
  return { kind: 'local', path: candidate, reason: null, url: null, ref: null };
}

/** The source one layers.<name>.source declares for this run. */
export function getSettingsLayerSource(
  name: string,
  spec: string,
  workspaceRoot: string,
  repoRoot: string,
): SettingsChoice {
  const grammar = readSourceGrammar(spec, { settings: true });
  if (grammar.code) {
    return { kind: 'unavailable', path: null, reason: 'is not a usable source.', url: null, ref: null };
  }
  if (ordinalEqual(grammar.kind, 'default')) {
    return { kind: 'default', path: null, reason: null, url: null, ref: null };
  }
  if (ordinalEqual(grammar.kind, 'local')) {
    return getSettingsLocalSource(
      name,
      grammar.path as string,
      Boolean(grammar.absolute),
      workspaceRoot,
      repoRoot,
    );
  }
  const owner = (grammar as unknown as { owner?: string }).owner;
  const repo = (grammar as unknown as { repo?: string }).repo;
  const url = grammar.url ?? (owner && repo ? githubRemoteUrl(owner, repo) : null);
  return { kind: 'git', path: null, reason: null, url, ref: grammar.ref ?? null };
}

function testSettingsSourceMatchesRecord(declared: SettingsChoice, recorded: SourceChoice): boolean {
  if (!ordinalEqual(declared.kind, recorded.kind)) return false;
  if (ordinalEqual(declared.kind, 'git')) {
    return ordinalEqual(declared.url, recorded.url) && ordinalEqual(declared.ref, recorded.ref);
  }
  return ordinalEqual(normalPath(String(declared.path)), normalPath(String(recorded.path)));
}

/** Says what the settings file declares for each layer source. */
export function writeSettingsSourceNotes(
  settings: SettingsDocument,
  declared: Map<string, SettingsChoice>,
  recorded: Map<string, SourceChoice>,
  reporting: boolean,
): void {
  for (const name of getSettingsNames(settings, 'layers')) {
    if (!declared.has(name)) continue;
    const source = declared.get(name) as SettingsChoice;
    if (ordinalEqual(source.kind, 'unavailable')) continue;
    if (ordinalEqual(source.kind, 'default')) {
      if (recorded.has(name)) {
        writeHost(`Settings: layers.${name}.source is default; an apply drops the recorded override.`);
      }
      continue;
    }
    if (reporting) {
      writeHost(
        `Settings: layers.${name}.source is declared; a read-only run uses the recorded source, and only an apply uses the declaration.`,
      );
    }
    if (recorded.has(name) && !testSettingsSourceMatchesRecord(source, recorded.get(name) as SourceChoice)) {
      writeHost(`Settings: layers.${name}.source differs from its recorded override.`);
    }
  }
  for (const name of ordinalSorted([...recorded.keys()])) {
    if (!declared.has(name)) {
      writeHost(`Settings: layers.${name} has no source in maxstack.settings.json; its recorded override is kept.`);
    }
  }
}

/** A settings source this run cannot use, for a selected layer. */
export function writeSettingsSourceProblems(
  layers: readonly { name: string; settingsSourced?: boolean; settingsFault?: string | null }[],
  selectedLayers: readonly string[],
  applying: boolean,
): void {
  for (const layer of layers) {
    if (!(layer.settingsSourced && layer.settingsFault && ordinalIn(layer.name, selectedLayers))) continue;
    if (applying) {
      throw new Error(
        `maxstack.settings.json: layers.${layer.name}.source ${layer.settingsFault} Fix it there, or repair with: bun scripts/install/main.ts -Source ${layer.name}=default -Apply`,
      );
    }
    writeHost(
      `Settings: layers.${layer.name}.source ${layer.settingsFault} This run skips layer ${layer.name} and has no fallback.`,
    );
  }
}

function decodeUtf8Strict(bytes: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function readBoundedFile(path: string, limit: number): { bytes: Buffer } | { missing: true } | { tooLarge: true } {
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    return { missing: true };
  }
  if (stats.size > limit) return { tooLarge: true };
  const bytes = readFileSync(path);
  if (bytes.length > limit) return { tooLarge: true };
  return { bytes };
}

/** Reads maxstack.settings.json as strict JSON. */
export function readMaxstackSettings(path: string, layerNames: readonly string[], platform?: Platform): SettingsDocument {
  let entry;
  try {
    entry = lstatSync(path);
  } catch {
    return ABSENT;
  }
  if (entry.isSymbolicLink()) {
    throw new Error('maxstack.settings.json settings path is a symbolic link or reparse point.');
  }
  if (entry.isDirectory()) throw new Error('maxstack.settings.json settings path is a directory.');
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    throw new Error(
      'maxstack.settings.json could not be read: another process has it open, or it is not accessible.',
    );
  }
  if (bytes.length > 65536) throw new Error('maxstack.settings.json is larger than the 65536 byte limit.');
  const offset = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  const text = decodeUtf8Strict(bytes.subarray(offset));
  if (text === null) throw new Error('maxstack.settings.json is not valid UTF-8.');
  assertSurrogateEscapes(text, 'maxstack.settings.json');
  const parsed = parseStrictJsonText(text, SETTINGS_MAX_DEPTH);
  if (!parsed.ok) {
    if (parsed.reason === 'duplicate') {
      throw new Error(`duplicate key '${safeName(parsed.duplicate.key)}' at ${parsed.duplicate.at}`);
    }
    if (parsed.reason === 'depth') {
      throw new Error(`maxstack.settings.json is nested deeper than ${SETTINGS_MAX_DEPTH} levels.`);
    }
    throw new Error('maxstack.settings.json is not strict JSON. Comments and trailing commas are not allowed.');
  }
  if (!isObject(parsed.value)) throw new Error('maxstack.settings.json must hold one JSON object.');
  const value = parsed.value;
  assertTextBoundaryTree(value, 'maxstack.settings.json');
  assertSettingsObjectKeys(value, SETTINGS_TOP_LEVEL_KEYS, 'the top level');
  if (hasField(value, '$schema') && typeof value.$schema !== 'string') {
    throw new Error('maxstack.settings.json: $schema must be a string.');
  }
  if (!hasField(value, 'version')) throw new Error('maxstack.settings.json needs "version": 1.');
  if (value.version !== 1) throw new Error('maxstack.settings.json needs "version": 1.');
  if (hasField(value, 'os') && !ordinalIn(value.os, SETTINGS_OS_MODES)) {
    throw new Error(
      `maxstack.settings.json: os has an unsupported value. Valid values: ${SETTINGS_OS_MODES.join(', ')}.`,
    );
  }
  if (hasField(value, 'runtimes')) {
    if (!isObject(value.runtimes)) throw new Error('maxstack.settings.json: runtimes must be an object.');
    assertSettingsObjectKeys(value.runtimes, SETTINGS_RUNTIME_IDS, 'runtimes');
    if (Object.keys(value.runtimes).length === 0) {
      throw new Error('maxstack.settings.json: runtimes names no runtime. Omit it to use the recorded selection.');
    }
    for (const runtime of Object.keys(value.runtimes)) {
      const entryValue = value.runtimes[runtime];
      assertSettingsObjectKeys(entryValue, ['cli'], `runtimes.${runtime}`);
      if (hasField(entryValue, 'cli') && !ordinalIn(getField(entryValue, 'cli'), SETTINGS_CLI_MODES)) {
        throw new Error(`maxstack.settings.json: runtimes.${runtime}.cli must be detect or install.`);
      }
    }
  }
  if (hasField(value, 'layers')) {
    if (!isObject(value.layers)) throw new Error('maxstack.settings.json: layers must be an object.');
    assertSettingsObjectKeys(value.layers, layerNames, 'layers');
    if (Object.keys(value.layers).length === 0) {
      throw new Error('maxstack.settings.json: layers names no layer. Omit it to use the recorded selection.');
    }
    for (const layer of Object.keys(value.layers)) {
      const entryValue = value.layers[layer];
      assertSettingsObjectKeys(entryValue, ['source'], `layers.${layer}`);
      if (hasField(entryValue, 'source')) assertSettingsSource(layer, getField(entryValue, 'source'), platform);
    }
  }
  if (hasField(value, 't3')) {
    if (!isObject(value.t3)) throw new Error('maxstack.settings.json: t3 must be an object.');
    assertSettingsObjectKeys(value.t3, ['cli', 'snapshot', 'defaults', 'gatedInstances', 'readOnlyInstances'], 't3');
    if (hasField(value.t3, 'cli') && !ordinalIn(getField(value.t3, 'cli'), SETTINGS_CLI_MODES)) {
      throw new Error('maxstack.settings.json: t3.cli must be detect or install.');
    }
    if (hasField(value.t3, 'snapshot') && typeof getField(value.t3, 'snapshot') !== 'boolean') {
      throw new Error('maxstack.settings.json: t3.snapshot must be true or false.');
    }
    if (hasField(value.t3, 'defaults') && !ordinalIn(getField(value.t3, 'defaults'), SETTINGS_T3_DEFAULTS)) {
      throw new Error('maxstack.settings.json: t3.defaults must be leave-alone or apply-defaults.');
    }
    if (hasField(value.t3, 'defaults') && ordinalEqual(getField(value.t3, 'defaults'), 'apply-defaults')) {
      writeWarning('t3.defaults apply-defaults is reserved and unsupported in this release; T3 settings are left alone.');
    }
    const allInstances = new Set<string>();
    for (const listName of ['gatedInstances', 'readOnlyInstances']) {
      if (!hasField(value.t3, listName)) continue;
      const list = getField(value.t3, listName);
      if (!Array.isArray(list)) {
        throw new Error(`maxstack.settings.json: t3.${listName} must be an array of unique instance ids.`);
      }
      const seen = new Set<string>();
      for (const instance of list) {
        if (
          typeof instance !== 'string' ||
          !/^[A-Za-z0-9_-]+$/.test(instance) ||
          seen.has(instance)
        ) {
          throw new Error(
            `maxstack.settings.json: t3.${listName} must contain unique non-empty ids made only of letters, digits, hyphens, and underscores.`,
          );
        }
        seen.add(instance);
        if (allInstances.has(instance)) {
          throw new Error(
            `maxstack.settings.json: T3 instance id '${instance}' cannot appear in both t3.gatedInstances and t3.readOnlyInstances.`,
          );
        }
        allInstances.add(instance);
      }
    }
  }
  const canonical = JSON.stringify(canonicalJsonValue(value));
  const sha = sha256Text(canonical);
  return { present: true, value, hash: sha };
}

/** Says each runtime or layer that maxstack.settings.json adds and the selection does not hold yet. */
export function writePendingSettingsNotes(
  runtimes: readonly string[],
  layers: readonly string[],
  claudeAvailable: boolean,
  applying: boolean,
  updating: boolean,
): void {
  for (const name of runtimes) {
    if (updating) {
      writeHost(
        `Settings: pending runtime '${name}' from maxstack.settings.json is not selected by -Update; run -Apply to select it.`,
      );
      continue;
    }
    if (applying) {
      writeHost(`Settings: runtime '${name}' from maxstack.settings.json is selected by this apply.`);
      continue;
    }
    const refusal =
      ordinalIn(name, ['copilot', 'pi']) && !claudeAvailable
        ? ' -Apply refuses it: it needs claude, which nothing lists.'
        : '';
    writeHost(
      `Settings: pending runtime '${name}' from maxstack.settings.json will be selected on -Apply.${refusal}`,
    );
  }
  for (const name of layers) {
    if (updating) {
      writeHost(
        `Settings: pending layer '${name}' from maxstack.settings.json is not selected by -Update; run -Apply to select it.`,
      );
      continue;
    }
    if (applying) {
      writeHost(`Settings: layer '${name}' from maxstack.settings.json is selected by this apply.`);
      continue;
    }
    writeHost(`Settings: pending layer '${name}' from maxstack.settings.json will be selected on -Apply.`);
  }
}

export function getSettingsNames(settings: SettingsDocument, key: string): string[] {
  if (!settings.present || !settings.value || !hasField(settings.value, key)) return [];
  const block = getField(settings.value, key);
  return isObject(block) ? Object.keys(block) : [];
}

/** The settings a removal reads, for its notes only. It never throws. */
export function readSettingsForRemoval(path: string, layerNames: readonly string[]): SettingsDocument {
  try {
    return readMaxstackSettings(path, layerNames);
  } catch {
    return ABSENT;
  }
}

/** Says each removed runtime or layer that the settings file still lists. */
export function writeRemovalSettingsNotes(
  settings: SettingsDocument,
  runtimes: readonly string[],
  layers: readonly string[],
): void {
  if (!settings.present) return;
  const listedRuntimes = getSettingsNames(settings, 'runtimes');
  const listedLayers = getSettingsNames(settings, 'layers');
  const tail = 'the next -Apply will select it again. Remove it from the settings file to keep it removed.';
  for (const name of runtimes.filter((value) => ordinalIn(value, listedRuntimes))) {
    writeHost(`Settings: runtime '${name}' is still listed in maxstack.settings.json; ${tail}`);
  }
  for (const name of layers.filter((value) => ordinalIn(value, listedLayers))) {
    writeHost(`Settings: layer '${name}' is still listed in maxstack.settings.json; ${tail}`);
  }
}

/** The recorded overrides a seed migrates, from a valid lock. */
export function getInitSettingsOverrides(stack: Record<string, unknown>): Map<string, Record<string, unknown>> {
  const overrides = new Map<string, Record<string, unknown>>();
  const layers = Array.isArray(stack.layers) ? (stack.layers as unknown[]) : [];
  for (const layer of layers) {
    const block = getField(layer, 'source');
    if (!isObject(block) || !isTrue(getField(block, 'override'))) continue;
    const name = String(getField(layer, 'name'));
    const kind = getField(block, 'kind');
    if (ordinalEqual(kind, 'git')) {
      const url = String(getField(block, 'url') ?? '');
      const ref = String(getField(block, 'ref') ?? '');
      const commit = String(getField(block, 'commit') ?? '');
      if (!isHttpsGitUrl(url) || specFault(url) || !safeRefNameSyntax(ref) || !isCommitRef(commit)) {
        throw new Error(
          `-InitSettings cannot migrate the recorded git source for '${name}' because its URL, ref, or commit is invalid.`,
        );
      }
    } else if (ordinalEqual(kind, 'local')) {
      const fault = localPathTextFault(String(getField(block, 'path') ?? ''));
      if (fault) throw new Error(`-InitSettings cannot migrate the recorded local source for '${name}': ${fault}`);
    } else {
      throw new Error(`-InitSettings cannot migrate the recorded source for '${name}' because its kind is invalid.`);
    }
    overrides.set(name, block);
  }
  return overrides;
}

/** The spec a recorded override becomes in the settings file. */
export function convertToInitSettingsSpec(
  name: string,
  source: Record<string, unknown>,
  workspaceRoot: string,
): string {
  if (ordinalEqual(source.kind, 'git')) {
    const url = String(source.url ?? '');
    const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url);
    if (match) return `${match[1]}/${match[2]}@${String(source.ref)}`;
    return `${url}@${String(source.ref)}`;
  }
  const path = resolve(String(source.path ?? ''));
  const root = trimMaxstackPathEndingSeparator(resolve(workspaceRoot));
  if (maxstackPathEqual(path, root)) {
    throw new Error(`-InitSettings cannot represent layer '${name}' as a local source at the workspace root.`);
  }
  if (maxstackPathInside(path, root)) {
    const relativePath = relativeFrom(root, path);
    return `local:${relativePath}`;
  }
  return `local:${path}`;
}

function relativeFrom(root: string, path: string): string {
  const parts = root.split(/[\\/]/).filter(Boolean);
  const target = path.split(/[\\/]/).filter(Boolean);
  let common = 0;
  while (common < parts.length && common < target.length && parts[common] === target[common]) common++;
  const result: string[] = [];
  for (let index = common; index < parts.length; index++) result.push('..');
  for (let index = common; index < target.length; index++) result.push(target[index] as string);
  return result.join('/');
}

/** The seed value: the lock's selection, and a source for each recorded override. */
export function convertToInitSettingsValue(
  stack: Record<string, unknown>,
  workspaceRoot: string,
): Record<string, unknown> {
  const selection = getField(stack, 'selection');
  const runtimes = ordinalSorted(ordinalUnique(getField(selection, 'runtimes') as unknown[]));
  const layers = ordinalSorted(ordinalUnique(getField(selection, 'layers') as unknown[]));
  const overrides = getInitSettingsOverrides(stack);
  const settingsLayers: Record<string, unknown> = {};
  for (const name of layers) {
    const entry: Record<string, unknown> = {};
    if (overrides.has(name)) {
      const spec = convertToInitSettingsSpec(name, overrides.get(name) as Record<string, unknown>, workspaceRoot);
      const grammar = readSourceGrammar(spec, { settings: true, noGit: true });
      if (grammar.code) {
        throw new Error(`-InitSettings cannot represent the recorded source of layer '${name}' as a settings source.`);
      }
      if (ordinalEqual(grammar.kind, 'local') && grammar.absolute) writeSettingsMachinePathWarning(name);
      entry.source = spec;
    }
    settingsLayers[name] = entry;
  }
  const settingsRuntimes: Record<string, unknown> = {};
  for (const name of runtimes) settingsRuntimes[name] = {};
  return { version: 1, runtimes: settingsRuntimes, layers: settingsLayers };
}

/** The seed as text, with format and separator characters escaped inside strings. */
export function convertToInitSettingsText(settings: Record<string, unknown>): string {
  const json = JSON.stringify(settings, null, 2);
  return json.replace(/"(?:[^"\\]|\\.)*"/g, (match) =>
    match.replace(/[\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/gu, (character) => {
      return `\\u${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
    }),
  );
}

export const LOCK_KEY_VOCABULARY = [
  'generatedAt', 'workspace', 'selection', 'runtimes', 'layers', 'configSha256', 'copilot', 'pi', 'ownedSchema',
  'owned', 'createdDirs', 'createdFiles', 'settings', 'file', 'version', 'sha256', 'claudeMarketplaceSha256',
  'claudeSettingsSha256', 'name', 'kind', 'source', 'claude', 'opencode', 'enabled', 'commit', 'dirty', 'override',
  'url', 'ref', 'path', 'wrappers', 'cmdSha256', 'agentDir', 'shSha256', 'runtime', 'target', 'plugin', 'key',
  'entries', 'items', 'createdKey', 'quarantine', 'treeSha256', 'role', 'backup', 'skills', 'layer', 'unknown',
  'loader', 'dir', 'entry', 'state',
];

function assertLockKeySpelling(value: unknown, where: string): void {
  if (typeof value === 'string') return;
  if (Array.isArray(value)) {
    for (const item of value) assertLockKeySpelling(item, `${where}[]`);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (!ordinalIn(key, LOCK_KEY_VOCABULARY)) {
        const spelled = LOCK_KEY_VOCABULARY.find(
          (candidate) => candidate.toLowerCase() === key.toLowerCase(),
        );
        if (spelled) throw new Error(`${where} key '${safeName(key)}' must be spelled ${spelled}.`);
      }
      assertLockKeySpelling(child, `${where}.${safeName(key)}`);
    }
  }
}

/** The lock's shape the readers rely on. */
export function assertLockShape(stack: unknown): void {
  assertLockKeySpelling(stack, 'stack.lock.json');
  const ownedRecords = getField(stack, 'owned');
  if (ownedRecords !== null && ownedRecords !== undefined) {
    for (const record of ownedRecords as unknown[]) {
      if (record === null || record === undefined) throw new Error('stack.lock.json has a null ownership record.');
      const claimsProperty = hasField(record, 'runtimes');
      const runtimeProperty = hasField(record, 'runtime');
      const path = getField(record, 'path');
      const agentSkillPath = typeof path === 'string' && path.startsWith('.agents/skills/');
      const skillName = agentSkillPath ? path.slice('.agents/skills/'.length) : '';
      if (agentSkillPath && !claimsProperty && !runtimeProperty) {
        throw new Error('stack.lock.json has an agent skill ownership record with no runtime attribution.');
      }
      if (claimsProperty && runtimeProperty) {
        throw new Error('stack.lock.json must use runtime or runtimes, not both.');
      }
      if (
        agentSkillPath &&
        runtimeProperty &&
        (!ordinalEqual(getField(record, 'runtime'), 'codex') ||
          !ordinalEqual(getField(record, 'kind'), 'dir') ||
          !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(skillName))
      ) {
        throw new Error('stack.lock.json has an invalid legacy Codex skill ownership record.');
      }
      if (!claimsProperty) continue;
      const runtimeClaims = getField(record, 'runtimes');
      if (
        !agentSkillPath ||
        !ordinalEqual(getField(record, 'kind'), 'dir') ||
        !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(skillName) ||
        !Array.isArray(runtimeClaims) ||
        runtimeClaims.length === 0
      ) {
        throw new Error('stack.lock.json has an invalid shared skill ownership record.');
      }
      let previous: string | null = null;
      for (const runtime of runtimeClaims as unknown[]) {
        if (
          typeof runtime !== 'string' ||
          !ordinalIn(runtime, ['antigravity', 'codex']) ||
          (previous !== null && compareUtf8Bytes(previous, runtime) >= 0)
        ) {
          throw new Error('stack.lock.json has invalid or unsorted shared skill runtime claims.');
        }
        previous = runtime;
      }
    }
  }
  const layers = getField(stack, 'layers');
  if (Array.isArray(layers)) {
    for (const layer of layers) {
      const source = getField(layer, 'source');
      if (!isObject(source)) continue;
      const kind = getField(source, 'kind');
      if (kind === null || kind === undefined) {
        throw new Error(
          `stack.lock.json layer '${safeName(String(getField(layer, 'name')))}' has a malformed source: it names no kind.`,
        );
      }
    }
  }
}

/** Reads the lock as strict JSON, for a seed only. */
export function readInitSettingsLock(path: string, layerNames: readonly string[]): Record<string, unknown> {
  const read = readBoundedFile(path, 65536);
  if ('missing' in read) throw new Error('-InitSettings cannot read stack.lock.json as strict JSON.');
  if ('tooLarge' in read) {
    throw new Error('-InitSettings cannot read stack.lock.json because it is larger than the 65536 byte limit.');
  }
  const bytes = read.bytes;
  const offset = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  const text = decodeUtf8Strict(bytes.subarray(offset));
  if (text === null) throw new Error('-InitSettings cannot read stack.lock.json because it is not valid UTF-8.');
  assertSurrogateEscapes(text, 'stack.lock.json');
  const parsed = parseStrictJsonText(text, SETTINGS_MAX_DEPTH);
  if (!parsed.ok) {
    if (parsed.reason === 'duplicate') {
      throw new Error('-InitSettings cannot read stack.lock.json because it has a duplicate key.');
    }
    throw new Error('-InitSettings cannot read stack.lock.json as strict JSON.');
  }
  if (!isObject(parsed.value)) throw new Error('-InitSettings cannot read stack.lock.json as strict JSON.');
  const stack = parsed.value;
  assertTextBoundaryTree(stack, 'stack.lock.json');
  assertLockShape(stack);
  const schema = getField(stack, 'ownedSchema');
  if (schema !== 1 && schema !== 2) {
    throw new Error('-InitSettings needs a stack.lock.json with ownedSchema 1 or 2.');
  }
  const selection = getField(stack, 'selection');
  if (!isObject(selection)) throw new Error('-InitSettings needs a valid recorded selection in stack.lock.json.');
  for (const key of Object.keys(selection)) {
    if (!ordinalIn(key, ['runtimes', 'layers'])) {
      throw new Error('-InitSettings cannot migrate a selection with an unknown field.');
    }
  }
  for (const [key, allowed] of [
    ['runtimes', SETTINGS_RUNTIME_IDS],
    ['layers', layerNames],
  ] as const) {
    const names = getField(selection, key);
    if (!Array.isArray(names) || names.length === 0) {
      throw new Error(`-InitSettings needs a valid recorded ${key} selection in stack.lock.json.`);
    }
    const seen = new Set<string>();
    for (const name of names) {
      if (typeof name !== 'string' || !ordinalIn(name, allowed) || seen.has(name)) {
        throw new Error(`-InitSettings cannot migrate an unknown, duplicate, or invalid ${key} selection.`);
      }
      seen.add(name);
    }
  }
  const layerRecords = getField(stack, 'layers');
  if (!Array.isArray(layerRecords)) {
    throw new Error('-InitSettings cannot migrate a lock without a valid layers list.');
  }
  const seenLayers = new Set<string>();
  for (const layer of layerRecords) {
    const layerName = getField(layer, 'name');
    if (
      !isObject(layer) ||
      typeof layerName !== 'string' ||
      !ordinalIn(layerName, layerNames) ||
      seenLayers.has(layerName)
    ) {
      throw new Error('-InitSettings cannot migrate an unknown, duplicate, or invalid layer record.');
    }
    seenLayers.add(layerName);
    const block = getField(layer, 'source');
    if (block !== null && block !== undefined && typeof block !== 'string' && !isObject(block)) {
      throw new Error('-InitSettings cannot migrate a malformed recorded source.');
    }
    if (isObject(block) && hasField(block, 'override') && typeof block.override !== 'boolean') {
      throw new Error('-InitSettings cannot migrate a malformed recorded source.');
    }
  }
  return stack;
}

/** Prints the seed, or with write creates the file when it is absent. Returns an exit code. */
export function invokeInitSettings(
  path: string,
  workspaceRoot: string,
  layerNames: readonly string[],
  write: boolean,
): number {
  const shown = safeName(path);
  let entry;
  try {
    entry = lstatSync(path);
  } catch {
    entry = null;
  }
  if (entry !== null) {
    if (entry.isSymbolicLink()) {
      throw new Error(`-InitSettings refuses ${shown}: it is a symbolic link or junction.`);
    }
    if (entry.isDirectory()) throw new Error(`-InitSettings cannot write because ${shown} is a directory.`);
    if (write) throw new Error(`-InitSettings refuses to overwrite existing ${shown}.`);
  }
  const stackPath = joinMaxstackPath(workspaceRoot, 'stack.lock.json');
  if (isMaxstackLink(stackPath)) throw new Error('-InitSettings refuses stack.lock.json: it is a symbolic link or junction.');
  let stackStats;
  try {
    stackStats = lstatSync(stackPath);
  } catch {
    stackStats = null;
  }
  if (!stackStats || !stackStats.isFile()) {
    process.stderr.write(
      '-InitSettings needs stack.lock.json. Copy workspace/maxstack.settings.json to the workspace, or run Install-Workspace.ps1 -Apply first.\n',
    );
    return 1;
  }
  const stack = readInitSettingsLock(stackPath, layerNames);
  const text = convertToInitSettingsText(convertToInitSettingsValue(stack, workspaceRoot));
  if (!write) {
    writeHost('InitSettings: derived settings file (dry run, no files written):');
    if (entry !== null) writeHost(`InitSettings: ${shown} exists, so -Apply would refuse to overwrite it.`);
    process.stdout.write(`${text}\n`);
    return 0;
  }
  try {
    writeFileSync(path, `${text}\n`, { encoding: 'utf8', flag: 'wx' });
  } catch {
    throw new Error(
      `-InitSettings could not create ${shown}: the file already exists, or the folder cannot take a new file.`,
    );
  }
  writeHost(`InitSettings: wrote ${shown}. No runtime files were changed.`);
  return 0;
}

/** The machine-path warning for a settings source. */
export function writeSettingsMachinePathWarning(name: string): void {
  writeWarning(`layers.${name}.source contains a machine path; use local: with a path relative to the workspace.`);
}
