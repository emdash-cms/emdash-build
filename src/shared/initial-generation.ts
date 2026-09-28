export type InitialGenerationStatus =
	| "preparing"
	| "awaiting_answers"
	| "building"
	| "checking"
	| "stopping"
	| "ready"
	| "stopped"
	| "failed";

/** Durable identity for the first site generation, anchored to its opening brief. */
export interface InitialGeneration {
	id: string;
	status: InitialGenerationStatus;
	/** Accepted capture ID; the bounded stored PNG may be unavailable. */
	previewShotId?: string;
	/** Last user message at an explicit Stop; only a newer message can resume. */
	terminalMessageId?: string;
}

/** The first build is underway: preparing, building, or checking the site. */
export function isInitialGenerationActive(status: InitialGenerationStatus): boolean {
	return (
		status === "preparing" ||
		status === "building" ||
		status === "checking" ||
		status === "stopping"
	);
}
