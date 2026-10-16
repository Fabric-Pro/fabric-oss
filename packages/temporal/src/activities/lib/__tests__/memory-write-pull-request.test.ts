/**
 * The pull request a Living Memory write opens (ADR-022): its title and
 * description, escaped the way every Fabric pull request text is, and the
 * provider call that opens it once, finds the one an earlier attempt opened,
 * and turns a provider's failure into the write's typed one.
 */
import {
	type InstructionPullRequestAdapter,
	InstructionPullRequestError,
	type PullRequestObservation,
} from "@repo/integrations/instruction-pull-requests";
import { describe, expect, it, vi } from "vitest";
import type { BranchCredential } from "../instruction-branch-credential";
import {
	openMemoryWritePullRequest,
	renderMemoryWritePullRequest,
} from "../memory-write-pull-request";

const repository = {
	provider: "GITHUB",
	owner: "example",
	repo: "example",
} as const;

const observation = (externalId = "7"): PullRequestObservation => ({
	externalId,
	url: `https://example.com/pull/${externalId}`,
	state: "OPEN",
	sourceRef: "fabric/memory/cwrite00000001",
	targetRef: "main",
	sourceRepository: repository,
	headSha: "a".repeat(40),
});

function credential(adapter: Partial<InstructionPullRequestAdapter>) {
	const signal = new AbortController().signal;
	return {
		signal,
		adapter: adapter as InstructionPullRequestAdapter,
		target: { auth: { token: "t", authMethod: "PAT" }, repository, signal },
	} as unknown as BranchCredential;
}

const request = {
	sourceRef: "fabric/memory/cwrite00000001",
	targetRef: "main",
	title: "Title",
	body: "Body",
};

describe("renderMemoryWritePullRequest", () => {
	it("makes the subject the title and writes the body, the files and a footer naming the member", () => {
		const text = renderMemoryWritePullRequest({
			subject: "Add notes",
			body: "An agent's notes.",
			authorName: "Example Member",
			files: [
				{ path: "docs/ai/new.md", op: "PUT" },
				{ path: "docs/ai/old.md", op: "DELETE" },
			],
		});

		expect(text.title).toBe("Add notes");
		expect(text.body).toBe(
			[
				"An agent's notes.",
				"2 files:\n- Writes docs/ai/new.md\n- Deletes docs/ai/old.md",
				"---",
				"Opened from Fabric by Example Member",
			].join("\n\n"),
		);
	});

	it("says '1 file' for one file and leaves out an empty body", () => {
		const text = renderMemoryWritePullRequest({
			subject: "Add",
			body: "",
			authorName: "A",
			files: [{ path: "docs/a.md", op: "PUT" }],
		});

		expect(text.body.startsWith("1 file:\n- Writes docs/a.md")).toBe(true);
	});

	it("neutralises a mention and escapes Markdown in the title and the body, since the text is an agent's", () => {
		const text = renderMemoryWritePullRequest({
			subject: "ping @org/team **now**",
			body: "also @someone and `code`",
			authorName: "Example Member",
			files: [{ path: "docs/my_file.md", op: "PUT" }],
		});

		expect(text.title).toBe("ping @​org/team \\*\\*now\\*\\*");
		expect(text.body).toContain("@​someone");
		expect(text.body).toContain("\\`code\\`");
		expect(text.body).toContain("docs/my\\_file.md");
		expect(text.body).not.toMatch(/(^|[^​])@org/);
	});

	it("lists at most fifty files but counts them all", () => {
		const files = Array.from({ length: 60 }, (_, index) => ({
			path: `docs/f${index}.md`,
			op: "PUT" as const,
		}));
		const text = renderMemoryWritePullRequest({
			subject: "Many",
			body: "",
			authorName: "A",
			files,
		});

		expect(text.body).toContain("60 files:");
		expect(text.body).toContain("docs/f49.md");
		expect(text.body).not.toContain("docs/f50.md");
	});
});

describe("openMemoryWritePullRequest", () => {
	it("opens one pull request from the write's branch when none exists", async () => {
		const open = vi.fn(async () => observation("9"));
		const found = await openMemoryWritePullRequest({
			credential: credential({
				findOperation: vi.fn(async () => ({ kind: "ABSENT" }) as const),
				open,
			}),
			...request,
		});

		expect(found.externalId).toBe("9");
		expect(open).toHaveBeenCalledTimes(1);
		expect(open.mock.calls[0]).toMatchObject([
			{ sourceRef: request.sourceRef, targetRef: "main", title: "Title" },
		]);
	});

	it("returns the pull request an earlier attempt opened, and opens nothing", async () => {
		const open = vi.fn();
		const found = await openMemoryWritePullRequest({
			credential: credential({
				findOperation: vi.fn(
					async () =>
						({
							kind: "FOUND",
							value: observation("5"),
						}) as const,
				),
				open,
			}),
			...request,
		});

		expect(found.externalId).toBe("5");
		expect(open).not.toHaveBeenCalled();
	});

	it("fails retryably when the lookup cannot decide, so the next attempt looks again before it opens anything", async () => {
		const open = vi.fn();

		await expect(
			openMemoryWritePullRequest({
				credential: credential({
					findOperation: vi.fn(
						async () =>
							({
								kind: "INCONCLUSIVE",
								cause: "transient",
							}) as const,
					),
					open,
				}),
				...request,
			}),
		).rejects.toMatchObject({
			code: "LOOKUP_INCONCLUSIVE",
			retryable: true,
		});
		expect(open).not.toHaveBeenCalled();
	});

	it("finds the pull request a provider says already exists, when the open raced another attempt", async () => {
		const findOperation = vi
			.fn()
			.mockImplementationOnce(async () => ({ kind: "ABSENT" }))
			.mockImplementation(async () => ({
				kind: "FOUND",
				value: observation("3"),
			}));

		const found = await openMemoryWritePullRequest({
			credential: credential({
				findOperation,
				open: vi.fn(async () => {
					throw new InstructionPullRequestError({
						code: "PR_CREATION_REFUSED",
						retryable: false,
						cause: "conflict",
						duplicate: true,
					});
				}),
			}),
			...request,
		});

		expect(found.externalId).toBe("3");
		expect(findOperation).toHaveBeenCalledTimes(2);
	});

	it("turns a provider's refusal into the write's typed failure", async () => {
		await expect(
			openMemoryWritePullRequest({
				credential: credential({
					findOperation: vi.fn(
						async () => ({ kind: "ABSENT" }) as const,
					),
					open: vi.fn(async () => {
						throw new InstructionPullRequestError({
							code: "PR_CREATION_REFUSED",
							retryable: false,
							cause: "permission",
						});
					}),
				}),
				...request,
			}),
		).rejects.toMatchObject({
			code: "PR_CREATION_REFUSED",
			retryable: false,
		});
	});
});
