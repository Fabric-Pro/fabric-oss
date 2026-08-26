"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@ui/components/skeleton";
import { cn } from "@ui/lib";
import { ChevronDownIcon, ShieldAlertIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { DecisionDateTime } from "./DecisionAtoms";

/**
 * Collapsible, read-only list of accepted decision pre-check overrides — the
 * immutable audit rows written when a reviewer accepted AI output that
 * contradicted a logged architecture decision. Mirrors the meeting-candidates
 * strip's collapse pattern (an `aria-expanded` toggle, keyboard-operable). No
 * actions and no mutations: it only reads the audit ledger. Like that sibling,
 * it renders nothing until at least one override exists — an override is a rare
 * event, so an empty strip would be permanent, information-free clutter.
 */
export function DecisionOverridesStrip({
	projectId,
	organizationId,
}: {
	projectId: string;
	organizationId?: string | null;
}) {
	const t = useTranslations("projects.decisionPrecheck.overrides");
	const [open, setOpen] = useState(false);

	const overridesQuery = useQuery(
		orpc.projects.architectureDecisions.overrides.list.queryOptions({
			input: { projectId, organizationId: organizationId ?? null },
		}),
	);
	const overrides = overridesQuery.data?.overrides ?? [];

	// Mirror MeetingCandidatesStrip: stay invisible until an override exists so
	// the Decisions tab isn't cluttered by a permanent empty audit strip.
	if (!overridesQuery.isLoading && overrides.length === 0) {
		return null;
	}

	const surfaceLabel = (surface: string) =>
		surface === "document"
			? t("surfaceDocument")
			: t("surfaceBacklogProposal");

	return (
		<div className="overflow-hidden rounded-lg border">
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				className="flex w-full items-center gap-2.5 px-4 py-3 text-left"
				aria-expanded={open}
				aria-label={t("toggleAria")}
			>
				<span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-highlight/10 text-highlight">
					<ShieldAlertIcon className="size-4" />
				</span>
				<span className="flex-1 text-sm">
					<strong className="font-semibold">{t("title")}</strong>
					{overrides.length > 0 && (
						<span className="ml-1.5 text-muted-foreground">
							{overrides.length}
						</span>
					)}
				</span>
				<span className="hidden text-muted-foreground text-xs md:inline">
					{t("subtitle")}
				</span>
				<ChevronDownIcon
					className={cn(
						"size-4 text-muted-foreground transition-transform",
						open && "rotate-180",
					)}
				/>
			</button>
			{open && (
				<div className="border-t p-3">
					{overridesQuery.isLoading ? (
						<div className="space-y-2">
							{[0, 1].map((i) => (
								<Skeleton
									key={i}
									className="h-14 w-full rounded-md"
								/>
							))}
						</div>
					) : (
						<div className="overflow-x-auto">
							<table className="w-full text-sm">
								<thead>
									<tr className="text-left text-muted-foreground text-xs">
										<th className="px-2 py-1.5 font-medium">
											{t("columnWhen")}
										</th>
										<th className="px-2 py-1.5 font-medium">
											{t("columnWho")}
										</th>
										<th className="px-2 py-1.5 font-medium">
											{t("columnDecision")}
										</th>
										<th className="px-2 py-1.5 font-medium">
											{t("columnSurface")}
										</th>
										<th className="px-2 py-1.5 font-medium">
											{t("columnConflict")}
										</th>
									</tr>
								</thead>
								<tbody>
									{overrides.map((o) => (
										<tr key={o.id} className="border-t">
											<td className="whitespace-nowrap px-2 py-2 align-top">
												<DecisionDateTime
													value={o.createdAt}
												/>
											</td>
											<td className="px-2 py-2 align-top">
												{o.actorName ||
													o.actorEmail ||
													"—"}
											</td>
											<td className="px-2 py-2 align-top">
												<span className="font-mono text-muted-foreground text-xs">
													{o.decisionIdentifier}
												</span>{" "}
												<span className="text-foreground">
													{o.decisionTitle}
												</span>
											</td>
											<td className="whitespace-nowrap px-2 py-2 align-top">
												{surfaceLabel(o.surface)}
											</td>
											<td className="px-2 py-2 align-top text-muted-foreground">
												{o.natureOfConflict}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
				</div>
			)}
		</div>
	);
}
