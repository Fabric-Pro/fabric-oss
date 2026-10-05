import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRepositoryFile, listRepositoryStructure } from "../src/code-search";

/**
 * Two properties of the file and tree reads the chat model sees:
 *
 * 1. A failure's message is a fixed sentence per kind and status. It never
 *    carries an exception message, a provider's response body, status text or
 *    headers — any of which can hold a token — and the logs carry only the
 *    kind, the status and an error class name.
 * 2. GitHub's contents API answers a folder with an array (or `type: "dir"`)
 *    and an empty file with `size: 0`; neither is "binary". Binary content
 *    (GitHub base64-encodes it too) is still binary.
 */

const SECRET_TOKEN = "ghp_EXAMPLESECRET0123456789abcdefABCDEF";
const SECRET_BEARER = "Bearer example.secret.jwt";

const GITHUB = {
	provider: "GITHUB" as const,
	token: "t",
	owner: "example-org",
	repo: "app",
};
const ADO = {
	provider: "AZURE_DEVOPS" as const,
	token: "t",
	owner: "example-org",
	repo: "app",
	azureProject: "example-project",
};

let logged: () => string;

beforeEach(() => {
	const spies = [
		vi.spyOn(console, "error").mockImplementation(() => {}),
		vi.spyOn(console, "warn").mockImplementation(() => {}),
		vi.spyOn(console, "log").mockImplementation(() => {}),
	];
	logged = () =>
		spies
			.flatMap((spy) => spy.mock.calls.flat())
			.map((arg) => inspect(arg, { depth: 6 }))
			.join("\n");
});
afterEach(() => vi.restoreAllMocks());

function leakyResponse(status: number) {
	return new Response(
		JSON.stringify({ message: `bad credentials ${SECRET_TOKEN}` }),
		{
			status,
			statusText: SECRET_BEARER,
			headers: { "x-debug-token": SECRET_TOKEN },
		},
	);
}

function expectNoSecret(text: string) {
	expect(text).not.toContain(SECRET_TOKEN);
	expect(text).not.toContain("example.secret.jwt");
}

describe("read errors never carry provider or exception text", () => {
	it.each([
		["GitHub file", () => getRepositoryFile({ ...GITHUB, path: "a.ts" })],
		["GitHub tree", () => listRepositoryStructure(GITHUB)],
		[
			"Azure DevOps file",
			() => getRepositoryFile({ ...ADO, path: "a.ts" }),
		],
		["Azure DevOps tree", () => listRepositoryStructure(ADO)],
	] as const)("%s: a failed response", async (_label, read) => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(leakyResponse(500));
		const result = await read();
		expect(result.error?.kind).toBe("provider_error");
		expectNoSecret(result.error?.message ?? "");
		expectNoSecret(logged());
	});

	it.each([
		["GitHub file", () => getRepositoryFile({ ...GITHUB, path: "a.ts" })],
		["Azure DevOps tree", () => listRepositoryStructure(ADO)],
	] as const)("%s: a thrown exception", async (_label, read) => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(
			new TypeError(
				`request to https://example.com/?access_token=${SECRET_TOKEN} failed, auth ${SECRET_BEARER}`,
			),
		);
		const result = await read();
		expect(result.error?.kind).toBe("request_failed");
		expectNoSecret(result.error?.message ?? "");
		expectNoSecret(logged());
		expect(logged()).toContain("TypeError");
	});
});

function okJson(body: unknown) {
	return new Response(JSON.stringify(body), { status: 200 });
}

