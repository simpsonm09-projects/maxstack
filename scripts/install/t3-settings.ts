// T3 settings: the report that classifies an explicitly selected T3 settings file, the canonical snapshot
// text, and the snapshot writer. The allowlist and defaults under t3/ decide what is recorded, excluded,
// unknown, or unverifiable, and no excluded value is ever copied into the snapshot or printed.
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ordinalEqual, ordinalIn, ordinalSorted, ordinalUnique } from './ordinal.ts';
import { parseStrictJsonText } from './json.ts';
import { sha256File, writeHost } from './util.ts';

type Dict = Record<string, unknown>;

const TWO_MEGABYTES = 2 * 1024 * 1024;
const MAX_DEPTH = 64;

function isDict(value: unknown): value is Dict {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value: Dict, name: string): boolean {
  return Object.hasOwn(value, name);
}

/** The root that holds t3/allowlist.json and t3/defaults.json. Tests may point at a copied policy. */
function t3PolicyRoot(): string {
  return process.env.MAXSTACK_T3_POLICY_ROOT || dirname(dirname(dirname(fileURLToPath(import.meta.url))));
}

interface T3Rule {
  kind: string;
  values?: unknown[];
  keys?: Dict;
  nullable?: boolean;
  default?: unknown;
}

interface T3Policy {
  allowlist: Dict;
  defaultsTemplate: Dict;
  drivers: string[];
  enabledDefaults: Dict;
  configDefaults: Dict;
  allowed: Record<string, T3Rule>;
  excluded: Dict;
}

let policyCache: { root: string; policy: T3Policy } | null = null;

function getPolicy(): T3Policy {
  const root = t3PolicyRoot();
  if (policyCache && policyCache.root === root) return policyCache.policy;
  const allowlist = JSON.parse(readFileSync(join(root, 't3/allowlist.json'), 'utf8')) as Dict;
  const defaultsTemplate = JSON.parse(readFileSync(join(root, 't3/defaults.json'), 'utf8')) as Dict;
  const allowed: Record<string, T3Rule> = {};
  for (const key of Object.keys(allowlist.top as Dict)) {
    const rule = (allowlist.top as Dict)[key] as Dict;
    const normalized: T3Rule = { kind: String(rule.rule) };
    if (hasOwn(rule, 'values')) normalized.values = [...(rule.values as unknown[])];
    if (hasOwn(rule, 'keys')) normalized.keys = rule.keys as Dict;
    if (hasOwn(rule, 'nullable')) normalized.nullable = Boolean(rule.nullable);
    if (hasOwn(rule, 't3Default')) normalized.default = rule.t3Default;
    allowed[key] = normalized;
  }
  const policy: T3Policy = {
    allowlist,
    defaultsTemplate,
    drivers: Object.keys(allowlist.drivers as Dict),
    enabledDefaults: allowlist.driverEnabledDefaults as Dict,
    configDefaults: allowlist.driverConfigDefaults as Dict,
    allowed,
    excluded: allowlist.excluded as Dict,
  };
  policyCache = { root, policy };
  return policy;
}

/** The redacted form of a key name. A name that looks like a credential is not printed at all. */
export function getT3SafeKey(name: string): string {
  if (
    /(token|secret|password|credential|api[-_]?key|key)[^\p{L}\p{N}]{0,8}[a-z0-9+/=_-]{12,}/iu.test(name) ||
    /[A-Za-z0-9+/=_-]{32,}/.test(name) ||
    (name.length >= 40 && /[A-Z]/.test(name) && /[a-z]/.test(name) && /[0-9]/.test(name))
  ) {
    return '[redacted key name]';
  }
  const safe = name.replace(/[\p{Cc}\p{Cf}]/gu, '?');
  return safe.length > 80 ? `${safe.slice(0, 77)}...` : safe;
}

/** Whether a map holds a key, compared exactly. */
export function testT3ExactKey(map: unknown, name: string): boolean {
  if (Array.isArray(map)) return map.some((key) => String(key) === name);
  if (!isDict(map)) return false;
  return Object.keys(map).some((key) => key === name);
}

/** The value of an exact key, or null. */
export function getT3ExactValue(map: unknown, name: string): unknown {
  if (!isDict(map)) return null;
  for (const key of Object.keys(map)) if (key === name) return map[key];
  return null;
}

export interface T3Input {
  state: 'missing' | 'unreadable' | 'malformed' | 'present';
  value: Dict | null;
}

/** Reads the selected T3 settings file: strict UTF-8, strict JSON, one object, no duplicate keys, under 2 MiB. */
export function readT3Input(path: string): T3Input {
  if (!existsSync(path)) return { state: 'missing', value: null };
  let buffer: Buffer;
  try {
    const item = statSync(path);
    if (item.isDirectory()) return { state: 'unreadable', value: null };
    if (item.size > TWO_MEGABYTES) return { state: 'unreadable', value: null };
    buffer = readFileSync(path);
    if (buffer.length > TWO_MEGABYTES) return { state: 'unreadable', value: null };
  } catch {
    return { state: 'unreadable', value: null };
  }
  const start = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf ? 3 : 0;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(start));
  } catch {
    return { state: 'malformed', value: null };
  }
  const parsed = parseStrictJsonText(text, MAX_DEPTH);
  if (!parsed.ok) return { state: 'malformed', value: null };
  if (!isDict(parsed.value)) return { state: 'malformed', value: null };
  return { state: 'present', value: parsed.value };
}

