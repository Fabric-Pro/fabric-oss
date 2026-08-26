/**
 * Backlog Updater State Module
 *
 * Defines the LangGraph state annotation for the Backlog Updater Agent.
 * State is synced with the frontend via CopilotKit's useCoAgent hook.
 */

import { Annotation, MessagesAnnotation } from "@langchain/langgraph";
import { reasoningByTurnAnnotation } from "@repo/agent-core/reasoning-trace";

/**
 * Backlog Updater State Annotation
 *
 * Frontend populates: projectId, projectName, organizationId, integration flags, backlogSummary
 * Agent updates: analysisStatus, lastProposalSummary, error, retryCount
 */
export const BacklogUpdaterStateAnnotation = Annotation.Root({
	// Project context (set by frontend via useCoAgent initialState)
	projectId: Annotation<string>({
		reducer: (x, y) => y ?? x,
		default: () => "",
	}),
	projectName: Annotation<string>({
		reducer: (x, y) => y ?? x,
		default: () => "",
	}),
	organizationId: Annotation<string | undefined>({
		reducer: (x, y) => y ?? x,
		default: () => undefined,
	}),

	// Integration availability (set by frontend)
	hasTeamsIntegration: Annotation<boolean>({
		reducer: (x, y) => y ?? x,
		default: () => false,
	}),
	hasSlackIntegration: Annotation<boolean>({
		reducer: (x, y) => y ?? x,
		default: () => false,
	}),
	hasNotionIntegration: Annotation<boolean>({
		reducer: (x, y) => y ?? x,
		default: () => false,
	}),
	hasPMTool: Annotation<boolean>({
		reducer: (x, y) => y ?? x,
		default: () => false,
	}),
	pmToolName: Annotation<string | undefined>({
		reducer: (x, y) => y ?? x,
		default: () => undefined,
	}),
	backlogSummary: Annotation<string>({
		reducer: (x, y) => y ?? x,
		default: () => "",
	}),

	// Workflow tracking (updated by agent)
	analysisStatus: Annotation<string | undefined>({
		reducer: (x, y) => y ?? x,
		default: () => undefined,
	}),
	lastProposalSummary: Annotation<string | undefined>({
		reducer: (x, y) => y ?? x,
		default: () => undefined,
	}),

	// Standard agent fields
	error: Annotation<string | undefined>({
		reducer: (x, y) => y ?? x,
		default: () => undefined,
	}),
	retryCount: Annotation<number>({
		reducer: (x, y) => y ?? x,
		default: () => 0,
	}),

	// CopilotKit tools available to the agent
	tools: Annotation<any[]>(),

	// Per-turn reasoning trace ("Thinking · X.Ys" UI affordance). Populated
	// by chat-node.ts via buildReasoningUpdate from @repo/agent-core/reasoning-trace
	// when the bound model emits Anthropic thinking blocks, OpenAI reasoning
	// blocks, or Vercel Gateway raw_response reasoning. Keyed by turnIndex
	// (= count of human messages preceding the assistant turn). Ephemeral.
	reasoningByTurn: reasoningByTurnAnnotation(),

	// Inherit message handling from MessagesAnnotation
	...MessagesAnnotation.spec,
});

export type BacklogUpdaterState = typeof BacklogUpdaterStateAnnotation.State;
