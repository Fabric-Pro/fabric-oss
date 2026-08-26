/**
 * Template Instance Execution Workflow
 *
 * Executes a user's configured template instance with full Fabric AI integration.
 * This workflow handles:
 * - Fabric AI enrichment (Strategy + Context + Pattern)
 * - Data source fetching via handlers (MCP or Integration based on template config)
 * - RAG processing for large datasets
 * - AI analysis with enriched prompts and RAG context
 * - Artifact generation and indexing
 */

import type { AiJobKey } from "@repo/ai";
import type { Prisma } from "@repo/database/prisma/generated/client";
import {
	ApplicationFailure,
	patched,
	proxyActivities,
} from "@temporalio/workflow";
import type * as evidenceActivities from "../activities/evidence";
import type * as fabricAiActivities from "../activities/fabric-ai";
import type * as orchestratorActivities from "../activities/orchestrator";
import type * as templateInstanceActivities from "../activities/template-instance";
import type * as dataFetchingActivities from "../activities/template-instance/data-fetching";
// Pure (deterministic) helpers — safe to import into a workflow bundle.
import {
	classifyConnectionError,
	redactMessage,
} from "../activities/template-instance/mcp-diagnostics";
import type * as agentLoopActivities from "../activities/template-instance/report-agent-loop";
import {
	hasNoUsableData,
	mapAgenticGatheredData,
} from "../activities/template-instance/report-data-gate";
import type { McpServerDiagnostic } from "../activities/template-instance/types";

// Activity proxies - core template instance activities
const {
	fetchTemplateInstanceWithTemplate,
	updateInstanceExecutionStatus,
	renderInstanceReport,
	storeInstanceArtifact,
	indexInstanceArtifactForRag,
	fetchReportTemplateSkills,
} = proxyActivities<typeof templateInstanceActivities>({
	startToCloseTimeout: "10 minutes",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "1s",
		backoffCoefficient: 2,
		maximumInterval: "60s",
		maximumAttempts: 3,
	},
});

// Notification dispatch — short timeout, its own retry budget. Kept
// in a SEPARATE proxy so a notification outage cannot stall the long report
// activities, and the workflow can wrap the call to protect run status.
const { emitReportExecutionNotification, sendReportExecutionEmail } =
	proxyActivities<typeof templateInstanceActivities>({
		startToCloseTimeout: "30 seconds",
		retry: {
			initialInterval: "1s",
			backoffCoefficient: 2,
			maximumInterval: "20s",
			maximumAttempts: 5,
		},
	});

// Activity proxies - new handler-based data fetching with RAG support
const { fetchDataSources, executeAiAnalysis, cleanupRagCollection } =
	proxyActivities<typeof dataFetchingActivities>({
		startToCloseTimeout: "15 minutes", // Longer timeout for large datasets + RAG processing
		heartbeatTimeout: "3 minutes", // AI generation calls can take 40-60s+ per agent
		retry: {
			initialInterval: "2s",
			backoffCoefficient: 2,
			maximumInterval: "60s",
			maximumAttempts: 3,
		},
	});

// Activity proxies - agentic data gathering loop + self-healing connection resolution
const { executeAgentDataGatheringLoop, resolveReportConnections } =
	proxyActivities<typeof agentLoopActivities>({
		startToCloseTimeout: "30 minutes", // Paginated card sweeps at ~2 min/iteration need headroom for all 15 iterations (a 15-min budget died at iteration ~8 and burned attempt 1 of 2)
		heartbeatTimeout: "5 minutes", // Final HTML generation can take 3-5 min for large reports
		retry: {
			initialInterval: "2s",
			backoffCoefficient: 2,
			maximumInterval: "60s",
			maximumAttempts: 2, // Fewer retries for agentic loop
		},
	});

const { checkFabricHealth } = proxyActivities<typeof fabricAiActivities>({
	startToCloseTimeout: "30 seconds",
	heartbeatTimeout: "30 seconds",
	retry: {
		maximumAttempts: 2,
	},
});

const { applyFabricPatternEnrichment } = proxyActivities<
	typeof orchestratorActivities
>({
	startToCloseTimeout: "30 seconds",
	heartbeatTimeout: "30 seconds",
	retry: {
		maximumAttempts: 2,
	},
});

const { generateEvidenceReport } = proxyActivities<typeof evidenceActivities>({
	startToCloseTimeout: "10 minutes", // Evidence build can take a while
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "5s",
		backoffCoefficient: 2,
		maximumInterval: "60s",
		maximumAttempts: 2, // Fewer retries since build is expensive
	},
});

// =============================================================================
// Types
// =============================================================================

export interface TemplateInstanceExecutionInput {
	executionId: string;
	instanceId: string;
	userId: string;
	organizationId?: string;
	/**
	 * Attribution label set by the caller that started this run —
	 * "scheduled-report" for schedule dispatches; undefined for manual runs.
	 * Threaded into AI-invoking activities so their model calls land on
	 * AiUsageLog rows tagged as background work (Fizzy #1894).
	 */
	jobType?: AiJobKey;
	parameters?: Record<string, unknown>;
	dateRange?: {
		start: string;
		end: string;
		period?: "daily" | "weekly" | "monthly" | "quarterly" | "yearly";
	};
}

