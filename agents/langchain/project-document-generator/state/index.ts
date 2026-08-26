/**
 * Project Document Generator State Module
 *
 * Defines the LangGraph state annotation for the Project Document Generator Agent.
 * Compatible with AG-UI protocol for predictive state updates.
 *
 * Uses CopilotKitStateAnnotation to receive frontend actions from CopilotKit.
 */

import { CopilotKitStateAnnotation } from "@copilotkit/sdk-js/langgraph";
import { Annotation } from "@langchain/langgraph";
import type { DocumentType, ProjectContext } from "@repo/agent-types";

/**
 * Project Document Generator State Annotation
 *
 * State structure for project document generation with RAG and predictive updates.
 * Inherits from CopilotKitStateAnnotation to receive frontend actions (like regenerate_document).
 */
export const AgentStateAnnotation = Annotation.Root({
	// CopilotKit state - provides copilotkit.actions (frontend tools), copilotkit.context, and messages
	...CopilotKitStateAnnotation.spec,

	/**
	 * The document content being generated/edited
	 */
	document: Annotation<string | undefined>({
		reducer: (x, y) => y ?? x,
		default: () => undefined,
	}),

	/**
	 * Streaming content for predictive updates
	 */
	streamingContent: Annotation<string>({
		reducer: (x, y) => y ?? x,
		default: () => "",
	}),

	/**
	 * Focus anchor for cursor positioning
	 */
	focusAnchor: Annotation<string | undefined>({
		reducer: (x, y) => y ?? x,
		default: () => undefined,
	}),

	/**
	 * Type of document being generated
	 */
	documentType: Annotation<DocumentType>({
		reducer: (x, y) => y ?? x,
		default: () => "general",
	}),

	/**
	 * Project context information
	 */
	projectContext: Annotation<ProjectContext>({
		reducer: (x, y) => y ?? x,
		default: () => ({
			name: "",
			techStack: [],
			features: [],
		}),
	}),

	/**
	 * RAG contexts for document generation
	 */
	ragContexts: Annotation<string[]>({
		reducer: (x, y) => y ?? x,
		default: () => [],
	}),

	/**
	 * Optional custom system prompt from Prompt Library
	 */
	systemPrompt: Annotation<string | undefined>({
		reducer: (x, y) => y ?? x,
		default: () => undefined,
	}),

	/**
	 * Retry count for error recovery
	 */
	retryCount: Annotation<number>({
		reducer: (x, y) => y ?? x,
		default: () => 0,
	}),

	/**
	 * Error message if any
	 */
	error: Annotation<string | undefined>({
		reducer: (x, y) => y ?? x,
		default: () => undefined,
	}),

	/**
	 * Whether the project has Teams integration configured
	 * When true, the agent can use the search_teams_messages tool
	 */
	hasTeamsIntegration: Annotation<boolean>({
		reducer: (x, y) => y ?? x,
		default: () => false,
	}),

	/**
	 * Whether the project has Slack integration configured
	 * When true, the agent can use the search_slack_messages tool
	 */
	hasSlackIntegration: Annotation<boolean>({
		reducer: (x, y) => y ?? x,
		default: () => false,
	}),

	/**
	 * Whether the project has a GitHub repository connected
	 * When true, the agent knows codebase context is available
	 */
	hasGitHubIntegration: Annotation<boolean>({
		reducer: (x, y) => y ?? x,
		default: () => false,
	}),

	/**
	 * Whether the project has code search enabled (any repo integration + codeSearchEnabled)
	 * When true, the agent can use search_repository_code, get_repository_file, list_repository_structure tools
	 */
	hasRepoIntegration: Annotation<boolean>({
		reducer: (x, y) => y ?? x,
		default: () => false,
	}),

	/**
	 * Project ID for tool execution (Teams search)
	 */
	projectId: Annotation<string>({
		reducer: (x, y) => y ?? x,
		default: () => "",
	}),

	/**
	 * User ID for tenant context in tool execution
	 */
	userId: Annotation<string>({
		reducer: (x, y) => y ?? x,
		default: () => "",
	}),

	/**
	 * Organization ID for tenant context in tool execution
	 */
	organizationId: Annotation<string | undefined>({
		reducer: (x, y) => y ?? x,
		default: () => undefined,
	}),

	/**
	 * Whether this is a regeneration request (user clicked Regenerate).
	 * When true, the agent generates a fresh document from the prompt template
	 * instead of editing the existing document in-place.
	 */
	isRegeneration: Annotation<boolean>({
		reducer: (x, y) => y ?? x,
		default: () => false,
	}),

	/**
	 * ProjectDocument ID (set by the calling activity). Needed by the
	 * write_document_asset tool so generated artifacts (architecture diagrams,
	 * etc.) attach to the correct ProjectDocument.
	 */
	documentId: Annotation<string | undefined>({
		reducer: (x, y) => y ?? x,
		default: () => undefined,
	}),

	/**
	 * Pre-loaded Anthropic Agent Skill bundle for this document type, when
	 * applicable (e.g. "architecture-diagram" for ARCHITECTURE docs). The
	 * activity resolves the Skill catalog entry + asset bytes out-of-band and
	 * injects them here so the prompt builder can eager-inline instead of
	 * forcing the model through list_skills / load_skill tool calls.
	 */
	activeSkill: Annotation<
		| {
				slug: string;
				skillMd: string;
				files: Array<{
					path: string;
					contentType: string;
					body: string;
				}>;
		  }
		| undefined
	>({
		reducer: (x, y) => y ?? x,
		default: () => undefined,
	}),

	/**
	 * Reasoning trace text per user turn (PO follow-up to F-1171).
	 *
	 * Keyed by turnIndex = count of human messages preceding the assistant
	 * message in state.messages. Computed independently on backend (chat-node)
	 * and frontend (CopilotAssistantMessage) so neither side needs to thread
	 * an id through. Stable across multiple chat-node invocations within the
	 * same user turn (e.g. when a tool call triggers a continuation).
	 *
	 * The reducer MERGES so prior turns' entries persist across state updates
	 * (incoming write only touches the current turn key). When the chat-node
	 * has more reasoning to append within the same turn, it reads the existing
	 * entry for the current turn and concatenates BEFORE writing — the reducer
	 * level overwrites a single key, but the chat-node coalesces within it.
	 *
	 * Ephemeral by design: lives only in in-memory LangGraph state. Reset on
	 * page reload along with the rest of the AI Assistant conversation.
	 */
	reasoningByTurn: Annotation<
		Record<
			number,
			{
				text: string;
				durationMs: number;
				startedAt: number;
				completedAt: number;
			}
		>
	>({
		reducer: (existing, incoming) => ({
			...(existing ?? {}),
			...(incoming ?? {}),
		}),
		default: () => ({}),
	}),

	/**
	 * Per-turn tool-call trace surfaced inline in the AI Assistant
	 * "Thinking & Tools" collapsible (follow-up to F-1171 reasoning trace).
	 *
	 * Keyed by the same turnIndex used for `reasoningByTurn`
	 * (= count of human messages preceding the assistant message). Each turn
	 * holds an ordered array of tool-call entries — there can be multiple
	 * within one user turn when the model issues parallel calls or chains
	 * several tool/result/tool/result steps before producing final text.
	 *
	 * Lifecycle:
	 * - chat-node sees a new AIMessage with tool_calls → appends one
	 *   `{ status: "pending" }` entry per call with `startedAt = Date.now()`.
	 * - On the next chat-node invocation (after the tool node ran), the
	 *   matching ToolMessage in state.messages is reconciled into the entry:
	 *   status flips to "success" (or "error" when the ToolMessage carries
	 *   an error signal), `durationMs` and `errorMessage` are populated.
	 *
	 * The reducer MERGES so prior turns persist when only the current turn
	 * is updated. Per-turn write is a whole-array replacement (chat-node
	 * pre-merges existing + new entries before writing) so we never lose
	 * a pending entry partway through a multi-step turn.
	 *
	 * Ephemeral: lives only in in-memory LangGraph state. Reset on page
	 * reload along with the rest of the AI Assistant conversation.
	 */
	toolCallsByTurn: Annotation<
		Record<
			number,
			Array<{
				id: string;
				name: string;
				status: "pending" | "success" | "error";
				startedAt: number;
				durationMs?: number;
				errorMessage?: string;
			}>
		>
	>({
		reducer: (existing, incoming) => ({
			...(existing ?? {}),
			...(incoming ?? {}),
		}),
		default: () => ({}),
	}),
});

/**
 * Type for the Project Document Generator state
 */
export type AgentState = typeof AgentStateAnnotation.State;
