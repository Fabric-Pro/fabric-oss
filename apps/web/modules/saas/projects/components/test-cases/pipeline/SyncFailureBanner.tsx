"use client";

import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { TriangleAlertIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { navigateToProjectSettingsTab } from "../../settings-tab-navigation";
import type { FreshnessView } from "./freshness";

/**
 * A failed pipeline sync, as a banner rather than a sentence.
 *
 * This used to be one inline `<span>` inside the freshness line, which was
 * adequate while the error was short. Once the provider clients started
 * reporting the real cause, the same line had to carry a classified explanation
 * AND the provider's raw JSON, and it became a wall of text wrapped across the
 * panel header — the most important message on the screen rendered as the least
 * readable thing on it.
 *
 * So: the readable sentence is the banner, and the raw body is behind a hover.
 * A person triaging needs to know which repo broke and what to do; a person
 * debugging needs GitHub's exact words. Those are different readers and the
 * banner should not make either one read the other's content.
 *
 * Tone follows the failure, not the feature: ALL sources failing is an error,
 * some-but-not-all is a warning, because a sync that still ingested runs from
 * three of four repos has not failed.
 *
 * `failure.reconnectFixes` gates a reconnect link (card #2383's banner
 * follow-through): true only for a missing or rejected credential, where
 * reconnecting is genuinely the fix. A missing-permission or SSO failure keeps
 * rendering exactly what it did before — a reconnect button there would send
 * someone through an OAuth round trip that changes nothing.
 */
export function SyncFailureBanner({
	failure,
	projectId,
}: {
	failure: NonNullable<FreshnessView["failure"]>;
	/** Which project's Settings ▸ Development tab the reconnect link opens. */
	projectId: string;
}) {
	const t = useTranslations("projects.stories.maturation.qa.pipelineRuns");

	return (
		<Alert variant={failure.tone === "error" ? "error" : "warning"}>
			<TriangleAlertIcon aria-hidden="true" />
			<AlertTitle>
				{failure.total
					? t("sourceErrorTitle")
					: t("sourcePartialErrorTitle", {
							failed: failure.failedCount,
							total: failure.sourceCount,
						})}
			</AlertTitle>
			<AlertDescription>
				{/* Naming the source matters most on exactly the projects where
				    this banner is ambiguous — several repos connected, one of them
				    broken. Without it the reader knows something failed and has no
				    idea which thing. */}
				{failure.sourceLabel && (
					<p className="font-medium font-mono text-xs opacity-80">
						{failure.sourceLabel}
					</p>
				)}
				<p>{failure.error}</p>

				{failure.errorDetail && (
					<Tooltip>
						<TooltipTrigger asChild>
							{/* A button, not a bare span: the raw body has to be
							    reachable by keyboard, and Radix opens a tooltip on
							    focus as well as hover. `type="button"` because this
							    banner can sit inside a form. */}
							<button
								type="button"
								className="mt-1 cursor-help font-medium text-xs underline decoration-dotted underline-offset-2"
							>
								{t("showRawError")}
							</button>
						</TooltipTrigger>
						<TooltipContent
							side="bottom"
							align="start"
							className="max-w-[32rem]"
						>
							{/* Monospace and wrapped: this is a JSON body or an HTML
							    error page, and reflowing it as prose makes it harder
							    to read than the sentence it is meant to substantiate. */}
							<p className="whitespace-pre-wrap break-all font-mono text-xs">
								{failure.errorDetail}
							</p>
						</TooltipContent>
					</Tooltip>
				)}

				{failure.reconnectFixes && (
					<Button
						type="button"
						size="sm"
						variant="outline"
						onClick={() =>
							navigateToProjectSettingsTab(
								projectId,
								"development",
							)
						}
						className="mt-2"
					>
						{t("reconnectCta")}
					</Button>
				)}
			</AlertDescription>
		</Alert>
	);
}
