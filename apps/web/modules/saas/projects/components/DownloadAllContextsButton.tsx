"use client";

/**
 * DownloadAllContextsButton — streams every context in a project into a
 * single ZIP archive via `projects.contexts.createBatchDownloadUrl` and hands
 * the presigned URL to the browser.
 *
 * Spec: `docs/specs/2026-04-15-download-project-context-files/spec.md` §7.2.
 * Telemetry: emits the four PostHog events from §9.
 * A11y: spec §7.3 — disabled-but-focusable, `aria-describedby` hint, hidden
 * `aria-live` region for completion / failure announcements.
 */

import { useAnalytics } from "@analytics";
import { orpc } from "@shared/lib/orpc-query-utils";
import { Button } from "@ui/components/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { DownloadIcon, Loader2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useId, useState } from "react";
import { toast } from "sonner";

type Props = {
	projectId: string;
	organizationId: string | null;
	totalContexts: number;
	totalBytesEstimate: number;
};

const CLIENT_BATCH_TIMEOUT_MS = 60_000;

function triggerBrowserDownload(url: string, filename: string): void {
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = filename;
	anchor.rel = "noopener";
	document.body.appendChild(anchor);
	anchor.click();
	document.body.removeChild(anchor);
}

type BatchFailReason =
	| "too_large"
	| "too_many"
	| "client_timeout"
	| "server_error";

function mapErrorToReason(err: unknown): BatchFailReason {
	const data = (err as { data?: { reason?: string } } | undefined)?.data;
	if (data?.reason === "too_large" || data?.reason === "too_many") {
		return data.reason;
	}
	return "server_error";
}

export function DownloadAllContextsButton({
	projectId,
	organizationId,
	totalContexts,
	totalBytesEstimate,
}: Props) {
	const t = useTranslations("projects.contexts.download");
	const { trackEvent } = useAnalytics();
	const [isPreparing, setIsPreparing] = useState(false);
	const [liveMessage, setLiveMessage] = useState("");
	const emptyHintId = useId();

	const isEmpty = totalContexts === 0;
	const disabled = isEmpty || isPreparing;

	const handleClick = useCallback(async () => {
		if (disabled) {
			return;
		}

		trackEvent("project_contexts_download_all_started", {
			projectId,
			totalContexts,
			totalBytesEstimate,
			organizationId,
		});

		const startedAt = Date.now();
		const controller = new AbortController();
		const timeoutId = setTimeout(() => {
			controller.abort();
		}, CLIENT_BATCH_TIMEOUT_MS);

		setIsPreparing(true);
		setLiveMessage("");

		try {
			const result =
				await orpc.projects.contexts.createBatchDownloadUrl.call(
					{ projectId, organizationId },
					{ signal: controller.signal },
				);

			triggerBrowserDownload(result.url, result.filename);

			const completedMsg = t("completed", {
				included: result.includedCount,
				total: result.totalCount,
			});
			const skippedMsg =
				result.skippedCount > 0
					? t("skipped", { skipped: result.skippedCount })
					: "";
			const announce = skippedMsg
				? `${completedMsg} — ${skippedMsg}`
				: completedMsg;

			setLiveMessage(announce);
			toast.success(announce);

			trackEvent("project_contexts_download_all_completed", {
				projectId,
				includedFiles: result.includedCount,
				skippedFiles: result.skippedCount,
				durationMs: Date.now() - startedAt,
			});
		} catch (err) {
			const aborted =
				controller.signal.aborted ||
				(err instanceof DOMException && err.name === "AbortError");

			if (aborted) {
				const failMsg = t("failed");
				setLiveMessage(failMsg);
				toast.error(failMsg);
				trackEvent("project_contexts_download_all_failed", {
					projectId,
					reason: "client_timeout" satisfies BatchFailReason,
				});
			} else {
				const reason = mapErrorToReason(err);
				const data = (
					err as { data?: Record<string, unknown> } | undefined
				)?.data;
				const toastMsg =
					reason === "too_large" || reason === "too_many"
						? t("tooLarge", {
								count: Number(data?.count ?? totalContexts),
								size: String(data?.size ?? totalBytesEstimate),
								maxCount: Number(data?.maxCount ?? 0),
								maxSize: String(data?.maxSize ?? 0),
							})
						: t("failed");
				setLiveMessage(toastMsg);
				toast.error(toastMsg);
				trackEvent("project_contexts_download_all_failed", {
					projectId,
					reason,
				});
			}
		} finally {
			clearTimeout(timeoutId);
			setIsPreparing(false);
		}
	}, [
		disabled,
		organizationId,
		projectId,
		t,
		totalBytesEstimate,
		totalContexts,
		trackEvent,
	]);

	const label = isPreparing ? t("preparingAria") : t("downloadAllAria");

	const buttonNode = (
		<Button
			type="button"
			variant="outline"
			size="sm"
			onClick={handleClick}
			autoLoading={false}
			aria-disabled={disabled}
			aria-label={label}
			aria-describedby={isEmpty ? emptyHintId : undefined}
			className="gap-2"
		>
			{isPreparing ? (
				<Loader2Icon
					className="size-4 motion-safe:animate-spin"
					aria-hidden="true"
				/>
			) : (
				<DownloadIcon className="size-4" aria-hidden="true" />
			)}
			{isPreparing ? t("preparing") : t("downloadAll")}
		</Button>
	);

	return (
		<div className="inline-flex items-center">
			{isEmpty ? (
				<TooltipProvider>
					<Tooltip>
						<TooltipTrigger asChild>
							<span tabIndex={-1}>{buttonNode}</span>
						</TooltipTrigger>
						<TooltipContent>{t("empty")}</TooltipContent>
					</Tooltip>
				</TooltipProvider>
			) : (
				buttonNode
			)}
			{isEmpty && (
				<span id={emptyHintId} className="sr-only">
					{t("empty")}
				</span>
			)}
			<span className="sr-only" aria-live="polite" aria-atomic="true">
				{liveMessage}
			</span>
		</div>
	);
}
