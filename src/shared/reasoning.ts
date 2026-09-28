export const REASONING_METADATA_NAMESPACE = "emdash";
export const REASONING_DURATION_FIELD = "reasoningDurationMs";

export function getReasoningDurationMs(part: {
	providerMetadata?: Record<string, Record<string, unknown> | undefined>;
}): number | undefined {
	const duration =
		part.providerMetadata?.[REASONING_METADATA_NAMESPACE]?.[REASONING_DURATION_FIELD];
	return typeof duration === "number" && Number.isFinite(duration) && duration >= 0
		? duration
		: undefined;
}