export interface T3RuleResult {
  ok: boolean;
  value?: unknown;
  unknownKeys?: string[];
  bad?: boolean;
}

/** The snapshot value of one top-level key under its allowlist rule. */
export function getT3RuleValue(key: string, value: unknown, _workspace: string): T3RuleResult {
  const { allowed } = getPolicy();
  const rule = allowed[key];
  if (!rule || ordinalEqual(rule.kind, 'exclude')) return { ok: false };
  if (ordinalEqual(rule.kind, 'bool') && typeof value === 'boolean') return { ok: true, value };
  if (
    ordinalEqual(rule.kind, 'enum') &&
    ((value === null && rule.nullable === true) || (typeof value === 'string' && ordinalIn(value, rule.values)))
  ) {
    return { ok: true, value };
  }
  if (ordinalEqual(rule.kind, 'object') && isDict(value) && isDict(rule.keys)) {
    const out: Dict = {};
    const unknown: string[] = [];
    let bad = false;
    for (const name of ordinalSorted(Object.keys(value))) {
      let child: Dict | null = null;
      for (const allowedName of Object.keys(rule.keys)) {
        if (allowedName === name) {
          child = rule.keys[allowedName] as Dict;
          break;
        }
      }
      if (child === null) {
        unknown.push(getT3SafeKey(name));
        continue;
      }
      const childValue = value[name];
      if (ordinalEqual(child.rule, 'bool') && typeof childValue === 'boolean') {
        out[name] = childValue;
      } else if (
        ordinalEqual(child.rule, 'nullable-int') &&
        (childValue === null ||
          (typeof childValue === 'number' &&
            Number.isInteger(childValue) &&
            childValue >= Number(child.minimum) &&
            childValue <= Number(child.maximum)))
      ) {
        out[name] = childValue;
      } else {
        bad = true;
      }
    }
    return { ok: !bad, value: out, unknownKeys: unknown, bad };
  }
  return { ok: false };
}

function pathSeparator(): string {
  return process.platform === 'win32' ? '\\' : '/';
}

function trimEndingSeparator(path: string): string {
  return path.replace(/[\\/]+$/, '');
}

/** A command is a bare allowlisted command or a wrapper under the workspace's .maxstack/bin. */
export function convertT3Command(value: unknown, workspace: string): { ok: boolean; value: string } {
  const { allowlist } = getPolicy();
  if (typeof value !== 'string' || value.trim().length === 0) return { ok: false, value: '{path}' };
  if (!/[\\/]/.test(value) && !/^[A-Za-z]:/.test(value)) {
    if (ordinalIn(value, allowlist.commands as unknown[])) return { ok: true, value };
    return { ok: false, value: '{path}' };
  }
  const root = trimEndingSeparator(resolve(workspace)).replaceAll('\\', '/');
  const candidate = value.replace(/^\\\\\?\\/, '').replaceAll('\\', '/');
  if (/(^|\/)\.\.(\/|$)/.test(candidate)) return { ok: false, value: '{path}' };
  if (
    candidate.toLowerCase() === root.toLowerCase() ||
    candidate.toLowerCase().startsWith(`${root.toLowerCase()}/`)
  ) {
    const tail = candidate.slice(root.length).replace(/^\/+/, '');
    const allowed = [
      '.maxstack/bin/copilot.cmd',
      '.maxstack/bin/copilot.sh',
      '.maxstack/bin/pi.cmd',
      '.maxstack/bin/pi.sh',
    ];
    if (tail) {
      const canonical = allowed.find((entry) => entry.toLowerCase() === tail.toLowerCase());
      if (canonical && testT3PhysicalWorkspacePath(resolve(value), workspace)) {
        return { ok: true, value: `{workspace}/${canonical}` };
      }
    }
  }
  return { ok: false, value: '{path}' };
}

/** A plugin directory is an absolute path under the workspace inside an allowlisted path root. */
export function convertT3PluginDirectory(
  pathValue: unknown,
  workspace: string,
  layerNames: readonly string[],
): { ok: boolean; value: string } {
  const { allowlist } = getPolicy();
  const text = typeof pathValue === 'string' ? pathValue : String(pathValue ?? '');
  if (/(^|\/)\.\.(\/|$)/.test(text)) return { ok: false, value: '{path}' };
  const root = trimEndingSeparator(resolve(workspace));
  const candidate = text.replace(/^\\\\\?\\/, '');
  if (!isAbsolute(candidate)) return { ok: false, value: '{path}' };
  let full: string;
  try {
    full = resolve(candidate);
  } catch {
    return { ok: false, value: '{path}' };
  }
  if (full.toLowerCase() !== root.toLowerCase() && !full.toLowerCase().startsWith(`${root.toLowerCase()}${pathSeparator()}`)) {
    return { ok: false, value: '{path}' };
  }
  const relativePath = full
    .slice(root.length)
    .replace(/^[\\/]+/, '')
    .replaceAll('\\', '/');
  let known = false;
  const launchArgs = allowlist.launchArgs as Dict;
  for (const rootRule of launchArgs.pathRoots as string[]) {
    if (rootRule.includes('<known-layer>')) {
      for (const layer of layerNames) {
        if (relativePath.toLowerCase() === rootRule.replace('<known-layer>', layer).toLowerCase()) known = true;
      }
    } else if (relativePath.toLowerCase() === rootRule.toLowerCase()) {
      known = true;
    }
  }
  if (!known) return { ok: false, value: '{path}' };
  if (!testT3PhysicalWorkspacePath(full, root)) return { ok: false, value: '{path}' };
  return { ok: true, value: `{workspace}/${relativePath}` };
}

