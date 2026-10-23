"use client";

import { Button } from "@ui/components/button";
import { Loader2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { BrandSourceChip, type BrandSourceLabel } from "./BrandSourceChip";
import type {
	RecipientSources,
	SuggestionField,
	SuggestionResult,
	SuggestionView,
} from "./proposal-style-model";

/** Why an explicit request to fetch the recipient's website did not run. */
export type FetchRequestError = "rate_limited" | "unavailable";

/**
 * Where each recipient field comes from: a person typed or confirmed every
 * value the recipient brand holds, so a field is either set by a person or
 * not set. A suggestion is shown apart, never as a source here.
 */
export function RecipientSourceList({
	recipient,
}: {
	recipient: RecipientSources | null;
}) {
	const t = useTranslations("projects.proposalArtifact.style");
	const fields: Array<{
		key: "name" | "website" | "logo" | "colors";
		set: boolean;
	}> = [
		{ key: "name", set: Boolean(recipient?.name) },
		{ key: "website", set: Boolean(recipient?.website) },
		{ key: "logo", set: recipient?.hasLogo ?? false },
		{ key: "colors", set: (recipient?.colors.length ?? 0) > 0 },
	];
	return (
		<div>
			<h4 className="sr-only">{t("recipientSources")}</h4>
			<dl className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
				{fields.map((field) => {
					const label: BrandSourceLabel = field.set
						? "person"
						: "notSet";
					return (
						<div
							key={field.key}
							className="flex items-center gap-1.5"
						>
							<dt className="text-muted-foreground">
								{t(`recipientFields.${field.key}`)}
							</dt>
							<dd>
								<BrandSourceChip label={label} />
							</dd>
						</div>
					);
				})}
			</dl>
		</div>
	);
}

/**
 * The fetch of the recipient's current website (Fizzy #2946): its progress
 * or failure as a polite status, and what it found as "not applied" until a
 * member confirms a field. Each field has its own Confirm, and there is no
 * Confirm all, so the fetched name is applied only by itself, after it is
 * shown in full. Nothing is offered while the recipient fields hold unsaved
 * changes: a confirm moves the recipient brand's version, which would replace
 * them.
 */
export function RecipientSuggestionArea({
	host,
	view,
	requestError,
	canAct,
	dirty,
	locked,
	idPrefix,
	onConfirm,
	onFetchAgain,
}: {
	host: string;
	view: SuggestionView;
	requestError: FetchRequestError | null;
	/** The server lets this person fetch and confirm. */
	canAct: boolean;
	/** The recipient fields hold unsaved changes. */
	dirty: boolean;
	/**
	 * A save or a confirm is in flight, or the recipient fields are still
	 * uploading or fetching.
	 */
	locked: boolean;
	idPrefix: string;
	onConfirm: (field: SuggestionField) => void;
	onFetchAgain: () => void;
}) {
	const t = useTranslations("projects.proposalArtifact.style");
	const hintId = `${idPrefix}-save-first`;

	const status = requestError
		? requestError === "rate_limited"
			? t("suggestion.failure.rate_limited")
			: t("suggestion.unavailable")
		: view.kind === "running"
			? t("suggestion.running", { host })
			: view.kind === "failed"
				? t(`suggestion.failure.${view.code}`, { host })
				: view.kind === "nothingFound"
					? t("suggestion.nothingFound", { host })
					: null;
	const offerFetchAgain =
		canAct &&
		view.kind !== "running" &&
		(requestError !== null ||
			view.kind === "failed" ||
			view.kind === "nothingFound" ||
			view.kind === "found");

	return (
		<div className="space-y-3">
			{/* Always mounted (an implicit polite status), so each state the
			    fetch moves through is announced. */}
			<output className="flex items-center gap-2 text-sm">
				{view.kind === "running" && !requestError && (
					<Loader2Icon
						className="size-4 text-muted-foreground motion-safe:animate-spin"
						aria-hidden="true"
					/>
				)}
				{status}
			</output>
			{view.kind === "found" && (
				<div className="space-y-3 rounded-lg border border-border p-4">
					<div className="space-y-1">
						<h4 className="font-medium text-sm">
							{t("suggestion.found", { host })}
						</h4>
						<p className="text-muted-foreground text-xs">
							{t("suggestion.foundHelp")}
						</p>
						{canAct && dirty && (
							<p
								id={hintId}
								className="text-muted-foreground text-xs"
							>
								{t("suggestion.saveFirst")}
							</p>
						)}
					</div>
					<ul className="space-y-3">
						{view.result.alternatives.map((field) => (
							<SuggestedValue
								key={field}
								field={field}
								result={view.result}
								host={host}
								canAct={canAct}
								disabled={dirty || locked}
								describedBy={dirty ? hintId : undefined}
								onConfirm={() => onConfirm(field)}
							/>
						))}
					</ul>
				</div>
			)}
			{offerFetchAgain && (
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={locked}
					onClick={onFetchAgain}
				>
					{t("suggestion.fetchAgain")}
				</Button>
			)}
		</div>
	);
}

function SuggestedValue({
	field,
	result,
	host,
	canAct,
	disabled,
	describedBy,
	onConfirm,
}: {
	field: SuggestionField;
	result: SuggestionResult;
	host: string;
	canAct: boolean;
	disabled: boolean;
	describedBy?: string;
	onConfirm: () => void;
}) {
	const t = useTranslations("projects.proposalArtifact.style");
	const colors = result.colors.join(", ");
	const confirmLabel =
		field === "name"
			? t("suggestion.confirmName", { value: result.name ?? "" })
			: field === "colors"
				? t("suggestion.confirmColors", { value: colors })
				: t("suggestion.confirmLogo", { host });

	return (
		<li className="flex flex-wrap items-start justify-between gap-3">
			<div className="min-w-0 flex-1 space-y-1">
				<p className="text-muted-foreground text-xs">
					{t(`suggestion.${field}`)}
				</p>
				{/* The fetched name is the website's text: plain text, in
				    full, before anyone confirms it. */}
				{field === "name" && (
					<p className="break-words text-sm">{result.name}</p>
				)}
				{field === "colors" && (
					<p className="font-mono text-sm">{colors}</p>
				)}
				{field === "logo" && result.logoUrl && (
					<div className="flex size-20 items-center justify-center overflow-hidden rounded-md border border-border bg-muted">
						{/* biome-ignore lint/performance/noImgElement: a short-lived signed read, which next/image cannot optimize */}
						<img
							src={result.logoUrl}
							alt={t("suggestion.logoAlt", { host })}
							className="max-h-full max-w-full object-contain"
						/>
					</div>
				)}
			</div>
			{canAct && (
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={disabled}
					aria-label={confirmLabel}
					aria-describedby={describedBy}
					onClick={onConfirm}
				>
					{t("suggestion.confirm")}
				</Button>
			)}
		</li>
	);
}
