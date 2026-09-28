"use client";

import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Alert, AlertDescription } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import { EmptyState, EmptyStateDescription } from "@ui/components/empty-state";
import { Skeleton } from "@ui/components/skeleton";
import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
	type GlossyEdition,
	type GlossyVisualDecision,
	glossyEditionQueryKey,
	isGlossyAccessDenied,
	SIGNED_URL_REFRESH_MS,
	useGlossyEdition,
	useGlossyVisualImages,
	useHeldSignedUrls,
} from "../../hooks/use-glossy-edition";
import {
	type GlossyRenderLabels,
	renderGlossyDocx,
	renderGlossyPdf,
	resolveRecipientName,
} from "../../lib/glossy/glossy-document-render";
import {
	deriveGlossyPalette,
	type GlossyPaletteInput,
} from "../../lib/glossy/palette";
import { toSlug, triggerBlobDownload } from "../../lib/markdown-to-document";
import { getOrpcCode } from "../field-mapping/orpc-error";
import {
	type GlossyAlignFirstOptions,
	GlossyAlignFirstPanel,
	type GlossyDetectionState,
} from "./GlossyAlignFirstPanel";
import { GlossyPreview } from "./GlossyPreview";
import { GlossyStatusStrip } from "./GlossyStatusStrip";
import {
	type GlossyBuildMode,
	type GlossyDownloadFormat,
	type GlossyLengthMode,
	type GlossyPrimaryAction,
	GlossyToolbar,
} from "./GlossyToolbar";
import { GlossyVisualCard, type GlossyVisualNotice } from "./GlossyVisualCard";
import { glossyIneligibleKey } from "./glossy-copy";

type GlossyEditionPageProps = {
	projectId: string;
	documentId: string;
	organizationSlug: string;
	projectName: string;
};

/**
 * The Glossy page of one document (Fizzy #2589, R4, R5, R9, R26; F1–F3):
 * where editors build, review, and download the Glossy edition, and every
 * other project member reads and downloads it.
 *
 * Reading the page never starts anything: a build starts only when an
 * editor asks for one. While a build runs the page polls the edition for
 * its progress; everything else refreshes after the action that changed it.
 */
export function GlossyEditionPage({
	projectId,
	documentId,
	organizationSlug,
	projectName,
}: GlossyEditionPageProps) {
	const t = useTranslations("projects.glossy");
	const query = useGlossyEdition(projectId, documentId);
	const basePath = `/app/${organizationSlug}`;
	const documentHref = `${basePath}/projects/${projectId}/documents/${documentId}`;
	// A refusal wins over the last good answer: the edition is no longer this
	// caller's to see, even if a poll before it still showed a build.
	const denied = query.isError && isGlossyAccessDenied(query.error);
	const data = denied ? undefined : query.data;

	let body: ReactNode;
	if (denied) {
		body = (
			<Alert variant="warning">
				<AlertDescription className="mt-0">
					{t("page.unavailable")}
				</AlertDescription>
			</Alert>
		);
	} else if (data) {
		body = (
			<GlossyEditionWorkspace
				data={data}
				dataUpdatedAt={query.dataUpdatedAt}
				refetch={async () => (await query.refetch()).data}
				projectId={projectId}
				documentId={documentId}
				aiProvidersHref={`${basePath}/settings/ai-providers`}
			/>
		);
	} else if (query.isError) {
		body = (
			<Alert variant="error">
				<AlertDescription className="mt-0 flex flex-wrap items-center gap-3">
					<span className="flex-1">{t("page.loadFailed")}</span>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => query.refetch()}
					>
						{t("page.retryLoad")}
					</Button>
				</AlertDescription>
			</Alert>
		);
	} else {
		body = (
			<div role="status" className="space-y-4">
				<span className="sr-only">{t("page.loading")}</span>
				<Skeleton className="h-32 w-full" />
				<Skeleton className="h-96 w-full" />
			</div>
		);
	}

	return (
		<div className="space-y-6">
			<PageBreadcrumbs
				items={[
					{
						label: t("page.breadcrumbProjects"),
						href: `${basePath}/projects`,
					},
					{
						label: projectName,
						href: `${basePath}/projects/${projectId}`,
					},
					{
						label:
							data?.document.title ??
							t("page.breadcrumbDocument"),
						href: documentHref,
					},
					{ label: t("page.title") },
				]}
			/>
			<div className="flex flex-wrap items-start justify-between gap-4">
				<div className="space-y-1">
					<h1 className="font-semibold text-2xl tracking-tight">
						{t("page.title")}
					</h1>
					<p className="max-w-2xl text-muted-foreground text-sm">
						{t("page.description")}
					</p>
				</div>
				<Button asChild variant="outline" size="sm">
					<Link href={documentHref}>
						<ArrowLeftIcon className="size-4" aria-hidden="true" />
						{t("page.backToDocument")}
					</Link>
				</Button>
			</div>
			{body}
		</div>
	);
}

