/**
 * @repo/agent-tools
 *
 * Framework-agnostic tool definitions for agents.
 * These tool definitions work with agents written in any language (TypeScript, Python, C#)
 * as long as they support the AG-UI protocol.
 */

/**
 * Framework-agnostic tool definition
 * This format can be serialized and sent to agents in any language
 */
export interface ToolDefinition {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: {
			type: "object";
			properties: Record<string, any>;
			required?: string[];
			additionalProperties?: boolean;
		};
	};
}

/**
 * Write document tool
 * Single source of truth for the document writing tool definition
 * Used by all agents regardless of implementation language
 */
export const WRITE_DOCUMENT_TOOL: ToolDefinition = {
	type: "function",
	function: {
		name: "write_document_local",
		description: [
			"Write a document. Use markdown formatting to format the document.",
			"It's good to format the document extensively so it's easy to read.",
			"You can use all kinds of markdown.",
			"However, do NOT use italic (*text*) or strike-through (~~text~~) formatting - these are reserved for diff highlighting.",
			"You MUST write the FULL document, even when changing only a few words.",
			"CRITICAL: When making edits to existing content, make MINIMAL changes:",
			"- Only modify the specific sections that need to change",
			"- Keep all other text EXACTLY as it was - copy it word-for-word",
			"- Do NOT rephrase, reorganize, or 'improve' content that wasn't asked to change",
			"- If asked to add something, INSERT it without modifying surrounding text",
			"- If asked to add a character, add ONLY the character details without rewriting the story",
			"Keep documents concise and focused.",
		].join(" "),
		parameters: {
			type: "object",
			properties: {
				document: {
					type: "string",
					description:
						"The complete document content in markdown format",
				},
				focusAnchor: {
					type: ["string", "null"],
					description:
						"Section heading where changes were made (e.g., '## Overview'). Can be null if not applicable.",
				},
			},
			required: ["document"],
			additionalProperties: false,
		},
	},
};

/**
 * Confirm changes tool
 * Used to request user confirmation for document changes
 */
export const CONFIRM_CHANGES_TOOL: ToolDefinition = {
	type: "function",
	function: {
		name: "confirm_changes",
		description: "Request user confirmation for document changes",
		parameters: {
			type: "object",
			properties: {},
		},
	},
};

/**
 * Apply document patches tool
 *
 * Targeted patch-based editing. Use this INSTEAD of rewriting the full
 * document when editing an existing doc. The model emits a small list of
 * operations (replace_section, insert_after, replace_text, etc.) anchored
 * by heading path strings like "## Requirements > ### Must Have", and the
 * agent server applies them server-side against the stable baseline.
 *
 * Output tokens stay small (~2K for typical edits) instead of scaling with
 * document size, which eliminates max_tokens truncation for large docs.
 */
