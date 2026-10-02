// Security red-team of `rein safe` (security/red-team-0.1.1.md): each case
// read "Looks normal", or lost or faked an alert, before the fix.
const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ethers } = require("ethers");
const safe = require("../scan/safe");

const SAFE = ethers.getAddress("0x5afe00000000000000000000000000000000cafe");
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const JUNK = "0x00000000000000000000000000000000000a11ce";
const who = (l) => ethers.getAddress(ethers.dataSlice(ethers.id(`rt: ${l}`), 12));
const VENDOR = who("vendor paid every month");
const ATTACKER = who("attacker's plain address");
const OWNERS = [who("owner a"), who("owner b")];
const I = new ethers.Interface(["function transfer(address,uint256)", "function increaseAllowance(address,uint256)", "function setApprovalForAll(address,bool)", "function approve(address,address,uint160,uint48)", "function disperseToken(address,address[],uint256[])"]);
const usdc = (n) => ethers.parseUnits(String(n), 6);
const DAY = 86400e3;
const T0 = Date.parse("2026-09-30T00:00:00Z");
const usdcToken = { address_hash: USDC, symbol: "USDC", name: "USD Coin", decimals: "6", type: "ERC-20", exchange_rate: "1.0", reputation: "ok" };
const junk = (sym = "GM", addr = JUNK) => ({ address_hash: addr, symbol: sym, name: sym, decimals: "6", type: "ERC-20", exchange_rate: null, reputation: "ok" });
const xfer = (i, to, token, raw, ts) => ({ transaction_hash: ethers.id(`rt tx ${i}`), timestamp: new Date(ts).toISOString(), block_number: 1, from: { hash: SAFE }, to: typeof to === "string" ? { hash: to } : to, token, total: { value: String(raw), decimals: "6" } });
const look = (a, pre, suf, fill) => ethers.getAddress(`0x${a.slice(2, 2 + pre)}${fill.repeat(40 - pre - suf)}${a.slice(42 - suf)}`.toLowerCase());

function history(extra = []) {
  const tokenTransfers = [];
  let i = 0;
  for (let m = 0; m < 12; m++) tokenTransfers.push(xfer(i++, VENDOR, usdcToken, usdc(4000), T0 - (m + 1) * 30 * DAY));
  for (let k = 0; k < 30; k++) tokenTransfers.push(xfer(i++, who(`regular ${k % 5}`), usdcToken, usdc(900), T0 - (k + 2) * 7 * DAY));
  tokenTransfers.push(...extra);
  tokenTransfers.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  return { chain: "base", address: SAFE, info: { exchange_rate: "2500" }, transactions: [], tokenTransfers, tokenBalances: [], truncated: false };
}
const service = (queue) => ({ info: async () => ({ nonce: 1, threshold: 2, owners: OWNERS }), queue: async () => queue, executed: async () => [] });
const qtx = (n, o) => ({ nonce: n, safeTxHash: `0x${n.toString(16).padStart(2, "0")}`, confirmations: [{}], confirmationsRequired: 2, value: "0", operation: 0, data: "0x", ...o });
const pay = (to, n) => ({ to: USDC, data: I.encodeFunctionData("transfer", [to, usdc(n)]) });
const levels = (q) => q.found.map((f) => f.level);
const run = (queue, hist = history(), o = {}) => safe.watchOnce(SAFE, { safeApi: service(queue), history: hist, ethPaid: [], executed: [], remember: false, ...o });

