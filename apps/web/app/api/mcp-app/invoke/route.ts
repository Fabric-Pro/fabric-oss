/**
 * MCP App tool-invoke proxy.
 *
 * The AI Feature Assistant (StoryWorkspace) and AI Document Assistant
 * (DocumentEditor) bind to the `project_document_generator` LangGraph
 * agent via `useCoAgent`. CopilotKit's AG-UI protocol forwards only
 * **frontend** `useCopilotAction` registrations to that external agent —
 * backend `actions` registered on `CopilotRuntime` flow only to the
 * built-in agent path. So MCP tools have to be surfaced as frontend
 * `useCopilotAction`s whose handler proxies the call to the MCP server.
 *
 * This route is that proxy. The frontend hook
 * `useDefaultMcpFrontendActions` (apps/web/modules/saas/agents/hooks/
 * useDefaultMcpInlineRender.tsx) hits this endpoint from its
 * `useCopilotAction` handlers.
 *
 * Why a per-tenant proxy (not a generic /mcp/exec endpoint):
 *   - The tool's `configId` is tenant-scoped — we authenticate the user
 *     and verify they own (or are an org member of) that MCPConfig.
 *   - The MCP server may need OAuth tokens / API keys that live on the
 *     MCPConfig row; `createMcpClientForConfig` handles the lookup +
 *     decryption.
 *   - Results carry a `__fabricMcpRender` envelope so the chat's
 *     wildcard `useCopilotAction({ name: "*", render })` can pick out
 *     the `resourceUri` / `configId` / `checkpointId` and render
 *     `<McpAppFrame>` inline. Same envelope shape PR #892's helper used,
 *     so the frontend renderer is unchanged.
 */

import { auth } from "@repo/auth";
import { db } from "@repo/database";
import { callMcpTool, createMcpClientForConfig } from "@repo/mcp";
import { isReadOnlyBlockedOutput } from "@repo/utils";
import { headers } from "next/headers";
import type { NextRequest } from "next/server";

/**
 * Mirrors the key written into the JSON-stringified tool result by
 * `apps/web/app/api/copilotkit/default-mcp-tools.ts`. Frontend
 * `useDefaultMcpInlineRender` reads this exact key — keep them in
 * lockstep.
 */
const FABRIC_MCP_RENDER_KEY = "__fabricMcpRender";

interface InvokeBody {
	configId: string;
	toolName: string;
	args?: Record<string, unknown>;
	/**
	 * Owning project id — enables the Read-only mode write-gate.
	 * This route is a documented leak class otherwise: it carries no project
	 * context, so a write tool (e.g. an AI-driven `create_view` diagram) would
	 * reach the external source even while the project is read-only.
	 */
	projectId?: string;
}

/**
 * Extract `checkpointId` from a CallToolResult — mirrors the logic in
 * `apps/web/app/api/copilotkit/default-mcp-tools.ts` and
 * `apps/web/components/ai-elements/McpAppFrame.tsx` so the chat
 * renderer and editor embed agree on the lookup.
 */
