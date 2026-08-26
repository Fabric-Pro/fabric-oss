/**
 * Execution Context Builder
 *
 * Builds execution context including system prompts, step prompts,
 * and manages tool filtering based on risk levels and step entities.
 */

import type { ExecuteStepInput } from "../../types";
import type { ExtractedArtifact, ToolCallRecord } from "../handlers/types";
import { formatListResponse } from "./output-builder";

/**
 * Execution context built from input and previous steps.
 */
export interface ExecutionContext {
	systemPrompt: string;
	stepPrompt: string;
	maxSteps: number;
	cachedToolResults: Record<string, unknown>;
	variableContext: string;
	previousStepsContext: string;
	isBulkOperation: boolean;
	estimatedItems: number;
}

/**
 * Filters tools based on step risk level.
 *
 * NOTE: This function is now FULLY PERMISSIVE by design. The approval system
 * (trust-manager.ts) handles permission checks BEFORE step execution.
 * Tool filtering should NEVER silently remove tools - that breaks user workflows.
 *
 * PREVIOUS BEHAVIOR (removed - caused delete operations to fail):
 * - low/medium risk steps had delete tools filtered out
 * - This caused "delete all boards" requests to fail silently because
 *   the AI didn't have access to delete tools
 *
 * CURRENT BEHAVIOR:
 * - ALL tools are available to the LLM regardless of step risk level
 * - The approval system prompts the user for high-risk operations
 * - The verification system checks that all intended actions completed
 * - Per-item approval shows exactly what will be affected
 *
 * The proper protection flow is:
 * 1. Planning phase marks destructive steps as high/critical risk + requiresApproval=true
 * 2. Approval system extracts affected items from previous steps
 * 3. User sees per-item approval card with all items that will be affected
 * 4. Verification system confirms all actions completed
 */
export function filterToolsByRiskLevel(
	allTools: Record<string, unknown>,
	stepRiskLevel: string,
): Record<string, unknown> {
	// Log that we're NOT filtering - all tools available
	// The approval system handles permission checks
	console.log(
		`[filterToolsByRiskLevel] Allowing all ${Object.keys(allTools).length} tools (risk level: ${stepRiskLevel}). ` +
			"Approval system handles destructive operation permissions.",
	);

	// Return all tools unchanged - do not filter
	// The approval flow (trust-manager, per-item approval) handles safety
	return allTools;
}

/**
 * Filter tools by the entity type mentioned in the step description.
 * E.g., "Create a card" -> prioritize card-related tools
 * This reduces token usage and improves LLM focus.
 */
export function filterToolsByStepEntity(
	tools: Record<string, unknown>,
	stepDescription: string,
): Record<string, unknown> {
	const descLower = stepDescription.toLowerCase();

	// Common entity types and their related keywords
	const entityKeywords: Record<string, string[]> = {
		card: [
			"card",
			"cards",
			"task",
			"tasks",
			"ticket",
			"tickets",
			"issue",
			"issues",
		],
		board: ["board", "boards", "project", "projects", "workspace"],
		column: [
			"column",
			"columns",
			"list",
			"lists",
			"lane",
			"lanes",
			"status",
		],
		comment: ["comment", "comments", "note", "notes", "reply", "replies"],
		user: ["user", "users", "member", "members", "assignee", "owner"],
		tag: ["tag", "tags", "label", "labels"],
		step: ["step", "steps", "subtask", "subtasks", "checklist"],
		identity: [
			"identity",
			"account",
			"accounts",
			"profile",
			"me",
			"myself",
		],
	};

	// Detect which entities are mentioned in the step
	const mentionedEntities = new Set<string>();
	for (const [entity, keywords] of Object.entries(entityKeywords)) {
		for (const keyword of keywords) {
			if (descLower.includes(keyword)) {
				mentionedEntities.add(entity);
				break;
			}
		}
	}

	// If no specific entity detected, return all tools
	if (mentionedEntities.size === 0) {
		return tools;
	}

	// Always include identity for context (needed for account_id, etc.)
	mentionedEntities.add("identity");

	// If card is mentioned, also include board (cards belong to boards)
	if (mentionedEntities.has("card")) {
		mentionedEntities.add("board");
	}

	// If column is mentioned, also include board
	if (mentionedEntities.has("column")) {
		mentionedEntities.add("board");
	}

	// Filter tools to only those related to mentioned entities
	const filteredTools: Record<string, unknown> = {};
	for (const [toolName, toolDef] of Object.entries(tools)) {
		const toolLower = toolName.toLowerCase();

		let isRelevant = false;
		for (const entity of mentionedEntities) {
			if (toolLower.includes(entity)) {
				isRelevant = true;
				break;
			}
			if (toolLower.includes(`${entity}s`)) {
				isRelevant = true;
				break;
			}
		}

		if (isRelevant) {
			filteredTools[toolName] = toolDef;
		}
	}

	// Ensure we have at least some tools (fallback to all if filtering too aggressive)
	if (Object.keys(filteredTools).length < 3) {
		return tools;
	}

	return filteredTools;
}

