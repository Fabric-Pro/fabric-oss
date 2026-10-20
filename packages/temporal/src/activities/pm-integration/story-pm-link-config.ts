import { db } from "@repo/database";
import {
	isGitLabPersonalMcpServerKey,
	requireRecordedGitLabPmOrigin,
} from "@repo/integrations/gitlab";
import { ApplicationFailure } from "@temporalio/activity";
import { mcpConfigPmInstanceOrigin } from "./pm-link-instance";

/** Resolve the active story link configuration and its PM instance binding. */
export async function resolveStoryPmLinkConfig(input: {
	mcpConfigId: string | null;
	mcpServerId: string;
	userId: string;
	organizationId?: string;
	additionalContext?: unknown;
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
	const instanceOrigin =
		input.mcpConfigId === null &&
		isGitLabPersonalMcpServerKey(config.mcpServer.key)
			? requireRecordedGitLabPmOrigin(input.additionalContext)
			: mcpConfigPmInstanceOrigin(config);

	return {
		config: { ...config, mcpServer: config.mcpServer },
		instanceOrigin,
	};
}
