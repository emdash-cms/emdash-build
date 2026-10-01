/** Drain every disjoint required setup branch before surfacing the first failure. */
export async function drainProvisionTasks(tasks: readonly Promise<unknown>[]): Promise<void> {
	const settled = await Promise.allSettled(tasks);
	const failure = settled.find(
		(result): result is PromiseRejectedResult => result.status === "rejected",
	);
	if (!failure) return;
	throw failure.reason instanceof Error
		? failure.reason
		: new Error(`Provision preparation failed: ${String(failure.reason)}`);
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The package.json fields that decide which dependencies are installed. */
const DEPENDENCY_FIELDS = [
	"dependencies",
	"devDependencies",
	"optionalDependencies",
	"peerDependencies",
	"pnpm",
	"overrides",
	"resolutions",
];

/**
 * Reads the scaffold's package.json on stdin and the site's at argv[1], and
 * exits 0 when their dependency fields match. A dependency added without
 * pnpm leaves the lockfile as it was.
 */
const SAME_DEPENDENCIES_SCRIPT = [
	'const { readFileSync } = require("node:fs");',
	`const fields = ${JSON.stringify(DEPENDENCY_FIELDS)};`,
	"const pick = (text) => JSON.stringify(fields.map((field) => JSON.parse(text)[field] ?? null));",
	"try {",
	'  process.exit(pick(readFileSync(0, "utf8")) === pick(readFileSync(process.argv[1], "utf8")) ? 0 : 1);',
	"} catch {",
	"  process.exit(1);",
	"}",
].join(" ");

/**
 * Restore installed dependencies from the image's prepared scaffold archive
 * when the restored site still depends on exactly the scaffold's packages,
 * instead of downloading every package again: the image keeps no package
 * store. Its lockfile and its package.json dependency fields must match the
 * scaffold's. The scaffold's own files beside the archive save decompressing
 * the archive twice; older images fall back to the copies inside it. Exits 0
 * when reused, 1 when the dependencies differ, and 2 when extraction failed or
 * ran out of time (any partial `node_modules` is removed); pnpm install
 * handles the rest.
 */
export function preparedDependenciesCommand(
	archive: string,
	sitePath: string,
	preparedLockfile?: string,
): string {
	const lockfile = shellQuote(`${sitePath}/pnpm-lock.yaml`);
	const nodeModules = shellQuote(`${sitePath}/node_modules`);
	const prepared = (name: string) =>
		preparedLockfile
			? `${preparedLockfile.slice(0, preparedLockfile.lastIndexOf("/"))}/${name}`
			: undefined;
	const fromArchive = (name: string) => `tar -xzOf ${shellQuote(archive)} ./${name} 2>/dev/null`;
	const scaffoldFile = (name: string) => {
		const beside = prepared(name);
		return beside
			? `{ if [ -f ${shellQuote(beside)} ]; then cat ${shellQuote(beside)}; else ${fromArchive(name)}; fi; }`
			: fromArchive(name);
	};
	const sameLockfile = `${scaffoldFile("pnpm-lock.yaml")} | cmp -s - ${lockfile}`;
	const sameDependencies =
		`${scaffoldFile("package.json")} | node -e ${shellQuote(SAME_DEPENDENCIES_SCRIPT)} ` +
		shellQuote(`${sitePath}/package.json`);
	return (
		`if ${sameLockfile} && ${sameDependencies}; then ` +
		`timeout --signal=TERM --kill-after=5s 170s tar -xzf ${shellQuote(archive)} -C ${shellQuote(sitePath)} ./node_modules || ` +
		`{ rm -rf ${nodeModules}; exit 2; }; else exit 1; fi`
	);
}
