# dsh-proxy — DSH 运行时可切换出站代理

**English readme: [README.md](README.md)。**

[![npm](https://img.shields.io/npm/v/@tr1v3r/dsh-proxy.svg)](https://www.npmjs.com/package/@tr1v3r/dsh-proxy)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

![演示：编辑 settings.yaml 即时改写全部出站路由](docs/assets/proxy-switch-demo.gif)

`@tr1v3r/dsh-proxy` 是 DeepSeek Harness 插件，把进程内**所有出站请求**——
LLM 提供方、`web_search` / `web_fetch`、streamable-http MCP——经由
HTTP(S) CONNECT 或 SOCKS5 代理转发，并且支持**运行时随时开关、随时换代理**：
只需编辑 `$DSH_HOME/settings.yaml` 的一个分节（watcher 热加载），全程零重启。
上面的动图是真实录制，安装后可运行 `node scripts/demo.mjs` 复现。

## 工作原理

DSH 与 pi-ai 的请求都走 `globalThis.fetch`，而它读取的是 undici 的全局
dispatcher 槽位（`Symbol.for('undici.globalDispatcher.1')`）。本插件接管该槽位：

- `http(s)://` 代理 → `EnvHttpProxyAgent`（https 走 CONNECT 隧道）
- `socks5://` 代理 → undici 内置 `Socks5ProxyAgent`（支持 URL 内鉴权；
  `socks5h://` / `socks://` 自动归一；域名在代理端远程解析）
- `noProxy` 规则 → 两条路径统一走 `RoutingDispatcher` 分流，HTTP 与 SOCKS
  语义完全一致（undici 风格：裸条目匹配主机及点边界子域；`host:port` 锁定
  端口；`*` 全部直连；前导点 / `*.` 前缀视同裸条目等价写法）。dispatcher
  刻意忽略环境变量里的 `NO_PROXY`/`HTTP_PROXY`——导出的 env 只引导子进程，
  进程内路由完全由 settings 分节决定）

`exportEnv: true`（默认）时，切换还会同步导出
`HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY` 到 dsh 进程环境——切换后
新拉起的子进程（bash 工具里的 `curl`/`git`、stdio MCP server）跟着走同一
代理。启动时由你自己设置的环境变量绝不会被覆盖；禁用/卸载时全部还原。

被替换下来的旧 dispatcher 先优雅关闭、30 秒后强制销毁，确保切换真正切断
旧的 keep-alive 连接。

## 安装

在目标 profile 目录（`~/.config/dsh/profiles/<name>/`）：

1. `package.json` 加依赖与 bundle（合并进现有 `dsh.profile.bundles` 列表）：

   ```json
   {
     "dependencies": {
       "@tr1v3r/dsh-proxy": "^0.1.0"
     },
     "dsh": {
       "profile": {
         "bundles": ["@deepseek-ai/dsh-base", "@tr1v3r/dsh-proxy"]
       }
     }
   }
   ```

2. 安装：

   ```sh
   dsh plugin --profile <name> install --no-frozen-lockfile
   ```

3. 重启一次 dsh 挂载插件；此后**再无需重启**——切换全在 settings 里。

## 使用

编辑 `~/.config/dsh/settings.yaml`（热加载，立即生效）：

```yaml
dsh-proxy:
  enabled: true                          # 改成 false → 立刻恢复直连
  proxy: socks5://127.0.0.1:1080         # 或 http://127.0.0.1:7890、https://…、
                                         # socks5://user:pass@host:1080、socks5h://…
  noProxy:                               # 可选分流规则
    - localhost
    - .internal.example
    - registry.corp:443
  exportEnv: true                        # 同步设置子进程的 HTTP(S)_PROXY 环境变量
```

每次保存立即重路由。插件会记录每次切换：

```
dsh-proxy: routing global fetch via socks5://***@127.0.0.1:1080, noProxy 3 rule(s)
dsh-proxy: direct (proxy off)
```

（日志中代理 URL 的用户名密码会打码。）

## 覆盖范围

| 流量 | 是否代理 |
| --- | --- |
| pi-ai 各提供方（`zai-coding-cn`、自定义 openai 兼容路由……） | ✅ |
| `dsh-llm-deepseek`（deepseek-official） | ✅ |
| `web_search` / `web_fetch` | ✅ |
| streamable-http MCP server | ✅ |
| stdio MCP、bash 工具子进程（`curl`、`git`……） | ✅ 经导出的环境变量，仅对切换后新拉起的进程生效 |
| pi-ai Bedrock 路由 | ⚠️ AWS SDK 自管代理（它会读 `HTTPS_PROXY` 环境变量） |
| 内置浏览器 host / 浏览器下载 | ❌ 独立进程，请在浏览器侧配置 |

另请注意：切换时已在运行的子进程保留其启动时的环境；undici 的 SOCKS5
agent 上游目前标注 experimental。

## 开发

```sh
npm install
npm test                      # 单测 + 本地 e2e：HTTP 代理、SOCKS5、noProxy、热切换、env
node scripts/boot-probe.mjs   # boot 真实 DSH 插件树，热翻转 settings.yaml 验证
```

## 许可

MIT © tr1v3r
