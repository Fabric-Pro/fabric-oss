"use client";

/**
 * Rules health (specs/2026-10-21-ai-artifacts-hub §5.8): how much of every
 * coding session the project's rules take, how they are loaded (always on,
 * by path, on demand), what is duplicated or too long, and an AI review for
 * contradictions and merges.
 */

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import { Markdown } from "@ui/components/markdown";
import { ChevronDownIcon, ChevronRightIcon, Loader2Icon } from "lucide-react";
import { useState } from "react";

const TIER_LABELS: Record<string, string> = {
	"always-on": "always on",
	scoped: "by path",
	"on-demand": "on demand",
	"over-budget": "over budget",
};

const FINDING_LABELS: Record<string, string> = {
	duplicate: "Duplicate",
	"near-duplicate": "Near duplicate",
	"over-budget": "Over the always-on budget",
	long: "Long rule",
	"no-description": "No description",
	empty: "Empty rule",
};

export function RulesHealthPanel({ projectId }: { projectId: string }) {
	const [open, setOpen] = useState(false);
	const health = useQuery({
		...orpc.projects.instructions.rulesHealth.queryOptions({
			input: { projectId },
		}),
		retry: false,
	});
	const review = useMutation(
		orpc.projects.instructions.reviewRules.mutationOptions(),
	);
	const data = health.data;
	if (!data || data.rules.length === 0) {
		return null;
	}
	const counts = data.rules.reduce<Record<string, number>>((acc, rule) => {
		acc[rule.tier] = (acc[rule.tier] ?? 0) + 1;
		return acc;
	}, {});
	const used = Math.min(
		100,
		Math.round((data.alwaysOnChars / data.budget) * 100),
	);

	return (
		<Card className="flex flex-col gap-2 p-4">
			<button
				type="button"
				className="flex w-full flex-wrap items-center justify-between gap-2 text-left"
				aria-expanded={open}
				onClick={() => setOpen((v) => !v)}
			>
				<span className="flex items-center gap-2 font-medium text-sm">
					{open ? (
						<ChevronDownIcon
							className="size-4"
							aria-hidden="true"
						/>
					) : (
						<ChevronRightIcon
							className="size-4"
							aria-hidden="true"
						/>
					)}
					Rules health
				</span>
				<span className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
					<span>
						{data.rules.length} rules ·{" "}
						{Object.entries(counts)
							.map(
								([tier, n]) =>
									`${n} ${TIER_LABELS[tier] ?? tier}`,
							)
							.join(" · ")}
					</span>
					{data.findings.length > 0 ? (
						<Badge status="warning">
							{data.findings.length} to clean up
						</Badge>
					) : (
						<Badge status="success">clean</Badge>
					)}
				</span>
			</button>
			<div className="flex items-center gap-2 text-xs">
				<span className="text-muted-foreground">Always-on budget</span>
				<div
					className="h-2 flex-1 overflow-hidden rounded bg-muted"
					role="meter"
					aria-label="Always-on rules budget"
					aria-valuemin={0}
					aria-valuemax={data.budget}
					aria-valuenow={data.alwaysOnChars}
				>
					<div
						className={`h-full ${used >= 100 ? "bg-destructive" : used >= 80 ? "bg-amber-500" : "bg-primary"}`}
						style={{ width: `${used}%` }}
					/>
				</div>
				<span className="tabular-nums">
					{data.alwaysOnChars.toLocaleString()} /{" "}
					{data.budget.toLocaleString()}
				</span>
			</div>
			{open ? (
				<div className="flex flex-col gap-3">
					<p className="text-muted-foreground text-xs">
						Rules with <code>paths:</code> load only for matching
						files; rules marked <code>load: on-demand</code> (and
						always-on rules past the budget) load when a task calls
						for them, through the plugin's fabric-rules skill.
					</p>
					{data.findings.length > 0 ? (
						<ul className="flex flex-col gap-2">
							{data.findings.map((finding, index) => (
								<li
									key={`${finding.kind}-${index}`}
									className="rounded-md border p-2 text-xs"
								>
									<p className="font-medium">
										{FINDING_LABELS[finding.kind] ??
											finding.kind}
									</p>
									<p className="text-muted-foreground">
										{finding.detail}
									</p>
									<p className="break-all">
										{finding.paths.map((p) => (
											<code key={p} className="mr-2">
												{p}
											</code>
										))}
									</p>
								</li>
							))}
						</ul>
					) : null}
					<div className="flex flex-col gap-2">
						<Button
							type="button"
							size="sm"
							variant="outline"
							className="self-start"
							disabled={review.isPending}
							onClick={() => review.mutate({ projectId })}
						>
							{review.isPending ? (
								<Loader2Icon
									className="size-4 motion-safe:animate-spin"
									aria-hidden="true"
								/>
							) : null}
							Review with AI
						</Button>
						{review.error ? (
							<p
								role="alert"
								className="text-destructive text-xs"
							>
								{review.error.message}
							</p>
						) : null}
						{review.data ? (
							<div className="rounded-md border p-3 text-sm">
								<Markdown>{review.data.review}</Markdown>
							</div>
						) : null}
					</div>
				</div>
			) : null}
		</Card>
	);
}
