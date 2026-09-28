import { pruneMessages, type ModelMessage } from "ai";

export function compactFollowUpContext(messages: ModelMessage[]): ModelMessage[] {
	let latestUserIndex = -1;
	for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
		if (messages[messageIndex]?.role !== "user") continue;
		latestUserIndex = messageIndex;
		break;
	}
	if (latestUserIndex < 0) return messages;
	return [
		...pruneMessages({
			messages: messages.slice(0, latestUserIndex),
			reasoning: "all",
			toolCalls: "all",
			emptyMessages: "remove",
		}),
		...messages.slice(latestUserIndex),
	];
}
