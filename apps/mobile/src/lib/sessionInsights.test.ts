import { describe, expect, it } from "vite-plus/test";

import { contextPercent, formatPercent, formatTokens, formatUsd } from "./sessionInsights";

describe("the Context & usage sheet's numbers", () => {
  it("reads tokens the way the terminal does, through B and T", () => {
    expect(formatTokens(45_200)).toBe("45k");
    expect(formatTokens(105_426_086)).toBe("105M");
    expect(formatTokens(1_400_000_000)).toBe("1.4B");
    expect(formatTokens(2_100_000_000_000)).toBe("2.1T");
  });

  it("knows how full the context is, and when it cannot tell", () => {
    expect(contextPercent(50_000, 200_000)).toBe(25);
    expect(contextPercent(300_000, 200_000)).toBe(100);
    expect(contextPercent(1_000, 0)).toBeNull();
    expect(formatPercent(0.4)).toBe("0.4%");
    expect(formatPercent(23.4)).toBe("23%");
  });

  it("prints spend at a readable precision", () => {
    expect(formatUsd(12.345)).toBe("$12.35");
    expect(formatUsd(0.0421)).toBe("$0.042");
    expect(formatUsd(0.00123)).toBe("$0.0012");
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(1.5, true)).toBe("~$1.50");
  });
});
