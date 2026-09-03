"use client";

/**
 * AgentChatDocument - Wrapper for document generator agents in organization context
 *
 * This component wraps the shared DocumentGeneratorEditor component with CopilotKit
 * to provide a consistent document editing experience across personal and org accounts.
 *
 * Features:
 * - TipTap rich-text editor with slash commands
 * - AG-UI protocol for real-time streaming updates
 * - Diff highlighting for AI-generated changes (green for additions, red for deletions)
 * - Predictive state updates pattern from CopilotKit
 *
 * IMPORTANT: This component uses the shared DocumentGeneratorEditor which implements
 * the 4-effect pattern for document streaming.
 * See docs/DOCUMENT_EDITOR_STREAMING_PATTERN.md for the canonical implementation.
 */

import { CopilotKit } from "@copilotkit/react-core";
import { makeCopilotAssistantMessage } from "@saas/shared/components/copilot/CopilotAssistantMessage";
import { CopilotChatSessionProvider } from "@saas/shared/components/copilot/CopilotChatSessionProvider";
import { useCopilotErrorHandler } from "@saas/shared/components/copilot/use-copilot-error-handler";
import { useMemo } from "react";
import { DocumentGeneratorEditor } from "./DocumentGeneratorEditor";
import type { ReasoningMode } from "./ReasoningModeSelector";

interface AgentChatDocumentProps {
	agent: any;
	runtimeUrl: string;
	reasoningMode: ReasoningMode;
	onReasoningModeChange: (mode: ReasoningMode) => void;
}

export function AgentChatDocument({
	agent,
	runtimeUrl,
}: AgentChatDocumentProps) {
	const onError = useCopilotErrorHandler();
	const effectiveAgentId = agent?.agentId || "document_generator";

	// Custom user agents have a dynamic `agentId`. Bind the assistant-message
	// factory to that exact name so reasoning state is read from the matching
	// `useCoAgent({ name })` channel. Without this, custom agents would
	// silently read reasoning from the wrong agent's state.
	const AssistantMessage = useMemo(
		() => makeCopilotAssistantMessage({ agentName: effectiveAgentId }),
		[effectiveAgentId],
	);

	return (
		<div className="h-full w-full">
			<CopilotKit
				runtimeUrl={runtimeUrl}
				useSingleEndpoint
				agent={agent?.agentId}
				showDevConsole={false}
				onError={onError}
			>
				<CopilotChatSessionProvider>
					<DocumentGeneratorEditor
						agentId={effectiveAgentId}
						title={agent?.displayName || "Document Generator"}
						AssistantMessage={AssistantMessage}
						initialMessage={`Hi! I'm ${agent?.displayName || "your AI assistant"}. I can help you create and edit documents. What would you like to work on?`}
						suggestions={[
							{
								title: "Create a PRD for user authentication",
								message:
									"Write a product requirements document for implementing user authentication with social login, email/password, and 2FA support",
							},
							{
								title: "Design a microservices architecture",
								message:
									"Create an architecture document for migrating our monolith to microservices, including service boundaries, communication patterns, and data management strategies",
							},
							{
								title: "Document API endpoints",
								message:
									"Generate technical documentation for our REST API, including authentication, rate limiting, request/response formats, and error handling",
							},
							{
								title: "Write onboarding guide",
								message:
									"Create a comprehensive onboarding guide for new developers joining the team, covering setup, architecture overview, coding standards, and deployment process",
							},
						]}
					/>
				</CopilotChatSessionProvider>
			</CopilotKit>
		</div>
	);
}
