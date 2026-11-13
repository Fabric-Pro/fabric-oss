/**
 * One tool-node round that includes web research calls. Before anything
 * runs, each research call is decided in call order against the research
 * gate, the run's budget and the URLs this run's searches returned; a refused
 * call gets a ToolMessage built here and never reaches a tool or the network.
 * The cached `ToolNode` runs the remaining calls, and the research calls are
 * folded into the run's outcome, which goes back to graph state whole: no
 * counter lives anywhere else.
 */

import type { BaseMessage, ToolCall } from "@langchain/core/messages";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import type { ToolNode } from "@langchain/langgraph/prebuilt";
import { logger } from "@repo/logs";
import type { AgentState } from "../state";
import {
	emptyWebResearchOutcome,
	foldWebResearchCalls,
	isWebResearchToolName,
	planWebResearchCalls,
	WEB_RESEARCH_GRANT_LIMIT_TEXT,
	WEB_RESEARCH_LIMITS,
	WEB_SEARCH_TOOL_NAME,
	type WebResearchArtifact,
	type WebResearchCallResult,
	type WebResearchRefusal,
	type WebResearchToolName,
} from "./web-research";

/**
 * The tool calls one tool-node round runs, chosen the way `ToolNode` chooses
 * them: the calls of the last AI message that have no ToolMessage yet. The
 * research pre-pass must decide exactly these, or it could answer a call
 * twice.
 */
export interface PendingToolCalls {
	index: number;
	message: AIMessage;
	calls: ToolCall[];
}

/**
 * The round's pending calls when at least one is a research call, else null,
 * so a round without research skips this scan of the history entirely.
 */
export function pendingResearchRound(
	messages: BaseMessage[],
): PendingToolCalls | null {
	// The same type checks ToolNode uses, so both pick the same round.
	let index = messages.length - 1;
	while (index >= 0 && messages[index]?.getType() !== "ai") {
		index--;
	}
	if (index < 0) {
		return null;
	}
	const aiMessage = messages[index] as AIMessage;
	const allCalls = aiMessage.tool_calls ?? [];
	if (!allCalls.some((call) => isWebResearchToolName(call.name))) {
		return null;
	}
	const answered = new Set(
		messages
			.filter((message) => message.getType() === "tool")
			.map((message) => (message as ToolMessage).tool_call_id),
	);
	const calls = allCalls.filter(
		(call) => call.id == null || !answered.has(call.id),
	);
	if (!calls.some((call) => isWebResearchToolName(call.name))) {
		return null;
	}
	return { index, message: aiMessage, calls };
}

/**
 * What the model is told about a research call the tool node refused before
 * running it. None of them invites repeating the same call.
 */
function webResearchRefusalText(
	kind: WebResearchToolName,
	reason: WebResearchRefusal,
): string {
	switch (reason) {
		case "not_authorized":
			return `${kind} is not available: web research is not authorized for this action. Do not call web_search or read_url in this run; continue with the context you already have.`;
		case "limit_reached":
			return kind === WEB_SEARCH_TOOL_NAME
				? `This run's web search limit (${WEB_RESEARCH_LIMITS.maxSearches} searches) is reached. Do not call web_search again in this run; work with the results and pages you already have.`
				: `This run's page read limit (${WEB_RESEARCH_LIMITS.maxReads} reads) is reached. Do not call read_url again in this run; work with the pages you already read.`;
		case "grant_limit_reached":
			return WEB_RESEARCH_GRANT_LIMIT_TEXT;
		case "url_not_searched":
			return "read_url reads only URLs that web_search returned in this run, and this URL is not one of them. Do not read it; read a URL from this run's search results, or continue without it.";
	}
}

/**
 * The research artifact a dispatched call's ToolMessage carries, when it is
 * a well-formed one of the expected kind. A call that threw or failed schema
 * validation has none and is counted as a failure.
 */
function webResearchArtifactOf(
	message: BaseMessage | undefined,
	kind: WebResearchToolName,
): WebResearchArtifact | undefined {
	if (!message || !ToolMessage.isInstance(message)) {
		return undefined;
	}
	const artifact: unknown = message.artifact;
	if (typeof artifact !== "object" || artifact === null) {
		return undefined;
	}
	const candidate = artifact as Partial<WebResearchArtifact>;
	if (
		candidate.kind !== kind ||
		(candidate.status !== "ok" &&
			candidate.status !== "failed" &&
			candidate.status !== "rejected")
	) {
		return undefined;
	}
	if (
		candidate.urls !== undefined &&
		!(
			Array.isArray(candidate.urls) &&
			candidate.urls.every((url) => typeof url === "string")
		)
	) {
		return undefined;
	}
	if (
		candidate.source !== undefined &&
		typeof candidate.source?.url !== "string"
	) {
		return undefined;
	}
	return candidate as WebResearchArtifact;
}

