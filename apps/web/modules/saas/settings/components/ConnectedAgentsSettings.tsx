"use client";

import {
	requestedScopes,
	unknownScopes,
} from "@saas/oauth/lib/consent-display";
import { SettingsList } from "@saas/shared/components/SettingsList";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, AlertDescription } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import { Skeleton } from "@ui/components/skeleton";
import { BotIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { SettingsHero } from "./SettingsHero";

const connectedAgentsQueryKey = ["users", "oauth-connections"] as const;

/**
 * The coding agents this account has signed in. Account-global like the rest
 * of `settings/account/*`: the rows span organizations and projects, one per
 * grant, each naming the organization or the project it was approved for.
 * Revoking deletes that grant's consent and every token under it and nothing
 * else, so the agent is signed out of it at its next request rather than when a
 * token expires.
 */
/**
 * What an agent may do, in the words the consent screen used when it was
 * approved: for a project grant, the sentences that say "this project". The raw
 * scope stays in each item's `title` for support; a scope this screen has no
 * sentence for is shown as it is.
 */
function ScopeList({
	scopes,
	projectScoped,
}: {
	scopes: string[];
	projectScoped: boolean;
}) {
	const tScopes = useTranslations("auth.oauth.consent");
	const scopeParam = scopes.join(" ");
	const wordsKey = projectScoped ? "scopesProject" : "scopes";

	return (
		<ul className="mt-1 list-disc space-y-0.5 pl-5">
			{requestedScopes(scopeParam).map((scope) => (
				<li key={scope} title={scope}>
					{tScopes(`${wordsKey}.${scope}`)}
				</li>
			))}
			{unknownScopes(scopeParam).map((scope) => (
				<li key={scope} title={scope}>
					<code>{scope}</code>
				</li>
			))}
		</ul>
	);
}

export function ConnectedAgentsSettings() {
	const t = useTranslations("settings.connectedAgents");
	const queryClient = useQueryClient();

	const connections = useQuery({
		queryKey: connectedAgentsQueryKey,
		queryFn: () => orpcClient.users.oauthConnections.list({}),
	});

	const revoke = useMutation({
		mutationFn: (consentId: string) =>
			orpcClient.users.oauthConnections.revoke({ consentId }),
		onSuccess: () => {
			toast.success(t("revoked"));
			queryClient.invalidateQueries({
				queryKey: connectedAgentsQueryKey,
			});
		},
		onError: () => {
			toast.error(t("revokeFailed"));
		},
	});

	return (
		<>
			<SettingsHero
				description={t("description")}
				label="Account"
				title={t("title")}
			/>
			<SettingsList>
				{connections.isPending ? (
					<Skeleton className="h-20 w-full" />
				) : connections.isError ? (
					<Alert variant="error">
						<AlertDescription>{t("loadFailed")}</AlertDescription>
					</Alert>
				) : connections.data.length === 0 ? (
					<p
						className="text-muted-foreground text-sm"
						data-testid="connected-agents-empty"
					>
						{t("empty")}
					</p>
				) : (
					<ul className="space-y-3">
						{connections.data.map((connection) => (
							<li
								key={connection.consentId}
								className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 sm:flex-row sm:items-start sm:justify-between"
								data-testid="connected-agent"
							>
								<div className="flex min-w-0 gap-3">
									<BotIcon
										aria-hidden="true"
										className="mt-0.5 size-5 shrink-0 text-muted-foreground"
									/>
									<div className="min-w-0 space-y-1 text-sm">
										<p className="font-medium">
											{connection.clientName ??
												t("unnamedClient")}
										</p>
										{connection.projectId === null ? (
											<p className="text-muted-foreground">
												{t("organization")}:{" "}
												{connection.organizationName ??
													"-"}
											</p>
										) : (
											<p
												className="text-muted-foreground"
												data-testid="connected-agent-project"
											>
												{t("project")}:{" "}
												{connection.projectName ===
													null ||
												connection.organizationName ===
													null
													? t("projectUnavailable")
													: t("projectLine", {
															project:
																connection.projectName,
															organization:
																connection.organizationName,
														})}
											</p>
										)}
										<div className="text-muted-foreground">
											<p>{t("access")}:</p>
											<ScopeList
												projectScoped={
													connection.projectId !==
													null
												}
												scopes={connection.scopes}
											/>
										</div>
										{connection.createdAt ? (
											<p className="text-muted-foreground text-xs">
												{t("connected", {
													date: new Date(
														connection.createdAt,
													).toLocaleDateString(),
												})}
											</p>
										) : null}
									</div>
								</div>
								<Button
									autoLoading={false}
									disabled={revoke.isPending}
									onClick={() =>
										revoke.mutate(connection.consentId)
									}
									size="sm"
									variant="outline"
								>
									{revoke.isPending &&
									revoke.variables === connection.consentId
										? t("revoking")
										: t("revoke")}
								</Button>
							</li>
						))}
					</ul>
				)}
			</SettingsList>
		</>
	);
}
