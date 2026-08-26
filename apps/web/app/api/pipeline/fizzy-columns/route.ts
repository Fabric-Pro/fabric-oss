import { closeMcpClient, createMcpClientForConfig } from "@repo/mcp";
import { getSession } from "@saas/auth/lib/server";
import { type NextRequest, NextResponse } from "next/server";

/**
 * Get Fizzy columns for a board using MCP config
 */
export async function POST(request: NextRequest) {
	let client:
		| Awaited<ReturnType<typeof createMcpClientForConfig>>["client"]
		| undefined;

	try {
		const session = await getSession();
		if (!session) {
			return NextResponse.json(
				{ error: "Unauthorized" },
				{ status: 401 },
			);
		}

		const { mcpConfigId, accountSlug, boardId, organizationId } =
			await request.json();

		if (!mcpConfigId) {
			return NextResponse.json(
				{ error: "MCP config ID is required" },
				{ status: 400 },
			);
		}

		if (!accountSlug) {
			return NextResponse.json(
				{ error: "Account slug is required" },
				{ status: 400 },
			);
		}

		if (!boardId) {
			return NextResponse.json(
				{ error: "Board ID is required" },
				{ status: 400 },
			);
		}

		// Create MCP client using the stored config (handles auth)
		// CRITICAL: Pass organizationId for proper tenant isolation
		// Include redirectUri for OAuth2 token refresh support
		const siteUrl =
			process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3001";
		const redirectUri = `${siteUrl}/api/mcp/oauth/callback`;

		const { client: mcpClient } = await createMcpClientForConfig({
			configId: mcpConfigId,
			userId: session.user.id,
			organizationId: organizationId ?? undefined,
			redirectUri,
		});
		client = mcpClient;

		// Get available tools
		const tools = await client.tools();

		// Execute fizzy_get_columns
		const columnsTool = tools.fizzy_get_columns;
		if (!columnsTool) {
			return NextResponse.json(
				{ error: "Fizzy get_columns tool not found" },
				{ status: 500 },
			);
		}

		const result = await columnsTool.execute(
			{ account_slug: accountSlug, board_id: boardId },
			{ toolCallId: `fizzy_columns-${Date.now()}`, messages: [] },
		);

		console.log(
			"[Fizzy API] Columns result:",
			JSON.stringify(result, null, 2),
		);

		// Parse MCP content format
		const rawColumns = parseMcpResult<Array<{ id: string; name: string }>>(
			result,
			[],
		);
		const columns = rawColumns.map((c: any) => ({
			id: c.id,
			name: c.name,
		}));

		return NextResponse.json({ columns });
	} catch (error) {
		console.error("[Fizzy API] Error fetching columns:", error);
		return NextResponse.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Failed to fetch columns",
			},
			{ status: 500 },
		);
	} finally {
		await closeMcpClient(client);
	}
}

/**
 * Parse MCP tool result - handles the content array format
 */
function parseMcpResult<T>(result: unknown, defaultValue: T): T {
	try {
		// MCP returns an array of content parts
		if (Array.isArray(result)) {
			const textContent = result.find((c: any) => c.type === "text");
			if (textContent && "text" in textContent) {
				const parsed = JSON.parse(textContent.text as string);
				return parsed as T;
			}
		}
		// Direct value
		if (result && typeof result === "object") {
			return result as T;
		}
		// String value
		if (typeof result === "string") {
			return JSON.parse(result) as T;
		}
	} catch (e) {
		console.error("[Fizzy API] Parse error:", e);
	}
	return defaultValue;
}
