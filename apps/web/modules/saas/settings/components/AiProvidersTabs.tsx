"use client";

import { PERSONAL_AI_PROVIDERS_TAB } from "@saas/settings/lib/personal-ai-providers-path";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

type AiProvidersTab = "organization" | "personal";

/** Anything other than `personal` — absent, stale, mistyped — is the organization's tab. */
function parseTab(value: string | null): AiProvidersTab {
	return value === PERSONAL_AI_PROVIDERS_TAB ? "personal" : "organization";
}

/**
 * The organization's provider keys and the member's own, on one page (Fizzy
 * #3082). The tab lives in the URL so the notices in the app chrome can link
 * straight to the Personal tab.
 *
 * Controlled from the URL rather than seeded once: a link to `?tab=personal`
 * followed while this page is already open is a soft navigation that does not
 * remount it, so an uncontrolled tab would stay where it was.
 */
export function AiProvidersTabs({
	organization,
	personal,
}: {
	organization: ReactNode;
	personal: ReactNode;
}) {
	const t = useTranslations("settings.aiProviders.tabs");
	const router = useRouter();
	const pathname = usePathname();
	const searchParams = useSearchParams();
	const tab = parseTab(searchParams.get("tab"));

	const select = (value: string) => {
		const query = new URLSearchParams(searchParams.toString());
		if (value === PERSONAL_AI_PROVIDERS_TAB) {
			query.set("tab", PERSONAL_AI_PROVIDERS_TAB);
		} else {
			query.delete("tab");
		}
		const qs = query.toString();
		router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
	};

	return (
		<Tabs value={tab} onValueChange={select} className="mt-4 w-full">
			<TabsList aria-label={t("label")}>
				<TabsTrigger value="organization">
					{t("organization")}
				</TabsTrigger>
				<TabsTrigger value="personal">{t("personal")}</TabsTrigger>
			</TabsList>
			<TabsContent value="organization" className="mt-0">
				{organization}
			</TabsContent>
			<TabsContent value="personal" className="mt-0">
				{personal}
			</TabsContent>
		</Tabs>
	);
}