type BuildOptions =
	| { mode: "roll_the_dice"; lengthMode: GlossyLengthMode }
	| GlossyAlignFirstOptions;

type WorkspaceProps = {
	data: GlossyEdition;
	dataUpdatedAt: number;
	refetch: () => Promise<GlossyEdition | undefined>;
	projectId: string;
	documentId: string;
	aiProvidersHref: string;
};

function withItem(set: ReadonlySet<string>, item: string): Set<string> {
	const next = new Set(set);
	next.add(item);
	return next;
}

function withoutItem(set: ReadonlySet<string>, item: string): Set<string> {
	const next = new Set(set);
	next.delete(item);
	return next;
}

/**
 * What the palette derives from in one read of the edition: both brands and
 * the edition's preparer overrides. The preview and a download each take it
 * from the read they show.
 */
function glossyPaletteInput({
	brand,
	edition,
}: GlossyEdition): GlossyPaletteInput {
	return {
		brandColorName: brand.preparer.brandColorName,
		accentColors: brand.preparer.accentColors,
		recipientColors: brand.recipient?.colors ?? [],
		overrides: edition?.lastOptions?.preparerOverrides ?? null,
	};
}

/** The edition with one visual's review decision replaced. */
function withDecision(
	edition: GlossyEdition | undefined,
	visualKey: string,
	decision: GlossyVisualDecision | null,
): GlossyEdition | undefined {
	if (!edition?.edition) {
		return edition;
	}
	const decisions = edition.edition.decisions.filter(
		(entry) => entry.visualKey !== visualKey,
	);
	if (decision) {
		decisions.push({ visualKey, decision, decidedAt: new Date() });
	}
	return { ...edition, edition: { ...edition.edition, decisions } };
}