/** Whether every link on the path stays inside the physical workspace. */
export function testT3PhysicalWorkspacePath(path: string, workspace: string): boolean {
  try {
    const root = trimEndingSeparator(resolve(workspace));
    let physicalRoot = root;
    if (lstatSync(root).isSymbolicLink()) physicalRoot = trimEndingSeparator(realpathOf(root));
    const full = resolve(path);
    if (full.length < root.length) return false;
    const relative = full.slice(root.length).replace(/^[\\/]+/, '');
    let cursor = root;
    for (const segment of relative.split(/[\\/]+/).filter(Boolean)) {
      cursor = join(cursor, segment);
      let item;
      try {
        item = lstatSync(cursor);
      } catch {
        continue;
      }
      if (item.isSymbolicLink()) {
        const resolved = trimEndingSeparator(realpathOf(cursor));
        if (
          resolved.toLowerCase() !== physicalRoot.toLowerCase() &&
          !resolved.toLowerCase().startsWith(`${physicalRoot.toLowerCase()}${pathSeparator()}`)
        ) {
          return false;
        }
      }
    }
    return true;
  } catch {
    return false;
  }
}

function realpathOf(path: string): string {
  return realpathSync(path);
}

/** The --plugin-dir argument form, with the directory normalized. */
export function convertT3PluginArgs(
  value: unknown,
  workspace: string,
  layerNames: readonly string[],
): { ok: boolean; value: string } {
  const { allowlist } = getPolicy();
  if (typeof value !== 'string') return { ok: false, value: '{args: 1 tokens}' };
  const match = /^\s*--plugin-dir\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/.exec(value);
  const launchArgs = allowlist.launchArgs as Dict;
  if (!match || !ordinalIn('--plugin-dir', launchArgs.allowedFlags as unknown[])) {
    const tokens = value.split(/\s+/).filter(Boolean).length;
    return { ok: false, value: `{args: ${tokens} tokens}` };
  }
  const path = match[1] ?? match[2] ?? match[3] ?? '';
  const normalized = convertT3PluginDirectory(path, workspace, layerNames);
  if (!normalized.ok) return { ok: false, value: '{args: 2 tokens}' };
  return { ok: true, value: `--plugin-dir ${normalized.value}` };
}

/** The instance-name suffix a workspace contributes. */
export function getT3WorkspaceSlug(workspace: string): string {
  const name = basename(trimEndingSeparator(workspace));
  const parts = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  let slug = parts.map((part) => part.slice(0, 1).toUpperCase() + part.slice(1)).join('');
  if (!slug) slug = 'Workspace';
  if (!/^[A-Za-z]/.test(slug)) slug = `Workspace${slug}`;
  if (slug.length > 64) slug = slug.slice(0, 64);
  return slug;
}

function replaceAll(text: string, search: string, replacement: string): string {
  return text.split(search).join(replacement);
}

/** Expands a defaults template value: the workspace placeholders, and the $os selector. */
export function expandT3DefaultValue(value: unknown, workspace: string, workspaceSlug: string): unknown {
  if (isDict(value)) {
    if (hasOwn(value, '$os')) {
      const osName =
        process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
      const byOs = value.$os;
      if (!isDict(byOs) || !hasOwn(byOs, osName)) return null;
      return expandT3DefaultValue(byOs[osName], workspace, workspaceSlug);
    }
    const result: Dict = {};
    for (const key of Object.keys(value)) result[key] = expandT3DefaultValue(value[key], workspace, workspaceSlug);
    return result;
  }
  if (Array.isArray(value)) return value.map((item) => expandT3DefaultValue(item, workspace, workspaceSlug));
  if (typeof value === 'string') {
    const native = trimEndingSeparator(resolve(workspace));
    const posix = native.replaceAll('\\', '/');
    return replaceAll(
      replaceAll(replaceAll(value, '{Workspace}', workspaceSlug), '{workspacePosix}', posix),
      '{workspace}',
      native,
    );
  }
  return value;
}

export interface T3Defaults {
  instances: Record<string, Dict>;
  app: Dict;
}

/** The defaults for this workspace, with instance ids and paths expanded. */
export function getT3Defaults(workspace: string): T3Defaults {
  const { defaultsTemplate } = getPolicy();
  const suffix = getT3WorkspaceSlug(workspace);
  const instances: Record<string, Dict> = {};
  const templateInstances = defaultsTemplate.instances as Dict;
  for (const templateId of Object.keys(templateInstances)) {
    const id = replaceAll(templateId, '{Workspace}', suffix);
    instances[id] = expandT3DefaultValue(templateInstances[templateId], workspace, suffix) as Dict;
  }
  return {
    instances,
    app: expandT3DefaultValue(defaultsTemplate.app, workspace, suffix) as Dict,
  };
}

