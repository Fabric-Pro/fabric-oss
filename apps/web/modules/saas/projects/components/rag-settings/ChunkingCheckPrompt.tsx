"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { SearchCheckIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useChunkingAnalysis } from "./ChunkingAnalysis";

/**
 * "Check search in this project?" (spec 2026-10-28 §8d, variant B).
 *
 * Shown on RAG Settings and the project overview when the content or the
 * embedding model changed enough since the last chunking check. The server
 * decides from counts only; nothing runs until the person says yes, and
 * "Not now" is remembered in this browser.
 */

type Reason = "model-changed" | "content-changed" | "stale" | "never-checked";

/** "Not now" for a model change is shorter: results mix two models meanwhile. */
const SNOOZE_DAYS: Record<Reason, number> = {
	"model-changed": 7,
	"content-changed": 30,
	stale: 30,
	"never-checked": 30,
};

function snoozeKey(projectId: string) {
	return `fabric.chunking-check.snooze.${projectId}`;
}

function readSnooze(
	projectId: string,
): { until: number; reason: Reason } | null {
	try {
		const raw = window.localStorage.getItem(snoozeKey(projectId));
		return raw
			? (JSON.parse(raw) as { until: number; reason: Reason })
			: null;
	} catch {
		return null;
	}
}

function writeSnooze(projectId: string, reason: Reason) {
	try {
		window.localStorage.setItem(
			snoozeKey(projectId),
			JSON.stringify({
				until: Date.now() + SNOOZE_DAYS[reason] * 86_400_000,
				reason,
			}),
		);
	} catch {
		// Storage unavailable: the prompt simply comes back next visit.
	}
}

function formatDate(iso: string | null): string {
	return iso ? new Date(iso).toLocaleDateString() : "";
}

function copy(prompt: {
	reason: Reason;
	lastCheckedAt: string | null;
	sources: number;
	sourcesAtLastCheck: number | null;
	addedSince: number;
	embeddingModel: string | null;
	embeddingModelAtLastCheck: string | null;
}): { title: string; body: string } {
	switch (prompt.reason) {
		case "model-changed":
			return {
				title: "Your organization switched to a new search model",
				body: `This project's search index was built with ${prompt.embeddingModelAtLastCheck}, and new content now uses ${prompt.embeddingModel}. A check shows whether to rebuild the index so all content is searched the same way.`,
			};
		case "content-changed":
			return {
				title: "This project's content changed a lot",
				body:
					prompt.sourcesAtLastCheck === null
						? `${prompt.addedSince.toLocaleString()} sources were added since search was last checked on ${formatDate(prompt.lastCheckedAt)}. A check shows whether a different way of splitting them would find answers better.`
						: `The project went from ${prompt.sourcesAtLastCheck.toLocaleString()} to ${prompt.sources.toLocaleString()} sources since search was last checked on ${formatDate(prompt.lastCheckedAt)}. A check shows whether a different way of splitting them would find answers better.`,
			};
		case "stale":
			return {
				title: "Search hasn't been checked for a while",
				body: `Last checked on ${formatDate(prompt.lastCheckedAt)}; ${prompt.addedSince.toLocaleString()} sources were added since. A check takes a few minutes and changes nothing on its own.`,
			};
		case "never-checked":
			return {
				title: "Check how well search works in this project?",
				body: `Fabric can sample a few of the ${prompt.sources.toLocaleString()} sources, ask test questions and show how often search finds the answer, with a suggestion if it can do better. Nothing changes until you approve.`,
			};
	}
}

export function ChunkingCheckPrompt({
	projectId,
	settingsHref,
}: {
	projectId: string;
	/** On the overview: where "Check now" leads, so the results are visible. */
	settingsHref?: string;
}) {
	const { data } = useQuery(
		orpc.projects.ragSettings.chunkingCheck.queryOptions({
			input: { projectId },
		}),
	);
	const { data: runs } = useQuery(
		orpc.projects.ragSettings.chunkingRuns.queryOptions({
			input: { projectId },
		}),
	);
	const { ask, starting, dialog } = useChunkingAnalysis(projectId);
	const [snoozedReason, setSnoozedReason] = useState<Reason | null>(null);

	// Read after mount: localStorage is not available while rendering on the
	// server, and the prompt must not flash for a snoozed project.
	useEffect(() => {
		const snooze = readSnooze(projectId);
		setSnoozedReason(
			snooze && snooze.until > Date.now() ? snooze.reason : null,
		);
	}, [projectId]);

	const prompt = data?.prompt;
	const checking =
		runs?.measure?.status === "RUNNING" ||
		runs?.tune?.status === "RUNNING" ||
		runs?.rechunk?.status === "RUNNING";
	// A model change shows through a snooze given for a smaller reason.
	const snoozed =
		snoozedReason !== null &&
		!(
			prompt?.reason === "model-changed" &&
			snoozedReason !== "model-changed"
		);
	if (!prompt || checking || snoozed) {
		return dialog;
	}
	const reason = prompt.reason as Reason;
	const { title, body } = copy({ ...prompt, reason });

	return (
		<section
			aria-label="Search check"
			className="flex flex-col gap-3 rounded-lg border bg-muted/40 p-4 sm:flex-row sm:items-start"
		>
			<SearchCheckIcon
				aria-hidden="true"
				className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground"
			/>
			<div className="flex-1 space-y-1">
				<p className="font-medium text-sm">{title}</p>
				<p className="text-muted-foreground text-sm">{body}</p>
			</div>
			<div className="flex shrink-0 gap-2">
				{settingsHref ? (
					<Button asChild size="sm">
						<Link href={settingsHref}>Check now</Link>
					</Button>
				) : (
					<Button
						size="sm"
						disabled={starting}
						onClick={() => ask("MEASURE")}
					>
						Check now
					</Button>
				)}
				<Button
					size="sm"
					variant="ghost"
					onClick={() => {
						writeSnooze(projectId, reason);
						setSnoozedReason(reason);
					}}
				>
					Not now
				</Button>
			</div>
			{dialog}
		</section>
	);
}
