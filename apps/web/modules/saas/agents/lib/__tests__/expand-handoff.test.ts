import type { AttachedFile } from "@saas/shared/components/copilot/use-copilot-document-upload";
import { describe, expect, it } from "vitest";
import {
	buildExpandHandoff,
	expandedFrameContextFor,
	expandedFrameOriginReducer,
	isExpandHandoffFor,
	transferableAttachments,
} from "../expand-handoff";

function file(
	id: string,
	status: AttachedFile["status"],
	documentId: string | null = null,
): AttachedFile {
	return {
		id,
		file: new File(["x"], `${id}.txt`),
		name: `${id}.txt`,
		type: "text/plain",
		size: 1,
		documentId,
		status,
	};
}

describe("transferableAttachments", () => {
	it("keeps queued and uploaded files, drops in-flight and failed ones", () => {
		const kept = transferableAttachments([
			file("queued", "pending"),
			file("uploaded", "ready", "doc_1"),
			file("ready-without-id", "ready"),
			file("uploading", "uploading"),
			file("failed", "error"),
		]);
		expect(kept.map((f) => f.id)).toEqual(["queued", "uploaded"]);
	});
});

describe("buildExpandHandoff", () => {
	it.each([
		{
			launchFrameId: "frame-workspace",
			workspaceId: "frame-workspace",
			surface: "workspace" as const,
		},
		{ launchFrameId: "frame-artifact", surface: "artifact" as const },
		{ launchFrameId: "frame-legacy", surface: null },
	])(
		"carries a frame origin without a draft or project: %j",
		(launchContext) => {
			const handoff = buildExpandHandoff({
				conversationId: null,
				draft: "",
				attachments: [],
				projectId: null,
				launchContext,
				now: 0,
			});
			expect(handoff?.frameLaunchContext).toEqual({
				launchFrameId: launchContext.launchFrameId,
				workspaceId:
					"workspaceId" in launchContext
						? launchContext.workspaceId
						: null,
				surface: launchContext.surface,
			});
		},
	);

	it("copies only the untrusted launch fields, not unrelated launcher content", () => {
		const handoff = buildExpandHandoff({
			conversationId: "conv-example",
			draft: "",
			attachments: [],
			projectId: "project-example",
			launchContext: {
				launchFrameId: "frame-example",
				workspaceId: "placement-conflict",
				surface: "artifact",
				storyId: "retrieval-story",
				documentId: "retrieval-document",
				prompt: "Unsent launcher text",
			},
			now: 0,
		});
		expect(handoff?.frameLaunchContext).toEqual({
			launchFrameId: "frame-example",
			workspaceId: "placement-conflict",
			surface: "artifact",
		});
	});

	it("returns nothing when there is nothing to carry", () => {
		expect(
			buildExpandHandoff({
				conversationId: "conv_1",
				draft: "   ",
				attachments: [file("failed", "error")],
				projectId: null,
				now: 0,
			}),
		).toBeNull();
	});

	it("carries the draft, files and project for the named conversation", () => {
		expect(
			buildExpandHandoff({
				conversationId: "conv_1",
				draft: "half a question",
				attachments: [file("queued", "pending")],
				projectId: "project_1",
				now: 5,
			}),
		).toMatchObject({
			conversationId: "conv_1",
			draft: "half a question",
			attachments: [{ id: "queued" }],
			projectId: "project_1",
			createdAt: 5,
		});
	});
});

describe("expanded frame origin lifecycle", () => {
	const handoff = {
		conversationId: null,
		draft: "",
		attachments: [],
		projectId: "project-example",
		createdAt: 0,
		frameLaunchContext: {
			launchFrameId: "frame-example",
			surface: "artifact" as const,
		},
	};
	const origin = expandedFrameOriginReducer(null, {
		type: "handoff",
		handoff,
	});

	it("retains the origin when the first turn creates a conversation and its URL settles", () => {
		const created = expandedFrameOriginReducer(origin, {
			type: "created",
			conversationId: "conv-example",
		});
		expect(
			expandedFrameContextFor(created, null, handoff.projectId),
		).toEqual(handoff.frameLaunchContext);
		expect(
			expandedFrameOriginReducer(created, {
				type: "location",
				conversationId: null,
				projectId: handoff.projectId,
			}),
		).toBe(created);
		const settled = expandedFrameOriginReducer(created, {
			type: "location",
			conversationId: "conv-example",
			projectId: handoff.projectId,
		});
		expect(
			expandedFrameContextFor(settled, "conv-example", handoff.projectId),
		).toEqual(handoff.frameLaunchContext);
		expect(
			expandedFrameContextFor(settled, null, handoff.projectId),
		).toBeNull();
		expect(
			expandedFrameOriginReducer(settled, {
				type: "location",
				conversationId: null,
				projectId: handoff.projectId,
			}),
		).toBeNull();
	});

	it("binds an existing drawer conversation and clears on unrelated history or project changes", () => {
		const existing = expandedFrameOriginReducer(null, {
			type: "handoff",
			handoff: { ...handoff, conversationId: "conv-existing" },
		});
		expect(
			expandedFrameContextFor(
				existing,
				"conv-existing",
				handoff.projectId,
			),
		).toEqual(handoff.frameLaunchContext);
		for (const { conversationId, projectId } of [
			{ conversationId: "conv-other", projectId: handoff.projectId },
			{ conversationId: "conv-existing", projectId: "project-other" },
			{ conversationId: "conv-existing", projectId: null },
		]) {
			expect(
				expandedFrameContextFor(existing, conversationId, projectId),
			).toBeNull();
			expect(
				expandedFrameOriginReducer(existing, {
					type: "location",
					conversationId,
					projectId,
				}),
			).toBeNull();
		}
	});

	it("does not recover a cleared origin by returning to the old context", () => {
		const cleared = expandedFrameOriginReducer(origin, { type: "clear" });
		expect(
			expandedFrameOriginReducer(cleared, {
				type: "location",
				conversationId: null,
				projectId: handoff.projectId,
			}),
		).toBeNull();
	});

	it("accepts older handoffs without restoring a provider's stale frame", () => {
		const { frameLaunchContext: _, ...olderHandoff } = handoff;
		expect(
			expandedFrameOriginReducer(origin, {
				type: "handoff",
				handoff: olderHandoff,
			}),
		).toBeNull();
	});
});

describe("isExpandHandoffFor", () => {
	const handoff = buildExpandHandoff({
		conversationId: null,
		draft: "draft",
		attachments: [],
		projectId: null,
		now: 1_000,
	});

	it("matches the page that opened the same conversation", () => {
		expect(isExpandHandoffFor(handoff, null, 2_000)).toBe(true);
		expect(isExpandHandoffFor(handoff, "conv_other", 2_000)).toBe(false);
	});

	it("expires a handoff whose page never mounted", () => {
		expect(isExpandHandoffFor(handoff, null, 1_000 + 61_000)).toBe(false);
	});

	it("is false with no handoff", () => {
		expect(isExpandHandoffFor(null, null, 0)).toBe(false);
	});
});
