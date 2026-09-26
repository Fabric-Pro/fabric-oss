/**
 * `readRepositoryFile` — the Coding Instructions configure dialog's read of
 * the chosen folder's `.fabricignore` (Fizzy #2726). The sibling of
 * `listRepositoryTree`: the same providers, auth headers and host handling;
 * a 404 is an absent file rather than a failure, and so is a folder, a
 * submodule or a symbolic link at the path, since the sync keeps only
 * regular files; a file over the cap is `tooLarge` and is never read past
 * the cap; every other failure is `ok: false`, never an empty file; and the
 * token never leaves the request.
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readRepositoryFile } from "../repository-file";

const mockFetch = vi.fn();

beforeEach(() => {
	vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

// Distinctive and token-shaped, so a leak assertion cannot pass by accident.
const SECRET_TOKEN = "ghs_example_file_secret";
const MAX = 64 * 1024;

const githubInput = {
	provider: "GITHUB" as const,
	token: SECRET_TOKEN,
	repositoryUrl: "https://github.com/example-org/instructions",
	owner: "example-org",
	repo: "instructions",
	branch: "release/1.2",
	path: "agents/my skills/.fabricignore",
	maxBytes: MAX,
};

const adoInput = {
	provider: "AZURE_DEVOPS" as const,
	token: SECRET_TOKEN,
	repositoryUrl: "https://dev.azure.com/example-org/Proj/_git/instructions",
	owner: "example-org",
	repo: "instructions",
	azureOrganization: "example-org",
	branch: "main",
	path: "agents/.fabricignore",
	maxBytes: MAX,
};

const gitlabInput = {
	...githubInput,
	provider: "GITLAB" as const,
	repositoryUrl: "https://gitlab.com/example-org/instructions",
};

function textResponse(status: number, body = "", headers?: HeadersInit) {
	return new Response(body, { status, headers });
}

function jsonResponse(status: number, value: unknown) {
	return new Response(JSON.stringify(value, null, 2), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}

/**
 * A body streamed in `chunkBytes` chunks, `chunks` of them, counting how
 * many the reader actually pulled. The first chunk starts with `prefix`.
 */
function streamedResponse(chunkBytes: number, chunks: number, prefix = "") {
	const pulled = { count: 0, cancelled: false };
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (pulled.count === chunks) {
				controller.close();
				return;
			}
			const chunk = new Uint8Array(chunkBytes).fill(0x61);
			if (pulled.count === 0) {
				chunk.set(new TextEncoder().encode(prefix));
			}
			pulled.count += 1;
			controller.enqueue(chunk);
		},
		cancel() {
			pulled.cancelled = true;
		},
	});
	return { response: new Response(body, { status: 200 }), pulled };
}

function toBytes(content: string | Uint8Array): Uint8Array {
	return typeof content === "string"
		? new TextEncoder().encode(content)
		: content;
}

/** The git object id of a blob holding `content`, as `git hash-object` gives it. */
function blobId(
	content: string | Uint8Array,
	algorithm: "sha1" | "sha256" = "sha1",
) {
	const bytes = toBytes(content);
	return createHash(algorithm)
		.update(`blob ${bytes.byteLength}\0`)
		.update(bytes)
		.digest("hex");
}

/** Base64 as GitHub's contents API spells it: a line break every 60 characters. */
function gitHubBase64(bytes: Uint8Array) {
	const lines = Buffer.from(bytes)
		.toString("base64")
		.match(/.{1,60}/g);
	return lines ? `${lines.join("\n")}\n` : "";
}

