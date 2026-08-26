import { afterEach, describe, expect, it, vi } from "vitest";
import { gitlabRequest } from "../../src/gitlab/rest-client";

describe("gitlabRequest", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("passes the caller's AbortSignal to fetch", async () => {
		const controller = new AbortController();
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({}), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		await gitlabRequest({
			path: "/x",
			token: "t",
			signal: controller.signal,
		});
		expect(fetchMock.mock.calls[0][1]).toMatchObject({
			signal: controller.signal,
		});
	});
});
