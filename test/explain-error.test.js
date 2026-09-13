const { expect } = require("chai");
const { explainError } = require("../scripts/explain-error");

describe("scripts/explain-error", () => {
  it("names the fix for the failures a first live run hits", () => {
    expect(explainError(new Error("insufficient funds for gas * price + value"))).to.include("preflight");
    expect(explainError(new Error("could not detect network (event=\"noNetwork\")"))).to.include("RPC");
    expect(explainError(new Error("No signer. Set PRIVATE_KEY in .env first."))).to.include(".env");
    expect(explainError(new Error("PolicyViolation(13)"))).to.equal(null);
  });
});
