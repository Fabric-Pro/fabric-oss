import { ORPCError } from "@orpc/client";
import {
	db,
	isPmServerIdKeySentinel,
	readPmServerIdKeySentinel,
	resolvePMConfigForUser,
} from "@repo/database";
import { GITLAB_REST_CAPABILITIES } from "@repo/integrations/gitlab";
import { pmServerKeyToDetectedType } from "@repo/utils";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { readPmStringContext } from "../../../lib/pm-additional-context";

export const getPMCapabilitiesProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/pm-capabilities",
		tags: ["Projects", "Stories", "Sync"],
		summary: "Get PM tool capabilities",
		description: "Get the sync capabilities of the configured PM tool",
	})
	.input(
		z.object({
			projectId: z.string(),
		}),
	)
	.output(
		z.object({
			configured: z.boolean(),
			capabilities: z
				.object({
					hasPMCapabilities: z.boolean(),
					canCreate: z.boolean(),
					canUpdate: z.boolean(),
					canGet: z.boolean(),
					canList: z.boolean(),
					supportsPush: z.boolean(),
					supportsPull: z.boolean(),
					supportsTaskSync: z.boolean(),
				})
				.nullable(),
			containerName: z.string().nullable(),
			detectedType: z.string().nullable(),
			/** PM config details needed by apply-changes workflow */
			mcpConfigId: z.string().nullable(),
			containerId: z.string().nullable(),
			additionalContext: z.record(z.string(), z.string()).nullable(),
			error: z.string().nullable(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;

		// Get project with PM settings
		// IMPORTANT: We need the project's organizationId to determine the correct context
		// for MCP config lookup - NOT the session's activeOrganizationId
		const project = await db.project.findUnique({
			where: { id: input.projectId },
			select: {
				id: true,
				organizationId: true, // Required for tenant isolation
				projectManagementMcpServerId: true,
				projectManagementMcpConfigId: true,
				projectManagementContainerId: true,
				projectManagementContainerName: true,
				projectManagementAdditionalContext: true,
			},
		});

		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found",
			});
		}

		// Resolve the project's PM **server key** once (sentinel → read inline,
		// catalog id → single DB lookup), memoized so at most one query runs and
		// only when a branch actually needs it. Used both for the GitLab-REST
		// routing decision below AND — via `storedDetectedType` — as a fallback
		// source for the response's `detectedType` so the connected tool's name
		// still surfaces in the UI (roadmap label, AI-Update/proposal "Also sync
		// to {tool}" checkbox) when the calling user has no resolvable MCP
		// connection (e.g. a teammate set the integration up). `detectedType` is
		// display-only — `capabilities`/`error`/`configured` still drive every
		// health check — so deriving it from stored config never masks a
		// degraded connection.
		let serverKeyResolved = false;
		let serverKeyCache: string | null = null;
		const getProjectServerKey = async (): Promise<string | null> => {
			if (serverKeyResolved) {
				return serverKeyCache;
			}
			serverKeyResolved = true;
			const sid = project.projectManagementMcpServerId;
			if (sid) {
				if (isPmServerIdKeySentinel(sid)) {
					serverKeyCache = readPmServerIdKeySentinel(sid);
				} else {
					const server = await db.mCPServer.findUnique({
						where: { id: sid },
						select: { key: true },
					});
					serverKeyCache = server?.key ?? null;
				}
			}
			return serverKeyCache;
		};
		const storedDetectedType = async (): Promise<string | null> =>
			pmServerKeyToDetectedType(await getProjectServerKey()) ?? null;

		// Project has MCP config but no board/container selected — user must pick one in Settings
		if (
			(project.projectManagementMcpConfigId ||
				project.projectManagementMcpServerId) &&
			!project.projectManagementContainerId
		) {
			return {
				configured: true,
				capabilities: null,
				containerName: null,
				detectedType: await storedDetectedType(),
				mcpConfigId: project.projectManagementMcpConfigId ?? null,
				containerId: null,
				additionalContext: null,
				error: "Select a board in Project Settings to sync stories with your PM tool.",
			};
		}

		// Resolve the CALLING USER's MCP config — prefers configId, falls back to serverId
		const userMcpConfig = await resolvePMConfigForUser({
			configId: project.projectManagementMcpConfigId,
			mcpServerId: project.projectManagementMcpServerId,
			userId: user.id,
			organizationId: project.organizationId || undefined,
		});

		// Parse additional context from JSON. String-valued entries only — the
		// column also carries the structured `fieldMapping` settings, which this
		// procedure publishes as a flat string map.
		const additionalContext = readPmStringContext(
			project.projectManagementAdditionalContext,
		);

		if (
			!userMcpConfig &&
			!project.projectManagementMcpServerId &&
			!project.projectManagementMcpConfigId
		) {
			return {
				configured: false,
				capabilities: null,
				containerName: null,
				detectedType: null,
				mcpConfigId: null,
				containerId: null,
				additionalContext: null,
				error: null,
			};
		}

		// REST-GitLab fallback: project's server is `gitlab-official` AND the
		// tenant has an active WorkflowIntegration, but the calling user has no
		// resolvable MCPConfig — either because the tier probe found the GitLab
		// instance isn't MCP-capable (fresh REST projects) or because an older
		// project still carries a stale `projectManagementMcpConfigId` from when
		// GitLab went through MCP. Both must reach REST, so this is gated on
		// `!userMcpConfig` alone, not on the absence of a stored config id.
		// PM runtime dispatches through callMcpWithRestFallback transparently.
		if (!userMcpConfig && project.projectManagementMcpServerId) {
			// Reuse the memoized resolver (sentinel → inline, catalog id → DB).
			const serverKey = await getProjectServerKey();
			if (serverKey === "gitlab-official") {
				const tenantFilter = project.organizationId
					? {
							organizationId: project.organizationId,
							userId: user.id,
						}
					: { organizationId: null, userId: user.id };
				const integration = await db.workflowIntegration.findFirst({
					where: {
						...tenantFilter,
						provider: "GITLAB",
						isActive: true,
					},
					select: { id: true },
				});
				if (integration) {
					// `canFetch` is consumed by internal Temporal activities but
					// is not part of the public `getPMCapabilities` Zod output
					// schema. Destructure-and-discard makes the omission visible
					// at the call site (instead of relying on Zod's silent
					// `.strip()`) — a future contributor adding `canFetch` to
					// the API surface must do so as a deliberate one-line schema
					// change, not by accident of constant shape.
					const {
						canFetch: _canFetchInternalOnly,
						...publicCapabilities
					} = GITLAB_REST_CAPABILITIES;
					return {
						configured: true,
						capabilities: publicCapabilities,
						containerName: project.projectManagementContainerName,
						detectedType: "gitlab-rest",
						mcpConfigId: null,
						containerId: project.projectManagementContainerId,
						additionalContext,
						error: null,
					};
				}
			}
		}

		if (!userMcpConfig) {
			return {
				configured: true,
				capabilities: null,
				containerName: project.projectManagementContainerName,
				detectedType: await storedDetectedType(),
				mcpConfigId: null,
				containerId: project.projectManagementContainerId,
				additionalContext,
				error: "You have not connected your account to the project management tool. Please configure your MCP connection in Settings.",
			};
		}

		if (!userMcpConfig.enabled) {
			return {
				configured: true,
				capabilities: null,
				containerName: project.projectManagementContainerName,
				detectedType: await storedDetectedType(),
				mcpConfigId: userMcpConfig.id,
				containerId: project.projectManagementContainerId,
				additionalContext,
				error: "Your project management connection is disabled. Please enable it in Settings.",
			};
		}

		// Get capabilities using CURRENT USER's config
		const { getPMToolCapabilities } = await import("@repo/temporal");

		const organizationId = project.organizationId || undefined;

		try {
			const capabilities = await getPMToolCapabilities({
				mcpConfigId: userMcpConfig.id, // Use current user's config
				userId: user.id,
				organizationId,
			});

			if (!capabilities) {
				return {
					configured: true,
					capabilities: null,
					containerName: project.projectManagementContainerName,
					detectedType: await storedDetectedType(),
					mcpConfigId: userMcpConfig.id,
					containerId: project.projectManagementContainerId,
					additionalContext,
					error: "Could not connect to PM tool. Please check your MCP configuration.",
				};
			}

			return {
				configured: true,
				containerName: project.projectManagementContainerName,
				detectedType:
					capabilities.detectedType ?? (await storedDetectedType()),
				mcpConfigId: userMcpConfig.id,
				containerId: project.projectManagementContainerId,
				additionalContext,
				capabilities: {
					hasPMCapabilities: capabilities.hasPMCapabilities,
					canCreate: capabilities.canCreate,
					canUpdate: capabilities.canUpdate,
					canGet: capabilities.canGet,
					canList: capabilities.canList,
					supportsPush: capabilities.canCreate,
					supportsPull: capabilities.canList,
					supportsTaskSync: capabilities.canCreate,
				},
				error: null,
			};
		} catch (error) {
			return {
				configured: true,
				capabilities: null,
				containerName: project.projectManagementContainerName,
				detectedType: await storedDetectedType(),
				mcpConfigId: userMcpConfig.id,
				containerId: project.projectManagementContainerId,
				additionalContext,
				error:
					error instanceof Error
						? error.message
						: "Unknown error discovering PM capabilities",
			};
		}
	});
