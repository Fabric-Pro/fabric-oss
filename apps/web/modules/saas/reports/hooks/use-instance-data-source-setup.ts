"use client";

import {
	analyzePMToolCapabilities,
	fetchContainersWithHierarchy,
	type McpTool,
} from "@saas/projects/lib/pm-tool-analyzer";
import {
	findMatchingMcpConfigs,
	getMcpConfigDisplayName,
	type McpConfigForDisplay,
} from "@saas/reports/lib/mcp-utils";
import {
	accountSlugFromContext,
	boardResourceBindings,
	type ContextField,
	contextFieldsForProviders,
	contextWithListedBoard,
	isRequiredDataSource,
	pickPrefillContext,
	projectConnectionDefaults,
} from "@saas/reports/lib/report-template-definition";
import {
	type DataSourceDefinition,
	PROVIDER_CONTEXT_FIELDS,
} from "@saas/shared/components/DataSourceDefinitionBuilder";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** Providers whose boards (containers) can be listed and picked from a dropdown. */
const BOARD_SELECTABLE_PROVIDERS = new Set(["fizzy"]);

export function isBoardSelectableProvider(provider: string): boolean {
	return BOARD_SELECTABLE_PROVIDERS.has(provider);
}

type DataSourceBinding = {
	mcpConfigId: string;
	mcpConfigName: string;
};