/** A value with every object key sorted ordinally, arrays in order. */
export function convertToT3CanonicalValue(value: unknown): unknown {
  if (isDict(value)) {
    const sorted: Dict = {};
    for (const key of ordinalSorted(Object.keys(value))) sorted[key] = convertToT3CanonicalValue(value[key]);
    return sorted;
  }
  if (Array.isArray(value)) return value.map((item) => convertToT3CanonicalValue(item));
  return value;
}

/** Whether two values have the same canonical JSON text. */
export function testT3ValueEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(convertToT3CanonicalValue(left)) === JSON.stringify(convertToT3CanonicalValue(right));
}

function convertT3ExpectedInstanceForReport(
  expected: Dict,
  workspace: string,
  layerNames: readonly string[],
): Dict {
  const envelope = expected.envelope as Dict;
  const safe: Dict = { driver: envelope.driver, enabled: envelope.enabled };
  const config: Dict = {};
  const expectedConfig = expected.config as Dict;
  for (const field of Object.keys(expectedConfig)) {
    let value = expectedConfig[field];
    if (ordinalIn(field, ['binaryPath', 'commandPath'])) {
      value = convertT3Command(value, workspace).value;
    } else if (
      ordinalEqual(field, 'launchArgs') &&
      typeof value === 'string' &&
      value.startsWith('--plugin-dir ')
    ) {
      const normalized = convertT3PluginDirectory(value.slice('--plugin-dir '.length), workspace, layerNames);
      value = normalized.ok ? `--plugin-dir ${normalized.value}` : '{args: 2 tokens}';
    } else if (ordinalEqual(field, 'commandArgs') && Array.isArray(value) && value.length === 2) {
      value = [
        value[0],
        convertT3PluginDirectory(value[1], workspace, layerNames).value,
      ];
    }
    config[field] = value;
  }
  safe.config = config;
  return safe;
}

export interface T3Counts {
  recorded: number;
  excluded: number;
  unknown: number;
  unverifiable: number;
  environment: number;
}

export interface T3DriftEntry {
  id: string;
  state: string;
  wanted?: unknown;
  observed?: unknown;
}

export interface T3Report {
  sourceState: T3Input['state'];
  topLevelCount: number;
  snapshot: Dict;
  canonical: string;
  stale: boolean;
  counts: T3Counts;
  unknownKeys: string[];
  unverifiableKeys: string[];
  strictFailures: string[];
  drift: T3DriftEntry[];
  snapshotSha256: string;
}

export interface T3ReportOptions {
  path: string;
  workspace: string;
  runtimeNames?: string[];
  layerNames?: string[];
}