function GlossyEditionWorkspace({
	data,
	dataUpdatedAt,
	refetch,
	projectId,
	documentId,
	aiProvidersHref,
}: WorkspaceProps) {
	const t = useTranslations("projects.glossy");
	const format = useFormatter();
	const queryClient = useQueryClient();
	const queryKey = glossyEditionQueryKey(projectId, documentId);
	const { canEdit, edition, build, brand } = data;
	const content = edition?.content ?? null;
	const building = build.status === "building";

	const [mode, setMode] = useState<GlossyBuildMode>(
		edition?.lastOptions?.mode ?? "roll_the_dice",
	);
	// Brief is the default length (product decision).
	const [lengthMode, setLengthMode] = useState<GlossyLengthMode>(
		edition?.lastOptions?.lengthMode ?? "brief",
	);
	const [alignFirst, setAlignFirstState] =
		useState<GlossyDetectionState | null>(null);
	// Align first as last set, read by the detection's callbacks. TanStack
	// runs them even after a Cancel, and a cancelled detection must neither
	// reopen the panel nor raise its notices. A functional update cannot
	// guard those notices (React applies it later), so the ref, written with
	// every change, is the one gate.
	const alignFirstRef = useRef<GlossyDetectionState | null>(null);
	const setAlignFirst = (next: GlossyDetectionState | null) => {
		alignFirstRef.current = next;
		setAlignFirstState(next);
	};
	const awaitingDetection = () =>
		alignFirstRef.current?.status === "detecting";
	const [draftStale, setDraftStale] = useState(false);
	const [providerNotConfigured, setProviderNotConfigured] = useState(false);
	const [regenerating, setRegenerating] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	const [reviewing, setReviewing] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	const [notRegenerable, setNotRegenerable] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	const [notices, setNotices] = useState<
		Readonly<Record<string, GlossyVisualNotice>>
	>({});
	const [downloading, setDownloading] = useState<GlossyDownloadFormat | null>(
		null,
	);

	// A newly published edition replaces every visual the notices described.
	const publishedAt = edition?.builtFrom?.builtAt
		? new Date(edition.builtFrom.builtAt).getTime()
		: null;
	useEffect(() => {
		setNotices({});
		setNotRegenerable(new Set());
	}, [publishedAt]);
	// A build notice reports the build state the server answered with; once
	// the page sees that state move, it no longer holds.
	useEffect(() => {
		setNotices((prev) => {
			const kept = Object.entries(prev).filter(
				([, notice]) => notice.kind !== "building",
			);
			return kept.length === Object.keys(prev).length
				? prev
				: Object.fromEntries(kept);
		});
	}, [build.status]);

	const invalidate = () => queryClient.invalidateQueries({ queryKey });
	const setNotice = (visualKey: string, notice: GlossyVisualNotice | null) =>
		setNotices((prev) => {
			const next = { ...prev };
			if (notice) {
				next[visualKey] = notice;
			} else {
				delete next[visualKey];
			}
			return next;
		});
	const rateLimitedOr = (error: unknown, fallback: string) =>
		getOrpcCode(error) === "TOO_MANY_REQUESTS"
			? t("outcome.rateLimited")
			: fallback;

	// Brands apply at render time, so a Brand kit or recipient brand change
	// shows without a rebuild. A download derives its palette the same way
	// from the read it renders, which may be fresher than this one.
	const paletteInput = JSON.stringify(glossyPaletteInput(data));
	const palette = useMemo(
		() =>
			deriveGlossyPalette(JSON.parse(paletteInput) as GlossyPaletteInput),
		[paletteInput],
	);
	const visualImages = useGlossyVisualImages(
		content?.visuals ?? null,
		palette,
	);
	// What the preview shows; a download reads the query's own data instead.
	const shownUrls = useHeldSignedUrls(
		{
			imageUrls: data.imageUrls,
			preparerLogoUrl: brand.preparer.logoUrl,
			recipientLogoUrl: brand.recipient?.logoUrl ?? null,
		},
		dataUpdatedAt,
	);
	const decisions = new Map(
		(edition?.decisions ?? []).map((entry) => [
			entry.visualKey,
			entry.decision,
		]),
	);

	const buildMutation = useMutation({
		mutationFn: (options: BuildOptions) =>
			orpcClient.projects.glossy.build({
				projectId,
				documentId,
				options,
			}),
		onSuccess: (result) => {
			switch (result.outcome) {
				case "started":
					setProviderNotConfigured(false);
					setDraftStale(false);
					setAlignFirst(null);
					// Every notice described the edition and build before this one.
					setNotices({});
					toast.success(t("outcome.started"));
					break;
				case "alreadyBuilding": {
					const name = result.holder?.startedBy?.name;
					setAlignFirst(null);
					toast.info(
						name
							? t("outcome.alreadyBuildingBy", { name })
							: t("outcome.alreadyBuilding"),
					);
					break;
				}
				case "aiProviderNotConfigured":
					setProviderNotConfigured(true);
					break;
				case "draftStale":
					setDraftStale(true);
					break;
				case "notEligible":
					toast.error(
						t(`ineligible.${glossyIneligibleKey(result.reason)}`),
					);
					break;
			}
		},
		onError: (error) => {
			toast.error(rateLimitedOr(error, t("outcome.startFailed")));
		},
		onSettled: () => invalidate(),
	});

	const detectMutation = useMutation({
		mutationFn: () =>
			orpcClient.projects.glossy.detect({ projectId, documentId }),
		onMutate: () => {
			setDraftStale(false);
			setAlignFirst({ status: "detecting" });
		},
		onSuccess: (result) => {
			if (!awaitingDetection()) {
				return;
			}
			if (result.outcome === "detected") {
				setAlignFirst({ status: "detected", result });
				return;
			}
			setAlignFirst(null);
			if (result.outcome === "aiProviderNotConfigured") {
				setProviderNotConfigured(true);
				return;
			}
			toast.error(t(`ineligible.${glossyIneligibleKey(result.reason)}`));
		},
		onError: (error) => {
			if (!awaitingDetection()) {
				return;
			}
			setAlignFirst({ status: "failed" });
			if (getOrpcCode(error) === "TOO_MANY_REQUESTS") {
				toast.error(t("outcome.rateLimited"));
			}
		},
	});

	const buildBusy = building || buildMutation.isPending;
	/**
	 * The one guard on every way to start a build: the toolbar, the status
	 * strip's Retry and Rebuild, and a visual notice's Rebuild. Nothing starts
	 * while a build runs or starts, while detection runs, while the Align-first
	 * form is open (its own Build is the way on from there), or for a document
	 * that cannot be built.
	 */
	const canStartBuild =
		canEdit &&
		!buildBusy &&
		!detectMutation.isPending &&
		alignFirst === null &&
		data.eligibility.eligible;

	/** Build, Rebuild, or Retry — straight away, or through Align first. */
	const startBuild = () => {
		if (!canStartBuild) {
			return;
		}
		if (mode === "align_first") {
			detectMutation.mutate();
			return;
		}
		buildMutation.mutate({ mode: "roll_the_dice", lengthMode });
	};

	const buildAlignFirst = async (options: GlossyAlignFirstOptions) => {
		try {
			await buildMutation.mutateAsync(options);
		} catch {
			// Reported by the mutation's own error handler.
		}
	};

	const regenerate = async (visualKey: string) => {
		setNotice(visualKey, null);
		setRegenerating((prev) => withItem(prev, visualKey));
		try {
			const result = await orpcClient.projects.glossy.regenerateVisual({
				projectId,
				documentId,
				visualKey,
			});
			switch (result.outcome) {
				case "regenerated":
					toast.success(t("visual.regenerated"));
					break;
				case "noValidReplacement":
					setNotice(visualKey, {
						kind: "noValidReplacement",
						reason: result.reason,
					});
					break;
				case "building":
					setNotice(visualKey, {
						kind: "building",
						startedBy: result.holder?.startedBy?.name ?? null,
						stuck: result.stuck,
					});
					break;
				case "aiProviderNotConfigured":
					setProviderNotConfigured(true);
					break;
				case "visualNotFound":
					toast.error(t("visual.notices.visualNotFound"));
					break;
				case "notRegenerable":
					setNotRegenerable((prev) => withItem(prev, visualKey));
					setNotice(visualKey, { kind: "notRegenerable" });
					break;
				case "rebuildRequired":
					setNotice(visualKey, { kind: "rebuildRequired" });
					break;
				case "superseded":
					toast.info(t("visual.superseded"));
					break;
			}
		} catch (error) {
			toast.error(rateLimitedOr(error, t("visual.regenerateFailed")));
		} finally {
			// The card stays busy until the refetch shows what changed, so no
			// control acts on a visual the editor has not seen yet.
			await invalidate();
			setRegenerating((prev) => withoutItem(prev, visualKey));
		}
	};

	const review = async (
		visualKey: string,
		decision: "accept" | "discard" | "restore",
	) => {
		const visual = content?.visuals[visualKey];
		if (!visual) {
			return;
		}
		setNotice(visualKey, null);
		setReviewing((prev) => withItem(prev, visualKey));
		try {
			const result = await orpcClient.projects.glossy.reviewVisual({
				projectId,
				documentId,
				visualKey,
				decision,
				...(decision === "accept" ? { specHash: visual.specHash } : {}),
			});
			if (result.outcome === "reviewed") {
				queryClient.setQueryData<GlossyEdition>(queryKey, (old) =>
					withDecision(old, visualKey, result.decision),
				);
			} else if (result.outcome === "visualChanged") {
				setNotice(visualKey, { kind: "visualChanged" });
			} else {
				toast.error(t("visual.notices.visualNotFound"));
			}
		} catch {
			toast.error(t("visual.reviewFailed"));
		} finally {
			setReviewing((prev) => withoutItem(prev, visualKey));
			void invalidate();
		}
	};

	const formatDate = (iso: string) => {
		const date = new Date(iso);
		return Number.isNaN(date.getTime())
			? iso
			: format.dateTime(date, { dateStyle: "medium" });
	};
	const renderLabels: GlossyRenderLabels = {
		preparedBy: t("preview.preparedBy"),
		preparedFor: t("preview.preparedFor"),
		appendix: t("preview.appendix"),
		sources: t("preview.sources"),
		details: t("preview.details"),
		placeholders: t("preview.placeholders"),
		assumptions: t("preview.assumptions"),
		additionalMaterial: t("preview.additionalMaterial"),
		provenance: (provenance) =>
			t("preview.provenance", {
				title: provenance.sourceTitle,
				version: provenance.sourceVersion,
				date: formatDate(provenance.builtAt),
			}),
	};

	const download = async (formatName: GlossyDownloadFormat) => {
		setDownloading(formatName);
		try {
			// Signed reads expire; an old page asks for fresh ones first.
			const current =
				Date.now() - dataUpdatedAt > SIGNED_URL_REFRESH_MS
					? ((await refetch()) ?? data)
					: data;
			const currentContent = current.edition?.content;
			if (!currentContent || !current.edition) {
				return;
			}
			const discarded = new Set(
				current.edition.decisions
					.filter((entry) => entry.decision === "DISCARDED")
					.map((entry) => entry.visualKey),
			);
			// The refreshed read can carry a Brand kit, recipient, or override
			// change the preview has not drawn yet. Its colors go with its
			// logos; the preview's images, drawn in the old colors, are then
			// left for the renderer to draw again in the new ones.
			const currentPalette = deriveGlossyPalette(
				glossyPaletteInput(current),
			);
			const samePalette =
				JSON.stringify(currentPalette) === JSON.stringify(palette);
			const render =
				formatName === "pdf" ? renderGlossyPdf : renderGlossyDocx;
			const result = await render({
				content: currentContent,
				palette: currentPalette,
				preparer: {
					name: current.brand.preparer.name,
					logoUrl: current.brand.preparer.logoUrl,
				},
				recipient: {
					name: current.brand.recipient?.name ?? null,
					logoUrl: current.brand.recipient?.logoUrl ?? null,
				},
				imageUrls: current.imageUrls,
				excludedVisualKeys: discarded,
				renderedVisuals: samePalette
					? visualImages.lookup(currentContent.visuals)
					: undefined,
				labels: renderLabels,
			});
			triggerBlobDownload(
				result.blob,
				`${toSlug(currentContent.title)}-glossy.${formatName}`,
			);
			if (result.omittedVisuals > 0) {
				toast.warning(
					t("download.omittedVisuals", {
						count: result.omittedVisuals,
					}),
				);
			}
			if (result.omittedImages > 0) {
				toast.warning(
					t("download.omittedImages", {
						count: result.omittedImages,
					}),
				);
			}
		} catch {
			toast.error(
				t("download.failed", { format: formatName.toUpperCase() }),
			);
		} finally {
			setDownloading(null);
		}
	};

	const primaryLabel = () => {
		if (building) {
			return t("toolbar.building");
		}
		if (mode === "align_first") {
			return t("toolbar.alignFirst");
		}
		if (content) {
			return t("toolbar.rebuild");
		}
		if (build.status === "failed") {
			return t("toolbar.retry");
		}
		return t("toolbar.build");
	};

	const primary: GlossyPrimaryAction | null =
		alignFirst !== null
			? null
			: {
					label: primaryLabel(),
					onClick: startBuild,
					disabled: !canStartBuild,
					loading: buildBusy || detectMutation.isPending,
				};

	const renderVisual = (visualKey: string) => {
		const visual = content?.visuals[visualKey];
		if (!visual) {
			return null;
		}
		return (
			<GlossyVisualCard
				visualKey={visualKey}
				visual={visual}
				image={
					visualImages.images.get(visualKey) ??
					(visualImages.failed.has(visualKey) ? null : undefined)
				}
				decision={decisions.get(visualKey) ?? null}
				canEdit={canEdit}
				buildRunning={building}
				regenerating={regenerating.has(visualKey)}
				reviewing={reviewing.has(visualKey)}
				regenerateUnavailable={notRegenerable.has(visualKey)}
				notice={notices[visualKey] ?? null}
				onAccept={() => review(visualKey, "accept")}
				onDiscard={() => review(visualKey, "discard")}
				onRestore={() => review(visualKey, "restore")}
				onRegenerate={() => regenerate(visualKey)}
				onRebuild={canEdit ? startBuild : undefined}
				rebuildDisabled={!canStartBuild}
			/>
		);
	};

	return (
		<div className="space-y-6">
			<GlossyToolbar
				canEdit={canEdit}
				mode={mode}
				onModeChange={setMode}
				lengthMode={lengthMode}
				onLengthModeChange={setLengthMode}
				showLength={alignFirst === null}
				optionsDisabled={
					buildBusy || detectMutation.isPending || alignFirst !== null
				}
				primary={primary}
				canDownload={content !== null}
				downloading={downloading}
				onDownload={download}
			/>

			{canEdit && alignFirst && (
				<GlossyAlignFirstPanel
					projectId={projectId}
					detection={alignFirst}
					onDetectAgain={() => detectMutation.mutate()}
					lengthMode={lengthMode}
					onLengthModeChange={setLengthMode}
					brand={brand}
					lastOptions={edition?.lastOptions ?? null}
					hasContent={content !== null}
					buildBusy={buildBusy}
					draftStale={draftStale}
					onBuild={buildAlignFirst}
					onRecipientChanged={invalidate}
					onCancel={() => {
						setAlignFirst(null);
						setDraftStale(false);
					}}
				/>
			)}

			<GlossyStatusStrip
				data={data}
				providerNotConfigured={providerNotConfigured}
				aiProvidersHref={aiProvidersHref}
				onBuild={canEdit ? startBuild : null}
				buildDisabled={!canStartBuild}
			/>

			{content ? (
				<GlossyPreview
					content={content}
					preparer={{
						name: brand.preparer.name,
						logoUrl: shownUrls.preparerLogoUrl,
					}}
					recipient={{
						name: resolveRecipientName(
							brand.recipient?.name,
							content,
						),
						logoUrl: shownUrls.recipientLogoUrl,
					}}
					imageUrls={shownUrls.imageUrls}
					renderVisual={renderVisual}
				/>
			) : build.status === "failed" ? null : (
				<EmptyState className="rounded-lg border border-border border-dashed">
					{/* An h2: the page title is the h1 above it. */}
					<h2 className="mb-2 font-semibold text-lg">
						{building ? t("empty.buildingTitle") : t("empty.title")}
					</h2>
					<EmptyStateDescription>
						{building
							? t("empty.buildingBody")
							: canEdit
								? t("empty.editorBody")
								: t("empty.viewerBody")}
					</EmptyStateDescription>
				</EmptyState>
			)}
		</div>
	);
}