export const APPLY_DOCUMENT_PATCHES_TOOL: ToolDefinition = {
	type: "function",
	function: {
		name: "apply_document_patches",
		description: [
			"Apply small, targeted edits to the current document using find/replace patches.",
			"Use this INSTEAD of rewriting the full document.",
			"PREFERRED SHAPE: replace_text WITHOUT an anchor — find a unique snippet of text in the document, replace it. This is the find/replace primitive every popular LLM has seen extensively in pretraining and avoids every anchor-resolution failure mode (heading-path typos, rename confusion, etc.).",
			"All find-strings and anchors resolve against the CURRENT document, not against prior patches in the same call.",
			"Emit ALL patches in a SINGLE call. Each patch's `content` must be ONLY the new markdown, never the surrounding document.",
			"Operations:",
			"- replace_text (PREFERRED): Replace a literal string. Anchor is optional — when omitted, search the whole document. Include enough context in `find` to make it unique. Use `replace: ''` to delete. Set `replaceAll: true` to replace EVERY occurrence of `find` in the search scope — use this when the user asks to replace all instances of a phrase or rename a term globally.",
			"- replace_section: Replace a section's body (keeps the heading line unless keepHeading=false). Use only for large body rewrites where a precise find string would be cumbersome.",
			"- insert_after / insert_before: Insert new markdown around a section. Often replaceable by replace_text whose `find` includes the surrounding text.",
			"- append_to_section / prepend_to_section: Add content at the end/start of a section's body.",
			"- delete_section: Remove a section and all its subsections.",
			"To rename a heading, use replace_text on the heading line itself (e.g. `find: '# Old Title'`, `replace: '# New Title'`) — much simpler than replace_section with keepHeading: false.",
			"Do NOT use italic (*text*) or strikethrough (~~text~~) formatting — both are reserved for diff highlighting.",
			"HTML tables: if the targeted section contains an HTML `<table>` block (typical for `Document Control` and `Revision History` after editor round-trip), do NOT emit markdown table rows (`| col | col |`) — they will not merge into the existing `<table>` and will leak as raw text below it. Instead, use replace_text with a `find` snippet from inside the existing `<table>` (e.g. an existing `</tbody>` or a specific `<tr>…</tr>`) and a `replace` that splices a new `<tr>…</tr>` in HTML form before the closing tag. Match the exact HTML shape of the existing rows.",
		].join(" "),
		parameters: {
			type: "object",
			properties: {
				patches: {
					type: "array",
					description:
						"Ordered list of patches. Each resolves against the current document independently.",
					items: {
						type: "object",
						properties: {
							op: {
								type: "string",
								enum: [
									"replace_section",
									"insert_after",
									"insert_before",
									"append_to_section",
									"prepend_to_section",
									"delete_section",
									"replace_text",
								],
								description: "The patch operation to perform.",
							},
							anchor: {
								type: "string",
								description:
									"Full heading path, e.g. '## Requirements > ### Must Have'. OPTIONAL for replace_text — when omitted, the find string is searched against the whole document (preferred). REQUIRED for every other operation.",
							},
							content: {
								type: "string",
								description:
									"New markdown content. Required for every operation except delete_section and replace_text.",
							},
							find: {
								type: "string",
								description:
									"Literal string to find. Required only for replace_text. Must match exactly once in the search scope (whole document if anchor is omitted, otherwise the anchored section) unless `replaceAll` is true. Include enough surrounding context to make the match unique.",
							},
							replace: {
								type: "string",
								description:
									"Replacement string. Required only for replace_text. May be empty to delete the found text.",
							},
							replaceAll: {
								type: "boolean",
								description:
									"replace_text only: replace EVERY occurrence of `find` in the search scope (whole document if anchor is omitted, otherwise the anchored section). Default false. Set true only when the user asks to replace all instances of a phrase or rename a term globally — never for surgical single-spot edits.",
							},
							keepHeading: {
								type: "boolean",
								description:
									"replace_section only: if false, also replaces the heading line itself. For simple renames, prefer replace_text on the heading line directly instead.",
							},
						},
						required: ["op"],
						additionalProperties: false,
					},
				},
				focusAnchor: {
					type: ["string", "null"],
					description:
						"Optional heading path the editor should scroll to after the changes are applied. Use the same path format as anchors.",
				},
			},
			required: ["patches"],
			additionalProperties: false,
		},
	},
};

/**
 * Enhance prompt tool
 * Used by the Prompt Enhancer Agent to update prompt content
 */
/**
 * ENHANCE_PROMPT_TOOL - Simplified tool for enhancing prompts
 * Matches WRITE_DOCUMENT_TOOL pattern for reliable Groq tool calling
 */
export const ENHANCE_PROMPT_TOOL: ToolDefinition = {
	type: "function",
	function: {
		name: "enhance_prompt_local",
		description: [
			"Write the enhanced version of a prompt. Use markdown formatting.",
			"You MUST write the FULL enhanced prompt, even when changing only a few words.",
			"Preserve all template variables exactly as they appear in the original.",
			"Do not use italic or strike-through formatting, it is reserved for another purpose.",
			"After calling this tool, DO NOT repeat the content - say something brief instead.",
		].join(" "),
		parameters: {
			type: "object",
			properties: {
				enhancedContent: {
					type: "string",
					description: "The complete enhanced prompt content",
				},
				focusAnchor: {
					type: "string",
					description:
						"Optional: A short text snippet where key changes were made for UI scrolling",
				},
			},
			required: ["enhancedContent"],
		},
	},
};

/**
 * Get all standard document tools
 */
export function getDocumentTools(): ToolDefinition[] {
	return [WRITE_DOCUMENT_TOOL, CONFIRM_CHANGES_TOOL];
}

