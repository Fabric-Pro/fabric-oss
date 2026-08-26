/**
 * Generate Document Node
 *
 * Generates the final task plan document with all analysis.
 *
 * Key behaviors:
 * - Detects post-confirmation state and outputs acknowledgment only (no tool calls)
 */

import {
	AIMessage,
	type BaseMessage,
	HumanMessage,
	SystemMessage,
} from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { Command, END } from "@langchain/langgraph";
import { logAgentUsageFromRunnableConfig } from "@repo/agent-core";
import { shapeHistoryForModel } from "@repo/agent-core/message-shape";
import {
	buildReasoningUpdate,
	countHumanMessages,
	stripRawResponseEnvelope,
} from "@repo/agent-core/reasoning-trace";
import { WRITE_TASK_PLAN_TOOL } from "@repo/agent-tools";
import { v4 as uuidv4 } from "uuid";
import { getDocumentGenerationPrompt } from "../prompts";
import type { TaskPlannerStateType } from "../state";
import {
	generateFallbackDocument,
	getAgentModelSync,
	type ProviderConfig,
	withRetry,
} from "../utils";

/** Default recursion limit for the graph */
const DEFAULT_RECURSION_LIMIT = 25;

/**
 * Get message type - handles multiple formats from CopilotKit and LangChain
 */
function getMessageType(msg: any): string {
	if (msg._getType) {
		return msg._getType();
	}
	if (msg.type && typeof msg.type === "string") {
		if (msg.type === "human") {
			return "human";
		}
		if (msg.type === "ai") {
			return "ai";
		}
		if (msg.type === "tool") {
			return "tool";
		}
		return msg.type;
	}
	if (msg.role) {
		if (msg.role === "user") {
			return "human";
		}
		if (msg.role === "assistant") {
			return "ai";
		}
		if (msg.role === "tool") {
			return "tool";
		}
		return msg.role;
	}
	return "unknown";
}

/**
 * Check if we should handle post-confirmation (user just clicked Accept/Reject).
 * SIMPLE RULE: Post-confirmation is ONLY when the LAST message is a tool response
 * to confirm_changes. Any other last message means process normally.
 */
function isAfterConfirmation(messages: BaseMessage[]): {
	isAfter: boolean;
	accepted: boolean;
} {
	if (!messages || messages.length < 2) {
		return { isAfter: false, accepted: false };
	}

	const lastMsg = messages[messages.length - 1];
	const secondLastMsg = messages[messages.length - 2];

	// Check if last message is a tool response
	if (getMessageType(lastMsg) !== "tool") {
		return { isAfter: false, accepted: false };
	}

	// Check if the tool response contains "accepted"
	const content = typeof lastMsg.content === "string" ? lastMsg.content : "";
	if (!content.includes("accepted")) {
		return { isAfter: false, accepted: false };
	}

	// Check if second-to-last is an AI message with confirm_changes tool call
	if (getMessageType(secondLastMsg) !== "ai") {
		return { isAfter: false, accepted: false };
	}

	const toolCalls =
		(secondLastMsg as any).tool_calls || (secondLastMsg as any).toolCalls;
	if (
		!toolCalls?.some(
			(tc: any) => (tc.name || tc.function?.name) === "confirm_changes",
		)
	) {
		return { isAfter: false, accepted: false };
	}

	const accepted =
		content.includes('"accepted":true') ||
		content.includes('"accepted": true');
	console.log("[Task Planner] Post-confirmation state detected", {
		accepted,
	});
	return { isAfter: true, accepted };
}

/**
 * Sanitize messages for the model API call.
 *
 * CopilotKit often sends back malformed message history:
 * - AI messages split into content-only and tool_calls-only messages
 * - Missing tool responses
 * - Tool calls stripped from some AI messages
 *
 * When these malformed messages go through ChatOpenAI → Vercel Gateway → Anthropic,
 * the format conversion fails with: "toolUse.input is invalid"
 *
 * Fix: Strip tool_calls and tool messages from conversation history.
 */
