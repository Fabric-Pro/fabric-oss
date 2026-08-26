/**
 * Unit tests for the `create_view` frontend action registered by
 * `useDefaultMcpInlineRender` — the AI Feature/Document Assistant's
 * Excalidraw entry point.
 *
 * Bug context: the assistant could call `create_view` with empty or
 * unparseable `elements`; the call sailed through to the MCP server,
 * created an empty checkpoint, and the chat rendered "Couldn't display
 * this diagram / Diagram has no elements." These tests pin the handler
 * guard (no server round-trip, corrective JSON back to the model, hard
 * stop after repeated misuse) and the tightened tool description that
 * keeps the model from invoking the tool on conversational turns.
 */
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { registrations } = vi.hoisted(() => ({
	registrations: [] as Array<{
		name: string;
		description?: string;
		parameters?: Array<{ name: string; description?: string }>;
		handler?: (args: Record<string, unknown>) => Promise<string>;
	}>,
}));

vi.mock("@copilotkit/react-core", () => ({
	useCopilotAction: (cfg: (typeof registrations)[number]) => {
		registrations.push(cfg);
	},
}));

// McpAppFrame drags in the Excalidraw canvas + iframe bridge — irrelevant
// here (these tests never mount a render result).
vi.mock("@/components/ai-elements/McpAppFrame", () => ({
	McpAppFrame: () => null,
}));

vi.mock("@saas/projects/hooks/use-route-project-id", () => ({
	useRouteProjectId: () => "proj-1",
}));

import { useDefaultMcpInlineRender } from "@saas/agents/hooks/useDefaultMcpInlineRender";

const VALID_ELEMENTS = JSON.stringify([
	{ id: "e1", type: "rectangle", x: 0, y: 0, width: 100, height: 60 },
]);

function lastCreateView() {
	const entry = [...registrations]
		.reverse()
		.find((r) => r.name === "create_view");
	if (!entry?.handler) {
		throw new Error("create_view was not registered with a handler");
	}
	return entry as typeof entry & {
		handler: NonNullable<(typeof entry)["handler"]>;
	};
}

function invokeCalls(fetchMock: ReturnType<typeof vi.fn>) {
	return fetchMock.mock.calls.filter(([url]) =>
		String(url).includes("/api/mcp-app/invoke"),
	);
}

describe("useDefaultMcpInlineRender — create_view", () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		registrations.length = 0;
		fetchMock = vi.fn(async (url: unknown) => {
			if (String(url).includes("/api/mcp-app/default-configs")) {
				return {
					ok: true,
					json: async () => ({
						configs: [
							{ serverKey: "excalidraw", configId: "cfg-1" },
						],
					}),
				};
			}
			if (String(url).includes("/api/mcp-app/invoke")) {
				return {
					ok: true,
					json: async () => ({
						result: {
							__fabricMcpRender: {
								resourceUri: "ui://excalidraw/view",
								configId: "cfg-1",
								checkpointId: "cp-1",
							},
						},
					}),
				};
			}
			throw new Error(`Unexpected fetch: ${String(url)}`);
		});
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	async function mountHook() {
		const view = renderHook(() =>
			useDefaultMcpInlineRender({ organizationId: null }),
		);
		// Wait for the default-configs fetch to resolve AND the resulting
		// re-render (a second registration pass) so the handler's config
		// lookup is populated before any test invokes it.
		await waitFor(() => {
			expect(
				registrations.filter((r) => r.name === "create_view").length,
			).toBeGreaterThanOrEqual(2);
		});
		return view;
	}

	it("registers a description that forbids conversational invocation", async () => {
		await mountHook();
		const { description } = lastCreateView();
		expect(description).toContain("ONLY when the user explicitly asks");
		expect(description).toContain("NEVER call it for");
		expect(description).toContain("when in doubt, do NOT call it");
		// The old broad tail that over-matched neutral messages.
		expect(description).not.toContain("any visual the user");
		// Parameter guidance carries the non-empty requirement.
		const elementsParam = lastCreateView().parameters?.find(
			(p) => p.name === "elements",
		);
		expect(elementsParam?.description).toContain("NON-EMPTY");
	});

	it("refuses empty elements without a server round-trip", async () => {
		await mountHook();
		const { handler } = lastCreateView();
		const result = JSON.parse(await handler({ elements: "[]" }));
		expect(result.error).toContain("NON-EMPTY");
		expect(result.hint).toContain("reply in text");
		expect(invokeCalls(fetchMock)).toHaveLength(0);
	});

	it("refuses missing and unparseable elements", async () => {
		await mountHook();
		const { handler } = lastCreateView();
		expect(JSON.parse(await handler({})).error).toBeTruthy();
		expect(
			JSON.parse(await handler({ elements: "not json" })).error,
		).toBeTruthy();
		expect(invokeCalls(fetchMock)).toHaveLength(0);
	});

	it("escalates after two consecutive refusals and resets on a guard-passing call", async () => {
		await mountHook();
		const { handler } = lastCreateView();

		const first = JSON.parse(await handler({ elements: "[]" }));
		expect(first.hint).toContain("reply in text without tools");

		const second = JSON.parse(await handler({ elements: "[]" }));
		expect(second.hint).toContain("Do NOT call create_view again");

		// A guard-passing call resets the streak…
		const ok = JSON.parse(await handler({ elements: VALID_ELEMENTS }));
		expect(ok.__fabricMcpRender.checkpointId).toBe("cp-1");

		// …so the next refusal is back to the soft correction.
		const third = JSON.parse(await handler({ elements: "[]" }));
		expect(third.hint).toContain("reply in text without tools");
	});

	it("resets the streak on a valid call even when the invoke itself fails", async () => {
		await mountHook();
		const { handler } = lastCreateView();

		// Build a two-rejection streak, then make the server unreachable.
		await handler({ elements: "[]" });
		await handler({ elements: "[]" });
		fetchMock.mockRejectedValueOnce(new Error("network down"));

		// The valid attempt fails at the network layer — but it passed the
		// guard, so the empty-call streak is over.
		const failed = JSON.parse(await handler({ elements: VALID_ELEMENTS }));
		expect(failed.error).toContain("network down");

		const next = JSON.parse(await handler({ elements: "[]" }));
		expect(next.hint).toContain("reply in text without tools");
	});

	it("invokes the server with the original args for a valid call", async () => {
		await mountHook();
		const { handler } = lastCreateView();
		const result = JSON.parse(await handler({ elements: VALID_ELEMENTS }));
		expect(result.__fabricMcpRender.resourceUri).toBe(
			"ui://excalidraw/view",
		);

		const calls = invokeCalls(fetchMock);
		expect(calls).toHaveLength(1);
		const body = JSON.parse((calls[0][1] as { body: string }).body);
		expect(body).toMatchObject({
			configId: "cfg-1",
			toolName: "create_view",
			args: { elements: VALID_ELEMENTS },
			projectId: "proj-1",
		});
	});
});
