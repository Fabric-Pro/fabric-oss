"use client";

import { Button } from "@ui/components/button";
import { useTranslations } from "next-intl";
import {
	navigateToProjectSettingsTab,
	REPOSITORY_SETTINGS_ANCHOR_ID,
} from "../settings-tab-navigation";

export type RepositoryUnavailability =
	| "DISCONNECTED"
	| "CREDENTIALS_EXPIRED"
	| "NOT_FOUND"
	| "UNAVAILABLE";

const MESSAGE_KEYS = {
	DISCONNECTED: "disconnected",
	CREDENTIALS_EXPIRED: "credentialsExpired",
	NOT_FOUND: "notFound",
	UNAVAILABLE: "unavailable",
} as const satisfies Record<RepositoryUnavailability, string>;

export function RepositoryUnavailableNotice({
	projectId,
	availability,
}: {
	projectId: string;
	availability: RepositoryUnavailability;
}) {
	const t = useTranslations("projects.codingInstructions.direct");
	return (
		<div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-4 text-sm">
			<output>{t(MESSAGE_KEYS[availability])}</output>
			{availability === "CREDENTIALS_EXPIRED" ? (
				<Button
					type="button"
					size="sm"
					onClick={() =>
						navigateToProjectSettingsTab(projectId, "development", {
							anchorId: REPOSITORY_SETTINGS_ANCHOR_ID,
						})
					}
				>
					{t("reconnect")}
				</Button>
			) : null}
		</div>
	);
}
