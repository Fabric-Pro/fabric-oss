import { db } from "@repo/database";
import { decryptApiKey } from "@repo/utils";
import { buildExternalPmTarget } from "@repo/utils/pm-target";
import {
	type DeliverySignalProvider,
	deliverySignalProjectInput,
	deliverySignalProvider,
	deliverySignalSourceConfiguration,
} from "./delivery-signal-contracts";
import {
	type DeliverySignalActor,
	deliverySignalNotFound,
	requireDeliverySignalIntegrationRead,
	requireDeliverySignalProjectAccess,
} from "./delivery-signals";

type SavedState = "NOT_CONFIGURED" | "CONFIGURED_NOT_CHECKED" | "PAUSED";
export function summarizeDeliverySignalSetup(
	rows: readonly { deactivatedAt: Date | null }[],
): SavedState {
	return !rows.length
		? "NOT_CONFIGURED"
		: rows.some((row) => row.deactivatedAt === null)
			? "CONFIGURED_NOT_CHECKED"
			: "PAUSED";
}
/** Read stored identity only. A decoded claim is a saved fact, never token validation/source access. */
function credentialIdentity(
	provider: string,
	encrypted: string,
): string | null {
	if (encrypted.length > 100_000) {
		return null;
	}
	try {
		let text: string;
		try {
			text = decryptApiKey(encrypted);
		} catch {
			text = encrypted;
		}
		if (text.length > 100_000) {
			return null;
		}
		const credentials: unknown = JSON.parse(text);
		if (!credentials || typeof credentials !== "object") {
			return null;
		}
		const token =
			"access_token" in credentials
				? credentials.access_token
				: "apiKey" in credentials
					? credentials.apiKey
					: null;
		if (typeof token !== "string" || !token.trim()) {
			return null;
		}
		if (
			provider === "SLACK" &&
			"team_id" in credentials &&
			typeof credentials.team_id === "string"
		) {
			return credentials.team_id.trim() ? credentials.team_id : null;
		}
		if (
			provider === "MICROSOFT_GRAPH" &&
			"access_token" in credentials &&
			typeof credentials.access_token === "string"
		) {
			const parts = credentials.access_token.split(".");
			if (parts.length !== 3) {
				return null;
			}
			const claims: unknown = JSON.parse(
				Buffer.from(parts[1], "base64url").toString("utf8"),
			);
			if (
				claims &&
				typeof claims === "object" &&
				"tid" in claims &&
				typeof claims.tid === "string"
			) {
				return claims.tid || null;
			}
		}
	} catch {
		/* Unknown legacy metadata is ineligible; never expose raw credential errors. */
	}
	return null;
}
function teamsChatTenant(chatId: string, webUrl: string | null) {
	if (!webUrl || webUrl.length > 4096) {
		return null;
	}
	try {
		const url = new URL(webUrl);
		if (
			url.protocol !== "https:" ||
			url.hostname !== "teams.microsoft.com" ||
			!decodeURIComponent(url.pathname).split("/").includes(chatId)
		) {
			return null;
		}
		const tenant = url.searchParams.get("tenantId");
		if (tenant) {
			return tenant;
		}
		const context: unknown = JSON.parse(
			url.searchParams.get("context") ?? "null",
		);
		return context &&
			typeof context === "object" &&
			"tid" in context &&
			typeof context.tid === "string"
			? context.tid
			: null;
	} catch {
		return null;
	}
}
const pmProvider = (key: string): DeliverySignalProvider | null => {
	switch (key) {
		case "jira":
		case "atlassian":
			return "JIRA";
		case "azure-devops":
			return "AZURE_DEVOPS";
		case "fizzy":
			return "FIZZY";
		default:
			return null;
	}
};