function sanitizeMessagesForModel(messages: BaseMessage[]): BaseMessage[] {
	const result: BaseMessage[] = [];

	for (const msg of messages) {
		const msgType = getMessageType(msg);

		if (msgType === "system" || msg instanceof SystemMessage) {
			continue;
		}

		if (msgType === "tool") {
			continue;
		}

		if (msgType === "ai") {
			const content =
				typeof msg.content === "string"
					? msg.content
					: String(msg.content || "");

			if (content.trim().length === 0) {
				continue;
			}

			const lastResult =
				result.length > 0 ? result[result.length - 1] : null;
			if (lastResult && getMessageType(lastResult) === "ai") {
				const lastContent =
					typeof lastResult.content === "string"
						? lastResult.content
						: "";
				result[result.length - 1] = new AIMessage({
					content: `${lastContent}\n\n${content}`,
				});
			} else {
				result.push(new AIMessage({ content }));
			}
			continue;
		}

		// Merge consecutive human messages
		// (Anthropic requires strictly alternating user/assistant messages)
		const content =
			typeof msg.content === "string"
				? msg.content
				: String(msg.content || "");
		const lastResult = result.length > 0 ? result[result.length - 1] : null;
		if (lastResult && getMessageType(lastResult) === "human") {
			const lastContent =
				typeof lastResult.content === "string"
					? lastResult.content
					: "";
			result[result.length - 1] = new HumanMessage({
				content: `${lastContent}\n\n${content}`,
			});
		} else {
			result.push(msg);
		}
	}

	// Claude refuses a history that ends on an assistant turn ("does not support
	// assistant message prefill"). The passes above can leave one behind when
	// they strip the tool results that followed it.
	return shapeHistoryForModel(result).messages;
}

/**
 * Generate Document Node
 *
 * Stage 5: Generates the final document using the write_task_plan tool.
 * Supports AG-UI protocol for predictive state updates.
 */