/**
 * Get all prompt enhancement tools
 */
export function getPromptTools(): ToolDefinition[] {
	return [ENHANCE_PROMPT_TOOL];
}

/**
 * Write features tool
 * Used by the Story Breakdown Agent to output features from a PRD
 */
export const WRITE_STORIES_TOOL: ToolDefinition = {
	type: "function",
	function: {
		name: "write_stories_local",
		description: [
			"Write features extracted from a PRD or requirements document.",
			"Each story should follow the 'As a [persona], I want [action], so that [benefit]' format.",
			"Include acceptance criteria, priority, and effort estimates for each story.",
			"Use markdown formatting to structure the stories clearly.",
			"You MUST write ALL the stories in a single call, not incrementally.",
			"Group stories by epic or feature when appropriate.",
		].join(" "),
		parameters: {
			type: "object",
			properties: {
				stories: {
					type: "string",
					description:
						"The complete set of features in markdown format",
				},
				summary: {
					type: "string",
					description:
						"Brief summary of the breakdown (total stories, epics, etc.)",
				},
				focusAnchor: {
					type: "string",
					description:
						"Optional: The section heading to focus on after update",
				},
			},
			required: ["stories"],
		},
	},
};

/**
 * Write tasks tool
 * Used by the Task Planner Agent to output granular development tasks
 */
export const WRITE_TASKS_TOOL: ToolDefinition = {
	type: "function",
	function: {
		name: "write_tasks_local",
		description: [
			"Write development tasks broken down from features.",
			"Each task should be granular enough to be completed in 1-4 hours.",
			"Include task descriptions, time estimates, and technical notes.",
			"Organize tasks hierarchically with parent tasks and subtasks.",
			"You MUST write ALL tasks in a single call, not incrementally.",
			"Include dependency information between tasks when relevant.",
		].join(" "),
		parameters: {
			type: "object",
			properties: {
				tasks: {
					type: "string",
					description:
						"The complete set of development tasks in markdown format",
				},
				summary: {
					type: "string",
					description:
						"Brief summary of the task breakdown (total tasks, categories, etc.)",
				},
				focusAnchor: {
					type: "string",
					description:
						"Optional: The section heading to focus on after update",
				},
			},
			required: ["tasks"],
		},
	},
};

/**
 * Create issue tool
 * Used by agents to create issues in external systems (Linear, GitHub, Jira)
 */
export const CREATE_ISSUE_TOOL: ToolDefinition = {
	type: "function",
	function: {
		name: "create_issue",
		description: [
			"Create an issue in an external project management system.",
			"Supports Linear, GitHub Issues, and Jira.",
			"The issue will be created via the configured MCP integration.",
		].join(" "),
		parameters: {
			type: "object",
			properties: {
				title: {
					type: "string",
					description: "The issue title",
				},
				description: {
					type: "string",
					description: "The issue description in markdown format",
				},
				labels: {
					type: "array",
					items: { type: "string" },
					description: "Labels or tags for the issue",
				},
				priority: {
					type: "string",
					enum: ["urgent", "high", "medium", "low", "none"],
					description: "Priority level for the issue",
				},
				estimate: {
					type: "number",
					description: "Time estimate in hours",
				},
				assignee: {
					type: "string",
					description: "Optional: Username or ID of the assignee",
				},
			},
			required: ["title", "description"],
		},
	},
};

/**
 * Get all story breakdown tools
 */
export function getStoryTools(): ToolDefinition[] {
	return [WRITE_STORIES_TOOL, CONFIRM_CHANGES_TOOL];
}

/**
 * Get all task planning tools
 */
export function getTaskTools(): ToolDefinition[] {
	return [WRITE_TASKS_TOOL, CREATE_ISSUE_TOOL, CONFIRM_CHANGES_TOOL];
}

// ============================================================================
// Task Decomposition Tools (CUGA-inspired)
// ============================================================================

/**
 * Write decomposed tasks tool
 * Used by Task Planner to output structured task decomposition with risk analysis
 */
