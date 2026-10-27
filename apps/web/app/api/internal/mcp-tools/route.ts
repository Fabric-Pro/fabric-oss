/** Fabric owns MCP connections; the data analyst receives read-only tool definitions and results. */
import {
	closeMcpClientSafe,
	getEnabledMcpConfigs,
	getMcpClientResult,
	getMcpConfigsNeedingReauth,
} from "@repo/agent-core/backend";
import { AI_TOKEN_HEADER, verifyAIToken } from "@repo/ai-token";
import { MCPClientError, McpClientError, type McpClientType } from "@repo/mcp";
import { readMcpToolAnnotations } from "@repo/utils/mcp-tool-annotations";
import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";

const requestSchema = z.discriminatedUnion("operation", [
	z.object({ operation: z.literal("list") }),
	z.object({
		operation: z.literal("call"),
		configId: z.string().min(1),
		toolName: z.string().min(1),
		arguments: z.record(z.string(), z.unknown()),
	}),
]);

async function listReadOnlyTools(client: McpClientType, serverName: string) {
	let page = await client.listTools();
	const tools = [...page.tools];
	const seenCursors = new Set<string>();
	let pages = 1;
	while (page.nextCursor != null) {
		if (pages >= 100 || seenCursors.has(page.nextCursor)) {
			console.warn("[Internal MCP Tools] Tool pagination limit reached", {
				stage: "list-tools",
				serverName,
				code: pages >= 100 ? "PAGE_LIMIT" : "REPEATED_CURSOR",
			});
			break;
		}
		const cursor = page.nextCursor;
		seenCursors.add(cursor);
		page = await client.listTools({ params: { cursor } });
		pages++;
		tools.push(...page.tools);
	}
	// The read-only hint is declared by the MCP server, matching the gateway trust boundary.
	return tools.filter(
		(tool) =>
			readMcpToolAnnotations(tool.annotations)?.readOnlyHint === true,
	);
}

type FailureStage = "list-configs" | "list-tools" | "call-tool";

function errorCode(error: unknown): string {
	return error instanceof McpClientError
		? error.code
		: error instanceof Error
			? error.name
			: "UnknownError";
}

function sdkErrorFields(error: unknown) {
	if (!MCPClientError.isInstance(error)) {
		return {};
	}
	return {
		...(typeof error.code === "number" ? { rpcCode: error.code } : {}),
		...(typeof error.statusCode === "number"
			? { httpStatus: error.statusCode }
			: {}),
	};
}

function clientFailure(code: string) {
	let status = 502;
	let error = "Unable to connect to MCP server";
	if (code === "CONFIG_NOT_FOUND") {
		status = 404;
		error = "MCP configuration not found";
	} else if (
		code === "MCP_PERMISSION_DENIED" ||
		code === "ORGANIZATION_MEMBERSHIP_REQUIRED"
	) {
		status = 403;
		error = "MCP server access denied";
	} else if (
		[
			"OAUTH_AUTH_REQUIRED",
			"CONFIG_DISABLED",
			"AUTH_FAILED",
			"API_KEY_MISSING",
			"OAUTH_ERROR",
			"INVALID_TWILIO_CREDENTIALS",
		].includes(code)
	) {
		status = 409;
		error = "The user must reconnect the server in Fabric";
	} else if (code === "RATE_LIMIT") {
		status = 429;
		error = "MCP server rate limit reached; try again later";
	}
	return NextResponse.json({ error, code }, { status });
}

