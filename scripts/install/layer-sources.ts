// Layer sources: the -Source and -LayerSource overrides, how each layer's source is chosen, and the source record the
// lock keeps. A layer installs from a git source (a url, a ref, and the commit the ref resolved to) or from a local
// working tree. layers.json gives each layer's default source.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { assertBoundaryText, findBoundaryIndex, ordinalEqual, ordinalIn, ordinalSame, ordinalSorted, safeName, sortUtf8 } from './ordinal.ts';
import {
  joinMaxstackPath,
  maxstackAbsolutePath,
  maxstackPathEqual,
  maxstackPathInside,
  pathPlatform,
  trimMaxstackPathEndingSeparator,
  type Platform,
} from './paths.ts';
import { assertMaxstackShortNames, isMaxstackCheckoutLocation, maxstackFinalDirectory } from './discovery.ts';
import { getField, isDirectory, pathExists, readText, sha256FileOrNull, writeHost, writeWarning } from './util.ts';
import { S } from './state.ts';

export interface LayerModel {
  name: string;
  kind: string;
  path: string | null;
  sourcePath: string;
  defaultGit: boolean;
  defaultUrl: string | null;
  defaultRef: string | null;
  defaultCommit: string | null;
  declared: Record<string, unknown>;
  runtimes: Record<string, unknown>;
  url: string | null;
  ref: string | null;
  commit: string | null;
  dirty: boolean | null;
  unreadable: string | null;
  localPath: string | null;
  repoRoot: string | null;
  root: string | null;
  sourceKind: string;
  override: boolean;
  recordUrl: string | null;
  settingsSourced: boolean;
  settingsFault: string | null;
  folderMissing: boolean;
}

export interface SourceChoice {
  kind: 'default' | 'git' | 'local' | 'unavailable';
  url?: string | null;
  ref?: string | null;
  commit?: string | null;
  path?: string | null;
  checkout?: string | null;
  override?: boolean;
  reason?: string | null;
  absolute?: boolean;
  /** The grammar fault the spec hit, when it did not parse. */
  code?: string | null;
}

export interface GitRun {
  unreadable: string | null;
  timedOut: boolean;
  code: number | null;
  text: string;
  stdout: string[];
  stderr: string[];
  incomplete: boolean;
  invalidUtf8: boolean;
}

const GIT_INHERITED = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_PREFIX', 'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS', 'GIT_EXTERNAL_DIFF', 'GIT_PAGER', 'GIT_ASKPASS', 'GIT_SSH',
  'GIT_SSH_COMMAND', 'GIT_PROXY_COMMAND', 'GIT_EXEC_PATH', 'GIT_TEMPLATE_DIR',
  'GIT_ALLOW_PROTOCOL', 'GIT_PROTOCOL_FROM_USER', 'SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE',
].map((name) => name.toUpperCase());

const DUBIOUS_OWNERSHIP_REASON =
  'git refused the folder: it is owned by another user; add it to safe.directory or fix its ownership';
const GIT_VERSION_REASON = 'git 2.31 or later is needed, so the filter guard cannot be passed';
const GIT_CONFIG_REASON = 'git could not read its configuration, so the filter guard cannot be passed';
const MAX_FILTER_NAME_LENGTH = 4096;
const GIT_ENVIRONMENT_BUDGET = 30000;

export function testNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

export function testTestSeam(): boolean {
  return ordinalEqual(process.env.MAXSTACK_TEST_MODE, '1');
}

export function testUnderTempFolder(path: string): boolean {
  const temp = normalPath(maxstackFinalOrSelf(tmpdir()));
  const full = normalPath(path);
  return !maxstackPathEqual(full, temp) && maxstackPathInside(full, temp);
}

/** A test seam: owner/repo names a bare repository under MAXSTACK_TEST_GITHUB_ROOT instead of github.com. */
export function githubRemoteUrl(owner: string, repo: string): string {
  const testRoot = process.env.MAXSTACK_TEST_GITHUB_ROOT;
  if (testRoot && testTestSeam() && testUnderTempFolder(testRoot)) {
    writeWarning(
      `MAXSTACK_TEST_GITHUB_ROOT is set, so ${owner}/${repo} reads the local folder ${testRoot}, not GitHub. This is the test seam.`,
    );
    return join(testRoot, `${owner}\\${repo}.git`).replaceAll('\\', '/');
  }
  return `https://github.com/${owner}/${repo}.git`;
}

function maxstackFinalOrSelf(path: string): string {
  try {
    return maxstackFinalDirectory(path);
  } catch {
    return path;
  }
}

/** The form of a path that comparisons use, with each link on the way followed. */
export function normalPath(path: string): string {
  try {
    const final = realpathSync(resolve(path));
    return trimMaxstackPathEndingSeparator(final);
  } catch {
    return trimMaxstackPathEndingSeparator(resolve(path));
  }
}

/** The full path of a folder, with a trailing separator dropped except on a root. */
export function fullFolderPath(path: string): string {
  const full = resolve(path);
  return full === '/' ? full : trimMaxstackPathEndingSeparator(full);
}

export interface GitSetting {
  key: string;
  value: string;
}

/** The settings every git command the installer runs under. */
export function gitGuardSettings(filterNames: readonly string[] = []): GitSetting[] {
  const settings: GitSetting[] = [
    { key: 'core.fsmonitor', value: '' },
    { key: 'core.hooksPath', value: 'NUL' },
    { key: 'core.askPass', value: '' },
    { key: 'protocol.allow', value: 'never' },
    { key: 'protocol.https.allow', value: 'always' },
  ];
  if (testTestSeam()) settings.push({ key: 'protocol.file.allow', value: 'always' });
  for (const name of filterNames) {
    for (const part of ['clean', 'smudge', 'process']) {
      settings.push({ key: `filter.${name}.${part}`, value: '' });
    }
    settings.push({ key: `filter.${name}.required`, value: 'false' });
  }
  return settings;
}

function gitChildVariables(settings: readonly GitSetting[]): Record<string, string> {
  const variables: Record<string, string> = {
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_CONFIG_COUNT: String(settings.length),
  };
  settings.forEach((setting, index) => {
    variables[`GIT_CONFIG_KEY_${index}`] = setting.key;
    variables[`GIT_CONFIG_VALUE_${index}`] = setting.value;
  });
  return variables;
}

function gitChildEnvironment(settings: readonly GitSetting[]): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(environment)) {
    const upper = key.toUpperCase();
    if (/^GIT_CONFIG_(COUNT|KEY_[0-9]+|VALUE_[0-9]+)$/.test(upper) || GIT_INHERITED.includes(upper)) {
      delete environment[key];
    }
  }
  Object.assign(environment, gitChildVariables(settings));
  return environment;
}

function newGitFault(reason: string, invalidUtf8 = false): GitRun {
  return {
    unreadable: reason,
    timedOut: false,
    code: null,
    text: '',
    stdout: [],
    stderr: [reason],
    incomplete: false,
    invalidUtf8,
  };
}

function decodeGitUtf8(bytes: Buffer): string | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.includes('\uFFFD')) return null;
    return text;
  } catch {
    return null;
  }
}

