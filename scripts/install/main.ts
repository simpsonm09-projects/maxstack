// The command line for the TypeScript workspace installer. It reads the same flags as
// scripts/Install-Workspace.ps1, accepting both the PowerShell single-dash spelling and the double-dash form, and
// hands them to runWorkspaceInstaller. Bun runs this file: `bun scripts/install/main.ts -Apply`.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runWorkspaceInstaller, type WorkspaceInstallerOptions } from './workspace.ts';

const USAGE = `Usage: bun scripts/install/main.ts [options]

  -Workspace <path>        The workspace to install into (default: discovery).
  -LayersFile <path>       The layer manifest (default: <repo>/layers.json).
  -T3Settings <path>       An explicit T3 settings source.
  -Source <name=spec>      A per-run layer source, repeatable or comma-separated.
  -LayerSource <name=path> A per-run local layer folder, repeatable or comma-separated.
  -CopilotCommand <cmd>    The Copilot CLI to wrap (default: copilot).
  -PiCommand <cmd>         The Pi CLI to wrap (default: pi).
  -Runtimes <names>        Runtimes to add to the selection, or all.
  -Layers <names>          Layers to add to the selection, or all.
  -InitSettings            Print the settings file derived from the selection.
  -Apply                   Write the workspace.
  -Status                  Report each owned path. Writes nothing.
  -Remove                  Remove the named runtimes or layers. A dry run unless -Apply.
  -Uninstall               Remove everything the lock records. A dry run unless -Apply.
  -Update                  Re-resolve the recorded layer sources.
  -UpdatePi                Refresh the workspace-local Pi package. A dry run unless -Apply.
  -PiVersion <version>     The Pi version -UpdatePi installs (default: latest).
  -Check                   With -Update, write nothing and exit 0.
  -Strict                  Exit 1 when the report finds a problem.`;

interface ParsedArguments {
  options: WorkspaceInstallerOptions;
}

const STRING_FLAGS: Record<string, string> = {
  workspace: 'workspace',
  layersfile: 'layersFile',
  t3settings: 't3Settings',
  copilotcommand: 'copilotCommand',
  picommand: 'piCommand',
  piversion: 'piVersion',
};

const LIST_FLAGS: Record<string, string> = {
  source: 'sourceSpecs',
  sourceoverrides: 'sourceSpecs',
  layersource: 'layerSourceSpecs',
  runtimes: 'requestedRuntimes',
  requestedruntimes: 'requestedRuntimes',
  layers: 'requestedLayers',
  requestedlayers: 'requestedLayers',
};

const SWITCH_FLAGS: Record<string, string> = {
  initsettings: 'initSettings',
  apply: 'apply',
  status: 'status',
  remove: 'remove',
  uninstall: 'uninstall',
  update: 'update',
  updatepi: 'updatePi',
  check: 'check',
  strict: 'strict',
};

const SPECIFIED_FLAGS: Record<string, string> = {
  layersfile: 'layersFileSpecified',
  t3settings: 't3SettingsSpecified',
  copilotcommand: 'copilotCommandSpecified',
  picommand: 'piCommandSpecified',
};

/** Splits one argument into its flag name and an inline value, if the form carries one. */
function splitArgument(raw: string): { name: string; inline: string | null } {
  const text = raw.replace(/^--?/, '');
  const equals = text.indexOf('=');
  const colon = text.indexOf(':');
  const at = equals >= 0 ? equals : colon >= 0 ? colon : -1;
  if (at < 0) return { name: text.toLowerCase(), inline: null };
  return { name: text.slice(0, at).toLowerCase(), inline: text.slice(at + 1) };
}

/** Reads the command line. A list flag appends, and its values are split on commas. */
function parseArguments(argv: readonly string[]): ParsedArguments {
  const options: WorkspaceInstallerOptions = {
    workspace: '',
    workspaceSpecified: false,
    currentDirectory: process.cwd(),
    scriptRoot: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
    repoRoot: resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
    layersFile: null,
    layersFileSpecified: false,
    t3Settings: null,
    t3SettingsSpecified: false,
    sourceSpecs: [],
    layerSourceSpecs: [],
    copilotCommand: 'copilot',
    copilotCommandSpecified: false,
    piCommand: 'pi',
    piCommandSpecified: false,
    requestedRuntimes: [],
    requestedLayers: [],
    runtimesNamed: false,
    layersNamed: false,
    initSettings: false,
    apply: false,
    status: false,
    remove: false,
    uninstall: false,
    update: false,
    updatePi: false,
    piVersion: '',
    check: false,
    strict: false,
  };
  const values = options as unknown as Record<string, unknown>;

  for (let index = 0; index < argv.length; index++) {
    const raw = argv[index] as string;
    if (raw === '--help' || raw === '-h' || raw === '-Help') {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    }
    if (!raw.startsWith('-')) {
      throw new Error(`Unexpected argument '${raw}': every argument is a flag.`);
    }
    const { name, inline } = splitArgument(raw);
    if (name === 'workspace') {
      const value = inline ?? argv[++index];
      if (value === undefined) throw new Error('-Workspace needs a path.');
      options.workspace = value;
      options.workspaceSpecified = true;
      continue;
    }
    const stringTarget = STRING_FLAGS[name];
    if (stringTarget !== undefined) {
      const value = inline ?? argv[++index];
      if (value === undefined) throw new Error(`-${name} needs a value.`);
      values[stringTarget] = value;
      const specified = SPECIFIED_FLAGS[name];
      if (specified !== undefined) values[specified] = true;
      continue;
    }
    const listTarget = LIST_FLAGS[name];
    if (listTarget !== undefined) {
      const value = inline ?? argv[++index];
      if (value === undefined) throw new Error(`-${name} needs a value.`);
      const list = values[listTarget] as string[];
      for (const entry of value.split(',')) {
        if (entry.trim()) list.push(entry);
      }
      if (listTarget === 'requestedRuntimes') options.runtimesNamed = true;
      if (listTarget === 'requestedLayers') options.layersNamed = true;
      continue;
    }
    const switchTarget = SWITCH_FLAGS[name];
    if (switchTarget !== undefined) {
      if (inline !== null) {
        const lowered = inline.toLowerCase();
        if (lowered !== 'true' && lowered !== 'false') {
          throw new Error(`-${name} is a switch and takes no value.`);
        }
        values[switchTarget] = lowered === 'true';
      } else {
        values[switchTarget] = true;
      }
      continue;
    }
    throw new Error(`Unknown argument '${raw}'.`);
  }
  return { options };
}

/** Runs the installer and maps a thrown error to exit code 1 with its message on stderr. */
function main(argv: readonly string[]): number {
  try {
    const { options } = parseArguments(argv);
    return runWorkspaceInstaller(options);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
