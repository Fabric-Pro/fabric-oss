/**
 * `fetchAdoWorkItemTypes` against a rejected PAT.
 *
 * Azure DevOps answers an invalid or expired PAT with HTTP 203 and an HTML
 * sign-in page, and `Response.ok` is true for 203. The helper must report the
 * same auth error a 401 gets, not a JSON parse failure.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/utils", () => ({
	decryptApiKey: (value: string) => `decrypted:${value}`,
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { fetchAdoWorkItemTypes } from "../ado-work-item-types";

const config = {
	mcpServer: { key: "azure-devops", command: null },
	encryptedApiKey: "enc-pat",
	commandArgs: ["example-org"],
	baseUrl: null,
};

beforeEach(() => {
	mockFetch.mockReset();
});

describe("fetchAdoWorkItemTypes", () => {
	it("returns the pickable types on a 200", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					value: [{ name: "Bug" }, { name: "Epic" }],
				}),
				{ status: 200 },
			),
		);

		const result = await fetchAdoWorkItemTypes({
			config,
			containerId: "Proj",
		});

		expect(result).toEqual({
			types: [{ name: "Bug", description: null }],
			error: null,
		});
	});

	it("reports an auth error for a 401", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response("unauthorized", { status: 401 }),
		);

		const result = await fetchAdoWorkItemTypes({
			config,
			containerId: "Proj",
		});

		expect(result.types).toEqual([]);
		expect(result.error).toMatch(/^Azure DevOps API error \(401\)/);
	});

	it("reports the same auth error for ADO's 203 sign-in page", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response("<html>sign in</html>", {
				status: 203,
				headers: { "content-type": "text/html" },
			}),
		);

		const result = await fetchAdoWorkItemTypes({
			config,
			containerId: "Proj",
		});

		expect(result.types).toEqual([]);
		expect(result.error).toMatch(/^Azure DevOps API error \(401\)/);
		expect(result.error).not.toMatch(/Unexpected token|JSON/i);
	});
});