export interface TemplateInstanceExecutionOutput {
	executionId: string;
	// COMPLETED on the normal path; CANCELLED when the workflow self-aborts because a
	// user cancel already landed (the RUNNING status write was guard-blocked). Other
	// failures throw ApplicationFailure instead of returning.
	status: "COMPLETED" | "CANCELLED";
	artifacts: Array<{
		id: string;
		name: string;
		artifactType: string;
		mimeType: string;
		size: number;
	}>;
	fabricEnrichment?: {
		strategy: string | null;
		context: string | null;
		pattern: string | null;
		fabricAvailable: boolean;
	};
	error?: string;
	duration: number;
}

// =============================================================================
// Main Workflow
// =============================================================================

export async function templateInstanceExecutionWorkflow(
	input: TemplateInstanceExecutionInput,
): Promise<TemplateInstanceExecutionOutput> {
	const startTime = Date.now();
	const artifacts: TemplateInstanceExecutionOutput["artifacts"] = [];
	// Per-MCP-server connection diagnostics, populated by whichever data path
	// runs (agentic loop or traditional fetch). Declared at function scope so
	// both the success path and the catch block can persist them for the UI.
	let mcpDiagnostics: McpServerDiagnostic[] = [];

	try {
		// 1. Update status to RUNNING (also sets instance.lastRunAt to start time).
		// The write is guard-blocked if the row is already CANCELLED.
		const startedRunning = await updateInstanceExecutionStatus({
			executionId: input.executionId,
			instanceId: input.instanceId,
			status: "RUNNING",
			startedAt: new Date(),
		});

		// Self-cancel backstop: if the RUNNING write didn't land, a user cancel
		// already flipped this execution to CANCELLED. terminate() may not have
		// reached this worker (best-effort), so abort here — before the token-heavy
		// data-gathering / AI / render pipeline — rather than relying solely on
		// terminate() to stop the run. Leaves the CANCELLED row untouched; no
		// COMPLETED write, no notification/email.
		if (!startedRunning) {
			return {
				executionId: input.executionId,
				status: "CANCELLED",
				artifacts: [],
				duration: Date.now() - startTime,
			};
		}

		// 2. Fetch instance with template
		const instance = await fetchTemplateInstanceWithTemplate({
			instanceId: input.instanceId,
			userId: input.userId,
			organizationId: input.organizationId,
		});

		if (!instance) {
			throw new Error("Template instance not found or access denied");
		}

		const template = instance.template;

		// Fetch skills attached to the template
		const templateSkills = await fetchReportTemplateSkills({
			templateId: template.id,
		});
		const skillsContent = buildSkillsPromptSection(templateSkills);

		const definition = template.definition as {
			dataSources?: Array<{
				type: string;
				id: string;
				config?: Record<string, unknown>;
			}>;
			aiAgents?: Array<{
				agentId: string;
				task: string;
				outputVariable?: string;
			}>;
			sections?: Array<{
				id: string;
				title: string;
				type: string;
				config?: Record<string, unknown>;
			}>;
			/** User prompt for AI analysis (used as default task when no aiAgents defined) */
			userPrompt?: string;
		};

		// Merge parameters: instance defaults + runtime overrides
		const mergedParameters = {
			...((instance.parameterDefaults as Record<string, unknown>) || {}),
			...input.parameters,
		};

		// 3. Apply Fabric AI enrichment
		// Merge fabricConfig: template config + instance overrides
		const templateFabricConfig = template.fabricConfig as {
			strategy?: string;
			context?: string;
			pattern?: string;
			variables?: Record<string, string>;
			enableAutoDetection?: boolean;
			// Default system prompt for the template (required for LLM)
			defaultSystemPrompt?: string;
		} | null;

		const instanceFabricConfig = instance.fabricConfig as {
			strategy?: string;
			context?: string;
			pattern?: string;
			variables?: Record<string, string>;
			// Custom system prompt override (replaces template default)
			customSystemPrompt?: string;
		} | null;

		const fabricConfig = {
			...templateFabricConfig,
			...instanceFabricConfig,
		};

		// Check Fabric AI availability first (gracefully handle server being down)
		let fabricHealth: {
			healthy: boolean;
			mode?: string;
			delegatedSupported?: boolean;
			error?: string;
		} = {
			healthy: false,
		};
		try {
			fabricHealth = await checkFabricHealth();
		} catch {
			// Fabric AI server not available - continue without enrichment
		}

		let enrichmentResult: {
			composedPrompt: string;
			components: {
				strategy: string | null;
				context: string | null;
				pattern: string | null;
			};
			fabricAvailable: boolean;
		} = {
			composedPrompt: "",
			components: { strategy: null, context: null, pattern: null },
			fabricAvailable: false,
		};

		if (fabricHealth.healthy) {
			// Build task description for auto-detection
			const taskDescription = `${template.name}: ${template.description || instance.name}`;

			enrichmentResult = await applyFabricPatternEnrichment({
				message: taskDescription,
				userId: input.userId,
				organizationId: input.organizationId,
				strategy: fabricConfig.strategy,
				context: fabricConfig.context,
				pattern: fabricConfig.pattern,
				variables: fabricConfig.variables,
				enableAutoDetection: fabricConfig.enableAutoDetection ?? true,
			});
		}

		// 4. Fetch data from configured data sources using handler-based architecture
		// Each data source explicitly specifies its type (mcp, integration, etc.)
		// The handler system routes to the appropriate fetcher
		const instanceConnections = instance.connections as {
			mcpConfigs?: string[];
			mcpBindings?: Record<string, string>;
			integrations?: string[];
			integrationBindings?: Record<string, string>;
			resourceBindings?: Record<
				string,
				{
					resourceId: string;
					resourceName: string;
					resourceType: string;
				}
			>;
			workspaces?: string[];
			workspaceBindings?: Record<string, string>;
			parameterBindings?: Record<string, Record<string, string>>;
			// Agentic data gathering fields
			context?: Record<string, string>;
			promptOverride?: string;
			maxIterations?: number;
		} | null;

		// Determine if RAG should be enabled based on template config or data source settings
		// Cast to extended type that may have processing config
		type DataSourceWithProcessing = {
			processing?: { embedForRag?: boolean };
			useAgentic?: boolean;
			[key: string]: unknown;
		};
		const enableRag =
			(
				definition.dataSources as DataSourceWithProcessing[] | undefined
			)?.some((ds) => ds.processing?.embedForRag === true) ?? false;

		// ── Self-healing connection resolution (root-cause fix) ──────────────────
		// Resolve each MCP data source to a config the running user can actually
		// use — preferring the stored binding id, else falling back to their own
		// config for that server. Fixes dangling bindings (deleted / reconnected /
		// teammate / wrong-context config id) that otherwise hard-fail the run with
		// CONFIG_NOT_FOUND. Gated behind patched() so in-flight executions keep
		// their recorded behaviour (replay-safe).
		let effectiveConnections = instanceConnections;
		if (
			instanceConnections &&
			patched("reports-resilient-mcp-resolution-v1")
		) {
			const resolvedConnections = await resolveReportConnections({
				connections: {
					mcpConfigs: instanceConnections.mcpConfigs,
					mcpBindings: instanceConnections.mcpBindings,
				},
				dataSources: (definition.dataSources ?? []) as Array<{
					id?: string;
					key?: string;
					provider?: string;
					type?: string;
					config?: { mcpServerKey?: string };
				}>,
				userId: input.userId,
				organizationId: input.organizationId,
			});
			effectiveConnections = {
				...instanceConnections,
				mcpConfigs: resolvedConnections.mcpConfigs,
				mcpBindings: resolvedConnections.mcpBindings,
			};
			if (resolvedConnections.healed.length > 0) {
				console.log(
					`[Workflow] Self-healed ${resolvedConnections.healed.length} report data-source binding(s) to the user's current connection(s)`,
				);
			}
			if (resolvedConnections.unresolved.length > 0) {
				console.warn(
					`[Workflow] ${resolvedConnections.unresolved.length} report data source(s) have no resolvable connection: ${resolvedConnections.unresolved.join(", ")}`,
				);
			}
		}

		// Check if agentic data gathering should be used
		// Use agentic approach when:
		// 1. Instance has context values provided (project, team, etc.)
		// 2. OR any data source is configured with useAgentic: true
		const hasAgenticContext =
			instanceConnections?.context &&
			Object.keys(instanceConnections.context).length > 0;
		const hasAgenticDataSource = (
			definition.dataSources as DataSourceWithProcessing[] | undefined
		)?.some((ds) => ds.useAgentic === true);
		const useAgenticApproach = hasAgenticContext || hasAgenticDataSource;

		let dataFetchResult: {
			results: Array<{
				sourceId: string;
				sourceType: string;
				provider: string;
				data: unknown;
				recordCount: number;
				error?: string;
			}>;
			qdrantCollectionId?: string;
			fetchStates: Record<string, unknown>;
			totalRecords: number;
		} = {
			results: [],
			fetchStates: {},
			totalRecords: 0,
		};

		// Track agentic loop results for reporting
		let agentLoopMetadata: {
			toolCallCount?: number;
			isPartial?: boolean;
			toolsUsed?: string[];
		} = {};

		if (useAgenticApproach && effectiveConnections?.mcpConfigs?.length) {
			// Use agentic data gathering loop
			// The AI will decide which tools to call based on context
			console.log("[Workflow] Using agentic data gathering approach");

			// Build task description from template sections
			const sectionTitles =
				definition.sections?.map((s) => s.title).join(", ") ||
				"data analysis";
			const taskDescription = `Generate a report for "${template.name}" covering: ${sectionTitles}. ${template.description || ""}`;

			// Extract providers from data sources
			const providers = [
				...new Set(
					(definition.dataSources || []).map(
						(ds) =>
							(ds as { provider?: string }).provider ||
							(ds.config?.mcpServerKey as string) ||
							"unknown",
					),
				),
			].filter((p) => p !== "unknown");

			const agentLoopResult = await executeAgentDataGatheringLoop({
				taskDescription,
				promptOverride: effectiveConnections.promptOverride,
				context: effectiveConnections.context || {},
				mcpConfigIds: effectiveConnections.mcpConfigs,
				providers,
				maxIterations: effectiveConnections.maxIterations || 15,
				enrichedSystemPrompt:
					enrichmentResult.composedPrompt || undefined,
				// Custom system prompt: instance override > template default
				customSystemPrompt:
					instanceFabricConfig?.customSystemPrompt ||
					templateFabricConfig?.defaultSystemPrompt,
				skillsContent: skillsContent || undefined,
				userId: input.userId,
				organizationId: input.organizationId,
				jobType: input.jobType,
				executionId: input.executionId,
			});

			// Store metadata for reporting
			agentLoopMetadata = {
				toolCallCount: agentLoopResult.toolCallCount,
				isPartial: agentLoopResult.isPartial,
				toolsUsed: agentLoopResult.toolsUsed,
			};
			mcpDiagnostics = agentLoopResult.mcpDiagnostics ?? [];

			// Convert gathered data to the expected format
			if (agentLoopResult.error) {
				console.warn(
					"[Workflow] Agentic data gathering error:",
					agentLoopResult.error,
				);
			}

			// Build a mapping from tool names to template data source IDs
			// so table sections can find data by their configured dataSourceId
			const toolToSourceId: Record<string, string> = {};
			if (definition.dataSources?.length) {
				for (const ds of definition.dataSources) {
					const toolName = (ds.config?.toolName as string) || "";
					if (toolName && ds.id) {
						toolToSourceId[toolName] = ds.id;
					}
				}
			}

			// Map gathered data → data-source results + usable-record total via
			// the tested pure helper (Codex findings 3 & 4). recordCount uses
			// countAgenticRecords so wrapper-empty payloads score zero.
			const agentic = mapAgenticGatheredData(
				agentLoopResult.gatheredData,
				{
					toolToSourceId,
					provider: providers[0] || "unknown",
				},
			);
			dataFetchResult.results.push(...agentic.results);
			dataFetchResult.totalRecords += agentic.totalRecords;

			// Fail only when the run is incomplete AND no usable records were
			// gathered (empty arrays/objects count as zero — Codex finding 4).
			// A partial run WITH records proceeds to render with a notice.
			if (
				hasNoUsableData(
					!!agentLoopResult.isPartial,
					dataFetchResult.totalRecords,
				)
			) {
				throw new Error(
					agentLoopResult.error ||
						"Agentic data gathering incomplete: no usable data was gathered",
				);
			}
		} else if (definition.dataSources?.length) {
			// Use traditional data fetching
			// Cast data sources to the expected format
			// The type field will be normalized by the handler if missing (legacy support)
			const normalizedDataSources = definition.dataSources.map((ds) => ({
				id: ds.id,
				type: (ds as { type?: string }).type || "mcp", // Default to mcp for legacy templates
				provider:
					(ds as { provider?: string }).provider ||
					(ds.config?.mcpServerKey as string) ||
					"unknown",
				operation:
					(ds as { operation?: string }).operation ||
					(ds.config?.toolName as string) ||
					"unknown",
				config: ds.config || {},
				processing: (ds as { processing?: Record<string, unknown> })
					.processing,
			}));

			dataFetchResult = await fetchDataSources({
				dataSources: normalizedDataSources,
				connections: {
					mcpBindings: effectiveConnections?.mcpBindings,
					integrationBindings:
						effectiveConnections?.integrationBindings,
					resourceBindings: effectiveConnections?.resourceBindings,
					workspaceBindings: effectiveConnections?.workspaceBindings,
					parameterBindings: effectiveConnections?.parameterBindings,
					mcpConfigs: effectiveConnections?.mcpConfigs,
					integrations: instanceConnections?.integrations,
					workspaces: instanceConnections?.workspaces,
				},
				userId: input.userId,
				organizationId: input.organizationId,
				executionId: input.executionId,
				parameters: mergedParameters,
				dateRange: input.dateRange,
				enableRag,
			});

			// Check if ALL data sources failed - if so, fail the execution
			const successfulSources = dataFetchResult.results.filter(
				(r) => !r.error && r.recordCount > 0,
			);
			const failedSources = dataFetchResult.results.filter(
				(r) => r.error,
			);

			// Surface connection diagnostics for the traditional fetch path too,
			// so a failed MCP/integration source populates the diagnostics panel
			// (previously only the agentic path produced diagnostics, leaving
			// non-agentic reports with an empty panel on connection failures).
			for (const r of failedSources) {
				mcpDiagnostics.push({
					configId: r.sourceId,
					serverName: r.provider || r.sourceId,
					provider: r.provider,
					outcome: classifyConnectionError(new Error(r.error || "")),
					toolCount: 0,
					readOnlyToolCount: 0,
					errorMessage: redactMessage(r.error || ""),
				});
			}

			if (
				successfulSources.length === 0 &&
				failedSources.length === normalizedDataSources.length
			) {
				const errorMessages = failedSources
					.map((r) => `${r.sourceId}: ${r.error}`)
					.join("; ");
				throw new Error(
					`All data sources failed to fetch data: ${errorMessages}`,
				);
			}
		}

		// Convert to legacy format for backward compatibility with rendering
		const dataResults = dataFetchResult.results.map((r) => ({
			sourceId: r.sourceId,
			sourceType: r.sourceType,
			data: r.data,
			error: r.error,
		}));

		// 5. Execute AI analysis with enriched prompts and RAG context
		let aiResults: Array<{
			agentId: string;
			task: string;
			output: string;
			outputVariable?: string;
			error?: string;
		}> = [];

		// Determine which AI agents to use
		// If using agentic approach with no defined agents, create a default agent
		// to process the gathered data using userPrompt or a default task
		let effectiveAiAgents = definition.aiAgents || [];

		if (
			useAgenticApproach &&
			effectiveAiAgents.length === 0 &&
			dataFetchResult.totalRecords > 0
		) {
			// Create default agent to analyze gathered data
			// Priority: instance promptOverride > template userPrompt > default
			const defaultTask =
				instanceConnections?.promptOverride ||
				definition.userPrompt ||
				`Analyze the gathered data and generate a comprehensive report for "${template.name}". Include key findings, metrics, and actionable insights.`;

			effectiveAiAgents = [
				{
					agentId: "default",
					task: defaultTask,
					outputVariable: "analysis",
				},
			];
		}

		// Resolve output format early — used by both AI analysis and rendering
		const outputFormat =
			typeof template.outputFormat === "string"
				? template.outputFormat
				: "MARKDOWN";

		if (effectiveAiAgents.length > 0) {
			// Use custom system prompt: instance override > template default > Fabric-enriched prompt
			const systemPrompt =
				instanceFabricConfig?.customSystemPrompt ||
				templateFabricConfig?.defaultSystemPrompt ||
				enrichmentResult.composedPrompt;

			aiResults = await executeAiAnalysis({
				aiAgents: effectiveAiAgents,
				dataResults: dataFetchResult.results,
				qdrantCollectionId: dataFetchResult.qdrantCollectionId,
				enrichedSystemPrompt: systemPrompt,
				skillsContent: skillsContent || undefined,
				userId: input.userId,
				organizationId: input.organizationId,
				jobType: input.jobType,
				parameters: mergedParameters,
				sections: definition.sections,
				outputFormat,
			});
		}

		// 6. Render report content
		const renderedReport = await renderInstanceReport({
			instance,
			template,
			dataResults,
			aiResults,
			parameters: mergedParameters,
			dateRange: input.dateRange,
			outputFormat,
			isPartial: !!agentLoopMetadata.isPartial,
		});

		if (outputFormat === "MARKDOWN" || outputFormat === "MULTI_FORMAT") {
			const artifact = await storeInstanceArtifact({
				executionId: input.executionId,
				userId: input.userId,
				organizationId: input.organizationId,
				name: `${instance.name}.md`,
				description: `Generated from ${template.name}`,
				artifactType: "MARKDOWN",
				content: renderedReport.markdown,
				mimeType: "text/markdown",
				metadata: {
					templateType: template.templateType,
					dateRange: input.dateRange,
					fabricEnrichment: enrichmentResult.components,
				},
			});

			artifacts.push({
				id: artifact.id,
				name: `${instance.name}.md`,
				artifactType: "MARKDOWN",
				mimeType: "text/markdown",
				size: new TextEncoder().encode(renderedReport.markdown).length,
			});

			// Index for RAG
			// TENANT ISOLATION: Pass userId and organizationId for proper tenant filtering
			await indexInstanceArtifactForRag({
				artifactId: artifact.id,
				content: renderedReport.markdown,
				userId: input.userId,
				organizationId: input.organizationId,
			});
		}

		if (outputFormat === "HTML" || outputFormat === "MULTI_FORMAT") {
			// Enforce a fixed, self-contained LIGHT theme on the stored HTML so the
			// report renders readably regardless of OS appearance or Fabric's theme.
			// Normalize BEFORE storing so both the in-app preview and the verbatim
			// download serve the guaranteed-light content (deterministic guarantee).
			const htmlContent = normalizeReportHtmlToLight(
				wrapInHtml(instance.name, renderedReport.markdown),
			);
			const artifact = await storeInstanceArtifact({
				executionId: input.executionId,
				userId: input.userId,
				organizationId: input.organizationId,
				name: `${instance.name}.html`,
				description: `Generated from ${template.name}`,
				artifactType: "HTML",
				content: htmlContent,
				mimeType: "text/html",
				metadata: {
					templateType: template.templateType,
					dateRange: input.dateRange,
				},
			});

			artifacts.push({
				id: artifact.id,
				name: `${instance.name}.html`,
				artifactType: "HTML",
				mimeType: "text/html",
				size: new TextEncoder().encode(htmlContent).length,
			});
		}

		// 8. Generate Evidence dashboard if output format is EVIDENCE_EMBED
		if (
			outputFormat === "EVIDENCE_EMBED" ||
			outputFormat === "MULTI_FORMAT"
		) {
			// Cast template to access Evidence-specific fields
			const templateWithEvidence = template as typeof template & {
				evidenceProjectId?: string | null;
				evidenceReportSlug?: string | null;
			};

			const evidenceResult = await generateEvidenceReport({
				executionId: input.executionId,
				template: {
					id: template.id,
					name: template.name,
					description: template.description,
					templateType: template.templateType,
					definition: template.definition,
					outputFormat: template.outputFormat,
					fabricConfig: template.fabricConfig,
					evidenceProjectId: templateWithEvidence.evidenceProjectId,
					evidenceReportSlug: templateWithEvidence.evidenceReportSlug,
				},
				dataResults: dataResults.map((r) => ({
					sourceId: r.sourceId,
					sourceType: r.sourceType,
					data: r.data,
					error: r.error,
				})),
				aiResults: aiResults.map((r) => ({
					agentId: r.agentId,
					task: r.task,
					output: r.output,
					outputVariable: r.outputVariable,
					error: r.error,
				})),
				parameters: mergedParameters,
				dateRange: input.dateRange,
			});

			if (evidenceResult.success && evidenceResult.htmlContent) {
				const artifact = await storeInstanceArtifact({
					executionId: input.executionId,
					userId: input.userId,
					organizationId: input.organizationId,
					name: `${instance.name}-dashboard.html`,
					description: `Interactive Evidence dashboard from ${template.name}`,
					artifactType: "HTML", // Use HTML type since it's valid HTML
					content: evidenceResult.htmlContent,
					mimeType: "text/html",
					metadata: {
						templateType: template.templateType,
						dateRange: input.dateRange,
						evidenceGenerated: true,
						evidenceBuildDuration: evidenceResult.buildDuration,
						evidenceWarnings: evidenceResult.warnings,
					},
				});

				artifacts.push({
					id: artifact.id,
					name: `${instance.name}-dashboard.html`,
					artifactType: "EVIDENCE_EMBED",
					mimeType: "text/html",
					size: new TextEncoder().encode(evidenceResult.htmlContent)
						.length,
				});

				// Index Evidence report for RAG (strip HTML for better indexing)
				const textContent = evidenceResult.htmlContent
					.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
					.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
					.replace(/<[^>]+>/g, " ")
					.replace(/\s+/g, " ")
					.trim();

				// TENANT ISOLATION: Pass userId and organizationId for proper tenant filtering
				await indexInstanceArtifactForRag({
					artifactId: artifact.id,
					content: textContent,
					userId: input.userId,
					organizationId: input.organizationId,
				});
			}
		}

		// 9. Cleanup RAG collection (ephemeral, not needed after report generation)
		if (dataFetchResult.qdrantCollectionId) {
			try {
				await cleanupRagCollection(dataFetchResult.qdrantCollectionId);
			} catch {
				// Non-critical - collection will be cleaned up by scheduled job
			}
		}

		// 10. Update execution status and instance stats
		const duration = Date.now() - startTime;

		await updateInstanceExecutionStatus({
			executionId: input.executionId,
			status: "COMPLETED",
			completedAt: new Date(),
			duration,
			fabricEnrichment: enrichmentResult.components,
			dataSources: dataFetchResult.results.map((r) => ({
				sourceId: r.sourceId,
				sourceType: r.sourceType,
				provider: r.provider,
				recordCount: r.recordCount,
				hasError: !!r.error,
				// Include agentic metadata if this was an agentic source
				...(r.sourceType === "agentic" &&
				agentLoopMetadata.toolCallCount
					? {
							agentic: {
								toolCallCount: agentLoopMetadata.toolCallCount,
								isPartial: agentLoopMetadata.isPartial,
								toolsUsed: agentLoopMetadata.toolsUsed,
							},
						}
					: {}),
			})),
			mcpDiagnostics: mcpDiagnostics.length
				? (mcpDiagnostics as unknown as Prisma.InputJsonValue)
				: undefined,
		});

		// Notify the triggering user the run succeeded. patched()
		// keeps recorded histories replay-deterministic; the try/catch guarantees a
		// notification failure never turns a successful run into a failed one.
		if (patched("report-execution-notifications-2026-06-22")) {
			try {
				await emitReportExecutionNotification({
					executionId: input.executionId,
					status: "COMPLETED",
				});
			} catch (notifyError) {
				console.error(
					"[Workflow] report completion notification failed:",
					notifyError instanceof Error
						? notifyError.message
						: notifyError,
				);
			}
		}

		// Email the run owner the run succeeded. A
		// SEPARATE patched() gate placed AFTER the in-app block — reusing the
		// 2026-06-22 id would break replay for in-flight executions. The
		// try/catch keeps a send failure from corrupting the run status.
		if (patched("report-execution-emails-2026-06-23")) {
			try {
				await sendReportExecutionEmail({
					executionId: input.executionId,
					status: "COMPLETED",
				});
			} catch (emailError) {
				console.error(
					"[Workflow] report completion email failed:",
					emailError instanceof Error
						? emailError.message
						: emailError,
				);
			}
		}

		return {
			executionId: input.executionId,
			status: "COMPLETED",
			artifacts,
			fabricEnrichment: {
				...enrichmentResult.components,
				fabricAvailable: enrichmentResult.fabricAvailable,
			},
			duration,
		};
	} catch (error) {
		const duration = Date.now() - startTime;
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";

		// Update DB status for UI — wrapped in try/catch to prevent
		// a secondary failure from causing infinite workflow task retries
		try {
			await updateInstanceExecutionStatus({
				executionId: input.executionId,
				instanceId: input.instanceId,
				status: "FAILED",
				completedAt: new Date(),
				duration,
				error: errorMessage,
				mcpDiagnostics: mcpDiagnostics.length
					? (mcpDiagnostics as unknown as Prisma.InputJsonValue)
					: undefined,
			});
		} catch (statusError) {
			console.error(
				"[Workflow] Failed to update execution status:",
				statusError instanceof Error
					? statusError.message
					: statusError,
			);
		}

		// Notify the triggering user the run failed. Same patched()
		// gate + wrapper; the original error below is still the one thrown.
		if (patched("report-execution-notifications-2026-06-22")) {
			try {
				await emitReportExecutionNotification({
					executionId: input.executionId,
					status: "FAILED",
				});
			} catch (notifyError) {
				console.error(
					"[Workflow] report failure notification failed:",
					notifyError instanceof Error
						? notifyError.message
						: notifyError,
				);
			}
		}

		// Email the run owner the run failed. A
		// SEPARATE patched() gate placed AFTER the in-app block — reusing the
		// 2026-06-22 id would break replay for in-flight executions. The
		// try/catch keeps a send failure from masking the original error below.
		if (patched("report-execution-emails-2026-06-23")) {
			try {
				await sendReportExecutionEmail({
					executionId: input.executionId,
					status: "FAILED",
				});
			} catch (emailError) {
				console.error(
					"[Workflow] report failure email failed:",
					emailError instanceof Error
						? emailError.message
						: emailError,
				);
			}
		}

		// Throw ApplicationFailure so Temporal properly marks this workflow as Failed
		// nonRetryable: true because the DB is already updated and retrying would
		// create duplicate executions or stale state
		throw ApplicationFailure.create({
			message: errorMessage,
			nonRetryable: true,
			details: [
				{
					executionId: input.executionId,
					status: "FAILED",
					artifacts,
					error: errorMessage,
					duration,
				},
			],
		});
	}
}

