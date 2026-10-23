"use client";

import { Alert, AlertDescription } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import { Label } from "@ui/components/label";
import { Switch } from "@ui/components/switch";
import { Loader2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { type ReactNode, useId } from "react";
import { getOrpcCode } from "../field-mapping/orpc-error";
import { RecipientBrandFields } from "../RecipientBrandFields";
import { BrandKitValues } from "./BrandKitValues";
import { ProposerColorField } from "./ProposerColorField";
import { DENIED_CODES } from "./proposal-style-model";
import {
	RecipientSourceList,
	RecipientSuggestionArea,
} from "./RecipientSuggestionArea";
import { SaveFeedback } from "./SaveFeedback";
import { StyleDirectionField } from "./StyleDirectionField";
import { useProposalStyle } from "./use-proposal-style";

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

/**
 * The Style tab of a Proposal (Fizzy #2801, Fizzy #2946): the style direction,
 * the proposer's brand and the project's recipient brand, each value with
 * where it comes from.
 *
 * Nothing already generated is re-rendered: a save shapes the NEXT
 * generation, which the notice after a save says and offers to start. The
 * recipient brand belongs to the project — every Proposal in it shares one —
 * and is confirmed through its own procedure against the version it was
 * read at, as the project settings card does.
 *
 * Proposer: the primary and accent colours are this document's overrides.
 * Without one a field inherits (Brand kit, then the vendor's website, then
 * the neutral default) and says so; the logo, fonts and hero are the Brand
 * kit's, shown read-only. Recipient: the person-owned fields, and what a
 * fetch of the recipient's website found, applied one field at a time only
 * when a member confirms it.
 *
 * One Save covers the style and the recipient fields: the style first, then
 * the recipient brand when it changed. Each part keeps its own saved
 * baseline, so after a partial failure only the part that did not save stays
 * dirty. Where each value comes from is a separate read: while it loads or
 * after it fails, the form stays editable without the chips.
 *
 * Diagrams: whether Fabric adds them after each generation is part of the
 * style and saves with it. Turning it off adds none from then on and keeps
 * the diagrams already in the document.
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
	const recipientIdPrefix = `${idPrefix}-recipient`;
	const state = useProposalStyle({
		projectId,
		documentId,
		canEdit,
		recipientIdPrefix,
	});
	const { styleQuery, recipientQuery, sourcesQuery } = state;

	// A refusal ends the form; a fault on a background refetch does not take
	// away a form that already loaded, or what is being typed into it.
	const styleDenied =
		styleQuery.isError &&
		DENIED_CODES.has(getOrpcCode(styleQuery.error) ?? "");
	if (styleDenied || (styleQuery.isError && styleQuery.data === undefined)) {
		return (
			<StylePanelShell rootRef={state.rootRef}>
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
			<StylePanelShell rootRef={state.rootRef}>
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

	const { styleDraft, recipientRead, proposer, feedback, confirmFeedback } =
		state;
	const dirty = state.styleDirty || state.recipientDirty;
	const locked = !canEdit || state.saving;
	const sourcesErrorId = `${idPrefix}-sources-error`;

	return (
		<StylePanelShell rootRef={state.rootRef}>
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

			<StyleDirectionField
				idPrefix={idPrefix}
				value={styleDraft.styleDirection}
				tooLong={
					feedback.kind === "invalid" &&
					feedback.error === "directionTooLong"
				}
				disabled={locked}
				onChange={(styleDirection) =>
					state.editStyle({ styleDirection })
				}
			/>

			<AutoVisualsField
				id={`${idPrefix}-auto-visuals`}
				checked={styleDraft.autoVisuals}
				disabled={locked}
				onChange={(autoVisuals) => state.editStyle({ autoVisuals })}
			/>

			<div className="space-y-5">
				<div className="space-y-1">
					<h3 className="font-medium text-base">{t("proposer")}</h3>
					<p className="text-muted-foreground text-xs">
						{t("proposerHelp")}
					</p>
				</div>
				{sourcesQuery.isPending && (
					<output className="flex items-center gap-2 text-muted-foreground text-xs">
						<Loader2Icon
							className="size-3 motion-safe:animate-spin"
							aria-hidden="true"
						/>
						{t("sourcesLoading")}
					</output>
				)}
				{sourcesQuery.isError && !state.sourcesLoaded && (
					<div className="flex flex-wrap items-center gap-3">
						<p
							id={sourcesErrorId}
							className="text-destructive text-sm"
						>
							{t("sourcesFailed")}
						</p>
						<Button
							type="button"
							variant="outline"
							size="sm"
							aria-describedby={sourcesErrorId}
							onClick={() => sourcesQuery.refetch()}
						>
							{t("retry")}
						</Button>
					</div>
				)}

				<div className="space-y-4">
					<div className="space-y-1">
						<h4 className="font-medium text-sm">{t("colors")}</h4>
						<p className="text-muted-foreground text-xs">
							{t("colorsHelp")}
						</p>
					</div>
					<ProposerColorField
						kind="primary"
						id={`${idPrefix}-primary`}
						entries={styleDraft.primary}
						proposer={proposer}
						disabled={locked}
						onChange={(primary) => state.editStyle({ primary })}
					/>
					<ProposerColorField
						kind="accents"
						id={`${idPrefix}-accents`}
						entries={styleDraft.accents}
						proposer={proposer}
						disabled={locked}
						onChange={(accents) => state.editStyle({ accents })}
					/>
				</div>

				{proposer && <BrandKitValues proposer={proposer} />}
			</div>

			<div className="space-y-4">
				<div className="space-y-1">
					<h3 className="font-medium text-base">{t("recipient")}</h3>
					<p className="text-muted-foreground text-xs">
						{t("recipientHelp")}
					</p>
				</div>
				{state.sourcesLoaded && (
					<RecipientSourceList recipient={state.recipientSources} />
				)}
				{state.recipientHost && (
					<RecipientSuggestionArea
						host={state.recipientHost}
						view={state.suggestionView}
						requestError={state.fetchRequestError}
						canAct={state.recipientEditable}
						dirty={state.recipientDirty}
						locked={
							state.saving ||
							state.confirming ||
							state.fieldsPending
						}
						idPrefix={`${idPrefix}-suggestion`}
						onConfirm={state.confirm}
						onFetchAgain={state.fetchAgain}
					/>
				)}
				{/* Always mounted (an implicit polite status), so a confirmed
				    value is announced as focus moves to it. */}
				<output className="block text-muted-foreground text-sm">
					{confirmFeedback.kind === "applied"
						? t("suggestion.applied", {
								host: confirmFeedback.host,
							})
						: null}
				</output>
				{confirmFeedback.kind !== "none" &&
					confirmFeedback.kind !== "applied" && (
						<Alert variant="warning" role="status">
							<AlertDescription className="mt-0">
								{confirmFeedback.kind === "failed"
									? t("recipientFailed")
									: t(`suggestion.${confirmFeedback.kind}`)}
							</AlertDescription>
						</Alert>
					)}
				{feedback.kind === "recipientConflict" && (
					<Alert variant="warning" role="status">
						<AlertDescription className="mt-0">
							{t("recipientConflict")}
						</AlertDescription>
					</Alert>
				)}
				{recipientRead ? (
					<RecipientBrandFields
						// Remounted when the draft is read again, not on every
						// newer version a background read brings.
						key={
							state.recipientBaseVersion ?? recipientRead.version
						}
						projectId={projectId}
						value={state.recipientDraft}
						onChange={state.editRecipient}
						currentLogoUrl={
							recipientRead.recipientBrand?.logoUrl ?? null
						}
						disabled={!state.recipientEditable}
						readOnlyReason={
							canEdit && !state.recipientEditable
								? "membersOnly"
								: null
						}
						busy={state.saving || state.confirming}
						logoError={state.logoError}
						idPrefix={recipientIdPrefix}
						onPendingChange={state.setFieldsPending}
						onFetched={state.markFetched}
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
							loading={state.saving}
							disabled={
								!dirty ||
								state.fieldsPending ||
								state.confirming
							}
							onClick={state.save}
						>
							{t("save")}
						</Button>
						{dirty && !state.saving && (
							<Button
								type="button"
								variant="outline"
								onClick={state.discard}
							>
								{t("discard")}
							</Button>
						)}
						{/* Always mounted (an implicit polite status), so the
						    change to and from saving is announced. */}
						<output className="text-muted-foreground text-sm">
							{state.saving
								? t("saving")
								: dirty
									? t("unsaved")
									: null}
						</output>
					</div>
					<SaveFeedback
						feedback={feedback}
						isGenerating={isGenerating}
						onRegenerate={
							onRegenerate
								? () => {
										state.dismissFeedback();
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

/** The switch for the diagrams Fabric adds after each generation. */
function AutoVisualsField({
	id,
	checked,
	disabled,
	onChange,
}: {
	id: string;
	checked: boolean;
	disabled: boolean;
	onChange: (checked: boolean) => void;
}) {
	const t = useTranslations("projects.proposalArtifact.style");
	const helpId = `${id}-help`;
	return (
		<div className="space-y-3">
			<h3 className="font-medium text-base">{t("diagrams")}</h3>
			<div className="flex items-start gap-3">
				<Switch
					id={id}
					checked={checked}
					disabled={disabled}
					aria-describedby={helpId}
					onCheckedChange={onChange}
				/>
				<div className="space-y-1">
					<Label htmlFor={id}>{t("autoVisuals")}</Label>
					<p id={helpId} className="text-muted-foreground text-xs">
						{t("autoVisualsHelp")}
					</p>
				</div>
			</div>
		</div>
	);
}

/**
 * The card every state of the tab renders in. Its wrapper is what the
 * automatic recipient fetch watches: a hidden tab panel hides it too.
 */
function StylePanelShell({
	rootRef,
	children,
}: {
	rootRef: (element: HTMLDivElement | null) => void;
	children: ReactNode;
}) {
	const t = useTranslations("projects.proposalArtifact.style");
	return (
		<div ref={rootRef}>
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
		</div>
	);
}
