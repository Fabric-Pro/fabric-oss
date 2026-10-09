"use client";

import {
	BrandColorListField,
	parseBrandColorList,
} from "@saas/shared/components/BrandColorListField";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, AlertDescription } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import { Label } from "@ui/components/label";
import { Textarea } from "@ui/components/textarea";
import { Loader2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import {
	type Dispatch,
	type ReactNode,
	type SetStateAction,
	useEffect,
	useId,
	useState,
} from "react";
import { getOrpcCode } from "../field-mapping/orpc-error";
import {
	type RecipientBrandDraft,
	RecipientBrandFields,
	type RecipientLogoErrorCode,
	recipientBrandDraftFrom,
} from "../RecipientBrandFields";

// The server's limits, restated for the browser: they live in
// `@repo/database` (`PROPOSAL_STYLE_MAX_*`), which would pull the Prisma
// client into the bundle. Checking here only spares a round trip; the
// server re-checks.
const PROPOSAL_STYLE_DIRECTION_MAX_CHARS = 500;
const PROPOSAL_STYLE_MAX_ACCENTS = 3;

/** A refusal: the gate is off, the document is gone, or the caller is not a member. */
const DENIED_CODES = new Set(["NOT_FOUND", "FORBIDDEN", "UNAUTHORIZED"]);

export type ProposalStylePanelProps = {
	projectId: string;
	documentId: string;
	/** `canEditProject`: editors change the style, everyone else reads it. */
	canEdit: boolean;
	/** The document is QUEUED or GENERATING. */
	isGenerating: boolean;
	/** Start a regeneration; offered after a save when given. */
	onRegenerate?: () => void;
};

/** What `projects.proposalArtifact.getStyle` returns: null until someone saves one. */
type ProposalStyle = Awaited<
	ReturnType<typeof orpcClient.projects.proposalArtifact.getStyle>
>;

function proposalStyleQueryKey(projectId: string, documentId: string) {
	return [
		"projects",
		"proposalArtifact",
		"style",
		projectId,
		documentId,
	] as const;
}

/**
 * The key the project settings card reads the recipient brand under, so a
 * save here refreshes it too. Restated rather than imported: that card keeps
 * it private.
 */
const recipientBrandQueryKey = (projectId: string) =>
	["projectRecipientBrand", projectId] as const;

/** The style as the editor is shaping it: entries as typed. */
type ProposalStyleDraft = {
	styleDirection: string;
	/** Zero or one entry. */
	primary: string[];
	accents: string[];
};

function proposalStyleDraftFrom(
	style: ProposalStyle | undefined,
): ProposalStyleDraft {
	return {
		styleDirection: style?.styleDirection ?? "",
		primary: style?.primaryColor ? [style.primaryColor] : [],
		accents: style?.accentColors ?? [],
	};
}

/** The server's validation codes, which double as the inline copy keys. */
type ProposalStyleError =
	| "directionTooLong"
	| "invalidColor"
	| "tooManyAccentColors";

const STYLE_ERRORS = new Set<string>([
	"directionTooLong",
	"invalidColor",
	"tooManyAccentColors",
]);

type ProposalStyleInput = {
	styleDirection: string | null;
	primaryColor: string | null;
	accentColors: string[];
};

/**
 * The checks `projects.proposalArtifact.updateStyle` makes, run before the
 * request: a trimmed direction of at most 500 characters (empty clears it),
 * `#rrggbb` colours (`#rgb` widened, blanks dropped), at most three accents.
 */
export function validateProposalStyleDraft(
	draft: ProposalStyleDraft,
):
	| { ok: true; value: ProposalStyleInput }
	| { ok: false; error: ProposalStyleError } {
	const styleDirection = draft.styleDirection.trim();
	if (styleDirection.length > PROPOSAL_STYLE_DIRECTION_MAX_CHARS) {
		return { ok: false, error: "directionTooLong" };
	}
	const primary = parseBrandColorList(draft.primary);
	const accents = parseBrandColorList(draft.accents);
	if (!primary || !accents || primary.length > 1) {
		return { ok: false, error: "invalidColor" };
	}
	if (accents.length > PROPOSAL_STYLE_MAX_ACCENTS) {
		return { ok: false, error: "tooManyAccentColors" };
	}
	return {
		ok: true,
		value: {
			styleDirection: styleDirection || null,
			primaryColor: primary[0] ?? null,
			accentColors: accents,
		},
	};
}

/** The validation code a refused save carries, when it is one of ours. */
function styleErrorOf(error: unknown): ProposalStyleError | null {
	if (getOrpcCode(error) !== "BAD_REQUEST") {
		return null;
	}
	const code = (error as { data?: { code?: unknown } }).data?.code;
	return typeof code === "string" && STYLE_ERRORS.has(code)
		? (code as ProposalStyleError)
		: null;
}

type Feedback =
	| { kind: "none" }
	| { kind: "saved" }
	| { kind: "invalid"; error: ProposalStyleError }
	| { kind: "styleFailed" }
	| { kind: "recipientFailed" }
	| { kind: "recipientConflict" };

type SaveRequest = {
	style: ProposalStyleInput | null;
	recipient: {
		expectedVersion: number;
		colors: string[];
		draft: RecipientBrandDraft;
	} | null;
};

type SaveResult =
	| { outcome: "saved" }
	| { outcome: "invalid"; error: ProposalStyleError }
	| { outcome: "styleFailed" }
	| { outcome: "recipientFailed" }
	| { outcome: "recipientConflict" }
	| { outcome: "logoRejected"; code: RecipientLogoErrorCode };

function sameDraft(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The Style tab of a Proposal (Fizzy #2801): the style direction and colours
 * the next generation's visuals use, and the project's recipient brand.
 *
 * Nothing already generated is re-rendered: a save shapes the NEXT
 * generation, which the notice after a save says and offers to start. The
 * recipient brand belongs to the project — every Proposal in it shares one —
 * and is confirmed through its own procedure against the version it was
 * read at, as the project settings card does.
 *
 * One Save covers both: the style first, then the recipient brand when it
 * changed. Each part keeps its own saved baseline, so after a partial failure
 * only the part that did not save stays dirty.
 */
export function ProposalStylePanel({
	projectId,
	documentId,
	canEdit,
	isGenerating,
	onRegenerate,
}: ProposalStylePanelProps) {
	const t = useTranslations("projects.proposalArtifact.style");
	const idPrefix = useId();
	const queryClient = useQueryClient();
	const styleKey = proposalStyleQueryKey(projectId, documentId);
	const recipientKey = recipientBrandQueryKey(projectId);

	const styleQuery = useQuery({
		queryKey: styleKey,
		queryFn: () =>
			orpcClient.projects.proposalArtifact.getStyle({
				projectId,
				documentId,
			}),
		retry: (failureCount, error) =>
			!DENIED_CODES.has(getOrpcCode(error) ?? "") && failureCount < 2,
	});
	const recipientQuery = useQuery({
		queryKey: recipientKey,
		queryFn: () => orpcClient.projects.recipientBrand.get({ projectId }),
		retry: 1,
	});

	const [styleDraft, setStyleDraft] = useState<ProposalStyleDraft>(() =>
		proposalStyleDraftFrom(undefined),
	);
	const [styleInitial, setStyleInitial] =
		useState<ProposalStyleDraft>(styleDraft);
	const [recipientDraft, setRecipientDraft] = useState<RecipientBrandDraft>(
		() => recipientBrandDraftFrom(null),
	);
	const [recipientInitial, setRecipientInitial] =
		useState<RecipientBrandDraft>(recipientDraft);
	const [fieldsPending, setFieldsPending] = useState(false);
	const [logoError, setLogoError] = useState<RecipientLogoErrorCode | null>(
		null,
	);
	const [feedback, setFeedback] = useState<Feedback>({ kind: "none" });

	// A newer saved style replaces the draft: after this editor's own save,
	// or someone else's. A refetch of the same save keeps what is typed.
	const styleData = styleQuery.data;
	const loadedStyleAt =
		styleData === undefined
			? null
			: styleData === null
				? "none"
				: new Date(styleData.updatedAt).toISOString();
	useEffect(() => {
		if (loadedStyleAt === null) {
			return;
		}
		const next = proposalStyleDraftFrom(styleData ?? undefined);
		setStyleDraft(next);
		setStyleInitial(next);
	}, [loadedStyleAt]);

	// The same for the recipient brand, by its version (and the fields
	// remount, dropping any fetch message that described the old one).
	const recipientVersion = recipientQuery.data?.version;
	useEffect(() => {
		if (!recipientQuery.data) {
			return;
		}
		const next = recipientBrandDraftFrom(
			recipientQuery.data.recipientBrand,
		);
		setRecipientDraft(next);
		setRecipientInitial(next);
		setLogoError(null);
	}, [recipientVersion]);

	const saveMutation = useMutation({
		mutationFn: async (request: SaveRequest): Promise<SaveResult> => {
			if (request.style) {
				try {
					const saved =
						await orpcClient.projects.proposalArtifact.updateStyle({
							projectId,
							documentId,
							...request.style,
						});
					queryClient.setQueryData(styleKey, saved);
					// The saved values, as the server normalized them, are the
					// new baseline — whatever their timestamp.
					const next = proposalStyleDraftFrom(saved);
					setStyleDraft(next);
					setStyleInitial(next);
				} catch (error) {
					const invalid = styleErrorOf(error);
					return invalid
						? { outcome: "invalid", error: invalid }
						: { outcome: "styleFailed" };
				}
			}
			if (request.recipient) {
				const { expectedVersion, colors, draft } = request.recipient;
				let result: Awaited<
					ReturnType<typeof orpcClient.projects.recipientBrand.update>
				>;
				try {
					result = await orpcClient.projects.recipientBrand.update({
						projectId,
						expectedVersion,
						name: draft.name.trim() || null,
						website: draft.website.trim() || null,
						colors,
						logo:
							draft.logo.action === "replace"
								? { action: "replace", token: draft.logo.token }
								: { action: draft.logo.action },
					});
				} catch {
					return { outcome: "recipientFailed" };
				}
				if (result.outcome === "logoRejected") {
					return { outcome: "logoRejected", code: result.code };
				}
				// Applied, or someone confirmed since this draft was read:
				// either way the newer version replaces the draft.
				await queryClient.invalidateQueries({ queryKey: recipientKey });
				if (result.outcome === "conflict") {
					return { outcome: "recipientConflict" };
				}
			}
			return { outcome: "saved" };
		},
		onSuccess: (result) => {
			if (result.outcome === "logoRejected") {
				// The server discarded the refused upload; the token is spent.
				setLogoError(result.code);
				setRecipientDraft((prev) => ({
					...prev,
					logo: { action: "keep" },
				}));
				setFeedback({ kind: "none" });
				return;
			}
			setFeedback(
				result.outcome === "saved"
					? { kind: "saved" }
					: result.outcome === "invalid"
						? { kind: "invalid", error: result.error }
						: { kind: result.outcome },
			);
		},
	});

	// Any edit retires the last save's message.
	const editStyle = (patch: Partial<ProposalStyleDraft>) => {
		setStyleDraft((prev) => ({ ...prev, ...patch }));
		setFeedback({ kind: "none" });
	};
	const editRecipient: Dispatch<SetStateAction<RecipientBrandDraft>> = (
		action,
	) => {
		setRecipientDraft(action);
		setFeedback({ kind: "none" });
	};

	// A refusal ends the form; a fault on a background refetch does not take
	// away a form that already loaded, or what is being typed into it.
	const styleDenied =
		styleQuery.isError &&
		DENIED_CODES.has(getOrpcCode(styleQuery.error) ?? "");
	if (styleDenied || (styleQuery.isError && styleData === undefined)) {
		return (
			<StylePanelShell>
				{styleDenied ? (
					<p className="text-muted-foreground text-sm">
						{t("unavailable")}
					</p>
				) : (
					<div className="flex flex-wrap items-center gap-3">
						<p className="text-destructive text-sm">
							{t("loadFailed")}
						</p>
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => styleQuery.refetch()}
						>
							{t("retry")}
						</Button>
					</div>
				)}
			</StylePanelShell>
		);
	}

	if (styleQuery.isPending || recipientQuery.isPending) {
		return (
			<StylePanelShell>
				<output className="flex items-center gap-2 text-muted-foreground text-sm">
					<Loader2Icon
						className="size-4 motion-safe:animate-spin"
						aria-hidden="true"
					/>
					{t("loading")}
				</output>
			</StylePanelShell>
		);
	}

	const recipient = recipientQuery.data ?? null;
	const styleDirty = !sameDraft(styleDraft, styleInitial);
	const recipientDirty =
		recipient !== null && !sameDraft(recipientDraft, recipientInitial);
	const dirty = styleDirty || recipientDirty;
	const saving = saveMutation.isPending;
	const locked = !canEdit || saving;

	const directionError =
		feedback.kind === "invalid" && feedback.error === "directionTooLong";
	const ids = {
		direction: `${idPrefix}-direction`,
		directionHelp: `${idPrefix}-direction-help`,
		directionCount: `${idPrefix}-direction-count`,
		directionError: `${idPrefix}-direction-error`,
	};

	const save = () => {
		const style = validateProposalStyleDraft(styleDraft);
		if (!style.ok) {
			setFeedback({ kind: "invalid", error: style.error });
			return;
		}
		const recipientColors = parseBrandColorList(recipientDraft.colors);
		if (recipientDirty && !recipientColors) {
			setFeedback({ kind: "invalid", error: "invalidColor" });
			return;
		}
		setFeedback({ kind: "none" });
		setLogoError(null);
		saveMutation.mutate({
			style: styleDirty ? style.value : null,
			recipient:
				recipientDirty && recipient && recipientColors
					? {
							expectedVersion: recipient.version,
							colors: recipientColors,
							draft: recipientDraft,
						}
					: null,
		});
	};

	const discard = () => {
		setStyleDraft(styleInitial);
		setRecipientDraft(recipientInitial);
		setLogoError(null);
		setFeedback({ kind: "none" });
	};

	return (
		<StylePanelShell>
			{isGenerating && (
				<Alert variant="primary" role="status">
					<AlertDescription className="mt-0">
						{t("generating")}
					</AlertDescription>
				</Alert>
			)}
			{!canEdit && (
				<p className="text-muted-foreground text-sm">{t("readOnly")}</p>
			)}

			<div className="space-y-2">
				<Label htmlFor={ids.direction}>{t("styleDirection")}</Label>
				<Textarea
					id={ids.direction}
					value={styleDraft.styleDirection}
					maxLength={PROPOSAL_STYLE_DIRECTION_MAX_CHARS}
					placeholder={t("styleDirectionPlaceholder")}
					aria-describedby={[
						ids.directionHelp,
						ids.directionCount,
						directionError ? ids.directionError : null,
					]
						.filter(Boolean)
						.join(" ")}
					aria-invalid={directionError || undefined}
					disabled={locked}
					onChange={(e) =>
						editStyle({ styleDirection: e.target.value })
					}
				/>
				<div className="flex flex-wrap justify-between gap-2">
					<p
						id={ids.directionHelp}
						className="text-muted-foreground text-xs"
					>
						{t("styleDirectionHelp")}
					</p>
					<p
						id={ids.directionCount}
						className="text-muted-foreground text-xs tabular-nums"
					>
						{t("characterCount", {
							count: styleDraft.styleDirection.length,
							max: PROPOSAL_STYLE_DIRECTION_MAX_CHARS,
						})}
					</p>
				</div>
				{directionError && (
					<p
						id={ids.directionError}
						className="text-destructive text-xs"
					>
						{t("directionTooLong", {
							max: PROPOSAL_STYLE_DIRECTION_MAX_CHARS,
						})}
					</p>
				)}
			</div>

			<div className="space-y-4">
				<div className="space-y-1">
					<h3 className="font-medium text-base">{t("colors")}</h3>
					<p className="text-muted-foreground text-xs">
						{t("colorsHelp")}
					</p>
				</div>
				<BrandColorListField
					id={`${idPrefix}-primary`}
					legend={t("primaryColor")}
					colors={styleDraft.primary}
					max={1}
					disabled={locked}
					labels={{
						hex: () => t("primaryHex"),
						picker: () => t("primaryPicker"),
						remove: () => t("primaryRemove"),
						add: t("addColor"),
						invalid: t("invalidColor"),
						empty: t("noColors"),
					}}
					onChange={(primary) => editStyle({ primary })}
				/>
				<BrandColorListField
					id={`${idPrefix}-accents`}
					legend={t("accentColors")}
					description={t("accentColorsHelp", {
						max: PROPOSAL_STYLE_MAX_ACCENTS,
					})}
					colors={styleDraft.accents}
					max={PROPOSAL_STYLE_MAX_ACCENTS}
					disabled={locked}
					labels={{
						hex: (position) => t("accentHex", { position }),
						picker: (position) => t("accentPicker", { position }),
						remove: (position) => t("accentRemove", { position }),
						add: t("addColor"),
						invalid: t("invalidColor"),
						empty: t("noColors"),
					}}
					onChange={(accents) => editStyle({ accents })}
				/>
			</div>

			<div className="space-y-4">
				<div className="space-y-1">
					<h3 className="font-medium text-base">{t("recipient")}</h3>
					<p className="text-muted-foreground text-xs">
						{t("recipientHelp")}
					</p>
				</div>
				{feedback.kind === "recipientConflict" && (
					<Alert variant="warning" role="status">
						<AlertDescription className="mt-0">
							{t("recipientConflict")}
						</AlertDescription>
					</Alert>
				)}
				{recipient ? (
					<RecipientBrandFields
						key={recipient.version}
						projectId={projectId}
						value={recipientDraft}
						onChange={editRecipient}
						currentLogoUrl={
							recipient.recipientBrand?.logoUrl ?? null
						}
						disabled={!canEdit}
						busy={saving}
						logoError={logoError}
						idPrefix={`${idPrefix}-recipient`}
						onPendingChange={setFieldsPending}
					/>
				) : (
					<div className="flex flex-wrap items-center gap-3">
						<p className="text-destructive text-sm">
							{t("recipientLoadFailed")}
						</p>
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => recipientQuery.refetch()}
						>
							{t("retry")}
						</Button>
					</div>
				)}
			</div>

			{canEdit && (
				<div className="space-y-3">
					<div className="flex flex-wrap items-center gap-3">
						<Button
							type="button"
							loading={saving}
							disabled={!dirty || fieldsPending}
							onClick={save}
						>
							{t("save")}
						</Button>
						{dirty && !saving && (
							<Button
								type="button"
								variant="outline"
								onClick={discard}
							>
								{t("discard")}
							</Button>
						)}
						{/* Always mounted (an implicit polite status), so the
						    change to and from saving is announced. */}
						<output className="text-muted-foreground text-sm">
							{saving ? t("saving") : dirty ? t("unsaved") : null}
						</output>
					</div>
					<SaveFeedback
						feedback={feedback}
						isGenerating={isGenerating}
						onRegenerate={
							onRegenerate
								? () => {
										setFeedback({ kind: "none" });
										onRegenerate();
									}
								: undefined
						}
					/>
				</div>
			)}
		</StylePanelShell>
	);
}

function SaveFeedback({
	feedback,
	isGenerating,
	onRegenerate,
}: {
	feedback: Feedback;
	isGenerating: boolean;
	onRegenerate?: () => void;
}) {
	const t = useTranslations("projects.proposalArtifact.style");

	if (feedback.kind === "saved") {
		return (
			<Alert variant="success" role="status">
				<AlertDescription className="mt-0 flex flex-wrap items-center gap-3">
					<span className="flex-1">{t("saved")}</span>
					{onRegenerate && (
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={isGenerating}
							onClick={onRegenerate}
						>
							{t("regenerate")}
						</Button>
					)}
				</AlertDescription>
			</Alert>
		);
	}
	if (feedback.kind === "invalid") {
		// A too-long direction is flagged beside the field; colours beside
		// each entry. This line says why nothing was saved.
		return (
			<p role="alert" className="text-destructive text-sm">
				{t(`invalid.${feedback.error}`, {
					max:
						feedback.error === "directionTooLong"
							? PROPOSAL_STYLE_DIRECTION_MAX_CHARS
							: PROPOSAL_STYLE_MAX_ACCENTS,
				})}
			</p>
		);
	}
	if (
		feedback.kind === "styleFailed" ||
		feedback.kind === "recipientFailed"
	) {
		return (
			<p role="alert" className="text-destructive text-sm">
				{t(feedback.kind)}
			</p>
		);
	}
	return null;
}

function StylePanelShell({ children }: { children: ReactNode }) {
	const t = useTranslations("projects.proposalArtifact.style");
	return (
		<Card className="space-y-6 p-6">
			<div className="space-y-1">
				<h2 className="font-semibold text-lg tracking-tight">
					{t("title")}
				</h2>
				<p className="text-muted-foreground text-sm">
					{t("description")}
				</p>
			</div>
			{children}
		</Card>
	);
}