// =============================================================================
// Helpers
// =============================================================================

function buildSkillsPromptSection(
	skills: Array<{ name: string; content: string }>,
): string {
	if (skills.length === 0) {
		return "";
	}
	let section =
		"\n\n## Loaded Skills\nYou have the following skills loaded. When the user's request matches a skill's purpose, you MUST follow that skill's instructions exactly, including its output format (e.g., generating HTML pages, diagrams, etc.).\n";
	for (const skill of skills) {
		section += `\n### Skill: ${skill.name}\n${skill.content}\n`;
	}
	return section;
}

/**
 * Normalize an LLM-generated report HTML document to a fixed, self-contained
 * LIGHT theme, independent of the OS `prefers-color-scheme` and Fabric's app theme.
 *
 * The board report (`task-board-visual-report`) is a self-contained HTML document
 * rendered inside an isolated `<iframe srcDoc … sandbox>` (and downloaded verbatim),
 * so it cannot inherit Fabric's `class="dark"`. When its CSS keys off
 * `@media (prefers-color-scheme: dark)` it renders dark on a dark-OS machine even
 * while Fabric is in light mode. The seed prompt now asks for a light-only theme,
 * but the HTML is LLM-generated — this is the deterministic guarantee that strips
 * any residual dark trigger before the artifact is stored (covers preview + download).
 *
 * Behavior (pure, deterministic — see why-note below):
 *  1. Removes every `@media (prefers-color-scheme: dark) { … }` block using
 *     balanced-brace matching, so nested rules inside the block are dropped and the
 *     surrounding light CSS is left untouched (no greedy regex, no stray `}`).
 *  2. Ensures a `color-scheme: light` signal is present so a dark-OS browser does not
 *     auto-apply dark UA styling to native form controls/scrollbars. If neither a
 *     `<meta name="color-scheme" … light …>` nor a `color-scheme: light` CSS
 *     declaration is present, injects `<meta name="color-scheme" content="light">`
 *     once into `<head>`. If there is no `<head>` (e.g. a non-document fragment),
 *     it is a safe no-op — the simplest robust choice for input that isn't a full
 *     HTML document (such as `wrapInHtml`-wrapped markdown, which has no dark block).
 *  3. Idempotent: running twice produces the same result as running once; already
 *     light-only input is returned unchanged where possible.
 *
 * why: this runs inside Temporal workflow code, so it MUST stay pure and
 * replay-safe — no Date, Math.random, IO, env reads, or other non-determinism.
 * (Replay validation runs in CI for `packages/temporal/src/workflows/**`.)
 */
