// Checks the statistics against textbook values (scipy agrees on each).
import assert from "node:assert/strict";
import * as s from "./stats.mjs";
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-4, `${msg}: ${a} vs ${b}`);
const f = s.friedman([
	[10, 15, 12],
	[20, 25, 22],
	[30, 35, 32],
	[40, 45, 42],
]);
close(f.statistic, 8, "friedman Q");
close(f.p, Math.exp(-4), "friedman p");
close(f.kendallW, 1, "W");
const ft = s.friedman([
	[1, 1, 2],
	[2, 1, 3],
	[3, 2, 1],
]);
assert.ok(ft.p > 0 && ft.p <= 1, "ties ok");
close(s.wilcoxonSignedRank([1, 2, 3, 4, 5, 6, 7, 8, 9]).p, 2 / 512, "wilcoxon all positive");
close(s.wilcoxonSignedRank([-1, 2, 3, -4, 5]).p, 0.625, "wilcoxon mixed");
close(
	s.wilcoxonSignedRank([-1, -2, 3, 4, 5, 6, 7, 8, 9]).p,
	10 / 512,
	"7 of 9 wins with the two smallest losses is significant",
);
assert.ok(s.wilcoxonSignedRank([-1, 2, -3, 4, -5, 6, 7, 8, 9]).p > 0.05, "6 of 9 wins is not");
close(s.chiSquareSurvival(3.841459, 1), 0.05, "chi2 df1");
close(s.chiSquareSurvival(5.991465, 2), 0.05, "chi2 df2");
close(s.chiSquareSurvival(7.814728, 3), 0.05, "chi2 df3");
assert.deepEqual(
	s.holm([0.01, 0.04, 0.03]).map((v) => +v.toFixed(4)),
	[0.03, 0.06, 0.06],
);
close(s.spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1, "spearman");
close(s.median([3, 1, 2, 10]), 2.5, "median");
console.log("stats ok");
close(
	s.friedmanExactP([
		[10, 15, 12],
		[20, 25, 22],
		[30, 35, 32],
		[40, 45, 42],
	]),
	6 / 1296,
	"exact Friedman: all 4 blocks in one order (table value 0.0046)",
);
assert.equal(
	s.friedmanExactP([
		[1, 1, 1],
		[2, 2, 2],
	]),
	1,
	"all ties give p = 1",
);
console.log("exact Friedman ok");
