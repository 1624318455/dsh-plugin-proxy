# dsh-plugin-proxy — runtime-switchable outbound proxy for DSH

> Maintained fork of [@tr1v3r/dsh-proxy](https://github.com/tr1v3r/dsh-proxy)
> (MIT © tr1v3r): tracks upstream plus a web settings card and bilingual copy.

**中文说明见 [README.zh.md](README.zh.md)。**

[![npm](https://img.shields.io/npm/v/@1624318455/dsh-plugin-proxy.svg)](https://www.npmjs.com/package/@1624318455/dsh-plugin-proxy)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH Market](https://raw.githubusercontent.com/2BingLing/dsh-market/master/assets/readme/badge-listed-en.svg)](https://dsh.market/)

![demo: editing settings.yaml reroutes every outbound request instantly](docs/assets/proxy-switch-demo.gif)

`@1624318455/dsh-plugin-proxy` is a DeepSeek Harness plugin that routes **every
in-process outbound request** — LLM providers, `web_search` / `web_fetch`,
streamable-http MCP — through an HTTP(S) CONNECT or SOCKS5 proxy, and lets
you **flip the proxy on, off, or to another server at runtime**, with zero
restarts, by editing one section of `$DSH_HOME/settings.yaml` (hot-reloaded).
The demo above is a real recording: `node scripts/demo.mjs` after install.

## How it works

DSH and pi-ai issue requests through `globalThis.fetch`, which reads undici's
well-known global dispatcher slot (`Symbol.for('undici.globalDispatcher.1')`).
The plugin owns that slot:

- `http(s)://` proxy → `EnvHttpProxyAgent` (CONNECT tunneling for https)
- `socks5://` proxy → undici's built-in `Socks5ProxyAgent` (URL credentials
  supported; `socks5h://`/`socks://` normalize to it; DNS resolves remotely)
- `noProxy` rules → both paths route through one `RoutingDispatcher`, so HTTP
  and SOCKS share identical matcher semantics (undici-style: bare entries
  match the host and dot-boundary subdomains; `host:port` pins a port; `*`
  bypasses everything; a leading dot or `*.` prefix is accepted as a synonym
  of the bare entry). In `manual` mode, ambient `NO_PROXY`/`HTTP_PROXY` env
  vars are deliberately ignored by the dispatchers — exported env only steers
  child processes, so in-process routing is fully determined by the settings
  section. `system` mode is the opposite: it follows the ambient proxy —
  `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY` env vars, falling back to
  the macOS System Settings proxy (`scutil --proxy`) — re-detected each time
  the section is applied, not continuously polled.

With `exportEnv: true` (default) the switch also exports
`HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY` into the dsh process, so
child processes spawned after the switch (bash-tool `curl`/`git`, stdio MCP
servers) follow the same proxy. Variables you set yourself at boot are never
clobbered, and everything is restored on disable/unload.

Retired dispatchers close gracefully and are force-destroyed after 30 s, so
switching away actually tears down old keep-alive connections.

## Install

In the target profile directory (`~/.config/dsh/profiles/<name>/`):

1. Add the dependency and bundle in `package.json`:

   ```json
   {
     "dependencies": {
       "@1624318455/dsh-plugin-proxy": "^0.1.2"
     },
     "dsh": {
       "profile": {
         "bundles": ["@deepseek-ai/dsh-base", "@1624318455/dsh-plugin-proxy"]
       }
     }
   }
   ```

   (Merge the bundle into your existing `dsh.profile.bundles` list.)

2. Install:

   ```sh
   dsh plugin --profile <name> install --no-frozen-lockfile
   ```

3. Restart dsh once to mount the plugin; afterwards **never again** —
   switching happens through settings.

## Use

Edit `~/.config/dsh/settings.yaml` (hot-reloaded, no restart). One `mode` key
picks the routing strategy — `direct`, `system`, or `manual`:

```yaml
dsh-proxy:
  mode: manual                           # direct | system | manual
  proxy: socks5://127.0.0.1:1080         # manual only — http://…, https://…,
                                         # socks5://user:pass@host:1080, socks5h://…
  noProxy:                               # manual only — optional bypass list
    - localhost
    - .internal.example
    - registry.corp:443
  exportEnv: true                        # manual only — also set HTTP(S)_PROXY for children
```

| `mode` | behavior |
| --- | --- |
| `direct` | No proxy — everything goes out directly (same as the old `enabled: false`). |
| `system` | Follow the host's proxy, detected each time the section is applied: `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY` env vars everywhere, falling back to the macOS System Settings network proxy (`scutil --proxy`) when env is unset. It re-detects on settings save, not continuously; Windows registry, Linux-desktop and PAC are not yet covered. `proxy`/`noProxy`/`exportEnv` are ignored. |
| `manual` | Route through the `proxy` URL with the optional `noProxy` bypass list (same as the old `enabled: true`). |

`enabled: true/false` still works as a deprecated alias for
`manual`/`direct` when `mode` is omitted:

```yaml
dsh-proxy:
  enabled: true                          # ≡ mode: manual
  proxy: http://127.0.0.1:7890
```

Every save re-routes immediately. The plugin logs each switch:

```
dsh-proxy: routing global fetch via socks5://***@127.0.0.1:1080, noProxy 3 rule(s)
dsh-proxy: following system proxy (http://127.0.0.1:7890, noProxy 3 rule(s))
dsh-proxy: direct (mode: direct)
```

(Userinfo in the proxy URL is redacted in logs. `system` mode follows the
ambient env/OS proxy, so it never writes those env vars itself.)

### Web settings card

Since 0.1.3 the same section is editable in the DSH web UI under
**Settings → Plugins → Plugin configuration** (card "Outbound proxy").
It binds the `dsh-proxy` settings namespace, so edits apply live exactly
like saving `settings.yaml` — no restart either way.

## What is covered / not covered

| Traffic | Routed? |
| --- | --- |
| LLM providers via pi-ai (`zai-coding-cn`, custom openai-compatible routes, …) | ✅ |
| `dsh-llm-deepseek` (deepseek-official) | ✅ |
| `web_search` / `web_fetch` | ✅ |
| streamable-http MCP servers | ✅ |
| stdio MCP servers, bash-tool subprocesses (`curl`, `git`, …) | ✅ via exported env, for processes spawned after the switch |
| pi-ai Bedrock route | ⚠️ AWS SDK manages its own proxying (`HTTPS_PROXY` env is honored there) |
| Built-in browser host / browser downloads | ❌ separate process, configure the browser itself |

Also note: child processes already running when you flip the switch keep the
env they were spawned with; undici's SOCKS5 agent is currently marked
experimental upstream.

## Development

```sh
npm install
npm test                      # unit + local e2e: HTTP proxy, SOCKS5, noProxy, hot-switch, env
node scripts/boot-probe.mjs   # boots a real DSH tree and hot-flips settings.yaml
```

## Fork maintenance

This fork ([1624318455/dsh-proxy](https://github.com/1624318455/dsh-proxy))
tracks upstream plus:

- Web settings card (`lib/client.js`, hand-built ModuleLoader bundle, no
  build step) for the `dsh-proxy` namespace.
- Bilingual card copy (zh/en) via the `locale` service.

Install from the fork:

```sh
dsh plugin --profile <name> add github:1624318455/dsh-proxy
```

## License

MIT © tr1v3r