export type InstanceDataSourceSetupOptions = {
	dataSources: DataSourceDefinition[];
	organizationId: string | null;
	/** Hold the queries until the organization context has loaded. */
	enabled?: boolean;
	/**
	 * Read the account and boards from the selected MCP server (Fizzy) to fill
	 * the account slug and offer a board picker.
	 */
	autoDetect: boolean;
	/**
	 * Report suite defaults: bind the only recommended MCP server, and start
	 * from the context an earlier report of `projectId` saved.
	 */
	suggestDefaults: boolean;
	projectId?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The account slug an identity tool (e.g. `fizzy_get_identity`) reports. */
function accountSlugFromIdentity(payload: unknown): string | null {
	if (!isRecord(payload) || payload.error) {
		return null;
	}
	const result = payload.result;
	const accounts = isRecord(result)
		? result.accounts
		: Array.isArray(result)
			? result
			: null;
	const first = Array.isArray(accounts) ? accounts[0] : null;
	if (!isRecord(first)) {
		return null;
	}
	const raw =
		typeof first.slug === "string"
			? first.slug
			: typeof first.id === "string"
				? first.id
				: "";
	return raw.replace(/^\/+/, "") || null;
}

/**
 * State and actions for the data-source part of creating a report: which MCP
 * server each data source reads through, and the context the AI needs to find
 * the data. Shared by the create dialog and the create page.
 */
export function useInstanceDataSourceSetup({
	dataSources,
	organizationId,
	enabled = true,
	autoDetect,
	suggestDefaults,
	projectId,
}: InstanceDataSourceSetupOptions) {
	const [bindings, setBindings] = useState<Record<string, DataSourceBinding>>(
		{},
	);
	const [contextValues, setContextValues] = useState<Record<string, string>>(
		{},
	);
	const [boards, setBoards] = useState<Array<{ id: string; name: string }>>(
		[],
	);
	const [isLoadingBoards, setIsLoadingBoards] = useState(false);
	const [boardsError, setBoardsError] = useState<string | null>(null);
	const [boardsMcpConfigId, setBoardsMcpConfigId] = useState<string | null>(
		null,
	);

	const { data: mcpConfigsData, isError: mcpConfigsFailed } = useQuery({
		...orpc.mcp.configs.list.queryOptions({
			input: { organizationId, limit: 100 },
		}),
		enabled,
	});
	const userMcpConfigs: McpConfigForDisplay[] = useMemo(
		() =>
			Array.isArray(mcpConfigsData)
				? mcpConfigsData
				: (mcpConfigsData?.configs ?? []),
		[mcpConfigsData],
	);

	// An optional source the person has not connected asks for no context.
	const contextFields: ContextField[] = useMemo(
		() =>
			contextFieldsForProviders(
				Array.from(
					new Set(
						dataSources
							.filter(
								(ds) =>
									isRequiredDataSource(ds) ||
									bindings[ds.id]?.mcpConfigId,
							)
							.map((ds) => ds.provider),
					),
				),
				PROVIDER_CONTEXT_FIELDS,
			),
		[dataSources, bindings],
	);

	const allConfigured = useMemo(() => {
		if (
			!dataSources.every(
				(ds) =>
					ds.type === "fabric" ||
					!isRequiredDataSource(ds) ||
					bindings[ds.id]?.mcpConfigId,
			)
		) {
			return false;
		}
		return contextFields.every(
			(field) => !field.required || contextValues[field.key]?.trim(),
		);
	}, [dataSources, bindings, contextFields, contextValues]);

	const setContextValue = useCallback((key: string, value: string) => {
		setContextValues((prev) => ({ ...prev, [key]: value }));
	}, []);

	/** Fill a field only while the person has not typed into it. */
	const offerContextValue = useCallback((key: string, value: string) => {
		setContextValues((prev) =>
			prev[key]?.trim() ? prev : { ...prev, [key]: value },
		);
	}, []);

	// Fetch boards/containers and identity from an MCP server
	const fetchBoards = useCallback(
		async (mcpConfigId: string) => {
			setIsLoadingBoards(true);
			setBoardsError(null);
			setBoards([]);
			setBoardsMcpConfigId(mcpConfigId);
			try {
				const { tools: toolsList } = await orpcClient.mcp.tools.list({
					serverIds: [mcpConfigId],
					organizationId,
				});
				if (!toolsList || toolsList.length === 0) {
					setBoardsError("No tools available from this MCP server");
					return;
				}
				const tools: McpTool[] = toolsList.map((t) => ({
					name: t.name,
					description: t.description,
					inputSchema: t.inputSchema as McpTool["inputSchema"],
					parameters: t.parameters,
				}));

				// Auto-fill account slug by calling identity tool (e.g. fizzy_get_identity)
				const identityToolName = toolsList.find((t) => {
					const lower = t.name.toLowerCase();
					return (
						lower.endsWith("_get_identity") ||
						lower.endsWith("_whoami")
					);
				})?.name;

				if (identityToolName) {
					try {
						const identityRes = await fetch(
							"/api/pipeline/mcp-tool",
							{
								method: "POST",
								headers: {
									"Content-Type": "application/json",
								},
								body: JSON.stringify({
									mcpConfigId,
									toolName: identityToolName,
									params: {},
									organizationId: organizationId ?? undefined,
								}),
							},
						);
						const identityData: unknown = await identityRes.json();
						const slug = identityRes.ok
							? accountSlugFromIdentity(identityData)
							: null;
						if (slug) {
							offerContextValue("accountSlug", slug);
						}
					} catch {
						// Identity fetch is best-effort, don't block board loading
					}
				}

				const capabilities = analyzePMToolCapabilities(tools);
				if (
					!capabilities.hasPMCapabilities ||
					capabilities.containerHierarchy.length === 0
				) {
					return;
				}
				const { containers, additionalContext } =
					await fetchContainersWithHierarchy(
						mcpConfigId,
						capabilities.containerHierarchy,
						organizationId ?? undefined,
					);
				setBoards(containers);

				// Also try to fill accountSlug from hierarchy context
				// (e.g. if accounts were an intermediate level)
				const slugFromContext =
					accountSlugFromContext(additionalContext);
				if (slugFromContext) {
					offerContextValue("accountSlug", slugFromContext);
				}
			} catch (err) {
				setBoardsError(
					err instanceof Error
						? err.message
						: "Failed to load boards",
				);
			} finally {
				setIsLoadingBoards(false);
			}
		},
		[organizationId, offerContextValue],
	);

	// A board from the project's defaults or an earlier report may no longer
	// exist; drop it once the board list shows it is gone.
	const selectedBoardId = contextValues.boardId;
	useEffect(() => {
		if (!selectedBoardId) {
			return;
		}
		setContextValues((prev) => contextWithListedBoard(prev, boards));
	}, [boards, selectedBoardId]);

	const selectMcpConfig = useCallback(
		(dataSourceId: string, configId: string) => {
			const config = userMcpConfigs.find((c) => c.id === configId);
			setBindings((prev) => ({
				...prev,
				[dataSourceId]: {
					mcpConfigId: configId,
					mcpConfigName: config
						? getMcpConfigDisplayName(config)
						: configId,
				},
			}));

			// Fetch boards when a board-selectable provider's MCP config is selected
			const ds = dataSources.find((d) => d.id === dataSourceId);
			if (
				autoDetect &&
				ds &&
				isBoardSelectableProvider(ds.provider) &&
				configId !== boardsMcpConfigId
			) {
				void fetchBoards(configId);
			}
		},
		[
			userMcpConfigs,
			dataSources,
			autoDetect,
			boardsMcpConfigId,
			fetchBoards,
		],
	);

	/** Skip an optional data source: the report runs without it. */
	const clearMcpConfig = useCallback((dataSourceId: string) => {
		setBindings((prev) => {
			const next = { ...prev };
			delete next[dataSourceId];
			return next;
		});
	}, []);

	// A project's report starts from the project's own PM connection and
	// board. It waits for the project so the suggestion below cannot bind a
	// different server first; a connection the creator cannot use is skipped.
	const projectDefaultsEnabled =
		enabled && suggestDefaults && Boolean(projectId);
	const { data: projectData, isFetched: projectFetched } = useQuery({
		...orpc.projects.get.queryOptions({
			input: { id: projectId ?? "", organizationId },
		}),
		enabled: projectDefaultsEnabled,
	});
	const waitingForProject = projectDefaultsEnabled && !projectFetched;
	const suggestedRef = useRef(new Set<string>());
	const projectDefaultsAppliedRef = useRef(false);
	useEffect(() => {
		const project = projectData?.project;
		if (
			!project ||
			projectDefaultsAppliedRef.current ||
			userMcpConfigs.length === 0
		) {
			return;
		}
		projectDefaultsAppliedRef.current = true;
		const defaults = projectConnectionDefaults(
			dataSources,
			project,
			userMcpConfigs,
			isBoardSelectableProvider,
		);
		for (const [dataSourceId, config] of Object.entries(
			defaults.bindings,
		)) {
			suggestedRef.current.add(dataSourceId);
			selectMcpConfig(dataSourceId, config.id);
		}
		for (const [key, value] of Object.entries(defaults.context)) {
			offerContextValue(key, value);
		}
	}, [
		projectData,
		userMcpConfigs,
		dataSources,
		selectMcpConfig,
		offerContextValue,
	]);

	// Bind a data source to its MCP server when exactly one recommended server
	// matches, so the board list and account slug load without a click. Each
	// data source is suggested once; the person can still pick another.
	useEffect(() => {
		if (
			!suggestDefaults ||
			waitingForProject ||
			userMcpConfigs.length === 0
		) {
			return;
		}
		for (const ds of dataSources) {
			if (
				ds.type === "fabric" ||
				suggestedRef.current.has(ds.id) ||
				bindings[ds.id]
			) {
				continue;
			}
			suggestedRef.current.add(ds.id);
			const matches = findMatchingMcpConfigs(userMcpConfigs, ds.provider);
			if (matches.length === 1) {
				selectMcpConfig(ds.id, matches[0].id);
			}
		}
	}, [
		suggestDefaults,
		waitingForProject,
		userMcpConfigs,
		dataSources,
		bindings,
		selectMcpConfig,
	]);

	// Start from the context the project's latest report saved, so a second
	// report on the same board does not ask for the account and board again.
	const prefillEnabled =
		enabled &&
		suggestDefaults &&
		Boolean(projectId) &&
		contextFields.length > 0;
	const { data: projectInstances } = useQuery({
		...orpc.reports.instances.list.queryOptions({
			input: { organizationId, projectId, limit: 1, offset: 0 },
		}),
		enabled: prefillEnabled,
	});
	const latestInstanceId = projectInstances?.instances[0]?.id;
	const { data: latestInstance } = useQuery({
		...orpc.reports.instances.get.queryOptions({
			input: { id: latestInstanceId ?? "", organizationId },
		}),
		enabled: prefillEnabled && Boolean(latestInstanceId),
	});
	// The project's own board, applied above, wins over an earlier report's.
	// A connections list that failed or is not asked for will not bring that
	// board, so it does not hold the prefill back.
	const projectDefaultsPending =
		waitingForProject ||
		(Boolean(projectData?.project?.projectManagementMcpConfigId) &&
			enabled &&
			!mcpConfigsFailed &&
			mcpConfigsData === undefined);
	const prefilledRef = useRef(false);
	useEffect(() => {
		if (!latestInstance || prefilledRef.current || projectDefaultsPending) {
			return;
		}
		prefilledRef.current = true;
		const prefill = pickPrefillContext(
			latestInstance.connections,
			contextFields,
		);
		for (const [key, value] of Object.entries(prefill)) {
			offerContextValue(key, value);
		}
	}, [
		latestInstance,
		projectDefaultsPending,
		contextFields,
		offerContextValue,
	]);

	/** The `connections` fields `reports.instances.create` takes from this setup. */
	const buildConnections = useCallback(() => {
		const mcpConfigs: string[] = [];
		const mcpBindings: Record<string, string> = {};
		for (const [dsId, binding] of Object.entries(bindings)) {
			if (!mcpConfigs.includes(binding.mcpConfigId)) {
				mcpConfigs.push(binding.mcpConfigId);
			}
			mcpBindings[dsId] = binding.mcpConfigId;
			// Also key by provider so the binding is found by provider too —
			// the runtime MCP handler looks up `mcpBindings[dataSource.provider]`.
			const ds = dataSources.find((d) => d.id === dsId);
			if (ds?.provider && ds.provider !== dsId) {
				mcpBindings[ds.provider] = binding.mcpConfigId;
			}
		}

		const context: Record<string, string> = {};
		for (const [key, value] of Object.entries(contextValues)) {
			if (value?.trim()) {
				context[key] = value.trim();
			}
		}
		const resourceBindings = boardResourceBindings(
			dataSources.filter((ds) => bindings[ds.id]),
			context,
			isBoardSelectableProvider,
		);
		return { mcpConfigs, mcpBindings, resourceBindings, context };
	}, [bindings, contextValues, dataSources]);

	return {
		userMcpConfigs,
		bindings,
		selectMcpConfig,
		clearMcpConfig,
		contextFields,
		contextValues,
		setContextValue,
		setContextValues,
		allConfigured,
		boards,
		isLoadingBoards,
		boardsError,
		boardsMcpConfigId,
		autoDetect,
		suggestDefaults,
		buildConnections,
	};
}

export type InstanceDataSourceSetup = ReturnType<
	typeof useInstanceDataSourceSetup
>;