/** GitHub's contents answer for a regular file holding `content`. */
function gitHubFile(
	content: string | Uint8Array,
	overrides: Record<string, unknown> = {},
) {
	const bytes = toBytes(content);
	const sha = blobId(bytes);
	return {
		name: ".fabricignore",
		path: githubInput.path,
		sha,
		size: bytes.byteLength,
		url: "https://api.github.com/repos/example-org/instructions/contents/agents/.fabricignore?ref=main",
		html_url:
			"https://github.com/example-org/instructions/blob/main/agents/.fabricignore",
		git_url: `https://api.github.com/repos/example-org/instructions/git/blobs/${sha}`,
		download_url:
			"https://raw.githubusercontent.com/example-org/instructions/main/agents/.fabricignore",
		type: "file",
		content: gitHubBase64(bytes),
		encoding: "base64",
		_links: {},
		...overrides,
	};
}

describe("readRepositoryFile — GitHub", () => {
	it("reads the file from the contents API's JSON answer through the integration's token", async () => {
		mockFetch.mockResolvedValue(
			jsonResponse(200, gitHubFile("build/\n# note\n")),
		);

		expect(await readRepositoryFile(githubInput)).toEqual({
			ok: true,
			state: "found",
			text: "build/\n# note\n",
		});
		const [url, init] = mockFetch.mock.calls[0] as [
			string,
			{ headers: Record<string, string>; signal?: AbortSignal },
		];
		expect(url).toBe(
			"https://api.github.com/repos/example-org/instructions/contents/agents/my%20skills/.fabricignore?ref=release%2F1.2",
		);
		expect(init.headers.Authorization).toBe(`Bearer ${SECRET_TOKEN}`);
		// The JSON answer, which says what the path is — never the raw
		// media type, which follows links and describes a folder as text.
		expect(init.headers.Accept).toBe("application/vnd.github+json");
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	it("decodes as the sync does, keeping a byte-order mark and replacing invalid UTF-8", async () => {
		const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0xff, 0x0a]);
		mockFetch.mockResolvedValue(jsonResponse(200, gitHubFile(bytes)));

		expect(await readRepositoryFile(githubInput)).toEqual({
			ok: true,
			state: "found",
			text: Buffer.from(bytes).toString("utf8"),
		});
	});

	it("reads an empty file as found with no text", async () => {
		mockFetch.mockResolvedValue(jsonResponse(200, gitHubFile("")));

		expect(await readRepositoryFile(githubInput)).toEqual({
			ok: true,
			state: "found",
			text: "",
		});
	});

	it("checks the content against a SHA-256 repository's blob id", async () => {
		mockFetch.mockResolvedValue(
			jsonResponse(
				200,
				gitHubFile("dist/\n", { sha: blobId("dist/\n", "sha256") }),
			),
		);

		expect(await readRepositoryFile(githubInput)).toEqual({
			ok: true,
			state: "found",
			text: "dist/\n",
		});
	});

	it("answers 404 as an absent file, not a failure", async () => {
		mockFetch.mockResolvedValue(
			textResponse(404, '{"message":"Not Found"}'),
		);

		expect(await readRepositoryFile(githubInput)).toEqual({
			ok: true,
			state: "absent",
		});
	});

	describe("a path that is not a regular file is absent, as the sync skips it", () => {
		it("a folder: the answer is its listing", async () => {
			mockFetch.mockResolvedValue(
				jsonResponse(200, [
					gitHubFile("a\n", {
						name: "rules.md",
						path: "agents/my skills/.fabricignore/rules.md",
					}),
				]),
			);

			expect(await readRepositoryFile(githubInput)).toEqual({
				ok: true,
				state: "absent",
			});
		});

		it("a folder whose listing is longer than the answer is read, declared length or not", async () => {
			const { response, pulled } = streamedResponse(
				16 * 1024,
				1000,
				"[\n  {",
			);
			response.headers.set("content-length", String(1000 * 16 * 1024));
			mockFetch.mockResolvedValue(response);

			expect(await readRepositoryFile(githubInput)).toEqual({
				ok: true,
				state: "absent",
			});
			expect(pulled.cancelled).toBe(true);
			expect(pulled.count).toBeLessThanOrEqual(14);
		});

		it("a folder in the object media type's spelling", async () => {
			mockFetch.mockResolvedValue(
				jsonResponse(200, {
					...gitHubFile(""),
					type: "dir",
					entries: [],
				}),
			);

			expect(await readRepositoryFile(githubInput)).toEqual({
				ok: true,
				state: "absent",
			});
		});

		it("a symbolic link GitHub describes rather than follows", async () => {
			const {
				content: _content,
				encoding: _encoding,
				...link
			} = gitHubFile("../shared/.fabricignore");
			mockFetch.mockResolvedValue(
				jsonResponse(200, {
					...link,
					type: "symlink",
					target: "../shared/.fabricignore",
				}),
			);

			expect(await readRepositoryFile(githubInput)).toEqual({
				ok: true,
				state: "absent",
			});
		});

		it("a symbolic link GitHub follows to a regular file: `sha` names the link, the content is the target's", async () => {
			// GitHub answers such a link with `type: "file"`, the link's own
			// path, and the target's size and content — only `sha` is the
			// link's blob.
			mockFetch.mockResolvedValue(
				jsonResponse(
					200,
					gitHubFile("build/\n", {
						sha: blobId("../shared/.fabricignore"),
					}),
				),
			);

			expect(await readRepositoryFile(githubInput)).toEqual({
				ok: true,
				state: "absent",
			});
		});

		it("a submodule", async () => {
			mockFetch.mockResolvedValue(
				jsonResponse(200, {
					name: ".fabricignore",
					path: githubInput.path,
					sha: blobId("a commit, as far as this test cares"),
					size: 0,
					type: "submodule",
					submodule_git_url:
						"https://github.com/example-org/other.git",
					download_url: null,
				}),
			);

			expect(await readRepositoryFile(githubInput)).toEqual({
				ok: true,
				state: "absent",
			});
		});
	});

	it("reads a file of exactly the cap: its JSON answer fits the bound", async () => {
		mockFetch.mockResolvedValue(
			jsonResponse(200, gitHubFile(new Uint8Array(MAX).fill(0xff))),
		);

		const result = await readRepositoryFile(githubInput);

		expect(result).toMatchObject({ ok: true, state: "found" });
	});

	it("answers a file one byte over the cap tooLarge from its size, before decoding", async () => {
		mockFetch.mockResolvedValue(
			jsonResponse(
				200,
				gitHubFile("a".repeat(MAX + 1), {
					content: "not base64 at all",
				}),
			),
		);

		expect(await readRepositoryFile(githubInput)).toEqual({
			ok: true,
			state: "tooLarge",
		});
	});

	it("answers GitHub's content-less answer for a large file tooLarge", async () => {
		mockFetch.mockResolvedValue(
			jsonResponse(
				200,
				gitHubFile("", {
					size: 2 * 1024 * 1024,
					content: "",
					encoding: "none",
				}),
			),
		);

		expect(await readRepositoryFile(githubInput)).toEqual({
			ok: true,
			state: "tooLarge",
		});
	});

	it("answers content longer than the cap tooLarge, whatever size the answer claims", async () => {
		mockFetch.mockResolvedValue(
			jsonResponse(200, gitHubFile("a".repeat(MAX + 1), { size: 10 })),
		);

		expect(await readRepositoryFile(githubInput)).toEqual({
			ok: true,
			state: "tooLarge",
		});
	});

	it("stops reading an answer once it passes the bound", async () => {
		const { response, pulled } = streamedResponse(
			16 * 1024,
			1000,
			'{\n  "',
		);
		mockFetch.mockResolvedValue(response);

		expect(await readRepositoryFile(githubInput)).toEqual({
			ok: true,
			state: "tooLarge",
		});
		// Twice the 64 KiB cap plus 64 KiB is twelve 16 KiB chunks; nowhere
		// near all thousand are read.
		expect(pulled.count).toBeLessThanOrEqual(14);
		expect(pulled.cancelled).toBe(true);
	});

	it.each([
		["a body that is not JSON", textResponse(200, "build/\n")],
		[
			"an unknown type",
			jsonResponse(200, gitHubFile("a", { type: "tag" })),
		],
		["no sha", jsonResponse(200, gitHubFile("a", { sha: undefined }))],
		[
			"a sha that is no object id",
			jsonResponse(200, gitHubFile("a", { sha: "xyz" })),
		],
		["no size", jsonResponse(200, gitHubFile("a", { size: undefined }))],
		[
			"content that is not base64",
			jsonResponse(200, gitHubFile("a", { encoding: "utf-8" })),
		],
		["a JSON value that is no object", jsonResponse(200, "build/")],
	])(
		"answers %s unreachable, never an empty file",
		async (_label, response) => {
			mockFetch.mockResolvedValue(response);

			expect(await readRepositoryFile(githubInput)).toEqual({
				ok: false,
				outcome: "unreachable",
			});
		},
	);

	it.each([401, 403])("answers %s unauthorized", async (status) => {
		mockFetch.mockResolvedValue(textResponse(status));

		expect(await readRepositoryFile(githubInput)).toEqual({
			ok: false,
			outcome: "unauthorized",
		});
	});

	it.each([500, 502, 409, 422])("answers %s unreachable", async (status) => {
		mockFetch.mockResolvedValue(textResponse(status));

		expect(await readRepositoryFile(githubInput)).toEqual({
			ok: false,
			outcome: "unreachable",
		});
	});

	it("answers a network failure or timeout unreachable, never throwing", async () => {
		mockFetch.mockRejectedValue(new Error(`timeout ${SECRET_TOKEN}`));

		const result = await readRepositoryFile(githubInput);

		expect(result).toEqual({ ok: false, outcome: "unreachable" });
		expect(JSON.stringify(result)).not.toContain(SECRET_TOKEN);
	});
});

