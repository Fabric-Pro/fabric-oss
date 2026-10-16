import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const organization = vi.hoisted(() => ({ id: null as string | null }));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationId: () => organization.id,
}));

const fetchMock = vi.fn();

type Client = typeof import("../fabric-tool-client");

/** A fresh copy of the client, so the tool list and sessions it keeps start empty. */
async function freshClient(): Promise<Client> {
	vi.resetModules();
	return import("../fabric-tool-client");
}

function toolListResponse(tools: unknown) {
	return {
		ok: true,
		status: 200,
		headers: new Headers({ "mcp-session-id": "listing-session" }),
		json: async () => ({ jsonrpc: "2.0", id: 1, result: { tools } }),
	};
}

function toolResponse(payload: unknown, sessionId?: string) {
	return {
		ok: true,
		status: 200,
		headers: new Headers(sessionId ? { "mcp-session-id": sessionId } : {}),
		json: async () => ({
			jsonrpc: "2.0",
			id: 1,
			result: { structuredContent: payload },
		}),
	};
}

function headersOfCall(index: number): Record<string, string> {
	return fetchMock.mock.calls[index][1].headers;
}

beforeEach(() => {
	fetchMock.mockReset();
	organization.id = null;
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("listFabricTools", () => {
	it("asks for Fabric's own tools, as the signed-in user, in a session of its own", async () => {
		const { listFabricTools } = await freshClient();
		fetchMock.mockResolvedValue(
			toolListResponse([
				{
					name: "fabric_list_workflows",
					annotations: { readOnlyHint: true },
				},
				{ name: "fabric_execute_workflow" },
			]),
		);

		const tools = await listFabricTools();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("/api/mcp-gateway?servers=fabric");
		expect(init).toMatchObject({
			method: "POST",
			credentials: "same-origin",
		});
		expect(init.headers).not.toHaveProperty("mcp-session-id");
		expect(JSON.parse(init.body)).toMatchObject({
			jsonrpc: "2.0",
			method: "tools/list",
		});
		expect(tools).toEqual([
			{
				name: "fabric_list_workflows",
				annotations: { readOnlyHint: true },
			},
			{ name: "fabric_execute_workflow" },
		]);
	});

	it("names the organization of the page it is read from", async () => {
		const { listFabricTools } = await freshClient();
		fetchMock.mockResolvedValue(toolListResponse([]));

		await listFabricTools({ organizationId: "org-a" });

		expect(headersOfCall(0)["x-organization-id"]).toBe("org-a");
	});

	it("reads the list once for the life of the page", async () => {
		const { listFabricTools } = await freshClient();
		fetchMock.mockResolvedValue(
			toolListResponse([{ name: "fabric_get_frame" }]),
		);

		const [first, second] = await Promise.all([
			listFabricTools(),
			listFabricTools(),
		]);
		await listFabricTools();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(first).toBe(second);
	});

	it("does not keep a failed read, so the next call tries again", async () => {
		const { FabricToolError, listFabricTools } = await freshClient();
		fetchMock.mockResolvedValueOnce({
			ok: false,
			status: 503,
			headers: new Headers(),
			json: async () => ({}),
		});
		await expect(listFabricTools()).rejects.toBeInstanceOf(FabricToolError);

		fetchMock.mockResolvedValueOnce(
			toolListResponse([{ name: "fabric_get_frame" }]),
		);
		await expect(listFabricTools()).resolves.toEqual([
			{ name: "fabric_get_frame" },
		]);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("reports a protocol error as a tool error", async () => {
		const { listFabricTools } = await freshClient();
		fetchMock.mockResolvedValue({
			ok: true,
			status: 200,
			headers: new Headers(),
			json: async () => ({ error: { code: -32603, message: "Failed" } }),
		});

		await expect(listFabricTools()).rejects.toThrow("Failed");
	});

	it("reports an answer that is not a tool list", async () => {
		const { listFabricTools } = await freshClient();
		fetchMock.mockResolvedValue(toolListResponse("not a list"));

		await expect(listFabricTools()).rejects.toThrow(
			"Fabric returned no tool list",
		);
	});
});

describe("callFabricTool", () => {
	it("names the organization of the page it is called from", async () => {
		const { callFabricTool } = await freshClient();
		fetchMock.mockResolvedValue(toolResponse({ ok: true }));

		await callFabricTool(
			"fabric_list_frames",
			{ surface: "workspace" },
			{ organizationId: "org-a" },
		);

		expect(headersOfCall(0)["x-organization-id"]).toBe("org-a");
		expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
			method: "tools/call",
			params: {
				name: "fabric_list_frames",
				arguments: { surface: "workspace" },
			},
		});
	});

	it("sends no organization when none is given, leaving the session's own", async () => {
		const { callFabricTool } = await freshClient();
		fetchMock.mockResolvedValue(toolResponse({ ok: true }));

		await callFabricTool("fabric_list_frames");

		expect(headersOfCall(0)).not.toHaveProperty("x-organization-id");
	});

	it("names the page a call is made for, so the gateway can hold it to what the page declared", async () => {
		const { callFabricTool } = await freshClient();
		fetchMock.mockResolvedValue(toolResponse({ ok: true }));

		await callFabricTool(
			"fabric_page_data_list",
			{ collection: "votes" },
			{ organizationId: "org-a", pageFrameId: "frame-1" },
		);

		expect(headersOfCall(0)["x-fabric-page-frame"]).toBe("frame-1");
	});

	it("sends no page for a call that is not made for one", async () => {
		const { callFabricTool } = await freshClient();
		fetchMock.mockResolvedValue(toolResponse({ ok: true }));

		await callFabricTool(
			"fabric_list_frames",
			{},
			{ organizationId: "org-a" },
		);

		expect(headersOfCall(0)).not.toHaveProperty("x-fabric-page-frame");
	});

	it("keeps a gateway session for each organization and never lends one to another", async () => {
		const { callFabricTool } = await freshClient();
		fetchMock
			.mockResolvedValueOnce(toolResponse({}, "session-a"))
			.mockResolvedValueOnce(toolResponse({}, "session-b"))
			.mockResolvedValue(toolResponse({}));

		await callFabricTool("t", {}, { organizationId: "org-a" });
		await callFabricTool("t", {}, { organizationId: "org-b" });
		await callFabricTool("t", {}, { organizationId: "org-a" });
		await callFabricTool("t", {}, { organizationId: "org-b" });

		expect(headersOfCall(0)).not.toHaveProperty("mcp-session-id");
		expect(headersOfCall(1)).not.toHaveProperty("mcp-session-id");
		expect(headersOfCall(2)["mcp-session-id"]).toBe("session-a");
		expect(headersOfCall(3)["mcp-session-id"]).toBe("session-b");
	});

	it("drops an organization's session when the gateway no longer knows it", async () => {
		const { callFabricTool, FabricToolError } = await freshClient();
		fetchMock.mockResolvedValueOnce(toolResponse({}, "session-a"));
		await callFabricTool("t", {}, { organizationId: "org-a" });
		fetchMock.mockResolvedValueOnce({
			ok: false,
			status: 404,
			headers: new Headers(),
			json: async () => ({}),
		});
		await expect(
			callFabricTool("t", {}, { organizationId: "org-a" }),
		).rejects.toBeInstanceOf(FabricToolError);
		fetchMock.mockResolvedValueOnce(toolResponse({}));

		await callFabricTool("t", {}, { organizationId: "org-a" });

		expect(headersOfCall(2)).not.toHaveProperty("mcp-session-id");
	});

	it("returns the payload checked against the schema it was given", async () => {
		const { callFabricTool } = await freshClient();
		fetchMock.mockResolvedValue(toolResponse({ frameId: "f1", extra: 1 }));

		const payload = await callFabricTool(
			"fabric_get_frame",
			{ frameId: "f1" },
			{ schema: z.object({ frameId: z.string() }) },
		);

		expect(payload).toEqual({ frameId: "f1" });
	});

	it("refuses a payload that does not fit the schema", async () => {
		const { callFabricTool } = await freshClient();
		fetchMock.mockResolvedValue(toolResponse({ frameId: 7 }));

		await expect(
			callFabricTool(
				"fabric_get_frame",
				{},
				{ schema: z.object({ frameId: z.string() }) },
			),
		).rejects.toThrow("returned an answer this page cannot read");
	});

	it("raises the tool's own error for an error result", async () => {
		const { callFabricTool } = await freshClient();
		fetchMock.mockResolvedValue({
			ok: true,
			status: 200,
			headers: new Headers(),
			json: async () => ({
				jsonrpc: "2.0",
				id: 1,
				result: {
					isError: true,
					content: [
						{ type: "text", text: '{"error":"Frame not found."}' },
					],
				},
			}),
		});

		await expect(callFabricTool("fabric_get_frame")).rejects.toThrow(
			"Frame not found.",
		);
	});

	it("carries the reason a tool gave, and whether to try again", async () => {
		const { callFabricTool } = await freshClient();
		fetchMock.mockResolvedValue({
			ok: true,
			status: 200,
			headers: new Headers(),
			json: async () => ({
				jsonrpc: "2.0",
				id: 1,
				result: {
					isError: true,
					content: [
						{
							type: "text",
							text: JSON.stringify({
								error: "The page is busy. Try again in a moment.",
								reason: "busy",
								retryable: true,
							}),
						},
					],
				},
			}),
		});

		const error = await callFabricTool("fabric_page_comment_add").catch(
			(caught: unknown) => caught,
		);

		expect(error).toMatchObject({
			name: "FabricToolError",
			message: "The page is busy. Try again in a moment.",
			toolName: "fabric_page_comment_add",
			reason: "busy",
			retryable: true,
		});
	});

	it("leaves the reason empty when the tool gave none", async () => {
		const { callFabricTool } = await freshClient();
		fetchMock.mockResolvedValue({
			ok: true,
			status: 200,
			headers: new Headers(),
			json: async () => ({
				jsonrpc: "2.0",
				id: 1,
				result: {
					isError: true,
					content: [{ type: "text", text: '{"error":"Nope."}' }],
				},
			}),
		});

		const error = await callFabricTool("fabric_get_frame").catch(
			(caught: unknown) => caught,
		);

		expect(error).toMatchObject({ message: "Nope." });
		expect(error).toHaveProperty("reason", undefined);
		expect(error).toHaveProperty("retryable", undefined);
	});
});

describe("useFabricToolQuery", () => {
	function wrapperFor(client: QueryClient) {
		return ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={client}>
				{children}
			</QueryClientProvider>
		);
	}

	const schema = z.object({ frames: z.array(z.string()) });

	it("reads in the organization of the page and keeps the answer under it", async () => {
		const { useFabricToolQuery } = await freshClient();
		organization.id = "org-a";
		fetchMock.mockResolvedValue(toolResponse({ frames: ["a"] }));
		const client = new QueryClient();

		const { result } = renderHook(
			() =>
				useFabricToolQuery(
					"fabric_list_frames",
					{ surface: "workspace" },
					{ schema },
				),
			{ wrapper: wrapperFor(client) },
		);

		await waitFor(() =>
			expect(result.current.data).toEqual({ frames: ["a"] }),
		);
		expect(headersOfCall(0)["x-organization-id"]).toBe("org-a");
		expect(client.getQueryCache().getAll()[0].queryKey).toEqual([
			"fabric-tool",
			"org-a",
			"fabric_list_frames",
			{ surface: "workspace" },
		]);
	});

	it("asks again, and does not show the last answer, when the page's organization changes", async () => {
		const { useFabricToolQuery } = await freshClient();
		organization.id = "org-a";
		fetchMock
			.mockResolvedValueOnce(toolResponse({ frames: ["from-a"] }))
			.mockResolvedValueOnce(toolResponse({ frames: ["from-b"] }));
		const client = new QueryClient();
		const { result, rerender } = renderHook(
			() => useFabricToolQuery("fabric_list_frames", {}, { schema }),
			{ wrapper: wrapperFor(client) },
		);
		await waitFor(() =>
			expect(result.current.data).toEqual({ frames: ["from-a"] }),
		);

		organization.id = "org-b";
		rerender();

		expect(result.current.data).toBeUndefined();
		await waitFor(() =>
			expect(result.current.data).toEqual({ frames: ["from-b"] }),
		);
		expect(headersOfCall(1)["x-organization-id"]).toBe("org-b");
	});

	it("waits until the page's organization is known, and asks nothing before", async () => {
		const { useFabricToolQuery } = await freshClient();
		organization.id = null;
		const client = new QueryClient();

		const { result } = renderHook(
			() => useFabricToolQuery("fabric_list_frames", {}, { schema }),
			{ wrapper: wrapperFor(client) },
		);
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(fetchMock).not.toHaveBeenCalled();
		expect(result.current.fetchStatus).toBe("idle");
	});

	it("stays idle when the caller turns it off", async () => {
		const { useFabricToolQuery } = await freshClient();
		organization.id = "org-a";
		const client = new QueryClient();

		renderHook(
			() =>
				useFabricToolQuery(
					"fabric_list_frames",
					{},
					{ schema, enabled: false },
				),
			{ wrapper: wrapperFor(client) },
		);
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(fetchMock).not.toHaveBeenCalled();
	});
});