/** Own saved setup only. No probes, source content, subscriptions, sync blobs or inferred health. */
export async function getDeliverySignalSourceConfiguration(
	actor: DeliverySignalActor,
	raw: unknown,
) {
	const input = deliverySignalProjectInput.parse(raw);
	const scope = await requireDeliverySignalProjectAccess(
		actor,
		input.projectId,
	);
	await requireDeliverySignalIntegrationRead(scope);
	const where = {
		projectId: scope.projectId,
		organizationId: scope.organizationId,
		userId: scope.userId,
		project: { organizationId: scope.organizationId, deletedAt: null },
	};
	const [slack, channels, chats, credentials, project] = await Promise.all([
		db.projectLinkedSlackChannel.findMany({
			where,
			select: { slackTeamId: true, channelId: true, deactivatedAt: true },
		}),
		db.projectLinkedTeamsChannel.findMany({
			where,
			select: {
				tenantId: true,
				teamId: true,
				channelId: true,
				deactivatedAt: true,
			},
		}),
		db.projectLinkedTeamsChat.findMany({
			where,
			select: { chatId: true, chatWebUrl: true, deactivatedAt: true },
		}),
		db.workflowIntegration.findMany({
			where: {
				organizationId: scope.organizationId,
				userId: scope.userId,
				isActive: true,
				provider: { in: ["SLACK", "MICROSOFT_GRAPH"] },
				NOT: {
					name: {
						in: ["SLACK_OAUTH_APP", "MICROSOFT_GRAPH_OAUTH_APP"],
					},
				},
			},
			select: { provider: true, credentials: true },
		}),
		db.project.findFirst({
			where: {
				id: scope.projectId,
				organizationId: scope.organizationId,
				deletedAt: null,
			},
			select: {
				projectManagementMcpConfigId: true,
				projectManagementMcpServerId: true,
				projectManagementContainerId: true,
				projectManagementAdditionalContext: true,
			},
		}),
	]);
	if (!project) {
		deliverySignalNotFound();
	}
	const identities = {
		SLACK: new Set<string>(),
		MICROSOFT_GRAPH: new Set<string>(),
	};
	for (const row of credentials) {
		const id = credentialIdentity(row.provider, row.credentials);
		if (
			id &&
			(row.provider === "SLACK" || row.provider === "MICROSOFT_GRAPH")
		) {
			identities[row.provider].add(id);
		}
	}
	const survivors = new Map<
		DeliverySignalProvider,
		{ deactivatedAt: Date | null }[]
	>(deliverySignalProvider.options.map((source) => [source, []]));
	survivors.set(
		"SLACK",
		slack.filter(
			(row) => !!row.channelId && identities.SLACK.has(row.slackTeamId),
		),
	);
	survivors.set("TEAMS", [
		...channels.filter(
			(row) =>
				!!row.tenantId &&
				!!row.teamId &&
				!!row.channelId &&
				identities.MICROSOFT_GRAPH.has(row.tenantId),
		),
		...chats.filter((row) => {
			const tenant = teamsChatTenant(row.chatId, row.chatWebUrl);
			return tenant !== null && identities.MICROSOFT_GRAPH.has(tenant);
		}),
	]);
	if (
		project.projectManagementMcpConfigId &&
		project.projectManagementMcpServerId &&
		project.projectManagementContainerId
	) {
		const config = await db.mCPConfig.findFirst({
			where: {
				id: project.projectManagementMcpConfigId,
				organizationId: scope.organizationId,
				userId: scope.userId,
				enabled: true,
			},
			select: {
				mcpServerId: true,
				baseUrl: true,
				commandArgs: true,
				atlassianCloudSiteUrl: true,
				atlassianCloudCloudId: true,
				atlassianCloudAccessibleResources: true,
				mcpServer: { select: { key: true, defaultUrl: true } },
			},
		});
		if (
			config &&
			(project.projectManagementMcpServerId === config.mcpServerId ||
				project.projectManagementMcpServerId ===
					`key:${config.mcpServer.key}`)
		) {
			const source = pmProvider(config.mcpServer.key);
			const target = source
				? buildExternalPmTarget({
						mcpServerId: config.mcpServerId,
						config,
						containerId: project.projectManagementContainerId,
						additionalContext:
							project.projectManagementAdditionalContext,
					})
				: null;
			// The common target helper permits an empty legacy instance; this view doesn't.
			if (source && target) {
				const identity: unknown = JSON.parse(target.slice(5));
				if (
					Array.isArray(identity) &&
					typeof identity[1] === "string" &&
					identity[1].trim()
				) {
					if (source === "JIRA") {
						const resources =
							config.atlassianCloudAccessibleResources;
						const matches =
							config.atlassianCloudCloudId === identity[1] ||
							(Array.isArray(resources) &&
								resources.some(
									(resource) =>
										resource !== null &&
										typeof resource === "object" &&
										!Array.isArray(resource) &&
										resource.id === identity[1],
								));
						if (matches) {
							survivors.set(source, [{ deactivatedAt: null }]);
						}
					} else {
						survivors.set(source, [{ deactivatedAt: null }]);
					}
				}
			}
		}
	}
	return deliverySignalSourceConfiguration.parse({
		version: 1,
		items: deliverySignalProvider.options.map((source) => ({
			source,
			state: summarizeDeliverySignalSetup(survivors.get(source) ?? []),
		})),
	});
}
