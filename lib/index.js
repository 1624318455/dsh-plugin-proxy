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

/** Env keys that carry the proxy URL itself (exported to child processes). */
export const PROXY_ONLY_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];
/** Env keys that carry the bypass list. */
export const NO_PROXY_ENV_KEYS = ['NO_PROXY', 'no_proxy'];
/** Every env key this plugin may read or write (snapshot + restore surface). */
export const PROXY_ENV_KEYS = [...PROXY_ONLY_ENV_KEYS, ...NO_PROXY_ENV_KEYS];

/** Grace period before force-destroying a retired dispatcher's sockets. */
const RETIRE_DESTROY_MS = 30_000;

/** Canonical proxy protocol → dispatcher factory. */
const PROXY_AGENT_FACTORIES = {
	// `noProxy` frozen to '': undici's EnvHttpProxyAgent re-reads the live
	// NO_PROXY/no_proxy env on every parse and would silently re-apply an
	// operator or exported bypass list on the HTTP leg only, diverging from
	// the SOCKS leg. RoutingDispatcher owns all noProxy routing instead.
	http: (url) => new EnvHttpProxyAgent({ httpProxy: url, httpsProxy: url, noProxy: '' }),
	https: (url) => new EnvHttpProxyAgent({ httpProxy: url, httpsProxy: url, noProxy: '' }),
	socks5: (url) => new Socks5ProxyAgent(url)
};

/** URL scheme aliases folded onto a canonical protocol. */
const PROTOCOL_ALIASES = { socks5h: 'socks5', socks: 'socks5' };

/**
 * Whether a request to `hostname`:`port` matches a noProxy rule list.
 * Semantics mirror undici's EnvHttpProxyAgent (bare entries match the host
 * and its dot-boundary subdomains; `host:port` pins the port; `*` matches
 * everything). A leading dot or `*.` prefix is accepted as a synonym of the
 * bare entry (`.internal.example` ≡ `internal.example`).
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

/**
 * @typedef {Object} OriginParts
 * @property {string} hostname - request host (lowercase).
 * @property {string} port - effective port, defaulted from the scheme.
 */

/**
 * Split a request origin (string or URL) into hostname/port. IPv6 literals
 * lose their brackets so matcher rules written either way ([::1] or ::1)
 * compare against the same host.
 * @returns {OriginParts | null} null when the origin is unusable.
 */
function originParts(origin) {
	try {
		const url = typeof origin === 'string' ? new URL(origin) : origin;
		if (!url?.hostname) return null;
		const hostname = url.hostname.replace(/^\[(.+)\]$/, '$1').toLowerCase();
		return { hostname, port: url.port || (url.protocol === 'https:' ? '443' : '80') };
	} catch {
		return null;
	}
}

/**
 * @typedef {Object} NormalizedProxy
 * @property {string} url - normalized proxy URL.
 * @property {string} protocol - canonical protocol (http|https|socks5).
 */