describe("GitHub contents: folders, empty files and binary files", () => {
	it("an empty file (size 0) is empty, not binary", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			okJson({
				type: "file",
				size: 0,
				content: "",
				encoding: "base64",
				sha: "e69de29",
			}),
		);
		const file = await getRepositoryFile({ ...GITHUB, path: "empty.txt" });
		expect(file).toMatchObject({ content: "", isBinary: false, size: 0 });
		expect(file.error).toBeUndefined();
	});

	it("a folder (array answer) is not a file", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			okJson([{ type: "file", name: "a.ts", path: "src/a.ts" }]),
		);
		const file = await getRepositoryFile({ ...GITHUB, path: "src" });
		expect(file.isBinary).toBe(false);
		expect(file.error).toMatchObject({
			kind: "not_a_file",
			objectType: "dir",
		});
	});

	it.each(["dir", "symlink", "submodule"])(
		"type %s is not a file",
		async (type) => {
			vi.spyOn(globalThis, "fetch").mockResolvedValue(
				okJson({ type, size: 0, path: "vendor/lib" }),
			);
			const file = await getRepositoryFile({
				...GITHUB,
				path: "vendor/lib",
			});
			expect(file.error).toMatchObject({
				kind: "not_a_file",
				objectType: type,
			});
		},
	);

	it("binary content (NUL bytes, base64-encoded) is still binary", async () => {
		const png = Buffer.from([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x00, 0x01,
		]);
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			okJson({
				type: "file",
				size: png.length,
				content: png.toString("base64"),
				encoding: "base64",
				sha: "abc1234",
			}),
		);
		const file = await getRepositoryFile({ ...GITHUB, path: "logo.png" });
		expect(file.isBinary).toBe(true);
		expect(file.content).toBe("");
		expect(file.error).toBeUndefined();
	});

	it("a non-base64 encoding is still binary", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			okJson({ type: "file", size: 5, content: "", encoding: "none" }),
		);
		const file = await getRepositoryFile({ ...GITHUB, path: "big.bin" });
		expect(file.isBinary).toBe(true);
	});
});

/**
 * Azure DevOps `items`: asked with `Accept: application/json` (as
 * repository-file.ts does) it answers the item's metadata; asked without,
 * it answers the file's raw content. The fake routes on that header, so a
 * reader that decides "folder" from the content cannot pass.
 */
function adoItems(item: Record<string, unknown>, content: string) {
	vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
		const accept = new Headers(
			(init as RequestInit | undefined)?.headers,
		).get("accept");
		return accept === "application/json"
			? new Response(JSON.stringify(item), {
					status: 200,
					headers: { "content-type": "application/json" },
				})
			: new Response(content, { status: 200 });
	});
}

const BLOB_ITEM = {
	objectId: "0123456789abcdef0123456789abcdef01234567",
	gitObjectType: "blob",
	path: "/config/item.json",
	url: "https://dev.azure.com/example-org/example-project/_apis/git/repositories/app/items/config/item.json",
};

describe("Azure DevOps items: folders and empty files", () => {
	it("an empty file is empty with no error", async () => {
		adoItems(BLOB_ITEM, "");
		const file = await getRepositoryFile({ ...ADO, path: "empty.txt" });
		expect(file).toMatchObject({ content: "", isBinary: false });
		expect(file.error).toBeUndefined();
	});

	it.each([
		[{ isFolder: true, gitObjectType: "tree" }, "dir"],
		[{ isSymLink: true, gitObjectType: "blob" }, "symlink"],
		[{ gitObjectType: "commit" }, "submodule"],
	] as const)(
		"item metadata %o is not a file (%s)",
		async (shape, objectType) => {
			adoItems(
				{ objectId: "a1b2c3", path: "/src", ...shape },
				"irrelevant",
			);
			const file = await getRepositoryFile({ ...ADO, path: "src" });
			expect(file.error).toMatchObject({
				kind: "not_a_file",
				objectType,
			});
		},
	);

	it("a regular JSON file that looks like folder metadata returns its contents", async () => {
		const lookalike = JSON.stringify({
			objectId: "fixture-object",
			path: "/fixtures/folder.json",
			isFolder: true,
			gitObjectType: "tree",
		});
		adoItems(BLOB_ITEM, lookalike);
		const file = await getRepositoryFile({
			...ADO,
			path: "fixtures/folder.json",
		});
		expect(file.error).toBeUndefined();
		expect(file.content).toBe(lookalike);
	});
});
