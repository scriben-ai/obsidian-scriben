/**
 * The Scriben side of the plugin.
 *
 * Everything goes through an injected `http` so the whole client is testable
 * without a network: in Obsidian that is `requestUrl` (which sidesteps CORS —
 * plain fetch from a plugin is blocked against most origins), and in tests it
 * is a function that returns canned responses.
 */
export const DEFAULT_HOST = 'https://app.scriben.ai';

export class ScribenApi {
  /** @param {{ http: Function, host?: string, token?: string }} opts */
  constructor({ http, host = DEFAULT_HOST, token = '' }) {
    this.http = http; this.host = host.replace(/\/+$/, ''); this.token = token;
  }

  async #json(path, { method = 'GET', body = null, auth = true } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (auth && this.token) headers.authorization = `Bearer ${this.token}`;
    const res = await this.http({
      url: this.host + path, method, headers,
      body: body == null ? undefined : JSON.stringify(body),
      throw: false,
    });
    const status = res?.status ?? 0;
    let data = res?.json;
    if (data === undefined) { try { data = JSON.parse(res?.text ?? ''); } catch { data = null; } }
    return { status, data };
  }

  /** Step 1 of pairing: ask for a code the human will retype in the browser. */
  startPairing(deviceLabel) {
    return this.#json('/api/mcp/connect/init', {
      method: 'POST', auth: false,
      body: { clientLabel: 'Obsidian', deviceLabel: deviceLabel || 'Obsidian vault' },
    });
  }

  /** Step 2: poll. 428 means "the human has not approved yet" and is not an error. */
  claimToken(requestId) {
    return this.#json('/api/mcp/connect/token', {
      method: 'POST', auth: false, body: { request_id: requestId },
    });
  }

  approvalUrl(userCode) {
    return `${this.host}/mcp/connect?code=${encodeURIComponent(userCode)}`;
  }

  whoami() { return this.#json('/api/mcp/whoami'); }

  /**
   * Tools are called by name through the one endpoint. Adding a capability
   * later is a new name, not a new client method — the same reason the agent
   * side is a registry rather than a switch.
   */
  tool(name, args = {}) {
    return this.#json(`/api/mcp/tools/${encodeURIComponent(name)}`, { method: 'POST', body: args });
  }

  listNotes(limit = 50) { return this.tool('list_notes', { limit }); }
  summary(ref) { return this.tool('get_summary', { ref }); }
  actionItems(ref) { return this.tool('get_action_items', { ref }); }
  /** What Scriben knows that is relevant to this meeting, for the memory block. */
  recall(query) { return this.tool('recall_memory', { query: String(query || ''), limit: 6 }); }

  /** The read direction. Absent on an older server, which the caller must handle. */
  pushVaultNotes(notes) {
    return this.#json('/api/mcp/vault/ingest', { method: 'POST', body: { notes } });
  }
}

/** `data` is the envelope every tool answers with; unwrap it in exactly one place. */
export const unwrap = (r) => (r?.status === 200 ? (r.data?.data ?? null) : null);
