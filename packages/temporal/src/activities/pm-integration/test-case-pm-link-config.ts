import { db } from "@repo/database";
import { ApplicationFailure } from "@temporalio/activity";

/** Resolve the active PM configuration using the push guard's tenant scope. */
export async function resolveTestCasePmLinkConfig(input: {
	mcpConfigId?: string | null;
	mcpServerId: string;
	userId: string;
	organizationId?: string;
}) {
	const config = input.mcpConfigId
		? await db.mCPConfig.findFirst({
				where: {
					id: input.mcpConfigId,
					userId: input.userId,
					organizationId: input.organizationId ?? null,
					mcpServerId: input.mcpServerId,
				},
				select: {
					baseUrl: true,
					commandArgs: true,
					atlassianCloudSiteUrl: true,
					mcpServer: { select: { defaultUrl: true, key: true } },
				},
			})
		: {
				baseUrl: null,
				mcpServer: await db.mCPServer.findUnique({
					where: { id: input.mcpServerId },
					select: { defaultUrl: true, key: true },
				}),
			};
	if (!config?.mcpServer) {
		throw ApplicationFailure.nonRetryable(
			"The PM configuration is no longer available. Sync again after selecting the PM tool.",
			"PmConfigNotFoundError",
		);
	}
	return config;
}
