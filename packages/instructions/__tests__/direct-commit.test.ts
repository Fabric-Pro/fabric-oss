import { describe, expect, it } from "vitest";
import {
	DIRECT_COMMIT_TRAILER,
	directCommitContextSchema,
	directCommitOutcomeSchema,
} from "../src/direct-commit";
import {
	DIRECT_COMMIT_MESSAGE_MAX_CHARS,
	DIRECT_COMMIT_SUBJECT_MAX_CHARS,
	REVERT_QUOTED_SUBJECT_MAX_CHARS,
	renderDirectCommitText,
	renderRevertCommitMessage,
} from "../src/pull-request-text";
import {
	instructionDirectCommitWorkflowId,
	instructionRevertCommitWorkflowId,
	instructionSnapshotWorkflowId,
} from "../src/workflow-ids";

// Assembled at run time: no address- or token-shaped literal in the tree.
const NOREPLY = ["noreply", "example.com"].join("@");
const MAIL_FROM = `Fabric <${NOREPLY}>`;
const TOKEN = `${"gh"}${"p_"}${"A".repeat(36)}`;
const SHA = "a".repeat(40);

function context(over: Record<string, unknown> = {}) {
	return {
		v: 1,
		integrationId: "int_1",
		syncId: "sync_1",
		syncGeneration: 3,
		provider: "GITHUB",
		targetRef: "main",
		rootPath: "instructions",
		baseCommitSha: SHA,
		repository: {
			provider: "GITHUB",
			owner: "example-org",
			repo: "example",
		},
		author: { name: "Pat Example", email: NOREPLY },
		committer: { name: "Fabric", email: NOREPLY },
		message: "Tighten the review skill",
		committedAt: "2026-10-02T10:00:00Z",
		...over,
	};
}

describe("directCommitContextSchema", () => {
	it("accepts the context admission freezes", () => {
		expect(directCommitContextSchema.safeParse(context()).success).toBe(
			true,
		);
	});

	it.each([
		[
			"a provider that disagrees with the repository's",
			{ provider: "GITLAB" },
		],
		["a commit sha that is not an object id", { baseCommitSha: "main" }],
		["a zero generation", { syncGeneration: 0 }],
		[
			"a timestamp with fractional seconds",
			{ committedAt: "2026-10-02T10:00:00.5Z" },
		],
		["an empty message", { message: "" }],
		["a field it does not know", { token: TOKEN }],
	])("refuses %s", (_label, over) => {
		expect(directCommitContextSchema.safeParse(context(over)).success).toBe(
			false,
		);
	});

	it("is not a pull-request context: version 2 is refused", () => {
		expect(
			directCommitContextSchema.safeParse(context({ v: 2 })).success,
		).toBe(false);
	});
});

describe("directCommitOutcomeSchema", () => {
	it.each([
		[{ outcome: "committed", sha: SHA, ref: "main" }],
		[{ outcome: "unchanged", sha: SHA }],
		[{ outcome: "pull-request", operationId: "op_1", reason: "protected" }],
		[{ outcome: "pull-request", operationId: "op_1", reason: "busy" }],
		[{ outcome: "branch-moved" }],
		[{ outcome: "failed", code: "GIT_FAILED", retryable: false }],
	])("accepts %j", (outcome) => {
		expect(directCommitOutcomeSchema.safeParse(outcome).success).toBe(true);
	});

	it.each([
		[{ outcome: "committed", sha: "tip", ref: "main" }],
		[{ outcome: "pull-request", operationId: "op_1", reason: "other" }],
		[{ outcome: "pushed" }],
		[{ outcome: "failed", code: "GIT_FAILED" }],
	])("refuses %j", (outcome) => {
		expect(directCommitOutcomeSchema.safeParse(outcome).success).toBe(
			false,
		);
	});
});

