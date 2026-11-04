/** Activity envelopes whose publishers can contribute to the primary chat journal. */
export const chatReplayProducerActivities = new Set([
	"runAgentIteration",
	"compactConversationHistoryActivity",
	"executeStep",
	"delegateToAgent",
	"executeAgentAsTool",
]);
