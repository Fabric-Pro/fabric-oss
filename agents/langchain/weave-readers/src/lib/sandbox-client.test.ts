/**
 * Sandbox Client Tests
 *
 * execCommand's allow-list and single-quote escaping are the sandbox's
 * shell-injection guard (see the comment above `quote` in sandbox-client.ts,
 * "Guards js/incomplete-sanitization"). These tests pin that contract
 * directly against the command string sent to the sandbox exec endpoint,
 * plus the read/list/search error-propagation paths.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";
import { createSandboxClient } from "./sandbox-client.js";

function makeClient() {
	return createSandboxClient({
		sessionId: "session-1",
		workDir: "/work",
		userId: "user-1",
		organizationId: "org-1",
	});
}

describe("createSandboxClient", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("readFile", () => {
		it("returns content on success", async () => {
			vi.spyOn(global, "fetch").mockResolvedValue({
				ok: true,
				json: async () => ({ content: "file contents" }),
			} as Response);

			const client = makeClient();
			const content = await client.readFile("src/index.ts");
			assert.equal(content, "file contents");
		});

		it("throws with statusText when the response is not ok", async () => {
			vi.spyOn(global, "fetch").mockResolvedValue({
				ok: false,
				statusText: "Not Found",
				json: async () => ({}),
			} as Response);

			await assert.rejects(
				() => makeClient().readFile("missing.ts"),
				/Failed to read file: Not Found/,
			);
		});

		it("throws the sandbox-reported error even when the HTTP response is ok", async () => {
			vi.spyOn(global, "fetch").mockResolvedValue({
				ok: true,
				json: async () => ({ error: "permission denied" }),
			} as Response);

			await assert.rejects(
				() => makeClient().readFile("secret.ts"),
				/permission denied/,
			);
		});

		it("returns an empty string when content is missing", async () => {
			vi.spyOn(global, "fetch").mockResolvedValue({
				ok: true,
				json: async () => ({}),
			} as Response);

			assert.equal(await makeClient().readFile("empty.ts"), "");
		});
	});

	describe("listFiles", () => {
		it("returns the file list on success", async () => {
			vi.spyOn(global, "fetch").mockResolvedValue({
				ok: true,
				json: async () => ({ files: ["a.ts", "b.ts"] }),
			} as Response);

			const files = await makeClient().listFiles(".");
			assert.deepEqual(files, ["a.ts", "b.ts"]);
		});

		it("returns an empty array when files is missing or not an array", async () => {
			vi.spyOn(global, "fetch").mockResolvedValue({
				ok: true,
				json: async () => ({}),
			} as Response);

			assert.deepEqual(await makeClient().listFiles("."), []);
		});
	});

	describe("execCommand", () => {
		it("rejects commands outside the allow-list before making a request", async () => {
			const fetchMock = vi.spyOn(global, "fetch");
			await assert.rejects(
				() => makeClient().execCommand("rm", ["-rf", "/"]),
				/Command 'rm' is not allowed/,
			);
			assert.equal(fetchMock.mock.calls.length, 0);
		});

		it("rejects args containing shell metacharacters before making a request", async () => {
			const fetchMock = vi.spyOn(global, "fetch");
			await assert.rejects(
				() => makeClient().execCommand("grep", ["foo; rm -rf /"]),
				/Invalid characters in command arguments/,
			);
			assert.equal(fetchMock.mock.calls.length, 0);
		});

		it("single-quotes each argument so shell metacharacters cannot reach the shell", async () => {
			const fetchMock = vi.spyOn(global, "fetch").mockResolvedValue({
				ok: true,
				json: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
			} as Response);

			await makeClient().execCommand("grep", [
				"it's a test",
				"$(whoami)",
			]);

			const [, init] = fetchMock.mock.calls[0];
			const body = JSON.parse((init as RequestInit).body as string);
			assert.equal(body.command, "grep 'it'\\''s a test' '$(whoami)'");
		});

		it("propagates exec errors reported by the sandbox", async () => {
			vi.spyOn(global, "fetch").mockResolvedValue({
				ok: true,
				json: async () => ({ error: "command timed out" }),
			} as Response);

			await assert.rejects(
				() => makeClient().execCommand("ls"),
				/command timed out/,
			);
		});
	});

	describe("searchCode", () => {
		it("parses grep-style output lines into file/line/content matches", async () => {
			vi.spyOn(global, "fetch").mockResolvedValue({
				ok: true,
				json: async () => ({
					stdout: "src/a.ts:10:const x = 1;\nsrc/b.ts:20:const y = 2;\n",
					stderr: "",
					exitCode: 0,
				}),
			} as Response);

			const matches = await makeClient().searchCode("const");
			assert.deepEqual(matches, [
				{ file: "src/a.ts", line: 10, content: "const x = 1;" },
				{ file: "src/b.ts", line: 20, content: "const y = 2;" },
			]);
		});

		it("skips lines that do not match the file:line:content shape", async () => {
			vi.spyOn(global, "fetch").mockResolvedValue({
				ok: true,
				json: async () => ({
					stdout: "not a match line\nsrc/a.ts:5:ok line\n",
					stderr: "",
					exitCode: 0,
				}),
			} as Response);

			const matches = await makeClient().searchCode("ok");
			assert.deepEqual(matches, [
				{ file: "src/a.ts", line: 5, content: "ok line" },
			]);
		});
	});
});
