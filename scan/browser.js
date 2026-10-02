// The scanner for a web page: the same code the CLI runs, bundled by
// scripts/build-web.js into web/scan/rein-scan.js, which sets window.Rein.
// It reads the explorer straight from the visitor's browser; nothing passes
// through a Rein server, and nothing is signed.
const { scan, scanHistory, summary, exportPolicy, CHAINS } = require("./index");
const { sampleHistory, poisonedSampleHistory } = require("./sample");
const { fetchHistory, fetchEthPaid } = require("./blockscout");
const checkup = require("./checkup");
const safe = require("./safe");

module.exports = { scan, scanHistory, summary, exportPolicy, sampleHistory, poisonedSampleHistory, fetchHistory, fetchEthPaid, checkup, safe, CHAINS };
