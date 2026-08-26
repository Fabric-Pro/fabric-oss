/**
 * Agent Handler
 *
 * Handles steps that delegate to specialized agents via A2A protocol.
 */

import { Context } from "@temporalio/activity";
import {
	enrichWeaveDelegationMessage,
	isWeaveAgent,
} from "../../../../activities/weave/enrich-delegation";
import {
	buildDelegationMessage,
	delegateToAgent,
	getAgentCapabilities,
	resolveAgentEndpoint,
} from "../../delegation";
import type {
	AgentVariable,
	ExecuteStepInput,
	ExecuteStepOutput,
} from "../../types";
import { publishStepProgress } from "../../utils/partykit-publisher";
import type {
	HandlerContext,
	HandlerResult,
	StepHandler,
	ToolCallRecord,
} from "./types";

export class AgentHandler implements StepHandler {
	readonly name = "agent";
	readonly capabilities = ["agent", "web"];

	canHandle(input: ExecuteStepInput): boolean {
		const capability = input.step.capability || "mcp_tool";
		const executor = input.step.executor;
		const app = input.step.app;
		const stepType = input.step.type || "api";

		// Determine if we should delegate to an agent
		const agentToDelegate =
			capability === "agent" ? app || executor : executor;
		const isAgentEnabled =
			!input.enabledAgentIds ||
			input.enabledAgentIds.includes(agentToDelegate || "");

		// Check if this step should be handled by an agent
		const shouldDelegate =
			agentToDelegate &&
			isAgentEnabled &&
			(capability === "agent" ||
				(capability === "web" &&
					(app === "cuga_generalist" || app === "browser_agent")) ||
				stepType === "generate");

		return Boolean(shouldDelegate && agentToDelegate);
	}

	async execute(context: HandlerContext): Promise<HandlerResult> {
		const { input } = context;
		const capability = input.step.capability || "mcp_tool";
		const executor = input.step.executor;
		const app = input.step.app;

		const agentToDelegate =
			capability === "agent" ? app || executor : executor;

		if (!agentToDelegate) {
			return {
				handled: false,
				shouldFallback: true,
				fallbackReason: "No agent specified for delegation",
			};
		}

		console.log(
			`[AgentHandler] Attempting delegation to agent: ${agentToDelegate}`,
		);

		// Heartbeat during delegation so Temporal doesn't time out
		Context.current().heartbeat({
			stepId: input.step.id,
			phase: "delegating",
			agentName: agentToDelegate,
		});

		const result = await this.tryAgentDelegation(input, agentToDelegate);

		if (result.success && result.output) {
			return {
				handled: true,
				output: result.output,
			};
		}

		return {
			handled: false,
			error: result.error,
			shouldFallback: true,
			fallbackReason: result.error || "Agent delegation failed",
		};
	}

