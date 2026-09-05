/**
 * Unified Server for Data Analyst Agent
 *
 * Exposes the data analyst agent via:
 * - A2A protocol (for orchestrator integration)
 * - AG-UI protocol (for CopilotKit frontend)
 * - LangGraph Platform API (for CopilotKit LangGraphAgent)
 *
 * Replaces Composio with Fabric's MCP system for tool access.
 * Uses token exchange for AI provider configuration.
 */

import { v4 as uuidv4 } from "uuid";
import {
	HumanMessage,
	AIMessage,
	SystemMessage,
	ToolMessage,
	type BaseMessage,
} from "@langchain/core/messages";
import {
	createUnifiedServer,
	type AgentSkill,
	type Artifact,
	type LangGraphStreamEvent,
	type AgentRuntimeConfig,
} from "@repo/agent-core";
import {
	createDataAnalystGraph,
	getGeneratedArtifacts,
	getConnectionSuggestionArtifacts,
	clearArtifacts,
	DEFAULT_RECURSION_LIMIT,
} from "./lib/agent/graph.js";
import { type ChartArtifact } from "@repo/agent-tools";
import { type ConnectionSuggestionArtifact } from "./lib/agent/analytics-tools.js";

// Configuration
const PORT = Number.parseInt(process.env.PORT || "8130", 10);
const HOST = process.env.HOST || "0.0.0.0";
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// System prompt for data analysis
const SYSTEM_PROMPT = `You are an advanced data analysis agent with comprehensive analytics capabilities. Your job is to help users analyze data, generate insights, and create visualizations.

## AVAILABLE TOOLS

### Data Source Tools
- **list_data_sources**: Check what data sources the user has connected
- **suggest_connection**: Suggest connecting an integration if needed for the analysis

### Analytics Tools
- **calculate_statistics**: Compute statistical measures (mean, median, std, percentiles)
- **aggregate_data**: Group and aggregate data (like SQL GROUP BY or pandas groupby)
- **detect_trends**: Analyze time-series data for trends, moving averages, peaks/troughs
- **join_datasets**: Join data from multiple sources on a common key

### Visualization Tools
- **create_chart**: Create interactive charts (line, bar, pie, area, scatter)

### MCP Data Tools
You also have access to the user's configured MCP integrations for fetching data from:
- CRM systems (HubSpot, Attio, Salesforce)
- Spreadsheets (Google Sheets, Airtable)
- Project tools (Jira, Linear, GitHub)
- And more based on user's connections

## WORKFLOW

1. **Check Available Sources**: Start by using list_data_sources to see what the user has connected
2. **Suggest Connections**: If the user asks about data from a source they haven't connected, use suggest_connection
3. **Fetch Data**: Use MCP tools to get the raw data
4. **Analyze**: Use analytics tools for statistics, aggregation, trends, or joins
5. **Visualize**: Create charts with create_chart to present findings

## IMPORTANT BEHAVIORS

- **Proactive Connection Suggestions**: If a user asks about "HubSpot data" but HubSpot isn't connected, suggest connecting it
- **Multi-Source Analysis**: You can combine data from different sources using join_datasets
- **Statistical Rigor**: Use calculate_statistics for proper statistical analysis, not mental math
- **Clear Results**: After analysis, explain insights in plain language
- **Visual First**: Create charts when data can be better understood visually

## EXAMPLE INTERACTIONS

User: "Analyze my sales pipeline"
1. list_data_sources → Check if CRM is connected
2. If not connected → suggest_connection("hubspot", "analyze sales pipeline")
3. If connected → Fetch deals data → calculate_statistics on deal values → create_chart

User: "Compare revenue by region from my CRM and spreadsheet"
1. Fetch CRM data → Fetch spreadsheet data
2. join_datasets on common key (e.g., region)
3. aggregate_data by region, sum revenue
4. create_chart (bar chart) showing comparison

User: "What are the trends in my ticket volume?"
1. Fetch ticket data from Linear/Jira
2. detect_trends to analyze weekly/monthly patterns
3. create_chart (line chart) with moving average

EXECUTION:
- Be autonomous and proactive
- Don't ask unnecessary clarification questions
- Execute multi-step analysis workflows end-to-end
- Always provide actionable insights, not just raw numbers`;

