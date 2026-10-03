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

/**
 * Restore installed dependencies from the image's prepared scaffold archive
 * when the restored site's lockfile is still the scaffold's, instead of
 * downloading every package again: the image keeps no package store. The
 * scaffold's own lockfile beside the archive saves decompressing the archive
 * twice; older images fall back to the copy inside it. Exits 0 when reused, 1
 * when the lockfile differs, and 2 when extraction failed or ran out of time
 * (any partial `node_modules` is removed); pnpm install handles the rest.
 */
export function preparedDependenciesCommand(
	archive: string,
	sitePath: string,
	preparedLockfile?: string,
): string {
	const lockfile = shellQuote(`${sitePath}/pnpm-lock.yaml`);
	const nodeModules = shellQuote(`${sitePath}/node_modules`);
	const fromArchive = `tar -xzOf ${shellQuote(archive)} ./pnpm-lock.yaml 2>/dev/null | cmp -s - ${lockfile}`;
	const sameLockfile = preparedLockfile
		? `{ if [ -f ${shellQuote(preparedLockfile)} ]; then cmp -s ${shellQuote(preparedLockfile)} ${lockfile}; else ${fromArchive}; fi; }`
		: fromArchive;
	return (
		`if ${sameLockfile}; then ` +
		`timeout --signal=TERM --kill-after=5s 170s tar -xzf ${shellQuote(archive)} -C ${shellQuote(sitePath)} ./node_modules || ` +
		`{ rm -rf ${nodeModules}; exit 2; }; else exit 1; fi`
	);
}