/** Runs git with the guard settings, a time limit, and strict UTF-8 decoding. */
export function gitProcess(
  args: readonly string[],
  settings: readonly GitSetting[],
  options: { timeoutSeconds?: number; workingDirectory?: string; ceilingDirectory?: string } = {},
): GitRun {
  const environment = gitChildEnvironment(settings);
  if (options.ceilingDirectory) environment.GIT_CEILING_DIRECTORIES = options.ceilingDirectory;
  const timeout = options.timeoutSeconds && options.timeoutSeconds > 0 ? options.timeoutSeconds * 1000 : undefined;
  const result = spawnSync('git', args, {
    cwd: options.workingDirectory || undefined,
    env: environment,
    timeout,
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === 'ETIMEDOUT') {
      return {
        unreadable: null,
        timedOut: true,
        code: null,
        text: '',
        stdout: [],
        stderr: [],
        incomplete: true,
        invalidUtf8: false,
      };
    }
    return newGitFault(`git could not start: ${result.error.message}`);
  }
  const outBytes = result.stdout ?? Buffer.alloc(0);
  const errBytes = result.stderr ?? Buffer.alloc(0);
  const text = decodeGitUtf8(outBytes);
  if (text === null) return newGitFault('git output is not valid UTF-8', true);
  const errText = errBytes.toString('utf8');
  return {
    unreadable: null,
    timedOut: false,
    code: result.status,
    text,
    stdout: text.split(/\r?\n/).filter(Boolean),
    stderr: errText.split(/\r?\n/).filter(Boolean),
    incomplete: false,
    invalidUtf8: false,
  };
}

let gitEnvConfigSupported: boolean | null = null;
let gitEnvConfigFault: string | null = null;

function gitEnvConfigSupport(): boolean {
  if (gitEnvConfigSupported === null) {
    const probe: GitSetting[] = [{ key: 'maxstack.guardprobe', value: 'on' }];
    const run = gitNeutral(['config', '--get', 'maxstack.guardprobe'], probe);
    gitEnvConfigSupported = run.code === 0 && ordinalIn('on', run.stdout);
    if (!gitEnvConfigSupported) gitEnvConfigFault = gitEnvConfigFaultFor(run);
  }
  return gitEnvConfigSupported;
}

function gitEnvConfigFaultFor(run: GitRun): string {
  const detail = run.stderr.find(Boolean) ?? '';
  if (detail && !detail.startsWith('git could not start')) return `${GIT_CONFIG_REASON}: ${detail}`;
  const version = gitVersion();
  if (version !== null && version >= 2.31) return 'git did not read the guard settings, so the filter guard cannot be passed';
  if (detail) return `${GIT_VERSION_REASON}: ${detail}`;
  return GIT_VERSION_REASON;
}

function gitVersion(): number | null {
  const run = gitNeutral(['version'], gitGuardSettings());
  if (run.code !== 0) return null;
  const line = gitLine(run);
  const match = /(\d+)\.(\d+)/.exec(line);
  return match ? Number(`${match[1]}.${match[2]}`) : null;
}

export function unreadableRemedy(reason: string): string {
  if (reason === DUBIOUS_OWNERSHIP_REASON) return '';
  if (reason.startsWith(GIT_VERSION_REASON)) return '. Install git 2.31 or later';
  if (reason.startsWith(GIT_CONFIG_REASON)) return '. Fix the config file that the reason names';
  return ". Fix the tree's git config";
}

function filterDriverName(key: string): string | null {
  const match = /^filter\.([\s\S]*)\.[^.]+$/.exec(key);
  return match ? (match[1] as string) : null;
}

function readTreeFilterNames(dir: string, allScopes = false): { names: string[]; fault: string | null } {
  const settings = gitGuardSettings();
  const repo = gitProcess(['-C', dir, 'rev-parse', '--git-dir'], settings);
  if (repo.unreadable !== null) return { names: [], fault: repo.unreadable };
  if (repo.incomplete) return { names: [], fault: 'git output was cut off, so the tree is unreadable' };
  if (repo.code !== 0) {
    const reason = repo.stderr[0] ?? '';
    const hasGitEntry = existsSync(joinMaxstackPath(dir, '.git'));
    if (!hasGitEntry || /not a git repository/.test(reason)) return { names: [], fault: null };
    if (/dubious ownership/.test(reason)) return { names: [], fault: DUBIOUS_OWNERSHIP_REASON };
    return { names: [], fault: `config cannot be read: ${reason}` };
  }
  let scopes = [''];
  if (!allScopes) {
    scopes = ['--local'];
    const worktreeConfig = gitProcess(
      ['-C', dir, 'config', '--local', '--bool', '--get', 'extensions.worktreeConfig'],
      settings,
      { timeoutSeconds: 15 },
    );
    if (worktreeConfig.unreadable !== null) return { names: [], fault: worktreeConfig.unreadable };
    if (worktreeConfig.incomplete) return { names: [], fault: 'git output was cut off, so worktree config is unknown' };
    if (worktreeConfig.code === 0 && worktreeConfig.text.trim().toLowerCase() === 'true') {
      scopes.push('--worktree');
    } else if (worktreeConfig.code !== 1 && worktreeConfig.code !== 0) {
      return { names: [], fault: 'git could not read the worktree config of this folder' };
    }
  }
  const keys: string[] = [];
  for (const scope of scopes) {
    const scopeArgs = scope ? [scope] : [];
    const run = gitProcess(
      ['-C', dir, 'config', ...scopeArgs, '--includes', '--name-only', '-z', '--get-regexp', '^filter\\.'],
      settings,
    );
    if (run.invalidUtf8) return { names: [], fault: 'a filter driver name is not valid UTF-8' };
    if (run.unreadable !== null) return { names: [], fault: run.unreadable };
    if (run.incomplete) return { names: [], fault: 'git output was cut off, so the filter names are unknown' };
    if (run.code === 1) continue;
    if (run.code !== 0) return { names: [], fault: 'git could not read the config of this folder' };
    keys.push(...run.text.split('\u0000').filter(Boolean));
  }
  const seen = new Set<string>();
  for (const key of keys) {
    const name = filterDriverName(key);
    if (name === null) continue;
    if (/[\x00-\x1f\x7f]/.test(name)) {
      return { names: [], fault: 'a filter driver name holds a control character, which the guard cannot pass to git' };
    }
    if (name.length > MAX_FILTER_NAME_LENGTH) {
      return {
        names: [],
        fault: `filter name too long: a name holds ${name.length} characters, and the guard passes at most ${MAX_FILTER_NAME_LENGTH}`,
      };
    }
    seen.add(name);
  }
  if (seen.size > 100) {
    return { names: [], fault: `too many filter drivers: ${seen.size} are named, and the guard passes at most 100` };
  }
  const environmentFault = gitEnvironmentFault([...seen]);
  if (environmentFault) return { names: [], fault: environmentFault };
  return { names: [...seen], fault: null };
}

function gitEnvironmentFault(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  let settingChars = 0;
  for (const [key, value] of Object.entries(gitChildVariables(gitGuardSettings(names)))) {
    settingChars += key.length + value.length + 2;
  }
  let ownChars = 0;
  for (const [key, value] of Object.entries(process.env)) {
    ownChars += key.length + (value ?? '').length + 2;
  }
  const total = settingChars + ownChars;
  if (total <= GIT_ENVIRONMENT_BUDGET) return null;
  return `filter name too long: the names together need ${total} characters of environment, and the guard passes at most ${GIT_ENVIRONMENT_BUDGET}`;
}

