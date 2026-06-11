// Dev server proxy: forwards API calls to the running Dremio backend and LLM API
const BACKEND = "http://localhost:9047";
const LLM_BACKEND = "http://localhost:8765";

const proxyTarget = {
  target: BACKEND,
  secure: false,
  changeOrigin: true,
  ws: true,
};

module.exports = {
  proxy: [
    { context: ["/apiv2"], ...proxyTarget },
    { context: ["/api"], ...proxyTarget },
    { context: ["/oauth"], ...proxyTarget },
    { context: ["/sso"], ...proxyTarget },
    { context: ["/metrics"], ...proxyTarget },
    {
      context: ["/llm"],
      target: LLM_BACKEND,
      secure: false,
      changeOrigin: true,
      pathRewrite: { "^/llm": "" },
    },
  ],
};
