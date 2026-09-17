// @1624318455/dsh-plugin-proxy — Client half (browser bundle).
// Hand-written in the harness module-loader format; `require` answers the
// platform externals (react), everything else is inlined. No build step.
window.__ModuleLoader__.load({
  id: "@1624318455/dsh-plugin-proxy",
  factory: require => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");

    // Service dependencies (fiber inject waiting): the client runner creates
    // the entry as ctx.plugin({ inject, apply }), so apply only runs after
    // `slots`/`locale`/`settingsScope` are available.
    const inject = ["slots", "locale", "settingsScope"];

    // Bundle build tag: bump on every client fix so a console line proves
    // WHICH code is actually running (rules out stale-bundle confusion).
    const CLIENT_BUILD = "0.1.3-proxy-card.1";

    /** Dictionary namespace owned by this plugin. */
    const NS = "settings.dsh-proxy";
    /** The settings namespace this card edits (mirrors the Host half). */
    const SETTINGS_NAMESPACE = "dsh-proxy";

    const zh = {
      "card.title": "出站代理 (dsh-proxy)",
      "card.desc": "DSH 进程内所有出站请求（模型、搜索、MCP）经 HTTP/SOCKS5 代理，保存即时生效，无需重启。",
      "field.mode": "模式",
      "mode.direct": "直连（不用代理）",
      "mode.system": "跟随系统代理",
      "mode.manual": "手动指定",
      "field.proxy": "代理地址",
      "field.proxy.tip": "manual 模式生效，如 http://127.0.0.1:10808 或 socks5://127.0.0.1:1080",
      "field.noProxy": "直连白名单",
      "field.noProxy.tip": "一行一条，如 localhost、127.0.0.1、speech.platform.bing.com",
      "field.exportEnv": "同时导出环境变量给子进程",
      "field.exportEnv.tip": "manual 模式生效：bash/curl/git、stdio MCP 跟随同一代理",
    };
    const en = {
      "card.title": "Outbound proxy (dsh-proxy)",
      "card.desc": "Routes every in-process outbound request (LLM, search, MCP) via HTTP/SOCKS5. Applies on save, no restart.",
      "field.mode": "Mode",
      "mode.direct": "Direct (no proxy)",
      "mode.system": "Follow system proxy",
      "mode.manual": "Manual",
      "field.proxy": "Proxy URL",
      "field.proxy.tip": "Manual mode, e.g. http://127.0.0.1:10808 or socks5://127.0.0.1:1080",
      "field.noProxy": "Bypass list",
      "field.noProxy.tip": "One entry per line, e.g. localhost, 127.0.0.1, speech.platform.bing.com",
      "field.exportEnv": "Also export env vars to child processes",
      "field.exportEnv.tip": "Manual mode: bash/curl/git and stdio MCP follow the same proxy",
    };

    const rowStyle = { display: "flex", flexDirection: "column", gap: 4, marginBottom: 12 };
    const labelStyle = { fontWeight: 600, fontSize: 13 };
    const tipStyle = { fontSize: 12, opacity: 0.65 };
    const inputStyle = { padding: "6px 8px", fontSize: 13, width: "100%", boxSizing: "border-box" };

    function ProxyCard(props) {
      const scope = props.scope;
      const useSnapshot = props.useSnapshot;
      const t = props.t;
      const snap = (useSnapshot() || {});
      const value = (snap && snap.value !== undefined) ? snap.value : snap;
      const mode = value.mode || (value.enabled === true ? "manual" : "direct");
      const proxy = value.proxy || "";
      const noProxyList = Array.isArray(value.noProxy) ? value.noProxy : [];
      const exportEnv = value.exportEnv !== undefined ? value.exportEnv : true;
      const [noProxyText, setNoProxyText] = react.useState(null);

      const set = (field, v) => {
        try {
          const r = scope.set(field, v);
          if (r && typeof r.catch === "function") r.catch(e => console.warn("[dsh-proxy] save failed:", e));
        } catch (e) { console.warn("[dsh-proxy] save failed:", e); }
      };

      const onMode = e => set("mode", e.target.value);
      const onProxy = e => set("proxy", e.target.value);
      const onExportEnv = e => set("exportEnv", e.target.checked);
      const onNoProxyFocus = e => { if (noProxyText === null) setNoProxyText(noProxyList.join("\n")); };
      const onNoProxyChange = e => setNoProxyText(e.target.value);
      const onNoProxyBlur = () => {
        if (noProxyText === null) return;
        const list = noProxyText.split("\n").map(s => s.trim()).filter(Boolean);
        setNoProxyText(null);
        set("noProxy", list);
      };

      return react.createElement("div", null,
        react.createElement("div", { style: { fontSize: 12, opacity: 0.7, marginBottom: 12 } }, t("card.desc")),
        react.createElement("div", { style: rowStyle },
          react.createElement("label", { style: labelStyle }, t("field.mode")),
          react.createElement("select", { value: mode, onChange: onMode, style: inputStyle },
            react.createElement("option", { value: "direct" }, t("mode.direct")),
            react.createElement("option", { value: "system" }, t("mode.system")),
            react.createElement("option", { value: "manual" }, t("mode.manual")),
          ),
        ),
        mode === "manual" ? react.createElement("div", { style: rowStyle },
          react.createElement("label", { style: labelStyle }, t("field.proxy")),
          react.createElement("input", { value: proxy, onChange: onProxy, placeholder: "http://127.0.0.1:10808", style: inputStyle }),
          react.createElement("div", { style: tipStyle }, t("field.proxy.tip")),
        ) : null,
        mode === "manual" ? react.createElement("div", { style: rowStyle },
          react.createElement("label", { style: labelStyle }, t("field.noProxy")),
          react.createElement("textarea", {
            value: noProxyText === null ? noProxyList.join("\n") : noProxyText,
            onFocus: onNoProxyFocus, onChange: onNoProxyChange, onBlur: onNoProxyBlur,
            rows: 3, style: inputStyle,
          }),
          react.createElement("div", { style: tipStyle }, t("field.noProxy.tip")),
        ) : null,
        mode === "manual" ? react.createElement("div", { style: { marginBottom: 4 } },
          react.createElement("label", { style: { fontSize: 13 } },
            react.createElement("input", { type: "checkbox", checked: !!exportEnv, onChange: onExportEnv, style: { marginRight: 6 } }),
            t("field.exportEnv"),
          ),
          react.createElement("div", { style: tipStyle }, t("field.exportEnv.tip")),
        ) : null,
      );
    }

    const apply = ctx => {
      const slots = ctx.slots ?? (typeof ctx.get === "function" ? ctx.get("slots") : undefined);
      if (!slots) throw new Error("[dsh-proxy] slots service unavailable");
      try { console.info("[dsh-proxy] client build " + CLIENT_BUILD + " loaded"); } catch (e) {}
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-proxy: copy dictionaries");

      const scope = ctx.settingsScope.bind({ namespace: SETTINGS_NAMESPACE });
      const getSnapshot = scope.getSnapshot.bind(scope);
      const subscribe = scope.subscribe.bind(scope);
      const useSnapshot = () => react.useSyncExternalStore(subscribe, getSnapshot);
      const t = ctx.locale.bind(NS);
      const injected = () => ({ scope, useSnapshot, t });

      ctx.slots.inject("settings.plugin.item", function* () {
        let kind;
        try { kind = ctx.slots.spec("settings.plugin.item")?.kind; } catch {}
        const options = kind === "list"
          ? { name: "settings.plugin.item", id: SETTINGS_NAMESPACE, locale: NS, inject: injected }
          : { name: "settings.plugin.item", key: SETTINGS_NAMESPACE, locale: NS, inject: injected };
        try {
          yield ctx.slots.register(options, ProxyCard);
        } catch (err) {
          console.warn("[dsh-proxy] settings card rejected by this DSH build (" + (err instanceof Error ? err.message : String(err)) + ")");
        }
      });
    };

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
