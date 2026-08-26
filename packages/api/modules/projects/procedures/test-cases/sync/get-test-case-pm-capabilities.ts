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
import { assertTestCasesFeatureEnabled } from "../../../lib/test-cases-feature";

/**
 * Discover the configured PM tool's capabilities for test-case sync. Wraps the
 * SAME capability discovery the story sync uses (`get-pm-capabilities.ts`) and
 * adds `supportsNativeSteps` — true only for Azure DevOps, which stores native
 * test-case steps (`Microsoft.VSTS.TCM.Steps`). Every other tool gets steps in
 * the issue body via the generic serializer, so `supportsNativeSteps` is false.
 */
export const getTestCasePmCapabilitiesProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/test-case-pm-capabilities",
		tags: ["Projects", "Test Cases", "Sync"],
		summary: "Get PM tool capabilities for test-case sync",
		description:
			"Get the sync capabilities of the configured PM tool, including whether it supports native test-case steps (Azure DevOps).",
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
			mcpConfigId: z.string().nullable(),
			containerId: z.string().nullable(),
			additionalContext: z.record(z.string(), z.string()).nullable(),
			error: z.string().nullable(),
			/** True when the PM tool stores native test-case steps (ADO). */
			supportsNativeSteps: z.boolean(),
		}),
	)
	.handler(async ({ input, context }) => {
		assertTestCasesFeatureEnabled();
		// AUTHORIZATION: requireProjectPermission(TEST_CASE_READ) gates project
		// access.
		const user = context.user;

		const project = await db.project.findUnique({
			where: { id: input.projectId },
			select: {
				id: true,
				organizationId: true,
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

		// Resolve the project's PM server key once (sentinel → read inline,
		// catalog id → single memoized DB lookup) — used for GitLab-REST routing
		// and as the display-only `detectedType` fallback. `detectedType` drives
		// `supportsNativeSteps`; capabilities/error/configured still drive health.
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

		// Project has MCP config but no board/container selected.
		if (
			(project.projectManagementMcpConfigId ||
				project.projectManagementMcpServerId) &&
			!project.projectManagementContainerId
		) {
			const detectedType = await storedDetectedType();
			return {
				configured: true,
				capabilities: null,
				containerName: null,
				detectedType,
				mcpConfigId: project.projectManagementMcpConfigId ?? null,
				containerId: null,
				additionalContext: null,
				error: "Select a board in Project Settings to sync test cases with your PM tool.",
				supportsNativeSteps: detectedType === "azure-devops",
			};
		}

		// Resolve the CALLING USER's MCP config — prefers configId, falls back
		// to serverId.
		const userMcpConfig = await resolvePMConfigForUser({
			configId: project.projectManagementMcpConfigId,
			mcpServerId: project.projectManagementMcpServerId,
			userId: user.id,
			organizationId: project.organizationId || undefined,
		});

		// String-valued entries only — the column also carries the structured
		// `fieldMapping` settings, which this procedure publishes as a flat
		// string map.
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
				supportsNativeSteps: false,
			};
		}

		// REST-GitLab fallback: project's server is `gitlab-official` AND the
		// tenant has an active WorkflowIntegration, but the caller has no
		// resolvable MCPConfig. GitLab does not store native test-case steps, so
		// `supportsNativeSteps` is false (steps ride the issue body).
		if (!userMcpConfig && project.projectManagementMcpServerId) {
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
					const {
						canFetch: _canFetchInternalOnly,
						...publicCapabilities
					} = GITLAB_REST_CAPABILITIES;
					return {
						configured: true,
						// The GitLab REST fallback has no native test-case entity
						// wired, so test cases can't sync through it.
						capabilities: {
							...publicCapabilities,
							supportsPush: false,
							supportsPull: false,
						},
						containerName: project.projectManagementContainerName,
						detectedType: "gitlab-rest",
						mcpConfigId: null,
						containerId: project.projectManagementContainerId,
						additionalContext,
						error: null,
						supportsNativeSteps: false,
					};
				}
			}
		}

		if (!userMcpConfig) {
			const detectedType = await storedDetectedType();
			return {
				configured: true,
				capabilities: null,
				containerName: project.projectManagementContainerName,
				detectedType,
				mcpConfigId: null,
				containerId: project.projectManagementContainerId,
				additionalContext,
				error: "You have not connected your account to the project management tool. Please configure your MCP connection in Settings.",
				supportsNativeSteps: detectedType === "azure-devops",
			};
		}

		if (!userMcpConfig.enabled) {
			const detectedType = await storedDetectedType();
			return {
				configured: true,
				capabilities: null,
				containerName: project.projectManagementContainerName,
				detectedType,
				mcpConfigId: userMcpConfig.id,
				containerId: project.projectManagementContainerId,
				additionalContext,
				error: "Your project management connection is disabled. Please enable it in Settings.",
				supportsNativeSteps: detectedType === "azure-devops",
			};
		}

		const { getPMToolCapabilities } = await import("@repo/temporal");
		const organizationId = project.organizationId || undefined;

		try {
			const capabilities = await getPMToolCapabilities({
				mcpConfigId: userMcpConfig.id,
				userId: user.id,
				organizationId,
			});

			if (!capabilities) {
				const detectedType = await storedDetectedType();
				return {
					configured: true,
					capabilities: null,
					containerName: project.projectManagementContainerName,
					detectedType,
					mcpConfigId: userMcpConfig.id,
					containerId: project.projectManagementContainerId,
					additionalContext,
					error: "Could not connect to PM tool. Please check your MCP configuration.",
					supportsNativeSteps: detectedType === "azure-devops",
				};
			}

			const detectedType =
				capabilities.detectedType ?? (await storedDetectedType());
			return {
				configured: true,
				containerName: project.projectManagementContainerName,
				detectedType,
				mcpConfigId: userMcpConfig.id,
				containerId: project.projectManagementContainerId,
				additionalContext,
				capabilities: {
					hasPMCapabilities: capabilities.hasPMCapabilities,
					canCreate: capabilities.canCreate,
					canUpdate: capabilities.canUpdate,
					canGet: capabilities.canGet,
					canList: capabilities.canList,
					// Test-case push/pull requires a native test-case entity
					// (ADO / Xray / Zephyr / GitLab test cases), NOT merely
					// generic work-item CRUD — a case is never synced as a plain
					// issue to a tool with no test-case concept.
					supportsPush:
						capabilities.supportsTestCases &&
						capabilities.canCreate,
					supportsPull:
						capabilities.supportsTestCases && capabilities.canList,
					supportsTaskSync: capabilities.canCreate,
				},
				error: null,
				supportsNativeSteps: detectedType === "azure-devops",
			};
		} catch (error) {
			const detectedType = await storedDetectedType();
			return {
				configured: true,
				capabilities: null,
				containerName: project.projectManagementContainerName,
				detectedType,
				mcpConfigId: userMcpConfig.id,
				containerId: project.projectManagementContainerId,
				additionalContext,
				error:
					error instanceof Error
						? error.message
						: "Unknown error discovering PM capabilities",
				supportsNativeSteps: detectedType === "azure-devops",
			};
		}
	});
