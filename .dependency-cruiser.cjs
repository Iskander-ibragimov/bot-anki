/** Layer rules: bot -> services -> srs; srs is pure; only bot imports grammy. */
module.exports = {
  forbidden: [
    { name: "srs-is-pure", severity: "error", from: { path: "^src/srs" }, to: { path: "^src/(?!srs)" } },
    { name: "srs-no-deps", severity: "error", from: { path: "^src/srs" }, to: { dependencyTypes: ["npm"], pathNot: "ts-fsrs" } },
    { name: "only-bot-uses-grammy", severity: "error", from: { path: "^src/(?!bot|index)" }, to: { path: "grammy" } },
    { name: "services-not-import-bot", severity: "error", from: { path: "^src/(?!bot|index)" }, to: { path: "^src/bot" } },
    { name: "no-circular", severity: "error", from: {}, to: { circular: true } },
  ],
  options: { doNotFollow: { path: "node_modules" }, tsConfig: { fileName: "tsconfig.json" }, tsPreCompilationDeps: true },
};
