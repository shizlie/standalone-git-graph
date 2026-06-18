const path = require("node:path");

const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const esbuildProblemMatcherPlugin = {
  name: "esbuild-problem-matcher",
  setup(build) {
    build.onStart(() => {
      console.log("[watch] build started");
    });
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        console.error(`    ${location.file}:${location.line}:${location.column}:`);
      });
      console.log("[watch] build finished");
    });
  }
};

const aliasPlugin = {
  name: "alias",
  setup(build) {
    build.onResolve({ filter: /^@\// }, async (args) => {
      const resolved = path.resolve(__dirname, "src", args.path.slice(2));
      return build.resolve(resolved, { kind: args.kind, resolveDir: path.dirname(resolved) });
    });
  }
};

// Alias plugin for the standalone build: redirects `@/l10n` (which normally
// resolves to the VS Code-backed `src/l10n.ts`) to the dependency-free
// `src/standalone/l10n.ts`, so the standalone CLI can reuse the webview l10n
// string table without pulling in `vscode`.
const standaloneAliasPlugin = {
  name: "alias-standalone",
  setup(build) {
    build.onResolve({ filter: /^@\/l10n$/ }, async (args) => {
      const resolved = path.resolve(__dirname, "src", "standalone", "l10n.ts");
      return build.resolve(resolved, { kind: args.kind, resolveDir: path.dirname(resolved) });
    });
    build.onResolve({ filter: /^@\// }, async (args) => {
      const resolved = path.resolve(__dirname, "src", args.path.slice(2));
      return build.resolve(resolved, { kind: args.kind, resolveDir: path.dirname(resolved) });
    });
  }
};

async function main() {
  const extension = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "node",
    target: "es6",
    outfile: "out/extension.js",
    external: ["vscode"],
    logLevel: "silent",
    plugins: [aliasPlugin, esbuildProblemMatcherPlugin]
  });

  const webview = await esbuild.context({
    entryPoints: ["src/webview/main.ts"],
    bundle: true,
    format: "iife",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    target: "es6",
    outfile: "out/web.min.js",
    logLevel: "silent",
    plugins: [aliasPlugin, esbuildProblemMatcherPlugin]
  });

  const standalone = await esbuild.context({
    entryPoints: ["src/standalone/cli.ts"],
    bundle: true,
    format: "cjs",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "node",
    target: "es2022",
    outfile: "out/cli.js",
    // `ws` is a native dep; let Node resolve it at runtime.
    external: ["ws"],
    logLevel: "silent",
    plugins: [standaloneAliasPlugin, esbuildProblemMatcherPlugin]
  });

  const shim = await esbuild.context({
    entryPoints: ["src/standalone/shim.ts"],
    bundle: true,
    format: "iife",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    target: "es2020",
    outfile: "out/shim.js",
    logLevel: "silent",
    plugins: [aliasPlugin, esbuildProblemMatcherPlugin]
  });

  if (watch) {
    await Promise.all([extension.watch(), webview.watch(), standalone.watch(), shim.watch()]);
  } else {
    await extension.rebuild();
    await extension.dispose();
    await webview.rebuild();
    await webview.dispose();
    await standalone.rebuild();
    await standalone.dispose();
    await shim.rebuild();
    await shim.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