/** Classifies the selected T3 settings file and reports what a snapshot would record and what drifts. */
export function getT3SettingsReport(options: T3ReportOptions): T3Report {
  const { allowlist, drivers, enabledDefaults, configDefaults, allowed, excluded } = getPolicy();
  const workspace = options.workspace;
  const runtimeNames = options.runtimeNames ?? ['claude', 'copilot', 'pi'];
  const layerNames = options.layerNames ?? [];
  const input = readT3Input(options.path);
  const counts: T3Counts = { recorded: 0, excluded: 0, unknown: 0, unverifiable: 0, environment: 0 };
  const snapshot: Dict = {};
  const unknownNames: string[] = [];
  const unverifiableNames: string[] = [];
  const strict: string[] = [];
  const providerInstancesApproved =
    testT3ExactKey(allowed, 'providerInstances') && ordinalEqual(allowed.providerInstances?.kind, 'instances');
  const instanceDrift: Record<string, { wanted: unknown; observed: unknown }> = {};
  const instanceStates: Record<string, string> = {};

  if (ordinalEqual(input.state, 'present') && input.value) {
    const value = input.value;
    for (const key of ordinalSorted(Object.keys(value))) {
      if (testT3ExactKey(excluded, key)) {
        counts.excluded++;
        continue;
      }
      if (!testT3ExactKey(allowed, key)) {
        counts.unknown++;
        unknownNames.push(getT3SafeKey(key));
        strict.push('unknown');
        continue;
      }
      if (ordinalEqual(key, 'providerInstances')) continue;
      const checked = getT3RuleValue(key, getT3ExactValue(value, key), workspace);
      if (checked.unknownKeys) {
        for (const nested of checked.unknownKeys) {
          counts.unknown++;
          unknownNames.push(`${key}.${nested}`);
          strict.push('unknown');
        }
      }
      if (checked.ok) {
        snapshot[key] = checked.value;
        counts.recorded++;
      } else {
        counts.unverifiable++;
        unverifiableNames.push(getT3SafeKey(key));
        strict.push('unverifiable');
      }
    }

    if (
      providerInstancesApproved &&
      testT3ExactKey(value, 'providerInstances') &&
      isDict(getT3ExactValue(value, 'providerInstances'))
    ) {
      const instances: Dict = {};
      const defaults = getT3Defaults(workspace);
      const providerInstances = getT3ExactValue(value, 'providerInstances') as Dict;
      const knownIdTemplates = new Map<string, string>();
      const templateInstances = getPolicy().defaultsTemplate.instances as Dict;
      for (const template of Object.keys(templateInstances)) {
        knownIdTemplates.set(replaceAll(template, '{Workspace}', getT3WorkspaceSlug(workspace)), template);
      }
      let extraIndex = 0;
      for (const id of ordinalSorted(Object.keys(providerInstances))) {
        const instance = providerInstances[id];
        const knownId = knownIdTemplates.has(id);
        const label = knownId ? (knownIdTemplates.get(id) as string) : `mapextra${++extraIndex}`;
        if (!isDict(instance)) {
          counts.unverifiable++;
          strict.push('unverifiable');
          instanceStates[knownId ? id : label] = 'unverifiable';
          continue;
        }
        const unknownBeforeInstance = counts.unknown;
        const strictBeforeInstance = strict.length;
        const driver = getT3ExactValue(instance, 'driver');
        const driverKnown = typeof driver === 'string' && ordinalIn(driver, drivers);
        const providerEnvelope = allowlist.providerEnvelope as Dict;
        const envelopeAllowed = providerEnvelope.allowed as unknown[];
        const driverApproved = testT3ExactKey(envelopeAllowed, 'driver');
        const enabledApproved = testT3ExactKey(envelopeAllowed, 'enabled');
        const configApproved = testT3ExactKey(envelopeAllowed, 'config');
        const safe: Dict = {};
        for (const field of Object.keys(instance)) {
          if (testT3ExactKey(envelopeAllowed, field)) continue;
          if (testT3ExactKey(providerEnvelope.excluded, field)) {
            counts.excluded++;
          } else {
            counts.unknown++;
            unknownNames.push(`providerInstances.${label}.${getT3SafeKey(field)}`);
            strict.push('unknown');
          }
        }
        if (driverKnown && driverApproved) safe.driver = driver;
        else if (!driverKnown && driverApproved) {
          counts.unverifiable++;
          strict.push('unverifiable');
        }
        let envelopeEnabled: boolean | null = null;
        if (enabledApproved && testT3ExactKey(instance, 'enabled')) {
          const enabledValue = getT3ExactValue(instance, 'enabled');
          if (typeof enabledValue === 'boolean') envelopeEnabled = enabledValue;
          else {
            counts.unverifiable++;
            strict.push('unverifiable');
          }
        }
        let envCount = 0;
        if (testT3ExactKey(instance, 'environment')) {
          const environmentValue = getT3ExactValue(instance, 'environment');
          if (Array.isArray(environmentValue)) envCount = environmentValue.length;
          else if (isDict(environmentValue)) envCount = Object.keys(environmentValue).length;
          else {
            counts.unverifiable++;
            strict.push('unverifiable');
          }
        }
        counts.environment += envCount;

        const config: Dict = {};
        const instanceConfig = getT3ExactValue(instance, 'config');
        if (configApproved && driverKnown && ordinalEqual(driver, 'acpRegistry')) {
          if (isDict(instanceConfig)) {
            const acp = (allowlist.drivers as Dict).acpRegistry as Dict;
            const acpAllowed = acp.allowed as unknown[];
            const acpValues = acp.values as Dict;
            for (const field of ['source', 'distribution']) {
              if (!testT3ExactKey(acpAllowed, field)) continue;
              const accepted = acpValues[field] as unknown[];
              if (!testT3ExactKey(instanceConfig, field)) continue;
              const fieldValue = getT3ExactValue(instanceConfig, field);
              if (typeof fieldValue === 'string' && ordinalIn(fieldValue, accepted)) config[field] = fieldValue;
              else {
                counts.unverifiable++;
                strict.push('unverifiable');
              }
            }
            if (testT3ExactKey(acpAllowed, 'agentId') && testT3ExactKey(instanceConfig, 'agentId')) {
              const agentId = getT3ExactValue(instanceConfig, 'agentId');
              if (typeof agentId === 'string' && ordinalIn(agentId, acpValues.agentId as unknown[])) {
                config.agentId = agentId;
              } else {
                counts.unverifiable++;
                strict.push('unverifiable');
              }
            }
            if (testT3ExactKey(acpAllowed, 'commandPath') && testT3ExactKey(instanceConfig, 'commandPath')) {
              const normalized = convertT3Command(getT3ExactValue(instanceConfig, 'commandPath'), workspace);
              config.commandPath = normalized.value;
              if (!normalized.ok) {
                counts.unverifiable++;
                strict.push('unverifiable');
              }
            }
            if (testT3ExactKey(acpAllowed, 'commandArgs') && testT3ExactKey(instanceConfig, 'commandArgs')) {
              const argsValue = getT3ExactValue(instanceConfig, 'commandArgs');
              if (Array.isArray(argsValue) && argsValue.length === 0) {
                config.commandArgs = [];
              } else if (
                Array.isArray(argsValue) &&
                argsValue.length === 2 &&
                ordinalEqual(argsValue[0], '--plugin-dir')
              ) {
                const normalized = convertT3PluginDirectory(argsValue[1], workspace, layerNames);
                if (typeof argsValue[1] === 'string' && normalized.ok) {
                  config.commandArgs = ['--plugin-dir', normalized.value];
                } else {
                  config.commandArgs = `{args: ${argsValue.length} tokens}`;
                  counts.unverifiable++;
                  strict.push('unverifiable');
                }
              } else {
                config.commandArgs = `{args: ${Array.isArray(argsValue) ? argsValue.length : 1} tokens}`;
                counts.unverifiable++;
                strict.push('unverifiable');
              }
            }
            const configKnown = [...acpAllowed, ...((acp.excluded as unknown[]) ?? [])];
            for (const field of Object.keys(instanceConfig)) {
              if (!ordinalIn(field, configKnown)) {
                counts.unknown++;
                unknownNames.push(`providerInstances.${label}.config.${getT3SafeKey(field)}`);
                strict.push('unknown');
              } else if (ordinalIn(field, acp.excluded as unknown[])) {
                counts.excluded++;
              }
            }
          } else {
            counts.unverifiable++;
            strict.push('unverifiable');
          }
        } else if (configApproved && driverKnown && testT3ExactKey(allowlist.drivers, String(driver))) {
          const driverPolicy = (allowlist.drivers as Dict)[String(driver)] as Dict;
          let instanceConfigObject: Dict;
          if (!isDict(instanceConfig)) {
            counts.unverifiable++;
            strict.push('unverifiable');
            instanceConfigObject = {};
          } else {
            instanceConfigObject = instanceConfig;
          }
          const driverAllowed = driverPolicy.allowed as unknown[];
          const driverExcluded = (driverPolicy.excluded as unknown[]) ?? [];
          for (const field of driverAllowed) {
            const fieldName = String(field);
            const value = getT3ExactValue(instanceConfigObject, fieldName);
            if (ordinalEqual(fieldName, 'enabled')) continue;
            if (!testT3ExactKey(instanceConfigObject, fieldName)) continue;
            if (ordinalEqual(fieldName, 'binaryPath')) {
              const normalized = convertT3Command(value, workspace);
              config[fieldName] = normalized.value;
              if (!normalized.ok) {
                counts.unverifiable++;
                strict.push('unverifiable');
              }
            } else if (ordinalEqual(fieldName, 'launchArgs') && typeof value === 'string') {
              if (ordinalEqual(value, '')) config[fieldName] = '';
              else {
                const normalized = convertT3PluginArgs(value, workspace, layerNames);
                config[fieldName] = normalized.value;
                if (!normalized.ok) {
                  counts.unverifiable++;
                  strict.push('unverifiable');
                }
              }
            } else if (ordinalEqual(fieldName, 'launchArgs')) {
              counts.unverifiable++;
              strict.push('unverifiable');
            }
          }
          const configKnown = [...driverAllowed, ...driverExcluded];
          for (const field of Object.keys(instanceConfigObject)) {
            if (!ordinalIn(field, configKnown)) {
              counts.unknown++;
              unknownNames.push(`providerInstances.${label}.config.${getT3SafeKey(field)}`);
              strict.push('unknown');
            } else if (ordinalIn(field, driverExcluded)) {
              counts.excluded++;
            }
          }
        } else if (configApproved) {
          counts.unverifiable++;
          strict.push('unverifiable');
        }

        let resolvedEnabled: unknown = null;
        if (driverKnown) {
          let legacyEnabled: boolean | null = null;
          const legacyConfig = configApproved ? instanceConfig : {};
          const nestedEnabledApproved = ordinalEqual(driver, 'acpRegistry')
            ? testT3ExactKey(((allowlist.drivers as Dict).acpRegistry as Dict).allowed, 'enabled')
            : testT3ExactKey(((allowlist.drivers as Dict)[String(driver)] as Dict).allowed, 'enabled');
          if (configApproved && nestedEnabledApproved && testT3ExactKey(legacyConfig, 'enabled')) {
            const legacyValue = getT3ExactValue(legacyConfig, 'enabled');
            if (typeof legacyValue === 'boolean') legacyEnabled = legacyValue;
            else {
              counts.unverifiable++;
              strict.push('unverifiable');
            }
          }
          const driverDefault = enabledDefaults[String(driver)];
          resolvedEnabled =
            envelopeEnabled === false || legacyEnabled === false
              ? false
              : envelopeEnabled !== null
                ? envelopeEnabled
                : legacyEnabled !== null
                  ? legacyEnabled
                  : driverDefault;
          if (enabledApproved) safe.enabled = resolvedEnabled;
        } else if (envelopeEnabled !== null && enabledApproved) {
          safe.enabled = envelopeEnabled;
        }
        if (Object.keys(config).length > 0) safe.config = config;
        instances[label] = safe;

        if (knownId) {
          const expected = defaults.instances[id] as Dict;
          const safeExpected = convertT3ExpectedInstanceForReport(expected, workspace, layerNames);
          let state =
            counts.unknown > unknownBeforeInstance
              ? 'unknown'
              : strict.length > strictBeforeInstance
                ? 'unverifiable'
                : 'matching';
          const expectedEnvelope = expected.envelope as Dict;
          if (
            ordinalEqual(state, 'matching') &&
            (!ordinalEqual(driver, expectedEnvelope.driver) || resolvedEnabled !== expectedEnvelope.enabled)
          ) {
            state = 'differs';
          }
          const wantedConfig = expected.config as Dict;
          for (const field of Object.keys(wantedConfig)) {
            let wantedValue = wantedConfig[field];
            if (ordinalIn(field, ['binaryPath', 'commandPath']) && typeof wantedValue === 'string') {
              wantedValue = convertT3Command(wantedValue, workspace).value;
            }
            if (
              ordinalEqual(field, 'launchArgs') &&
              typeof wantedValue === 'string' &&
              wantedValue.startsWith('--plugin-dir ')
            ) {
              wantedValue = `--plugin-dir ${convertT3PluginDirectory(
                wantedValue.slice('--plugin-dir '.length),
                workspace,
                layerNames,
              ).value}`;
            }
            let actualValue: unknown;
            if (hasOwn(config, field)) actualValue = config[field];
            else if (
              isDict(configDefaults[String(driver)]) &&
              hasOwn(configDefaults[String(driver)] as Dict, field)
            ) {
              actualValue = (configDefaults[String(driver)] as Dict)[field];
            } else {
              actualValue = '{unset}';
            }
            if (ordinalEqual(state, 'matching') && JSON.stringify(actualValue) !== JSON.stringify(wantedValue)) {
              state = 'differs';
            }
          }
          instanceStates[id] = state;
          if (ordinalEqual(state, 'differs')) instanceDrift[id] = { wanted: safeExpected, observed: safe };
        } else {
          instanceStates[label] = driverKnown ? 'extra' : 'unverifiable';
        }
      }
      snapshot.providerInstances = instances;
    } else if (providerInstancesApproved && testT3ExactKey(value, 'providerInstances')) {
      counts.unverifiable++;
      strict.push('unverifiable');
      for (const template of Object.keys(getPolicy().defaultsTemplate.instances as Dict)) {
        instanceStates[replaceAll(template, '{Workspace}', getT3WorkspaceSlug(workspace))] = 'unverifiable';
      }
    }
  }

  const defaults = getT3Defaults(workspace);
  const drift: T3DriftEntry[] = [];
  for (const id of Object.keys(defaults.instances)) {
    if (!(ordinalEqual(input.state, 'present') && providerInstancesApproved)) continue;
    const wanted = defaults.instances[id] as Dict;
    if (!ordinalIn(wanted.runtime, runtimeNames)) continue;
    const providerMap = input.value ? getT3ExactValue(input.value, 'providerInstances') : null;
    let state: string;
    if (!ordinalEqual(input.state, 'present') || !testT3ExactKey(input.value, 'providerInstances')) {
      state = 'missing';
      strict.push('missing');
    } else if (!isDict(providerMap)) {
      state = instanceStates[id] as string;
    } else if (!testT3ExactKey(providerMap, id)) {
      state = 'missing';
      strict.push('missing');
    } else {
      state = instanceStates[id] as string;
    }
    if (ordinalIn(state, ['differs', 'unverifiable', 'unknown'])) strict.push(state);
    const safeId = Object.keys(getPolicy().defaultsTemplate.instances as Dict).find(
      (template) => replaceAll(template, '{Workspace}', getT3WorkspaceSlug(workspace)) === id,
    );
    const entry: T3DriftEntry = { id: safeId as string, state };
    if (ordinalEqual(state, 'differs') && instanceDrift[id]) {
      entry.wanted = instanceDrift[id].wanted;
      entry.observed = instanceDrift[id].observed;
    }
    drift.push(entry);
  }

  if (
    providerInstancesApproved &&
    ordinalEqual(input.state, 'present') &&
    input.value &&
    testT3ExactKey(input.value, 'providerInstances') &&
    isDict(getT3ExactValue(input.value, 'providerInstances'))
  ) {
    for (const instanceId of Object.keys(instanceStates)) {
      if (ordinalIn(instanceStates[instanceId], ['extra', 'unverifiable'])) {
        drift.push({ id: instanceId, state: instanceStates[instanceId] as string });
      }
    }
  }

  for (const key of Object.keys(defaults.app)) {
    if (!ordinalEqual(input.state, 'present')) continue;
    let appDrift: { wanted: unknown; observed: unknown } | null = null;
    let state: string;
    if (hasOwn(snapshot, key)) {
      if (testT3ValueEqual(snapshot[key], defaults.app[key])) {
        state = 'matching';
      } else {
        state = 'differs';
        strict.push('differs');
        appDrift = { wanted: defaults.app[key], observed: snapshot[key] };
      }
    } else if (ordinalEqual(input.state, 'present') && testT3ExactKey(input.value, key)) {
      state = 'unverifiable';
      strict.push('unverifiable');
    } else {
      const rule = allowed[key] as T3Rule;
      if (!Object.hasOwn(rule, 'default')) {
        state = 'unset (T3 default unknown)';
      } else if (JSON.stringify(rule.default) === JSON.stringify(defaults.app[key])) {
        state = 'unset';
      } else {
        state = 'differs';
        strict.push('differs');
        appDrift = { wanted: defaults.app[key], observed: rule.default };
      }
    }
    const entry: T3DriftEntry = { id: key, state };
    if (appDrift) {
      entry.wanted = appDrift.wanted;
      entry.observed = appDrift.observed;
    }
    drift.push(entry);
  }

  const canonical = ordinalEqual(input.state, 'present') ? JSON.stringify(snapshot) : '{}';
  if (ordinalIn(input.state, ['malformed', 'unreadable'])) strict.push('malformedSource');

  const snapshotPath = join(workspace, '.maxstack/t3/settings.snapshot.json');
  let stale = true;
  if (testT3SnapshotPathSafe(workspace, true)) {
    try {
      if (existsSync(snapshotPath)) {
        const buffer = readFileSync(snapshotPath);
        if (buffer.length <= TWO_MEGABYTES) {
          const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
          stale = text !== `${canonical}\n`;
        }
      }
    } catch {
      stale = true;
    }
  }

  return {
    sourceState: input.state,
    topLevelCount: ordinalEqual(input.state, 'present') && input.value ? Object.keys(input.value).length : 0,
    snapshot,
    canonical,
    stale,
    counts,
    unknownKeys: unknownNames,
    unverifiableKeys: unverifiableNames,
    strictFailures: ordinalUnique(strict),
    drift,
    snapshotSha256: createHash('sha256')
      .update(Buffer.from(`${canonical}\n`, 'utf8'))
      .digest('hex')
      .toLowerCase(),
  };
}

