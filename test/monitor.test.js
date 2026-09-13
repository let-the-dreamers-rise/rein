const { expect } = require("chai");
const monitor = require("../client/monitor");

// 2026-09-15 is a Tuesday. Timestamps are UTC seconds.
const TUE = Date.UTC(2026, 8, 15) / 1000;
const FRI = Date.UTC(2026, 8, 18) / 1000;
const at = (day, hour) => day + hour * 3600;

const policy = {
  sentences: [
    { text: "Calls only USDT", kind: "bound", enforced: "target allowlist" },
    { text: "Pays Supplier B on Tuesdays", kind: "learned", enforced: "monitor only",
      rule: { conditions: [["self", "pay"], ["weekday", "Tuesday"]], predicts: "payee", outcome: "Supplier B" } },
    { text: "Supplier A receives 100 to 500 in the morning", kind: "learned", enforced: "monitor only",
      rule: { conditions: [["self", "Supplier A"], ["hour", "morning"]], predicts: "amount", outcome: "100 to 500" } },
  ],
};

describe("client/monitor", () => {
  it("bands the world the way v2/compile.py does", () => {
    expect(monitor.bandHour(at(TUE, 5))).to.equal("night");
    expect(monitor.bandHour(at(TUE, 6))).to.equal("morning");
    expect(monitor.bandHour(at(TUE, 11))).to.equal("morning");
    expect(monitor.bandHour(at(TUE, 12))).to.equal("afternoon");
    expect(monitor.bandHour(at(TUE, 17))).to.equal("afternoon");
    expect(monitor.bandHour(at(TUE, 18))).to.equal("evening");
    expect(monitor.weekday(TUE)).to.equal("Tuesday");
    expect(monitor.weekday(FRI)).to.equal("Friday");
    expect(monitor.bandDay(Date.UTC(2026, 8, 3) / 1000)).to.equal("start of the month");
    expect(monitor.bandDay(Date.UTC(2026, 8, 4) / 1000)).to.equal("first half of the month");
    expect(monitor.bandDay(Date.UTC(2026, 8, 15) / 1000)).to.equal("first half of the month");
    expect(monitor.bandDay(Date.UTC(2026, 8, 16) / 1000)).to.equal("second half of the month");
    expect(monitor.bandAmount(99.99)).to.equal("under 100");
    expect(monitor.bandAmount(100)).to.equal("100 to 500");
    expect(monitor.bandAmount(499.99)).to.equal("100 to 500");
    expect(monitor.bandAmount(500)).to.equal("500 to 2,000");
    expect(monitor.bandAmount(1999.99)).to.equal("500 to 2,000");
    expect(monitor.bandAmount(2000)).to.equal("2,000 and over");
  });

  it("flags a fired sentence whose outcome differs, and nothing else", () => {
    const ok = { ts: at(TUE, 15), kind: "transfer", token: "USDT", payee: "Supplier B", amount: 60 };
    expect(monitor.flags(policy, ok)).to.deep.equal([]);

    const wrongPayee = { ts: at(TUE, 15), kind: "transfer", token: "USDT", payee: "Supplier C", amount: 60 };
    expect(monitor.flags(policy, wrongPayee)).to.deep.equal([
      { sentence: "Pays Supplier B on Tuesdays", expected: "Supplier B", actual: "Supplier C" },
    ]);

    // Not a Tuesday: the payee sentence does not fire, so paying C is not a flag.
    const friday = { ts: at(FRI, 15), kind: "transfer", token: "USDT", payee: "Supplier C", amount: 60 };
    expect(monitor.flags(policy, friday)).to.deep.equal([]);

    // Amount rules are pinned to a payee: Supplier A in the morning, wrong band.
    const big = { ts: at(FRI, 9), kind: "transfer", token: "USDT", payee: "Supplier A", amount: 900 };
    expect(monitor.flags(policy, big)).to.deep.equal([
      { sentence: "Supplier A receives 100 to 500 in the morning", expected: "100 to 500", actual: "500 to 2,000" },
    ]);
    // Same amount to a different payee: the Supplier A sentence does not fire.
    expect(monitor.flags(policy, { ...big, payee: "Supplier B" })).to.deep.equal([]);

    // Approvals and swaps carry no payee habit and are never flagged here.
    expect(monitor.flags(policy, { ts: at(TUE, 9), kind: "approve", token: "USDT", payee: "Router", amount: 500 })).to.deep.equal([]);
    expect(monitor.flags({ sentences: [] }, ok)).to.deep.equal([]);
  });
});