/** Runs a git command that names no tree, in a fresh empty folder outside any repository. */
export function gitNeutral(
  args: readonly string[],
  settings: readonly GitSetting[],
  timeoutSeconds = 0,
): GitRun {
  const folder = mkdtempSync(join(tmpdir(), 'maxstack-git-'));
  try {
    return gitProcess(args, settings, {
      timeoutSeconds,
      workingDirectory: folder,
      ceilingDirectory: dirname(folder).replaceAll('\\', '/'),
    });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/** Runs one git command under the guard. */
export function gitGuarded(
  args: readonly string[],
  options: { dir?: string; timeoutSeconds?: number; allFilterScopes?: boolean } = {},
): GitRun {
  if (!gitEnvConfigSupport()) return newGitFault(gitEnvConfigFault ?? GIT_VERSION_REASON);
  const argumentsList = ['--no-optional-locks', ...args];
  if (!options.dir) {
    return gitNeutral(argumentsList, gitGuardSettings(), options.timeoutSeconds ?? 0);
  }
  const tree = readTreeFilterNames(options.dir, options.allFilterScopes ?? false);
  if (tree.fault !== null) return newGitFault(tree.fault);
  return gitProcess(argumentsList, gitGuardSettings(tree.names), {
    timeoutSeconds: options.timeoutSeconds ?? 0,
  });
}

/** The first line a git command printed, trimmed. */
export function gitLine(run: GitRun): string {
  return (run.stdout.find(Boolean) ?? '').trim();
}

export function writeGitStderr(run: GitRun): void {
  for (const line of run.stderr) writeHost(line);
}

export function specFault(spec: string): string | null {
  if (/[\s\x00-\x1f\x7f]/.test(spec)) return 'it holds a space or a control character';
  if (spec.startsWith('-')) return 'it starts with a dash';
  if (spec.includes('..')) return 'it holds ..';
  return null;
}

export function isCommitRef(ref: string): boolean {
  return /^[0-9a-f]{40}$/.test(ref);
}

export function safeRefNameSyntax(ref: string): boolean {
  if (!ref || ref.startsWith('-')) return false;
  if (/[\x00-\x20\x7f~^:?*\[\\]/.test(ref) || ref.includes('..') || ref.includes('@{') || ref.includes('//')) {
    return false;
  }
  if (ref.startsWith('/') || ref.endsWith('/') || ref.endsWith('.')) return false;
  for (const part of ref.split('/')) {
    if (part.startsWith('.') || part.endsWith('.lock')) return false;
  }
  return true;
}

export function isSafeRefName(ref: string): boolean {
  if (isCommitRef(ref)) return true;
  if (!safeRefNameSyntax(ref)) return false;
  return gitGuarded(['check-ref-format', `refs/heads/${ref}`]).code === 0;
}

/** The text fault of a local path, or null. */
export function localTextFault(path: string, platform?: Platform): string | null {
  const platformName = pathPlatform(platform);
  const windows = platformName.toLowerCase() === 'windows';
  if (windows && /^[\\/]{2}/.test(path)) {
    return 'has a UNC or device path, which cannot be a layer source.';
  }
  for (const segment of path.split(/[\\/]/)) {
    if (segment === '' || segment === '.' || segment === '..') continue;
    if (windows && (segment.endsWith('.') || segment.endsWith(' '))) {
      return 'has a folder name with a trailing dot or space, which cannot be a layer source.';
    }
  }
  return null;
}

/** The fault of a recorded local path, read by its text alone. */
export function localPathTextFault(path: string, platform?: Platform): string | null {
  const platformName = pathPlatform(platform);
  const windows = platformName.toLowerCase() === 'windows';
  const textFault = localTextFault(path, platformName);
  if (textFault) return textFault;
  if (!testNonEmptyString(path) || !maxstackAbsolutePath(path, platformName)) return 'needs an absolute path.';
  if (windows) {
    for (const segment of path.split(/[\\/]/)) {
      if (/^[^~]{1,6}~\d+(\.[^.]{0,3})?$/.test(segment)) {
        return 'has an 8.3 short name, which the seed would write and apply then refuses. Give the long path.';
      }
    }
  }
  const normal = fullFolderPath(path);
  if (maxstackPathEqual(normal, dirname(normal) === normal ? normal : resolve(normal, '..'), platformName) && normal === '/') {
    return 'is a drive or share root, which cannot be a layer source.';
  }
  const workspaceNormal = fullFolderPath(S.workspace);
  if (maxstackPathEqual(normal, workspaceNormal, platformName)) {
    return 'is the workspace itself, which cannot be a layer source.';
  }
  if (maxstackPathInside(workspaceNormal, normal, platformName)) {
    return 'is an ancestor of the workspace, and a layer cannot contain the installer that reads it.';
  }
  for (const output of ['.claude', '.opencode', '.pi', '.maxstack']) {
    const folder = joinMaxstackPath(S.workspace, output);
    if (maxstackPathEqual(normal, folder, platformName) || maxstackPathInside(normal, folder, platformName)) {
      return `is inside ${output}, which the installer writes, so it cannot be a layer source.`;
    }
  }
  return null;
}

/** The reason a path cannot be a local layer source, or null. */
export function localPathFault(path: string): string | null {
  const platformName = pathPlatform();
  const windows = platformName.toLowerCase() === 'windows';
  const textFault = localTextFault(path, platformName);
  if (textFault) return textFault;
  if (!testNonEmptyString(path) || !maxstackAbsolutePath(path, platformName)) return 'needs an absolute path.';
  if (windows) {
    try {
      assertMaxstackShortNames(path, 'local');
    } catch (error) {
      return (error as Error).message.slice('local path '.length);
    }
  }
  const full = fullFolderPath(path);
  if (full === '/' || (dirname(full) === full)) {
    return 'is a drive or share root, which cannot be a layer source.';
  }
  const normal = normalPath(full);
  const workspaceNormal = normalPath(S.workspace);
  if (maxstackPathEqual(normal, workspaceNormal, platformName)) {
    return 'is the workspace itself, which cannot be a layer source.';
  }
  if (maxstackPathInside(workspaceNormal, normal, platformName)) {
    return 'is an ancestor of the workspace, and a layer cannot contain the installer that reads it.';
  }
  for (const output of ['.claude', '.opencode', '.pi', '.maxstack']) {
    const folder = normalPath(joinMaxstackPath(S.workspace, output));
    if (maxstackPathEqual(normal, folder, platformName) || maxstackPathInside(normal, folder, platformName)) {
      return `is inside ${output}, which the installer writes, so it cannot be a layer source.`;
    }
  }
  if (isMaxstackCheckoutLocation(normal, S.repoRoot || '')) {
    return 'is a maxstack checkout, which cannot be a layer source.';
  }
  return null;
}

function readLocalSpec(name: string, path: string): SourceChoice {
  const textFault = localTextFault(path);
  if (textFault) throw new Error(`-Source ${name}=local:${safeName(path)} ${textFault}`);
  const fault = localPathFault(path);
  const shown = safeName(path);
  if (fault) throw new Error(`-Source ${name}=local:${shown} ${fault}`);
  if (!isDirectory(path)) throw new Error(`-Source ${name}=local:${shown}: that folder does not exist.`);
  return { kind: 'local', path: fullFolderPath(path) };
}

/** Whether a url is an https address with a host and a path. */
export function isHttpsGitUrl(url: string): boolean {
  return !url.includes('\n') && /^https:\/\/[^/\\?#@]+\/[^\\?#@]+$/.test(url);
}

const SOURCE_EXTRA_FORBIDDEN = '\u00A0';

function newSourceFault(code: string, reason: string): SourceChoice {
  return { kind: 'default', reason, code };
}

/** The one source grammar. */
export function readSourceGrammar(
  spec: string,
  options: { settings?: boolean; noGit?: boolean; platform?: Platform } = {},
): SourceChoice & { code?: string | null } {
  if (findBoundaryIndex(spec) >= 0 || spec.includes(SOURCE_EXTRA_FORBIDDEN)) {
    const badIndex = findBoundaryIndex(spec);
    const held =
      badIndex >= 0
        ? `the character \\u${spec.charCodeAt(badIndex).toString(16).toUpperCase().padStart(4, '0')}`
        : 'a non-breaking space';
    return { ...newSourceFault('forbidden', ` holds ${held}, which a source may not hold.`), code: 'forbidden' };
  }
  if (ordinalEqual(spec, 'default') || (ordinalEqual(spec, '') && !options.settings)) {
    return { kind: 'default', code: null };
  }
  if (spec.startsWith('local:')) {
    return readLocalGrammar(spec.slice(6), options.settings ?? false, options.platform);
  }
  const fault = specFault(spec);
  if (fault) {
    return {
      ...newSourceFault(
        'spec',
        ` is refused: ${fault}. Use owner/repo@ref, https://host/path.git@ref, or local:<absolute path>.`,
      ),
      code: 'spec',
    };
  }
  return readGitGrammar(spec, options.noGit ?? false);
}

function readLocalGrammar(path: string, settings: boolean, platform?: Platform): SourceChoice {
  const platformName = pathPlatform(platform);
  const textFault = localTextFault(path, platformName);
  if (textFault) return { ...newSourceFault('local-text', ` ${textFault}`), code: 'local-text' };
  const absolute = maxstackAbsolutePath(path, platformName);
  if (settings) {
    if (!path.trim()) return { ...newSourceFault('unsafe-local', ' has an unsafe local path.'), code: 'unsafe-local' };
    if (platformName.toLowerCase() === 'windows' && !absolute && /^([A-Za-z]:|[\\/])/.test(path)) {
      return { ...newSourceFault('unsafe-local', ' has an unsafe local path.'), code: 'unsafe-local' };
    }
    if (!absolute && /(^|[\\/])\.\.([\\/]|$)/.test(path)) {
      return { ...newSourceFault('unsafe-local', ' has an unsafe local path.'), code: 'unsafe-local' };
    }
  }
  return { kind: 'local', path, absolute };
}

function readGitGrammar(spec: string, noGit: boolean): SourceChoice {
  const at = spec.lastIndexOf('@');
  if (at < 1) {
    return {
      ...newSourceFault('ref', ' needs @ref: the branch, tag, or full commit to install.'),
      code: 'ref',
    };
  }
  const location = spec.slice(0, at);
  const ref = spec.slice(at + 1);
  const refIsSafe = noGit ? safeRefNameSyntax(ref) : isSafeRefName(ref);
  if (!refIsSafe) {
    return {
      ...newSourceFault('ref', ' has a ref that is not a safe git ref name.'),
      code: 'ref',
    };
  }
  if (/^([A-Za-z]:[\\/]|[\\/])/.test(location)) {
    return {
      ...newSourceFault(
        'folder-ref',
        ` names a folder with an @ref, which is not a git source: did you mean local:${safeName(location)}?`,
      ),
      code: 'folder-ref',
    };
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(location)) {
    if (!isHttpsGitUrl(location)) {
      return {
        ...newSourceFault('scheme', ': only https:// URLs with a host and a path are allowed.'),
        code: 'scheme',
      };
    }
    return { kind: 'git', url: location, ref };
  }
  const match = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)$/.exec(location);
  if (match) {
    return {
      kind: 'git',
      url: null,
      ref,
      ...({ owner: match[1], repo: (match[2] as string).replace(/\.git$/, '') } as object),
    };
  }
  return {
    ...newSourceFault('location', ': the location must be owner/repo or an https:// URL.'),
    code: 'location',
  };
}

/** Reads one -Source spec. */
export function readSourceSpec(name: string, spec: string): SourceChoice {
  const grammar = readSourceGrammar(spec);
  if (grammar.code) throw new Error(`-Source ${name}=${safeName(spec)}${grammar.reason}`);
  if (grammar.kind === 'default') return { kind: 'default' };
  if (grammar.kind === 'local') return readLocalSpec(name, grammar.path as string);
  const url =
    grammar.url ??
    githubRemoteUrl(
      (grammar as unknown as { owner: string }).owner,
      (grammar as unknown as { repo: string }).repo,
    );
  return { kind: 'git', url, ref: grammar.ref };
}

function addExplicitSource(
  table: Map<string, SourceChoice>,
  name: string,
  spec: SourceChoice,
  layerNames: readonly string[],
): void {
  if (!ordinalIn(name, layerNames)) {
    throw new Error(`-Source names an unknown layer: ${name}. Layers in layers.json: ${layerNames.join(', ')}.`);
  }
  if (table.has(name)) throw new Error(`-Source names layer ${name} twice.`);
  table.set(name, spec);
}

/** The explicit sources a run names. */
export function readSourceSpecs(
  specs: readonly string[],
  layerSpecs: readonly string[],
  layerNames: readonly string[],
): Map<string, SourceChoice> {
  const table = new Map<string, SourceChoice>();
  for (const raw of specs.flatMap((entry) => entry.split(',')).filter(Boolean)) {
    const [name, ...rest] = raw.split('=');
    assertBoundaryText(name, '-Source name');
    if (rest.length === 0) {
      throw new Error(`-Source expects name=spec, got '${raw}'. A comma separates -Source entries, so a path cannot hold one.`);
    }
    const spec = rest.join('=');
    addExplicitSource(table, name as string, readSourceSpec(name as string, spec), layerNames);
  }
  for (const raw of layerSpecs.flatMap((entry) => entry.split(',')).filter(Boolean)) {
    const [name, ...rest] = raw.split('=');
    assertBoundaryText(name, '-LayerSource name');
    const path = rest.join('=');
    if (!testNonEmptyString(path)) throw new Error(`LayerSource expects name=path, got '${raw}'.`);
    const grammar = readSourceGrammar(`local:${path}`);
    if (grammar.code) throw new Error(`-LayerSource ${name}=${safeName(path)}${grammar.reason}`);
    const full = isAbsolute(path) ? path : joinMaxstackPath(process.cwd(), path);
    addExplicitSource(table, name as string, readLocalSpec(name as string, full), layerNames);
  }
  return table;
}

/** Joins a folder inside a checkout or cache. '.' names the whole repository. */
export function joinSourceSub(root: string, sub: string): string {
  if (!sub || sub === '.') return root;
  return joinMaxstackPath(root, sub);
}

export interface CheckoutState {
  commit: string | null;
  dirty: boolean | null;
  unreadable: string | null;
}

function unreadableState(reason: string): CheckoutState {
  return { commit: null, dirty: null, unreadable: reason };
}

/** The state of a local checkout, read without writing. */
export function localCheckoutState(root: string): CheckoutState {
  try {
    return readLocalCheckoutState(root);
  } catch (error) {
    return unreadableState(`the checkout could not be read: ${(error as Error).message}`);
  }
}

function readLocalCheckoutState(root: string): CheckoutState {
  if (!isDirectory(root)) return { commit: null, dirty: null, unreadable: null };
  const head = gitGuarded(['-C', root, 'rev-parse', 'HEAD'], { dir: root });
  if (head.unreadable !== null) return unreadableState(head.unreadable);
  if (head.code !== 0 || !gitLine(head)) return { commit: null, dirty: null, unreadable: null };
  const top = gitGuarded(['-C', root, 'rev-parse', '--show-toplevel'], { dir: root });
  if (top.code !== 0 || !gitLine(top) || normalPath(gitLine(top)) !== normalPath(root)) {
    return { commit: null, dirty: null, unreadable: null };
  }
  const status = gitGuarded(
    ['-C', root, 'status', '--porcelain', '--ignore-submodules=all', '--', '.'],
    { dir: root, allFilterScopes: true },
  );
  if (status.unreadable !== null) return unreadableState(status.unreadable);
  if (status.incomplete) return unreadableState('git output was cut off, so the worktree state is unknown');
  const dirty = status.code === 0 ? status.stdout.length > 0 : null;
  return { commit: gitLine(head), dirty, unreadable: null };
}

/** The commit a branch, tag, or full commit names on a remote. */
export function findGitRefCommit(url: string, ref: string, timeoutSeconds = 60): string {
  const run = gitGuarded(['ls-remote', '--', url], { timeoutSeconds });
  if (run.timedOut) {
    throw new Error(
      `could not read the refs of ${url}: git ls-remote took longer than ${timeoutSeconds} seconds, so it was stopped. Check the network and the url.`,
    );
  }
  if (run.unreadable !== null) throw new Error(`could not read the refs of ${url}: ${run.unreadable}.`);
  if (run.incomplete) {
    throw new Error(
      `could not read the refs of ${url}: git output was cut off, so the refs are unknown. A process may still hold the output open.`,
    );
  }
  if (run.code !== 0) {
    throw new Error(`could not read the refs of ${url}: ${[...run.stdout, ...run.stderr].join(' ')}`);
  }
  const refs = new Map<string, string>();
  for (const line of run.stdout) {
    const [sha, name] = line.split('\t');
    if (name) refs.set(name, sha as string);
  }
  for (const candidate of [`refs/heads/${ref}`, `refs/tags/${ref}^{}`, `refs/tags/${ref}`]) {
    const found = refs.get(candidate);
    if (found) return found;
  }
  throw new Error(`${url} has no branch or tag named ${ref}.`);
}

function newDefaultChoice(layer: LayerModel): SourceChoice {
  if (layer.defaultGit) {
    return {
      kind: 'git',
      url: layer.defaultUrl,
      ref: layer.defaultRef,
      commit: layer.defaultCommit,
      path: null,
      checkout: null,
      override: false,
    };
  }
  const checkout = joinMaxstackPath(S.workspace, layer.path as string);
  return {
    kind: 'local',
    url: layer.defaultUrl,
    ref: null,
    commit: null,
    path: layer.path,
    checkout,
    override: false,
  };
}

function newGitChoice(layer: LayerModel, url: string, ref: string, commit: string | null): SourceChoice {
  const resolved = commit ?? (isCommitRef(ref) ? ref : findGitRefCommit(url, ref));
  if (layer.defaultGit && ordinalEqual(url, layer.defaultUrl) && ordinalEqual(resolved, layer.defaultCommit)) {
    return newDefaultChoice(layer);
  }
  return { kind: 'git', url, ref, commit: resolved, path: null, checkout: null, override: true };
}

function newLocalChoice(layer: LayerModel, path: string): SourceChoice {
  const full = fullFolderPath(path);
  if (
    !layer.defaultGit &&
    maxstackPathEqual(normalPath(full), normalPath(joinMaxstackPath(S.workspace, layer.path as string)))
  ) {
    return newDefaultChoice(layer);
  }
  return { kind: 'local', url: null, ref: null, commit: null, path: full, checkout: full, override: true };
}

function newUnavailableChoice(path: string | null, reason: string): SourceChoice {
  return {
    kind: 'unavailable',
    url: null,
    ref: null,
    commit: null,
    path,
    checkout: null,
    override: true,
    reason,
  };
}

function resolveLayerChoice(
  layer: LayerModel,
  explicit: SourceChoice | undefined,
  recorded: SourceChoice | undefined,
  updating: boolean,
): SourceChoice {
  if (explicit) {
    if (explicit.kind === 'default') return newDefaultChoice(layer);
    if (explicit.kind === 'unavailable') return newUnavailableChoice(explicit.path ?? null, explicit.reason ?? '');
    if (explicit.kind === 'local') return newLocalChoice(layer, explicit.path as string);
    return newGitChoice(layer, explicit.url as string, explicit.ref as string, null);
  }
  if (recorded) {
    if (recorded.kind === 'local') return newLocalChoice(layer, recorded.path as string);
    const commit = updating && !isCommitRef(recorded.ref as string) ? null : (recorded.commit ?? null);
    return newGitChoice(layer, recorded.url as string, recorded.ref as string, commit);
  }
  return newDefaultChoice(layer);
}

function resolveLayerChoiceOrUnavailable(
  layer: LayerModel,
  explicit: SourceChoice | undefined,
  recorded: SourceChoice | undefined,
  updating: boolean,
  fromSettings: boolean,
): SourceChoice {
  if (!fromSettings) return resolveLayerChoice(layer, explicit, recorded, updating);
  try {
    return resolveLayerChoice(layer, explicit, recorded, updating);
  } catch (error) {
    return newUnavailableChoice(
      null,
      `cannot be used: its git ref could not be read: ${safeName((error as Error).message)}.`,
    );
  }
}

function setLayerChoice(layer: LayerModel, choice: SourceChoice, fromSettings = false): void {
  layer.override = Boolean(choice.override);
  layer.recordUrl = choice.url ?? null;
  layer.settingsSourced = fromSettings;
  layer.settingsFault = null;
  if (choice.kind === 'unavailable') {
    layer.sourceKind = 'local';
    layer.url = null;
    layer.ref = null;
    layer.commit = null;
    layer.dirty = null;
    layer.unreadable = choice.reason ?? '';
    layer.localPath = choice.path ?? null;
    layer.repoRoot = null;
    layer.root = null;
    layer.folderMissing = false;
    layer.settingsFault = choice.reason ?? '';
    return;
  }
  if (choice.kind === 'git') {
    layer.sourceKind = 'git';
    layer.url = choice.url ?? null;
    layer.ref = choice.ref ?? null;
    layer.commit = choice.commit ?? null;
    layer.dirty = null;
    layer.unreadable = null;
    layer.localPath = null;
    layer.folderMissing = false;
    layer.repoRoot = null;
    layer.root = null;
    return;
  }
  const state = localCheckoutState(choice.checkout as string);
  layer.sourceKind = 'local';
  layer.url = null;
  layer.ref = null;
  layer.commit = state.commit;
  layer.dirty = state.dirty;
  layer.unreadable = state.unreadable;
  layer.localPath = choice.path ?? null;
  layer.repoRoot = choice.checkout ?? null;
  layer.folderMissing = !isDirectory(choice.checkout as string);
  layer.root = layer.folderMissing || layer.unreadable ? null : joinSourceSub(choice.checkout as string, layer.sourcePath);
}

/** Resolves every layer's source for this run. */
export function setLayerSources(args: {
  layers: LayerModel[];
  explicit: Map<string, SourceChoice>;
  recorded: Map<string, SourceChoice>;
  updating: boolean;
  selectedLayers: readonly string[];
  fromSettings?: readonly string[];
}): void {
  for (const layer of args.layers) {
    const moves = args.updating && ordinalIn(layer.name, args.selectedLayers);
    const fromSettingsFile = ordinalIn(layer.name, args.fromSettings ?? []);
    const choice = resolveLayerChoiceOrUnavailable(
      layer,
      args.explicit.get(layer.name),
      args.recorded.get(layer.name),
      moves,
      fromSettingsFile,
    );
    setLayerChoice(layer, choice, fromSettingsFile);
  }
}

/** The source record the lock keeps for one layer. */
export function newSourceRecord(layer: LayerModel): Record<string, unknown> {
  if (layer.sourceKind === 'git') {
    return { kind: 'git', url: layer.url, ref: layer.ref, commit: layer.commit, override: layer.override };
  }
  return {
    kind: 'local',
    url: layer.recordUrl,
    ref: null,
    commit: layer.commit,
    dirty: layer.dirty,
    override: layer.override,
    path: layer.localPath,
  };
}

export interface RecordedSources {
  overrides: Map<string, SourceChoice>;
  invalid: Map<string, { field: string; reason: string }>;
}

/** The recorded overrides the lock holds, split into those that pass the -Source rules and those that do not. */
export function getRecordedOverrides(stack: Record<string, unknown> | null): RecordedSources {
  const overrides = new Map<string, SourceChoice>();
  const invalid = new Map<string, { field: string; reason: string }>();
  for (const layer of (stack?.layers as Array<Record<string, unknown>> | undefined) ?? []) {
    const block = getField(layer, 'source') as Record<string, unknown> | null;
    if (!block || block.override !== true) continue;
    const fault = recordedSourceFault(block);
    if (fault) invalid.set(layer.name as string, fault);
    else overrides.set(layer.name as string, block as unknown as SourceChoice);
  }
  return { overrides, invalid };
}

function recordedSourceFault(block: Record<string, unknown>): { field: string; reason: string } | null {
  const kind = getField(block, 'kind');
  if (ordinalEqual(kind, 'local')) {
    const reason = localPathFault((getField(block, 'path') as string) ?? '');
    return reason ? { field: 'path', reason } : null;
  }
  if (!ordinalEqual(kind, 'git')) return { field: 'kind', reason: 'it is neither git nor local.' };
  const url = getField(block, 'url');
  const httpsUrl = testNonEmptyString(url) && isHttpsGitUrl(url as string) && !specFault(url as string);
  const seamUrl =
    testTestSeam() &&
    testNonEmptyString(url) &&
    /^([A-Za-z]:\/|\/)[^\x00-\x1f\x7f@]+$/.test(url as string);
  if (!httpsUrl && !seamUrl) return { field: 'url', reason: 'it is not an https address with a host and a path.' };
  const ref = getField(block, 'ref');
  if (!(testNonEmptyString(ref) && !specFault(ref as string) && isSafeRefName(ref as string))) {
    return { field: 'ref', reason: 'it is not a safe git ref name.' };
  }
  if (!isCommitRef((getField(block, 'commit') as string) ?? '')) {
    return { field: 'commit', reason: 'it is not a full 40-character lowercase commit SHA.' };
  }
  return null;
}

export function formatRecordedFault(name: string, fault: { field: string; reason: string }): string {
  return `stack.lock.json: layer '${name}' has an invalid ${fault.field}: ${fault.reason}`;
}

export function writeInvalidRecordedSources(
  invalid: Map<string, { field: string; reason: string }>,
  skip: readonly string[],
): void {
  for (const name of ordinalSorted([...invalid.keys()])) {
    if (ordinalIn(name, skip)) continue;
    writeWarning(
      `${formatRecordedFault(name, invalid.get(name) as { field: string; reason: string })} This run ignores the recorded override and uses the layers.json source. Repair it with -Source ${name}=default -Apply.`,
    );
    writeHost(`  ${name}: invalid recorded source, ignored for this run`);
  }
}

/** The source a lock records for a layer, or the one its layers.json entry implies. */
export function getRecordedSourceOf(record: Record<string, unknown>): Record<string, unknown> {
  const block = getField(record, 'source');
  if (block && typeof block === 'object' && !Array.isArray(block)) {
    const value = block as Record<string, unknown>;
    return {
      kind: getField(value, 'kind'),
      url: getField(value, 'url'),
      ref: getField(value, 'ref'),
      commit: getField(value, 'commit'),
      dirty: getField(value, 'dirty'),
      override: getField(value, 'override'),
      path: getField(value, 'path'),
    };
  }
  const local = getField(record, 'path') !== null;
  return {
    kind: local ? 'local' : 'git',
    url: local ? null : getField(record, 'source'),
    ref: null,
    commit: getField(record, 'commit'),
    dirty: null,
    override: false,
    path: getField(record, 'path'),
  };
}

function formatDirtyLabel(dirty: unknown): string {
  if (dirty === null || dirty === undefined) return 'dirty state not recorded';
  return dirty ? 'uncommitted changes' : 'clean';
}

export interface SourceEntry {
  name: string;
  source: Record<string, unknown>;
  unreadable: string | null;
  settingsFault: string | null;
}

function localSourceFolder(path: string): string {
  return isAbsolute(path) ? path : joinMaxstackPath(S.workspace, path);
}

function sourcePinLines(entries: readonly SourceEntry[]): string[] {
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.settingsFault) {
      lines.push(`  ${entry.name}: declared source skipped: ${safeName(entry.settingsFault)}`);
      continue;
    }
    const source = entry.source;
    if (ordinalEqual(source.kind, 'git')) {
      if (source.override === true) {
        lines.push(`  ${entry.name}: override, git ${source.url} ref ${source.ref} at ${source.commit}`);
      }
      continue;
    }
    const kind = source.override === true ? 'override, local' : 'local, default';
    const shown = safeName(source.path as string);
    if (testNonEmptyString(source.path)) {
      if (!isDirectory(localSourceFolder(source.path as string))) {
        lines.push(`  ${entry.name}: ${kind} ${shown}: folder missing`);
        continue;
      }
    }
    if (entry.unreadable) {
      lines.push(`  ${entry.name}: ${kind} ${shown}: unreadable: ${safeName(entry.unreadable)}`);
      continue;
    }
    const where =
      source.commit === null || source.commit === undefined
        ? 'not a git checkout'
        : `HEAD ${source.commit}, ${formatDirtyLabel(source.dirty)}`;
    lines.push(`  ${entry.name}: ${kind} ${shown} (${where})`);
  }
  return lines;
}

export function writeSourcePinBlock(entries: readonly SourceEntry[]): void {
  const lines = sourcePinLines(entries);
  if (lines.length === 0) return;
  writeHost('Layer sources not at their committed pin:');
  for (const line of lines) writeHost(line);
}

function recordedUnreadable(source: Record<string, unknown>): string | null {
  if (!ordinalEqual(source.kind, 'local') || !testNonEmptyString(source.path)) return null;
  try {
    const folder = localSourceFolder(source.path as string);
    if (!isDirectory(folder)) return null;
    return readTreeFilterNames(folder).fault;
  } catch (error) {
    return `the folder could not be read: ${(error as Error).message}`;
  }
}

export function getRecordedSourceEntries(stack: Record<string, unknown> | null): SourceEntry[] {
  if (!stack) return [];
  return ((stack.layers as Array<Record<string, unknown>> | undefined) ?? []).map((layer) => {
    const source = getRecordedSourceOf(layer);
    return {
      name: layer.name as string,
      source,
      unreadable: recordedUnreadable(source),
      settingsFault: null,
    };
  });
}

export function getResolvedSourceEntries(layers: readonly LayerModel[]): SourceEntry[] {
  return layers.map((layer) => ({
    name: layer.name,
    source: newSourceRecord(layer),
    unreadable: layer.unreadable,
    settingsFault: layer.settingsFault,
  }));
}

function formatCommit(commit: unknown): string {
  return commit === null || commit === undefined ? 'none' : String(commit);
}

function formatDirtyState(dirty: unknown): string {
  if (dirty === null || dirty === undefined) return 'unknown';
  return dirty ? 'yes' : 'no';
}

function testCachedCommit(cache: string, commit: string | null | undefined): boolean {
  if (!commit || !existsSync(joinMaxstackPath(cache, '.git'))) return false;
  const present = gitGuarded(['--no-lazy-fetch', '-C', cache, 'cat-file', '-e', `${commit}^{commit}`], { dir: cache });
  return present.code === 0;
}

let noLazyFetchSupported: boolean | null = null;

function testNoLazyFetchSupport(): boolean {
  if (noLazyFetchSupported === null) {
    noLazyFetchSupported = gitGuarded(['--no-lazy-fetch', 'version']).code === 0;
  }
  return noLazyFetchSupported;
}

function moveFilesNote(layer: LayerModel, oldCommit: string | null): string {
  const cache = joinMaxstackPath(S.claudeCacheTarget, layer.name);
  if (!testNoLazyFetchSupport()) {
    return 'changed files unknown: git 2.44 or later is needed to read the cache without fetching';
  }
  if (!oldCommit || !isCommitRef(oldCommit)) return 'changed files unknown: the recorded commit is not a full SHA';
  if (!testCachedCommit(cache, layer.commit)) {
    return 'needs fetch: the new commit is not in the cache, so the changed files are known after an apply fetches it';
  }
  if (!testCachedCommit(cache, oldCommit)) return 'changed files unknown: the old commit is not in the cache';
  const diff = gitGuarded(
    ['--no-lazy-fetch', '-C', cache, 'diff', '--no-renames', '--name-only', oldCommit, layer.commit as string, '--', layer.sourcePath],
    { dir: cache },
  );
  if (diff.code !== 0) return 'changed files unknown: git could not list the changed files from the cache';
  return `${diff.stdout.length} files changed under ${layer.sourcePath}`;
}

/** One layer's line in the -Update report, and whether the layer's source changes. */
export function getSourceUpdate(
  layer: LayerModel,
  priorSource: Record<string, unknown> | null,
): { line: string; changed: boolean } {
  const oldCommit = priorSource ? (getField(priorSource, 'commit') as string | null) : null;
  if (layer.sourceKind === 'local') {
    if (layer.folderMissing) return { line: `  ${layer.name}: local ${layer.localPath}: folder missing`, changed: true };
    if (layer.unreadable) {
      return { line: `  ${layer.name}: local ${layer.localPath}: unreadable: ${layer.unreadable}`, changed: true };
    }
    const was = formatDirtyState(priorSource ? getField(priorSource, 'dirty') : null);
    const now = formatDirtyState(layer.dirty);
    const head = `HEAD ${formatCommit(oldCommit)} -> ${formatCommit(layer.commit)}`;
    return {
      line: `  ${layer.name}: local ${layer.localPath}: ${head}, uncommitted changes ${was} -> ${now}`,
      changed: !ordinalSame(oldCommit, layer.commit) || was !== now,
    };
  }
  if (!layer.override) {
    return { line: `  ${layer.name}: pinned at ${layer.commit} in layers.json`, changed: false };
  }
  if (isCommitRef(layer.ref as string)) {
    return { line: `  ${layer.name}: override pinned to commit ${layer.commit}, not moved`, changed: false };
  }
  if (ordinalSame(oldCommit, layer.commit)) {
    return { line: `  ${layer.name}: ${layer.ref} is at ${layer.commit}, unchanged`, changed: false };
  }
  const note = moveFilesNote(layer, oldCommit);
  return { line: `  ${layer.name}: ${layer.ref} ${oldCommit} -> ${layer.commit}; ${note}`, changed: true };
}

/** The hint for a layers.json pin whose branch has moved on. */
export function getPinHint(layer: LayerModel): string | null {
  if (!layer.defaultGit || isCommitRef(layer.defaultRef as string)) return null;
  let head: string;
  try {
    head = findGitRefCommit(layer.defaultUrl as string, layer.defaultRef as string);
  } catch (error) {
    return `  ${layer.name}: cannot read ${layer.defaultRef} to check the pin: ${(error as Error).message}`;
  }
  if (ordinalEqual(head, layer.defaultCommit)) return null;
  return `  ${layer.name}: layers.json pins ${layer.defaultCommit}, and ${layer.defaultRef} is at ${head}. -Update never moves a pin. To move it, change source.commit in layers.json (and the matching pin in pstack.lock.json), then run verify-manifests.`;
}

/** The record one layer has in the lock, or null. */
export function getPriorLayerRecord(
  stack: Record<string, unknown> | null,
  name: string,
): Record<string, unknown> | null {
  if (!stack) return null;
  return ((stack.layers as Array<Record<string, unknown>> | undefined) ?? []).find((layer) => layer.name === name) ?? null;
}

export function writeUpdateSummary(changes: number): void {
  if (changes === 0) {
    writeHost('Nothing would change.');
    return;
  }
  writeHost(`Would change: ${changes} item(s).`);
}

export { sortUtf8, readText, sha256FileOrNull, basename, readdirSync, readFileSync, statSync };

/** The runtime names layers.json may declare, in the order the installer names them. */
export const RUNTIME_NAMES = ['claude', 'opencode', 'copilot', 'pi', 'codex', 'cursor', 'antigravity'];

/** The runtimes a new workspace selects when none is named. */
export const DEFAULT_RUNTIME_NAMES = ['claude', 'opencode', 'copilot', 'pi'];

/** Whether a value is a relative path that stays inside its root. */
export function testRelativePath(value: unknown): boolean {
  return (
    testNonEmptyString(value) &&
    !isAbsolute(value as string) &&
    !/(^|[\\/])\.\.([\\/]|$)/.test(value as string)
  );
}

/** Turns one layers.json entry into the record the rest of the installer reads. */
export function newLayerModel(raw: Record<string, unknown>): LayerModel {
  const name = getField(raw, 'name');
  if (!testNonEmptyString(name) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name as string)) {
    throw new Error(`Layer name '${safeName(String(name ?? ''))}' must be a non-empty folder-safe name.`);
  }
  const kind = getField(raw, 'kind');
  if (!ordinalIn(kind, ['plugin', 'config'])) throw new Error(`Layer '${name as string}' kind must be plugin or config.`);

  const runtimes: Record<string, unknown> = {};
  const runtimeBlock = getField(raw, 'runtimes');
  if (runtimeBlock !== null && runtimeBlock !== undefined) {
    for (const [key, value] of Object.entries(runtimeBlock as Record<string, unknown>)) {
      if (!ordinalIn(key, RUNTIME_NAMES)) {
        throw new Error(`Layer '${name as string}' names an unknown runtime '${safeName(key)}'.`);
      }
      runtimes[key] = value;
    }
  }

  const source = getField(raw, 'source');
  let path: string | null = null;
  let defaultUrl: string | null = null;
  let defaultRef: string | null = null;
  let sourcePath = '.';
  let commit: string | null = null;
  if (typeof source === 'string') {
    path = getField(raw, 'path') as string | null;
    if (!testRelativePath(path)) throw new Error(`Layer '${name as string}' needs a relative checkout path.`);
    defaultUrl = source;
  } else if (source !== null && source !== undefined) {
    if (!ordinalEqual(kind, 'plugin')) {
      throw new Error(`Layer '${name as string}' is pinned to a git source, so its kind must be plugin.`);
    }
    const block = source as Record<string, unknown>;
    defaultUrl = getField(block, 'url') as string | null;
    sourcePath = (getField(block, 'path') as string | null) ?? '';
    commit = getField(block, 'commit') as string | null;
    defaultRef = getField(block, 'ref') as string | null;
    if (!testNonEmptyString(defaultUrl)) throw new Error(`Layer '${name as string}' source needs a url.`);
    if (!testRelativePath(sourcePath)) {
      throw new Error(`Layer '${name as string}' source.path must be a relative path inside the repository.`);
    }
    if (!testNonEmptyString(commit) || !/^[0-9a-f]{40}$/.test(commit as string)) {
      throw new Error(`Layer '${name as string}' source.commit must be a 40-character lowercase commit SHA.`);
    }
  } else {
    throw new Error(`Layer '${name as string}' needs a source.`);
  }

  if (Object.hasOwn(runtimes, 'copilot') && !Object.hasOwn(runtimes, 'claude')) {
    throw new Error(`Layer '${name as string}' declares copilot, which loads the Claude plugin folder, so it also needs claude.`);
  }
  if (Object.hasOwn(runtimes, 'pi') && !Object.hasOwn(runtimes, 'claude')) {
    throw new Error(`Layer '${name as string}' declares pi, which lists the Claude plugin folder's skills, so it also needs claude.`);
  }
  if (Object.hasOwn(runtimes, 'claude') && path !== null && !Object.hasOwn(runtimes, 'opencode')) {
    throw new Error(
      `Layer '${name as string}' declares claude from a local checkout, which links to its OpenCode copy, so it also needs opencode.`,
    );
  }

  return {
    name: name as string,
    kind: kind as string,
    defaultGit: typeof source !== 'string' && source !== null && source !== undefined,
    defaultUrl,
    defaultRef,
    defaultCommit: commit,
    path,
    sourcePath,
    declared: runtimes,
    runtimes: { ...runtimes },
    url: null,
    ref: null,
    commit: null,
    dirty: null,
    unreadable: null,
    localPath: null,
    repoRoot: null,
    root: null,
    sourceKind: '',
    override: false,
    recordUrl: null,
    settingsSourced: false,
    settingsFault: null,
    folderMissing: false,
  };
}