describe("rein safe, red-teamed", function () {
  it("won't let one fake transfer in a junk token vouch for a USDC payment to the same address", async () => {
    const r = await run([qtx(1, pay(ATTACKER, 250000))], history([xfer(900, ATTACKER, junk(), 1, T0 - DAY)]));
    expect(levels(r.queue[0])).to.include("warn");
    expect(r.queue[0].found[0].why).to.contain("never paid");
  });

  it("catches a poisoner's lookalike that matches 3 and 5 characters, not only 4 and 4", async () => {
    const L = look(VENDOR, 3, 5, "8");
    const r = await run([qtx(1, pay(L, 4000))], history([xfer(950, L, junk("USDC", "0x00000000000000000000000000000000000c0c00"), 4000e6, T0 - DAY)]));
    expect(levels(r.queue[0])).to.include("danger");
  });

  it("still flags a lookalike after a flood of fake transfers pushes the real payee out of the window", async () => {
    const L = look(VENDOR, 4, 4, "7");
    const flood = Array.from({ length: 1000 }, (_, k) => xfer(2000 + k, who(`flood ${k}`), junk(), 1, T0 - 1000 * k));
    const h = history([...flood, xfer(5000, L, junk(), 1, T0 - 2000 * 1000)]);
    h.tokenTransfers = h.tokenTransfers.slice(0, 999).concat(h.tokenTransfers.find((t) => t.to.hash === L));
    h.truncated = true;
    const r = await run([qtx(1, pay(L, 4000))], h);
    expect(r.queue[0].found.length).to.be.greaterThan(0);
    expect(safe.text(r)).to.contain("newest part of this Safe's history");
  });

  it("won't let a lookalike seeded by a junk transfer make a legitimate new payee read Don't sign yet", async () => {
    const NEW = who("legit new contractor");
    const r = await run([qtx(1, pay(NEW, 5000))], history([xfer(901, look(NEW, 4, 4, "1"), junk(), 1, T0 - DAY)]));
    expect(levels(r.queue[0])).to.not.include("danger");
  });

  it("flags a gas refund to a stranger hidden behind a small usual payment", async () => {
    const r = await run([qtx(1, { ...pay(VENDOR, 10), safeTxGas: "0", baseGas: "1000000000000", gasPrice: "1", gasToken: USDC, refundReceiver: ATTACKER })]);
    expect(levels(r.queue[0])).to.include("danger");
    expect(r.queue[0].found[0].why).to.contain("gas refund").and.contain(ATTACKER);
  });

  it("reads ETH sent along with calldata as a payment", async () => {
    const r = await run([qtx(1, { to: ATTACKER, value: ethers.parseEther("100").toString(), data: "0xdeadbeef" })]);
    expect(r.queue[0].what).to.contain("pay 100 ETH");
    expect(levels(r.queue[0])).to.include("warn");
  });

  it("reads increaseAllowance, Permit2 approve and setApprovalForAll as approvals", async () => {
    const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
    const r = await run([
      qtx(1, { to: USDC, data: I.encodeFunctionData("increaseAllowance", [ATTACKER, usdc(1e6)]) }),
      qtx(2, { to: PERMIT2, data: I.encodeFunctionData("approve", [USDC, ATTACKER, usdc(1e6), 2 ** 40]) }),
      qtx(3, { to: who("nft"), data: I.encodeFunctionData("setApprovalForAll", [ATTACKER, true]) }),
    ]);
    for (const q of r.queue) expect(q.what).to.contain(`let ${ATTACKER} spend`), expect(levels(q)).to.include("warn");
  });

  it("reads each payout of a Disperse batch as a payment", async () => {
    const r = await run([qtx(1, { to: "0xD152f549545093347A162Dce210e7293f1452150", data: I.encodeFunctionData("disperseToken", [USDC, [VENDOR, ATTACKER], [usdc(4000), usdc(250000)]]) })]);
    expect(r.queue[0].what).to.contain("pay 250,000 USDC to");
    expect(r.queue[0].found.map((f) => f.why).join()).to.contain(`never paid ${ATTACKER}`);
  });

  it("adds up first payments to one stranger across the whole queue", async () => {
    const r = await run(Array.from({ length: 30 }, (_, k) => qtx(k + 1, pay(ATTACKER, 990))));
    expect(r.queue.every((q) => levels(q).includes("warn"))).to.equal(true);
    expect(r.queue[0].found[0].why).to.contain("30 transactions").and.contain("$30k in all");
  });

  it("shows the address next to any label, and keeps chain text from acting in Slack or Discord", async () => {
    const h = history([xfer(900, { hash: ATTACKER, name: "<https://evil.example|Coinbase Prime>" }, junk(), 1, T0 - DAY), xfer(901, { hash: VENDOR, name: "@everyone <!channel>" }, usdcToken, usdc(10), T0 - 2 * DAY)]);
    const r = await run([qtx(1, pay(ATTACKER, 250000)), qtx(2, pay(VENDOR, 20000))], h);
    expect(r.queue[0].what).to.contain(ATTACKER).and.not.contain("evil.example");
    const sent = [];
    await safe.main(["--sample", "--webhook", "https://hooks.example/x"], { log: () => {}, fetch: async (u, init) => (sent.push(JSON.parse(init.body)), { ok: true, status: 200 }) });
    expect(sent[0].allowed_mentions).to.deep.equal({ parse: [] });
    expect(sent[0].text).to.not.match(/<[^>]*>/);
    const tg = [];
    await safe.main(["--sample", "--webhook", "https://api.telegram.org/botX/sendMessage?chat_id=1"], { log: () => {}, fetch: async (u, init) => (tg.push(JSON.parse(init.body)), { ok: true, status: 200 }) });
    expect(tg[0].text).to.not.contain("&amp;").and.not.contain("&lt;"); // Telegram shows text as it is
  });

  it("cleans text from Safe's service and the explorer before the terminal or the webhook sees it", async () => {
    const ODD = "0x00000000000000000000000000000000000b0b00";
    const evil = "US\u001b]52;c;MHhhdHRhY2tlcg==\u0007DC\u202e";
    const tx = qtx(1, { ...pay(ATTACKER, 250000), to: ODD, tokens: [{ address: ODD, symbol: evil, decimals: 6 }], dataDecoded: { method: "transfer\u001b[2J", parameters: [] } });
    const h = history([xfer(902, { hash: VENDOR, name: "Payroll\u001b[31m\u2066" }, usdcToken, usdc(10), T0 - 2 * DAY)]);
    const r = await run([tx, qtx(2, pay(VENDOR, 40000))], h);
    const out = safe.text(r);
    expect(out).to.not.match(/[\u0000-\u0009\u000b-\u001f\u202a-\u202e\u2066-\u2069]/);
    expect(out).to.contain("\ufffd");
    // The webhook posts alertText: the same cleaned text.
    expect(r.fresh.length).to.be.greaterThan(0);
    expect(safe.alertText(r)).to.not.match(/[\u001b\u0007\u202e\u2066]/);
  });

  it("keeps an alert it couldn't post, so the next check posts it", async () => {
    const env = { REIN_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "rein-rt-")) };
    const q = [qtx(1, pay(ATTACKER, 250000))];
    const a = await run(q, history(), { remember: true, env, defer: true });
    expect(a.fresh.length).to.equal(1); // the post failed: no commit
    const b = await run(q, history(), { remember: true, env, defer: true });
    expect(b.fresh.length).to.equal(1);
    b.commit();
    expect((await run(q, history(), { remember: true, env, defer: true })).fresh.length).to.equal(0);
  });
});