/**
 * Normalize messages from various formats to LangChain BaseMessage format
 */
function normalizeMessages(
	messages: Array<Record<string, unknown>>,
): BaseMessage[] {
	return messages
		.map((msg) => {
			const content =
				typeof msg.content === "string"
					? msg.content
					: String(msg.content || "");

			const msgType =
				(msg.type as string) || (msg.role as string) || "user";
			const toolCallId =
				(msg.tool_call_id as string) || (msg.toolCallId as string);

			switch (msgType.toLowerCase()) {
				case "human":
				case "user":
					return new HumanMessage({ content });

				case "ai":
				case "assistant": {
					const toolCalls = (msg.tool_calls || msg.toolCalls) as
						| Array<Record<string, unknown>>
						| undefined;

					if (toolCalls && toolCalls.length > 0) {
						return new AIMessage({
							content,
							tool_calls: toolCalls.map((tc) => ({
								id: (tc.id as string) || "",
								name:
									(tc.name as string) ||
									((tc.function as Record<string, unknown>)
										?.name as string) ||
									"",
								args: parseToolCallArgs(tc),
								type: "tool_call" as const,
							})),
						});
					}
					return new AIMessage({ content });
				}

				case "system":
					return new SystemMessage({ content });

				case "tool":
					return new ToolMessage({
						content,
						tool_call_id: toolCallId || "unknown",
					});

				default:
					return new HumanMessage({ content });
			}
		})
		.filter((msg): msg is NonNullable<typeof msg> => msg !== null);
}

/**
 * Convert LangChain BaseMessage[] back to the plain {role, content} shape
 * the LangGraphExecutor contract (and A2A/CopilotKit consumers) expect.
 */
function serializeMessages(
	messages: BaseMessage[],
): Array<{ role: string; content: string }> {
	return messages.map((msg) => {
		const role =
			msg.type === "human"
				? "user"
				: msg.type === "ai"
					? "assistant"
					: msg.type;
		return { role, content: msg.text };
	});
}

/**
 * Parse tool call arguments from various formats
 */
function parseToolCallArgs(
	tc: Record<string, unknown>,
): Record<string, unknown> {
	let args = tc.args;
	if (!args && tc.function) {
		args = (tc.function as Record<string, unknown>)?.arguments;
	}
	if (typeof args === "string") {
		try {
			const parsed = JSON.parse(args);
			if (
				parsed &&
				typeof parsed === "object" &&
				!Array.isArray(parsed)
			) {
				return parsed as Record<string, unknown>;
			}
			return {};
		} catch {
			return {};
		}
	}
	if (args && typeof args === "object") {
		return args as Record<string, unknown>;
	}
	return {};
}

// Define agent skills for A2A discovery
const AGENT_SKILLS: AgentSkill[] = [
	{
		id: "analyze-data",
		name: "Analyze Data",
		description:
			"Analyze data from connected sources (HubSpot, Attio, Google Sheets, databases) and generate insights",
		parameters: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: "What analysis to perform",
				},
				dataSource: {
					type: "string",
					description: "Optional: specific data source to use",
				},
			},
			required: ["query"],
		},
		examples: [
			"Analyze sales trends from HubSpot",
			"Show me customer engagement metrics from Attio",
			"Summarize the data in my Google Sheet",
		],
		tags: ["data", "analysis", "insights", "business-intelligence"],
	},
	{
		id: "create-visualization",
		name: "Create Visualization",
		description:
			"Generate charts and visualizations from data (bar, line, pie, scatter, histogram)",
		parameters: {
			type: "object",
			properties: {
				chartType: {
					type: "string",
					description: "Type of chart to create",
					enum: [
						"bar",
						"line",
						"pie",
						"scatter",
						"area",
						"histogram",
					],
				},
				data: {
					type: "string",
					description: "Description of data to visualize",
				},
			},
			required: ["data"],
		},
		examples: [
			"Create a bar chart of monthly sales",
			"Show revenue trends as a line chart",
			"Generate a pie chart of customer segments",
		],
		tags: ["visualization", "charts", "graphics"],
	},
	{
		id: "generate-report",
		name: "Generate Report",
		description:
			"Generate comprehensive data reports with statistics, trends, and recommendations",
		examples: [
			"Generate a quarterly sales report",
			"Create an executive summary of customer metrics",
			"Build a performance analysis report",
		],
		tags: ["reports", "summary", "documentation"],
	},
	{
		id: "query-data",
		name: "Query Data",
		description: "Query and retrieve data from connected MCP data sources",
		parameters: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: "Natural language query for data",
				},
			},
			required: ["query"],
		},
		examples: [
			"Get all contacts from HubSpot",
			"List deals closed this month",
			"Fetch customer data from the CRM",
		],
		tags: ["query", "data", "retrieval"],
	},
];

