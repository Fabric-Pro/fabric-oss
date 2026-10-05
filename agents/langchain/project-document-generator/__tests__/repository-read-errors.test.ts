/**
 * Fizzy #2917: a refused or failed repository read must not reach the model
 * as a missing or empty file. /api/internal/code-search passes the
 * connector's `error` field through on `file` and `structure`; the editor
 * tools report it, keep "not found" for a genuine 404, and keep the old
 * wording when the field is absent (an empty read, or an older web app).
 */

import { AIMessage, type ToolMessage } from "@langchain/core/messages";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toolNode } from "../nodes/tool-node";
import type { AgentState } from "../state";

function stateWithCall(name: string, args: Record<string, unknown>) {
	return {
		messages: [
			new AIMessage({
				content: "",
				tool_calls: [{ id: "call_1", name, args }],
			}),
		],
		document: "",
		documentType: "architecture",
		projectContext: { name: "Test Project", techStack: [], features: [] },
		ragContexts: [],
		streamingContent: "",
		retryCount: 0,
		copilotkit: { actions: [], context: [] },
		hasTeamsIntegration: false,
		hasSlackIntegration: false,
		hasGitHubIntegration: false,
		hasRepoIntegration: true,
		projectId: "proj_1",
		userId: "user_1",
		isRegeneration: false,
		reasoningByTurn: {},
		toolCallsByTurn: {},
	} as unknown as AgentState;
}

function stubCodeSearch(body: unknown) {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => body,
		}),
	);
}

async function runTool(name: string, args: Record<string, unknown>) {
	const result = await toolNode(stateWithCall(name, args), {
		configurable: { ai_token: "tok_1" },
	});
	const messages = result.messages ?? [];
	expect(messages).toHaveLength(1);
	return String((messages[0] as ToolMessage).content);
}

const EXISTENCE_UNKNOWN =
	"The repository could not be read, so this says nothing about whether the content exists.";

function emptyFile(error?: unknown) {
	return {
		file: {
			path: "src/app.ts",
			content: "",
			size: 0,
			encoding: "none",
			isBinary: false,
			isTruncated: false,
			...(error ? { error } : {}),
		},
	};
}

function emptyTree(error?: unknown) {
	return {
		structure: {
			entries: [],
			totalFiles: 0,
			totalDirectories: 0,
			truncated: false,
			...(error ? { error } : {}),
		},
		totalFiles: 0,
		totalDirectories: 0,
	};
}

describe("get_repository_file read errors", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it.each([
		[
			"forbidden",
			403,
			"Reading src/app.ts was denied: the repository credentials do not have access (HTTP 403).",
		],
		[
			"unauthorized",
			401,
			"Reading src/app.ts was refused: the repository credentials were rejected (HTTP 401).",
		],
		[
			"rate_limited",
			429,
			"Reading src/app.ts was rate limited by the repository provider (HTTP 429); try again shortly.",
		],
		[
			"provider_error",
			502,
			"Reading src/app.ts failed: the repository provider returned an error (HTTP 502).",
		],
	])(
		"reports a %s read as a failure, not a missing file",
		async (kind, status, message) => {
			stubCodeSearch(emptyFile({ kind, status, message }));

			const text = await runTool("get_repository_file", {
				path: "src/app.ts",
			});

			expect(text).toContain(message);
			expect(text).toContain(EXISTENCE_UNKNOWN);
			expect(text).not.toContain("not found");
		},
	);

	it("reports a genuine 404 as not found", async () => {
		stubCodeSearch(
			emptyFile({
				kind: "not_found",
				status: 404,
				message: "Reading src/app.ts: not found (HTTP 404).",
			}),
		);

		const text = await runTool("get_repository_file", {
			path: "src/app.ts",
		});

		expect(text).toBe("File src/app.ts not found.");
	});

	it("falls back to the kind and status when the error carries no message", async () => {
		stubCodeSearch(emptyFile({ kind: "forbidden", status: 403 }));

		const text = await runTool("get_repository_file", {
			path: "src/app.ts",
		});

		expect(text).toContain("Repository read failed (forbidden, HTTP 403).");
		expect(text).toContain(EXISTENCE_UNKNOWN);
	});

	it("reports a kind it does not know through the connector's message", async () => {
		const message = "Reading src/app.ts failed: quota exceeded.";
		stubCodeSearch(emptyFile({ kind: "quota_exceeded", message }));

		const text = await runTool("get_repository_file", {
			path: "src/app.ts",
		});

		expect(text).toBe(`${message} ${EXISTENCE_UNKNOWN}`);
	});

	it("reports the error before the binary flag", async () => {
		const message =
			"Reading src/app.ts was denied: the repository credentials do not have access (HTTP 403).";
		const body = emptyFile({ kind: "forbidden", status: 403, message });
		body.file.isBinary = true;
		stubCodeSearch(body);

		const text = await runTool("get_repository_file", {
			path: "src/app.ts",
		});

		expect(text).toBe(`${message} ${EXISTENCE_UNKNOWN}`);
	});

	it("returns a successful read's content unchanged", async () => {
		stubCodeSearch({
			file: {
				path: "src/app.ts",
				content: "export const ok = true;",
				size: 23,
				encoding: "utf-8",
				isBinary: false,
				isTruncated: false,
			},
		});

		const text = await runTool("get_repository_file", {
			path: "src/app.ts",
		});

		expect(text).toBe(
			"### src/app.ts (23 bytes)\n```\nexport const ok = true;\n```",
		);
	});

	it("keeps the old wording for an empty read without an error", async () => {
		stubCodeSearch(emptyFile());

		const text = await runTool("get_repository_file", {
			path: "src/app.ts",
		});

		expect(text).toBe("File src/app.ts not found or is empty.");
	});
});

