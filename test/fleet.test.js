// rein fleet: shadow mode across many agent wallets, on the sample wallet and
// a copy of it whose last day includes a drain to an address it never paid.
const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const fleet = require("../scan/fleet");
const { sampleHistory, sampleFetch, AGENT } = require("../scan/sample");
const rein = require("../bin/rein");

const THIEF = "0x7777777777777777777777777777777777777777";

describe("rein fleet (shadow mode)", function () {
  this.timeout(60000);

  it("learns each wallet from before --since and lists what a second key would have held after it", async () => {
    const lines = [];
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "rein-fleet-"));
    expect(await fleet.main(["--sample", "--out", out], { log: (l) => lines.push(l) })).to.equal(0);
    const { results } = JSON.parse(fs.readFileSync(path.join(out, "fleet.json"), "utf8"));
    const [honest, drained] = results;
    expect(honest.address).to.equal(AGENT);
    expect(honest.status).to.equal("ok");
    expect(honest.held.map((h) => h.reason)).to.have.members(["NEW_ADDRESS", "APPROVAL_TOO_LARGE"]);
    const stolen = drained.held.filter((h) => h.payee === THIEF);
    expect(stolen).to.have.length(3);
    expect(stolen.map((h) => h.reason).sort()).to.deep.equal(["NEW_ADDRESS", "PAYEE_NOT_ALLOWED", "PAYEE_NOT_ALLOWED"]);
    // Held payments never left, so the honest payments after them still fit the day.
    expect(drained.held.filter((h) => h.reason === "TOKEN_PER_DAY")).to.deep.equal([]);
    const text = lines.join("\n");
    expect(text).to.contain("would have waited for a person's approval in the last 30 days").and.contain("the first payment this agent ever made to that address");
    expect(text).to.contain("Nothing was held");
    expect(fs.readFileSync(path.join(out, "fleet.md"), "utf8")).to.contain(`## ${drained.address}`);
  });

  it("posts to Slack only when something would have been held, unless told to always post", async () => {
    const posts = [];
    const fetch = async (url, init) => (posts.push(JSON.parse(init.body).text), { ok: true });
    await fleet.main(["--sample", "--webhook", "https://hooks.example/x"], { log: () => {}, fetch });
    expect(posts).to.have.length(1);
    expect(posts[0]).to.contain("*Rein shadow mode:* 7 payments from 2 of 2 agent wallets");
    await fleet.main(["--sample", "--since", "1m", "--webhook", "https://hooks.example/x"], { log: () => {}, fetch });
    expect(posts).to.have.length(1);
    await fleet.main(["--sample", "--since", "1m", "--always", "--webhook", "https://hooks.example/x"], { log: () => {}, fetch });
    expect(posts[1]).to.contain("nothing from 2 agent wallets would have been held in the last 1 minute");
  });

  it("reads a list of wallets from a file, and says which are too new to learn from", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rein-fleet-")), "wallets.csv");
    fs.writeFileSync(file, `address,label\n${AGENT},sample\nnot an address\n`);
    const out = path.join(path.dirname(file), "out");
    await fleet.main([file, "--since", "2026-07-30", "--out", out], { log: () => {}, fetch: sampleFetch() });
    const { results } = JSON.parse(fs.readFileSync(path.join(out, "fleet.json"), "utf8"));
    expect(results).to.have.length(1);
    expect(results[0].held.length).to.be.greaterThan(0);
    const young = fleet.shadow(sampleHistory(), { since: Date.parse("2026-07-01T12:00:00Z") / 1000 });
    expect(young.status).to.equal("too new");
  });

  it("is a rein command", async () => {
    const lines = [];
    const log = console.log;
    console.log = (l) => lines.push(l);
    try {
      expect(await rein.main(["fleet", "--sample"])).to.equal(0);
    } finally {
      console.log = log;
    }
    expect(lines.join("\n")).to.contain("Rein shadow mode");
  });
});