export function normalizeReportHtmlToLight(html: string): string {
	if (!html) {
		return html;
	}

	let result = stripPrefersColorSchemeDarkBlocks(html);
	result = ensureColorSchemeLight(result);
	return result;
}

/**
 * Remove all `@media (prefers-color-scheme: dark) { … }` blocks via balanced-brace
 * matching. Whitespace inside the media query (e.g. `@media  ( prefers-color-scheme : dark )`)
 * is tolerated. Pure string scan — no regex backtracking on the block body.
 */
function stripPrefersColorSchemeDarkBlocks(html: string): string {
	// Matches the at-rule prelude up to (but not including) the opening brace.
	// Tolerant of arbitrary internal whitespace; case-insensitive.
	const darkAtRule =
		/@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)\s*\{/gi;

	let output = "";
	let cursor = 0;
	darkAtRule.lastIndex = 0;

	let match = darkAtRule.exec(html);
	while (match !== null) {
		const blockStart = match.index;
		// Index of the `{` that opened the at-rule body (last char of the match).
		const openBraceIndex = match.index + match[0].length - 1;

		// Walk forward from the opening brace, tracking depth, to find the matching
		// close brace so nested rules inside the block are fully consumed.
		let depth = 0;
		let i = openBraceIndex;
		for (; i < html.length; i++) {
			const ch = html[i];
			if (ch === "{") {
				depth++;
			} else if (ch === "}") {
				depth--;
				if (depth === 0) {
					break;
				}
			}
		}

		// Emit everything before the block; skip the block itself.
		output += html.slice(cursor, blockStart);

		if (depth === 0 && i < html.length) {
			// i points at the matching close brace; resume after it.
			cursor = i + 1;
			// Also swallow a single trailing newline left behind by the block,
			// so removal does not leave a dangling blank line in the CSS.
			if (html[cursor] === "\n") {
				cursor += 1;
			} else if (html[cursor] === "\r" && html[cursor + 1] === "\n") {
				cursor += 2;
			}
		} else {
			// Unbalanced braces (malformed input) — drop to end of string rather
			// than risk emitting a half-open dark block. Resume at end.
			cursor = html.length;
		}

		darkAtRule.lastIndex = cursor;
		match = darkAtRule.exec(html);
	}

	output += html.slice(cursor);
	return output;
}

