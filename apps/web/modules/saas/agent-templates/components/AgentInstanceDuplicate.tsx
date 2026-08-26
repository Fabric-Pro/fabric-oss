"use client";

import { Spinner } from "@shared/components/Spinner";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Card, CardContent } from "@ui/components/card";
import { AlertCircleIcon } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import {
	type AgentBuilderInitialValues,
	CreateAgentPage,
	type StarterMessage,
} from "./CreateAgentPage";
import type { TriggerConfig } from "./TriggersSheet";
import type { WorkspaceDocumentFilter } from "./WorkspacesSheet";

type InstanceWithTemplate = {
	template?: {
		id: string;
		slug: string;
		name: string;
		displayName: string;
		description: string;
		heroEmojis: string[];
		category: string;
		instructions: string;
		suggestedModel?: string | null;
	} | null;
	integrationConfigurations?: Array<{
		integrationType: string;
		integrationId: string;
		allowedResources?: unknown;
	}>;
	memoryFiles?: Array<{
		path: string;
		sourceSkillId?: string | null;
	}>;
	toolConnections?: Record<string, Record<string, unknown>> | null;
	customInstructions?: Record<string, unknown> | null;
	workspaceIds?: string[];
	triggers?: Array<{
		type: string;
		enabled?: boolean;
		config?: Record<string, unknown>;
	}> | null;
	executionMode?: "single_turn" | "goal_oriented" | null;
	goal?: string | null;
	maxIterations?: number | null;
	isApiExposed?: boolean;
	name: string;
	description?: string | null;
};

type Props = {
	instanceId: string;
	organizationId?: string | null;
	basePath?: string;
};

export function AgentInstanceDuplicate({
	instanceId,
	organizationId,
	basePath = "/app/agent-templates",
}: Props) {
	const { data, isLoading, error } = useQuery(
		orpc.agentTemplates.instances.get.queryOptions({
			input: { id: instanceId },
		}),
	);

	const initialValues = useMemo<AgentBuilderInitialValues | null>(() => {
		const instance = data?.instance as InstanceWithTemplate | undefined;
		if (!instance) {
			return null;
		}

		const customInstructions = instance.customInstructions ?? {};
		const starterMessages = Array.isArray(
			customInstructions.starterMessages,
		)
			? (customInstructions.starterMessages as StarterMessage[])
			: [];
		const workspaceDocumentFilters = Array.isArray(
			customInstructions.knowledgeFilters,
		)
			? (customInstructions.knowledgeFilters as WorkspaceDocumentFilter[])
			: [];
		const selectedSkillIds = (instance.memoryFiles ?? [])
			.map((file) => file.sourceSkillId)
			.filter((id): id is string => Boolean(id));

		const selectedDataSources = [
			...(instance.workspaceIds ?? []),
			...(instance.integrationConfigurations ?? []).map(
				(config) => config.integrationType,
			),
		];

		const selectedTools = Object.entries(instance.toolConnections ?? {})
			.filter(([, config]) => config?.enabled !== false)
			.map(([toolName]) => toolName);

		// Per-provider resource scoping (e.g. Databricks Vector Search schema +
		// index selection) persisted on AgentIntegrationConfiguration.allowedResources.
		const knowledgeResources: Record<
			string,
			{ schema: string; indexes: string[] }
		> = {};
		for (const config of instance.integrationConfigurations ?? []) {
			const allowed = config.allowedResources;
			if (
				allowed &&
				typeof allowed === "object" &&
				typeof (allowed as { schema?: unknown }).schema === "string" &&
				Array.isArray((allowed as { indexes?: unknown }).indexes) &&
				(allowed as { indexes: unknown[] }).indexes.every(
					(index) => typeof index === "string",
				)
			) {
				knowledgeResources[config.integrationType] = {
					schema: (allowed as { schema: string }).schema,
					indexes: (allowed as { indexes: string[] }).indexes,
				};
			}
		}

		const databricksIntegrationId = (
			instance.integrationConfigurations ?? []
		).find(
			(config) => config.integrationType === "DATABRICKS_VECTOR_SEARCH",
		)?.integrationId;

		return {
			name: `${instance.name} Copy`,
			description: instance.description ?? "",
			instructions:
				typeof customInstructions.additionalContext === "string"
					? customInstructions.additionalContext
					: typeof customInstructions.role === "string"
						? customInstructions.role
						: "",
			selectedDataSources,
			selectedTools,
			selectedSkillIds,
			knowledgeResources,
			databricksIntegrationId,
			triggers: instance.triggers?.map(
				(trigger): TriggerConfig => ({
					type: trigger.type,
					enabled: trigger.enabled !== false,
					config: trigger.config,
				}),
			) ?? [{ type: "manual", enabled: true }],
			executionMode:
				instance.executionMode === "goal_oriented"
					? "goal_oriented"
					: "single_turn",
			goal: instance.goal ?? "",
			maxIterations: instance.maxIterations ?? 10,
			isApiExposed: instance.isApiExposed ?? false,
			starterMessages,
			workspaceDocumentFilters,
			existingToolConnections: instance.toolConnections ?? {},
			existingSkillFiles: (instance.memoryFiles ?? []).map((file) => ({
				path: file.path,
				sourceSkillId: file.sourceSkillId,
			})),
		};
	}, [data?.instance]);

	if (isLoading) {
		return (
			<div className="flex justify-center py-12">
				<Spinner className="h-8 w-8" />
			</div>
		);
	}

	if (error || !data?.instance) {
		return (
			<Card>
				<CardContent className="py-12 text-center">
					<AlertCircleIcon className="mx-auto h-12 w-12 text-destructive/50" />
					<h3 className="mt-4 font-semibold">Agent Not Found</h3>
					<p className="mt-2 text-muted-foreground">
						{error?.message ||
							"The agent you're trying to duplicate doesn't exist."}
					</p>
					<Button asChild className="mt-4">
						<Link href={basePath}>Go Back</Link>
					</Button>
				</CardContent>
			</Card>
		);
	}

	const instance = data.instance as InstanceWithTemplate;
	if (!instance.template || !initialValues) {
		return (
			<Card>
				<CardContent className="py-12 text-center">
					<AlertCircleIcon className="mx-auto h-12 w-12 text-destructive/50" />
					<h3 className="mt-4 font-semibold">Template Missing</h3>
					<p className="mt-2 text-muted-foreground">
						This agent no longer has a valid template reference.
					</p>
					<Button asChild className="mt-4">
						<Link href={basePath}>Go Back</Link>
					</Button>
				</CardContent>
			</Card>
		);
	}

	return (
		<CreateAgentPage
			template={instance.template}
			organizationId={organizationId ?? undefined}
			basePath={basePath}
			mode="create"
			initialValues={initialValues}
		/>
	);
}