// Create the LangGraph agent
const dataAnalystGraph = createDataAnalystGraph();

// Create unified server
const { app, start } = createUnifiedServer(
	{
		name: "data_analyst",
		description:
			"Data analysis agent that connects to user's MCP data sources (HubSpot, Attio, Google Sheets, databases) to analyze data, generate insights, and create visualizations. Best for: data analysis, charts, reports, business intelligence.",
		baseUrl: BASE_URL,
		port: PORT,
		host: HOST,
		skills: AGENT_SKILLS,
		tags: [
			"data",
			"analysis",
			"visualization",
			"charts",
			"business-intelligence",
			"langgraph",
		],
		supportsStreaming: true,
		// Generalist agent capabilities
		autonomousExecution: true,
		taskDecomposition: true,
		contextPreservation: true,
		codeExecution: false,
		browserAutomation: false,
		memoryEnabled: false,
		multiTenancyAware: true,
		maxAutonomyLevel: "task",
	},
	// Invoke function - wraps the LangGraph graph
	async (input) => {
		const rawMessages = input.messages as Array<Record<string, unknown>>;
		const messages = normalizeMessages(rawMessages);

		// Extract tenant and AI config from input (passed from A2A metadata)
		const tenantUserId = input.tenant_user_id as string | undefined;
		const tenantOrgId = input.tenant_organization_id as string | undefined;
		const aiToken = input.ai_token as string | undefined;
		const aiApiKey = input.ai_api_key as string | undefined;
		const aiModel = input.ai_model as string | undefined;
		const aiProvider = input.ai_provider as string | undefined;
		const aiBaseUrl = input.ai_base_url as string | undefined;

		console.log("[DataAnalyst] Invoking with:", {
			messageCount: messages.length,
			tenantUserId: tenantUserId || "NOT SET",
			tenantOrgId: tenantOrgId || "NOT SET",
			aiToken: aiToken ? "SET" : "NOT SET",
		});

		// Clear artifacts from previous execution
		clearArtifacts();

		// Pass tenant context to the graph via configurable
		const result = await dataAnalystGraph.invoke(
			{
				messages,
				systemPrompt: SYSTEM_PROMPT,
			},
			{
				recursionLimit: DEFAULT_RECURSION_LIMIT,
				configurable: {
					tenant_user_id: tenantUserId,
					tenant_organization_id: tenantOrgId,
					ai_token: aiToken,
					ai_api_key: aiApiKey,
					ai_model: aiModel,
					ai_provider: aiProvider,
					ai_gateway_url: aiBaseUrl,
				},
			},
		);

		// Get all artifacts generated during execution
		const chartArtifacts = getGeneratedArtifacts();
		const connectionSuggestions = getConnectionSuggestionArtifacts();

		console.log("[DataAnalyst] Result:", {
			hasResponse: !!result.response,
			responseLength: result.response?.length || 0,
			chartArtifactsCount: chartArtifacts.length,
			connectionSuggestionsCount: connectionSuggestions.length,
		});

		return {
			response: result.response || "",
			messages: serializeMessages(result.messages),
			error: result.error,
			artifacts: chartArtifacts,
			connectionSuggestions,
		};
	},
	// Transform output for A2A response
	(output) => {
		const response = (output.response as string) || "";
		const chartArtifacts = (output.artifacts as ChartArtifact[]) || [];
		const connectionSuggestions =
			(output.connectionSuggestions as ConnectionSuggestionArtifact[]) ||
			[];

		// Combine all artifacts into the A2A Artifact shape (id/name/mimeType/parts)
		const allArtifacts: Artifact[] = [
			...chartArtifacts.map((a) => ({
				id: a.id,
				name: a.type,
				mimeType: "application/json",
				parts: [{ type: "data" as const, data: { ...a } }],
			})),
			...connectionSuggestions.map((a) => ({
				id: a.id,
				name: a.type,
				mimeType: "application/json",
				parts: [{ type: "data" as const, data: { ...a } }],
			})),
		];

		return {
			response,
			artifacts: allArtifacts,
			metadata: {
				error: output.error,
				chartCount: chartArtifacts.length,
				connectionSuggestionsCount: connectionSuggestions.length,
			},
		};
	},
	// A2A streaming executor (not used for now)
	undefined,
	// Platform streaming executor for CopilotKit LangGraphAgent
	async function* (
		input,
		config?: AgentRuntimeConfig,
	): AsyncGenerator<LangGraphStreamEvent> {
		const rawMessages = input.messages as Array<Record<string, unknown>>;
		const messages = normalizeMessages(rawMessages);

		console.log("[DataAnalyst] Streaming with:", {
			messageCount: messages.length,
			hasConfig: !!config,
			hasAiApiKey: !!config?.configurable?.ai_api_key,
			aiModel: config?.configurable?.ai_model,
			aiProvider: config?.configurable?.ai_provider,
			tenantUserId: config?.configurable?.tenant_user_id || "NOT SET",
			tenantOrgId:
				config?.configurable?.tenant_organization_id || "NOT SET",
			aiToken: config?.configurable?.ai_token ? "SET" : "NOT SET",
		});

		// Clear artifacts from previous execution
		clearArtifacts();

		// Stream from the LangGraph graph
		const stream = await dataAnalystGraph.stream(
			{
				messages,
				systemPrompt: SYSTEM_PROMPT,
			},
			{
				streamMode: ["updates", "messages"] as const,
				recursionLimit: DEFAULT_RECURSION_LIMIT,
				configurable: config?.configurable,
			},
		);

		let lastNodeName = "agent";
		let accumulatedResponse = "";

		for await (const chunk of stream) {
			const [streamMode, data] = chunk as [string, unknown];

			if (streamMode === "updates") {
				for (const [nodeName, stateUpdate] of Object.entries(
					data as Record<string, unknown>,
				)) {
					const state = stateUpdate as Record<string, unknown>;
					lastNodeName = nodeName;

					console.log(
						`[DataAnalyst] Stream update from node: ${nodeName}`,
						{
							hasResponse: !!state.response,
							responseLength:
								(state.response as string)?.length || 0,
						},
					);

					if (state.response) {
						accumulatedResponse = state.response as string;
					}

					yield {
						nodeName,
						state: {
							...state,
							streamingContent:
								state.response || accumulatedResponse || "",
						},
					};
				}
			} else if (streamMode === "messages") {
				// Handle message streaming for real-time token output
				const messageChunk = data as [unknown, unknown];
				const [message] = messageChunk;

				const msgAny = message as any;
				if (msgAny?.content) {
					// Accumulate streamed content
					const content =
						typeof msgAny.content === "string"
							? msgAny.content
							: Array.isArray(msgAny.content)
								? msgAny.content
										.filter((c: any) => c.type === "text")
										.map((c: any) => c.text)
										.join("")
								: "";

					if (content) {
						accumulatedResponse += content;
						yield {
							nodeName: lastNodeName,
							state: {
								streamingContent: accumulatedResponse,
							},
						};
					}
				}
			}
		}

		// Emit final state with artifacts
		const chartArtifacts = getGeneratedArtifacts();
		if (chartArtifacts.length > 0) {
			console.log(
				`[DataAnalyst] Streaming complete with ${chartArtifacts.length} chart artifacts`,
			);
			yield {
				nodeName: "end",
				state: {
					streamingContent: accumulatedResponse,
					artifacts: chartArtifacts,
				},
			};
		}
	},
);

// Start the server
start();

export { app };
