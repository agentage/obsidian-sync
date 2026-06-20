// Desktop ~/.agentage/auth.json writer. Atomic (tmp+rename), mode 0600, NEVER vaults.json.
// Mirrors the CLI AuthState shape so CLI/daemon git-sync can share the file. Node-only:
// fs/os/path imported lazily inside the async methods (import-safe on mobile).
import type { TokenSet } from './oauth';
import type { AuthJsonWriter } from './token-store';

export interface AuthJsonState {
  siteFqdn: string; // e.g. agentage.io (prod) / localhost (dev)
  clientId: string;
  tokens: { accessToken: string; refreshToken?: string; expiresAt?: number };
  user?: { id: string; email: string };
}

const expandHome = (p: string, home: string): string =>
  p === '~' || p.startsWith('~/') ? home + p.slice(1) : p;

/** Read ~/.agentage/auth.json (the reliable desktop store, shared with the CLI). Null if
 * absent/unparseable/tokenless. Node-only; lazy imports keep it import-safe on mobile. */
export async function readAuthJsonState(configDirSetting: string): Promise<AuthJsonState | null> {
  try {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const envDir = typeof process !== 'undefined' ? process.env?.AGENTAGE_CONFIG_DIR : undefined;
    const dir = expandHome(envDir || configDirSetting || '~/.agentage', os.homedir());
    const raw = await fs.readFile(path.join(dir, 'auth.json'), 'utf8');
    const state = JSON.parse(raw) as AuthJsonState;
    return state?.tokens?.accessToken ? state : null;
  } catch {
    return null;
  }
}

async function writeAtomic(configDirSetting: string, name: string, json: string): Promise<string> {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const envDir = typeof process !== 'undefined' ? process.env?.AGENTAGE_CONFIG_DIR : undefined;
  const dir = expandHome(envDir || configDirSetting || '~/.agentage', os.homedir());
  const file = path.join(dir, name);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, json, { mode: 0o600 });
  await fs.rename(tmp, file);
  try {
    await fs.chmod(file, 0o600);
  } catch {
    /* best-effort on non-posix */
  }
  return file;
}

/** configDirSetting defaults to '~/.agentage' (AGENTAGE_CONFIG_DIR wins, matching memory-core). */
export function createAuthJsonWriter(opts: {
  configDirSetting: string;
  siteFqdn: string;
}): AuthJsonWriter {
  return {
    async write({ clientId, tokens }: { clientId: string; tokens: TokenSet }) {
      const state: AuthJsonState = {
        siteFqdn: opts.siteFqdn,
        clientId,
        tokens: {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt,
        },
      };
      await writeAtomic(opts.configDirSetting, 'auth.json', JSON.stringify(state, null, 2) + '\n');
    },
    async clear() {
      try {
        await writeAtomic(
          opts.configDirSetting,
          'auth.json',
          JSON.stringify({ siteFqdn: opts.siteFqdn }, null, 2) + '\n'
        );
      } catch {
        /* file may not exist */
      }
    },
  };
}