/**
 * Builds execution context including prompts and cached results.
 */
export function buildExecutionContext(
	input: ExecuteStepInput,
	filteredTools: Record<string, unknown>,
): ExecutionContext {
	// Build variable context
	const variableContext = Object.entries(input.variables)
		.filter(([k]) => !k.startsWith("sys."))
		.map(([k, v]) => `${k} = ${JSON.stringify(v.value)}`)
		.join("\n");

	// Extract cached tool results from variables
	const cachedToolResults: Record<string, unknown> = {};
	for (const [key, variable] of Object.entries(input.variables)) {
		if (key.startsWith("tool.")) {
			const toolName = key.replace("tool.", "");
			cachedToolResults[toolName] = variable.value;
		}
	}

	// Extract key data from previous step tool calls to avoid redundant API calls
	const extractedData: Record<string, unknown> = {};
	for (const prevResult of input.previousStepResults) {
		if (prevResult.keyOutputs) {
			for (const [key, value] of Object.entries(prevResult.keyOutputs)) {
				if (key.includes("identity") || key.includes("account")) {
					extractedData.identity = value;
				}
				if (key.includes("boards") || key.includes("board")) {
					extractedData.boards = value;
				}
			}
		}
		if (prevResult.response) {
			try {
				const parsed = JSON.parse(prevResult.response);
				if (parsed?.accounts && !extractedData.identity) {
					extractedData.identity = parsed;
				}
				if (
					Array.isArray(parsed) &&
					parsed[0]?.id &&
					parsed[0]?.name &&
					!extractedData.boards
				) {
					extractedData.boards = parsed;
				}
			} catch {
				// Not JSON, ignore
			}
		}
	}

	// Merge extracted data into cached results
	for (const [key, value] of Object.entries(extractedData)) {
		const toolKey = key.includes("identity")
			? "get_identity"
			: key.includes("board")
				? "get_boards"
				: key;
		if (!cachedToolResults[toolKey] && value) {
			cachedToolResults[toolKey] = value;
		}
	}

	const currentStepType = input.step.type;
	const isResearchStep = currentStepType === "research";

	// Build cached results context
	let cachedResultsContext = "";
	if (Object.keys(cachedToolResults).length > 0 && !isResearchStep) {
		const cachedItems = Object.entries(cachedToolResults)
			.map(([tool, result]) => {
				const resultStr = JSON.stringify(result, null, 2);
				const maxLen =
					tool.includes("identity") || tool.includes("boards")
						? 1000
						: 500;
				return `${tool}:\n${resultStr.slice(0, maxLen)}${resultStr.length > maxLen ? "..." : ""}`;
			})
			.join("\n\n");

		cachedResultsContext = `
=== CACHED DATA FROM PREVIOUS STEPS ===
**CRITICAL: Use this data instead of making redundant API calls!**
- DO NOT call get_identity/get_accounts again - use the cached identity below
- DO NOT call get_boards again - use the cached boards list below
- Extract account_id, board_id, and other IDs from this cached data

${cachedItems}
`;
	}

	// Build tool descriptions
	const _toolDescriptions = Object.entries(filteredTools)
		.map(([name, def]) => {
			const toolDef = def as {
				description?: string;
				inputSchema?: Record<string, unknown>;
			};
			const schema = toolDef.inputSchema;
			let paramInfo = "";
			if (schema?.properties) {
				const props = schema.properties as Record<
					string,
					{ type?: string; description?: string }
				>;
				const required = (schema.required as string[]) || [];
				const paramList = Object.entries(props).map(
					([paramName, paramDef]) => {
						const isRequired = required.includes(paramName);
						return `    - ${paramName}${isRequired ? " (required)" : ""}: ${paramDef.type || "any"} - ${paramDef.description || ""}`;
					},
				);
				paramInfo =
					paramList.length > 0
						? `\n  Parameters:\n${paramList.join("\n")}`
						: "";
			}
			return `- ${name}: ${toolDef.description || "No description"}${paramInfo}`;
		})
		.join("\n\n");

	// Step inputs context
	const stepInputsContext = input.step.inputs
		? `\nPlanned Inputs for this step:\n${JSON.stringify(input.step.inputs, null, 2)}`
		: "";

	// Check for bulk operation
	const stepInputsObj = input.step.inputs as
		| Record<string, unknown>
		| undefined;
	const iterateOver = stepInputsObj?.iterateOver as string | undefined;
	const isBulkOperation =
		iterateOver ||
		input.step.description.toLowerCase().includes("each") ||
		input.step.description.toLowerCase().includes("all") ||
		input.step.description.toLowerCase().includes("every") ||
		input.step.description.toLowerCase().includes("iterate") ||
		input.step.description.toLowerCase().includes("bulk");

	// Build iteration context
	let iterationContext = "";
	let estimatedItems = 10;

	if (isBulkOperation) {
		for (const [, result] of Object.entries(cachedToolResults)) {
			if (Array.isArray(result)) {
				estimatedItems = Math.max(estimatedItems, result.length);
			}
		}

		for (const prevResult of input.previousStepResults) {
			if (prevResult.response) {
				try {
					const parsed = JSON.parse(prevResult.response);
					if (Array.isArray(parsed)) {
						estimatedItems = Math.max(
							estimatedItems,
							parsed.length,
						);
					} else if (parsed && typeof parsed === "object") {
						for (const val of Object.values(parsed)) {
							if (Array.isArray(val)) {
								estimatedItems = Math.max(
									estimatedItems,
									(val as unknown[]).length,
								);
							}
						}
					}
				} catch {}
			}
		}

		iterationContext = `
=== BULK/ITERATION OPERATION ===
**YOU MUST PROCESS ALL ITEMS - DO NOT STOP EARLY**

This step requires iteration over ${estimatedItems > 0 ? `${estimatedItems} items` : "all items"}.
- Call the tool ONCE for EACH item in the list
- Do NOT stop after 2-3 items - process the ENTIRE list
- If there are 10 items, make 10 tool calls
- If there are 50 items, make 50 tool calls
- Report progress: "Processing item X of Y..."
`;
	}

	// Previous steps context
	const previousStepsContext =
		input.previousStepResults.length > 0
			? `\n\nPREVIOUS STEPS COMPLETED:\n${input.previousStepResults
					.map(
						(s, idx) =>
							`Step ${idx + 1}: ${s.stepDescription}\nResult: ${s.response || "(no response yet)"}`,
					)
					.join("\n\n")}`
			: "";

	// Step rules
	const stepRules = isResearchStep
		? `Rules: Execute ONLY this step. You MUST use the available tools to gather NEW information specific to "${input.step.description}". Do not assume previous step data covers this topic - each research step has a unique focus.`
		: "Rules: Execute ONLY this step. Use cached data if available.";

	// Tool usage guidelines
	const toolUsageGuidelines = `
=== TOOL USAGE GUIDELINES ===

**1. TOOL SELECTION**
- Choose the most specific tool for the task
- If a "search" or "get" tool exists, prefer it over "list" tools
- One well-chosen tool call is better than multiple redundant calls

**2. PARAMETER HANDLING**
- Read each tool's parameter schema carefully
- Use the exact parameter names and types specified
- Different identifiers serve different purposes (workspace_id vs project_id vs item_id)
- When a tool returns IDs, use those IDs (not names) for subsequent tool calls

**3. PROCESSING TOOL RESULTS**
- Parse JSON responses carefully to extract the data you need
- If a tool returns a list, that single call contains ALL the data - do not call it again
- Use IDs from results when making follow-up tool calls

**4. PRESENTING RESULTS TO USER**
**CRITICAL: You must present ALL data from tool results to the user - NEVER truncate or summarize.**
- If a tool returns 5 items, show all 5 items
- If a tool returns 50 items, show all 50 items
- Do NOT say "and X more..." or "here are the first few..."
- Format each item with its key properties (name, ID, description, URL, dates, etc.)
- Present results in a clear, organized format (use markdown lists or tables)

**5. EFFICIENCY**
- A single tool call that returns a list is sufficient - do NOT call the same tool multiple times for the same data
- Do NOT iterate by calling a tool once per item when a single call returns all items
- Cache and reuse results from previous steps when relevant

**6. CHARTS AND VISUALIZATIONS**
- When the user asks for a chart, call the create_chart tool with RAW data - the tool handles aggregation
- **Pass raw API data directly** - DO NOT try to count or aggregate yourself
- **The tool will count/sum/aggregate** - just tell it how via the 'aggregation' parameter
- Example: If API returned [{board_name: "A", ...}, {board_name: "B", ...}, {board_name: "A", ...}]
  Call: create_chart(data: <raw_api_response>, groupBy: "board_name", aggregation: "count", chartType: "pie")
  The tool will count: A=2, B=1 and create the chart
- **Parameters:**
  - data: Pass the RAW array from API response (don't modify it)
  - groupBy: Field to categorize by (e.g., "board_name", "status", "type", "assignee")
  - aggregation: "count" (count items), "sum" (total a field), "average", or "none"
  - valueField: Only needed for "sum" or "average" - the numeric field to aggregate
- **WRONG:** Trying to count items yourself, making up numbers, writing markdown about charts
- **RIGHT:** Pass raw data array + aggregation instructions, let the tool do the math`;

	// Final step instructions
	const isFinalStep = input.stepIndex === input.totalSteps;
	const finalStepInstructions = isFinalStep
		? `
=== FINAL STEP - PRESENT YOUR ANSWER ===
This is the final step. Present the COMPLETE answer to the user's question.

DO:
- Present ALL data retrieved from tools (every item in lists, all relevant fields)
- Format the answer clearly with the most important information first
- Include names, IDs, URLs, dates, and other relevant properties for each item

DO NOT:
- Summarize or truncate lists ("showing 3 of 10...")
- Describe what you did instead of showing results
- Omit items from lists to be brief
- Make additional tool calls for data you already have
`
		: "";

	// Include user memory context and learned patterns if provided
	// This ensures patterns like "use tabular form" are enforced during execution
	const memoryContext = input.systemPrompt ? `\n${input.systemPrompt}\n` : "";

	// Build system prompt
	const systemPrompt = `Step ${input.stepIndex}/${input.totalSteps}: ${input.step.description}
${stepInputsContext}
${memoryContext}
Context: ${input.message}
${previousStepsContext ? `\nPrevious steps:\n${previousStepsContext}` : ""}
${cachedResultsContext ? `\n${cachedResultsContext}` : ""}
${iterationContext}
${finalStepInstructions}

${stepRules}
${toolUsageGuidelines}`;

	// Calculate max steps
	let maxSteps = input.executionMode === "balanced" ? 8 : 5;
	if (isBulkOperation) {
		maxSteps = Math.min(Math.max(estimatedItems + 2, 10), 20);
		console.log(
			`[ExecutionContextBuilder] Bulk operation detected, estimated ${estimatedItems} items, maxSteps=${maxSteps}`,
		);
	}

	const bulkInstruction = isBulkOperation
		? "\n\n**CRITICAL: Process ALL items in the list. Do NOT stop after a few items.**"
		: "";
	const stepPrompt = `${input.step.description}${bulkInstruction}\n\nRemember: Present ALL results from tool calls - never truncate lists.`;

	return {
		systemPrompt,
		stepPrompt,
		maxSteps,
		cachedToolResults,
		variableContext,
		previousStepsContext,
		isBulkOperation: Boolean(isBulkOperation),
		estimatedItems,
	};
}

