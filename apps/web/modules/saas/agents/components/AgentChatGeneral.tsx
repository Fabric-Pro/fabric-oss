"use client";

/**
 * AgentChatGeneral - General chat interface for non-document agents
 *
 * Features:
 * - Fabric logo icon (instead of placeholder emoji)
 * - Contextual prompt suggestions based on agent type
 * - Polished styling matching Fabric Agent direct mode
 * - CopilotKit sidebar integration
 */

import { CopilotKit } from "@copilotkit/react-core";
import { CopilotSidebar } from "@copilotkit/react-ui";
import { CopilotAssistantMessage } from "@saas/shared/components/copilot/CopilotAssistantMessage";
import { useCopilotErrorHandler } from "@saas/shared/components/copilot/use-copilot-error-handler";
import "@copilotkit/react-ui/styles.css";
import { FabricLogo } from "@saas/shared/components/FabricLogo";
import { Badge } from "@ui/components/badge";
import { useHumanInLoop } from "../hooks/useHumanInLoop";
import { HITLDialog } from "./HITLDialog";
import type { ReasoningMode } from "./ReasoningModeSelector";

interface AgentChatGeneralProps {
	agent: any;
	runtimeUrl: string;
	reasoningMode: ReasoningMode;
	onReasoningModeChange: (mode: ReasoningMode) => void;
	useOrchestrator?: boolean;
}

/**
 * Get contextual prompt suggestions based on agent ID
 */
function getAgentSuggestions(agentId: string, useOrchestrator?: boolean) {
	if (useOrchestrator) {
		return [
			{
				title: "Plan a feature",
				message: "Help me plan the implementation of a new feature",
			},
			{ title: "Write code", message: "I need help writing some code" },
			{ title: "Generate docs", message: "Help me create documentation" },
			{
				title: "Break down tasks",
				message: "Break down this feature into tasks",
			},
		];
	}

	// Agent-specific suggestions
	const suggestions: Record<
		string,
		Array<{ title: string; message: string }>
	> = {
		task_planner: [
			{
				title: "Plan authentication",
				message: "Break down user authentication with OAuth",
			},
			{
				title: "Plan API endpoint",
				message: "Plan tasks for a REST API endpoint",
			},
			{
				title: "Analyze risks",
				message: "Analyze risks for implementing a payment system",
			},
		],
		story_breakdown: [
			{
				title: "Create features",
				message:
					"Convert this PRD into features with acceptance criteria",
			},
			{
				title: "Estimate features",
				message: "Provide story point estimates for these features",
			},
			{
				title: "Sprint planning",
				message: "Help me plan a 2-week sprint",
			},
		],
		cuga_generalist: [
			{
				title: "Browser automation",
				message:
					"Navigate to a website and extract product information",
			},
			{
				title: "Multi-API workflow",
				message: "Orchestrate a workflow across multiple APIs",
			},
			{
				title: "Code execution",
				message: "Execute Python code to analyze data",
			},
			{
				title: "Task decomposition",
				message: "Break down this complex task into subtasks",
			},
		],
		prompt_enhancer: [
			{
				title: "Enhance prompt",
				message: "Make this prompt more effective",
			},
			{
				title: "Add variables",
				message: "Add template variables to this prompt",
			},
			{
				title: "Apply best practices",
				message: "Apply prompt engineering best practices",
			},
		],
	};

	return (
		suggestions[agentId] || [
			{ title: "Get started", message: "What can you help me with?" },
			{
				title: "Show capabilities",
				message: "What are your capabilities?",
			},
			{
				title: "Example task",
				message: "Show me an example of what you can do",
			},
		]
	);
}

export function AgentChatGeneral({
	agent,
	runtimeUrl,
	reasoningMode,
	useOrchestrator = false,
}: AgentChatGeneralProps) {
	const suggestions = getAgentSuggestions(agent?.agentId, useOrchestrator);
	const onError = useCopilotErrorHandler();

	return (
		<div className="h-full w-full">
			<CopilotKit
				runtimeUrl={runtimeUrl}
				useSingleEndpoint
				agent={useOrchestrator ? "orchestrator" : agent?.agentId}
				showDevConsole={false}
				onError={onError}
			>
				<AgentChatGeneralContent
					agent={agent}
					reasoningMode={reasoningMode}
					suggestions={suggestions}
					useOrchestrator={useOrchestrator}
				/>
			</CopilotKit>
		</div>
	);
}

function AgentChatGeneralContent({
	agent,
	reasoningMode,
	suggestions,
	useOrchestrator,
}: {
	agent: any;
	reasoningMode: ReasoningMode;
	suggestions: Array<{ title: string; message: string }>;
	useOrchestrator?: boolean;
}) {
	// HITL hook for human-in-the-loop interactions
	const { pendingRequest, hasActiveRequest, respond, dismiss } =
		useHumanInLoop({
			defaultTimeout: 60000,
		});

	return (
		<>
			<CopilotSidebar
				AssistantMessage={CopilotAssistantMessage}
				defaultOpen={true}
				clickOutsideToClose={false}
				labels={{
					title: agent?.displayName || "AI Assistant",
					initial: useOrchestrator
						? "Hi! I'm Fabric Loom. I can help you with planning, coding, document generation, and more. What would you like to work on today?"
						: `Hi! I'm ${agent?.displayName}. ${agent?.description || "How can I help you today?"}`,
				}}
				suggestions={suggestions}
			>
				<div className="flex items-center justify-center h-full">
					<div className="text-center space-y-6 max-w-lg px-6">
						{/* Fabric Logo */}
						<FabricLogo size={80} className="mx-auto opacity-80" />

						{/* Agent Info */}
						<div className="space-y-3">
							<h3 className="text-2xl font-semibold">
								{agent?.displayName}
							</h3>
							<p className="text-sm text-muted-foreground leading-relaxed">
								{agent?.description}
							</p>
						</div>

						{/* Reasoning Mode Badge */}
						<div className="flex items-center justify-center">
							<Badge variant="outline" className="font-normal">
								{reasoningMode === "lite" && "Fast Mode"}
								{reasoningMode === "balanced" &&
									"Balanced Mode"}
								{reasoningMode === "deep" && "Thorough Mode"}
							</Badge>
						</div>
					</div>
				</div>
			</CopilotSidebar>

			{/* HITL Dialog */}
			<HITLDialog
				request={pendingRequest}
				open={hasActiveRequest}
				onRespond={respond}
				onDismiss={dismiss}
			/>
		</>
	);
}
