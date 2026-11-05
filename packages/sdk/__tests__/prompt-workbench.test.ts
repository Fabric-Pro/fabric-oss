import { expect, it, vi } from "vitest";
import type { FabricHttpClient } from "../src/client.js";
import { PromptsResource } from "../src/resources/prompts.js";

it("exposes assistance and previews with org propagation, response bounds and no automatic retries", async () => {
	const request = vi.fn().mockResolvedValue({ output: "example" });
	const resource = new PromptsResource({
		request,
	} as unknown as FabricHttpClient);
	const draft = { content: "Reply briefly" };
	await resource.assist(
		{ draft, message: "Improve" },
		{ org: "example team" },
	);
	expect(request).toHaveBeenCalledWith(
		"POST",
		"/prompt-assistance?org=example+team",
		{
			body: { draft, message: "Improve" },
			retry: { maxRetries: 0 },
			boundedRead: { maxResponseBytes: 512 * 1024 },
		},
	);
	await resource.preview({ draft });
	expect(request).toHaveBeenLastCalledWith(
		"POST",
		"/prompt-previews",
		expect.objectContaining({ body: { draft }, retry: { maxRetries: 0 } }),
	);
});
it("refuses oversized aggregate payloads without sending them", async () => {
	const request = vi.fn();
	const resource = new PromptsResource({
		request,
	} as unknown as FabricHttpClient);
	await expect(
		resource.preview({ draft: { content: "x".repeat(512 * 1024) } }),
	).rejects.toThrow(/512 KiB/);
	expect(request).not.toHaveBeenCalled();
});
it("reads and versions response contracts through the same bounded organization transport", async () => {
	const request = vi.fn().mockResolvedValue({ versionId: "example-v2" });
	const resource = new PromptsResource({
		request,
	} as unknown as FabricHttpClient);
	await resource.getResponseContract("example-prompt", {
		org: "example-team",
	});
	expect(request).toHaveBeenLastCalledWith(
		"POST",
		"/prompt-responses/read?org=example-team",
		expect.objectContaining({
			body: { promptId: "example-prompt" },
			retry: { maxRetries: 0 },
		}),
	);
	await resource.setResponseContract(
		"example-prompt",
		{ format: "JSON", schema: { type: "object" } },
		{ org: "example-team" },
	);
	expect(request).toHaveBeenLastCalledWith(
		"POST",
		"/prompt-responses?org=example-team",
		expect.objectContaining({
			body: {
				promptId: "example-prompt",
				responseContract: {
					format: "JSON",
					schema: { type: "object" },
				},
			},
		}),
	);
});
