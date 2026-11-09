window.__ModuleLoader__.load({
  id: "hexing-memory-ui",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    let React = require("react");

    function Icon() {
      return React.createElement("span", {
        "aria-hidden": "true",
        style: {
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: "16px",
          height: "16px",
          fontSize: "15px",
          lineHeight: "1",
          color: "#ffd479",
        },
      }, "✦");
    }

    function Page() {
      return React.createElement("div", {
        style: {
          display: "flex",
          flexDirection: "column",
          width: "100%",
          height: "100%",
          minHeight: 0,
          background: "#02040b",
        },
      },
        React.createElement("div", {
          style: {
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "12px",
            padding: "8px 14px",
            borderBottom: "1px solid rgba(110,145,235,.14)",
            fontSize: "12px",
            color: "#8d9bc0",
            flex: "none",
          },
        },
          React.createElement("span", null, "核星记忆 · 总览"),
          React.createElement("a", {
            href: "http://127.0.0.1:3099/",
            target: "_blank",
            rel: "noopener noreferrer",
            style: { color: "#9fb4ff", textDecoration: "none" },
          }, "新标签打开 ↗")
        ),
        React.createElement("iframe", {
          title: "核星记忆总览",
          src: "http://127.0.0.1:3099/",
          style: {
            flex: "1 1 auto",
            width: "100%",
            minHeight: 0,
            border: "0",
            background: "#02040b",
          },
        })
      );
    }

    function apply(ctx) {
      ctx.slots.inject("main", () => ctx.slots.register({
        name: "main",
        key: "hexing-memory",
        label: "记忆总览",
      }, Page));
      ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
        name: "sidebar.panellist",
        id: "hexing-memory",
        order: 20,
        label: "记忆总览",
      }, Icon));
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  },
});
