/**
 * @tr1v3r/dsh-proxy — runtime-switchable outbound proxy for the DeepSeek Harness.
 *
 * One settings section (`dsh-proxy`) hot-reloaded from $DSH_HOME/settings.yaml
 * routes every in-process `globalThis.fetch` request through an HTTP(S)
 * CONNECT proxy or a SOCKS5 proxy — and flips back to direct — without
 * restarting dsh. Child processes spawned after a switch (bash tool curl/git,
 * MCP stdio servers) follow along through exported HTTP(S)_PROXY/NO_PROXY
 * variables.
 *
 * Mechanics: DSH and pi-ai issue LLM/web requests via `globalThis.fetch`,
 * which reads the well-known global dispatcher slot
 * (`Symbol.for('undici.globalDispatcher.1')`). Swapping that dispatcher
 * redirects all undici-based outbound traffic in the process.
 */

import { Agent, Dispatcher, EnvHttpProxyAgent, Socks5ProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import z from '@deepseek-ai/schemastery';

/** Cordis plugin tree id (independent of the npm package name). */
export const name = 'dsh-proxy';
/** No hard service dependencies; settings is injected opportunistically. */
export const inject = [];

/** Settings namespace consumed from $DSH_HOME/settings.yaml. */
export const PROXY_SETTINGS_NAMESPACE = 'dsh-proxy';

/** Schema of the `dsh-proxy` settings section and of the entry config. */
export const Config = z.object({
	/** Master switch. `false` routes direct (default). */
	enabled: z.boolean().default(false),
	/** Proxy URL: http(s)://host:port or socks5://[user:pass@]host:port. */
	proxy: z.string(),
	/** Hosts that bypass the proxy (curl-style: host, .suffix, host:port, *). */
	noProxy: z.array(z.string()),
	/** Also export HTTP(S)_PROXY/NO_PROXY env to child processes. */
	exportEnv: z.boolean().default(true)
});

const PROXY_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
	'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'];

/** Grace period before force-destroying a retired dispatcher's sockets. */
const RETIRE_DESTROY_MS = 30_000;

/**
 * Whether a request to `hostname`:`port` matches a noProxy rule list.
 * Semantics mirror undici's EnvHttpProxyAgent (bare entries match the host
 * and its dot-boundary subdomains; `host:port` pins the port; `*` matches
 * everything) plus two curl-style extensions: a leading dot or `*.` prefix
 * marks a pure suffix rule (`*.internal.example`).
 * @param hostname - lowercase request host (FQDN or IP literal).
 * @param port - request port as string, or null when unknown.
 * @param rules - raw noProxy entries (whitespace tolerated).
 * @returns true when the request must bypass the proxy.
 */
export function matchesNoProxy(hostname, port, rules) {
	const host = String(hostname ?? '').toLowerCase();
	if (!host || !rules?.length) return false;
	const portNumber = port == null ? null : Number(port);
	for (const rawRule of rules) {
		const rule = String(rawRule ?? '').trim().toLowerCase();
		if (!rule) continue;
		if (rule === '*') return true;
		let candidate = rule;
		let rulePort = null;
		const colon = rule.lastIndexOf(':');
		if (colon !== -1 && rule.indexOf(':') === colon) {
			candidate = rule.slice(0, colon);
			rulePort = rule.slice(colon + 1);
		}
		if (candidate.startsWith('[') && candidate.endsWith(']')) candidate = candidate.slice(1, -1);
		if (candidate.startsWith('.')) candidate = candidate.slice(1);
		if (candidate.startsWith('*.')) candidate = candidate.slice(2);
		if (!candidate) continue;
		if (rulePort !== null && Number(rulePort) !== portNumber) continue;
		if (host === candidate || host.endsWith('.' + candidate)) return true;
	}
	return false;
}

/** Split a request origin (string or URL) into hostname/port. */
function originParts(origin) {
	try {
		const url = typeof origin === 'string' ? new URL(origin) : origin;
		if (!url?.hostname) return null;
		return { hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? '443' : '80') };
	} catch {
		return null;
	}
}

/** Normalize a proxy URL for undici: accept socks5h:// as socks5://. */
function normalizeProxyUrl(raw) {
	const url = new URL(raw);
	const protocol = url.protocol.replace(/:$/, '').toLowerCase();
	if (protocol === 'socks5h' || protocol === 'socks') url.protocol = 'socks5:';
	else if (protocol !== 'http' && protocol !== 'https' && protocol !== 'socks5') {
		throw new Error(`unsupported proxy protocol "${protocol}" (use http/https/socks5/socks5h)`);
	}
	return { url: url.href, protocol: url.protocol.replace(/:$/, '').toLowerCase() };
}

/**
 * Dispatcher that sends matching origins direct and everything else through
 * a proxy dispatcher (needed for SOCKS, where undici has no built-in noProxy).
 */
class RoutingDispatcher extends Dispatcher {
	/** Marker so hosts/probes can recognize dsh-proxy dispatchers. */
	static kind = 'dsh-proxy';

	#direct;
	#proxied;
	#rules;

	constructor(direct, proxied, rules) {
		super();
		this.#direct = direct;
		this.#proxied = proxied;
		this.#rules = rules;
	}