describe("renderDirectCommitText", () => {
	function render(
		over: Partial<Parameters<typeof renderDirectCommitText>[0]> = {},
	) {
		return renderDirectCommitText({
			message: "Tighten the review skill",
			proposerName: "Pat Example",
			mailFrom: MAIL_FROM,
			...over,
		});
	}

	it("attributes the commit to the member with the noreply address and Fabric as committer", () => {
		expect(render()).toEqual({
			ok: true,
			author: { name: "Pat Example", email: NOREPLY },
			committer: { name: "Fabric", email: NOREPLY },
			message: "Tighten the review skill",
		});
	});

	it("keeps the committer's own words, normalising line endings, controls and trailing space", () => {
		const text = render({
			message: "Tighten it  \r\n\r\n\r\n\r\nBecause\u0007 flaky\t \r\n",
		});

		expect(text).toMatchObject({
			ok: true,
			message: "Tighten it\n\nBecause flaky",
		});
	});

	it("never carries an address-shaped member name into the author", () => {
		const text = render({ proposerName: "pat@example.org" });

		expect(text).toMatchObject({ ok: true });
		expect(JSON.stringify(text)).not.toContain("pat@example.org");
	});

	it.each([
		["blank", "  \n  ", "MESSAGE_EMPTY"],
		[
			"a long subject",
			"x".repeat(DIRECT_COMMIT_SUBJECT_MAX_CHARS + 1),
			"MESSAGE_TOO_LONG",
		],
		[
			"a long body",
			`subject\n\n${"y".repeat(DIRECT_COMMIT_MESSAGE_MAX_CHARS)}`,
			"MESSAGE_TOO_LONG",
		],
		["a token", `Rotate ${TOKEN}`, "MESSAGE_REJECTED"],
		[
			"a line that spells Fabric's own trailer",
			"Tighten the rules\n\nFabric-Commit: snap_example_1",
			"MESSAGE_REJECTED",
		],
		[
			"a trailer line in the middle of the body",
			"Tighten the rules\n\nFabric-Commit: snap_example_1\n\nand more",
			"MESSAGE_REJECTED",
		],
		[
			"a trailer line in another case or with space before the colon",
			"Tighten the rules\n\nfabric-commit : snap_example_1",
			"MESSAGE_REJECTED",
		],
		[
			"an indented trailer line",
			"Tighten the rules\n\n  Fabric-Commit: snap_example_1",
			"MESSAGE_REJECTED",
		],
	])("refuses a message that is %s", (_label, message, code) => {
		const text = render({ message });

		expect(text).toEqual({ ok: false, code });
		expect(JSON.stringify(text)).not.toContain(TOKEN);
	});

	it("allows a message that only mentions the trailer's name in a sentence", () => {
		const text = render({
			message: "Explain the Fabric-Commit: line the docs describe",
		});

		expect(text).toMatchObject({ ok: true });
	});

	it("refuses attribution when the sender has no mail domain", () => {
		expect(render({ mailFrom: "Fabric" })).toEqual({
			ok: false,
			code: "ATTRIBUTION_REJECTED",
		});
	});
});

describe("renderRevertCommitMessage", () => {
	it("writes the message git writes: the quoted subject, then the reverted commit", () => {
		expect(
			renderRevertCommitMessage({
				subject: "Tighten the rules",
				sha: SHA,
			}),
		).toBe(`Revert "Tighten the rules"\n\nThis reverts commit ${SHA}.`);
	});

	it("flattens whitespace and controls, and cuts an overlong subject", () => {
		const message = renderRevertCommitMessage({
			subject: `  Tighten\tthe\u0007  rules ${"x".repeat(400)}`,
			sha: SHA,
		});

		const [subject] = message.split("\n");
		expect(subject?.startsWith('Revert "Tighten the rules x')).toBe(true);
		expect(Array.from(subject ?? "")).toHaveLength(
			`Revert ""`.length + REVERT_QUOTED_SUBJECT_MAX_CHARS,
		);
	});

	it.each([
		["empty", "  "],
		["a credential", `Rotate ${TOKEN}`],
	])("does not quote a subject that is %s", (_label, subject) => {
		const message = renderRevertCommitMessage({ subject, sha: SHA });

		expect(message).toBe(
			`Revert commit ${SHA.slice(0, 7)}\n\nThis reverts commit ${SHA}.`,
		);
		expect(message).not.toContain(TOKEN);
	});
});

describe("workflow ids", () => {
	it("derives one commit workflow per snapshot, distinct from its validation workflow", () => {
		expect(instructionDirectCommitWorkflowId("snap_1")).toBe(
			"project-instruction-direct-commit-snap_1",
		);
		expect(instructionDirectCommitWorkflowId("snap_1")).not.toBe(
			instructionSnapshotWorkflowId("snap_1"),
		);
	});

	it("derives one revert workflow per project, so two reverts of one branch cannot be open at once, distinct from a commit's", () => {
		expect(instructionRevertCommitWorkflowId("proj_1")).toBe(
			"project-instruction-revert-commit-proj_1",
		);
		expect(instructionRevertCommitWorkflowId("x")).not.toBe(
			instructionDirectCommitWorkflowId("x"),
		);
	});

	it("names the trailer that finds a commit again", () => {
		expect(DIRECT_COMMIT_TRAILER).toBe("Fabric-Commit");
	});
});
