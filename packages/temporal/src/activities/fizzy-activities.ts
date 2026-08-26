/**
 * Fizzy MCP Activities
 *
 * @deprecated This file contains legacy Fizzy-specific activities.
 * New code should use the generic MCP activities instead:
 * - Use `pushTasksViaMcp` from `./mcp-activities.ts` for task creation
 * - Use the dynamic PM tool analyzer from `./pm-integration/tool-analyzer.ts`
 *
 * These functions are kept for backwards compatibility with existing workflows
 * that use the `issueTracker: "fizzy"` legacy configuration.
 *
 * @see ./mcp-activities.ts - Generic MCP activities (preferred)
 * @see ./pm-integration/tool-analyzer.ts - Dynamic PM tool capability detection
 * @see https://github.com/Fabric-Pro/fizzy-mcp
 */

import { isProjectReadOnly } from "@repo/database";
import { logger } from "@repo/logs";
import { closeMcpClient, createMcpClient, type McpClientType } from "@repo/mcp";
import { getAmbientProjectId } from "@repo/utils/project-context";
import { READ_ONLY_MODE_MESSAGE } from "@repo/utils/read-only-mode";

// Fizzy MCP endpoint
const FIZZY_MCP_URL =
	process.env.FIZZY_MCP_URL || "https://fizzy.fabric.pro/mcp";

/**
 * Fizzy Card (Task)
 */
export interface FizzyCard {
	id: string;
	title: string;
	description?: string;
	column_id?: string;
	due_on?: string;
	status?: string;
}

/**
 * Fizzy Board
 */
export interface FizzyBoard {
	id: string;
	name: string;
	columns?: Array<{
		id: string;
		name: string;
	}>;
}

/**
 * Create an MCP client for Fizzy using shared factory
 * Uses official MCP SDK transports for proper protocol handling
 */
async function createFizzyClient(accessToken: string): Promise<McpClientType> {
	return await createMcpClient({
		serverUrl: FIZZY_MCP_URL,
		transport: "HTTP", // Fizzy uses Streamable HTTP transport
		headers: {
			Authorization: `Bearer ${accessToken}`,
		},
	});
}

/**
 * Execute a Fizzy MCP tool
 */
async function executeFizzyTool<T>(
	accessToken: string,
	toolName: string,
	args: Record<string, unknown>,
): Promise<T> {
	let client: McpClientType | undefined;

	try {
		client = await createFizzyClient(accessToken);
		const tools = await client.tools();

		const tool = tools[toolName];
		if (!tool) {
			const availableTools = Object.keys(tools).join(", ");
			throw new Error(
				`Tool "${toolName}" not found. Available: ${availableTools}`,
			);
		}

		// Log the tool name + the ARG KEYS only — never the arg VALUES, which carry
		// card title/description (business content) that must not land in logs
		// (SOC 2: keep logs metadata-only, like the audit-log redactor).
		logger.info("[Fizzy MCP] Executing tool", {
			toolName,
			argKeys: args && typeof args === "object" ? Object.keys(args) : [],
		});

		const result = await tool.execute(args, {
			toolCallId: `${toolName}-${Date.now()}`,
			messages: [],
		});

		// Parse the result - MCP returns content array
		if (Array.isArray(result)) {
			const textContent = result.find(
				(c: { type: string }) => c.type === "text",
			);
			if (textContent && "text" in textContent) {
				try {
					return JSON.parse(textContent.text as string) as T;
				} catch {
					return textContent.text as T;
				}
			}
		}

		return result as T;
	} finally {
		// Use shared close helper for proper cleanup
		await closeMcpClient(client);
	}
}

/**
 * Get Fizzy identity (current user info)
 */
export async function getFizzyIdentity(params: {
	accessToken: string;
}): Promise<{ accounts: Array<{ slug: string; name: string }> }> {
	return await executeFizzyTool(params.accessToken, "fizzy_get_identity", {});
}

/**
 * Get all boards in a Fizzy account
 */
export async function getFizzyBoards(params: {
	accessToken: string;
	accountSlug: string;
}): Promise<FizzyBoard[]> {
	return await executeFizzyTool(params.accessToken, "fizzy_get_boards", {
		account_slug: params.accountSlug,
	});
}

/**
 * Get columns for a Fizzy board
 */
export async function getFizzyColumns(params: {
	accessToken: string;
	accountSlug: string;
	boardId: string;
}): Promise<Array<{ id: string; name: string; color?: string }>> {
	return await executeFizzyTool(params.accessToken, "fizzy_get_columns", {
		account_slug: params.accountSlug,
		board_id: params.boardId,
	});
}

/**
 * Create a card (task) in Fizzy
 */
export async function createFizzyCard(params: {
	accessToken: string;
	accountSlug: string;
	boardId: string;
	title: string;
	description?: string;
	columnId?: string;
	dueOn?: string;
	status?: "draft" | "published";
}): Promise<FizzyCard> {
	const result = await executeFizzyTool<FizzyCard>(
		params.accessToken,
		"fizzy_create_card",
		{
			account_slug: params.accountSlug,
			board_id: params.boardId,
			title: params.title,
			description: params.description,
			column_id: params.columnId,
			due_on: params.dueOn,
			status: params.status || "published",
		},
	);

	// Metadata only — do NOT log the card title or the full result body (both
	// carry business content). The column id is enough to confirm creation.
	logger.info("[Fizzy MCP] Card created", { columnId: params.columnId });

	return result;
}

/**
 * Create a column in Fizzy
 */