function extractCheckpointId(result: unknown): string | null {
	if (!result || typeof result !== "object") {
		return null;
	}
	const r = result as Record<string, unknown>;
	if (typeof r.checkpointId === "string") {
		return r.checkpointId;
	}
	if (typeof r.checkpoint_id === "string") {
		return r.checkpoint_id as string;
	}
	const sc = r.structuredContent;
	if (sc && typeof sc === "object") {
		const o = sc as Record<string, unknown>;
		if (typeof o.checkpointId === "string") {
			return o.checkpointId;
		}
		if (typeof o.checkpoint_id === "string") {
			return o.checkpoint_id as string;
		}
	}
	const content = r.content;
	if (Array.isArray(content)) {
		for (const block of content) {
			const text =
				typeof block === "object" && block !== null && "text" in block
					? (block as { text: unknown }).text
					: null;
			if (typeof text === "string") {
				const m = text.match(
					/checkpoint[_\s-]?id[:\s"]+([a-zA-Z0-9_-]+)/i,
				);
				if (m?.[1]) {
					return m[1];
				}
			}
		}
	}
	return null;
}

export async function POST(req: NextRequest) {
	const headersList = await headers();
	const session = await auth.api.getSession({ headers: headersList });
	if (!session?.user) {
		return new Response(JSON.stringify({ error: "Unauthorized" }), {
			status: 401,
			headers: { "Content-Type": "application/json" },
		});
	}

	let body: InvokeBody;
	try {
		body = (await req.json()) as InvokeBody;
	} catch {
		return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
			status: 400,
			headers: { "Content-Type": "application/json" },
		});
	}

	if (!body.configId || !body.toolName) {
		return new Response(
			JSON.stringify({ error: "configId and toolName are required" }),
			{ status: 400, headers: { "Content-Type": "application/json" } },
		);
	}

	// Tenant-scoped existence check. `createMcpClientForConfig` ALSO
	// does this internally, but pre-validating gives a clearer 404 vs
	// the generic MCP error.
	const config = await db.mCPConfig.findFirst({
		where: {
			id: body.configId,
			userId: session.user.id,
		},
		select: {
			id: true,
			organizationId: true,
			mcpServer: { select: { key: true } },
		},
	});
	if (!config) {
		return new Response(
			JSON.stringify({
				error: "MCP config not found or not accessible",
			}),
			{ status: 404, headers: { "Content-Type": "application/json" } },
		);
	}

	try {
		const { client, serverUrl } = await createMcpClientForConfig({
			configId: body.configId,
			userId: session.user.id,
			organizationId: config.organizationId ?? undefined,
		});

		const aiSdkTools = await client.tools();
		// `@ai-sdk/mcp`'s `execute` expects (input, options) — we only
		// pass input, so cast through unknown.
		const tool = aiSdkTools[body.toolName] as unknown as
			| {
					execute: (params: unknown) => Promise<unknown>;
					_meta?: { ui?: { resourceUri?: string } };
			  }
			| undefined;

		if (!tool) {
			return new Response(
				JSON.stringify({
					error: `MCP tool "${body.toolName}" not found on server`,
					serverUrl,
				}),
				{
					status: 404,
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		// Route through the shared external-dispatch funnel: a write-classified
		// tool is blocked here when the project is read-only,
		// before it reaches the MCP server.
		const result = await callMcpTool({
			toolName: body.toolName,
			projectId: body.projectId,
			execute: () => tool.execute(body.args ?? {}),
		});

		if (isReadOnlyBlockedOutput(result)) {
			// Hand the block straight back as the tool response text so the
			// assistant relays "the project is in Read-only mode".
			return new Response(JSON.stringify({ result }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}

		const resourceUri = tool._meta?.ui?.resourceUri;

		if (!resourceUri) {
			// Tool result with no renderable UI resource — return raw.
			// The frontend handler will hand this to the LLM as the
			// tool response text.
			return new Response(JSON.stringify({ result }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}

		const checkpointId = extractCheckpointId(result);
		const base =
			result && typeof result === "object"
				? (result as Record<string, unknown>)
				: { text: String(result ?? "") };
		const enriched = {
			...base,
			[FABRIC_MCP_RENDER_KEY]: {
				resourceUri,
				configId: body.configId,
				checkpointId,
				toolArgs: body.args,
			},
		};
		return new Response(JSON.stringify({ result: enriched }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	} catch (err) {
		console.error(
			"[/api/mcp-app/invoke] Tool execution failed:",
			{ configId: body.configId, toolName: body.toolName },
			err,
		);
		return new Response(
			JSON.stringify({
				error: err instanceof Error ? err.message : String(err),
			}),
			{ status: 500, headers: { "Content-Type": "application/json" } },
		);
	}
}