	private async tryAgentDelegation(
		input: ExecuteStepInput,
		agentToDelegate: string,
	): Promise<{
		success: boolean;
		attempted: boolean;
		output?: ExecuteStepOutput;
		error?: string;
	}> {
		console.log(
			`[AgentHandler] Capability: ${input.step.capability}, agent: ${agentToDelegate}, type: ${input.step.type}`,
		);

		const agent = await resolveAgentEndpoint(
			agentToDelegate,
			input.userId,
			input.organizationId,
		);

		if (!agent) {
			console.log(
				`[AgentHandler] No endpoint found for agent: ${agentToDelegate}`,
			);
			return { success: false, attempted: false };
		}

		const stepInputs = input.step.inputs as
			| Record<string, unknown>
			| undefined;
		const delegationMode =
			(stepInputs?.delegationMode as "complete-task" | "single-step") ||
			"single-step";
		const isCompleteTaskDelegation = delegationMode === "complete-task";

		console.log(
			`[AgentHandler] Delegating to ${agent.name} (${agent.protocol}, mode: ${delegationMode})`,
		);

		try {
			const agentCapabilities = await getAgentCapabilities(
				agentToDelegate,
				input.userId,
				input.organizationId,
			);

			const delegationMessage = buildDelegationMessage(
				input.step.description,
				agentCapabilities || undefined,
				{
					conversationHistory: input.conversationHistory,
					previousStepResults: input.previousStepResults,
					variables: input.variables,
					delegationMode,
				},
			);

			const context: Record<string, unknown> = {
				stepIndex: input.stepIndex,
				totalSteps: input.totalSteps,
				previousStepResults: input.previousStepResults,
				variables: input.variables,
				stepInputs: input.step.inputs,
				capability: input.step.capability,
				isWebTask: input.step.capability === "web",
				// Weave agent context enrichment
				reviewMode: stepInputs?.reviewMode as string | undefined,
				taskContext: stepInputs?.taskContext as string | undefined,
				changedFiles: stepInputs?.changedFiles as string[] | undefined,
				originalPlan: stepInputs?.originalPlan as string | undefined,
			};

			// Publish step progress to PartyKit so UI shows delegation is in progress
			// This is critical for real-time tool call display during delegation
			if (input.executionId) {
				const delegationToolCall = {
					id: `delegate_${agentToDelegate}_${Date.now()}`,
					name: `delegate:${agent.name}`,
					serverName: agent.protocol,
					args: { task: input.step.description },
					status: "running" as const,
				};
				await publishStepProgress(input.executionId, {
					stepId: input.step.id,
					stepDescription: input.step.description,
					phase: "executing",
					toolCalls: [delegationToolCall],
					stepIndex: input.stepIndex,
					totalSteps: input.totalSteps,
					message: `Delegating to ${agent.name}...`,
				}).catch(() => {}); // Non-blocking
			}

			// Enrich delegation message for weave agents (skills, sandbox, project context)
			let finalMessage = delegationMessage;
			if (isWeaveAgent(agentToDelegate)) {
				// Tapestry context propagation: prepend prior step results
				const priorContext = (stepInputs?.priorContext as string) || "";
				if (priorContext) {
					finalMessage = `<prior-step-results>\n${priorContext}\n</prior-step-results>\n\n${finalMessage}`;
				}

				const sandboxVar = input.variables?.["weave.sandboxSessionId"];
				finalMessage = await enrichWeaveDelegationMessage({
					agentId: agentToDelegate,
					message: finalMessage,
					projectId: (input.step.inputs as Record<string, unknown>)
						?.projectId as string | undefined,
					userId: input.userId,
					organizationId: input.organizationId,
					sandboxSessionId:
						typeof sandboxVar?.value === "string"
							? sandboxVar.value
							: undefined,
				});
			}

			const agentTimeoutMs =
				agentToDelegate === "weave_shuttle"
					? Number(
							(stepInputs?.codingRunTimeoutMs as
								| number
								| undefined) ?? 15 * 60 * 1000,
						)
					: undefined;

			const result = await delegateToAgent({
				agentId: agentToDelegate,
				message: finalMessage,
				context,
				userId: input.userId,
				organizationId: input.organizationId,
				projectId: input.projectId,
				timeout: agentTimeoutMs,
				delegationMode,
				preserveContext: isCompleteTaskDelegation
					? (stepInputs?.preserveContext as boolean) || true
					: false,
				inheritedVariables: isCompleteTaskDelegation
					? input.variables
					: undefined,
				originalTaskDescription: isCompleteTaskDelegation
					? (stepInputs?.originalTaskDescription as string) ||
						input.step.description
					: undefined,
				expectedArtifacts: isCompleteTaskDelegation
					? ["code", "subtasks", "variables"]
					: undefined,
				conversationHistory: input.conversationHistory,
				// Pass execution context for PartyKit real-time updates
				executionId: input.executionId,
				stepId: input.step.id,
			});

			console.log(
				`[AgentHandler] Agent ${agent.name} ${result.status} in ${result.durationMs}ms`,
			);

			if (result.status === "failed") {
				console.warn(
					`[AgentHandler] Agent delegation failed: ${result.response}`,
				);
				return {
					success: false,
					attempted: true,
					error: result.response,
				};
			}

			const agentIdentifier =
				agent.name || agentToDelegate || input.step.executor || "agent";

			const agentToolCall: ToolCallRecord = {
				id: `agent_${agentIdentifier}_${Date.now()}`,
				name: `delegate:${agent.name}`,
				args: {
					task: input.step.description,
					protocol: agent.protocol,
				},
				result:
					result.status === "completed"
						? {
								success: true,
								response: result.response,
								responseLength: result.response.length,
							}
						: { success: false, error: result.response },
				status: result.status === "completed" ? "success" : "error",
				durationMs: result.durationMs,
			};

			const artifactToolCalls: ToolCallRecord[] = result.artifacts.map(
				(artifact, idx) => ({
					id: `agent_${agentIdentifier}_artifact_${idx}`,
					name: `${agentIdentifier}:${artifact.name}`,
					args: {},
					result: artifact.content,
					status: "success" as const,
					durationMs: 0,
				}),
			);

			const outputVariables: Record<string, AgentVariable> = {
				[`agent.${agentIdentifier}.response`]: {
					name: `agent.${agentIdentifier}.response`,
					value: result.response,
					setBy: input.step.id,
					setAt: new Date().toISOString(),
					scope: "workflow",
				},
			};

			const stepArtifacts = result.artifacts.map((artifact, idx) => {
				const mimeType = artifact.mimeType || "";
				let artifactType: "document" | "code" | "data" = "document";
				if (
					mimeType.includes("javascript") ||
					mimeType.includes("typescript") ||
					mimeType.includes("python") ||
					mimeType.includes("json")
				) {
					artifactType = "code";
				} else if (
					mimeType.includes("json") ||
					mimeType.includes("xml")
				) {
					artifactType = "data";
				}

				return {
					id: `artifact-${input.step.id}-${idx}`,
					type: artifactType,
					name: artifact.name || `${agentIdentifier} output`,
					content:
						typeof artifact.content === "string"
							? artifact.content
							: JSON.stringify(artifact.content),
					metadata: {
						agentId: agentToDelegate,
						agentName: agent.name,
						mimeType: artifact.mimeType,
					},
				};
			});

			return {
				success: true,
				attempted: true,
				output: {
					outputs: {
						response: result.response,
						agentId: agentToDelegate,
						agentName: agent.name,
						artifacts: result.artifacts,
						delegatedTo: agent.name,
					},
					variables: outputVariables,
					toolCalls: [agentToolCall, ...artifactToolCalls],
					response: result.response,
					artifacts: stepArtifacts,
				},
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			console.error("[AgentHandler] Agent delegation failed:", error);
			return { success: false, attempted: true, error: errorMessage };
		}
	}
}
