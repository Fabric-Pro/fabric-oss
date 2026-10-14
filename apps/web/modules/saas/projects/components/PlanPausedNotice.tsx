"use client";

import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import { format } from "date-fns";
import { Loader2Icon, PauseCircleIcon } from "lucide-react";
import { useTranslations } from "next-intl";

/**
 * A bulk run — a scan, its review or grouping, a batch generation — paused
 * because every shared ChatGPT plan it may use is spent (Fizzy #2770). It
 * saved its progress and resumes at `resumesAt`; meanwhile the person may
 * cancel it, or, when the organization has an AI provider of its own, an
 * admin or owner may run it now on that provider for this run only; anyone
 * else is told to ask one.
 */
export function PlanPausedNotice({
	resumesAt,
	pendingDocumentCount,
	canRunOnApi,
	askAdminToRunOnApi = false,
	onCancel,
	onRunNow,
	cancelling = false,
	runningNow = false,
	inline = false,
	subject,
}: {
	resumesAt: Date | string | null | undefined;
	/** A batch generation's documents still to write. */
	pendingDocumentCount?: number;
	canRunOnApi: boolean;
	/** The organization could bill it, but the viewer is not an admin or owner. */
	askAdminToRunOnApi?: boolean;
	onCancel: () => void;
	onRunNow: () => void;
	cancelling?: boolean;
	runningNow?: boolean;
	/** One line for a toolbar (a review or grouping run), not a banner. */
	inline?: boolean;
	/** What paused, for a banner the page does not otherwise name. */
	subject?: string;
}) {
	const t = useTranslations("projects.planPause");
	const resumes = resumesAt ? new Date(resumesAt) : null;
	const busy = cancelling || runningNow;
	const when = resumes
		? t("resumesAt", { time: format(resumes, "HH:mm") })
		: t("resumesSoon");

	if (inline) {
		return (
			<span
				className="inline-flex flex-wrap items-center gap-2 text-sm"
				data-testid="plan-paused-notice"
			>
				<output className="inline-flex items-center gap-1.5 text-muted-foreground">
					<PauseCircleIcon aria-hidden="true" className="size-4" />
					<span title={t("body")}>
						{t("title")} · {when}
					</span>
				</output>
				<Button
					variant="ghost"
					size="sm"
					onClick={onCancel}
					disabled={busy}
				>
					{t("cancel")}
				</Button>
				{canRunOnApi ? (
					<Button
						variant="outline"
						size="sm"
						onClick={onRunNow}
						disabled={busy}
						title={t("runNowHint")}
					>
						{t("runNow")}
					</Button>
				) : askAdminToRunOnApi ? (
					<span className="text-muted-foreground text-xs">
						{t("askAdmin")}
					</span>
				) : null}
			</span>
		);
	}

	return (
		<Alert variant="warning" data-testid="plan-paused-notice">
			<PauseCircleIcon aria-hidden="true" className="size-4" />
			<AlertTitle>
				{subject ? `${subject} · ` : null}
				{t("title")} · {when}
			</AlertTitle>
			<AlertDescription className="space-y-3">
				<p>
					{t("body")}
					{pendingDocumentCount !== undefined
						? ` ${t("pendingDocuments", { count: pendingDocumentCount })}`
						: null}
				</p>
				<div className="flex flex-wrap items-center gap-2">
					<Button
						variant="outline"
						size="sm"
						onClick={onCancel}
						disabled={busy}
					>
						{cancelling ? (
							<Loader2Icon
								aria-hidden="true"
								className="size-4 motion-safe:animate-spin"
							/>
						) : null}
						{t("cancel")}
					</Button>
					{canRunOnApi ? (
						<Button size="sm" onClick={onRunNow} disabled={busy}>
							{runningNow ? (
								<Loader2Icon
									aria-hidden="true"
									className="size-4 motion-safe:animate-spin"
								/>
							) : null}
							{t("runNow")}
						</Button>
					) : null}
				</div>
				{canRunOnApi ? (
					<p className="text-muted-foreground text-xs">
						{t("runNowHint")}
					</p>
				) : askAdminToRunOnApi ? (
					<p className="text-muted-foreground text-xs">
						{t("askAdmin")}
					</p>
				) : null}
			</AlertDescription>
		</Alert>
	);
}
