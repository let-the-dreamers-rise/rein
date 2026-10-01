// Bundles scan/browser.js into web/scan/rein-scan.js for the scan page, so
// the page runs exactly the scanner the CLI runs. CI rebuilds it and fails if
// it differs from what is committed.
//
//   node scripts/build-web.js
const path = require("path");
const esbuild = require("esbuild");

const ROOT = path.join(__dirname, "..");

esbuild
  .build({
    entryPoints: [path.join(ROOT, "scan", "browser.js")],
    outfile: path.join(ROOT, "web", "scan", "rein-scan.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "Rein",
    target: "es2020",
    minify: true,
    legalComments: "eof",
    // v2/export.js and the guard read files only when run as a command or
    // given a file, never here: the page hands the guard its limits in memory.
    alias: { fs: "./scripts/empty.js", path: "./scripts/empty.js", os: "./scripts/empty.js", child_process: "./scripts/empty.js", readline: "./scripts/empty.js" },
    // A page has no process; code that reads settings from it finds none.
    define: { "process.env": "{}" },
    banner: { js: "// Rein wallet scanner, bundled from scan/ in github.com/let-the-dreamers-rise/rein by scripts/build-web.js. Read the source there." },
    logLevel: "warning",
  })
  .then(() => console.log("wrote web/scan/rein-scan.js"));
