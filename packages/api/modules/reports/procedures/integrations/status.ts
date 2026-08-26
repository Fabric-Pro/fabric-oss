/**
 * Check Integration Status for Report Templates
 *
 * Returns the status of all integrations the user has configured:
 * - MCP Servers (GitHub, JIRA, Linear, Slack, etc.)
 * - Workspaces (document access for RAG)
 * - External services (Fabric AI, Evidence.dev)
 */

import { listMcpConfigsForTenant, listWorkspaces } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

const inputSchema = z.object({
	organizationId: z.string().nullable().optional(),
});

type Integration = {
	id: string;
	type: "mcp" | "workspace" | "external";
	key: string;
	name: string;
	status: "connected" | "disconnected" | "error" | "pending";
	configUrl?: string;
	metadata?: Record<string, unknown>;
};

export const getIntegrationStatus = tenantProtectedProcedure
	.use(requirePermission(Permissions.REPORT_READ))
	.input(inputSchema)
	.handler(async ({ input, context }) => {
		const { organizationId } = input;
		const userId = context.user.id;

		const integrations: Integration[] = [];
		const mcpServerKeys: string[] = [];

		// 1. Get MCP Configs (per-user-within-org pattern)
		const mcpConfigs = await listMcpConfigsForTenant({
			userId,
			organizationId: organizationId ?? undefined,
		});

		for (const config of mcpConfigs) {
			const server = config.mcpServer;
			const isConnected = config.enabled && config.status === "HEALTHY";

			mcpServerKeys.push(server.key);

			integrations.push({
				id: config.id,
				type: "mcp",
				key: server.key,
				name: config.displayName || server.name,
				status: isConnected
					? "connected"
					: config.status === "UNAVAILABLE" ||
							config.status === "DEGRADED"
						? "error"
						: "disconnected",
				configUrl: `/app/mcp-servers/${server.key}`,
				metadata: {
					serverId: server.id,
					serverKey: server.key,
					authType: config.authType,
					transport: config.transport || server.transport,
				},
			});
		}

		// 2. Get Workspaces
		const workspacesResult = await listWorkspaces({
			userId,
			organizationId: organizationId ?? undefined,
		});

		const workspaceList = workspacesResult.workspaces.map((ws) => ({
			id: ws.id,
			name: ws.name,
		}));

		for (const ws of workspacesResult.workspaces) {
			integrations.push({
				id: ws.id,
				type: "workspace",
				key: `workspace:${ws.id}`,
				name: ws.name,
				status: "connected",
				configUrl: `/app/workspaces/${ws.id}`,
				metadata: {
					documentCount: ws._count?.documents || 0,
				},
			});
		}

		// 3. Check External Services
		const externalServices: Record<string, boolean> = {
			fabricAi: !!process.env.FABRIC_AI_URL,
			evidenceDev: !!process.env.EVIDENCE_API_KEY,
		};

		if (externalServices.fabricAi) {
			integrations.push({
				id: "fabric-ai",
				type: "external",
				key: "fabric-ai",
				name: "Fabric AI",
				status: "connected",
				configUrl: "/app/settings/integrations",
				metadata: {
					url: process.env.FABRIC_AI_URL,
				},
			});
		}

		if (externalServices.evidenceDev) {
			integrations.push({
				id: "evidence-dev",
				type: "external",
				key: "evidence-dev",
				name: "Evidence.dev",
				status: "connected",
				configUrl: "/app/settings/integrations",
			});
		}

		return {
			integrations,
			mcpServers: mcpServerKeys,
			workspaces: workspaceList,
			externalServices,
		};
	});