export const WRITE_TASK_PLAN_TOOL: ToolDefinition = {
	type: "function",
	function: {
		name: "write_task_plan",
		description: [
			"Write a comprehensive task plan with decomposed tasks, risk analysis, and execution plan.",
			"This tool outputs structured data for task decomposition visualization.",
			"Include all tasks broken down to 1-4 hour granularity.",
			"Assess risks for each task and provide mitigation strategies.",
			"Identify dependencies and suggest parallel execution opportunities.",
		].join(" "),
		parameters: {
			type: "object",
			properties: {
				document: {
					type: "string",
					description:
						"The complete task plan document in markdown format",
				},
				decomposedTasks: {
					type: "array",
					description:
						"Array of decomposed tasks with risk scores and dependencies",
					items: {
						type: "object",
						properties: {
							id: { type: "string" },
							parentId: { type: "string" },
							title: { type: "string" },
							description: { type: "string" },
							type: {
								type: "string",
								enum: [
									"Frontend",
									"Backend",
									"Database",
									"DevOps",
									"Testing",
									"Documentation",
								],
							},
							estimate: { type: "number" },
							complexity: {
								type: "string",
								enum: ["low", "medium", "high"],
							},
							riskScore: { type: "number" },
							riskFactors: {
								type: "array",
								items: { type: "string" },
							},
							dependencies: {
								type: "array",
								items: { type: "string" },
							},
							blockedBy: {
								type: "array",
								items: { type: "string" },
							},
							parallelizable: { type: "boolean" },
							acceptanceCriteria: {
								type: "array",
								items: { type: "string" },
							},
							technicalApproach: {
								type: "array",
								items: { type: "string" },
							},
							filesToModify: {
								type: "array",
								items: { type: "string" },
							},
						},
						required: [
							"id",
							"title",
							"description",
							"type",
							"estimate",
							"complexity",
							"riskScore",
						],
					},
				},
				riskAnalysis: {
					type: "object",
					description:
						"Overall risk analysis with factors and mitigations",
					properties: {
						overallScore: { type: "number" },
						factors: {
							type: "array",
							items: {
								type: "object",
								properties: {
									id: { type: "string" },
									category: {
										type: "string",
										enum: [
											"technical",
											"resource",
											"timeline",
											"dependency",
											"unknown",
										],
									},
									description: { type: "string" },
									severity: {
										type: "string",
										enum: [
											"low",
											"medium",
											"high",
											"critical",
										],
									},
									probability: { type: "number" },
									impact: { type: "number" },
									affectedTasks: {
										type: "array",
										items: { type: "string" },
									},
								},
							},
						},
						mitigations: {
							type: "array",
							items: {
								type: "object",
								properties: {
									riskId: { type: "string" },
									strategy: { type: "string" },
									effort: { type: "number" },
									effectiveness: { type: "number" },
								},
							},
						},
						recommendations: {
							type: "array",
							items: { type: "string" },
						},
					},
				},
				dependencyGraph: {
					type: "object",
					description: "Task dependency graph for visualization",
					properties: {
						nodes: {
							type: "array",
							items: {
								type: "object",
								properties: {
									id: { type: "string" },
									label: { type: "string" },
									level: { type: "number" },
									type: { type: "string" },
								},
							},
						},
						edges: {
							type: "array",
							items: {
								type: "object",
								properties: {
									from: { type: "string" },
									to: { type: "string" },
									type: {
										type: "string",
										enum: ["blocks", "depends"],
									},
								},
							},
						},
						criticalPath: {
							type: "array",
							items: { type: "string" },
						},
						totalCriticalPathDuration: { type: "number" },
					},
				},
				executionPlan: {
					type: "object",
					description: "Phased execution plan with parallelization",
					properties: {
						phases: {
							type: "array",
							items: {
								type: "object",
								properties: {
									id: { type: "string" },
									name: { type: "string" },
									tasks: {
										type: "array",
										items: { type: "string" },
									},
									duration: { type: "number" },
									dependencies: {
										type: "array",
										items: { type: "string" },
									},
								},
							},
						},
						totalDuration: { type: "number" },
						parallelDuration: { type: "number" },
						parallelizationFactor: { type: "number" },
						recommendedTeamSize: { type: "number" },
					},
				},
				focusAnchor: {
					type: "string",
					description: "Section heading to scroll to after update",
				},
			},
			required: ["document", "decomposedTasks"],
		},
	},
};

/**
 * Get enhanced task planning tools with decomposition
 */
