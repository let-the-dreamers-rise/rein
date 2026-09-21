// The HTTP surface's own half: authentication, rate limiting and body limits.
//
// These are the parts that decide whether putting a spending key behind an HTTP
// endpoint is defensible at all, so they are tested without a chain -- they must
// hold even when everything downstream is broken.
const { expect } = require("chai");
const crypto = require("node:crypto");

describe("the HTTP surface", () => {
  const SECRET = "a".repeat(64);
  let api;

  beforeEach(() => {
    delete require.cache[require.resolve("../api/server")];
    process.env.REIN_API_TOKENS = `book-keeper:${SECRET}`;
    api = require("../api/server");
  });

  describe("tokens", () => {
    it("stores a digest, never the secret itself", () => {
      const table = api.loadTokens();
      const digest = crypto.createHash("sha256").update(SECRET).digest("hex");
      expect(table.get(digest)).to.equal("book-keeper");
      expect([...table.keys()]).to.not.include(SECRET);
    });

    it("refuses a token short enough to guess", () => {
      process.env.REIN_API_TOKENS = "weak:hunter2";
      expect(() => api.loadTokens()).to.throw(/24 characters/);
    });

    it("names the caller behind a valid bearer token", () => {
      const table = api.loadTokens();
      expect(api.identify(table, `Bearer ${SECRET}`)).to.equal("book-keeper");
      expect(api.identify(table, `bearer ${SECRET}`)).to.equal("book-keeper");
    });

    it("rejects a wrong, absent or malformed token", () => {
      const table = api.loadTokens();
      expect(api.identify(table, `Bearer ${"b".repeat(64)}`)).to.equal(null);
      expect(api.identify(table, "")).to.equal(null);
      expect(api.identify(table, undefined)).to.equal(null);
      expect(api.identify(table, SECRET)).to.equal(null); // no Bearer prefix
    });
  });

  describe("rate limiting", () => {
    it("limits paying far harder than asking", () => {
      let payAllowed = 0;
      let checkAllowed = 0;
      for (let i = 0; i < 200; i++) {
        if (api.withinLimit("caller-a", "pay")) payAllowed += 1;
        if (api.withinLimit("caller-a", "check")) checkAllowed += 1;
      }
      expect(payAllowed).to.equal(20);
      expect(checkAllowed).to.equal(120);
      // Asking is free on chain and stays cheap here: an agent that checks
      // before it acts is doing what the product wants and is not punished.
      expect(checkAllowed).to.be.greaterThan(payAllowed);
    });

    it("counts each caller separately", () => {
      for (let i = 0; i < 20; i++) api.withinLimit("caller-b", "pay");
      expect(api.withinLimit("caller-b", "pay")).to.equal(false);
      expect(api.withinLimit("caller-c", "pay")).to.equal(true);
    });
  });

  describe("the listening server", () => {
    let server;
    let base;

    beforeEach(async () => {
      server = api.createServer(api.loadTokens());
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      base = `http://127.0.0.1:${server.address().port}`;
    });

    afterEach(async () => {
      await new Promise((r) => server.close(r));
    });

    it("refuses an unauthenticated request before doing any work", async () => {
      const res = await fetch(`${base}/v1/budget`);
      expect(res.status).to.equal(401);
      expect((await res.json()).error).to.contain("bearer token");
    });

    it("404s an unknown endpoint without leaking what exists", async () => {
      const res = await fetch(`${base}/v1/admin`, { headers: { authorization: `Bearer ${SECRET}` } });
      expect(res.status).to.equal(404);
    });

    it("sets headers that stop a browser guessing at the body", async () => {
      const res = await fetch(`${base}/v1/budget`);
      expect(res.headers.get("x-content-type-options")).to.equal("nosniff");
      expect(res.headers.get("cache-control")).to.equal("no-store");
    });

    it("rejects a body that is not JSON", async () => {
      const res = await fetch(`${base}/v1/check`, {
        method: "POST",
        headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
        body: "{not json",
      });
      expect(res.status).to.equal(400);
      expect((await res.json()).error).to.contain("valid JSON");
    });

    it("rejects an oversized body rather than buffering it", async () => {
      const res = await fetch(`${base}/v1/check`, {
        method: "POST",
        headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
        body: JSON.stringify({ padding: "x".repeat(100_000) }),
      }).catch((e) => ({ status: 0, err: e }));
      // Either a 400 or a dropped connection is acceptable; silently accepting
      // 100 KB is not.
      expect([0, 400, 413]).to.include(res.status);
    });
  });
});
