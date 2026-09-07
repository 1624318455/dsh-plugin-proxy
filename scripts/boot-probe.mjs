/**
 * Real-runtime hot-switch probe. Boots an actual DSH plugin tree (dsh-base
 * + @tr1v3r/dsh-proxy) from a throwaway DSH_HOME, then flips the
 * `dsh-proxy:` settings section in settings.yaml and verifies that the
 * global dispatcher, child-process env, and live fetch routing follow along
 * without a restart.
 *
 * Usage: node scripts/boot-probe.mjs
 * Requires the global `@deepseek-ai/dsh` installation (fnm node dir).
 */

import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { getGlobalDispatcher } from 'undici';

const DSH_ROOT = '/Users/bytedance/.local/share/fnm/node-versions/v24.20.0/installation/lib/node_modules/@deepseek-ai/dsh';
const APP_BOOT = `${DSH_ROOT}/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js`;
const LAUNCH_ENV = `${DSH_ROOT}/node_modules/@deepseek-ai/dsh-launch-environment/lib/index.js`;
const CMDLINE = `${DSH_ROOT}/node_modules/@deepseek-ai/dsh-cmdline/lib/index.js`;
const PLUGIN_DIR = new URL('..', import.meta.url).pathname;

const HOME = '/tmp/dsh-proxy-boot/home';
const PROFILE = 'proxyprobe';

/* ------------------------------------------------- local origin + proxy */

const originHits = [];
const proxyHits = [];

const origin = createServer((req, res) => {
	originHits.push(req.url);
	res.writeHead(200, { 'content-type': 'text/plain' });
	res.end('origin-ok');
});
const proxy = createServer((req, res) => {
	proxyHits.push(req.url);
	res.writeHead(200, { 'x-via': 'probe-proxy' });
	res.end('proxy-ok');
});

await new Promise((r) => origin.listen(0, '127.0.0.1', r));
await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
const originUrl = `http://127.0.0.1:${origin.address().port}/probe`;
const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;

/* ------------------------------------------------------ throwaway home */

rmSync(HOME, { recursive: true, force: true });
const profileDir = join(HOME, 'profiles', PROFILE);
mkdirSync(profileDir, { recursive: true });

writeFileSync(join(HOME, 'settings.yaml'), [
	'dsh-proxy:',
	'  enabled: true',
	`  proxy: ${proxyUrl}`,
	'  noProxy:',
	'    - example.invalid',
	''
].join('\n'));

writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
	name: PROFILE,
	private: true,
	dsh: {
		profile: {
			bundles: ['@deepseek-ai/dsh-base', '@tr1v3r/dsh-proxy'],
			patchReload: 'startup'
		}
	}
}, null, '\t'));

writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n');

// Minimal node_modules: the plugin package plus its runtime deps.
mkdirSync(join(profileDir, 'node_modules', '@tr1v3r'), { recursive: true });
cpSync(PLUGIN_DIR, join(profileDir, 'node_modules', '@tr1v3r', 'dsh-proxy'), {
	recursive: true,
	filter: (src) => !src.includes(`${PLUGIN_DIR}/.git`) && !src.includes('node_modules')
});
// undici must come from the plugin's own installed copy for resolution.
cpSync(
	join(PLUGIN_DIR, 'node_modules', 'undici'),
	join(profileDir, 'node_modules', 'undici'),
	{ recursive: true }
);
cpSync(
	join(PLUGIN_DIR, 'node_modules', '@deepseek-ai'),
	join(profileDir, 'node_modules', '@deepseek-ai'),
	{ recursive: true }
);

/* --------------------------------------------------------------- boot */

process.env.DSH_HOME = HOME;
process.env.DEEPSEEK_API_KEY ??= 'probe-unused';

const { boot, loadProfile, composeEntries, loadLayeredEnv, healProfilesModuleFallback } = await import(APP_BOOT);
const { DSH_LAUNCH_ENVIRONMENT_KEY } = await import(LAUNCH_ENV);
const { provideCmdline } = await import(CMDLINE);