export function getEnhancedTaskTools(): ToolDefinition[] {
	return [WRITE_TASK_PLAN_TOOL, CREATE_ISSUE_TOOL, CONFIRM_CHANGES_TOOL];
}

// ============================================================================
// Human-in-the-Loop (HITL) Tools
// ============================================================================

/**
 * Request human approval tool
 * Used by agents to request approval before proceeding with risky actions
 */
export const REQUEST_HUMAN_APPROVAL_TOOL: ToolDefinition = {
	type: "function",
	function: {
		name: "request_human_approval",
		description: [
			"Request human approval before proceeding with a potentially risky or irreversible action.",
			"Use this when the agent is about to perform an action that could have significant consequences.",
			"Examples: deleting data, sending emails, making API calls to external services, modifying production systems.",
		].join(" "),
		parameters: {
			type: "object",
			properties: {
				prompt: {
					type: "string",
					description:
						"Clear description of what approval is needed for",
				},
				title: {
					type: "string",
					description: "Optional title for the approval dialog",
				},
				context: {
					type: "object",
					description:
						"Additional context to help the human make a decision",
				},
				timeout: {
					type: "number",
					description: "Timeout in milliseconds (default: 60000)",
				},
			},
			required: ["prompt"],
		},
	},
};

/**
 * Request human input tool
 * Used by agents to request text input from the user
 */
export const REQUEST_HUMAN_INPUT_TOOL: ToolDefinition = {
	type: "function",
	function: {
		name: "request_human_input",
		description: [
			"Request text input from the user when the agent needs additional information.",
			"Use this when the agent needs clarification, missing data, or user preferences.",
		].join(" "),
		parameters: {
			type: "object",
			properties: {
				prompt: {
					type: "string",
					description: "Clear description of what input is needed",
				},
				title: {
					type: "string",
					description: "Optional title for the input dialog",
				},
				defaultValue: {
					type: "string",
					description: "Optional default value for the input field",
				},
				multiline: {
					type: "boolean",
					description:
						"Whether to show a multiline text area (default: false)",
				},
				required: {
					type: "boolean",
					description:
						"Whether the input is required (default: true)",
				},
				timeout: {
					type: "number",
					description: "Timeout in milliseconds (default: 60000)",
				},
			},
			required: ["prompt"],
		},
	},
};

/**
 * Request human choice tool
 * Used by agents to request a selection from predefined options
 */
export const REQUEST_HUMAN_CHOICE_TOOL: ToolDefinition = {
	type: "function",
	function: {
		name: "request_human_choice",
		description: [
			"Request the user to select from a list of predefined options.",
			"Use this when the agent needs the user to make a decision between specific choices.",
		].join(" "),
		parameters: {
			type: "object",
			properties: {
				prompt: {
					type: "string",
					description: "Clear description of what choice is needed",
				},
				title: {
					type: "string",
					description: "Optional title for the choice dialog",
				},
				options: {
					type: "array",
					description: "List of options to choose from",
					items: {
						type: "object",
						properties: {
							value: {
								type: "string",
								description: "Option value",
							},
							label: {
								type: "string",
								description: "Display label",
							},
							description: {
								type: "string",
								description: "Optional description",
							},
						},
						required: ["value", "label"],
					},
				},
				timeout: {
					type: "number",
					description: "Timeout in milliseconds (default: 60000)",
				},
			},
			required: ["prompt", "options"],
		},
	},
};

/**
 * Get all HITL tools
 */
export function getHITLTools(): ToolDefinition[] {
	return [
		REQUEST_HUMAN_APPROVAL_TOOL,
		REQUEST_HUMAN_INPUT_TOOL,
		REQUEST_HUMAN_CHOICE_TOOL,
	];
}

// ============================================================================
// Agent Workspace Tools (CUGA-inspired file management)
// ============================================================================

/**
 * Create file tool
 * Used by agents to create files in the workspace
 */
