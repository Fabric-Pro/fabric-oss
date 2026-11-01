import { ORPCError } from "@orpc/client";
import {
	createRemoteAgentServer,
	db,
	disableRemoteAgentServer,
	listRemoteAgentServers,
} from "@repo/database";
import { isFabricAgentsBridgeEnabled } from "@repo/temporal/coding-execution-rollout";
import { agentEndpointRefusal } from "@repo/utils/agent-endpoint";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { requireOrgMembership } from "../../organizations/lib/membership";
import { requireRemoteServerAccess } from "../lib/remote-server-access";

const projectInput = z.object({
	projectId: z.string(),
	organizationId: z.string().nullable().optional(),
});
const base = tenantProtectedProcedure.use(
	requireProjectPermission(Permissions.AGENT_EXECUTE),
);

async function projectOrganization(projectId: string) {
	const project = await db.project.findUnique({
		where: { id: projectId },
		select: { organizationId: true },
	});
	if (!project?.organizationId) {
		throw new ORPCError("NOT_FOUND", {
			message: "Organization project not found",
		});
	}
	return project.organizationId;
}

export const listRemoteServersProcedure = base
	.route({
		method: "GET",
		path: "/coding-runs/remote-servers",
		tags: ["CodingRuns"],
	})
	.input(projectInput)
	.handler(async ({ input, context }) => {
		if (!isFabricAgentsBridgeEnabled()) {
			return { enabled: false, canShare: false, servers: [] };
		}
		const organizationId = await projectOrganization(input.projectId);
		const admin = await requireOrgMembership(
			context.user.id,
			organizationId,
			["owner", "admin"],
		);
		return {
			enabled: isFabricAgentsBridgeEnabled(),
			canShare: !!admin,
			servers: (
				await listRemoteAgentServers(input.projectId, context.user.id)
			).map(({ userId, ...row }) => ({
				...row,
				ownedByCaller: userId === context.user.id,
			})),
		};
	});

export const connectRemoteServerProcedure = base
	.route({
		method: "POST",
		path: "/coding-runs/remote-servers",
		tags: ["CodingRuns"],
	})
	.input(
		projectInput.extend({
			name: z.string().trim().min(1).max(80),
			scope: z.enum(["PRIVATE", "TEAM"]),
			url: z.string().url().max(500),
			secret: z.string().min(32).max(4096),
		}),
	)
	.handler(async ({ input, context }) => {
		if (!isFabricAgentsBridgeEnabled()) {
			throw new ORPCError("PRECONDITION_FAILED", {
				message:
					"Fabric remote execution is not enabled on this deployment.",
			});
		}
		const organizationId = await projectOrganization(input.projectId);
		if (
			input.scope === "TEAM" &&
			!(await requireOrgMembership(context.user.id, organizationId, [
				"owner",
				"admin",
			]))
		) {
			throw new ORPCError("FORBIDDEN", {
				message:
					"An organization administrator must connect a team server.",
			});
		}
		const url = new URL(input.url);
		const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
			url.hostname,
		);
		if (
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			url.pathname !== "/" ||
			(url.protocol !== "https:" &&
				!(
					url.protocol === "http:" &&
					loopback &&
					process.env.NODE_ENV !== "production"
				)) ||
			agentEndpointRefusal(url.href)
		) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Use a trusted HTTPS server origin. Private networks must be allowed by the deployment administrator.",
			});
		}
		const normalized = url.origin;
		const { FabricBackgroundAdapter } = await import(
			"@repo/temporal/coding-execution"
		);
		let profileId: string;
		try {
			const result = await new FabricBackgroundAdapter(undefined, {
				url: normalized,
				secret: input.secret,
			}).executionReadiness();
			profileId = result.profileId;
		} catch {
			throw new ORPCError("SERVICE_UNAVAILABLE", {
				message:
					"Could not verify this server. Check its URL, service secret, protocol version, and network access.",
			});
		}
		const server = await createRemoteAgentServer({
			projectId: input.projectId,
			userId: context.user.id,
			name: input.name,
			scope: input.scope,
			url: normalized,
			profileId,
			secret: input.secret,
		});
		recordAuditFromRequest(context, {
			action: "project.updated",
			category: "project",
			organizationId,
			projectId: input.projectId,
			resource: { type: "project", id: input.projectId },
			metadata: {
				operation: "remote_server_connected",
				connectionId: server.id,
				scope: server.scope,
			},
		});
		const { userId: _owner, ...publicServer } = server;
		return publicServer;
	});

export const disconnectRemoteServerProcedure = base
	.route({
		method: "POST",
		path: "/coding-runs/remote-servers/{id}/disconnect",
		tags: ["CodingRuns"],
	})
	.input(projectInput.extend({ id: z.string() }))
	.handler(async ({ input, context }) => {
		const server = await requireRemoteServerAccess({
			...input,
			userId: context.user.id,
		});
		const organizationId = await projectOrganization(input.projectId);
		if (
			server.scope === "TEAM" &&
			!(await requireOrgMembership(context.user.id, organizationId, [
				"owner",
				"admin",
			]))
		) {
			throw new ORPCError("FORBIDDEN");
		}
		await disableRemoteAgentServer(input.id, input.projectId);
		recordAuditFromRequest(context, {
			action: "project.updated",
			category: "project",
			organizationId,
			projectId: input.projectId,
			resource: { type: "project", id: input.projectId },
			metadata: {
				operation: "remote_server_disconnected",
				connectionId: input.id,
			},
		});
		return { disconnected: true };
	});