export async function POST(req: Request) {
	let stage: FailureStage = "list-configs";
	let serverName: string | undefined;
	try {
		const token = req.headers.get(AI_TOKEN_HEADER);
		if (!token) {
			return NextResponse.json(
				{ error: "Authentication required" },
				{ status: 401 },
			);
		}
		const payload = await verifyAIToken(token);
		if (!payload?.valid) {
			return NextResponse.json(
				{ error: "Invalid AI token" },
				{ status: 401 },
			);
		}
		const userId = payload.claims.sub;
		const organizationId = payload.claims.org;
		if (!organizationId) {
			return NextResponse.json(
				{ error: "Organization required" },
				{ status: 403 },
			);
		}
		// Zod strips unrecognized fields, including body-supplied identity.
		const parsed = requestSchema.safeParse(
			await req.json().catch(() => null),
		);
		if (!parsed.success) {
			return NextResponse.json(
				{ error: "Invalid request" },
				{ status: 400 },
			);
		}
		const body = parsed.data;
		if (body.operation === "list") {
			const configs = await getEnabledMcpConfigs({
				userId,
				organizationId,
			});
			const servers = [];
			const reauthConfigs = await getMcpConfigsNeedingReauth({
				userId,
				organizationId,
			});
			const unavailable: Array<{ name: string; code: string }> =
				reauthConfigs.map((config) => ({
					name:
						config.displayName ||
						config.mcpServer?.name ||
						"MCP Server",
					code: "OAUTH_AUTH_REQUIRED",
				}));
			for (const config of configs) {
				const name =
					config.displayName ||
					config.mcpServer?.name ||
					"MCP Server";
				let client: McpClientType | undefined;
				try {
					const connection = await getMcpClientResult(
						config.id,
						userId,
						organizationId,
						{ access: "connect" },
					);
					if (!connection.ok) {
						console.warn("[Internal MCP Tools] Request failed", {
							stage: "list-tools",
							serverName: name,
							code: connection.error.code,
						});
						unavailable.push({ name, code: connection.error.code });
						continue;
					}
					client = connection.client;
					const tools = await listReadOnlyTools(client, name);
					servers.push({
						configId: config.id,
						name,
						serverName: connection.serverName,
						tools,
					});
				} catch (error) {
					unavailable.push({ name, code: errorCode(error) });
					console.warn("[Internal MCP Tools] Request failed", {
						stage: "list-tools",
						serverName: name,
						code: errorCode(error),
						...sdkErrorFields(error),
					});
				} finally {
					if (client) {
						await closeMcpClientSafe(client);
					}
				}
			}
			return NextResponse.json({ servers, unavailable });
		}
		stage = "call-tool";
		const connection = await getMcpClientResult(
			body.configId,
			userId,
			organizationId,
			{ access: "connect" },
		);
		if (!connection.ok) {
			console.warn("[Internal MCP Tools] Request failed", {
				stage,
				...(connection.error.serverName
					? { serverName: connection.error.serverName }
					: {}),
				code: connection.error.code,
			});
			return clientFailure(connection.error.code);
		}
		serverName = connection.serverName;
		try {
			stage = "list-tools";
			const tools = await listReadOnlyTools(
				connection.client,
				connection.serverName,
			);
			if (!tools.some((tool) => tool.name === body.toolName)) {
				return NextResponse.json(
					{ error: "Tool is not available for read-only access" },
					{ status: 403 },
				);
			}
			stage = "call-tool";
			const result = await connection.client.callTool({
				name: body.toolName,
				arguments: body.arguments,
			});
			return NextResponse.json({ result });
		} finally {
			await closeMcpClientSafe(connection.client);
		}
	} catch (error) {
		console.error("[Internal MCP Tools] Request failed", {
			stage,
			...(serverName ? { serverName } : {}),
			code: errorCode(error),
			...sdkErrorFields(error),
		});
		if (
			stage === "call-tool" &&
			((MCPClientError.isInstance(error) &&
				typeof error.code === "number") ||
				(error instanceof McpClientError &&
					error.code === "MCP_CALL_FAILED"))
		) {
			return NextResponse.json(
				{
					error: "Tool call failed",
					code: "TOOL_ERROR",
					message: error.message.slice(0, 500),
				},
				{ status: 422 },
			);
		}
		return NextResponse.json(
			{
				error: "Unable to process MCP tools request",
				code: "INTERNAL_ERROR",
			},
			{ status: 500 },
		);
	}
}