const ADO_BLOB_ID = "0123456789abcdef0123456789abcdef01234567";

/** Azure DevOps's metadata for the item at `adoInput.path`. */
function adoItem(overrides: Record<string, unknown> = {}) {
	return {
		objectId: ADO_BLOB_ID,
		gitObjectType: "blob",
		commitId: "89abcdef0123456789abcdef0123456789abcdef",
		path: "/agents/.fabricignore",
		url: "https://dev.azure.com/example-org/Proj/_apis/git/repositories/instructions/items/agents/.fabricignore",
		...overrides,
	};
}

/** The metadata answer, then the blob's bytes. */
function adoAnswers(blob: Response, item = adoItem()) {
	mockFetch
		.mockResolvedValueOnce(jsonResponse(200, item))
		.mockResolvedValueOnce(blob);
}

describe("readRepositoryFile — Azure DevOps", () => {
	it("reads the item's metadata, then the blob it names, from the URL's host, organization and project", async () => {
		adoAnswers(textResponse(200, "dist/**\n"));

		expect(await readRepositoryFile(adoInput)).toEqual({
			ok: true,
			state: "found",
			text: "dist/**\n",
		});
		expect(mockFetch).toHaveBeenCalledTimes(2);
		const [itemUrl, itemInit] = mockFetch.mock.calls[0] as [
			string,
			{ headers: Record<string, string>; signal?: AbortSignal },
		];
		const item = new URL(itemUrl);
		expect(`${item.origin}${item.pathname}`).toBe(
			"https://dev.azure.com/example-org/Proj/_apis/git/repositories/instructions/items",
		);
		expect(item.searchParams.get("path")).toBe("/agents/.fabricignore");
		expect(item.searchParams.get("versionDescriptor.version")).toBe("main");
		expect(item.searchParams.get("versionDescriptor.versionType")).toBe(
			"branch",
		);
		expect(item.searchParams.get("$format")).toBeNull();
		expect(itemInit.headers.Accept).toBe("application/json");
		expect(itemInit.headers.Authorization).toBe(
			`Basic ${Buffer.from(`:${SECRET_TOKEN}`).toString("base64")}`,
		);
		expect(itemInit.signal).toBeInstanceOf(AbortSignal);

		const [blobUrl, blobInit] = mockFetch.mock.calls[1] as [
			string,
			{ headers: Record<string, string>; signal?: AbortSignal },
		];
		const blob = new URL(blobUrl);
		expect(`${blob.origin}${blob.pathname}`).toBe(
			`https://dev.azure.com/example-org/Proj/_apis/git/repositories/instructions/blobs/${ADO_BLOB_ID}`,
		);
		expect(blob.searchParams.get("$format")).toBe("octetstream");
		expect(blobInit.headers.Accept).toBe("application/octet-stream");
		expect(blobInit.headers.Authorization).toBe(
			`Basic ${Buffer.from(`:${SECRET_TOKEN}`).toString("base64")}`,
		);
		expect(blobInit.signal).toBeInstanceOf(AbortSignal);
	});

	it("decodes a stored repository name once and encodes it once", async () => {
		adoAnswers(textResponse(200, ""));

		await readRepositoryFile({ ...adoInput, repo: "my%20repo" });

		for (const [url] of mockFetch.mock.calls as Array<[string]>) {
			expect(url).toContain("/_apis/git/repositories/my%20repo/");
		}
	});

	it("reads an empty file as found with no text", async () => {
		adoAnswers(textResponse(200, ""));

		expect(await readRepositoryFile(adoInput)).toEqual({
			ok: true,
			state: "found",
			text: "",
		});
	});

	it("answers 404 as an absent file, without reading a blob", async () => {
		mockFetch.mockResolvedValue(textResponse(404));

		expect(await readRepositoryFile(adoInput)).toEqual({
			ok: true,
			state: "absent",
		});
		expect(mockFetch).toHaveBeenCalledTimes(1);
	});

	it.each([
		["a folder", { isFolder: true, gitObjectType: "tree" }],
		["a folder, by its object type alone", { gitObjectType: "tree" }],
		["a symbolic link", { isSymLink: true }],
		["a submodule", { gitObjectType: "commit" }],
	])(
		"answers %s at the path absent, without reading a blob",
		async (_label, overrides) => {
			mockFetch.mockResolvedValue(jsonResponse(200, adoItem(overrides)));

			expect(await readRepositoryFile(adoInput)).toEqual({
				ok: true,
				state: "absent",
			});
			expect(mockFetch).toHaveBeenCalledTimes(1);
		},
	);

	it.each([
		["metadata that is not JSON", textResponse(200, "<html></html>")],
		[
			"an unknown object type",
			jsonResponse(200, adoItem({ gitObjectType: "tag" })),
		],
		["no object id", jsonResponse(200, adoItem({ objectId: undefined }))],
		[
			"an object id that is no SHA-1",
			jsonResponse(200, adoItem({ objectId: "../../other" })),
		],
	])(
		"answers %s unreachable, without reading a blob",
		async (_label, response) => {
			mockFetch.mockResolvedValue(response);

			expect(await readRepositoryFile(adoInput)).toEqual({
				ok: false,
				outcome: "unreachable",
			});
			expect(mockFetch).toHaveBeenCalledTimes(1);
		},
	);

	it("answers a blob over the cap tooLarge", async () => {
		adoAnswers(textResponse(200, "a".repeat(MAX + 1)));

		expect(await readRepositoryFile(adoInput)).toEqual({
			ok: true,
			state: "tooLarge",
		});
	});

	it("reads a blob of exactly the cap", async () => {
		adoAnswers(textResponse(200, "a".repeat(MAX)));

		const result = await readRepositoryFile(adoInput);

		expect(result).toMatchObject({ ok: true, state: "found" });
		expect(
			result.ok && result.state === "found" && result.text,
		).toHaveLength(MAX);
	});

	it("answers a declared length over the cap tooLarge without reading the blob", async () => {
		const { response, pulled } = streamedResponse(1024, 200);
		response.headers.set("content-length", String(200 * 1024));
		adoAnswers(response);

		expect(await readRepositoryFile(adoInput)).toEqual({
			ok: true,
			state: "tooLarge",
		});
		// A stream pulls one chunk ahead on construction at most.
		expect(pulled.count).toBeLessThanOrEqual(1);
	});

	it("stops reading a streamed blob once it passes the cap", async () => {
		const { response, pulled } = streamedResponse(16 * 1024, 1000);
		adoAnswers(response);

		expect(await readRepositoryFile(adoInput)).toEqual({
			ok: true,
			state: "tooLarge",
		});
		// Five 16 KiB chunks pass 64 KiB; nowhere near all thousand are read.
		expect(pulled.count).toBeLessThanOrEqual(6);
		expect(pulled.cancelled).toBe(true);
	});

	it("does not believe an encoded blob's declared length: a short body is read", async () => {
		adoAnswers(
			textResponse(200, "dist/**\n", {
				"content-encoding": "gzip",
				"content-length": String(10 * MAX),
			}),
		);

		expect(await readRepositoryFile(adoInput)).toEqual({
			ok: true,
			state: "found",
			text: "dist/**\n",
		});
	});

	it("still cuts an encoded blob at the cap as it streams", async () => {
		const { response, pulled } = streamedResponse(16 * 1024, 1000);
		response.headers.set("content-encoding", "gzip");
		response.headers.set("content-length", String(1024));
		adoAnswers(response);

		expect(await readRepositoryFile(adoInput)).toEqual({
			ok: true,
			state: "tooLarge",
		});
		// Read past the declared kilobyte — it was not believed — and cut at
		// the cap.
		expect(pulled.count).toBeGreaterThan(1);
		expect(pulled.count).toBeLessThanOrEqual(6);
		expect(pulled.cancelled).toBe(true);
	});

	it("answers the 203 sign-in page an invalid PAT gets unauthorized", async () => {
		mockFetch.mockResolvedValue(textResponse(203, "<html>sign in</html>"));

		expect(await readRepositoryFile(adoInput)).toEqual({
			ok: false,
			outcome: "unauthorized",
		});
	});

	it("answers a 203 sign-in page for the blob unauthorized", async () => {
		adoAnswers(textResponse(203, "<html>sign in</html>"));

		expect(await readRepositoryFile(adoInput)).toEqual({
			ok: false,
			outcome: "unauthorized",
		});
	});

	it.each([401, 403])("answers %s unauthorized", async (status) => {
		mockFetch.mockResolvedValue(textResponse(status));

		expect(await readRepositoryFile(adoInput)).toEqual({
			ok: false,
			outcome: "unauthorized",
		});
	});

	it("answers 500 unreachable", async () => {
		mockFetch.mockResolvedValue(textResponse(500));

		expect(await readRepositoryFile(adoInput)).toEqual({
			ok: false,
			outcome: "unreachable",
		});
	});

	it("answers a blob the metadata named but that is not found unreachable, not absent", async () => {
		adoAnswers(textResponse(404));

		expect(await readRepositoryFile(adoInput)).toEqual({
			ok: false,
			outcome: "unreachable",
		});
	});

	it("answers unreachable without a request when no organization is known", async () => {
		expect(
			await readRepositoryFile({
				...adoInput,
				repositoryUrl: "https://example.com/not-ado",
				azureOrganization: null,
			}),
		).toEqual({ ok: false, outcome: "unreachable" });
		expect(mockFetch).not.toHaveBeenCalled();
	});
});

describe("readRepositoryFile — unsupported providers", () => {
	it("answers GitLab unsupported without a request", async () => {
		expect(await readRepositoryFile(gitlabInput)).toEqual({
			ok: false,
			outcome: "unsupported",
		});
		expect(mockFetch).not.toHaveBeenCalled();
	});
});
