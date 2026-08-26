"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { Spinner } from "@shared/components/Spinner";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import { AlertCircle, AlertTriangleIcon, SettingsIcon } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { AgentChatAPI } from "./AgentChatAPI";
import { AgentChatCode } from "./AgentChatCode";
import { AgentChatDocument } from "./AgentChatDocument";
import { AgentChatGeneral } from "./AgentChatGeneral";
import type { ReasoningMode } from "./ReasoningModeSelector";

interface AgentChatCopilotKitProps {
	agentId: string;
	/** Use orchestrator mode - routes to specialized agents automatically */
	useOrchestrator?: boolean;
}

interface AgentCapabilities {
	supportsPredictiveState?: boolean;
	usesOpenAPI?: boolean;
	requiresEditor?: boolean;
	editorType?: "document" | "prompt" | "code";
}

/**
 * Agent Chat Interface using CopilotKit
 *
 * Provides a unified chat interface for all agents using CopilotKit's runtime.
 * Supports:
 * - Real-time streaming
 * - Predictive state updates
 * - AG-UI protocol
 * - Multi-tenancy (user and organization scoped)
 * - Reasoning mode selection (Fast/Balanced/Thorough)
 * - Human-in-the-loop dialogs
 */
export function AgentChatCopilotKit({
	agentId,
	useOrchestrator = false,
}: AgentChatCopilotKitProps) {
	const { organizationId, organizationName, basePath, isOrgContext } =
		useOrganizationContext();
	const [reasoningMode, setReasoningMode] =
		useState<ReasoningMode>("balanced");

	// Check AI configuration status
	// IMPORTANT: Pass null explicitly for personal context to prevent
	// session fallback which could leak org data to personal pages
	const { data: aiConfigStatus, isLoading: isLoadingAiConfig } = useQuery({
		queryKey: ["aiConfigStatus", organizationId],
		queryFn: async () => {
			return await orpcClient.aiConfig.resolution.getStatus({
				organizationId,
			});
		},
	});

	// Fetch agent details
	const {
		data: agent,
		isLoading,
		error,
	} = useQuery({
		queryKey: ["agents", "registry", "get", agentId],
		queryFn: async () => {
			const result = await orpcClient.agents.registry.get({
				id: agentId,
			});
			return result;
		},
		enabled: !useOrchestrator,
	});

	// For orchestrator mode, use a default config
	const orchestratorConfig = useOrchestrator
		? {
				displayName: "Fabric Loom",
				description:
					"Your intelligent assistant that automatically routes tasks to specialized agents",
				status: "ACTIVE",
				framework: "orchestrator",
				agentId: "orchestrator",
			}
		: null;

	const activeAgent = useOrchestrator ? orchestratorConfig : agent;

	// Parse agent capabilities from metadata
	const capabilities = useMemo<AgentCapabilities | null>(() => {
		if (useOrchestrator || !agent?.metadata) {
			return null;
		}

		try {
			// Prisma automatically parses JSON columns, so metadata is already an object
			// But handle both cases for safety
			const metadata =
				typeof agent.metadata === "string"
					? JSON.parse(agent.metadata)
					: agent.metadata;

			// Debug logging
			console.log("[AgentChatCopilotKit] Agent:", agent.agentId);
			console.log(
				"[AgentChatCopilotKit] Metadata type:",
				typeof agent.metadata,
			);
			console.log("[AgentChatCopilotKit] Metadata:", metadata);
			console.log(
				"[AgentChatCopilotKit] Capabilities:",
				metadata?.capabilities,
			);

			return metadata?.capabilities || null;
		} catch (error) {
			console.error(
				"[AgentChatCopilotKit] Failed to parse metadata:",
				error,
			);
			return null;
		}
	}, [agent, useOrchestrator]);

	if (!useOrchestrator && isLoading) {
		return (
			<div className="flex items-center justify-center h-96">
				<Spinner />
			</div>
		);
	}

	if (!useOrchestrator && (error || !agent)) {
		return (
			<Alert variant="error">
				<AlertCircle className="h-4 w-4" />
				<AlertTitle>Failed to load agent</AlertTitle>
				<AlertDescription>
					{error instanceof Error ? error.message : "Agent not found"}
				</AlertDescription>
			</Alert>
		);
	}

	// Build runtime URL with organization context and reasoning mode
	const runtimeParams = new URLSearchParams();
	if (organizationId) {
		runtimeParams.set("organizationId", organizationId);
	}
	runtimeParams.set("reasoningMode", reasoningMode);
	if (useOrchestrator) {
		runtimeParams.set("useOrchestrator", "true");
	}
	const runtimeUrl = `/api/copilotkit?${runtimeParams.toString()}`;

	// Determine which UI to render based on agent capabilities
	const renderAgentUI = () => {
		// Document generators: split-pane with TipTap editor
		if (
			capabilities?.requiresEditor &&
			capabilities?.editorType === "document"
		) {
			return (
				<AgentChatDocument
					agent={activeAgent}
					runtimeUrl={runtimeUrl}
					reasoningMode={reasoningMode}
					onReasoningModeChange={setReasoningMode}
				/>
			);
		}

		// API Agent: specialized UI with request/response panels
		if (capabilities?.usesOpenAPI) {
			return (
				<AgentChatAPI
					agent={activeAgent}
					runtimeUrl={runtimeUrl}
					reasoningMode={reasoningMode}
					onReasoningModeChange={setReasoningMode}
				/>
			);
		}

		// Code Executor: code editor interface
		if (
			capabilities?.requiresEditor &&
			capabilities?.editorType === "code"
		) {
			return (
				<AgentChatCode
					agent={activeAgent}
					runtimeUrl={runtimeUrl}
					reasoningMode={reasoningMode}
					onReasoningModeChange={setReasoningMode}
				/>
			);
		}

		// General chat agents: polished chat interface with Fabric logo
		return (
			<AgentChatGeneral
				agent={activeAgent}
				runtimeUrl={runtimeUrl}
				reasoningMode={reasoningMode}
				onReasoningModeChange={setReasoningMode}
				useOrchestrator={useOrchestrator}
			/>
		);
	};

	// Check if AI provider is not configured
	const isAiNotConfigured =
		!isLoadingAiConfig && !aiConfigStatus?.isConfigured;

	// Generate the correct settings URL based on context
	const settingsUrl = `${basePath}/settings/ai-providers`;

	// Show full-page error when AI is not configured
	if (isAiNotConfigured) {
		return (
			<div className="flex flex-col h-full">
				{/* Warning Banner at Top */}
				<Alert
					variant="error"
					className="rounded-none border-x-0 border-t-0"
				>
					<AlertTriangleIcon className="size-4" />
					<AlertTitle className="font-bold">
						AI Provider Not Configured
					</AlertTitle>
					<AlertDescription className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
						<span className="text-sm">
							{isOrgContext
								? `The organization "${organizationName}" does not have an AI provider configured. AI features require at least one configured provider (e.g., OpenAI, Anthropic, Groq, or OpenRouter).`
								: "You have not configured an AI provider. AI features require at least one configured provider (e.g., OpenAI, Anthropic, Groq, or OpenRouter)."}
						</span>
						<Button
							asChild
							size="sm"
							variant="outline"
							className="shrink-0 border-destructive hover:bg-destructive/10"
						>
							<Link href={settingsUrl}>
								<SettingsIcon className="mr-2 size-4" />
								Configure AI Provider
							</Link>
						</Button>
					</AlertDescription>
				</Alert>

				{/* Centered Error State */}
				<div className="flex-1 flex items-center justify-center p-8">
					<div className="text-center max-w-md">
						<div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10">
							<AlertCircle className="h-8 w-8 text-destructive" />
						</div>
						<h3 className="text-lg font-semibold mb-2">
							Cannot Start Agent
						</h3>
						<p className="text-muted-foreground mb-6">
							This agent requires an AI provider to function.
							Please configure at least one AI provider in your
							settings to use this agent.
						</p>
						<Button asChild>
							<Link href={settingsUrl}>
								<SettingsIcon className="mr-2 size-4" />
								Go to AI Provider Settings
							</Link>
						</Button>
					</div>
				</div>
			</div>
		);
	}

	// Render the appropriate UI based on agent type
	return renderAgentUI();
}
