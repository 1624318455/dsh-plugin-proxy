# dsh-plugin-proxy — runtime-switchable outbound proxy for DSH

**中文说明见 [README.zh.md](README.zh.md)。**

[![npm](https://img.shields.io/npm/v/@1624318455/dsh-plugin-proxy.svg)](https://www.npmjs.com/package/@1624318455/dsh-plugin-proxy)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH Market](https://raw.githubusercontent.com/2BingLing/dsh-market/master/assets/readme/badge-listed-en.svg)](https://dsh.market/)

![demo: editing settings.yaml reroutes every outbound request instantly](docs/assets/proxy-switch-demo.gif)

`@1624318455/dsh-plugin-proxy` is a DeepSeek Harness plugin that routes **every
in-process outbound request** — LLM providers, `web_search` / `web_fetch`,
streamable-http MCP — through an HTTP(S) CONNECT or SOCKS5 proxy, and lets
you **flip the proxy on, off, or to another server at runtime**, with zero
restarts, by editing one section of `$DSH_HOME/settings.yaml` (hot-reloaded)
or the web settings card. The demo above is a real recording:
`node scripts/demo.mjs` after install.

## Features

- **Runtime switching** — `direct` / `system` / `manual` routing flips on
  every settings save; retired dispatchers close gracefully (force-destroyed
  after 30 s), so old keep-alive connections actually go away.
- **Web settings card** — the same section is editable under **Settings →
  Plugins → Plugin configuration**, bilingual (zh/en), no restart either way.
- **Single matcher for both protocols** — HTTP and SOCKS5 share one
  `RoutingDispatcher`, so `noProxy` semantics are identical on both legs.
- **Child-process follow-along** — `exportEnv` (default on) publishes
  `HTTP(S)_PROXY` / `NO_PROXY` to processes spawned after the switch
  (bash-tool `curl`/`git`, stdio MCP servers) without clobbering values you
  set yourself; everything is restored on disable/unload.

## Requirements

- DSH (DeepSeek Harness) ≥ 0.1.2-rc.1 with a profile; Node.js ≥ 20.
- A reachable HTTP(S) or SOCKS5 proxy when `mode: manual`.

## Install

**From the plugin market** (recommended, once listed): in DSH open
**Settings → Plugin Market**, search `dsh-plugin-proxy`, one-click install.

**From GitHub**:

```sh
dsh plugin --profile <name> add github:1624318455/dsh-plugin-proxy
```

**From npm**:

```sh
dsh plugin --profile <name> add @1624318455/dsh-plugin-proxy
```

**Verify**: restart `dsh web` once, then open the settings card or flip
`mode` in `settings.yaml` and watch the `dsh-proxy:` log line.

## Use

Edit `~/.config/dsh/settings.yaml` (hot-reloaded, no restart), or use the
web card — same section. One `mode` key picks the routing strategy —
`direct`, `system`, or `manual`:

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
| `direct` | No proxy — everything goes out directly. |
| `system` | Follow the host's proxy, detected each time the section is applied: `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY` env vars everywhere, falling back to the macOS System Settings network proxy (`scutil --proxy`) when env is unset. It re-detects on settings save, not continuously; Windows registry, Linux-desktop and PAC are not yet covered. `proxy`/`noProxy`/`exportEnv` are ignored. |
| `manual` | Route through the `proxy` URL with the optional `noProxy` bypass list. |

Every save re-routes immediately. The plugin logs each switch:

```
dsh-proxy: routing global fetch via socks5://***@127.0.0.1:1080, noProxy 3 rule(s)
dsh-proxy: following system proxy (http://127.0.0.1:7890, noProxy 3 rule(s))
dsh-proxy: direct (mode: direct)
```

(Userinfo in the proxy URL is redacted in logs. `system` mode follows the
ambient env/OS proxy, so it never writes those env vars itself.)

## Architecture

DSH and pi-ai issue requests through `globalThis.fetch`, which reads undici's
well-known global dispatcher slot (`Symbol.for('undici.globalDispatcher.1')`).
The plugin owns that slot:

- `http(s)://` proxy → `EnvHttpProxyAgent` (CONNECT tunneling for https)
- `socks5://` proxy → undici's built-in `Socks5ProxyAgent` (URL credentials
  supported; `socks5h://`/`socks://` normalize to it; DNS resolves remotely)
- `noProxy` rules → both paths route through one `RoutingDispatcher`
  (undici-style: bare entries match the host and dot-boundary subdomains;
  `host:port` pins a port; `*` bypasses everything; a leading dot or `*.`
  prefix is accepted as a synonym of the bare entry). In `manual` mode,
  ambient `NO_PROXY`/`HTTP_PROXY` env vars are deliberately ignored by the
  dispatchers — exported env only steers child processes, so in-process
  routing is fully determined by the settings section.

## Edge cases handled

| Traffic | Routed? |
| --- | --- |
| LLM providers via pi-ai (`zai-coding-cn`, custom openai-compatible routes, …) | ✅ |
| `dsh-llm-deepseek` (deepseek-official) | ✅ |
| `web_search` / `web_fetch` | ✅ |
| streamable-http MCP servers | ✅ |
| stdio MCP servers, bash-tool subprocesses (`curl`, `git`, …) | ✅ via exported env, for processes spawned after the switch |
| pi-ai Bedrock route | ⚠️ AWS SDK manages its own proxying (`HTTPS_PROXY` env is honored there) |
| Built-in browser host / browser downloads | ❌ separate process, configure the browser itself |

Child processes already running when you flip the switch keep the env they
were spawned with; undici's SOCKS5 agent is currently marked experimental
upstream.

## Settings persistence

One namespace, two editors: `$DSH_HOME/settings.yaml` (`dsh-proxy:`) and the
web card bind the same settings scope. Either side saves live; DSH persists
the file. The card needs DSH ≥ 0.1.0-rc.7; on older builds use the file —
routing is unaffected.

## Troubleshooting

| Symptom | Likely cause & fix |
| --- | --- |
| No card under Plugin configuration | DSH build predates the slot contract — upgrade DSH; routing via the file still works. |
| A websocket tool (e.g. Edge TTS) fails through the proxy | Some endpoints dislike CONNECT tunneling — add the host to `noProxy` (e.g. `speech.platform.bing.com`); hot-reloaded, no restart. |
| Children ignore the proxy | They were spawned before the switch — restart that tool/process; check `exportEnv: true`. |

## FAQ

- **Direct vs manual?** `direct` is a full bypass for debugging; `manual`
  with an empty `proxy` refuses to route and stays direct with an error log.
- **Does it read my shell proxy env?** Only in `system` mode. `manual`
  mode is fully determined by the settings section.
- **Overhead?** One dispatcher swap per save; per-request cost is a
  hostname match against a short rule list.

## UI language (i18n)

The web card ships zh + en copy via the `locale` service and follows the
DSH UI language.

## Development

```sh
npm install
npm test                      # unit + local e2e: HTTP proxy, SOCKS5, noProxy, hot-switch, env
node scripts/boot-probe.mjs   # boots a real DSH tree and hot-flips settings.yaml
```

The client half (`lib/client.js`) is hand-built in the harness
ModuleLoader format — no bundler step; `node --check` covers it in `npm test`.

## Known limits

- Windows registry, Linux-desktop proxies and PAC are not followed in
  `system` mode (env vars work everywhere).
- `*` in `noProxy` bypasses everything by design — use with care.

## Acknowledgments

- [@tr1v3r/dsh-proxy](https://github.com/tr1v3r/dsh-proxy) by
  [tr1v3r](https://github.com/tr1v3r) — the dispatcher engine, matcher
  semantics and settings-section design originate there; this project
  maintains that core and adds the web card.

## License

MIT © tr1v3r, © 1624318455 — see [LICENSE](./LICENSE).
