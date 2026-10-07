"use client";

/**
 * FailedBriefState — shown when the Daily Brief workflow failed (status = FAILED).
 */

import { useActiveOrganization } from "@saas/organizations/hooks/use-active-organization";
import { AI_PROVIDER_NOT_CONFIGURED } from "@saas/shared/lib/ai-provider-missing";
import { Button } from "@ui/components/button";
import { AlertTriangleIcon, RefreshCwIcon, SettingsIcon } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";

/** The failure explained, with the way to fix it. */
function ProviderMissingDetails() {
	const t = useTranslations("app.aiProviderMissing");
	const { activeOrganization } = useActiveOrganization();
	return (
		<>
			<p
				className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground"
				data-testid="brief-provider-missing"
			>
				<span className="block font-medium text-foreground">
					{t("title")}
				</span>
				{t("body")}
			</p>
			{activeOrganization?.slug ? (
				<div className="mt-6">
					<Button asChild variant="editorial">
						<Link
							href={`/app/${activeOrganization.slug}/settings/ai-providers`}
						>
							<SettingsIcon
								className="size-3.5"
								aria-hidden="true"
							/>
							{t("configure")}
						</Link>
					</Button>
				</div>
			) : null}
		</>
	);
}

export interface FailedBriefStateProps {
	/** Optional error message from the workflow. */
	errorMessage?: string;
	/** Called when the user clicks Regenerate. */
	onRegenerate?: () => void;
}

export function FailedBriefState({
	errorMessage,
	onRegenerate,
}: FailedBriefStateProps) {
	return (
		<div
			role="alert"
			className="rounded-2xl border border-destructive/40 bg-destructive/5 p-12 text-center"
		>
			<div className="mx-auto flex size-12 items-center justify-center rounded-full border border-destructive/40 bg-destructive/10">
				<AlertTriangleIcon
					className="size-6 text-destructive"
					aria-hidden="true"
				/>
			</div>
			<h2 className="mt-5 font-serif text-2xl font-normal leading-tight text-foreground">
				Your brief couldn't be generated
			</h2>
			{errorMessage === AI_PROVIDER_NOT_CONFIGURED ? (
				<ProviderMissingDetails />
			) : (
				<p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">
					{errorMessage ??
						"Something went wrong while pulling activity from your project sources. No data has been discarded — you can regenerate the brief and try again."}
				</p>
			)}
			{onRegenerate ? (
				<div className="mt-6">
					<Button variant="editorial" onClick={onRegenerate}>
						<RefreshCwIcon
							className="size-3.5"
							aria-hidden="true"
						/>
						Regenerate
					</Button>
				</div>
			) : null}
		</div>
	);
}
