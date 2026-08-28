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
 *
 * Reporting what did not make it in (Fizzy #2228): the server classifies
 * every skipped row and returns a count per reason. This renders one line per
 * reason that actually occurred, into the success toast's description slot
 * beneath the completion title — no new control on the Context tab. The
 * screen-reader announcement carries the same lines joined into one sentence,
 * so the two surfaces say exactly the same thing.
 *
 * The single sentence this replaces — *"N were skipped (still processing or
 * unavailable)"* — was the only summary available for six different
 * situations, and after the item ceiling started truncating rather than
 * refusing, it described a deliberate cut as a processing delay.
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

/**
 * `too_many` is deliberately absent. A project holding more contexts than the
 * batch ceiling no longer gets refused — the server truncates, ships an
 * archive, and names every excluded item in the manifest (Fizzy #2228), so
 * nothing produces that reason any more. `too_large` remains a genuine
 * refusal: an archive too heavy to build cannot be handed back partial.
 */
type BatchFailReason = "too_large" | "client_timeout" | "server_error";

function mapErrorToReason(err: unknown): BatchFailReason {
	const data = (err as { data?: { reason?: string } } | undefined)?.data;
	if (data?.reason === "too_large") {
		return "too_large";
	}
	return "server_error";
}

/**
 * The reasons a context can miss the archive, in the order they are shown.
 *
 * Mirrors `CONTEXT_SKIP_REASON_CODES` in
 * `packages/api/modules/projects/lib/context-skip-reason.ts`, which is where
 * the taxonomy is defined and tested. Listed again here — rather than
 * imported — because this module renders i18n copy keyed by code and must not
 * pull a server module into the client bundle. A code the server adds but this
 * list has not caught up with is silently not rendered, so the two move
 * together; the reverse (a code here the server never sends) simply counts
 * zero and prints nothing.
 */
const SKIP_REASON_CODES = [
	"NOTHING_STORED",
	"EXTRACTION_FAILED",
	"EXTRACTION_CANCELLED",
	"CONVERSATION_NOT_CAPTURED",
	"PRIVATE_CONVERSATION_EXCLUDED",
	"CRAWL_INDEXED_NO_PAGES",
	"OBJECT_MISSING",
	"STORAGE_READ_FAILED",
	"BEYOND_ITEM_LIMIT",
] as const;

type SkipReasonCode = (typeof SKIP_REASON_CODES)[number];

/**
 * The reasons that actually occurred, in display order. A reason counting
 * zero is dropped here — the whole point of the taxonomy is that the summary
 * names what happened, not everything that could have.
 */
function presentSkipReasons(
	skippedByReason: Partial<Record<SkipReasonCode, number>> | undefined,
): Array<{ code: SkipReasonCode; count: number }> {
	if (!skippedByReason) {
		return [];
	}
	return SKIP_REASON_CODES.flatMap((code) => {
		const count = skippedByReason[code] ?? 0;
		return count > 0 ? [{ code, count }] : [];
	});
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
			// Read defensively rather than off the inferred contract: during a
			// rollout the deployed server may still be the one that returned
			// counts without a taxonomy, and inventing a reason for it would
			// be the same class of lie this replaces. `presentSkipReasons`
			// treats an absent tally as "nothing to add".
			const reasonLines = presentSkipReasons(
				(
					result as {
						skippedByReason?: Partial<
							Record<SkipReasonCode, number>
						>;
					}
				).skippedByReason,
			).map(({ code, count }) => t(`skippedReason.${code}`, { count }));

			// The announcement is the visible summary read as one sentence:
			// the completion line, then the same per-reason lines joined. A
			// screen-reader user hears exactly what a sighted user reads.
			setLiveMessage(
				reasonLines.length > 0
					? `${completedMsg} — ${reasonLines.join("; ")}`
					: completedMsg,
			);
			toast.success(completedMsg, {
				description:
					reasonLines.length > 0 ? (
						<ul className="mt-1 list-none space-y-0.5 p-0">
							{reasonLines.map((line) => (
								<li key={line}>{line}</li>
							))}
						</ul>
					) : undefined,
			});

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
					reason === "too_large"
						? t("tooLarge", {
								size: String(data?.size ?? totalBytesEstimate),
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

	// No layout wrapper: `Button` already carries `inline-flex items-center`
	// from `buttonVariants`, and the `sr-only` spans are absolutely positioned,
	// so they are out of flow and never become flex items of the toolbar this
	// renders into. The trigger is the `Button` itself — it is `aria-disabled`,
	// never DOM-`disabled`, so it still receives the pointer and focus events
	// the tooltip opens on, and needs no focusable stand-in.
	return (
		<>
			{isEmpty ? (
				<TooltipProvider>
					<Tooltip>
						<TooltipTrigger asChild>{buttonNode}</TooltipTrigger>
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
		</>
	);
}
