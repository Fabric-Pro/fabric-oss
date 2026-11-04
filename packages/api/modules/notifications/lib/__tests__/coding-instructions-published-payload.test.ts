/**
 * CODING_INSTRUCTIONS_PUBLISHED is written by
 * `createInstructionPublishedNotifications` in `@repo/database`, which every
 * publish path calls and which cannot use this validator. This keeps its
 * `InstructionPublishedPayload` and the schema registered here in step.
 */
import {
	type InstructionPublishedPayload,
	NotificationType,
} from "@repo/database";
import { describe, expect, it } from "vitest";
import { validatePayload } from "../payloads";

const UPLOAD: InstructionPublishedPayload = {
	projectId: "proj-1",
	snapshotId: "snap-1",
	version: 4,
	source: "UPLOAD",
	sourceRef: null,
	shortCommitSha: null,
	via: "proposal_review",
	publishedByUserId: "user-1",
	publishedByName: "Example Reviewer",
	update: {
		kind: "cli_sync",
		command: "fabric instructions sync --project proj-1",
	},
};

const REPOSITORY: InstructionPublishedPayload = {
	...UPLOAD,
	source: "REPOSITORY",
	sourceRef: "main",
	shortCommitSha: "0123456",
	via: "automatic",
	publishedByUserId: null,
	publishedByName: null,
	update: { kind: "git_pull", ref: "main" },
};

describe("coding instructions published payload schema", () => {
	it("accepts the upload and repository shapes the writer emits", () => {
		expect(
			validatePayload(
				NotificationType.CODING_INSTRUCTIONS_PUBLISHED,
				UPLOAD,
			),
		).toEqual(UPLOAD);
		expect(
			validatePayload(
				NotificationType.CODING_INSTRUCTIONS_PUBLISHED,
				REPOSITORY,
			),
		).toEqual(REPOSITORY);
	});

	it("rejects a payload without the update hint", () => {
		const { update: _update, ...missing } = UPLOAD;
		expect(() =>
			validatePayload(
				NotificationType.CODING_INSTRUCTIONS_PUBLISHED,
				missing,
			),
		).toThrow();
	});
});
