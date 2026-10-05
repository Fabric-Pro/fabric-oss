"use client";

import { authClient } from "@repo/auth/client";
import { OAUTH_ORGANIZATION_CHOSEN_COOKIE } from "@repo/auth/lib/oauth-scopes";
import { useSession } from "@saas/auth/hooks/use-session";
import { useOrganizationListQuery } from "@saas/organizations/lib/api";
import { Alert, AlertDescription } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import { Label } from "@ui/components/label";
import { RadioGroup, RadioGroupItem } from "@ui/components/radio-group";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import {
	type AuthorizationRedirect,
	followAuthorizationRedirect,
} from "../lib/authorization-redirect";
import { useAuthorizationBinding } from "../lib/use-authorization-binding";

/**
 * Which organization an agent is authorized for, asked when the person belongs
 * to more than one. The choice becomes the organization the consent and every
 * token are bound to, so it is made here and nowhere later.
 *
 * An agent that asked for one project has no organization to choose, and the
 * authorization server sends it to this page only when the person cannot open
 * that project. The page says so, and offers nothing to continue with.
 */
export function OAuthOrganizationPicker() {
	const t = useTranslations("auth.oauth.organization");
	const searchParams = useSearchParams();
	const { session } = useSession();
	const organizations = useOrganizationListQuery();
	const binding = useAuthorizationBinding();
	const [chosen, setChosen] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const [failed, setFailed] = useState(false);

	const list = organizations.data ?? [];
	const selected =
		chosen ?? session?.activeOrganizationId ?? list[0]?.id ?? "";

	const proceed = async () => {
		setPending(true);
		setFailed(false);
		try {
			// A plain request, not `authClient.organization.setActive`: the
			// auth client attaches the signed authorization query to every
			// request it makes from this page, and the server would resume the
			// authorization in the middle of this call.
			const setActive = await fetch("/api/auth/organization/set-active", {
				method: "POST",
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ organizationId: selected }),
			});
			if (!setActive.ok) {
				throw new Error("set-active failed");
			}

			// Tells the authorization server the choice is made, for this
			// authorization only: the value is its `code_challenge`. Without
			// it the server would ask again when the flow continues.
			const challenge = searchParams.get("code_challenge") ?? "";
			const secure =
				window.location.protocol === "https:" ? "; secure" : "";
			// biome-ignore lint/suspicious/noDocumentCookie: the Cookie Store API is not in every browser this page must work in, and the write has to land before the request below.
			document.cookie = `${OAUTH_ORGANIZATION_CHOSEN_COOKIE}=${encodeURIComponent(challenge)}; path=/; max-age=600; samesite=lax${secure}`;

			const { data, error } =
				await authClient.$fetch<AuthorizationRedirect>(
					"/oauth2/continue",
					{ method: "POST", body: { postLogin: true } },
				);
			if (error || !data?.url) {
				throw new Error("continue failed");
			}
			followAuthorizationRedirect({ ...data, url: data.url });
		} catch {
			setFailed(true);
			setPending(false);
		}
	};

	if (binding.data?.bound === true && binding.data.project === null) {
		return (
			<div className="flex flex-col gap-5">
				<div className="space-y-2">
					<p className="app-editorial-label">{t("label")}</p>
					<h1 className="font-serif font-normal text-2xl leading-snug">
						{t("noProjectAccessTitle")}
					</h1>
				</div>
				<Alert variant="error">
					<AlertDescription>{t("noProjectAccess")}</AlertDescription>
				</Alert>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-5">
			<div className="space-y-2">
				<p className="app-editorial-label">{t("label")}</p>
				<h1 className="font-serif font-normal text-2xl leading-snug">
					{t("title")}
				</h1>
				<p className="text-muted-foreground text-sm">
					{t("description")}
				</p>
			</div>

			{list.length === 0 && !organizations.isLoading ? (
				<p className="text-muted-foreground text-sm">{t("empty")}</p>
			) : (
				<RadioGroup onValueChange={setChosen} value={selected}>
					{list.map((organization) => (
						<div
							key={organization.id}
							className="flex items-center gap-3 rounded-lg border border-border p-3"
						>
							<RadioGroupItem
								id={`oauth-org-${organization.id}`}
								value={organization.id}
							/>
							<Label
								className="flex-1 cursor-pointer"
								htmlFor={`oauth-org-${organization.id}`}
							>
								{organization.name}
							</Label>
						</div>
					))}
				</RadioGroup>
			)}

			{failed ? (
				<Alert variant="error">
					<AlertDescription>{t("failed")}</AlertDescription>
				</Alert>
			) : null}

			<Button
				autoLoading={false}
				disabled={pending || selected === ""}
				loading={pending}
				onClick={proceed}
			>
				{pending ? t("working") : t("continue")}
			</Button>
		</div>
	);
}