/**
 * Ensure a `color-scheme: light` signal exists. If a `<meta name="color-scheme">`
 * containing `light` or a `color-scheme: light` CSS declaration is already present,
 * the input is returned unchanged (idempotent). Otherwise a single
 * `<meta name="color-scheme" content="light">` is injected immediately after the
 * opening `<head>` tag. If there is no `<head>`, the input is returned unchanged.
 */
function ensureColorSchemeLight(html: string): string {
	const hasColorSchemeMeta =
		/<meta\b[^>]*name\s*=\s*["']color-scheme["'][^>]*content\s*=\s*["'][^"']*\blight\b[^"']*["'][^>]*>/i.test(
			html,
		);
	const hasColorSchemeCss = /color-scheme\s*:\s*[^;}"']*\blight\b/i.test(
		html,
	);

	if (hasColorSchemeMeta || hasColorSchemeCss) {
		return html;
	}

	const headOpen = /<head\b[^>]*>/i.exec(html);
	if (!headOpen) {
		// No <head> to inject into — safe no-op (e.g. a non-document fragment).
		return html;
	}

	const insertAt = headOpen.index + headOpen[0].length;
	const meta = '\n  <meta name="color-scheme" content="light">';
	return html.slice(0, insertAt) + meta + html.slice(insertAt);
}

