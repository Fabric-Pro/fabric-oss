import { createHash } from "node:crypto";
import type { AzureDevOpsStorySnapshot } from "@repo/connectors";
import { z } from "zod";

function canonical(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(canonical).join(",")}]`;
	}
	if (value && typeof value === "object") {
		return `{${Object.entries(value)
			.filter(([, item]) => item !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

export function reviewFingerprint(value: unknown): string {
	return createHash("sha256").update(canonical(value)).digest("hex");
}

export const storyReviewSchema = z
	.object({
		id: z.number().int().positive(),
		verdict: z.enum(["ready", "needs_work", "blocked"]),
		summary: z.string().min(1).max(1_000),
		issues: z.array(z.string().min(1).max(400)).max(8),
	})
	.strict();

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const sourceDetailsSchema = z
	.object({
		requirements: z
			.record(z.string().max(128), hash)
			.refine((fields) => Object.keys(fields).length <= 20),
		comments: z
			.array(
				z
					.object({
						id: z.number().int().positive(),
						version: z.number().int().positive(),
						isDeleted: z.boolean(),
						fingerprint: hash,
					})
					.strict(),
			)
			.max(1_000),
	})
	.strict()
	.refine(
		(source) =>
			new Set(source.comments.map((comment) => comment.id)).size ===
			source.comments.length,
	);

export const observationSchema = z
	.object({
		title: z.string().max(4_000),
		state: z.string().max(256),
		assignedTo: z.string().max(512).nullable(),
		workItemType: z.string().max(128),
	})
	.strict();

export function sourceFingerprint(story: AzureDevOpsStorySnapshot): string {
	return reviewFingerprint(sourceDetails(story));
}

export function sourceDetails(story: AzureDevOpsStorySnapshot) {
	return sourceDetailsSchema.parse({
		requirements: Object.fromEntries(
			Object.entries(story.requirements)
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([field, value]) => [field, reviewFingerprint(value)]),
		),
		comments: [...story.comments.comments]
			.sort((a, b) => a.id - b.id)
			.map((comment) => ({
				id: comment.id,
				version: comment.version,
				isDeleted: comment.isDeleted,
				fingerprint: reviewFingerprint(comment),
			})),
	});
}

export function observation(story: AzureDevOpsStorySnapshot) {
	return observationSchema.parse({
		title: story.title,
		state: story.state,
		assignedTo: story.assignedTo?.uniqueName ?? null,
		workItemType: story.workItemType,
	});
}
