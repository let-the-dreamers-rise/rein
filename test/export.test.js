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

  const lastBody = (plan) => plan.steps[plan.steps.length - 1].request.body;
  const stepTo = (plan, url) => plan.steps.find((s) => s.request.url.endsWith(url));

  it("Turnkey: the ABI upload first, then one allow policy whose branches cover every contract function", () => {
    const upload = stepTo(r.turnkey, "/create_smart_contract_interface");
    expect(upload.request.body.type).to.equal("ACTIVITY_TYPE_CREATE_SMART_CONTRACT_INTERFACE");
    expect(upload.request.body.parameters.smartContractAddress).to.equal("0xdac17f958d2ee523a2206206994597c13d831ec7");
    const create = stepTo(r.turnkey, "/create_policy").request.body;
    expect(create.type).to.equal("ACTIVITY_TYPE_CREATE_POLICY_V3");
    expect(create.organizationId).to.equal("{{turnkey_organization_id}}");
    const p = create.parameters;
    expect(p.effect).to.equal("EFFECT_ALLOW");
    expect(p.notes).to.be.a("string").and.not.equal("");
    expect(r.turnkey.covers).to.include("transfer on USDT").and.include("approve on USDT").and.include("swapExact on Router");
    expect(r.turnkey.covers.join(" ")).to.not.include("increaseAllowance");
    // data carries its 0x, so a selector is ten characters; addresses are lowercase.
    expect(p.condition).to.include("eth.tx.data[0..10] == '0xa9059cbb'").and.not.include("data[0..4]");
    expect(p.condition).to.include("eth.tx.to == '0xdac17f958d2ee523a2206206994597c13d831ec7'").and.include("eth.tx.chain_id == 8453");
    // A transfer is capped per call, not only an approval.
    const transfer = p.condition.split(" || ").find((c) => c.includes("0xa9059cbb"));
    expect(transfer).to.include("contract_call_args['to'] in [").and.include("contract_call_args['value'] <= 3750000000");
    expect(p.condition).to.include("contract_call_args['value'] <= 500000000");
  });

  it("Coinbase: an account policy with one rule per function and operation, then the attach", () => {
    const body = r.coinbase.steps[0].request.body;
    expect(body.scope).to.equal("account");
    expect(body.description).to.match(/^[A-Za-z0-9 ,.]{1,50}$/);
    expect(JSON.stringify(body)).to.not.include('"note"');
    for (const rule of body.rules) {
      const data = rule.criteria.find((c) => c.type === "evmData");
      if (data) expect(data.conditions).to.have.length(1);
    }
    const ops = new Set(body.rules.map((x) => x.operation));
    expect([...ops]).to.have.members(["signEvmTransaction", "sendEvmTransaction"]);
    const send = body.rules.find((x) => x.operation === "sendEvmTransaction");
    expect(send.criteria[0]).to.deep.equal({ type: "evmNetwork", networks: ["base"], operator: "in" });
    const transfer = body.rules.find((x) => x.operation === "signEvmTransaction" && x.criteria.some((c) => c.type === "evmData" && c.conditions[0].function === "transfer"));
    const params = transfer.criteria.find((c) => c.type === "evmData").conditions[0].params;
    expect(params.find((p) => p.name === "to").values).to.include("<Payroll>");
    expect(params.find((p) => p.name === "value").value).to.equal("3750000000");
    expect(r.coinbase.steps[1].request).to.include({ method: "PUT" });
    expect(r.coinbase.steps[1].request.body).to.deep.equal({ accountPolicy: "{{policy.id}}" });
  });

  it("Privy: the window created first, the policy referencing it by returned id, on signing requests, then attached", () => {
    const [agg, pol, attach] = r.privy.steps;
    expect(agg.request.url).to.equal("https://api.privy.io/v1/aggregations");
    expect(agg.request.body.window).to.deep.equal({ type: "rolling", seconds: 3600 });
    expect(agg.request.body.method).to.equal("eth_signTransaction");
    expect(agg.request.body).to.not.have.property("id");
    const body = pol.request.body;
    expect(body).to.not.have.property("aggregations");
    expect(body).to.not.have.property("default_action");
    const rule = body.rules.find((x) => x.name.startsWith("USDT to known payees"));
    expect(rule.method).to.equal("eth_signTransaction");
    const ref = rule.conditions.find((c) => c.field_source === "reference");
    expect(ref.field).to.equal(`aggregation.{{${agg.returns}.id}}`);
    expect(BigInt(ref.value)).to.equal(4002000000n);
    expect(rule.conditions.find((c) => c.field === "chain_id").value).to.equal("8453");
    expect(rule.conditions.find((c) => c.field === "transfer.to").value).to.include("<Supplier A>");
    expect(attach.request).to.include({ method: "PATCH", url: "https://api.privy.io/v1/wallets/{{privy_wallet_id}}" });
    expect(attach.request.body).to.deep.equal({ policy_ids: ["{{policy.id}}"] });
  });

  it("writes user-operation rules for a smart wallet", () => {
    const smart = exporter.run(["--out", out, "--addresses", path.join(__dirname, "..", "v2", "addresses.json"), "--smart"]);
    expect(smart.privy.steps[0].request.body.method).to.equal("eth_signUserOperation");
    expect(new Set(smart.coinbase.steps[0].request.body.rules.map((x) => x.operation))).to.deep.equal(new Set(["prepareUserOperation", "sendUserOperation"]));
    exporter.run(["--out", out, "--addresses", path.join(__dirname, "..", "v2", "addresses.json")]);
  });

  it("says what each vendor cannot hold", () => {
    const md = fs.readFileSync(path.join(out, "export.md"), "utf8");
    expect(md).to.include("| rolling spend window | yes (velocity controls; Rein does not write them yet) | no: per transaction only | yes (aggregation, signing requests only) |");
    expect(md).to.include("| intent required | no | no | no |");
  });
});