export async function generateDocumentNode(
	state: TaskPlannerStateType,
	config?: RunnableConfig,
): Promise<Command> {
	console.log("[Task Planner] Stage 5: Generating final document");
	const generationStart = Date.now();

	try {
		// =====================================================================
		// POST-CONFIRMATION HANDLING
		// =====================================================================
		// After user clicks Accept/Reject, CopilotKit sends a tool response back.
		// We detect this and return a simple acknowledgment WITHOUT calling tools.
		// This prevents the infinite confirm_changes loop.
		const confirmationStatus = isAfterConfirmation(state.messages);
		if (confirmationStatus.isAfter) {
			console.log("[Task Planner] Handling post-confirmation", {
				accepted: confirmationStatus.accepted,
			});

			const acknowledgment = confirmationStatus.accepted
				? "Task plan has been applied to the document."
				: "Task plan has been discarded. The document remains unchanged.";

			const ackMessage = new AIMessage({ content: acknowledgment });

			return new Command({
				goto: END,
				update: {
					messages: [...state.messages, ackMessage],
					error: undefined,
				},
			});
		}

		// Extract provider config from runtime config
		let providerConfig: ProviderConfig | undefined;
		if (config?.configurable) {
			const configurable = config.configurable as Record<string, unknown>;
			if (configurable.ai_api_key && configurable.ai_model) {
				providerConfig = {
					apiKey: String(configurable.ai_api_key),
					model: String(configurable.ai_model),
					provider: configurable.ai_provider
						? String(configurable.ai_provider)
						: undefined,
					baseUrl: configurable.ai_gateway_url
						? String(configurable.ai_gateway_url)
						: undefined,
					// Canonical-derived reasoning signal (Bug #1942 review): gates
					// Databricks <think> stripping when the serving alias is opaque.
					isReasoningModel:
						typeof configurable.ai_is_reasoning === "boolean"
							? configurable.ai_is_reasoning
							: undefined,
				};
			}
		}

		const model = getAgentModelSync(providerConfig, { temperature: 0.7 });
		console.log(
			"[Task Planner] Using model:",
			providerConfig?.model || "groq/llama-3.3-70b-versatile (env)",
		);
		const systemPrompt = getDocumentGenerationPrompt(state.techStack);

		// Configure predictive state updates (AG-UI protocol)
		const runnableConfig = config || {
			recursionLimit: DEFAULT_RECURSION_LIMIT,
		};
		if (!runnableConfig.metadata) {
			runnableConfig.metadata = {};
		}
		runnableConfig.metadata.predict_state = [
			{
				state_key: "document",
				tool: "write_task_plan",
				tool_argument: "document",
			},
			{
				state_key: "focusAnchor",
				tool: "write_task_plan",
				tool_argument: "focusAnchor",
			},
		];

		// Bind tools to model
		if (!model.bindTools) {
			throw new Error(
				"[Task Planner] Model does not support tool binding. Please configure a model with function calling support.",
			);
		}
		const modelWithTools = model.bindTools([
			...(state.tools || []),
			WRITE_TASK_PLAN_TOOL,
		]);

		const userMessage = `Generate a comprehensive task plan document combining:

**Project:** ${state.projectName}
**Tasks:** ${state.decomposedTasks.length} decomposed tasks
**Risk Score:** ${state.riskAnalysis?.overallScore || 0}/100
**Critical Path:** ${state.dependencyGraph?.criticalPath.length || 0} tasks
**Phases:** ${state.executionPlan?.phases.length || 0}

Data:
- Decomposed Tasks: ${JSON.stringify(state.decomposedTasks, null, 2)}
- Risk Analysis: ${JSON.stringify(state.riskAnalysis, null, 2)}
- Dependency Graph: ${JSON.stringify(state.dependencyGraph, null, 2)}
- Execution Plan: ${JSON.stringify(state.executionPlan, null, 2)}

Use write_task_plan tool to output ALL data including the markdown document and structured data.`;

		// Sanitize messages: strip tool_calls, tool messages, merge consecutive AI
		// messages to prevent Anthropic 400 errors from malformed CopilotKit history
		const sanitizedMessages = sanitizeMessagesForModel(state.messages);

		// turnStart captured BEFORE invoke (protocol P3); the withRetry
		// wrapper can replay invoke on transient failures, in which case
		// durationMs reflects total wall-clock time across retries — that
		// matches the user-observed "Thinking · X.Ys" feel.
		const turnStart = Date.now();
		const response = await withRetry(async () => {
			return modelWithTools.invoke(
				[
					new SystemMessage(systemPrompt),
					...sanitizedMessages,
					new HumanMessage(userMessage),
				],
				runnableConfig,
			);
		});
		await logAgentUsageFromRunnableConfig(runnableConfig, response, {
			taskType: "TOOL_CALLING",
			agentId: "task_planner",
			latencyMs: Date.now() - generationStart,
		});

		// === Reasoning capture (shared lib, F-1171 follow-up) ===
		// Only the final DAG node (this one) emits reasoning — see state.ts
		// JSDoc for the Q3 product rationale. buildReasoningUpdate MUST run
		// BEFORE stripRawResponseEnvelope (protocol P1).
		const reasoningByTurnUpdate = buildReasoningUpdate({
			response,
			existingByTurn: state.reasoningByTurn,
			stateMessages: state.messages,
			turnStart,
			loggerLabel: "[Task Planner]",
		});
		stripRawResponseEnvelope(response);

		if (reasoningByTurnUpdate.reasoningByTurn) {
			const turnIndex = countHumanMessages(state.messages);
			const entry = reasoningByTurnUpdate.reasoningByTurn[turnIndex];
			console.log("[Task Planner] Reasoning emitted", {
				turnIndex,
				textLength: entry?.text.length ?? 0,
				durationMs: entry?.durationMs ?? 0,
			});
		}

		const updatedMessages = [...state.messages, response];

		// Handle tool calls
		if (response.tool_calls && response.tool_calls.length > 0) {
			const toolCall = response.tool_calls[0];

			if (toolCall.name === "write_task_plan") {
				console.log("[Task Planner] Document generated");

				const toolResponse = {
					role: "tool" as const,
					content: "Task plan written successfully.",
					tool_call_id: toolCall.id,
				};

				// Generate a follow-up message for task planning
				// Models often return empty content with tool calls, so we generate our own
				const followUpOptions = [
					"Would you like me to break down any high-complexity tasks further?",
					"Should I add more detail to the risk mitigation strategies?",
					"Would you like me to adjust the timeline estimates?",
					"Should I identify additional dependencies or blockers?",
				];
				const randomFollowUp =
					followUpOptions[
						Math.floor(Math.random() * followUpOptions.length)
					];
				const followUpMessage = `I've generated the task plan. ${randomFollowUp}`;

				// Include generated follow-up question so it appears in sidebar
				const confirmToolCall = {
					role: "assistant" as const,
					content: followUpMessage,
					tool_calls: [
						{
							id: uuidv4(),
							type: "function" as const,
							function: {
								name: "confirm_changes",
								arguments: {},
							},
						},
					],
				};

				return new Command({
					goto: END,
					update: {
						messages: [
							...updatedMessages,
							toolResponse,
							confirmToolCall,
						],
						document: toolCall.args.document,
						focusAnchor: toolCall.args.focusAnchor,
						decomposedTasks:
							toolCall.args.decomposedTasks ||
							state.decomposedTasks,
						riskAnalysis:
							toolCall.args.riskAnalysis || state.riskAnalysis,
						dependencyGraph:
							toolCall.args.dependencyGraph ||
							state.dependencyGraph,
						executionPlan:
							toolCall.args.executionPlan || state.executionPlan,
						error: undefined,
						currentStage: "Complete",
						...reasoningByTurnUpdate,
					},
				});
			}
		}

		// Fallback: generate document from state
		const fallbackDoc = generateFallbackDocument(state);
		return new Command({
			goto: END,
			update: {
				messages: updatedMessages,
				document: fallbackDoc,
				currentStage: "Complete",
				...reasoningByTurnUpdate,
			},
		});
	} catch (error) {
		console.error("[Task Planner] Document generation failed:", error);
		return new Command({
			goto: END,
			update: {
				error:
					error instanceof Error
						? error.message
						: "Document generation failed",
				document: generateFallbackDocument(state),
			},
		});
	}
}
