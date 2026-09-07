import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { EnvHttpProxyAgent, Socks5ProxyAgent, getGlobalDispatcher } from 'undici';

import { matchesNoProxy, buildDispatcher, createEngine, PROXY_ENV_KEYS } from '../lib/index.js';

/* ---------------------------------------------------------------- helpers */

function listen(server) {
	return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function close(server) {
	return new Promise((resolve) => server.close(() => resolve()));
}

/** Remove proxy env keys for a test, restoring them in t.after. */
function isolateProxyEnv(t) {
	const saved = {};
	for (const key of PROXY_ENV_KEYS) {
		saved[key] = process.env[key];
		delete process.env[key];
	}
	t.after(() => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
}

/** Plain origin server that echoes how the request reached it. */
async function startOrigin() {
	const server = http.createServer((req, res) => {
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ via: 'origin', path: req.url }));
	});
	await listen(server);
	return { server, url: `http://127.0.0.1:${server.address().port}` };
}

/** Minimal forwarding HTTP proxy that records every absolute-form request. */
async function startHttpProxy() {
	const seen = [];
	const server = http.createServer((req, res) => {
		seen.push(req.url);
		try {
			const target = new URL(req.url);
			const upstream = http.request(
				{
					hostname: target.hostname,
					port: target.port,
					path: target.pathname + target.search,
					method: req.method,
					headers: req.headers
				},
				(up) => {
					res.writeHead(up.statusCode, up.headers);
					up.pipe(res);
				}
			);
			upstream.on('error', () => {
				res.writeHead(502);
				res.end('proxy-upstream-error');
			});
			req.pipe(upstream);
		} catch {
			res.writeHead(400);
			res.end('proxy-bad-target');
		}
	});
	await listen(server);
	return { server, seen, url: `http://127.0.0.1:${server.address().port}` };
}

/** Minimal no-auth SOCKS5 server that records CONNECT targets. */
async function startSocks5() {
	const connects = [];
	const server = net.createServer((socket) => {
		socket.on('error', () => socket.destroy());
		let phase = 0;
		socket.on('data', function onData(chunk) {
			if (phase === 0) {
				socket.write(Buffer.from([0x05, 0x00])); // no-auth accepted
				phase = 1;
				return;
			}
			socket.off('data', onData);
			const atyp = chunk[3];
			let host;
			let offset;
			if (atyp === 0x01) {
				host = `${chunk[4]}.${chunk[5]}.${chunk[6]}.${chunk[7]}`;
				offset = 8;
			} else if (atyp === 0x03) {
				const len = chunk[4];
				host = chunk.subarray(5, 5 + len).toString('utf8');
				offset = 5 + len;
			} else {
				host = '::1';
				offset = 20;
			}
			const port = chunk.readUInt16BE(offset);
			connects.push(`${host}:${port}`);
			const upstream = net.connect(port, host, () => {
				socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
				upstream.pipe(socket);
				socket.pipe(upstream);
			});
			upstream.on('error', () => socket.destroy());
			socket.on('error', () => upstream.destroy());
		});
	});
	await listen(server);
	return { server, connects, url: `socks5://127.0.0.1:${server.address().port}` };
}

/* ------------------------------------------------------------ unit: matcher */

