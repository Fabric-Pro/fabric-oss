import {
	firstRequestChange,
	type ModelRequestObservation,
	type RequestPartShape,
} from "@repo/ai/lib/request-shape";
import { chargedConversationInputTokens } from "@repo/utils/conversation-turn-charge";
import { log } from "@temporalio/workflow";
import type { WorkflowState } from "./types";

const TOKEN_FIELDS = [
	"cacheReadTokens",
	"cacheWriteTokens",
	"uncachedInputTokens",
	"outputTokens",
] as const;
const arm = (state: WorkflowState) =>
	state.advisorBoundedHistoryV2Enabled
		? "bounded-v2"
		: state.advisorBoundedHistoryEnabled
			? "bounded-v1"
			: "age";
function metrics(state: WorkflowState) {
	state.advisorCacheMetrics ??= {
		mainRounds: 0,
		physicalRequests: 0,
		compactions: 0,
		prunes: 0,
		activitiesWithoutRequestObservations: 0,
		tokens: {},
		reportedRequests: {},
	};
	return state.advisorCacheMetrics;
}
/** FNV-1a of the already hashed section descriptors; no prompt content enters the workflow logger. */
function sectionHash(parts: RequestPartShape[]): string {
	let hash = 2166136261;
	for (const part of parts) {
		for (const character of `${part.role ?? ""}:${part.hash}:${part.bytes};`) {
			hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
		}
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}
export function recordAdvisorMainRound(state: WorkflowState): void {
	metrics(state).mainRounds++;
}
export function recordAdvisorHistoryChange(
	state: WorkflowState,
	change: "pruned" | "compacted" | "tools_discovered",
): void {
	state.advisorHistoryChanges ??= [];
	if (!state.advisorHistoryChanges.includes(change)) {
		state.advisorHistoryChanges.push(change);
	}
	const totals = metrics(state);
	if (change === "pruned") {
		totals.prunes++;
	}
	if (change === "compacted") {
		totals.compactions++;
	}
}
export function recordAdvisorTurnSummary(state: WorkflowState): void {
	if (state.advisorCacheSummaryLogged) {
		return;
	}
	state.advisorCacheSummaryLogged = true;
	const totals = metrics(state);
	const stop = state.budgetStop?.kind;
	log.info("advisor.turn_cache_summary", {
		historyRetention: arm(state),
		historyDecision: state.advisorHistoryDecision,
		mainRounds: totals.mainRounds,
		toolLoading: toolLoadingSummary(state),
		chargedInputTokens: totals.chargedInputTokens,
		chargedTokens: state.turnLedger
			? state.turnLedger.measured + state.turnLedger.outstanding
			: totals.chargedTokens,
		calibrationFactor: state.advisorCalibrationFactor ?? 1,
		physicalRequests: totals.physicalRequests,
		...totals.tokens,
		usageReportedRequests: totals.reportedRequests,
		activitiesWithoutRequestObservations:
			totals.activitiesWithoutRequestObservations,
		compactions: totals.compactions,
		prunes: totals.prunes,
		stopKind:
			stop === "round_limit"
				? "round"
				: stop === "time_limit"
					? "time"
					: stop === "token_budget"
						? "token"
						: stop === "token_allowance"
							? "allowance"
							: undefined,
		answerFinished:
			state.status === "completed" &&
			!stop &&
			!state.truncated &&
			!state.pendingHandoff,
	});
}
/** Older activity results contain neither of these optional diagnostic fields. */
export function recordAdvisorRequests(
	state: WorkflowState,
	result: {
		requests?: ModelRequestObservation[];
		requestSizing?: { extraInputTokens: number; contextWindow?: number };
	},
): void {
	if (result.requestSizing) {
		state.advisorRequestSizing = result.requestSizing;
	}
	const totals = metrics(state);
	if (result.requests === undefined) {
		totals.activitiesWithoutRequestObservations++;
	}
	if (
		(state.advisorBoundedHistoryV2Enabled ||
			state.advisorWeightedAllowanceEnabled) &&
		!result.requests?.length
	) {
		state.advisorCalibrationFactor = 1;
		state.advisorPreviousInputTokens = undefined;
		state.advisorPreviousCacheReadTokens = undefined;
	}
	for (const request of result.requests ?? []) {
		recordToolRequest(state, request);
		if (
			state.advisorBoundedHistoryV2Enabled ||
			state.advisorWeightedAllowanceEnabled
		) {
			state.advisorCalibrationFactor =
				typeof request.inputTokens === "number" &&
				Number.isFinite(request.inputTokens) &&
				request.estimatedInputTokens > 0
					? Math.min(
							2,
							Math.max(
								0.25,
								request.inputTokens /
									request.estimatedInputTokens,
							),
						)
					: 1;
			state.advisorPreviousInputTokens = request.inputTokens;
			state.advisorPreviousCacheReadTokens = request.cacheReadTokens;
		}
		const chargedInputTokens =
			request.inputTokens === undefined
				? undefined
				: chargedConversationInputTokens(
						request.inputTokens,
						request.cacheReadTokens,
					);
		if (chargedInputTokens !== undefined) {
			totals.chargedInputTokens =
				(totals.chargedInputTokens ?? 0) + chargedInputTokens;
		}
		if (
			chargedInputTokens !== undefined &&
			request.outputTokens !== undefined
		) {
			totals.chargedTokens =
				(totals.chargedTokens ?? 0) +
				chargedInputTokens +
				request.outputTokens;
		}
		totals.physicalRequests++;
		for (const field of TOKEN_FIELDS) {
			const value = request[field];
			if (typeof value === "number") {
				totals.tokens[field] = (totals.tokens[field] ?? 0) + value;
				totals.reportedRequests[field] =
					(totals.reportedRequests[field] ?? 0) + 1;
			}
		}
		log.info("advisor.request_shape", {
			iteration: request.iteration,
			activityAttempt: request.activityAttempt,
			streamAttempt: request.streamAttempt,
			request: request.request,
			historyRetention: arm(state),
			historyDecision: state.advisorHistoryDecision,
			requestBytes: request.fingerprint.bytes,
			toolCount: request.fingerprint.tools.length,
			systemCount: request.fingerprint.system.length,
			messageCount: request.fingerprint.messages.length,
			toolBytes: request.fingerprint.tools.reduce(
				(sum, part) => sum + part.bytes,
				0,
			),
			systemBytes: request.fingerprint.system.reduce(
				(sum, part) => sum + part.bytes,
				0,
			),
			messageBytes: request.fingerprint.messages.reduce(
				(sum, part) => sum + part.bytes,
				0,
			),
			toolsHash: sectionHash(request.fingerprint.tools),
			systemHash: sectionHash(request.fingerprint.system),
			messagesHash: sectionHash(request.fingerprint.messages),
			chargedInputTokens,
			calibrationFactor: state.advisorCalibrationFactor ?? 1,
			cacheReadTokens: request.cacheReadTokens,
			cacheWriteTokens: request.cacheWriteTokens,
			uncachedInputTokens: request.uncachedInputTokens,
			outputTokens: request.outputTokens,
			firstChangedPosition: firstRequestChange(
				state.advisorPreviousRequest,
				request.fingerprint,
			),
			historyChanges: state.advisorHistoryChanges?.length
				? state.advisorHistoryChanges
				: ["none"],
		});
		state.advisorPreviousRequest = request.fingerprint;
		state.advisorHistoryChanges = [];
	}
}

/** Read an optional diagnostic suffix; ledger/refusal readers still use the original first detail. */
export function recordAdvisorFailureRequests(
	state: WorkflowState,
	error: unknown,
): void {
	const seen = new Set<unknown>();
	let cursor = error;
	while (cursor && typeof cursor === "object" && !seen.has(cursor)) {
		seen.add(cursor);
		const failure = cursor as { details?: unknown; cause?: unknown };
		for (const detail of Array.isArray(failure.details)
			? failure.details
			: []) {
			const diagnostics = (
				detail as {
					advisorRequestDiagnosticsV1?: {
						requests?: ModelRequestObservation[];
					};
				} | null
			)?.advisorRequestDiagnosticsV1;
			if (Array.isArray(diagnostics?.requests)) {
				recordAdvisorRequests(state, diagnostics);
			}
		}
		cursor = failure.cause;
	}
}

// Shared allowance for search/execution name samples; final overlap has its own allowance.
const ADVISOR_TOOL_SUMMARY_NAME_LIMIT = 50;

export interface AdvisorToolSearch {
	round: number;
	added: string[];
	changed: string[];
	executedAdded: string[];
	agentSearch: { ran: boolean; tools: string[]; used: string[] };
	integrationSearch: { ran: boolean; tools: string[]; used: string[] };
}
export interface AdvisorToolLoadingMetrics {
	catalog: string[];
	initialNames: string[];
	initialToolCount?: number;
	initialSchemaBytes?: number;
	initialToolsHash?: string;
	stubCatalogUsed: boolean;
	versions: string[];
	changes: Array<{
		round: number;
		hash: string;
		causes: Array<"search_tools" | "skill_tool_change" | "other">;
	}>;
	overlaps: Array<{
		round: number;
		afterSearch: number;
		count: number;
	}>;
	finalOverlapNames: string[];
	searches: AdvisorToolSearch[];
	executions: Array<{
		name: string;
		count: number;
		origin: "initial" | "discovery" | "other";
	}>;
	previous?: {
		signature: string;
		names?: string[];
		skills?: string[];
		parts: RequestPartShape[];
	};
	pendingSearchChanges: string[];
}
function toolMetrics(state: WorkflowState): AdvisorToolLoadingMetrics {
	state.advisorToolLoading ??= {
		catalog: [],
		initialNames: [],
		stubCatalogUsed: false,
		versions: [],
		changes: [],
		overlaps: [],
		finalOverlapNames: [],
		searches: [],
		executions: [],
		pendingSearchChanges: [],
	};
	return state.advisorToolLoading;
}
export function recordAdvisorToolCatalog(
	state: WorkflowState,
	catalog: string[],
): void {
	const m = toolMetrics(state);
	m.catalog = [...catalog];
	m.stubCatalogUsed = catalog.length > 0;
}
export function recordAdvisorToolSet(
	state: WorkflowState,
	tools: Record<string, unknown>,
	round: number,
): void {
	const m = toolMetrics(state);
	const names = [
		...new Set([...Object.keys(tools), ...(m.previous?.skills ?? [])]),
	];
	if (!m.overlaps.length) {
		m.initialNames = names;
	}
	const overlap = m.catalog.filter((name) => names.includes(name));
	m.overlaps.push({
		round,
		afterSearch: m.searches.length,
		count: overlap.length,
	});
	m.finalOverlapNames = overlap;
}
export function beginAdvisorToolSearch(
	state: WorkflowState,
	round: number,
): AdvisorToolSearch {
	const search: AdvisorToolSearch = {
		round,
		added: [],
		changed: [],
		executedAdded: [],
		agentSearch: { ran: false, tools: [], used: [] },
		integrationSearch: { ran: false, tools: [], used: [] },
	};
	toolMetrics(state).searches.push(search);
	return search;
}
export function finishAdvisorToolSearch(
	state: WorkflowState,
	search: AdvisorToolSearch,
	before: Record<string, unknown>,
	after: Record<string, unknown>,
	agents: string[],
	integrations: string[],
	suppressed: ReadonlySet<string> = new Set(),
): void {
	// Filter diagnostic copies, leaving the workflow's tool-loading behavior intact.
	const visible = (tools: Record<string, unknown>) =>
		Object.fromEntries(
			Object.entries(tools).filter(([name]) => !suppressed.has(name)),
		);
	const visibleBefore = visible(before);
	const visibleAfter = visible(after);
	search.added = Object.keys(visibleAfter).filter(
		(name) => !(name in visibleBefore),
	);
	search.changed = Object.keys(visibleAfter).filter(
		(name) =>
			JSON.stringify(visibleAfter[name]) !==
			JSON.stringify(visibleBefore[name]),
	);
	search.agentSearch.tools = agents;
	search.integrationSearch.tools = integrations;
	toolMetrics(state).pendingSearchChanges.push(...search.changed);
	recordAdvisorToolSet(state, visibleAfter, search.round);
}
/** Called after approval and before dispatch, including attempts that subsequently fail. */
export function recordAdvisorToolExecution(
	state: WorkflowState,
	name: string,
): void {
	const m = toolMetrics(state);
	const origin = m.initialNames.includes(name)
		? "initial"
		: m.searches.some((s) => s.added.includes(name))
			? "discovery"
			: "other";
	const execution = m.executions.find(
		(e) => e.name === name && e.origin === origin,
	);
	if (execution) {
		execution.count++;
	} else {
		m.executions.push({ name, count: 1, origin });
	}
	for (const search of m.searches) {
		if (
			search.added.includes(name) &&
			!search.executedAdded.includes(name)
		) {
			search.executedAdded.push(name);
		}
		for (const run of [search.agentSearch, search.integrationSearch]) {
			if (run.tools.includes(name) && !run.used.includes(name)) {
				run.used.push(name);
			}
		}
	}
}
function recordToolRequest(
	state: WorkflowState,
	request: ModelRequestObservation,
): void {
	const m = toolMetrics(state);
	const parts = request.fingerprint.tools;
	const signature = JSON.stringify(parts);
	const previous = m.previous;
	if (!previous) {
		m.initialToolCount = parts.length;
		m.initialToolsHash = sectionHash(parts);
		m.initialSchemaBytes = parts.reduce((sum, part) => sum + part.bytes, 0);
		if (request.toolNames) {
			m.initialNames = [...request.toolNames];
			const initial = m.overlaps[0];
			if (initial) {
				const overlap = m.catalog.filter((name) =>
					request.toolNames?.includes(name),
				);
				initial.count = overlap.length;
				if (m.overlaps.length === 1) {
					m.finalOverlapNames = overlap;
				}
			}
		}
	}
	if (!m.versions.includes(signature)) {
		m.versions.push(signature);
	}
	if (previous && signature !== previous.signature) {
		const causes: AdvisorToolLoadingMetrics["changes"][number]["causes"] =
			[];
		// Name-to-fingerprint pairing is captured at the physical request boundary.
		// Missing metadata on old activity results leaves attribution as other.
		if (previous.names && request.toolNames) {
			const changed = [
				...new Set([...previous.names, ...request.toolNames]),
			].filter((name) => {
				const before =
					previous.parts[previous.names?.indexOf(name) ?? -1];
				const after = parts[request.toolNames?.indexOf(name) ?? -1];
				return JSON.stringify(before) !== JSON.stringify(after);
			});
			const skills = [
				...(previous.skills ?? []),
				...(request.skillToolNames ?? []),
			];
			if (changed.some((name) => m.pendingSearchChanges.includes(name))) {
				causes.push("search_tools");
			}
			if (changed.some((name) => skills.includes(name))) {
				causes.push("skill_tool_change");
			}
			if (
				!changed.length ||
				changed.some(
					(name) =>
						!m.pendingSearchChanges.includes(name) &&
						!skills.includes(name),
				)
			) {
				causes.push("other");
			}
		} else {
			causes.push("other");
		}
		m.changes.push({
			round: request.iteration,
			hash: sectionHash(parts),
			causes,
		});
	}
	m.previous = {
		signature,
		names: request.toolNames,
		skills: request.skillToolNames,
		parts,
	};
	m.pendingSearchChanges = [];
}
function toolLoadingSummary(state: WorkflowState) {
	const m = state.advisorToolLoading;
	if (!m) {
		return undefined;
	}
	let remainingNames = ADVISOR_TOOL_SUMMARY_NAME_LIMIT;
	const sampleNames = <T>(items: T[]): T[] => {
		const sampled = items.slice(0, remainingNames);
		remainingNames -= sampled.length;
		return sampled;
	};
	// Prioritize execution provenance, then sample search names from the shared allowance.
	const executions = sampleNames(m.executions);
	const searches = m.searches.map((search) => {
		const added = sampleNames(search.added);
		const executedAdded = sampleNames(search.executedAdded);
		return {
			round: search.round,
			added,
			addedCount: search.added.length,
			addedMore: search.added.length - added.length,
			executedAdded,
			executedAddedCount: search.executedAdded.length,
			executedAddedMore:
				search.executedAdded.length - executedAdded.length,
		};
	});
	const finalOverlapNames = m.finalOverlapNames.slice(
		0,
		ADVISOR_TOOL_SUMMARY_NAME_LIMIT,
	);
	return {
		initialToolCount: m.initialToolCount,
		initialSchemaBytes: m.initialSchemaBytes,
		initialToolsHash: m.initialToolsHash,
		toolListChanges: m.changes.length,
		stubCatalogUsed: m.stubCatalogUsed,
		distinctToolLists: m.versions.length,
		changes: m.changes,
		searchToolsCalls: m.searches.length,
		searches,
		agentSearchRuns: m.searches.filter((s) => s.agentSearch.ran).length,
		agentSearchRunsUsed: m.searches.filter(
			(s) => s.agentSearch.used.length > 0,
		).length,
		integrationSearchRuns: m.searches.filter((s) => s.integrationSearch.ran)
			.length,
		integrationSearchRunsUsed: m.searches.filter(
			(s) => s.integrationSearch.used.length > 0,
		).length,
		executions,
		executionsMore: m.executions.length - executions.length,
		executedToolCalls: m.executions.reduce(
			(sum, entry) => sum + entry.count,
			0,
		),
		stubCatalogOverlap: m.overlaps,
		finalStubCatalogOverlap: {
			count: m.finalOverlapNames.length,
			names: finalOverlapNames,
			more: m.finalOverlapNames.length - finalOverlapNames.length,
		},
	};
}
