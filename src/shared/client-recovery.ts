import type { UIMessage } from "ai";
import type { InitialGeneration } from "./initial-generation.js";

export interface ClientRecoveryState {
	messages: UIMessage[];
	turnActive: boolean;
	initialGeneration?: InitialGeneration;
}

export type DeliveryStatus = "received" | "not-received" | "unknown";
export type StopStatus = "stopped" | "pending" | "unknown";

/** Read durable agent state after a connection failure, with two short reconnect attempts. */
export async function readClientRecoveryState(
	load: () => Promise<ClientRecoveryState>,
	delays: readonly number[] = [150, 500],
): Promise<ClientRecoveryState | undefined> {
	for (let attempt = 0; ; attempt += 1) {
		try {
			return await load();
		} catch {
			if (attempt >= delays.length) return undefined;
			await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
		}
	}
}

export function messageDeliveryStatus(
	state: ClientRecoveryState | undefined,
	messageId: string,
): DeliveryStatus {
	if (!state) return "unknown";
	if (state.messages.some((message) => message.id === messageId)) return "received";
	// The request may have reached the turn queue before its message became
	// visible. Only an idle durable agent can prove the message was not received.
	return state.turnActive ? "unknown" : "not-received";
}

export function stopDeliveryStatus(
	state: ClientRecoveryState | undefined,
	generationId: string | undefined,
): StopStatus {
	if (!state) return "unknown";
	const generation = state.initialGeneration;
	if (
		generationId &&
		generation?.id === generationId &&
		["ready", "stopped", "failed"].includes(generation.status)
	) {
		return "stopped";
	}
	if (state.turnActive) return "pending";
	if (!generationId || !generation || generation.id !== generationId) return "stopped";
	return "pending";
}