/** Brings a layer's cache to the pinned commit and returns the cache path. */
export function syncGitPlugin(layer: LayerModel, cacheRoot: string): string {
  const cache = joinMaxstackPath(cacheRoot, layer.name);
  if (!pathExists(joinMaxstackPath(cache, '.git'))) {
    mkdirSync(cacheRoot, { recursive: true });
    writeHost(`Cloning ${layer.url} (partial, sparse) into ${cache}`);
    const clone = gitGuarded(['clone', '--quiet', '--filter=blob:none', '--no-checkout', '--sparse', '--', layer.url as string, resolve(cache)]);
    if (clone.code !== 0) {
      writeGitStderr(clone);
      throw new Error(`git clone of ${layer.url} failed for '${layer.name}'.`);
    }
    gitGuarded(['-C', cache, 'config', 'core.autocrlf', 'false'], { dir: cache });
    gitGuarded(['-C', cache, 'config', 'core.eol', 'lf'], { dir: cache });
  }
  gitGuarded(['-C', cache, 'remote', 'set-url', 'origin', layer.url as string], { dir: cache });
  const sparse = ordinalEqual(layer.sourcePath, '.')
    ? gitGuarded(['-C', cache, 'sparse-checkout', 'disable'], { dir: cache })
    : gitGuarded(['-C', cache, 'sparse-checkout', 'set', layer.sourcePath], { dir: cache });
  if (sparse.code !== 0) {
    writeGitStderr(sparse);
    throw new Error(`git sparse-checkout of ${layer.sourcePath} failed in ${cache}.`);
  }

  const present = gitGuarded(['-C', cache, 'cat-file', '-e', `${layer.commit}^{commit}`], { dir: cache });
  if (present.code !== 0) {
    const fetch = gitGuarded(['-C', cache, 'fetch', '--quiet', '--filter=blob:none', 'origin', '--', layer.commit as string], {
      dir: cache,
    });
    if (fetch.code !== 0) {
      writeGitStderr(fetch);
      const what = layer.override ? 'commit' : 'pinned commit';
      const hint = layer.override ? 'Check the -Source spec.' : 'Check source.commit in layers.json.';
      throw new Error(`Could not fetch the ${what} ${layer.commit} from ${layer.url} for '${layer.name}'. ${hint}`);
    }
  }
  const checkout = gitGuarded(
    ['-C', cache, '-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', '--end-of-options', layer.commit as string],
    { dir: cache },
  );
  if (checkout.code !== 0) {
    writeGitStderr(checkout);
    throw new Error(`git checkout of ${layer.commit} failed in ${cache}.`);
  }
  const headRun = gitGuarded(['-C', cache, 'rev-parse', 'HEAD'], { dir: cache });
  if (headRun.unreadable !== null) {
    throw new Error(`Could not read the HEAD of the cache for '${layer.name}': ${headRun.unreadable}.`);
  }
  const head = gitLine(headRun);
  if (!ordinalEqual(head, layer.commit)) {
    throw new Error(`The cache is at ${head}, not the pinned ${layer.commit} for '${layer.name}'.`);
  }
  const clean = gitGuarded(['-C', cache, 'clean', '-ffdx'], { dir: cache });
  for (const line of clean.stdout) writeHost(`Cache ${layer.name}: ${line}`);
  return cache;
}

/** Whether a pinned layer's cache is a checkout of the pinned commit. */
export function testCacheAtPin(layer: LayerModel, cacheRoot: string): boolean {
  const cache = joinMaxstackPath(cacheRoot, layer.name);
  if (!pathExists(joinMaxstackPath(cache, '.git'))) return false;
  const run = gitGuarded(['-C', cache, 'rev-parse', 'HEAD'], { dir: cache });
  return run.code === 0 && ordinalEqual(gitLine(run), layer.commit);
}

/** The folder a layer installs from, or null when its cache is not at its pin yet. */
export function getLayerRoot(layer: LayerModel, cacheRoot: string): string | null {
  if (layer.url === null) return layer.root;
  if (!testCacheAtPin(layer, cacheRoot)) return null;
  return joinSourceSub(joinMaxstackPath(cacheRoot, layer.name), layer.sourcePath);
}
