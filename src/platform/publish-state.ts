export type PublishStage = "authentication-required" | "ready" | "publishing" | "live" | "failed";

export interface PublishState {
	stage: PublishStage;
	liveUrl?: string;
	releaseId?: string;
	publishedAt?: number;
	error?: string;
	reference?: string;
	progress?: string;
}

export type PublishEvent =
	| { type: "authenticated" }
	| { type: "started" }
	| { type: "progress"; message: string }
	| { type: "synced"; liveUrl: string; releaseId: string; publishedAt: number }
	| { type: "succeeded"; liveUrl: string; releaseId: string; publishedAt: number }
	| { type: "failed"; message: string; reference?: string };

export function reducePublishState(state: PublishState, event: PublishEvent): PublishState {
	switch (event.type) {
		case "authenticated":
			return state.stage === "authentication-required" ? { ...state, stage: "ready" } : state;
		case "started":
			return state.stage === "authentication-required" || state.stage === "publishing"
				? state
				: {
						...state,
						stage: "publishing",
						error: undefined,
						reference: undefined,
						progress: undefined,
					};
		case "progress":
			return state.stage === "publishing" && event.message
				? { ...state, progress: event.message }
				: state;
		case "synced":
			if (
				(state.stage === "publishing" || state.stage === "failed") &&
				state.releaseId === event.releaseId &&
				state.publishedAt === event.publishedAt
			)
				return state;
			return {
				stage: "live",
				liveUrl: event.liveUrl,
				releaseId: event.releaseId,
				publishedAt: event.publishedAt,
			};
		case "succeeded":
			return {
				stage: "live",
				liveUrl: event.liveUrl,
				releaseId: event.releaseId,
				publishedAt: event.publishedAt,
			};
		case "failed":
			return state.stage === "live"
				? state
				: {
						...state,
						stage: "failed",
						error: event.message,
						reference: event.reference,
						progress: undefined,
					};
	}
}
