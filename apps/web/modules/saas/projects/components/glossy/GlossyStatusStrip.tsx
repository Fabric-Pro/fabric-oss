"use client";

import { Alert, AlertDescription } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import { Progress } from "@ui/components/progress";
import { Loader2Icon } from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { GlossyEdition } from "../../hooks/use-glossy-edition";
import {
	glossyErrorKey,
	glossyIneligibleKey,
	glossyKeptOriginalKey,
	glossyKindKey,
	glossyReasonKey,
	glossyStepKey,
} from "./glossy-copy";

type GlossyStatusStripProps = {
	data: GlossyEdition;
	/** A build, detect, or regenerate answered that no AI provider resolves (R10, AE6). */
	providerNotConfigured: boolean;
	/** Where the configure-provider link points. */
	aiProvidersHref: string;
	/** Retry or Rebuild, the same action as the toolbar's; null for viewers. */
	onBuild: (() => void) | null;
	/**
	 * A build cannot start right now — one runs or is starting, detection
	 * runs, the Align-first form is open, or the document is ineligible — so
	 * Retry and Rebuild wait.
	 */
	buildDisabled: boolean;
};

/**
 * The Glossy page's status strip (Fizzy #2589, R7, R9, R10, R16, R21, R22,
 * KTD5, KTD11): build progress and who started it, a failed first build or
 * rebuild with Retry, the out-of-date notice, and — for editors — the build
 * report: sections kept in original wording, visuals left out, unfilled
 * slots, a document with no suggestions, and unrecognized scaffolding.
 */