test('matchesNoProxy mirrors undici semantics plus suffix extensions', () => {
	const rules = ['localhost', '.internal.example', 'pin.exact:8443', '*.wild.test'];
	// undici semantics: a bare entry matches the host AND dot-boundary subdomains
	assert.equal(matchesNoProxy('localhost', '8080', rules), true);
	assert.equal(matchesNoProxy('api.localhost', '8080', rules), true);
	// leading dot / *. prefixes are pure suffix rules
	assert.equal(matchesNoProxy('svc.internal.example', '443', rules), true);
	assert.equal(matchesNoProxy('internal.example', '443', rules), true);
	assert.equal(matchesNoProxy('xinternal.example', '443', rules), false);
	// host:port pins the port
	assert.equal(matchesNoProxy('pin.exact', '8443', rules), true);
	assert.equal(matchesNoProxy('pin.exact', '9999', rules), false);
	assert.equal(matchesNoProxy('a.wild.test', '80', rules), true);
	assert.equal(matchesNoProxy('wild.test', '80', rules), true);
	// '*' bypasses everything; nothing matches an empty rule list
	assert.equal(matchesNoProxy('anything.dev', '80', ['*']), true);
	assert.equal(matchesNoProxy('x.dev', '80', []), false);
	assert.equal(matchesNoProxy('', '80', ['*']), false);
	assert.equal(matchesNoProxy('HOST.UPPER', '80', ['host.upper']), true);
	// bracketed IPv6 entries lose their brackets
	assert.equal(matchesNoProxy('::1', '80', ['[::1]']), true);
});

/* ------------------------------------------------- unit: dispatcher choice */

test('buildDispatcher picks the right agent per protocol', () => {
	assert.ok(buildDispatcher({ enabled: true, proxy: 'http://127.0.0.1:8080' }) instanceof EnvHttpProxyAgent);
	assert.ok(buildDispatcher({ enabled: true, proxy: 'socks5://127.0.0.1:1080' }) instanceof Socks5ProxyAgent);
	// socks5h and socks:// normalize onto the SOCKS5 agent
	assert.ok(buildDispatcher({ enabled: true, proxy: 'socks5h://127.0.0.1:1080' }) instanceof Socks5ProxyAgent);
	assert.ok(buildDispatcher({ enabled: true, proxy: 'socks://127.0.0.1:1080' }) instanceof Socks5ProxyAgent);
	// unsupported protocol rejects
	assert.throws(() => buildDispatcher({ enabled: true, proxy: 'ftp://127.0.0.1:21' }), /unsupported proxy protocol/);
});

/* ----------------------------------------------------------- e2e: runtime */

test('engine routes global fetch through an HTTP proxy and back', async (t) => {
	const origin = await startOrigin();
	const proxy = await startHttpProxy();
	t.after(async () => {
		await close(proxy.server);
		await close(origin.server);
	});

	const engine = createEngine(null);
	t.after(() => engine.restore());

	engine.apply({ enabled: true, proxy: proxy.url, exportEnv: false });
	let body = await (await fetch(origin.url)).json();
	assert.equal(body.via, 'origin');
	assert.equal(proxy.seen.length, 1);

	// hot switch off → direct
	engine.apply({ enabled: false, exportEnv: false });
	body = await (await fetch(origin.url)).json();
	assert.equal(body.via, 'origin');
	assert.equal(proxy.seen.length, 1, 'disabled proxy must see no traffic');

	// hot switch on again
	engine.apply({ enabled: true, proxy: proxy.url, exportEnv: false });
	body = await (await fetch(origin.url)).json();
	assert.equal(body.via, 'origin');
	assert.equal(proxy.seen.length, 2);
});

test('noProxy bypasses the proxy for matching hosts only', async (t) => {
	const origin = await startOrigin();
	const proxy = await startHttpProxy();
	t.after(async () => {
		await close(proxy.server);
		await close(origin.server);
	});

	const engine = createEngine(null);
	t.after(() => engine.restore());

	engine.apply({ enabled: true, proxy: proxy.url, noProxy: ['127.0.0.1'], exportEnv: false });
	const body = await (await fetch(origin.url)).json();
	assert.equal(body.via, 'origin');
	assert.equal(proxy.seen.length, 0, '127.0.0.1 must bypass');

	// localhost is not 127.0.0.1 for the matcher → goes through the proxy
	const localhostUrl = origin.url.replace('127.0.0.1', 'localhost');
	const viaProxy = await (await fetch(localhostUrl)).json();
	assert.equal(viaProxy.via, 'origin');
	assert.equal(proxy.seen.length, 1, 'localhost must route via proxy');
});

