import { db } from "@repo/database";
import { decryptApiKey, encryptApiKey } from "@repo/utils";

interface StoredSlackCredentials {
	access_token?: unknown;
	apiKey?: unknown;
	user_access_token?: unknown;
	team_id?: unknown;
	team_name?: unknown;
	bot_user_id?: unknown;
	[key: string]: unknown;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function readSlackConnectionIdentity(
	integration: {
		id: string;
		userId: string;
		organizationId: string | null;
		credentials: string;
	},
	resolveMissingTeamId = true,
): Promise<{
	accessToken?: string;
	userAccessToken?: string;
	teamId?: string;
	teamName?: string;
	botUserId?: string;
}> {
	let json: string;
	try {
		json = decryptApiKey(integration.credentials);
	} catch {
		json = integration.credentials;
	}
	let credentials: StoredSlackCredentials;
	try {
		const parsed = JSON.parse(json) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("Invalid Slack credentials");
		}
		credentials = parsed as StoredSlackCredentials;
	} catch {
		throw new Error(
			"Slack credentials are corrupted. Please reconnect your Slack workspace in Settings > Integrations.",
		);
	}
	const accessToken =
		stringValue(credentials.access_token) ??
		stringValue(credentials.apiKey);
	let teamId = stringValue(credentials.team_id);
	let teamName = stringValue(credentials.team_name);
	let botUserId = stringValue(credentials.bot_user_id);

	if (resolveMissingTeamId && !teamId && accessToken) {
		const response = await fetch("https://slack.com/api/auth.test", {
			headers: { Authorization: `Bearer ${accessToken}` },
		});
		if (response.ok) {
			const data = (await response.json()) as {
				ok?: boolean;
				team_id?: unknown;
				team?: unknown;
				user_id?: unknown;
			};
			if (data.ok) {
				teamId = stringValue(data.team_id);
				if (teamId) {
					teamName = stringValue(data.team);
					botUserId = stringValue(data.user_id);
					const persisted = await db.workflowIntegration.updateMany({
						where: {
							id: integration.id,
							credentials: integration.credentials,
						},
						data: {
							credentials: encryptApiKey(
								JSON.stringify({
									...credentials,
									team_id: teamId,
									team_name: teamName,
									bot_user_id: botUserId,
								}),
							),
						},
					});
					if (persisted.count === 0) {
						const fresh = await db.workflowIntegration.findFirst({
							where: {
								id: integration.id,
								userId: integration.userId,
								organizationId: integration.organizationId,
								provider: "SLACK",
								isActive: true,
								NOT: { name: "SLACK_OAUTH_APP" },
							},
						});
						if (!fresh?.credentials) {
							throw new Error(
								"Slack connection changed during verification",
							);
						}
						const freshIdentity = await readSlackConnectionIdentity(
							fresh,
							false,
						);
						if (!freshIdentity.teamId) {
							throw new Error(
								"Slack connection changed without a readable team ID",
							);
						}
						return freshIdentity;
					}
					if (persisted.count !== 1) {
						throw new Error(
							"Slack connection verification could not be persisted",
						);
					}
				}
			}
		}
	}

	return {
		accessToken,
		userAccessToken: stringValue(credentials.user_access_token),
		teamId,
		teamName,
		botUserId,
	};
}
