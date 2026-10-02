"use client";

import { authClient } from "@repo/auth/client";
import { useSession } from "@saas/auth/hooks/use-session";
import { useOrganizationListQuery } from "@saas/organizations/lib/api";
import { useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import { CheckIcon } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import {
	redirectTargetLabel,
	requestedScopes,
	unknownScopes,
} from "../lib/consent-display";

interface PublicClient {
	client_name?: string;
}

interface AuthorizationRedirect {
	redirect?: boolean;
	url?: string;
}

/**
 * Where an agent asks to act as the signed-in person, for one organization.
 *
 * Always shown the first time for a client, user and organization — consent is
 * never skipped for a client that registered itself. The name is whatever the
 * client called itself, and is labelled as such.
 */
export function OAuthConsent() {
	const t = useTranslations("auth.oauth.consent");
	const searchParams = useSearchParams();
	const { session, user, loaded } = useSession();
	const organizations = useOrganizationListQuery();
	const [pending, setPending] = useState<"accept" | "deny" | null>(null);
	const [failed, setFailed] = useState(false);

	const clientId = searchParams.get("client_id");
	const scopes = requestedScopes(searchParams.get("scope"));
	const unrecognized = unknownScopes(searchParams.get("scope"));
	const target = redirectTargetLabel(searchParams.get("redirect_uri"));

	const client = useQuery({
		queryKey: ["oauth", "client", clientId],
		enabled: Boolean(clientId) && Boolean(user),
		queryFn: async () => {
			const { data, error } = await authClient.$fetch<PublicClient>(
				"/oauth2/public-client",
				{ query: { client_id: clientId } },
			);
			if (error) {
				throw new Error("client lookup failed");
			}
			return data;
		},
	});

	const organizationList = organizations.data ?? [];
	const organization =
		organizationList.find(
			(org) => org.id === session?.activeOrganizationId,
		) ?? (organizationList.length === 1 ? organizationList[0] : undefined);

	const answer = async (accept: boolean) => {
		setPending(accept ? "accept" : "deny");
		setFailed(false);
		try {
			const { data, error } =
				await authClient.$fetch<AuthorizationRedirect>(
					"/oauth2/consent",
					{ method: "POST", body: { accept } },
				);
			if (error || !data?.url) {
				throw new Error("consent failed");
			}
			window.location.assign(data.url);
		} catch {
			setFailed(true);
			setPending(null);
		}
	};

	if (loaded && !user) {
		return (
			<p className="text-muted-foreground text-sm">
				{t("signInRequired")}
			</p>
		);
	}

	const clientName = client.data?.client_name?.trim() || t("unnamedClient");
	const cannotAllow =
		pending !== null ||
		!organization ||
		scopes.length === 0 ||
		unrecognized.length > 0 ||
		!clientId;

	return (
		<div className="flex flex-col gap-5">
			<div className="space-y-2">
				<p className="app-editorial-label">{t("label")}</p>
				<h1 className="font-serif font-normal text-2xl leading-snug">
					{t("title", { client: clientName })}
				</h1>
				<p className="text-muted-foreground text-xs">
					{t("selfAsserted")}
				</p>
			</div>

			<dl className="space-y-3 text-sm">
				<div>
					<dt className="app-editorial-label">
						{t("organizationLabel")}
					</dt>
					<dd className="mt-1 font-medium">
						{organization?.name ?? t("noOrganization")}
					</dd>
				</div>
				<div>
					<dt className="app-editorial-label">{t("scopesLabel")}</dt>
					<dd className="mt-1">
						<ul className="space-y-2">
							{scopes.map((scope) => (
								<li
									key={scope}
									className="flex items-start gap-2"
								>
									<CheckIcon
										aria-hidden="true"
										className="mt-0.5 size-4 shrink-0 text-secondary"
									/>
									<span>{t(`scopes.${scope}`)}</span>
								</li>
							))}
						</ul>
					</dd>
				</div>
			</dl>

			{target ? (
				<p className="text-muted-foreground text-xs">
					{t("redirectsTo", { host: target })}
				</p>
			) : null}
			<p className="text-muted-foreground text-xs">{t("revokeHint")}</p>

			{failed ? (
				<Alert variant="error">
					<AlertDescription>{t("failed")}</AlertDescription>
				</Alert>
			) : null}

			<div className="flex gap-3">
				<Button
					autoLoading={false}
					className="flex-1"
					disabled={cannotAllow}
					loading={pending === "accept"}
					onClick={() => answer(true)}
				>
					{pending === "accept" ? t("working") : t("allow")}
				</Button>
				<Button
					autoLoading={false}
					className="flex-1"
					disabled={pending !== null}
					loading={pending === "deny"}
					onClick={() => answer(false)}
					variant="outline"
				>
					{t("deny")}
				</Button>
			</div>
		</div>
	);
}