/** Whether the snapshot and its parents are real folders and files, with no linked ancestor. */
export function testT3SnapshotPathSafe(workspace: string, allowMissing = false): boolean {
  const target = join(workspace, '.maxstack/t3/settings.snapshot.json');
  let cursor = workspace;
  for (const part of ['.maxstack', 't3']) {
    cursor = join(cursor, part);
    let item;
    try {
      item = lstatSync(cursor);
    } catch {
      item = null;
    }
    if (item) {
      if (item.isSymbolicLink()) return false;
      if (!item.isDirectory()) return false;
    } else if (!allowMissing && existsSync(dirname(cursor))) {
      // A missing path component is normal during the first snapshot write.
    }
  }
  let targetItem;
  try {
    targetItem = lstatSync(target);
  } catch {
    targetItem = null;
  }
  if (targetItem && (targetItem.isSymbolicLink() || targetItem.isDirectory())) return false;
  if (!allowMissing) {
    try {
      lstatSync(`${target}.maxstack-tmp`);
      return false;
    } catch {
      // absent
    }
  }
  return true;
}

/** The snapshot destination, refused when a link or a planted temporary path makes it unsafe. */
export function assertT3SnapshotDestination(workspace: string): string {
  const target = join(workspace, '.maxstack/t3/settings.snapshot.json');
  if (!testT3SnapshotPathSafe(workspace)) {
    throw new Error(
      'T3 snapshot destination has a linked ancestor, unsafe leaf, or pre-existing temporary path.',
    );
  }
  return target;
}