/**
 * Extracts artifacts from tool results and response text.
 */
export function extractArtifactsFromResults(
	stepId: string,
	responseText: string,
	toolCalls: ToolCallRecord[],
): ExtractedArtifact[] {
	const artifacts: ExtractedArtifact[] = [];

	// Extract code blocks from response
	const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
	let match: RegExpExecArray | null;
	let codeIndex = 0;
	while (
		// biome-ignore lint/suspicious/noAssignInExpressions: standard regex iteration idiom
		(match = codeBlockRegex.exec(responseText)) !== null
	) {
		const language = match[1] || "text";
		const content = match[2].trim();
		if (content.length > 50) {
			artifacts.push({
				id: `${stepId}-code-${codeIndex++}`,
				type: "code",
				name: `Code (${language})`,
				content,
				metadata: { language },
			});
		}
	}

	// Check if response looks like a document
	const textWithoutCode = responseText.replace(codeBlockRegex, "").trim();
	const isSubstantialDocument =
		textWithoutCode.length > 300 &&
		(responseText.includes("##") ||
			responseText.includes("# ") ||
			responseText.includes("**") ||
			(responseText.includes("- ") &&
				responseText.split("- ").length > 3) ||
			responseText.split("\n").length > 8);

	if (isSubstantialDocument) {
		artifacts.push({
			id: `${stepId}-doc-main`,
			type: "document",
			name: "Generated Document",
			content: responseText,
			metadata: { format: "markdown" },
		});
	}

	// Extract artifacts from tool results
	for (const tc of toolCalls) {
		if (tc.status !== "success" || !tc.result) {
			continue;
		}

		const resultStr =
			typeof tc.result === "string"
				? tc.result
				: JSON.stringify(tc.result, null, 2);

		if (resultStr.length < 100) {
			continue;
		}

		if (typeof tc.result === "object" && tc.result !== null) {
			const resultObj = tc.result as Record<string, unknown>;
			if (resultObj.content && typeof resultObj.content === "string") {
				artifacts.push({
					id: `${stepId}-${tc.id}-file`,
					type: resultObj.type === "code" ? "code" : "document",
					name: (resultObj.name as string) || `${tc.name} output`,
					content: resultObj.content as string,
					metadata: { toolName: tc.name, ...resultObj },
				});
			} else if (resultStr.length > 500) {
				artifacts.push({
					id: `${stepId}-${tc.id}-data`,
					type: "data",
					name: `${tc.name} result`,
					content: resultStr,
					metadata: { toolName: tc.name },
				});
			}
		} else if (resultStr.length > 500) {
			artifacts.push({
				id: `${stepId}-${tc.id}-result`,
				type: "tool_result",
				name: `${tc.name} output`,
				content: resultStr,
				metadata: { toolName: tc.name },
			});
		}
	}

	return artifacts;
}

