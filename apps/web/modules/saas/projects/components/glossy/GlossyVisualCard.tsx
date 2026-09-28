"use client";

import type { EditionVisual } from "@repo/utils/glossy/edition-content";
import { visualSpecFacts } from "@repo/utils/glossy/visual-spec";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Skeleton } from "@ui/components/skeleton";
import {
	CheckIcon,
	ImageOffIcon,
	Loader2Icon,
	RefreshCwIcon,
	RotateCcwIcon,
	XIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useId } from "react";
import type { GlossyVisualDecision } from "../../hooks/use-glossy-edition";
import type { RenderedGlossyVisual } from "../../lib/glossy/visual-render";
import { glossyKindKey, glossyReasonKey } from "./glossy-copy";

/** What the last action on this visual answered, shown on the card itself. */
export type GlossyVisualNotice =
	/** The replacement failed its checks; the previous visual is kept (R18). */
	| { kind: "noValidReplacement"; reason: string }
	/** A build holds the edition; `stuck` offers Rebuild rather than a wait. */
	| { kind: "building"; startedBy: string | null; stuck: boolean }
	/** Accept named a spec that was regenerated since the page loaded. */
	| { kind: "visualChanged" }
	/** Built under older pipeline rules; only a rebuild refreshes it. */
	| { kind: "rebuildRequired" }
	/** The server says this visual is restyled, not extracted. */
	| { kind: "notRegenerable" };

type GlossyVisualCardProps = {
	visualKey: string;
	visual: EditionVisual;
	/** `undefined` while it renders; `null` when it could not render (KTD15). */
	image: RenderedGlossyVisual | null | undefined;
	/** The review decision; `null` is pending, and included (R28). */
	decision: GlossyVisualDecision | null;
	/** Editors review; everyone else sees the visual as it will download (R5). */
	canEdit: boolean;
	/** A build holds the edition: Regenerate waits for it. Review does not. */
	buildRunning: boolean;
	/** This card's own regenerate is in flight. */
	regenerating: boolean;
	/** This card's own review is in flight. */
	reviewing: boolean;
	/** The server answered that this visual cannot be regenerated. */
	regenerateUnavailable?: boolean;
	notice?: GlossyVisualNotice | null;
	onAccept: () => void;
	onDiscard: () => void;
	onRestore: () => void;
	onRegenerate: () => void;
	/** Start a rebuild, offered when a stuck build or older rules hold the edition. */
	onRebuild?: () => void;
	/** A build cannot start from here right now: the notice's Rebuild waits. */
	rebuildDisabled?: boolean;
};

/**
 * One visual of the Glossy edition in the preview, beside the text it
 * illustrates (Fizzy #2589, R19, R26–R29).
 *
 * Editors see its review state and Accept, Regenerate, Discard, and Restore.
 * Everyone else sees exactly what the download carries: the image, and
 * nothing at all for a discarded visual. The detection reason is model
 * output and renders as plain text only (KTD13).
 */
