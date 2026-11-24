// The mutable run state the installer modules share, mirroring the variables the PowerShell script dot-sources.
import type { Platform } from './paths.ts';

export interface OwnedRecord {
  path: string;
  kind: string;
  sha256?: string | null;
  target?: string | null;
  runtime?: string | null;
  runtimes?: string[];
  layers?: string[];
  key?: string;
  entries?: unknown[];
  unknown?: unknown[];
  createdKey?: boolean;
  preserve?: boolean;
  hookHash?: string | null;
  backup?: boolean;
  role?: string | null;
  quarantine?: string;
  [field: string]: unknown;
}

export interface StackDocument {
  generatedAt?: string;
  workspace?: string;
  selection?: { runtimes: string[]; layers: string[] };
  configSha256?: string | null;
  copilot?: unknown;
  pi?: Record<string, unknown> | null;
  layers?: Array<Record<string, unknown>>;
  ownedSchema?: number;
  owned?: OwnedRecord[];
  createdDirs?: string[];
  createdFiles?: string[];
  settings?: Record<string, unknown>;
  [field: string]: unknown;
}

export interface InstallerState {
  workspace: string;
  repoRoot: string;
  platform: Platform;
  claudeCacheTarget: string;
  claudePluginsTarget: string;
  opencodePluginsTarget: string;
  agentsTarget: string;
  copilotBinTarget: string;
  configTarget: string;
  stackTarget: string;
  piAgentDir: string;
  piSettingsTarget: string;
  piLocalBinTarget: string;
  priorStack: StackDocument | null;
  priorOwned: OwnedRecord[] | null;
  priorLayers: Map<string, Record<string, unknown>>;
  priorCreatedDirs: string[];
  priorCreatedFiles: string[];
  priorLegacy: boolean;
  priorSettingsSha: string | null;
  selectedRuntimes: string[];
  selectedLayers: string[];
  apply: boolean;
  removing: boolean;
  uninstalling: boolean;
  updating: boolean;
  status: boolean;
  strict: boolean;
  check: boolean;
  initSettings: boolean;
  requestedRuntimes: string[];
  requestedLayers: string[];
  sourceSpecs: string[];
  layerSourceSpecs: string[];
  t3Settings: string | null;
  copilotCommand: string;
  piCommand: string;
  piVersion: string;
  layersFile: string | null;
  applyOwnershipReport?: (args: {
    recorded: OwnedRecord[];
    plan: OwnedRecord[];
    selectedRuntimes: string[];
    notSelected: string[];
    skippedLayers?: string[];
  }) => Array<{ state: string; label: string }>;
}

export const S: InstallerState = {
  workspace: '',
  repoRoot: '',
  platform: undefined,
  claudeCacheTarget: '',
  claudePluginsTarget: '',
  opencodePluginsTarget: '',
  agentsTarget: '',
  copilotBinTarget: '',
  configTarget: '',
  stackTarget: '',
  piAgentDir: '',
  piSettingsTarget: '',
  piLocalBinTarget: '',
  priorStack: null,
  priorOwned: null,
  priorLayers: new Map(),
  priorCreatedDirs: [],
  priorCreatedFiles: [],
  priorLegacy: false,
  priorSettingsSha: null,
  selectedRuntimes: [],
  selectedLayers: [],
  apply: false,
  removing: false,
  uninstalling: false,
  updating: false,
  status: false,
  strict: false,
  check: false,
  initSettings: false,
  requestedRuntimes: [],
  requestedLayers: [],
  sourceSpecs: [],
  layerSourceSpecs: [],
  t3Settings: null,
  copilotCommand: 'copilot',
  piCommand: 'pi',
  piVersion: '',
  layersFile: null,
};

/** Resets the shared state for a fresh run (tests and the CLI set it). */
export function resetState(): void {
  Object.assign(S, {
    workspace: '',
    repoRoot: '',
    platform: undefined,
    claudeCacheTarget: '',
    claudePluginsTarget: '',
    opencodePluginsTarget: '',
    agentsTarget: '',
    copilotBinTarget: '',
    configTarget: '',
    stackTarget: '',
    piAgentDir: '',
    piSettingsTarget: '',
    piLocalBinTarget: '',
    priorStack: null,
    priorOwned: null,
    priorLayers: new Map(),
    priorCreatedDirs: [],
    priorCreatedFiles: [],
    priorLegacy: false,
    priorSettingsSha: null,
    selectedRuntimes: [],
    selectedLayers: [],
    apply: false,
    removing: false,
    uninstalling: false,
    updating: false,
    status: false,
    strict: false,
    check: false,
    initSettings: false,
    requestedRuntimes: [],
    requestedLayers: [],
    sourceSpecs: [],
    layerSourceSpecs: [],
    t3Settings: null,
    copilotCommand: 'copilot',
    piCommand: 'pi',
    piVersion: '',
    layersFile: null,
    applyOwnershipReport: undefined,
  });
}