/**
 * Formats tool results as a direct response when they contain list data.
 */
export function formatToolResultsAsDirectResponse(
	toolCalls: ToolCallRecord[],
	stepDescription: string,
): string | null {
	const successfulCalls = toolCalls.filter(
		(tc) => tc.status === "success" && tc.result,
	);
	if (successfulCalls.length === 0) {
		return null;
	}

	for (const tc of successfulCalls) {
		const result = tc.result;

		let data: unknown = result;
		if (typeof result === "string") {
			try {
				data = JSON.parse(result);
			} catch {
				if (typeof result === "object" && result !== null) {
					const obj = result as Record<string, unknown>;
					if (obj.content && Array.isArray(obj.content)) {
						const textContent = obj.content.find(
							(c: unknown) =>
								typeof c === "object" &&
								c !== null &&
								(c as Record<string, unknown>).type === "text",
						);
						if (
							textContent &&
							typeof (textContent as Record<string, unknown>)
								.text === "string"
						) {
							try {
								data = JSON.parse(
									(textContent as Record<string, unknown>)
										.text as string,
								);
							} catch {
								continue;
							}
						}
					}
				} else {
					continue;
				}
			}
		}

		// Handle MCP tool response format
		if (typeof data === "object" && data !== null && !Array.isArray(data)) {
			const obj = data as Record<string, unknown>;
			if (obj.content && Array.isArray(obj.content)) {
				const textContent = obj.content.find(
					(c: unknown) =>
						typeof c === "object" &&
						c !== null &&
						(c as Record<string, unknown>).type === "text",
				);
				if (
					textContent &&
					typeof (textContent as Record<string, unknown>).text ===
						"string"
				) {
					try {
						data = JSON.parse(
							(textContent as Record<string, unknown>)
								.text as string,
						);
					} catch {
						continue;
					}
				}
			}
		}

		if (Array.isArray(data) && data.length > 0) {
			return formatListResponse(data, tc.name, stepDescription);
		}
	}

	return null;
}
