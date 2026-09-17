# dsh-plugin-proxy — DSH 运行时可切换出站代理

**English readme: [README.md](README.md)。**

[![npm](https://img.shields.io/npm/v/@1624318455/dsh-plugin-proxy.svg)](https://www.npmjs.com/package/@1624318455/dsh-plugin-proxy)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH Market](https://raw.githubusercontent.com/2BingLing/dsh-market/master/assets/readme/badge-listed-zh.svg)](https://dsh.market/)

<div>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="license"></a>
  <a href="https://github.com/awesome-dsh-plugin/awesome-dsh-plugin"><img src="https://awesome-dsh-plugin.com/badge.svg" alt="Awesome"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-20%2B-blue" alt="node"></a>
  <a href="test/switch.test.mjs"><img src="https://img.shields.io/badge/tests-26%20passed-success" alt="tests"></a>
  <a href="https://github.com/1624318455/dsh-plugin-proxy"><img src="https://img.shields.io/github/stars/1624318455/dsh-plugin-proxy" alt="stars"></a>
  <a href="https://github.com/1624318455/dsh-plugin-proxy/commits/master"><img src="https://img.shields.io/github/last-commit/1624318455/dsh-plugin-proxy" alt="last commit"></a>
</div>

![演示：编辑 settings.yaml 即时改写全部出站路由](docs/assets/proxy-switch-demo.gif)

`@1624318455/dsh-plugin-proxy` 是 DeepSeek Harness 插件，把进程内**所有出站请求**——
LLM 提供方、`web_search` / `web_fetch`、streamable-http MCP——经由
HTTP(S) CONNECT 或 SOCKS5 代理转发，并且支持**运行时随时开关、随时换代理**：
编辑 `$DSH_HOME/settings.yaml` 的一个分节或网页设置卡片（watcher 热加载），全程零重启。
上面的动图是真实录制，安装后可运行 `node scripts/demo.mjs` 复现。

## 特性

- **运行时切换**——`direct` / `system` / `manual` 每次保存即时生效；
  被替换的旧 dispatcher 先优雅关闭、30 秒后强制销毁，旧 keep-alive 真正断开。
- **网页设置卡片**——**设置 → 插件 → 插件配置** 里的“出站代理”卡片，
  中英双语，同样零重启。
- **双协议统一分流**——HTTP 与 SOCKS5 共用一个 `RoutingDispatcher`，
  `noProxy` 语义两条路径完全一致。
- **子进程跟随**——`exportEnv`（默认开）把 `HTTP(S)_PROXY` / `NO_PROXY`
  发布给切换后新拉起的进程（bash 工具的 `curl`/`git`、stdio MCP），
  绝不覆盖你自己在启动时设定的变量；禁用/卸载时全部还原。

## 环境要求

- DSH（DeepSeek Harness）≥ 0.1.2-rc.1，Node.js ≥ 20。
- `mode: manual` 时需要一个可达的 HTTP(S) 或 SOCKS5 代理。

## 安装

**从插件市场安装**（推荐，收录后可用）：在 DSH 里打开 **设置 → 插件市场**，
搜索 `dsh-plugin-proxy`，一键安装。

**从 GitHub 安装**：

```sh
dsh plugin --profile <name> add github:1624318455/dsh-plugin-proxy
```

**从 npm 安装**：

```sh
dsh plugin --profile <name> add @1624318455/dsh-plugin-proxy
```

**验证**：重启一次 `dsh web` 挂载插件，之后翻 `mode` 或打开设置卡片，
看 `dsh-proxy:` 日志行即算生效。

## 使用

编辑 `~/.config/dsh/settings.yaml`（热加载，立即生效），或用网页卡片——
同一分节。一个 `mode` 键即可在三种模式间切换——`direct`（直连）、
`system`（跟随系统）、`manual`（手动）：

```yaml
dsh-proxy:
  mode: manual                           # direct | system | manual
  proxy: socks5://127.0.0.1:1080         # 仅 manual——http://…、https://…、
                                         # socks5://user:pass@host:1080、socks5h://…
  noProxy:                               # 仅 manual——可选分流规则
    - localhost
    - .internal.example
    - registry.corp:443
  exportEnv: true                        # 仅 manual——同步设置子进程的 HTTP(S)_PROXY
```

| `mode` | 行为 |
| --- | --- |
| `direct` | 直连，不走任何代理。 |
| `system` | 跟随主机代理，每次分节应用时探测一次：读取 `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY` 环境变量；环境变量缺失时，在 macOS 上再读取系统设置里的网络代理（`scutil --proxy`）。是保存时探测、非持续轮询；Windows 注册表、Linux 桌面与 PAC 暂未覆盖。忽略 `proxy`/`noProxy`/`exportEnv`。 |
| `manual` | 走 `proxy` URL，可用 `noProxy` 分流。 |

每次保存立即重路由。插件会记录每次切换：

```
dsh-proxy: routing global fetch via socks5://***@127.0.0.1:1080, noProxy 3 rule(s)
dsh-proxy: following system proxy (http://127.0.0.1:7890, noProxy 3 rule(s))
dsh-proxy: direct (mode: direct)
```

（日志中代理 URL 的用户名密码会打码。`system` 模式只读环境/系统代理，
不会回写这些环境变量。）

## 工作原理

DSH 与 pi-ai 的请求都走 `globalThis.fetch`，而它读取的是 undici 的全局
dispatcher 槽位（`Symbol.for('undici.globalDispatcher.1')`）。本插件接管该槽位：

- `http(s)://` 代理 → `EnvHttpProxyAgent`（https 走 CONNECT 隧道）
- `socks5://` 代理 → undici 内置 `Socks5ProxyAgent`（支持 URL 内鉴权；
  `socks5h://` / `socks://` 自动归一；域名在代理端远程解析）
- `noProxy` 规则 → 两条路径统一走 `RoutingDispatcher` 分流
  （undici 风格：裸条目匹配主机及点边界子域；`host:port` 锁定端口；
  `*` 全部直连；前导点 / `*.` 前缀视同裸条目）

## 边界情况处理

| 流量 | 是否代理 |
| --- | --- |
| pi-ai 各提供方（`zai-coding-cn`、自定义 openai 兼容路由……） | ✅ |
| `dsh-llm-deepseek`（deepseek-official） | ✅ |
| `web_search` / `web_fetch` | ✅ |
| streamable-http MCP server | ✅ |
| stdio MCP、bash 工具子进程（`curl`、`git`……） | ✅ 经导出的环境变量，仅对切换后新拉起的进程生效 |
| pi-ai Bedrock 路由 | ⚠️ AWS SDK 自管代理（它会读 `HTTPS_PROXY` 环境变量） |
| 内置浏览器 host / 浏览器下载 | ❌ 独立进程，请在浏览器侧配置 |

切换时已在运行的子进程保留其启动时的环境；undici 的 SOCKS5 agent
上游目前标注 experimental。

## 设置持久化

一个命名空间、两个编辑器：`$DSH_HOME/settings.yaml`（`dsh-proxy:`）与网页卡片
绑定同一个 settings scope，两边保存都即时生效，DSH 负责落盘。卡片需要
DSH ≥ 0.1.0-rc.7，旧版本直接改文件——路由不受影响。

## 排查

| 现象 | 可能原因与处理 |
| --- | --- |
| 插件配置里没有卡片 | DSH 版本早于槽位契约——升级 DSH；走文件配置路由照常工作。 |
| 某个 websocket 工具（如 Edge TTS）经代理失败 | 个别服务端不喜欢 CONNECT 隧道——把该域名加入 `noProxy`（如 `speech.platform.bing.com`），热加载，无需重启。 |
| 子进程不走代理 | 它们在切换前就启动了——重启对应工具/进程；确认 `exportEnv: true`。 |

## 常见问题

- **direct 和 manual 怎么选？** `direct` 用于排查时全量直连；`manual`
  下 `proxy` 为空会拒绝路由并记错，直接保持直连。
- **会读我 shell 里的代理环境变量吗？** 仅 `system` 模式会。`manual`
  模式完全由 settings 分节决定。
- **有额外开销吗？** 每次保存换一次 dispatcher；单次请求只是一次主机名
  规则匹配，开销可忽略。

## 界面语言（i18n）

网页卡片经 `locale` 服务提供中英双语，跟随 DSH 界面语言。

## 开发

```sh
npm install
npm test                      # 单测 + 本地 e2e：HTTP 代理、SOCKS5、noProxy、热切换、env
node scripts/boot-probe.mjs   # boot 真实 DSH 插件树，热翻转 settings.yaml 验证
```

客户端半边（`lib/client.js`）是手写的 harness ModuleLoader 包——无打包步骤，
`npm test` 里的 `node --check` 即覆盖。

## 已知限制

- `system` 模式不跟 Windows 注册表、Linux 桌面代理与 PAC（环境变量全平台可用）。
- `noProxy` 里写 `*` 即全部直连——慎用。

## 致谢

- [@tr1v3r/dsh-proxy](https://github.com/tr1v3r/dsh-proxy)（[tr1v3r](https://github.com/tr1v3r)）——
  dispatcher 引擎、分流语义与 settings 分节设计源自该项目，本项目在其基础上维护并补齐网页卡片。

## 许可

MIT © tr1v3r, © 1624318455 —— 见 [LICENSE](./LICENSE)。