/** Writes the canonical snapshot atomically and returns the uppercase SHA-256 of the file. */
export function writeT3Snapshot(workspace: string, report: T3Report): string {
  const target = assertT3SnapshotDestination(workspace);
  let folder = workspace;
  for (const part of ['.maxstack', 't3']) {
    folder = join(folder, part);
    if (!existsSync(folder)) mkdirSync(folder);
  }
  const text = `${report.canonical}\n`;
  const temp = `${target}.maxstack-${randomUUID().replaceAll('-', '')}.tmp`;
  let createdTemp = false;
  try {
    const fd = openSync(temp, 'wx');
    createdTemp = true;
    try {
      writeFileSync(fd, text, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (!testT3SnapshotPathSafe(workspace, true)) {
      throw new Error('T3 snapshot destination changed during the write.');
    }
    renameSync(temp, target);
  } finally {
    if (createdTemp && existsSync(temp)) unlinkSync(temp);
  }
  return sha256File(target);
}

/** Prints the T3 report: counts, unknown and unverifiable names, drift, and snapshot freshness. */
export function writeT3SettingsReport(report: T3Report, _workspace: string, snapshotEnabled: boolean): void {
  if (!snapshotEnabled) {
    writeHost('T3 settings: snapshot disabled by workspace settings.');
    return;
  }
  if (ordinalEqual(report.sourceState, 'missing')) {
    writeHost('T3 settings: no settings file was found at the explicitly selected source.');
    return;
  }
  if (!ordinalEqual(report.sourceState, 'present')) {
    writeHost(`T3 settings: source is ${report.sourceState}; existing snapshot was preserved.`);
    return;
  }
  writeHost(
    `T3 settings: ${report.topLevelCount} top-level keys: ${report.counts.recorded} recorded, ${report.counts.excluded} excluded, ${report.counts.unknown} unknown, ${report.counts.unverifiable} unverifiable`,
  );
  for (const name of report.unknownKeys) writeHost(`  unknown: ${name} (not in t3/allowlist.json)`);
  for (const name of report.unverifiableKeys) writeHost(`  unverifiable: ${name}`);
  for (const item of report.drift) {
    if (hasOwn(item as unknown as Dict, 'wanted')) {
      writeHost(
        `  ${item.id}  ${item.state} (wanted ${JSON.stringify(item.wanted)}; observed ${JSON.stringify(item.observed)})`,
      );
    } else {
      writeHost(`  ${item.id}  ${item.state}`);
    }
  }
  if (report.stale) writeHost('Snapshot: .maxstack/t3/settings.snapshot.json (stale: would change)');
  else writeHost('Snapshot: .maxstack/t3/settings.snapshot.json (current)');
}
