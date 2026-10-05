import { describe, expect, it } from "vitest";
import {
	COMMIT_GIVE_UP_MS,
	COMMIT_POLL_MS,
	COMMIT_SLOW_POLL_MS,
	commitFailureKey,
	commitMessageProblem,
	commitPollInterval,
	commitRefusal,
	commitSubject,
	defaultCommitMessage,
	fileToBase64,
	pathBasename,
	safeHttpsUrl,
	settledCommit,
} from "../instructions-direct-commit";

const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("the message a commit starts from", () => {
	it("names the file by its basename for an edit, as git users write it", () => {
		expect(
			defaultCommitMessage({
				kind: "update",
				path: ".claude/skills/review/SKILL.md",
			}),
		).toBe("Update SKILL.md");
	});

	it("names the whole path for an added or deleted file", () => {
		expect(defaultCommitMessage({ kind: "add", path: "docs/a.md" })).toBe(
			"Add docs/a.md",
		);
		expect(
			defaultCommitMessage({ kind: "delete", path: "docs/a.md" }),
		).toBe("Delete docs/a.md");
	});

	it("names both paths for a rename", () => {
		expect(
			defaultCommitMessage({
				kind: "rename",
				from: "docs/a.md",
				to: "docs/b.md",
			}),
		).toBe("Rename docs/a.md to docs/b.md");
	});

	it("has nothing to name for an add before a path is typed", () => {
		expect(defaultCommitMessage({ kind: "add", path: "" })).toBe(
			"Add a file",
		);
	});

	it("takes the last segment, ignoring a trailing slash", () => {
		expect(pathBasename("a/b/c.md")).toBe("c.md");
		expect(pathBasename("c.md")).toBe("c.md");
		expect(pathBasename("a/b/")).toBe("b");
	});

	it("takes the first line of a message as its subject", () => {
		expect(commitSubject("Tighten lint rules\n\nLonger body")).toBe(
			"Tighten lint rules",
		);
		expect(commitSubject("  spaced  ")).toBe("spaced");
	});

	it("refuses an empty subject and an over-long one before anything is sent", () => {
		expect(commitMessageProblem("   ")).toBe("empty");
		expect(commitMessageProblem("")).toBe("empty");
		// Leading blank lines are trimmed, as the server renders it.
		expect(commitMessageProblem("\n\nbody only")).toBeNull();
		expect(commitMessageProblem("x".repeat(301))).toBe("tooLong");
		expect(commitMessageProblem("Update SKILL.md")).toBeNull();
	});
});

describe("what a polled snapshot says became of the commit", () => {
	it("is still pending while neither a verdict nor an outcome is recorded", () => {
		expect(
			settledCommit({ status: "VALIDATING", commitOutcome: null }),
		).toBeNull();
		expect(
			settledCommit({ status: "READY", commitOutcome: null }),
		).toBeNull();
		expect(settledCommit({ status: "READY" })).toBeNull();
	});

	it("reads a scan refusal as nothing pushed, whatever else the row holds", () => {
		expect(
			settledCommit({ status: "REJECTED", commitOutcome: null }),
		).toEqual({ kind: "rejected" });
	});

	it("reads a check that broke as a failed, retryable commit", () => {
		expect(settledCommit({ status: "FAILED" })).toEqual({
			kind: "failed",
			code: "VALIDATION_FAILED",
			retryable: true,
		});
	});

	it.each([
		[
			{ outcome: "committed", sha: SHA, ref: "main" },
			{ kind: "committed", sha: SHA, ref: "main" },
		],
		[
			{ outcome: "unchanged", sha: SHA },
			{ kind: "unchanged", sha: SHA },
		],
		[
			{
				outcome: "pull-request",
				operationId: "op_1",
				reason: "protected",
			},
			{ kind: "pull-request", reason: "protected" },
		],
		[
			{ outcome: "pull-request", operationId: "op_1", reason: "busy" },
			{ kind: "pull-request", reason: "busy" },
		],
		[{ outcome: "branch-moved" }, { kind: "branch-moved" }],
		[
			{ outcome: "failed", code: "GIT_FAILED", retryable: false },
			{ kind: "failed", code: "GIT_FAILED", retryable: false },
		],
	])("reads the recorded outcome %j", (commitOutcome, expected) => {
		expect(settledCommit({ status: "READY", commitOutcome })).toEqual(
			expected,
		);
	});

	it("treats an outcome it does not know as pending, never as a guess", () => {
		expect(
			settledCommit({
				status: "READY",
				commitOutcome: { outcome: "from-the-future" },
			}),
		).toBeNull();
		expect(
			settledCommit({
				status: "READY",
				commitOutcome: {
					outcome: "committed",
					sha: "not-a-sha",
					ref: "main",
				},
			}),
		).toBeNull();
	});
});