export function GlossyVisualCard({
	visualKey,
	visual,
	image,
	decision,
	canEdit,
	buildRunning,
	regenerating,
	reviewing,
	regenerateUnavailable = false,
	notice = null,
	onAccept,
	onDiscard,
	onRestore,
	onRegenerate,
	onRebuild,
	rebuildDisabled = false,
}: GlossyVisualCardProps) {
	const t = useTranslations("projects.glossy.visual");
	const captionId = useId();
	const discarded = decision === "DISCARDED";

	// A discarded visual is left out of downloads (R29); a viewer sees the
	// edition as it downloads, so there is nothing to show them.
	if (discarded && !canEdit) {
		return null;
	}

	const kindLabel = t(`kinds.${glossyKindKey(visual.kind)}`);
	const labels = visualSpecFacts(visual.spec).labels.slice(0, 12);
	const alt =
		labels.length > 0
			? t("alt", { kind: kindLabel, labels: labels.join("; ") })
			: t("altNoLabels", { kind: kindLabel });
	// An existing diagram is restyled, not extracted (R19): nothing to regenerate.
	const canRegenerate =
		visual.source !== "existing_mermaid" && !regenerateUnavailable;
	const busy = regenerating || reviewing;

	const status = discarded
		? { label: t("status.discarded"), variant: "secondary" as const }
		: decision === "ACCEPTED"
			? { label: t("status.accepted"), variant: "success" as const }
			: { label: t("status.pending"), variant: "info" as const };

	return (
		// For editors the caption names the figure, so its buttons read in context.
		<figure
			className="not-prose my-6 space-y-3 rounded-lg border border-border bg-card p-4"
			data-visual-key={visualKey}
			aria-labelledby={canEdit ? captionId : undefined}
		>
			{discarded ? (
				<p className="text-muted-foreground text-sm">
					{t("discardedNote")}
				</p>
			) : image === undefined ? (
				<div className="space-y-2">
					<Skeleton className="h-40 w-full" />
					<p className="sr-only">{t("rendering")}</p>
				</div>
			) : image === null ? (
				<div className="flex items-start gap-3 rounded-md border border-border border-dashed bg-muted p-4 text-sm">
					<ImageOffIcon
						className="mt-0.5 size-4 shrink-0 text-muted-foreground"
						aria-hidden="true"
					/>
					<p>
						{canEdit
							? t("couldNotRender")
							: t("couldNotRenderViewer")}
					</p>
				</div>
			) : (
				// biome-ignore lint/performance/noImgElement: a PNG data URL rasterized in the browser, which next/image cannot optimize
				<img
					src={image.dataUrl}
					alt={alt}
					width={image.width}
					height={image.height}
					className="mx-auto h-auto max-w-full"
				/>
			)}

			{canEdit && (
				<figcaption id={captionId} className="space-y-1 text-sm">
					<span className="flex flex-wrap items-center gap-2">
						<span className="font-medium">{kindLabel}</span>
						<Badge variant={status.variant}>{status.label}</Badge>
					</span>
					{visual.source === "slot" && (
						<span className="block text-muted-foreground">
							{t("fromSlot")}
						</span>
					)}
					{visual.source === "existing_mermaid" && (
						<span className="block text-muted-foreground">
							{t("restyled")}
						</span>
					)}
					{/* Model output: plain text, never markup (KTD13). */}
					{visual.reason && (
						<span className="block text-muted-foreground">
							{visual.reason}
						</span>
					)}
				</figcaption>
			)}

			{canEdit && (
				<div className="flex flex-wrap items-center gap-2">
					{discarded ? (
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={busy}
							onClick={onRestore}
						>
							<RotateCcwIcon
								className="size-4"
								aria-hidden="true"
							/>
							{t("restore")}
						</Button>
					) : (
						<>
							<Button
								type="button"
								variant="outline"
								size="sm"
								// Nobody approves a visual they have not seen:
								// not while it renders, nor once it could not.
								disabled={
									busy || decision === "ACCEPTED" || !image
								}
								onClick={onAccept}
							>
								<CheckIcon
									className="size-4"
									aria-hidden="true"
								/>
								{t("accept")}
							</Button>
							{canRegenerate && (
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={busy || buildRunning}
									onClick={onRegenerate}
								>
									<RefreshCwIcon
										className="size-4"
										aria-hidden="true"
									/>
									{t("regenerate")}
								</Button>
							)}
							<Button
								type="button"
								variant="ghost"
								size="sm"
								disabled={busy}
								onClick={onDiscard}
							>
								<XIcon className="size-4" aria-hidden="true" />
								{t("discard")}
							</Button>
						</>
					)}
				</div>
			)}

			{canEdit && (
				// Always mounted, so what it becomes is announced.
				<output className="block text-muted-foreground text-sm">
					{regenerating && (
						<span className="inline-flex items-center gap-2">
							<Loader2Icon
								className="size-4 animate-spin"
								aria-hidden="true"
							/>
							{t("regenerating")}
						</span>
					)}
				</output>
			)}

			{canEdit && notice && (
				<VisualNotice
					notice={notice}
					onRebuild={onRebuild}
					rebuildDisabled={rebuildDisabled}
				/>
			)}
		</figure>
	);
}

function VisualNotice({
	notice,
	onRebuild,
	rebuildDisabled,
}: {
	notice: GlossyVisualNotice;
	onRebuild?: () => void;
	rebuildDisabled: boolean;
}) {
	const t = useTranslations("projects.glossy");
	let text: string;
	let offerRebuild = false;
	switch (notice.kind) {
		case "noValidReplacement":
			text = t("visual.notices.noValidReplacement", {
				reason: t(
					`report.dropReasons.${glossyReasonKey(notice.reason)}`,
				),
			});
			break;
		case "building":
			if (notice.stuck) {
				text = t("visual.notices.buildingStuck");
				offerRebuild = true;
			} else {
				text = notice.startedBy
					? t("visual.notices.buildingBy", { name: notice.startedBy })
					: t("visual.notices.building");
			}
			break;
		case "visualChanged":
			text = t("visual.notices.visualChanged");
			break;
		case "rebuildRequired":
			text = t("visual.notices.rebuildRequired");
			offerRebuild = true;
			break;
		case "notRegenerable":
			text = t("visual.notices.notRegenerable");
			break;
	}
	return (
		<div
			role="status"
			className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-muted p-3 text-sm"
		>
			<p className="flex-1">{text}</p>
			{offerRebuild && onRebuild && (
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={rebuildDisabled}
					onClick={onRebuild}
				>
					{t("toolbar.rebuild")}
				</Button>
			)}
		</div>
	);
}
