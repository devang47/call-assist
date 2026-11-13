import { expect, it } from "vitest";
import { percentile, summarize } from "./latency.js";

it("nearest-rank percentiles", () => {
  const v = [500, 100, 400, 200, 300, 1000, 600, 700, 800, 900];
  expect(percentile(v, 50)).toBe(500);
  expect(percentile(v, 90)).toBe(900);
  expect(percentile(v, 99)).toBe(1000);
  expect(percentile([42], 90)).toBe(42);
  expect(summarize([])).toMatchObject({ n: 0, p50: NaN });
});
