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
