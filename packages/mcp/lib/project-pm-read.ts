import { azureDevOpsOrganization } from "@repo/connectors";
import { db, hasProjectAccess } from "@repo/database";
import {
	getProjectPMServerKey,
	GitLabPmOriginMismatchError,
	resolveProjectPMConfigForUser,
} from "@repo/integrations/gitlab";
import { resolveAdoPat } from "@repo/integrations/pm/pull-image-ingest";
import { checkMcpConfigOrganizationAccess } from "./organization-access";

/**
 * Internal context only: never return the PAT through an API, tool result,
 * or workflow history.
 */
export async function resolveProjectPmRead(args: {
	projectId: string;
	userId: string;
	organizationId: string;
}) {
	const project = await db.project.findFirst({
		where: {
			id: args.projectId,
			organizationId: args.organizationId,
			deletedAt: null,
		},
		select: {
			organizationId: true,
			projectManagementMcpServerId: true,
			projectManagementMcpConfigId: true,
			projectManagementAdditionalContext: true,
			projectManagementContainerId: true,
			projectManagementContainerName: true,
		},
	});
	if (!project) {
		return { status: "not_found" as const };
	}
	if (!(await hasProjectAccess(args.projectId, args.userId))) {
		return {
			status: "forbidden" as const,
			message: "You do not have access to this project.",
		};
	}
	if (
		(!project.projectManagementMcpConfigId &&
			!project.projectManagementMcpServerId) ||
		!project.projectManagementContainerId
	) {
		return {
			status: "not_configured" as const,
			message:
				"Configure project management in this Fabric project's Development settings.",
		};
	}
	const refusal = await checkMcpConfigOrganizationAccess({
		userId: args.userId,
		organizationId: args.organizationId,
		access: "connect",
	});
	if (refusal) {
		return { status: "forbidden" as const, message: refusal.message };
	}
	const pinnedConfig = project.projectManagementMcpConfigId
		? await db.mCPConfig.findFirst({
				where: {
					id: project.projectManagementMcpConfigId,
					organizationId: args.organizationId,
				},
				select: {
					commandArgs: true,
					mcpServer: { select: { key: true } },
				},
			})
		: null;
	const serverKey =
		pinnedConfig?.mcpServer.key ??
		(await getProjectPMServerKey(project.projectManagementMcpServerId));
	if (serverKey && serverKey !== "azure-devops") {
		return {
			status: "unsupported" as const,
			message:
				"This dashboard currently supports Azure DevOps project management.",
		};
	}
	const pinnedOrganization = pinnedConfig
		? azureDevOpsOrganization(pinnedConfig.commandArgs)
		: null;
	if (!pinnedOrganization) {
		return {
			status: "not_connected" as const,
			message:
				"Connect to the Azure DevOps organization selected in this project's Development settings. Reselect its project if the original connection was removed.",
		};
	}
	let config: Awaited<ReturnType<typeof resolveProjectPMConfigForUser>>;
	try {
		config = await resolveProjectPMConfigForUser({
			configId: project.projectManagementMcpConfigId,
			mcpServerId: project.projectManagementMcpServerId ?? undefined,
			userId: args.userId,
			organizationId: args.organizationId,
			pmAdditionalContext: project.projectManagementAdditionalContext,
		});
	} catch (error) {
		if (!(error instanceof GitLabPmOriginMismatchError)) {
			throw error;
		}
		config = null;
	}
	if (!config?.enabled) {
		return {
			status: "not_connected" as const,
			message:
				"Connect your own Azure DevOps account in this organization.",
		};
	}
	if (config.mcpServer.key !== "azure-devops") {
		return {
			status: "unsupported" as const,
			message:
				"This dashboard currently supports Azure DevOps project management.",
		};
	}
	if (
		config.userId !== args.userId ||
		config.organizationId !== args.organizationId ||
		config.authType !== "API_KEY" ||
		config.needsReauth
	) {
		return {
			status: "not_connected" as const,
			message:
				"Reconnect your own Azure DevOps account with a personal access token.",
		};
	}
	const organization = azureDevOpsOrganization(config.commandArgs);
	if (
		!organization ||
		organization.toLowerCase() !== pinnedOrganization.toLowerCase()
	) {
		return {
			status: "not_connected" as const,
			message:
				"Connect to the Azure DevOps organization selected in this project's Development settings. Reselect its project if the original connection was removed.",
		};
	}
	const pat = resolveAdoPat(config.encryptedApiKey);
	if (!pat) {
		return {
			status: "not_connected" as const,
			message:
				"Reconnect Azure DevOps with an organization and personal access token.",
		};
	}
	return {
		status: "ready" as const,
		provider: "azure-devops" as const,
		target: {
			organization,
			projectId: project.projectManagementContainerId,
			projectName:
				project.projectManagementContainerName ??
				project.projectManagementContainerId,
		},
		pat,
	};
}