function wrapInHtml(title: string, htmlContent: string): string {
	return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 900px; margin: 0 auto; padding: 2rem; line-height: 1.6; color: #1a1a1a; background: #fff; }
    h1 { color: #111; font-size: 1.8em; border-bottom: 2px solid #e5e7eb; padding-bottom: 0.5em; }
    h2 { color: #1a1a1a; font-size: 1.4em; margin-top: 2em; border-bottom: 1px solid #e5e7eb; padding-bottom: 0.3em; }
    h3 { color: #374151; font-size: 1.15em; margin-top: 1.5em; }
    p { margin: 0.75em 0; }
    table, .data-table { border-collapse: collapse; width: 100%; margin: 1em 0; font-size: 0.95em; }
    th, td { border: 1px solid #d1d5db; padding: 10px 12px; text-align: left; }
    th { background-color: #f3f4f6; font-weight: 600; color: #374151; }
    tr:nth-child(even) { background-color: #f9fafb; }
    tr:hover { background-color: #f3f4f6; }
    pre { background: #f3f4f6; padding: 1em; overflow-x: auto; border-radius: 6px; border: 1px solid #e5e7eb; }
    code { background: #f3f4f6; padding: 0.2em 0.4em; border-radius: 3px; font-size: 0.9em; }
    pre code { background: none; padding: 0; }
    blockquote { border-left: 4px solid #6366f1; margin: 1em 0; padding: 0.5em 1em; background: #f5f3ff; color: #4338ca; border-radius: 0 6px 6px 0; }
    hr { border: none; border-top: 1px solid #e5e7eb; margin: 2em 0; }
    ul, ol { padding-left: 1.5em; }
    li { margin: 0.3em 0; }
    strong { color: #111; }
    em { color: #6b7280; }
    section { margin: 1.5em 0; }
    .report-meta { color: #6b7280; font-size: 0.9em; }
    .summary-box { background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px; padding: 1em 1.5em; margin: 1em 0; }
    .metric-card { display: inline-block; background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 1em 1.5em; margin: 0.5em; min-width: 150px; text-align: center; }
    .metric-card .value { font-size: 1.8em; font-weight: 700; color: #111; }
    .metric-card .label { font-size: 0.85em; color: #6b7280; margin-top: 0.25em; }
    .highlight { background: #fefce8; border-left: 4px solid #eab308; padding: 0.75em 1em; margin: 1em 0; border-radius: 0 6px 6px 0; }
    .warning { color: #b45309; background: #fffbeb; border: 1px solid #fde68a; padding: 0.75em 1em; border-radius: 6px; margin: 1em 0; }
  </style>
</head>
<body>
${htmlContent}
</body>
</html>`;
}
