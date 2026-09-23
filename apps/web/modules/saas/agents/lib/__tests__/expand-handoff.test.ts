import type { AttachedFile } from "@saas/shared/components/copilot/use-copilot-document-upload";
import { describe, expect, it } from "vitest";
import {
	buildExpandHandoff,
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
