import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listAdoBuildDefinitions, triggerAdoBuild } from "../azure-devops";

const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
	fetchMock = vi.fn();
	globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function reply(status: number, body: unknown = ""): Response {
	return new Response(
		typeof body === "string" ? body : JSON.stringify(body),
		{ status },
	);
}

const base = {
	pat: "ado-pat",
	organization: "contoso",
	project: "Store",
	definitionId: "42",
	sourceBranch: "main",
};

describe("triggerAdoBuild", () => {
	it("queues the build and returns its id and web link", async () => {
		fetchMock.mockResolvedValue(
			reply(200, {
				id: 5150,
				_links: {
					web: {
						href: "https://dev.azure.com/contoso/Store/_build/results?buildId=5150",
					},
				},
			}),
		);

		const result = await triggerAdoBuild(base);

		expect(result).toEqual({
			ok: true,
			runId: "5150",
			runUrl: "https://dev.azure.com/contoso/Store/_build/results?buildId=5150",
		});
	});

	it("drops a non-http run link rather than rendering it as an href", async () => {
		fetchMock.mockResolvedValue(
			reply(200, {
				id: 7,
				_links: { web: { href: "javascript:alert(1)" } },
			}),
		);

		const result = await triggerAdoBuild(base);

		expect(result).toEqual({ ok: true, runId: "7", runUrl: null });
	});

	it("expands a bare branch name to a full ref", async () => {
		// ADO accepts a bare name and then silently builds the wrong thing, so the
		// prefix is added here rather than trusted from the caller.
		fetchMock.mockResolvedValue(reply(200, { id: 1 }));

		await triggerAdoBuild(base);

		expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
			definition: { id: 42 },
			sourceBranch: "refs/heads/main",
		});
	});

	it("leaves an already-qualified ref alone", async () => {
		fetchMock.mockResolvedValue(reply(200, { id: 1 }));

		await triggerAdoBuild({
			...base,
			sourceBranch: "refs/heads/release/2.0",
		});

		expect(JSON.parse(fetchMock.mock.calls[0][1].body).sourceBranch).toBe(
			"refs/heads/release/2.0",
		);
	});

	it("rejects a non-numeric definition id without calling ADO", async () => {
		const result = await triggerAdoBuild({
			...base,
			definitionId: "e2e-pipeline",
		});

		expect(fetchMock).not.toHaveBeenCalled();
		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.failure).toBe("NOT_FOUND");
	});

	it("treats ADO's 203 sign-in response as a credential problem, not success", async () => {
		// ADO answers a rejected PAT with 203 and an HTML sign-in page. A naive
		// 2xx check would call that a queued build and report a run that does not
		// exist.
		fetchMock.mockResolvedValue(reply(203, "<html>sign in</html>"));

		const result = await triggerAdoBuild(base);

		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.failure).toBe("INSUFFICIENT_SCOPE");
		expect(result.message).toContain("Build (read and execute)");
	});

	it("maps 403 to the missing execute scope", async () => {
		fetchMock.mockResolvedValue(reply(403, "Forbidden"));

		const result = await triggerAdoBuild(base);

		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.failure).toBe("INSUFFICIENT_SCOPE");
	});

	it("names the definition and project on a 404", async () => {
		fetchMock.mockResolvedValue(reply(404, "not found"));

		const result = await triggerAdoBuild(base);

		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.failure).toBe("NOT_FOUND");
		expect(result.message).toContain("42");
		expect(result.message).toContain("Store");
	});
});

describe("listAdoBuildDefinitions", () => {
	it("maps definitions and drops ADO's meaningless root folder path", async () => {
		fetchMock.mockResolvedValue(
			reply(200, {
				value: [
					{
						id: 42,
						name: "Store-CI",
						path: "\\",
						_links: { web: { href: "https://dev.azure.com/x" } },
					},
					{ id: 43, name: "Nightly", path: "\\QA" },
				],
			}),
		);

		const definitions = await listAdoBuildDefinitions({
			pat: "ado-pat",
			organization: "contoso",
			project: "Store",
		});

		expect(definitions).toEqual([
			{
				id: "42",
				name: "Store-CI",
				path: null,
				url: "https://dev.azure.com/x",
			},
			{ id: "43", name: "Nightly", path: "\\QA", url: null },
		]);
	});

	it("throws on a rejected PAT rather than reporting no pipelines", async () => {
		fetchMock.mockResolvedValue(reply(203, "<html>sign in</html>"));

		await expect(
			listAdoBuildDefinitions({
				pat: "bad",
				organization: "contoso",
				project: "Store",
			}),
		).rejects.toThrow(/Build scope/);
	});
});
