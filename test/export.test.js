const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const exporter = require("../v2/export");

describe("v2/export", () => {
  const policy = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "v2", "out", "policy.json"), "utf8"));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "rein-export-"));
  const r = exporter.run(["--out", out, "--addresses", path.join(__dirname, "..", "v2", "addresses.json")]);

  it("converts amounts with exact integer arithmetic", () => {
    expect(exporter.units(4002, 6)).to.equal(4002000000n);
    expect(exporter.units("0.5", 6)).to.equal(500000n);
    expect(exporter.units("1.2345678", 6)).to.equal(1234567n);
  });

  it("writes all four files", () => {
    for (const f of ["turnkey.json", "coinbase.json", "privy.json", "export.md"]) expect(fs.existsSync(path.join(out, f))).to.equal(true);
  });

  it("Turnkey: one allow policy per contract function, selectors and payees in the condition, no increaseAllowance", () => {
    const names = r.turnkey.map((p) => p.policyName);
    expect(names).to.include("Rein: transfer on USDT").and.include("Rein: approve on USDT").and.include("Rein: swapExact on Router");
    expect(names.join(" ")).to.not.include("increaseAllowance");
    const t = r.turnkey.find((p) => p.policyName === "Rein: transfer on USDT");
    expect(t.effect).to.equal("EFFECT_ALLOW");
    expect(t.condition).to.include("eth.tx.data[0..4] == '0xa9059cbb'").and.include("'<Supplier B>'").and.include("eth.tx.value <= 0");
    const a = r.turnkey.find((p) => p.policyName === "Rein: approve on USDT");
    expect(a.condition).to.include("contract_call_args['value'] <= 500000000");
  });

  it("Coinbase: accept rules with evmAddress, ethValue and evmData criteria", () => {
    expect(r.coinbase.scope).to.equal("project");
    const usdt = r.coinbase.rules.find((x) => x.criteria.some((c) => c.type === "evmAddress" && c.addresses[0] === "0xdAC17F958D2ee523a2206206994597C13D831ec7"));
    const data = usdt.criteria.find((c) => c.type === "evmData");
    const transfer = data.conditions.find((c) => c.function === "transfer");
    expect(transfer.params.find((p) => p.name === "to").values).to.include("<Payroll>");
    expect(transfer.params.find((p) => p.name === "value").value).to.equal("4002000000");
    expect(data.conditions.find((c) => c.function === "approve").params.find((p) => p.name === "value").value).to.equal("500000000");
  });

  it("Privy: a rolling-window aggregation per token, referenced by the transfer rule, default deny", () => {
    expect(r.privy.default_action).to.equal("DENY");
    const agg = r.privy.aggregations.find((a) => a.id === "rein_usdt_window");
    expect(agg.window).to.equal(3600);
    const rule = r.privy.rules.find((x) => x.name.startsWith("Rein: USDT transfers"));
    const ref = rule.conditions.find((c) => c.field_source === "reference");
    expect(ref.field).to.equal("aggregation.rein_usdt_window");
    expect(BigInt(ref.value)).to.equal(4002000000n);
    expect(rule.conditions.find((c) => c.field === "transfer.to").value).to.include("<Supplier A>");
  });

  it("says what each vendor cannot hold", () => {
    const md = fs.readFileSync(path.join(out, "export.md"), "utf8");
    expect(md).to.include("| rolling spend window | no: stateless; per-call only | no: per-call ceiling instead | yes (stateful aggregation) |");
    expect(md).to.include("| intent required | no | no | no |");
  });
});
