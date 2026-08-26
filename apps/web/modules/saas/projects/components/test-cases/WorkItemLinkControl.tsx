"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import {
	buildStoryDetailsRoute,
	buildStoryQaRoute,
} from "@saas/projects/lib/stories/routes";
import { Button } from "@ui/components/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { LinkIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { AcRefPicker } from "./AcRefPicker";
import { FeaturePicker } from "./FeaturePicker";

/** A case↔work-item link as edited in the sheet (display fields included). */
export type WorkItemLinkDraft = {
	userStoryId: string;
	/** Bare refs as stored, e.g. `["2", "5"]`. A case may cover several criteria. */
	acceptanceCriterionRefs?: string[];
	identifier?: string;
	title?: string;
	kind?: string | null;
};

type StoryOption = {
	id: string;
	identifier: string;
	title: string;
	kind?: string | null;
};

function kindLabel(kind: string | null | undefined, fallback: string): string {
	if (!kind) {
		return fallback;
	}
	return kind.charAt(0).toUpperCase() + kind.slice(1).toLowerCase();
}

type Props = {
	projectId: string;
	organizationId: string | null;
	links: WorkItemLinkDraft[];
	onAdd: (story: StoryOption) => void;
	onRemove: (userStoryId: string) => void;
	onChangeAcRef: (userStoryId: string, refs: string[]) => void;
	/** Called when the selection settles so edit-mode can persist once per edit
	 * (rather than per keystroke). Omitted in create-mode (held in the payload). */
	onCommitAcRef?: (userStoryId: string, refs: string[]) => void;
	disabled?: boolean;
};

/**
 * Search/select a project Feature/Bug to link to the case, with an optional
 * "Covers AC" reference per link. Controlled: the parent owns the link list and
 * decides whether each add/remove persists immediately (edit) or is held for the
 * create payload. The AC ref is stored as a bare value (e.g. "2") because the
 * RAG context formatter prefixes "Covers AC".
 */
export function WorkItemLinkControl({
	projectId,
	organizationId,
	links,
	onAdd,
	onRemove,
	onChangeAcRef,
	onCommitAcRef,
	disabled,
}: Props) {
	const t = useTranslations("projects.testCases");
	const { basePath } = useOrganizationContext();

	const linkedIds = useMemo(
		() => new Set(links.map((l) => l.userStoryId)),
		[links],
	);

	return (
		<div className="space-y-2">
			<div className="flex items-center justify-between">
				<div>
					<p className="app-editorial-label">{t("links.heading")}</p>
					{/* This control, plan membership and the AC ref all write on
					    click/blur, while the fields above are draft-only — one
					    sheet, two persistence models, and a single Cancel button
					    that only ever discarded the drafts. Say which is which
					    rather than implying an undo that never existed. */}
					<p className="mt-0.5 text-[11px] text-muted-foreground">
						{t("editor.savesImmediately")}
					</p>
				</div>
				{/* Already-linked items are excluded rather than shown ticked:
				    this control adds links, and the list below is the selection. */}
				<FeaturePicker
					projectId={projectId}
					organizationId={organizationId}
					value={[]}
					onChange={(selected) => {
						const story = selected[0];
						if (story) {
							onAdd(story);
						}
					}}
					excludeIds={linkedIds}
					disabled={disabled}
					trigger={
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={disabled}
						>
							<LinkIcon
								className="mr-2 size-4"
								aria-hidden="true"
							/>
							{t("actions.link")}
						</Button>
					}
				/>
			</div>

			{links.length === 0 ? (
				<p className="text-muted-foreground text-sm">
					{t("links.empty")}
				</p>
			) : (
				<ul className="space-y-1.5">
					{links.map((link) => (
						<li
							key={link.userStoryId}
							className="flex flex-wrap items-center gap-2 rounded-md border bg-card px-3 py-2"
						>
							<span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
								{kindLabel(
									link.kind,
									t("links.workItemFallback"),
								)}
							</span>
							{link.identifier && (
								<Link
									href={
										// Case→criterion direction of the QA
										// traceability matrix:
										// a FEATURE link lands on the QA tab,
										// where its "Covers AC" row lives. The
										// param degrades to the default tab for
										// bugs or when the QA tab is off.
										link.kind === "FEATURE"
											? buildStoryQaRoute(
													basePath,
													projectId,
													link.userStoryId,
												)
											: buildStoryDetailsRoute(
													basePath,
													projectId,
													link.userStoryId,
												)
									}
									className="shrink-0 font-mono text-primary text-xs tabular-nums hover:underline"
								>
									{link.identifier}
								</Link>
							)}
							<span className="min-w-0 flex-1 truncate text-sm">
								{link.title ?? link.userStoryId}
							</span>
							<div className="flex items-center gap-1">
								<span className="text-muted-foreground text-xs">
									{t("links.coversAc")}
								</span>
								<AcRefPicker
									projectId={projectId}
									organizationId={organizationId}
									storyId={link.userStoryId}
									identifier={
										link.identifier ??
										t("links.workItemFallback")
									}
									values={link.acceptanceCriterionRefs ?? []}
									onChange={(refs) =>
										onChangeAcRef(link.userStoryId, refs)
									}
									onCommit={
										onCommitAcRef &&
										((refs) =>
											onCommitAcRef(
												link.userStoryId,
												refs,
											))
									}
									disabled={disabled}
								/>
							</div>
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										type="button"
										variant="ghost"
										size="icon-sm"
										onClick={() =>
											onRemove(link.userStoryId)
										}
										disabled={disabled}
										aria-label={t("links.unlinkAria", {
											identifier:
												link.identifier ??
												t("links.workItemFallback"),
										})}
										className={cn(
											"text-muted-foreground hover:text-destructive",
										)}
									>
										<XIcon
											className="size-4"
											aria-hidden="true"
										/>
									</Button>
								</TooltipTrigger>
								<TooltipContent surface="popover">
									{t("actions.unlink")}
								</TooltipContent>
							</Tooltip>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
