import type { VaultEntryPreview, VaultsConfigPreview } from './settings';
import { VAULTS_SCHEMA_URL } from './settings';

// Reads/writes the real memory-core config at ~/.agentage/vaults.json (desktop only).
// The plugin owns exactly ONE entry (this Obsidian vault); every other vault in the
// file (CLI-managed) is preserved. Writes are atomic (tmp + rename).

export interface ApplyArgs {
  /** configDir setting, e.g. '~/.agentage' (AGENTAGE_CONFIG_DIR wins if set). */
  configDirSetting: string;
  name: string;
  previousName?: string;
  entry: VaultEntryPreview;
  makeDefault: boolean;
}

export interface ApplyResult {
  ok: boolean;
  path: string;
  error?: string;
}

const expandHome = (p: string, home: string): string => (p === '~' || p.startsWith('~/') ? home + p.slice(1) : p);

const envConfigDir = (): string | undefined =>
  typeof process !== 'undefined' ? process.env?.AGENTAGE_CONFIG_DIR : undefined;

export const resolveConfigFile = (configDirSetting: string, home: string, join: (...p: string[]) => string): string =>
  join(expandHome(envConfigDir() || configDirSetting || '~/.agentage', home), 'vaults.json');

/** Upsert this vault's entry into ~/.agentage/vaults.json, preserving other vaults. */
export const applyVaultsConfig = async (args: ApplyArgs): Promise<ApplyResult> => {
  const os = await import('node:os');
  const path = await import('node:path');
  const fs = await import('node:fs/promises');
  const file = resolveConfigFile(args.configDirSetting, os.homedir(), path.join);
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });

    let config: VaultsConfigPreview = { $schema: VAULTS_SCHEMA_URL, version: 1, vaults: {} };
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        const p = parsed as Partial<VaultsConfigPreview>;
        config = {
          $schema: p.$schema ?? VAULTS_SCHEMA_URL,
          version: 1,
          default: p.default,
          vaults: p.vaults && typeof p.vaults === 'object' ? p.vaults : {},
        };
      }
    } catch {
      // missing or invalid file -> start from a fresh, valid config
    }

    if (args.previousName && args.previousName !== args.name) delete config.vaults[args.previousName];
    config.vaults[args.name] = args.entry;
    if (args.makeDefault) config.default = args.name;
    else if (config.default === args.name) delete config.default;

    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(config, null, 2) + '\n', 'utf8');
    await fs.rename(tmp, file);
    return { ok: true, path: file };
  } catch (e) {
    return { ok: false, path: file, error: (e as Error).message };
  }
};
