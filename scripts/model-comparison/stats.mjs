// Small nonparametric statistics for a randomized complete block design.

export function quantile(values, q) {
	const sorted = [...values].sort((a, b) => a - b);
	if (sorted.length === 0) return NaN;
	const position = (sorted.length - 1) * q;
	const low = Math.floor(position);
	const high = Math.ceil(position);
	return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

export const median = (values) => quantile(values, 0.5);
export const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

/** Ranks 1..n, ties sharing their average rank. */
export function ranks(values) {
	const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
	const result = new Array(values.length);
	for (let i = 0; i < order.length; ) {
		let j = i;
		while (j + 1 < order.length && order[j + 1].value === order[i].value) j += 1;
		const rank = (i + j) / 2 + 1;
		for (let k = i; k <= j; k += 1) result[order[k].index] = rank;
		i = j + 1;
	}
	return result;
}

// Regularized upper incomplete gamma Q(a, x), Numerical Recipes gammq.
function gammaLn(x) {
	const c = [
		76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155,
		0.1208650973866179e-2, -0.5395239384953e-5,
	];
	let y = x;
	const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
	let ser = 1.000000000190015;
	for (const coefficient of c) ser += coefficient / ++y;
	return -tmp + Math.log((2.5066282746310005 * ser) / x);
}
function gammaQ(a, x) {
	if (x <= 0) return 1;
	if (x < a + 1) {
		let sum = 1 / a;
		let term = sum;
		for (let n = 1; n < 500; n += 1) {
			term *= x / (a + n);
			sum += term;
			if (Math.abs(term) < Math.abs(sum) * 1e-14) break;
		}
		return 1 - sum * Math.exp(-x + a * Math.log(x) - gammaLn(a));
	}
	let b = x + 1 - a;
	let c = 1 / 1e-300;
	let d = 1 / b;
	let h = d;
	for (let i = 1; i < 500; i += 1) {
		const an = -i * (i - a);
		b += 2;
		d = an * d + b;
		if (Math.abs(d) < 1e-300) d = 1e-300;
		c = b + an / c;
		if (Math.abs(c) < 1e-300) c = 1e-300;
		d = 1 / d;
		const delta = d * c;
		h *= delta;
		if (Math.abs(delta - 1) < 1e-14) break;
	}
	return Math.exp(-x + a * Math.log(x) - gammaLn(a)) * h;
}
export const chiSquareSurvival = (x, df) => gammaQ(df / 2, x / 2);

/**
 * Friedman test. `rows` is one array per block holding one value per
 * treatment, in the same treatment order. Higher values get higher ranks.
 */
export function friedman(rows) {
	const n = rows.length;
	const k = rows[0]?.length ?? 0;
	const rankSums = new Array(k).fill(0);
	let tieCorrection = 0;
	for (const row of rows) {
		ranks(row).forEach((rank, j) => (rankSums[j] += rank));
		for (const group of Map.groupBy(row, (value) => value).values()) {
			tieCorrection += group.length ** 3 - group.length;
		}
	}
	const sumSquares = rankSums.reduce((sum, value) => sum + value ** 2, 0);
	const raw = (12 / (n * k * (k + 1))) * sumSquares - 3 * n * (k + 1);
	const denominator = 1 - tieCorrection / (n * (k ** 3 - k));
	const statistic = denominator > 0 ? raw / denominator : 0;
	return {
		n,
		k,
		statistic,
		p: chiSquareSurvival(statistic, k - 1),
		meanRanks: rankSums.map((sum) => sum / n),
		kendallW: n > 0 && k > 1 ? statistic / (n * (k - 1)) : NaN,
	};
}

/** Exact two-sided Wilcoxon signed-rank test on paired differences (zeros dropped). */
export function wilcoxonSignedRank(differences) {
	const nonzero = differences.filter((value) => value !== 0);
	const n = nonzero.length;
	if (n === 0) return { n, statistic: 0, p: 1 };
	const absoluteRanks = ranks(nonzero.map(Math.abs));
	const positive = absoluteRanks.reduce((sum, rank, i) => sum + (nonzero[i] > 0 ? rank : 0), 0);
	const total = absoluteRanks.reduce((sum, rank) => sum + rank, 0);
	const observed = Math.min(positive, total - positive);
	let extreme = 0;
	for (let mask = 0; mask < 2 ** n; mask += 1) {
		let sum = 0;
		for (let i = 0; i < n; i += 1) if (mask & (1 << i)) sum += absoluteRanks[i];
		if (Math.min(sum, total - sum) <= observed + 1e-9) extreme += 1;
	}
	return { n, statistic: positive, p: Math.min(1, extreme / 2 ** n) };
}

/** Holm step-down adjustment, returned in the input order. */
export function holm(pValues) {
	const order = pValues.map((p, index) => ({ p, index })).sort((a, b) => a.p - b.p);
	const adjusted = new Array(pValues.length);
	let running = 0;
	order.forEach(({ p, index }, rank) => {
		running = Math.max(running, Math.min(1, p * (pValues.length - rank)));
		adjusted[index] = running;
	});
	return adjusted;
}

export function spearman(a, b) {
	const ra = ranks(a);
	const rb = ranks(b);
	const ma = mean(ra);
	const mb = mean(rb);
	let num = 0;
	let da = 0;
	let db = 0;
	for (let i = 0; i < ra.length; i += 1) {
		num += (ra[i] - ma) * (rb[i] - mb);
		da += (ra[i] - ma) ** 2;
		db += (rb[i] - mb) ** 2;
	}
	return num / Math.sqrt(da * db);
}

function permutations(items) {
	if (items.length <= 1) return [items];
	return items.flatMap((item, i) =>
		permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
	);
}

/**
 * Exact Friedman p-value: under the null hypothesis every block's observed
 * ranks are equally likely in any order. Exact over the rank-sum distribution,
 * so small n needs no chi-square approximation; ties keep their midranks.
 */
export function friedmanExactP(rows) {
	const n = rows.length;
	const k = rows[0]?.length ?? 0;
	const observed = friedman(rows);
	let tieCorrection = 0;
	let distribution = new Map([[new Array(k).fill(0).join(","), 1]]);
	for (const row of rows) {
		for (const group of Map.groupBy(row, (value) => value).values()) {
			tieCorrection += group.length ** 3 - group.length;
		}
		const orders = permutations(ranks(row));
		const next = new Map();
		for (const [key, probability] of distribution) {
			const sums = key.split(",").map(Number);
			for (const order of orders) {
				const nextKey = sums.map((sum, j) => sum + order[j]).join(",");
				next.set(nextKey, (next.get(nextKey) ?? 0) + probability / orders.length);
			}
		}
		distribution = next;
	}
	const denominator = 1 - tieCorrection / (n * (k ** 3 - k));
	// Every block fully tied: no ordering is more extreme than another.
	if (denominator <= 0) return 1;
	let p = 0;
	for (const [key, probability] of distribution) {
		const sumSquares = key.split(",").reduce((sum, value) => sum + Number(value) ** 2, 0);
		const statistic = ((12 / (n * k * (k + 1))) * sumSquares - 3 * n * (k + 1)) / denominator;
		if (statistic >= observed.statistic - 1e-9) p += probability;
	}
	return Math.min(1, p);
}