export const CREATE_WORKSPACE_FILE_TOOL: ToolDefinition = {
	type: "function",
	function: {
		name: "create_file",
		description: [
			"Create a new file in the agent workspace.",
			"Use this to save code, documents, data, or any other content generated during execution.",
			"Files are organized in a virtual file system visible to the user.",
			"Choose appropriate file paths and extensions based on content type.",
		].join(" "),
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description:
						"Virtual file path (e.g., '/documents/report.md', '/code/script.py')",
				},
				name: {
					type: "string",
					description: "File name with extension",
				},
				content: {
					type: "string",
					description: "File content to write",
				},
				fileType: {
					type: "string",
					enum: [
						"DOCUMENT",
						"CODE",
						"DATA",
						"CONFIG",
						"OUTPUT",
						"ARTIFACT",
					],
					description: "Type of file being created",
				},
				description: {
					type: "string",
					description: "Optional description of the file",
				},
			},
			required: ["path", "name", "content"],
		},
	},
};

/**
 * Read file tool
 * Used by agents to read files from the workspace
 */
export const READ_WORKSPACE_FILE_TOOL: ToolDefinition = {
	type: "function",
	function: {
		name: "read_file",
		description: [
			"Read a file from the agent workspace.",
			"Use this to retrieve previously saved content or reference existing files.",
		].join(" "),
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Virtual file path to read",
				},
			},
			required: ["path"],
		},
	},
};

/**
 * Update file tool
 * Used by agents to update existing files in the workspace
 */
export const UPDATE_WORKSPACE_FILE_TOOL: ToolDefinition = {
	type: "function",
	function: {
		name: "update_file",
		description: [
			"Update an existing file in the agent workspace.",
			"Use this to modify content of a previously created file.",
			"Creates a new version while preserving history.",
		].join(" "),
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Virtual file path to update",
				},
				content: {
					type: "string",
					description: "New file content",
				},
			},
			required: ["path", "content"],
		},
	},
};

/**
 * List files tool
 * Used by agents to list files in the workspace
 */
export const LIST_WORKSPACE_FILES_TOOL: ToolDefinition = {
	type: "function",
	function: {
		name: "list_files",
		description: [
			"List files in the agent workspace.",
			"Use this to explore the workspace and find existing files.",
		].join(" "),
		parameters: {
			type: "object",
			properties: {
				directory: {
					type: "string",
					description: "Directory path to list (default: root '/')",
				},
				fileType: {
					type: "string",
					enum: [
						"DOCUMENT",
						"CODE",
						"DATA",
						"CONFIG",
						"OUTPUT",
						"ARTIFACT",
					],
					description: "Optional filter by file type",
				},
			},
			required: [],
		},
	},
};

/**
 * Delete file tool
 * Used by agents to delete files from the workspace
 */
export const DELETE_WORKSPACE_FILE_TOOL: ToolDefinition = {
	type: "function",
	function: {
		name: "delete_file",
		description: [
			"Delete a file from the agent workspace.",
			"Use with caution - consider archiving instead if the file might be needed later.",
		].join(" "),
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Virtual file path to delete",
				},
			},
			required: ["path"],
		},
	},
};

/**
 * Get all workspace file management tools
 */
export function getWorkspaceTools(): ToolDefinition[] {
	return [
		CREATE_WORKSPACE_FILE_TOOL,
		READ_WORKSPACE_FILE_TOOL,
		UPDATE_WORKSPACE_FILE_TOOL,
		LIST_WORKSPACE_FILES_TOOL,
		DELETE_WORKSPACE_FILE_TOOL,
	];
}

// ============================================================================
// Chart Artifact Types & Tools (Data Analyst)
// ============================================================================

/**
 * Supported chart types
 */
export type ChartType = "line" | "bar" | "pie" | "area" | "scatter";

/**
 * Chart configuration matching Evidence ChartConfig
 */
export interface ChartArtifactConfig {
	xAxis: string;
	yAxis: string | string[];
	title?: string;
	series?: string;
	stacked?: boolean;
	showLegend?: boolean;
}

/**
 * Chart artifact returned by agents for UI rendering
 * This is the structured data format that frontends use to render charts
 */
export interface ChartArtifact {
	type: "chart";
	id: string;
	chartType: ChartType;
	data: Record<string, unknown>[];
	config: ChartArtifactConfig;
	metadata?: {
		createdAt?: string;
		sourceDescription?: string;
		dataPointCount?: number;
		totalValue?: number; // Sum of numeric values (for aggregate charts like pie/bar)
	};
}

/**
 * Create chart tool
 * Used by data analyst and other agents to generate chart artifacts
 * The tool validates data and returns a ChartArtifact JSON that UIs can render
 */
