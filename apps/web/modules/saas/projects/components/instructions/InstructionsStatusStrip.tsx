"use client";

import { Button } from "@ui/components/button";
import { PlugIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import {
	type BaseComparison,
	comparisonHasChanges,
} from "../../lib/instructions-base-changes";
import { leftOutListing } from "../../lib/instructions-left-out";
import type { InstructionsSnapshot } from "../../lib/instructions-snapshot";

/** One labelled fact of the strip: the label above, the value below. */
export function InstructionsStatusFact({
	label,
	children,
}: {
	label: string;
	children: ReactNode;
}) {
	return (
		<div className="flex min-w-0 flex-col gap-1 border-border border-l px-5 first:border-l-0">
			<dt className="fab-label">{label}</dt>
			<dd className="m-0 flex flex-wrap items-baseline gap-x-2 text-sm [overflow-wrap:anywhere]">
				{children}
			</dd>
		</div>
	);
}

/** A button that reads as a link, inside a fact's value. */
const FACT_ACTION = "h-auto p-0 text-sm underline";

export function InstructionsStatusFacts({ children }: { children: ReactNode }) {
	return (
		<dl
			data-testid="instructions-status-strip"
			data-onboarding-target="coding-instructions-status"
			className="m-0 flex flex-wrap gap-y-3 rounded-[10px] border border-border bg-card py-3"
		>
			{children}
		</dl>
	);
}

export function InstructionsAgentFact({
	onConnect,
}: {
	onConnect?: () => void;
}) {
	const t = useTranslations("projects.codingInstructions.publishedView");
	return (
		<InstructionsStatusFact label={t("statusAgents")}>
			<span>{t("statusMcp")}</span>
			{onConnect ? (
				<Button
					type="button"
					variant="link"
					className={`${FACT_ACTION} gap-1`}
					data-onboarding-target="coding-instructions-connect"
					onClick={onConnect}
				>
					<PlugIcon className="size-3.5" aria-hidden="true" />
					{t("connectButton")}
				</Button>
			) : null}
		</InstructionsStatusFact>
	);
}

const Fact = InstructionsStatusFact;

/**
 * The published version as labelled facts, in place of a sentence holding five
 * of them: where it came from, who published it and when, how many files it
 * holds and left out, what changed since the version it was edited from, and
 * how agents read it. The two facts that lead somewhere carry the way there:
 * the left-out files are listed in the tree on request, the changes open the
 * compare dialog, and Connect your agent sits beside the Fabric MCP it names.
 *
 * `publishedBy` is passed in because a synced version names the commit's own
 * author, which needs the branch's history to find; an upload names whoever
 * uploaded it.
 */
export function InstructionsStatusStrip({
	published,
	repository,
	reason,
	publishedBy,
	comparison,
	leftOutShown,
	onToggleLeftOut,
	onCompare,
	onConnect,
}: {
	published: InstructionsSnapshot;
	/** `owner/name` of a synced version's repository, or a plain "the repository" when it is no longer the configured one. */
	repository: string;
	/** Why files were left out, worded ("by the default rules"). */
	reason: string;
	publishedBy: ReactNode;
	/** What the published version changed from the version it was edited from, once it is known. */
	comparison?: BaseComparison;
	leftOutShown: boolean;
	onToggleLeftOut: () => void;
	onCompare: () => void;
	/** Opens the Connect dialog. Absent for guests and without an organization. */
	onConnect?: () => void;
}) {
	const t = useTranslations("projects.codingInstructions.publishedView");
	const listing = leftOutListing(
		published.excludedCount,
		published.excludedPaths,
	);
	const shown = published.excludedPaths?.length ?? 0;

	const source =
		published.source === "REPOSITORY"
			? t("statusSourceRepository", {
					repository,
					ref: published.sourceRef ?? "",
				})
			: published.baseVersion != null
				? t("statusSourceEdit", { version: published.baseVersion })
				: t("statusSourceUpload");

	return (
		<InstructionsStatusFacts>
			<Fact label={t("statusSource")}>
				<span>{source}</span>
			</Fact>
			<Fact label={t("statusPublished")}>{publishedBy}</Fact>
			<Fact label={t("statusStored")}>
				<span>{t("statusFiles", { count: published.fileCount })}</span>
			</Fact>
			{published.excludedCount > 0 ? (
				<Fact label={t("statusLeftOut")}>
					<span>
						{t("statusFiles", { count: published.excludedCount })}{" "}
						<span className="text-muted-foreground">{reason}</span>
					</span>
					{listing.listable ? (
						<Button
							type="button"
							variant="link"
							className={FACT_ACTION}
							aria-pressed={leftOutShown}
							onClick={onToggleLeftOut}
						>
							{t(
								leftOutShown
									? "statusHideLeftOut"
									: "statusShowLeftOut",
							)}
						</Button>
					) : null}
					{listing.listable && listing.partial && leftOutShown ? (
						<span className="text-muted-foreground text-xs">
							{t("statusLeftOutPartial", { shown })}
						</span>
					) : null}
				</Fact>
			) : null}
			{comparison ? (
				<Fact
					label={t("statusSince", {
						version: comparison.from.version,
					})}
				>
					{comparisonHasChanges(comparison) ? (
						<>
							<span>
								{comparison.added.length > 0 ? (
									<span className="text-success">
										{t("statusAdded", {
											count: comparison.added.length,
										})}
									</span>
								) : null}
								{comparison.added.length > 0 &&
								comparison.changed.length > 0
									? " · "
									: null}
								{comparison.changed.length > 0 ? (
									<span className="text-highlight-ink">
										{t("statusChanged", {
											count: comparison.changed.length,
										})}
									</span>
								) : null}
								{(comparison.added.length > 0 ||
									comparison.changed.length > 0) &&
								comparison.removed.length > 0
									? " · "
									: null}
								{comparison.removed.length > 0 ? (
									<span className="text-destructive">
										{t("statusRemoved", {
											count: comparison.removed.length,
										})}
									</span>
								) : null}
							</span>
							<Button
								type="button"
								variant="link"
								className={FACT_ACTION}
								onClick={onCompare}
							>
								{t("compareButton")}
							</Button>
						</>
					) : (
						<span>{t("statusNoChanges")}</span>
					)}
				</Fact>
			) : null}
			<InstructionsAgentFact onConnect={onConnect} />
		</InstructionsStatusFacts>
	);
}
