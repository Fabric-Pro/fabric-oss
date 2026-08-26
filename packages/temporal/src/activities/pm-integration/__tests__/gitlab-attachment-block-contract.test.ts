/**
 * Pure-function contract for the GitLab attachment block (Fizzy #1745).
 *
 * NOT a wiring/integration test: this file never imports
 * `gitlab-rest-story-sync.ts` and exercises only two pure modules —
 * `gitlab-attachment-block` (append/render/strip) and `computePmHash`. It
 * pins the contract that the real wiring in `gitlab-rest-story-sync.ts`
 * depends on: append/strip round-trip cleanly, stripping the block keeps
 * the push-time hash stable across an attachment-only change while still
 * reacting to a real description change, and repeated push/pull/push does
 * not accumulate blocks.
 *
 * For coverage of the actual call sites in `gitlab-rest-story-sync.ts`
 * (`stampPmSyncSuccess` receiving a block-free description, the push-time
 * conflict guard stripping before it hashes), see
 * `gitlab-attachment-self-heal.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
	appendAttachmentBlock,
	renderAttachmentBlock,
	stripAttachmentBlock,
} from "../gitlab-attachment-block";
import { computePmHash } from "../pm-sync-hash";

const PATH = `/uploads/${"c".repeat(32)}/spec.pdf`;

describe("GitLab attachment block — pure-function contract (Fizzy #1745)", () => {
	it("the hash is unchanged when only the attachment block differs", () => {
		const body = "the description";
		const withBlock = appendAttachmentBlock(
			body,
			renderAttachmentBlock({
				links: [{ filename: "spec.pdf", path: PATH }],
				excluded: [],
			}),
		);
		expect(computePmHash("t", stripAttachmentBlock(withBlock))).toBe(
			computePmHash("t", stripAttachmentBlock(body)),
		);
	});

	it("the hash still changes when the real description changes", () => {
		expect(computePmHash("t", stripAttachmentBlock("a"))).not.toBe(
			computePmHash("t", stripAttachmentBlock("b")),
		);
	});

	it("a pulled description arrives at the editor without the block", () => {
		const remote = appendAttachmentBlock(
			"body from gitlab",
			renderAttachmentBlock({ links: [], excluded: ["secret.png"] }),
		);
		const forEditor = stripAttachmentBlock(remote);
		expect(forEditor).not.toContain("fabric:attachments");
		expect(forEditor).not.toContain("secret.png");
		expect(forEditor).toContain("body from gitlab");
	});

	it("push → pull → push does not accumulate blocks", () => {
		const block = renderAttachmentBlock({
			links: [{ filename: "spec.pdf", path: PATH }],
			excluded: [],
		});
		const pushed = appendAttachmentBlock("body", block);
		const pulled = stripAttachmentBlock(pushed);
		const pushedAgain = appendAttachmentBlock(pulled, block);
		expect(pushedAgain).toBe(pushed);
		expect(pushedAgain.match(/fabric:attachments/g)).toHaveLength(2);
	});
});
