/**
 * Spike runs — web-side contract for the inverted-loop plan, Slice 3.
 *
 * This module is the only place that knows the exact shape of the spike
 * endpoints (`codingRuns.start` with `kind: "SPIKE"`, `codingRuns.acceptSpike`,
 * `codingRuns.discardSpike`, `frames.listForStory`). The input types below
 * are checked against the router types at the call sites, so a contract
 * change fails type-check here rather than somewhere in a component.
 */

import { orpcClient } from "@shared/lib/orpc-client";
import type { DeliveryTrack } from "./stories/types";

type CodingRunKind = "IMPLEMENT" | "SPIKE";

export type SpikeRunStatus =
	| "QUEUED"
	| "STARTING"
	| "RUNNING"
	| "AWAITING_REVIEW"
	| "PR_OPENED"
	| "DEMO_READY"
	| "COMPLETED"
	| "FAILED"
	| "CANCELLED";

/** Tracks a person may pick as the recommended next step after a spike. */
export type SpikeNextTrack = Extract<
	DeliveryTrack,
	"SPIKE" | "DISCOVERY" | "SPECIFY" | "DEFER"
>;

export const SPIKE_NEXT_TRACKS: readonly SpikeNextTrack[] = [
	"SPIKE",
	"DISCOVERY",
	"SPECIFY",
	"DEFER",
];

/** Minimum play-notes length enforced by `codingRuns.acceptSpike`. */
export const SPIKE_PLAY_NOTES_MIN_LENGTH = 20;

/** Fields of a coding run that matter for the spike UI. */
export interface SpikeRunView {
	id: string;
	kind: CodingRunKind;
	status: SpikeRunStatus;
	storyId: string | null;
	spikeQuestion: string | null;
	spikeBranch: string | null;
	findings: string | null;
	playNotes: string | null;
	demoFrameId: string | null;
	demoUrl: string | null;
	error: string | null;
	createdAt: string | null;
	updatedAt: string | null;
}

/** Statuses that block another run on the same story (F2 partial index). */
export const ACTIVE_SPIKE_STATUSES: readonly SpikeRunStatus[] = [
	"QUEUED",
	"STARTING",
	"RUNNING",
	"AWAITING_REVIEW",
	"PR_OPENED",
	"DEMO_READY",
];

function str(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function dateStr(value: unknown): string | null {
	if (value instanceof Date) {
		return value.toISOString();
	}
	return typeof value === "string" ? value : null;
}

/**
 * Read the spike-relevant fields off any coding-run DTO (list item, `get`
 * result, or kanban `latestCodingRun` summary). Returns `null` when the input
 * is not a run.
 */
export function asSpikeRunView(run: unknown): SpikeRunView | null {
	if (typeof run !== "object" || run === null) {
		return null;
	}
	const r = run as Record<string, unknown>;
	if (typeof r.id !== "string" || typeof r.status !== "string") {
		return null;
	}
	return {
		id: r.id,
		kind: r.kind === "SPIKE" ? "SPIKE" : "IMPLEMENT",
		status: r.status as SpikeRunStatus,
		storyId: str(r.storyId),
		spikeQuestion: str(r.spikeQuestion),
		spikeBranch: str(r.spikeBranch),
		findings: str(r.findings),
		playNotes: str(r.playNotes),
		demoFrameId: str(r.demoFrameId),
		demoUrl: str(r.demoUrl),
		error: str(r.error) ?? str(r.errorMessage),
		createdAt: dateStr(r.createdAt),
		updatedAt: dateStr(r.updatedAt),
	};
}

/** Frame DTO fields the evidence section renders. */
export interface StoryFrameView {
	id: string;
	title: string;
	description: string | null;
	kind: "frame" | "slideshow" | string;
	projectId: string | null;
	storyId: string | null;
	shareScope: string | null;
	sourceRunId: string | null;
	createdAt: string | null;
	updatedAt: string | null;
}

function asStoryFrameView(frame: unknown): StoryFrameView | null {
	if (typeof frame !== "object" || frame === null) {
		return null;
	}
	const f = frame as Record<string, unknown>;
	if (typeof f.id !== "string") {
		return null;
	}
	return {
		id: f.id,
		title: str(f.title) ?? str(f.name) ?? "Untitled frame",
		description: str(f.description),
		kind: str(f.kind) ?? "frame",
		projectId: str(f.projectId),
		storyId: str(f.storyId),
		shareScope: str(f.shareScope),
		sourceRunId: str(f.sourceRunId),
		createdAt: dateStr(f.createdAt),
		updatedAt: dateStr(f.updatedAt),
	};
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

export interface StartSpikeInput {
	projectId: string;
	storyId: string;
	organizationId: string | null;
	kind: "SPIKE";
	spikeQuestion: string;
}

export interface StartSpikeResult {
	codingRunId: string;
	workflowId: string;
	status: string;
}

export interface AcceptSpikeInput {
	codingRunId: string;
	projectId: string;
	organizationId: string | null;
	playNotes: string;
	nextTrack?: SpikeNextTrack;
}

export interface DiscardSpikeInput {
	codingRunId: string;
	projectId: string;
	organizationId: string | null;
	reason?: string;
}

export interface ListFramesForStoryInput {
	projectId: string;
	storyId: string;
	organizationId: string | null;
}

export function startSpikeRun(
	input: Omit<StartSpikeInput, "kind">,
): Promise<StartSpikeResult> {
	const payload: StartSpikeInput = { ...input, kind: "SPIKE" };
	return orpcClient.codingRuns.start(payload);
}

export function acceptSpikeRun(input: AcceptSpikeInput) {
	return orpcClient.codingRuns.acceptSpike(input);
}

export function discardSpikeRun(input: DiscardSpikeInput) {
	return orpcClient.codingRuns.discardSpike(input);
}

export async function listFramesForStory(
	input: ListFramesForStoryInput,
): Promise<StoryFrameView[]> {
	const rows: unknown[] = await orpcClient.frames.listForStory(input);
	return rows
		.map(asStoryFrameView)
		.filter((frame): frame is StoryFrameView => frame !== null);
}

export function framesForStoryQueryKey(input: ListFramesForStoryInput) {
	return [
		"frames",
		"listForStory",
		input.projectId,
		input.storyId,
		input.organizationId ?? null,
	] as const;
}