	dispatch(options, handler) {
		const parts = originParts(options?.origin);
		const bypass = parts !== null && matchesNoProxy(parts.hostname, parts.port, this.#rules);
		return (bypass ? this.#direct : this.#proxied).dispatch(options, handler);
	}

	close() {
		return Promise.allSettled([this.#direct.close(), this.#proxied.close()]).then(() => {});
	}

	destroy() {
		return Promise.allSettled([this.#direct.destroy(), this.#proxied.destroy()]).then(() => {});
	}
}

/**
 * Build the undici dispatcher for a resolved configuration. With noProxy
 * rules present, every protocol routes through {@link RoutingDispatcher} so
 * HTTP and SOCKS share the exact same matcher semantics.
 * @param config - resolved section: { enabled, proxy, noProxy, exportEnv }.
 * @returns an undici Dispatcher installing the described routing.
 * @throws when the proxy URL is unparseable or its protocol unsupported.
 */
export function buildDispatcher(config) {
	const { url, protocol } = normalizeProxyUrl(config.proxy);
	let proxied;
	if (protocol === 'http' || protocol === 'https') {
		// noProxy deliberately NOT passed on: RoutingDispatcher owns routing so
		// HTTP and SOCKS paths apply identical matcher semantics.
		proxied = new EnvHttpProxyAgent({ httpProxy: url, httpsProxy: url });
	} else {
		proxied = new Socks5ProxyAgent(url);
	}
	if (!config.noProxy?.length) return proxied;
	return new RoutingDispatcher(new Agent(), proxied, config.noProxy);
}

/** Snapshot of env keys this engine overwrote (value = previous or null). */
function snapshotEnv() {
	const snapshot = {};
	for (const key of PROXY_ENV_KEYS) snapshot[key] = key in process.env ? process.env[key] : null;
	return snapshot;
}

/** Restore the env snapshot taken before the first export. */
function restoreEnv(snapshot) {
	if (!snapshot) return;
	for (const [key, prior] of Object.entries(snapshot)) {
		if (prior === null) delete process.env[key];
		else process.env[key] = prior;
	}
}

/** Export proxy env vars for child processes, keeping a restore snapshot. */
function exportEnv(config, snapshot) {
	const next = snapshot ?? snapshotEnv();
	const noProxy = config.noProxy?.length ? config.noProxy.join(',') : undefined;
	for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
		// Never clobber variables the operator set intentionally at boot.
		if (next[key] === null) process.env[key] = config.proxy;
	}
	if (noProxy) {
		for (const key of ['NO_PROXY', 'no_proxy']) if (next[key] === null) process.env[key] = noProxy;
	}
	return next;
}

/** Gracefully retire a replaced dispatcher, then force-close leftovers. */
function retire(dispatcher) {
	Promise.resolve(dispatcher.close?.()).catch(() => {});
	const timer = setTimeout(() => {
		Promise.resolve(dispatcher.destroy?.()).catch(() => {});
	}, RETIRE_DESTROY_MS);
	timer.unref?.();
}

/**
 * Create the switch engine: applies resolved sections onto the global
 * dispatcher + env, restoring the pre-plugin state on disable/dispose.
 * @param logger - cordis logger (or null in tests).
 * @returns engine with `apply(config)` and `restore()`.
 */
export function createEngine(logger) {
	let baseline;
	let installed = null;
	let envSnapshot = null;
	let current = null;

	function log(level, message) {
		logger?.[level]?.(message);
	}

	function apply(config) {
		current = config ?? {};
		if (baseline === undefined) baseline = getGlobalDispatcher();
		if (installed) {
			const retired = installed;
			installed = null;
			setGlobalDispatcher(baseline);
			retire(retired);
		}
		if (!current.enabled || !current.proxy) {
			if (envSnapshot) {
				restoreEnv(envSnapshot);
				envSnapshot = null;
			}
			if (current.enabled) log('error', 'dsh-proxy: enabled without a proxy URL — staying direct');
			else log('info', 'dsh-proxy: direct (proxy off)');
			return;
		}
		let dispatcher;
		try {
			dispatcher = buildDispatcher(current);
		} catch (error) {
			if (envSnapshot) {
				restoreEnv(envSnapshot);
				envSnapshot = null;
			}
			log('error', `dsh-proxy: invalid configuration, staying direct — ${error.message}`);
			return;
		}
		installed = dispatcher;
		setGlobalDispatcher(dispatcher);
		if (current.exportEnv !== false) envSnapshot = exportEnv(current, envSnapshot);
		const rules = current.noProxy?.length ? `, noProxy ${current.noProxy.length} rule(s)` : '';
		log('info', `dsh-proxy: routing global fetch via ${redact(current.proxy)}${rules}`);
	}

	function restore() {
		if (baseline !== undefined && installed) {
			setGlobalDispatcher(baseline);
			retire(installed);
			installed = null;
		}
		if (envSnapshot) {
			restoreEnv(envSnapshot);
			envSnapshot = null;
		}
	}

	return { apply, restore };
}

/** Mask userinfo in a proxy URL before logging it. */
function redact(proxyUrl) {
	try {
		const url = new URL(proxyUrl);
		if (url.username || url.password) return `${url.protocol}//***@${url.host}`;
		return url.href;
	} catch {
		return '<invalid url>';
	}
}

/**
 * Cordis entry. The composition entry config provides defaults; once the
 * settings provider mounts, the `dsh-proxy` settings section overlays it and
 * every settings.yaml edit re-runs `onChange` — no restart required.
 * @param ctx - cordis context.
 * @param config - entry config resolved through {@link Config}.
 */
export function apply(ctx, config = {}) {
	const engine = createEngine(ctx?.logger);
	const entry = Config(config);
	let read = () => entry;

	// Entry-level default (proxy off) keeps the host usable without settings.
	engine.apply(entry);

	ctx.inject?.(['settings'], (settingsCtx) => {
		settingsCtx.settings.installSection(ctx, PROXY_SETTINGS_NAMESPACE, Config, entry, {
			setSource: (get) => {
				read = get;
			},
			onChange: () => engine.apply(read())
		});
	});

	ctx.on?.('dispose', () => engine.restore());
}