export const CREATE_CHART_TOOL: ToolDefinition = {
	type: "function",
	function: {
		name: "create_chart",
		description: [
			"Create a chart visualization from data.",
			"Use this tool when you need to visualize data as a chart.",
			"Supported chart types: line, bar, pie, area, scatter.",
			"The data array should contain objects with consistent keys matching xAxis and yAxis fields.",
			"Returns a chart artifact that the UI will render as an interactive chart.",
			"Example: create_chart({ chartType: 'bar', data: [{month: 'Jan', sales: 100}], config: {xAxis: 'month', yAxis: 'sales'} })",
		].join(" "),
		parameters: {
			type: "object",
			properties: {
				chartType: {
					type: "string",
					enum: ["line", "bar", "pie", "area", "scatter"],
					description:
						"Type of chart to create. Use 'line' for trends over time, 'bar' for comparisons, 'pie' for proportions, 'area' for cumulative data, 'scatter' for correlations.",
				},
				data: {
					type: "array",
					description:
						"Array of data objects. Each object should have keys matching the xAxis and yAxis fields.",
					items: {
						type: "object",
						additionalProperties: true,
					},
				},
				config: {
					type: "object",
					description: "Chart configuration",
					properties: {
						xAxis: {
							type: "string",
							description:
								"Field name in data to use for X axis (e.g., 'month', 'date', 'category')",
						},
						yAxis: {
							oneOf: [
								{ type: "string" },
								{ type: "array", items: { type: "string" } },
							],
							description:
								"Field name(s) in data to use for Y axis. Can be a single field or array for multi-series charts.",
						},
						title: {
							type: "string",
							description: "Chart title to display",
						},
						series: {
							type: "string",
							description:
								"Optional field name to split data into multiple series",
						},
						stacked: {
							type: "boolean",
							description:
								"For bar/area charts, whether to stack the series (default: false)",
						},
						showLegend: {
							type: "boolean",
							description:
								"Whether to show the legend (default: true)",
						},
					},
					required: ["xAxis", "yAxis"],
				},
				sourceDescription: {
					type: "string",
					description:
						"Optional description of where the data came from",
				},
			},
			required: ["chartType", "data", "config"],
			additionalProperties: false,
		},
	},
};

/**
 * Helper function to create a ChartArtifact from tool parameters
 * Used by agent implementations to generate the artifact
 */
export function createChartArtifact(params: {
	chartType: ChartType;
	data: Record<string, unknown>[];
	config: ChartArtifactConfig;
	sourceDescription?: string;
}): ChartArtifact {
	// Calculate total value from the y-axis fields
	const yAxisFields = Array.isArray(params.config.yAxis)
		? params.config.yAxis
		: [params.config.yAxis];

	let totalValue = 0;
	for (const row of params.data) {
		for (const field of yAxisFields) {
			const value = row[field];
			if (typeof value === "number") {
				totalValue += value;
			} else if (typeof value === "string") {
				const num = Number.parseFloat(value);
				if (!Number.isNaN(num)) {
					totalValue += num;
				}
			}
		}
	}

	return {
		type: "chart",
		id: `chart-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
		chartType: params.chartType,
		data: params.data,
		config: params.config,
		metadata: {
			createdAt: new Date().toISOString(),
			sourceDescription: params.sourceDescription,
			dataPointCount: params.data.length,
			totalValue: totalValue > 0 ? totalValue : undefined,
		},
	};
}

/**
 * Type guard to check if an object is a ChartArtifact
 */
export function isChartArtifact(obj: unknown): obj is ChartArtifact {
	if (!obj || typeof obj !== "object") {
		return false;
	}
	const artifact = obj as Record<string, unknown>;
	return (
		artifact.type === "chart" &&
		typeof artifact.id === "string" &&
		typeof artifact.chartType === "string" &&
		["line", "bar", "pie", "area", "scatter"].includes(
			artifact.chartType as string,
		) &&
		Array.isArray(artifact.data) &&
		artifact.config !== null &&
		typeof artifact.config === "object"
	);
}

/**
 * Get all data analysis tools (including charting)
 */
export function getDataAnalysisTools(): ToolDefinition[] {
	return [CREATE_CHART_TOOL];
}