describe("how long the page waits for a commit", () => {
	it("polls quickly at first, then slowly, then stops", () => {
		expect(commitPollInterval(0)).toBe(COMMIT_POLL_MS);
		expect(commitPollInterval(59_000)).toBe(COMMIT_POLL_MS);
		expect(commitPollInterval(61_000)).toBe(COMMIT_SLOW_POLL_MS);
		expect(commitPollInterval(COMMIT_GIVE_UP_MS - 1)).toBe(
			COMMIT_SLOW_POLL_MS,
		);
		expect(commitPollInterval(COMMIT_GIVE_UP_MS)).toBe(false);
	});
});

describe("the words for a commit that failed", () => {
	it.each([
		["AUTHENTICATION_FAILED", "authentication"],
		["PERMISSION_REVOKED", "permission"],
		["CONFIGURATION_CHANGED", "configuration"],
		["REPOSITORY_CHANGED", "configuration"],
		["TARGET_BRANCH_MISSING", "branchMissing"],
		["LIMITS_EXCEEDED", "tooLarge"],
		["VALIDATION_TIMEOUT", "timeout"],
		["VALIDATION_FAILED", "validation"],
		["SETTLE_FAILED", "settle"],
		["STALE", "stale"],
		["GIT_FAILED", "generic"],
		["UNEXPECTED", "generic"],
		["SOMETHING_NEW", "generic"],
	])("maps %s to %s", (code, key) => {
		expect(commitFailureKey(code)).toBe(key);
	});
});

describe("why commitChange was refused", () => {
	function refused(reason: string) {
		return {
			code: "UNPROCESSABLE_CONTENT",
			data: { reason, field: "message" },
		};
	}

	it.each([
		["MESSAGE_EMPTY", "messageEmpty", "message"],
		["MESSAGE_TOO_LONG", "messageTooLong", "message"],
		["MESSAGE_REJECTED", "messageRejected", "message"],
		["ATTRIBUTION_REJECTED", "attribution", null],
		["BASE_NOT_PUBLISHED", "stale", null],
		["NOT_REPOSITORY_SOURCED", "notRepository", null],
		["COMMIT_PROPOSER_LIMIT", "proposerLimit", null],
		["COMMIT_PROJECT_LIMIT", "projectLimit", null],
	])("words %s as %s on field %s", (reason, key, field) => {
		expect(commitRefusal(refused(reason))).toEqual({ key, field });
	});

	it("leaves an error it does not know to the shared error map", () => {
		expect(commitRefusal(refused("SOMETHING_NEW"))).toBeNull();
		expect(commitRefusal(new Error("nope"))).toBeNull();
		expect(commitRefusal({ code: "FORBIDDEN" })).toBeNull();
		expect(commitRefusal(null)).toBeNull();
	});
});

describe("a file as a commit carries it", () => {
	it("is base64 of its bytes, however large", async () => {
		const bytes = new Uint8Array(70_000).map((_, i) => i % 251);
		const encoded = await fileToBase64(new Blob([bytes]));

		const decoded = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
		expect(decoded).toEqual(bytes);
	});

	it("is empty for an empty file", async () => {
		expect(await fileToBase64(new Blob([]))).toBe("");
	});
});

describe("an address a provider reported", () => {
	it("is a link only when it is https, so a response can never put script in an href", () => {
		expect(safeHttpsUrl("https://github.com/o/r/pull/1")).toBe(
			"https://github.com/o/r/pull/1",
		);
		expect(safeHttpsUrl("javascript:alert(1)")).toBeNull();
		expect(safeHttpsUrl("http://github.com/o/r/pull/1")).toBeNull();
		expect(safeHttpsUrl("//github.com/o/r")).toBeNull();
		expect(safeHttpsUrl("")).toBeNull();
		expect(safeHttpsUrl(null)).toBeNull();
		expect(safeHttpsUrl(undefined)).toBeNull();
	});
});