export function GlossyStatusStrip({
	data,
	providerNotConfigured,
	aiProvidersHref,
	onBuild,
	buildDisabled,
}: GlossyStatusStripProps) {
	const t = useTranslations("projects.glossy");
	const format = useFormatter();
	const { build, edition, canEdit } = data;
	const content = edition?.content ?? null;
	const items: ReactNode[] = [];

	const startedBy = (ref: { name: string | null } | null) =>
		ref?.name ?? t("status.someone");

	if (build.status === "building") {
		const total = build.sectionsTotal;
		const percent =
			total && total > 0
				? Math.round((build.sectionsDone / total) * 100)
				: null;
		items.push(
			<Alert key="building" variant="primary" role="status">
				<AlertDescription className="mt-0 space-y-2">
					<p className="flex items-center gap-2 font-medium">
						<Loader2Icon
							className="size-4 animate-spin"
							aria-hidden="true"
						/>
						{t("status.building", {
							step: t(
								`status.steps.${glossyStepKey(build.step)}`,
							),
						})}
					</p>
					<p>
						{t("status.startedBy", {
							name: startedBy(build.startedBy),
							// `now` explicitly: without it next-intl reports an
							// environment fallback. The poll re-renders it.
							time: format.relativeTime(
								new Date(build.startedAt),
								new Date(),
							),
						})}
					</p>
					{total !== null && total > 0 && (
						<>
							<p>
								{t("status.progress", {
									done: build.sectionsDone,
									total,
								})}
							</p>
							<Progress
								value={percent ?? 0}
								className="h-2"
								aria-label={t("status.progressLabel")}
							/>
						</>
					)}
				</AlertDescription>
			</Alert>,
		);
	}

	if (build.status === "failed") {
		const errorKey = glossyErrorKey(build.errorCode);
		const headline = build.stuck
			? t("status.stuck")
			: content
				? t("status.lastRebuildFailed")
				: t("status.firstBuildFailed");
		items.push(
			<Alert key="failed" variant="error" role="status">
				<AlertDescription className="mt-0 flex flex-wrap items-center gap-3">
					<span className="flex-1 space-y-1">
						<span className="block font-medium">{headline}</span>
						{!build.stuck && (
							<span className="block">
								{t(`status.errors.${errorKey}`)}
							</span>
						)}
					</span>
					{onBuild && (
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={buildDisabled}
							onClick={onBuild}
						>
							{build.stuck && content
								? t("toolbar.rebuild")
								: t("toolbar.retry")}
						</Button>
					)}
				</AlertDescription>
			</Alert>,
		);
	}

	const providerMissing =
		providerNotConfigured ||
		(build.status === "failed" &&
			build.errorCode === "AI_PROVIDER_NOT_CONFIGURED");
	if (providerMissing && canEdit) {
		items.push(
			<Alert key="provider" variant="warning">
				<AlertDescription className="mt-0 space-y-1">
					<p className="font-medium">{t("provider.title")}</p>
					<p>{t("provider.body")}</p>
					<Link
						href={aiProvidersHref}
						className="font-medium underline underline-offset-4"
					>
						{t("provider.link")}
					</Link>
				</AlertDescription>
			</Alert>,
		);
	}

	if (!data.eligibility.eligible) {
		items.push(
			<Alert key="ineligible" variant="warning" role="status">
				<AlertDescription className="mt-0">
					{t(
						`ineligible.${glossyIneligibleKey(data.eligibility.reason)}`,
					)}
				</AlertDescription>
			</Alert>,
		);
	}

	if (edition?.outOfDate && content) {
		items.push(
			<Alert key="outOfDate" variant="warning" role="status">
				<AlertDescription className="mt-0 flex flex-wrap items-center gap-3">
					<span className="flex-1 space-y-1">
						<span className="block font-medium">
							{t("status.outOfDate")}
						</span>
						<span className="block">
							{canEdit
								? t("status.outOfDateEditor")
								: t("status.outOfDateViewer")}
						</span>
					</span>
					{onBuild && (
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={buildDisabled}
							onClick={onBuild}
						>
							{t("toolbar.rebuild")}
						</Button>
					)}
				</AlertDescription>
			</Alert>,
		);
	}

	if (content && canEdit) {
		const { report } = content;
		const suggested = Object.values(content.visuals).filter(
			(visual) => visual.source !== "existing_mermaid",
		).length;

		if (report.keptOriginal.length > 0) {
			items.push(
				<ReportNotice
					key="keptOriginal"
					title={t("report.keptOriginal", {
						count: report.keptOriginal.length,
					})}
					help={t("report.keptOriginalHelp")}
					entries={report.keptOriginal.map((entry) =>
						t("report.entry", {
							subject:
								entry.heading ?? t("report.untitledSection"),
							reason: t(
								`report.keptOriginalReasons.${glossyKeptOriginalKey(entry.reason)}`,
							),
						}),
					)}
				/>,
			);
		}
		if (report.droppedVisuals.length > 0) {
			items.push(
				<ReportNotice
					key="droppedVisuals"
					title={t("report.droppedVisuals", {
						count: report.droppedVisuals.length,
					})}
					entries={report.droppedVisuals.map((entry) =>
						t("report.droppedEntry", {
							kind: t(
								`visual.kinds.${glossyKindKey(entry.kind)}`,
							),
							section:
								entry.heading ?? t("report.untitledSection"),
							reason: t(
								`report.dropReasons.${glossyReasonKey(entry.reason)}`,
							),
						}),
					)}
				/>,
			);
		}
		if (report.unfilledSlots.length > 0) {
			items.push(
				<ReportNotice
					key="unfilledSlots"
					title={t("report.unfilledSlots", {
						count: report.unfilledSlots.length,
					})}
					entries={report.unfilledSlots.map((entry) =>
						t("report.slotEntry", {
							reason: t(
								`report.dropReasons.${glossyReasonKey(entry.reason)}`,
							),
						}),
					)}
				/>,
			);
		}
		if (
			suggested === 0 &&
			report.droppedVisuals.length === 0 &&
			report.unfilledSlots.length === 0
		) {
			items.push(
				<ReportNotice
					key="noSuggestions"
					title={t("report.noSuggestions")}
				/>,
			);
		}
		if (report.scaffoldingUnrecognized) {
			items.push(
				<ReportNotice
					key="scaffolding"
					title={t("report.scaffoldingUnrecognized")}
				/>,
			);
		}
	}

	if (items.length === 0) {
		return null;
	}
	return (
		<section aria-label={t("status.region")} className="space-y-3">
			{items}
		</section>
	);
}

function ReportNotice({
	title,
	help,
	entries,
}: {
	title: string;
	help?: string;
	entries?: string[];
}) {
	return (
		<Alert variant="default" role="status">
			<AlertDescription className="mt-0 space-y-1">
				<p className="font-medium">{title}</p>
				{help && <p className="text-muted-foreground">{help}</p>}
				{entries && entries.length > 0 && (
					<ul className="list-disc space-y-0.5 pl-5">
						{entries.map((entry, index) => (
							// Report entries have no identity beyond their position.
							<li key={index}>{entry}</li>
						))}
					</ul>
				)}
			</AlertDescription>
		</Alert>
	);
}