const installAnchor = `${DSH_ROOT}/package.json`;
const profile = loadProfile('dsh', PROFILE, installAnchor, HOME);
await healProfilesModuleFallback({ installAnchor, profile });
writeFileSync(join(profile.dir, 'cordis.yml'), [
	'# dsh profile root — an empty entry list. The tree is composed as patches:',
	'# each bundle in package.json\'s dsh.profile.bundles, then cordis.patch.yml, then any',
	'# --patch overlays. Edit cordis.patch.yml, not this file.',
	'[]',
	''
].join('\n'));
const bundlePatches = profile.layers.flatMap((layer) => layer.patches);
const patchLayers = [bundlePatches, profile.patches];
console.log('composed entries:', composeEntries(structuredClone(patchLayers)).map((entry) => entry.id ?? `+${entry.name}`).join(', '));

const baseline = getGlobalDispatcher();
const ctx = await boot('dsh', join(profile.dir, 'cordis.yml'), structuredClone(patchLayers.flat()), (hostCtx) => {
	hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, loadLayeredEnv('dsh'));
	provideCmdline(hostCtx, {
		args: [],
		exit: () => {},
		ready: { service: () => {} }
	});
});

/* ------------------------------------------------------------ verify */

const dispatcherName = () => getGlobalDispatcher().constructor.name;
const isOurs = () => {
	const dispatcher = getGlobalDispatcher();
	return dispatcher.constructor.kind === 'dsh-proxy' || dispatcher.constructor.name === 'EnvHttpProxyAgent' || dispatcher.constructor.name === 'Socks5ProxyAgent';
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(description, predicate, timeoutMs = 15000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await sleep(200);
	}
	throw new Error(`probe: timed out waiting for ${description} (dispatcher=${dispatcherName()})`);
}

function check(label, condition, detail) {
	if (!condition) throw new Error(`probe: FAIL ${label}${detail ? ` — ${detail}` : ''}`);
	console.log(`probe: ok ${label}`);
}

try {
	// --- diagnostics: is the section registered and resolved?
	const described = ctx.get('settings')?.describe?.() ?? [];
	console.log('probe: settings namespaces:', described.map((row) => `${row.ns}=${JSON.stringify(row.value)}`).join(' | ') || '(none)');
	const allEntries = [...ctx.loader.entries()];
	const includeEntry = allEntries[0];
	console.log('probe: loader entries:', allEntries.length, allEntries.slice(-5).map((row) => JSON.stringify({ id: row.options?.id, name: row.options?.name })));
	console.log('probe: include subtree store:', Object.keys(includeEntry?.subtree?.store ?? {}));
	console.log('probe: include fiber state:', includeEntry?.fiber?.state, 'subtree entries:', [...(includeEntry?.subtree?.entries() ?? [])].map((row) => row.options?.id));
	console.log('probe: services with settings:', Object.keys(ctx.get('settings') ?? {}).slice(0, 5));

	await waitFor('proxy dispatcher installed', isOurs);
	check('dispatcher switched to a dsh-proxy dispatcher at boot', isOurs(), dispatcherName());

	check('child env exported', process.env.HTTP_PROXY === proxyUrl && process.env.NO_PROXY === 'example.invalid');

	const body = await (await fetch(originUrl)).text();
	check('fetch routed through settings proxy', body === 'proxy-ok' && proxyHits.length === 1);

	// ---- hot switch off
	writeFileSync(join(HOME, 'settings.yaml'), 'dsh-proxy:\n  enabled: false\n');
	await waitFor('dispatcher restored', () => getGlobalDispatcher() === baseline);
	const direct = await (await fetch(originUrl)).text();
	check('hot-off: fetch direct', direct === 'origin-ok' && originHits.length === 1 && proxyHits.length === 1);
	check('hot-off: env cleared', process.env.HTTP_PROXY === undefined);

	// ---- hot switch on again (proxy port unchanged)
	writeFileSync(join(HOME, 'settings.yaml'), `dsh-proxy:\n  enabled: true\n  proxy: ${proxyUrl}\n`);
	await waitFor('dispatcher re-installed', isOurs);
	const again = await (await fetch(originUrl)).text();
	check('hot-on: fetch via proxy again', again === 'proxy-ok' && proxyHits.length === 2);

	// ---- settings describe sees the section
	const describeAgain = ctx.get('settings')?.describe?.() ?? [];
	const section = describeAgain.find((row) => row.ns === 'dsh-proxy');
	check('settings describe exposes dsh-proxy', Boolean(section), JSON.stringify(section?.value));

	console.log('probe: ALL PASS — runtime switching verified inside a real DSH boot');
} finally {
	await ctx.fiber.dispose();
	origin.close();
	proxy.close();
}