/**
 * Runs a round that includes `web_search` or `read_url` calls. Each research
 * call is decided in call order against the research gate, the run's
 * budget and the URLs its searches returned; a refused call gets a
 * ToolMessage built here and never reaches a tool or the network. The cached
 * `ToolNode` runs the remaining calls, through a copy of the AI message that
 * lists only them. The results go back in the original call order, and the
 * research calls are folded into the run's outcome, which is written back to
 * graph state whole: no counter lives anywhere else. Image results are left
 * as they are; the tool node splits them out after the round.
 */
export async function runRoundWithWebResearch(
	node: ToolNode,
	state: AgentState,
	config: { configurable?: Record<string, unknown> } | undefined,
	round: PendingToolCalls,
	researchAllowed: boolean,
): Promise<Partial<AgentState>> {
	const progress = {
		outcome: state.webResearchOutcome ?? emptyWebResearchOutcome(),
		searchedUrls: state.webResearchSearchedUrls ?? [],
	};
	const researchCalls = round.calls.filter(
		(call): call is ToolCall & { name: WebResearchToolName } =>
			isWebResearchToolName(call.name),
	);
	const decisions = planWebResearchCalls(
		researchCalls.map((call) => ({
			kind: call.name,
			url: call.args?.url,
		})),
		researchAllowed,
		progress,
	);
	const refusals = new Map<
		ToolCall,
		{ kind: WebResearchToolName; reason: WebResearchRefusal }
	>();
	researchCalls.forEach((call, index) => {
		const decision = decisions[index];
		if (decision?.action === "refuse") {
			refusals.set(call, { kind: call.name, reason: decision.reason });
		}
	});
	const permitted = round.calls.filter((call) => !refusals.has(call));

	let dispatched: BaseMessage[] = [];
	if (permitted.length > 0) {
		// Built from scratch rather than copied, so the constructor cannot
		// restore a refused call from the original's content blocks.
		const messages = [...state.messages];
		messages[round.index] = new AIMessage({
			content: "",
			id: round.message.id,
			name: round.message.name,
			tool_calls: permitted,
		});
		const result = (await node.invoke({ ...state, messages }, config)) as {
			messages?: BaseMessage[];
		};
		dispatched = result.messages ?? [];
	}

	// Match each permitted call to its ToolMessage by id, falling back to
	// position: ToolNode answers the calls it ran in their order.
	const used = new Set<BaseMessage>();
	const resultFor = (
		call: ToolCall,
		position: number,
	): BaseMessage | undefined => {
		const byId = call.id
			? dispatched.find(
					(message) =>
						!used.has(message) &&
						ToolMessage.isInstance(message) &&
						message.tool_call_id === call.id,
				)
			: undefined;
		const atPosition = dispatched[position];
		const match =
			byId ??
			(atPosition && !used.has(atPosition) ? atPosition : undefined);
		if (match) {
			used.add(match);
		}
		return match;
	};

	const ordered: BaseMessage[] = [];
	const researchResults: WebResearchCallResult[] = [];
	let position = 0;
	for (const call of round.calls) {
		const refusal = refusals.get(call);
		if (refusal) {
			const { kind, reason } = refusal;
			logger.warn("[ToolNode] Research call refused before running", {
				tool: kind,
				reason,
			});
			ordered.push(
				new ToolMessage({
					content: webResearchRefusalText(kind, reason),
					tool_call_id: call.id ?? "",
					name: call.name,
					status: "error",
				}),
			);
			researchResults.push({ kind, refused: reason });
			continue;
		}
		const message = resultFor(call, position++);
		if (message) {
			ordered.push(message);
		}
		if (isWebResearchToolName(call.name)) {
			const artifact = webResearchArtifactOf(message, call.name);
			researchResults.push(
				artifact ? { kind: call.name, artifact } : { kind: call.name },
			);
		}
	}
	ordered.push(...dispatched.filter((message) => !used.has(message)));

	const next = foldWebResearchCalls(progress, researchResults);
	return {
		messages: ordered,
		webResearchOutcome: {
			...next.outcome,
			authorized: next.outcome.authorized || researchAllowed,
		},
		webResearchSearchedUrls: next.searchedUrls,
	};
}