test('engine routes global fetch through a SOCKS5 proxy', async (t) => {
	const origin = await startOrigin();
	const socks = await startSocks5();
	t.after(async () => {
		await close(socks.server);
		await close(origin.server);
	});

	const engine = createEngine(null);
	t.after(() => engine.restore());

	engine.apply({ enabled: true, proxy: socks.url, exportEnv: false });
	const body = await (await fetch(origin.url)).json();
	assert.equal(body.via, 'origin');
	assert.equal(socks.connects.length, 1);
	assert.equal(socks.connects[0], `127.0.0.1:${origin.server.address().port}`);
});

test('SOCKS5 honors noProxy through the routing dispatcher', async (t) => {
	const origin = await startOrigin();
	const socks = await startSocks5();
	t.after(async () => {
		await close(socks.server);
		await close(origin.server);
	});

	const engine = createEngine(null);
	t.after(() => engine.restore());

	engine.apply({ enabled: true, proxy: socks.url, noProxy: ['127.0.0.1'], exportEnv: false });
	const body = await (await fetch(origin.url)).json();
	assert.equal(body.via, 'origin');
	assert.equal(socks.connects.length, 0, 'bypass rule must keep SOCKS out of the path');
});

test('env export follows the switch and never clobbers operator values', async (t) => {
	const origin = await startOrigin();
	const proxy = await startHttpProxy();
	t.after(async () => {
		await close(proxy.server);
		await close(origin.server);
	});

	isolateProxyEnv(t);

	const engine = createEngine(null);
	t.after(() => engine.restore());

	engine.apply({ enabled: true, proxy: proxy.url, noProxy: ['localhost'] });
	assert.equal(process.env.HTTP_PROXY, proxy.url);
	assert.equal(process.env.HTTPS_PROXY, proxy.url);
	assert.equal(process.env.ALL_PROXY, proxy.url);
	assert.equal(process.env.NO_PROXY, 'localhost');

	engine.apply({ enabled: false });
	assert.ok(!('HTTP_PROXY' in process.env));
	assert.ok(!('NO_PROXY' in process.env));

	// operator-provided values survive untouched
	process.env.HTTP_PROXY = 'http://operator:1';
	engine.apply({ enabled: true, proxy: proxy.url });
	assert.equal(process.env.HTTP_PROXY, 'http://operator:1');
	engine.apply({ enabled: false });
	assert.equal(process.env.HTTP_PROXY, 'http://operator:1');
	delete process.env.HTTP_PROXY;
});

test('clearing noProxy on a hot switch removes stale NO_PROXY env', (t) => {
	isolateProxyEnv(t);

	const engine = createEngine(null);
	t.after(() => engine.restore());

	engine.apply({ enabled: true, proxy: 'http://127.0.0.1:9', noProxy: ['localhost'] });
	assert.equal(process.env.NO_PROXY, 'localhost');

	// hot switch to an empty noProxy list — NO_PROXY must clear, not go stale
	engine.apply({ enabled: true, proxy: 'http://127.0.0.1:9', noProxy: [] });
	assert.ok(!('NO_PROXY' in process.env));
	assert.ok(!('no_proxy' in process.env));
	assert.equal(process.env.HTTP_PROXY, 'http://127.0.0.1:9');
});

test('invalid or incomplete config keeps traffic direct', async (t) => {
	const origin = await startOrigin();
	t.after(() => close(origin.server));

	const engine = createEngine(null);
	t.after(() => engine.restore());

	engine.apply({ enabled: true, proxy: 'ftp://nope:21' });
	const body = await (await fetch(origin.url)).json();
	assert.equal(body.via, 'origin');

	engine.apply({ enabled: true });
	const again = await (await fetch(origin.url)).json();
	assert.equal(again.via, 'origin');
});

test('restore returns the original global dispatcher', (t) => {
	const before = getGlobalDispatcher();
	const engine = createEngine(null);
	t.after(() => engine.restore());
	engine.apply({ enabled: true, proxy: 'http://127.0.0.1:9', exportEnv: false });
	assert.notEqual(getGlobalDispatcher(), before);
	engine.restore();
	assert.equal(getGlobalDispatcher(), before);
});
