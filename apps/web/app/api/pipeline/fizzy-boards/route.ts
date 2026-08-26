import { closeMcpClient, createMcpClientForConfig } from "@repo/mcp";
import { getSession } from "@saas/auth/lib/server";
import { type NextRequest, NextResponse } from "next/server";

/**
 * Get Fizzy boards for an account using MCP config
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

		const { mcpConfigId, accountSlug, organizationId } =
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

		// Execute fizzy_get_boards
		const boardsTool = tools.fizzy_get_boards;
		if (!boardsTool) {
			return NextResponse.json(
				{ error: "Fizzy get_boards tool not found" },
				{ status: 500 },
			);
		}

		const result = await boardsTool.execute(
			{ account_slug: accountSlug },
			{ toolCallId: `fizzy_boards-${Date.now()}`, messages: [] },
		);

		console.log(
			"[Fizzy Boards API] Raw result:",
			JSON.stringify(result, null, 2),
		);

		// Parse MCP content format
		const rawBoards = parseMcpResult<Array<{ id: string; name: string }>>(
			result,
			[],
		);
		console.log("[Fizzy Boards API] Parsed boards:", rawBoards);

		const boards = rawBoards.map((b: any) => ({
			id: b.id,
			name: b.name,
		}));

		console.log("[Fizzy Boards API] Final boards:", boards);
		return NextResponse.json({ boards });
	} catch (error) {
		console.error("[Fizzy Boards API] Error fetching boards:", error);
		// Include stack trace for debugging
		if (error instanceof Error) {
			console.error("[Fizzy Boards API] Stack:", error.stack);
		}
		return NextResponse.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Failed to fetch boards",
			},
			{ status: 500 },
		);
	} finally {
		await closeMcpClient(client);
	}
}

/**
 * Parse MCP tool result - handles the content array format
 * MCP SDK returns: { content: [{ type: "text", text: "..." }], isError: false }
 */
function parseMcpResult<T>(result: unknown, defaultValue: T): T {
	console.log(
		"[Fizzy API] parseMcpResult input:",
		typeof result,
		JSON.stringify(result, null, 2),
	);

	try {
		// Handle MCP SDK format: { content: [{ type: "text", text: "..." }], isError: false }
		if (result && typeof result === "object" && !Array.isArray(result)) {
			const obj = result as Record<string, unknown>;

			// Check for { content: [...] } wrapper format (MCP SDK response)
			if (Array.isArray(obj.content)) {
				console.log("[Fizzy API] Found content array wrapper");
				const textContent = obj.content.find(
					(c: any) => c.type === "text",
				);
				if (textContent && "text" in textContent) {
					console.log(
						"[Fizzy API] Found text content inside content array",
					);
					const parsed = JSON.parse(textContent.text as string);
					return parsed as T;
				}
			}

			// Direct object (not a content wrapper)
			return result as T;
		}

		// MCP returns an array of content parts directly
		if (Array.isArray(result)) {
			const textContent = result.find((c: any) => c.type === "text");
			if (textContent && "text" in textContent) {
				const parsed = JSON.parse(textContent.text as string);
				return parsed as T;
			}
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
