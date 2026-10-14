/**
 * Markdown negotiation for the URL-reading tools.
 *
 * `fetchUrl` and `fetchRfc` ask for `text/markdown` first so sites that
 * offer it (e.g. Cloudflare's Markdown for Agents) return a compact body.
 * A markdown response must reach the model unchanged: running it through
 * the HTML stripper would delete angle-bracket text such as `Array<string>`.
 */

import assert from "node:assert/strict";
import type { ToolSet } from "ai";
import { afterEach, describe, it, vi } from "vitest";
import { createWebFetchTools } from "./web-fetch.js";
import { createWebSearchTools } from "./web-search.js";

const MARKDOWN =
	"# Title\n\nReturns `Array<string>` from <https://example.com>.";

function stubFetch(body: string, contentType: string) {
	const fetchMock = vi.fn(
		async (_url: string | URL | Request, _init?: RequestInit) =>
			new Response(body, {
				status: 200,
				headers: { "content-type": contentType },
			}),
	);
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

function sentAccept(fetchMock: ReturnType<typeof stubFetch>): string {
	const headers = fetchMock.mock.calls[0]?.[1]?.headers as
		| Record<string, string>
		| undefined;
	return headers?.Accept ?? "";
}

async function run(
	tools: ToolSet,
	name: string,
	input: Record<string, unknown>,
): Promise<{ content?: string; error?: string }> {
	const execute = tools[name]?.execute;
	assert.ok(execute, `${name} has no execute`);
	return (await execute(input, {
		toolCallId: "test",
		messages: [],
	} as never)) as { content?: string; error?: string };
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("fetchUrl", () => {
	it("asks for markdown before HTML", async () => {
		const fetchMock = stubFetch(MARKDOWN, "text/markdown; charset=utf-8");
		await run(createWebSearchTools(), "fetchUrl", {
			url: "https://example.com/docs",
		});
		assert.equal(
			sentAccept(fetchMock),
			"text/markdown,text/html;q=0.9,text/plain;q=0.8,application/json;q=0.8",
		);
	});

	it("returns a markdown body unchanged", async () => {
		stubFetch(MARKDOWN, "text/markdown; charset=utf-8");
		const result = await run(createWebSearchTools(), "fetchUrl", {
			url: "https://example.com/docs",
		});
		assert.equal(result.content, MARKDOWN);
	});

	it("still strips tags from an HTML body", async () => {
		stubFetch(
			"<html><body><p>Hello <b>world</b></p><script>x()</script></body></html>",
			"text/html; charset=utf-8",
		);
		const result = await run(createWebSearchTools(), "fetchUrl", {
			url: "https://example.com/page",
		});
		assert.equal(result.content, "Hello world");
	});
});

describe("fetchRfc", () => {
	it("asks for markdown first and returns it unchanged", async () => {
		const fetchMock = stubFetch(MARKDOWN, "text/markdown; charset=utf-8");
		const result = await run(createWebFetchTools(), "fetchRfc", {
			url: "https://www.rfc-editor.org/rfc/rfc9110",
		});
		assert.equal(
			sentAccept(fetchMock),
			"text/markdown,text/html;q=0.9,text/plain;q=0.8,application/xhtml+xml;q=0.8,application/xml;q=0.8",
		);
		assert.equal(result.content, MARKDOWN);
	});
});