/** Normalize a proxy URL for undici: fold aliases onto canonical protocols. @returns {NormalizedProxy} */
function normalizeProxyUrl(raw) {
	const url = new URL(raw);
	const rawProtocol = url.protocol.replace(/:$/, '').toLowerCase();
	const protocol = PROTOCOL_ALIASES[rawProtocol] ?? rawProtocol;
	if (!Object.hasOwn(PROXY_AGENT_FACTORIES, protocol)) {
		throw new Error(`unsupported proxy protocol "${protocol}" (use http/https/socks5/socks5h)`);
	}
	url.protocol = `${protocol}:`;
	return { url: url.href, protocol };
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

	/** Fan a lifecycle call out to both inner dispatchers. */
	#fan(method) {
		return Promise.allSettled([this.#direct[method](), this.#proxied[method]()]).then(() => {});
	}

	close() {
		return this.#fan('close');
	}

	destroy() {
		return this.#fan('destroy');
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
	// noProxy deliberately NOT passed on: RoutingDispatcher owns routing so
	// HTTP and SOCKS paths apply identical matcher semantics.
	const proxied = PROXY_AGENT_FACTORIES[protocol](url);
	if (!config.noProxy?.length) return proxied;
	return new RoutingDispatcher(new Agent(), proxied, config.noProxy);
}

/** Snapshot of env keys this engine may overwrite (value = previous or null). */
function snapshotEnv() {
	const snapshot = {};
	for (const key of PROXY_ENV_KEYS) snapshot[key] = key in process.env ? process.env[key] : null;
	return snapshot;
}

/** Restore the env snapshot taken before the first export. */
function restoreEnv(snapshot) {
	for (const [key, prior] of Object.entries(snapshot)) {
		if (prior === null) delete process.env[key];
		else process.env[key] = prior;
	}
}

/**
 * Create the export/restore side of the engine's env management.
 * Owns the snapshot and the record of values this engine itself wrote, so
 * operator values that appear mid-session are adopted into the snapshot
 * (preserved and restored) instead of being clobbered by the next hot switch.
 * @returns {object} with `export(config)` and `restore()`.
 */
function createEnvManager() {
	let snapshot = null;
	let exported = {};

	/** Drop everything this engine exported, restoring adopted values. */
	function restore() {
		if (!snapshot) return;
		restoreEnv(snapshot);
		snapshot = null;
		exported = {};
	}

	/**
	 * Export proxy env vars for child processes (never clobbering operator
	 * values) or, when the active config stops asking for export, restore.
	 * @param config - resolved section that is now active.
	 */
	function sync(config) {
		if (config.enabled !== true || !config.proxy || config.exportEnv === false) {
			restore();
			return;
		}
		const next = snapshot ?? snapshotEnv();
		const noProxy = config.noProxy?.length ? config.noProxy.join(',') : undefined;
		for (const key of PROXY_ONLY_ENV_KEYS) {
			adoptOperatorValue(next, key);
			if (next[key] === null) {
				process.env[key] = config.proxy;
				exported[key] = config.proxy;
			}
		}
		for (const key of NO_PROXY_ENV_KEYS) {
			adoptOperatorValue(next, key);
			if (next[key] !== null) continue;
			if (noProxy) {
				process.env[key] = noProxy;
				exported[key] = noProxy;
			} else {
				delete process.env[key]; // clear a previously exported bypass list
				delete exported[key];
			}
		}
		snapshot = next;
	}

	/** Preserve a value the operator set mid-session instead of clobbering it. */
	function adoptOperatorValue(next, key) {
		const live = process.env[key];
		if (next[key] === null && live !== undefined && live !== exported[key]) next[key] = live;
	}

	return { sync, restore };
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
	const env = createEnvManager();

	function log(level, message) {
		logger?.[level]?.(message);
	}

	function apply(config) {
		const current = config ?? {};
		if (baseline === undefined) baseline = getGlobalDispatcher();
		if (installed) {
			const retired = installed;
			installed = null;
			setGlobalDispatcher(baseline);
			retire(retired);
		}
		if (!current.enabled || !current.proxy) {
			env.restore();
			if (current.enabled) log('error', 'dsh-proxy: enabled without a proxy URL — staying direct');
			else log('info', 'dsh-proxy: direct (proxy off)');
			return;
		}
		let dispatcher;
		try {
			dispatcher = buildDispatcher(current);
		} catch (error) {
			env.restore();
			log('error', `dsh-proxy: invalid configuration, staying direct — ${error.message}`);
			return;
		}
		installed = dispatcher;
		setGlobalDispatcher(dispatcher);
		env.sync(current);
		const rules = current.noProxy?.length ? `, noProxy ${current.noProxy.length} rule(s)` : '';
		log('info', `dsh-proxy: routing global fetch via ${redact(current.proxy)}${rules}`);
	}

	function restore() {
		if (baseline !== undefined && installed) {
			setGlobalDispatcher(baseline);
			retire(installed);
			installed = null;
		}
		env.restore();
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
	let getConfig = () => entry;

	// Entry-level default (proxy off) keeps the host usable without settings.
	engine.apply(entry);

	ctx.inject?.(['settings'], (settingsCtx) => {
		settingsCtx.settings.installSection(ctx, PROXY_SETTINGS_NAMESPACE, Config, entry, {
			setSource: (get) => {
				getConfig = get;
			},
			onChange: () => engine.apply(getConfig())
		});
	});

	ctx.on?.('dispose', () => engine.restore());
}
