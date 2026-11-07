import { z } from "zod";

export const FRAME_REVIEW_MAX_BYTES = 1_000_000;
export const frameReviewRevisionSchema = z.string().datetime({ offset: true });
export const frameReviewBlockSchema = z.strictObject({
	id: z.string().min(1).max(200),
	type: z.enum(["html", "json", "mermaid", "markdown"]),
	title: z.string().max(300).optional(),
	content: z.string().max(FRAME_REVIEW_MAX_BYTES),
	language: z.string().max(100).optional(),
});
export const frameReviewEditSchema = z
	.strictObject({
		title: z.string().trim().min(1).max(300).optional(),
		description: z.string().max(20000).optional(),
		presentation: z.enum(["DOCUMENT", "INTERFACE"]).optional(),
		blocks: z
			.array(frameReviewBlockSchema)
			.min(1)
			.max(100)
			.refine(
				(blocks) =>
					new Set(blocks.map((b) => b.id)).size === blocks.length,
				{ message: "Block identifiers must be unique." },
			)
			.refine(
				(blocks) =>
					blocks.every((b) => {
						if (b.type !== "json") {
							return true;
						}
						try {
							JSON.parse(b.content);
							return true;
						} catch {
							return false;
						}
					}),
				{ message: "JSON blocks must contain valid JSON." },
			)
			.optional(),
		theme: z
			.strictObject({
				mode: z.enum(["light", "dark", "system"]).optional(),
				accentColor: z.string().max(100).optional(),
			})
			.optional(),
	})
	.refine((value) => Object.keys(value).length > 0, {
		message: "Provide at least one content change.",
	});
export const frameProposeChangeSchema = z.strictObject({
	requestId: z
		.string()
		.uuid()
		.transform((v) => v.toLowerCase()),
	expectedUpdatedAt: frameReviewRevisionSchema,
	edit: frameReviewEditSchema,
});
export const frameChangeIdentitySchema = z.strictObject({
	proposalId: z.string().min(1).max(200),
});
export const frameApplyChangeSchema = frameChangeIdentitySchema.extend({
	expectedProposalHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export const frameApproveRevisionSchema = z.strictObject({
	expectedUpdatedAt: frameReviewRevisionSchema,
	expectedContentHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export const frameProposalListSchema = z.strictObject({
	limit: z.coerce.number().int().min(1).max(50).default(20),
	offset: z.coerce.number().int().min(0).default(0),
});
export type FrameReviewEdit = z.infer<typeof frameReviewEditSchema>;
export interface FrameReviewDocument {
	title: string;
	description?: string;
	presentation?: "DOCUMENT" | "INTERFACE";
	blocks: Array<z.infer<typeof frameReviewBlockSchema>>;
	theme?: { mode?: "light" | "dark" | "system"; accentColor?: string };
}
export interface FrameChangeSummary {
	titleChanged: boolean;
	descriptionChanged: boolean;
	presentationChanged: boolean;
	themeChanged: boolean;
	blocks: Array<{
		id: string;
		title?: string;
		change: "added" | "removed" | "updated";
	}>;
}
export function summarizeFrameChange(
	base: FrameReviewDocument,
	proposed: FrameReviewDocument,
): FrameChangeSummary {
	const previous = new Map(base.blocks.map((block) => [block.id, block]));
	const next = new Map(proposed.blocks.map((block) => [block.id, block]));
	const blocks: FrameChangeSummary["blocks"] = [];
	for (const block of proposed.blocks) {
		const old = previous.get(block.id);
		if (!old) {
			blocks.push({ id: block.id, title: block.title, change: "added" });
		} else if (JSON.stringify(old) !== JSON.stringify(block)) {
			blocks.push({
				id: block.id,
				title: block.title,
				change: "updated",
			});
		}
	}
	for (const block of base.blocks) {
		if (!next.has(block.id)) {
			blocks.push({
				id: block.id,
				title: block.title,
				change: "removed",
			});
		}
	}
	return {
		titleChanged: base.title !== proposed.title,
		descriptionChanged: base.description !== proposed.description,
		presentationChanged: base.presentation !== proposed.presentation,
		themeChanged:
			JSON.stringify(base.theme) !== JSON.stringify(proposed.theme),
		blocks,
	};
}
export interface FrameChangeProposalView {
	id: string;
	frameId: string;
	status: "PENDING" | "APPLIED" | "DISMISSED";
	baseUpdatedAt: string;
	baseContentHash: string;
	proposedContentHash: string;
	createdAt: string;
	appliedUpdatedAt: string | null;
	summary: FrameChangeSummary;
	base: FrameReviewDocument;
	proposed: FrameReviewDocument;
	currentUpdatedAt: string;
	conflicted: boolean;
}
export interface FrameApprovedRevisionView {
	id: string;
	contentHash: string;
	sourceUpdatedAt: string;
	createdAt: string;
	origin: "APPROVED" | "LEGACY_PUBLICATION";
}
export interface FrameReviewState {
	frameId: string;
	currentUpdatedAt: string;
	currentContentHash: string;
	approved: FrameApprovedRevisionView | null;
	published: FrameApprovedRevisionView | null;
	hasPublicLink: boolean;
	hasUnapprovedChanges: boolean;
	hasUnpublishedChanges: boolean;
}
