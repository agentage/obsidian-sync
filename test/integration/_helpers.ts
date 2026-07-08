import { bootPlugin, signIn, type BootOptions, type Handles } from '../fakes/boot';
import { encodeFile, type LeafDoc } from '../../src/couch/couch-doc';

// Shared scenario setup for the assembled-plugin integration tests. Boots the plugin against
// the fakes, signs in, and selects the couch-channel memory so a test starts at "ready to sync".
// Deterministic: no timers/network beyond the fakes; ticks are driven explicitly, never by sleep.

export const MEMORY = 'work';
export const DB = 'mem_work';

/** Boot + advertise one couch-channel memory named MEMORY (the wedge single-memory flow). */
export async function bootReady(opts: BootOptions = {}): Promise<Handles> {
  return bootPlugin({
    memoryName: MEMORY,
    couchDb: DB,
    memories: [{ name: MEMORY, entries: 0, folderCount: 0, updated: null }],
    ...opts,
  });
}

/** Boot -> sign in -> select MEMORY. Returns a plugin sitting at "ready", first sync not yet run. */
export async function bootSignedIn(opts: BootOptions = {}): Promise<Handles> {
  const h = await bootReady(opts);
  await signIn(h);
  await h.plugin.selectVault(MEMORY);
  return h;
}

/** The content-addressed leaf docs the fake couch wants for injectRemoteChange (mirror encodeFile). */
export async function leavesFor(body: string): Promise<LeafDoc[]> {
  return (await encodeFile('x', body)).leaves;
}

/** Seed a remote-origin note (as another device would) so a pull delivers it. */
export async function seedRemote(h: Handles, path: string, body: string): Promise<void> {
  h.couch.injectRemoteChange(path, body, await leavesFor(body));
}

// The live couch controller + its 2s tick are reachable only through the plugin's private
// couchChannel; a test drives sync via the public syncNow()/tick surface below.
interface CouchChannelLike {
  tick(): Promise<void>;
  pendingCount(): number;
}
interface WithCouchChannel {
  couchChannel: CouchChannelLike;
}

/** Drive one explicit couch tick (flush queued pushes/deletes, then pull). No wall-clock wait. */
export async function tick(h: Handles): Promise<void> {
  await (h.plugin as unknown as WithCouchChannel).couchChannel.tick();
}

/** Queued outgoing changes (failed live pushes + deletes) the next tick will retry. */
export function pendingCount(h: Handles): number {
  return (h.plugin as unknown as WithCouchChannel).couchChannel.pendingCount();
}

/** True while a live couch controller is attached (a sign-out / non-couch route tears it down). */
export function couchActive(h: Handles): boolean {
  return (h.plugin as unknown as { couchChannel: { active: boolean } }).couchChannel.active;
}

// The private status field that drives the dot tone (idle/syncing -> green, error/conflict ->
// red). The dot itself is a headless chainable no-op, so a test reads the state that computes it.
export function syncStateOf(h: Handles): string {
  return (h.plugin as unknown as { syncState: string }).syncState;
}

/** Run `turns` macrotask ticks unconditionally, letting a fire-and-forget handler run to
 * completion even when its outcome is "no state change" (e.g. a delete the plugin abandons). */
export async function drain(turns = 12): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Fire a vault event through the plugin's live handlers AND mutate the in-memory vault. Note
 * the vault mutation is synchronous but the plugin's push/delete handler is async - await
 * settle()/drain() before asserting on couch state. */
export function edit(h: Handles, path: string, content: string): void {
  const create = h.vault.getAbstractFileByPath(path) === null;
  h.vault.trigger(create ? 'create' : 'modify', path, content);
}
export function del(h: Handles, path: string): void {
  h.vault.trigger('delete', path);
}

/** Drain the microtask queue until `done()` holds so the plugin's fire-and-forget void handlers
 * (pushFileLive/removeFile, each a bounded async chain: Web-Crypto digest -> getDoc -> _bulk_docs
 * -> PUT/DELETE against the fakes) settle. Deterministic: the fakes never touch a real timer or
 * socket, so the chain converges on microtasks alone - no sleep, no wall clock. Throws if it
 * has not converged after `max` turns, surfacing a genuinely stuck handler instead of hanging. */
export async function settle(done: () => boolean = () => true, max = 200): Promise<void> {
  // Yield to the macrotask queue too: Web-Crypto digest resolves off the microtask queue, so a
  // pure Promise.resolve() drain would spin without ever running the push's hashing step. A 0ms
  // timer fires on the next loop tick with no wall-clock wait, keeping the test deterministic.
  for (let i = 0; i < max; i++) {
    if (done()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  if (!done()) throw new Error('settle: handlers did not converge');
}

// The plugin's in-memory secret mirror (main.ts secretCache) is where the live access-token
// expiry lives; rewinding it is the deterministic stand-in for "the OAuth access token expired
// mid-session" without an injectable clock, forcing getValidToken down its refresh branch.
const EXPIRES_AT_SECRET = 'agentage-memory-token-expires-at';
interface WithSecretCache {
  secretCache: Map<string, string>;
}
export function expireAccessToken(h: Handles): void {
  (h.plugin as unknown as WithSecretCache).secretCache.set(EXPIRES_AT_SECRET, '1');
}

export { bootPlugin, signIn, type Handles };