export async function createFizzyColumn(params: {
	accessToken: string;
	accountSlug: string;
	boardId: string;
	name: string;
	color?:
		| "blue"
		| "gray"
		| "tan"
		| "yellow"
		| "lime"
		| "aqua"
		| "violet"
		| "purple"
		| "pink";
}): Promise<{ id: string; name: string }> {
	return await executeFizzyTool(params.accessToken, "fizzy_create_column", {
		account_slug: params.accountSlug,
		board_id: params.boardId,
		name: params.name,
		color: params.color || "blue",
	});
}

/**
 * Create a board in Fizzy
 */
export async function createFizzyBoard(params: {
	accessToken: string;
	accountSlug: string;
	name: string;
}): Promise<FizzyBoard> {
	return await executeFizzyTool(params.accessToken, "fizzy_create_board", {
		account_slug: params.accountSlug,
		name: params.name,
	});
}

/**
 * Parse tasks from markdown and create them in Fizzy
 *
 * This activity takes a markdown document with tasks and creates
 * corresponding cards in Fizzy.
 */
export async function pushTasksToFizzy(params: {
	accessToken: string;
	accountSlug: string;
	boardId: string;
	tasksMarkdown: string;
	columnId?: string;
	createMissingColumns?: boolean;
	/** Owning Fabric project — enables the Read-only mode skip. */
	projectId?: string;
}): Promise<{
	success: boolean;
	cardsCreated: number;
	cards: FizzyCard[];
	errors: string[];
}> {
	const { accessToken, accountSlug, boardId, tasksMarkdown, columnId } =
		params;
	const cards: FizzyCard[] = [];
	const errors: string[] = [];

	// Read-only mode: this legacy path only creates cards in Fizzy, so a
	// read-only project skips the whole push before any external dispatch —
	// same contract as the live pushTasksViaMcp branch (post-ship review
	// finding: this path had no gate). Ambient fallback covers callers that
	// don't thread projectId.
	const readOnlyProjectId = params.projectId ?? getAmbientProjectId();
	if (readOnlyProjectId && (await isProjectReadOnly(readOnlyProjectId))) {
		logger.info("[Fizzy MCP] Push skipped — project is in Read-only mode", {
			projectId: readOnlyProjectId,
		});
		return {
			success: false,
			cardsCreated: 0,
			cards: [],
			errors: [READ_ONLY_MODE_MESSAGE],
		};
	}

	logger.info("[Fizzy MCP] Parsing and pushing tasks", {
		accountSlug,
		boardId,
		markdownLength: tasksMarkdown.length,
	});

	// Parse tasks from markdown
	const tasks = parseTasksFromMarkdown(tasksMarkdown);

	logger.info("[Fizzy MCP] Found tasks to create", { count: tasks.length });

	// Create cards for each task
	for (const task of tasks) {
		try {
			const card = await createFizzyCard({
				accessToken,
				accountSlug,
				boardId,
				title: task.title.slice(0, 200),
				description: task.description?.slice(0, 5000),
				columnId,
				status: "published",
			});
			cards.push(card);

			// Small delay to avoid rate limiting
			await new Promise((resolve) => setTimeout(resolve, 100));
		} catch (error) {
			const errorMsg =
				error instanceof Error ? error.message : "Unknown error";
			errors.push(`Failed to create card "${task.title}": ${errorMsg}`);
			logger.error("[Fizzy MCP] Failed to create card", {
				titleLength: task.title?.length ?? 0,
				error: errorMsg,
			});
		}
	}

	logger.info("[Fizzy MCP] Tasks pushed to Fizzy", {
		cardsCreated: cards.length,
		errors: errors.length,
	});

	return {
		success: errors.length === 0,
		cardsCreated: cards.length,
		cards,
		errors,
	};
}

/**
 * Parse tasks from markdown content
 */
function parseTasksFromMarkdown(
	markdown: string,
): Array<{ title: string; description?: string }> {
	const tasks: Array<{ title: string; description?: string }> = [];
	const lines = markdown.split("\n");
	let currentTask: { title: string; description: string } | null = null;

	for (const line of lines) {
		// Pattern 1: ### TASK-N: Title
		const taskMatch = line.match(/^###\s*TASK-?\d*:?\s*(.+)/);
		if (taskMatch) {
			if (currentTask) {
				tasks.push(currentTask);
			}
			currentTask = {
				title: taskMatch[1].trim(),
				description: "",
			};
			continue;
		}

		// Pattern 2: - [ ] Task description (checkbox)
		const checkboxMatch = line.match(/^-\s*\[\s*\]\s*(.+)/);
		if (checkboxMatch) {
			if (currentTask) {
				tasks.push(currentTask);
			}
			tasks.push({
				title: checkboxMatch[1].trim(),
			});
			currentTask = null;
			continue;
		}

		// Add to current task description
		if (currentTask && line.trim()) {
			currentTask.description += `${line}\n`;
		}
	}

	// Don't forget the last task
	if (currentTask) {
		tasks.push(currentTask);
	}

	// Fallback: if no tasks found, try bullet points
	if (tasks.length === 0) {
		const bulletPattern = /^[-*]\s+(.+)$/gm;
		let bulletMatch: RegExpExecArray | null = bulletPattern.exec(markdown);
		while (bulletMatch !== null) {
			const title = bulletMatch[1].trim();
			if (
				!title.startsWith("**") &&
				title.length > 5 &&
				title.length < 200
			) {
				tasks.push({ title });
			}
			bulletMatch = bulletPattern.exec(markdown);
		}
	}

	return tasks;
}