describe("list_repository_structure read errors", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("reports a denied listing as a failure, not an empty repository", async () => {
		const message =
			"Listing example-org/example-repo was denied: the repository credentials do not have access (HTTP 403).";
		stubCodeSearch(emptyTree({ kind: "forbidden", status: 403, message }));

		const text = await runTool("list_repository_structure", {});

		expect(text).toContain(message);
		expect(text).toContain(EXISTENCE_UNKNOWN);
		expect(text).not.toContain("No files found");
	});

	it("reports a 404 on a directory as that directory not found", async () => {
		stubCodeSearch(
			emptyTree({
				kind: "not_found",
				status: 404,
				message:
					"Listing example-org/example-repo: not found (HTTP 404).",
			}),
		);

		const text = await runTool("list_repository_structure", {
			directory: "src/missing",
		});

		expect(text).toBe("Directory src/missing not found in the repository.");
	});

	it("keeps the old wording for an empty listing without an error", async () => {
		stubCodeSearch(emptyTree());

		const text = await runTool("list_repository_structure", {});

		expect(text).toBe("No files found in the repository (or directory).");
	});

	it("lists a successful read's entries unchanged", async () => {
		stubCodeSearch({
			structure: {
				entries: [
					{ path: "src", type: "directory" },
					{ path: "src/app.ts", type: "file", size: 23 },
				],
				totalFiles: 1,
				totalDirectories: 1,
				truncated: false,
			},
			totalFiles: 1,
			totalDirectories: 1,
		});

		const text = await runTool("list_repository_structure", {});

		expect(text).toBe(
			"Repository structure (1 files, 1 directories):\n\n📁 src\n📄 src/app.ts (23B)",
		);
	});
});

describe("search_repository_code search errors", () => {
	const SEARCH_EXISTENCE_UNKNOWN =
		"The repository could not be searched, so this says nothing about whether the code exists.";

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it.each([
		[
			"forbidden",
			403,
			"The repository credentials do not have access to this (HTTP 403).",
		],
		[
			"unauthorized",
			401,
			"The repository credentials were rejected (HTTP 401).",
		],
		[
			"rate_limited",
			429,
			"The repository provider rate-limited the request (HTTP 429); try again shortly.",
		],
		[
			"provider_error",
			500,
			"The repository provider returned an error (HTTP 500).",
		],
	])(
		"reports a %s search as a failure, not as no matches",
		async (kind, status, message) => {
			stubCodeSearch({
				results: [],
				totalCount: 0,
				error: { kind, status, message },
			});

			const text = await runTool("search_repository_code", {
				query: "login",
			});

			expect(text).toBe(`${message} ${SEARCH_EXISTENCE_UNKNOWN}`);
			expect(text).not.toContain("No code matches");
		},
	);

	it("reports not_found as a failed search too, never as no matches", async () => {
		stubCodeSearch({
			results: [],
			totalCount: 0,
			error: {
				kind: "not_found",
				status: 404,
				message: "Not found (HTTP 404).",
			},
		});

		const text = await runTool("search_repository_code", {
			query: "login",
		});

		expect(text).toContain("could not be searched");
		expect(text).toContain(SEARCH_EXISTENCE_UNKNOWN);
		expect(text).not.toContain("No code matches");
	});

	it("falls back to the kind and status when the error carries no message", async () => {
		stubCodeSearch({
			results: [],
			totalCount: 0,
			error: { kind: "forbidden", status: 403 },
		});

		const text = await runTool("search_repository_code", {
			query: "login",
		});

		expect(text).toContain(
			"Repository search failed (forbidden, HTTP 403).",
		);
		expect(text).toContain(SEARCH_EXISTENCE_UNKNOWN);
	});

	it("keeps the old wording for an empty search without an error", async () => {
		stubCodeSearch({ results: [], totalCount: 0 });

		const text = await runTool("search_repository_code", {
			query: "login",
		});

		expect(text).toBe("No code matches found. Try different search terms.");
	});

	it("returns a successful search's matches unchanged", async () => {
		stubCodeSearch({
			results: [
				{
					filePath: "src/auth.ts",
					fileName: "auth.ts",
					repository: "example-org/example-repo",
					matchedSnippets: ["export function login() {}"],
				},
			],
			totalCount: 1,
		});

		const text = await runTool("search_repository_code", {
			query: "login",
		});

		expect(text).toBe(
			"Found 1 code matches:\n\n### src/auth.ts\nexport function login() {}",
		);
	});
});
