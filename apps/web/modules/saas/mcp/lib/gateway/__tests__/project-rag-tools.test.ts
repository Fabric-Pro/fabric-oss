import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	retrieve: vi.fn(),
	compact: vi.fn(),
}));

vi.mock("@repo/rag", () => ({
	retrieveProjectContexts: m.retrieve,
	compactProjectContextPassages: m.compact,
	contextMetaHeader: () => "",
}));

import { createProjectRagTools } from "../project-rag-tools";
import type { GatewaySession } from "../types";

const session = { userId: "user-1" } as GatewaySession;

function family(status: "allowed" | "not-found" | "forbidden") {
	const gate = vi.fn(async () =>
		status === "allowed" ? { status, organizationId: "org-1" } : { status },
	);
	return {
		gate,
		tools: createProjectRagTools({
			resolveGatewayProjectWriteAccessWithHost: gate,
		}),
	};
}

async function call(
	tools: ReturnType<typeof family>["tools"],
	args: Record<string, unknown>,
) {
	const handler = tools.handlers.get("fabric_semantic_search");
	if (!handler) {
		throw new Error("tool not registered");
	}
	const result = await handler(args, session);
	const text = (result.content[0] as { text: string }).text;
	return { isError: result.isError === true, text };
}

describe("fabric_semantic_search", () => {
	beforeEach(() => {
		m.retrieve.mockReset();
		m.compact.mockReset();
	});

	it("is a read under projects:read", () => {
		const { tools } = family("allowed");
		expect(tools.scopes.fabric_semantic_search).toEqual({
			scope: "projects:read",
			kind: "read",
		});
	});

	it("searches the project's RAG in the project's tenant and returns compact passages", async () => {
		m.retrieve.mockResolvedValue([
			{ id: "ctx-1", type: "DOCUMENT", content: "body", score: 0.8 },
		]);
		m.compact.mockReturnValue({
			context: "### From: spec.md",
			chunkCount: 1,
		});
		const { tools, gate } = family("allowed");

		const out = await call(tools, {
			projectId: "proj-1",
			query: "how does sign-in work",
			limit: 50,
		});

		expect(gate).toHaveBeenCalledWith("proj-1", session, "CONTEXT_READ");
		expect(m.retrieve).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "proj-1",
				query: "how does sign-in work",
				userId: "user-1",
				organizationId: "org-1",
				includeMatchedPassages: true,
				topK: 20,
			}),
		);
		const fullSourceNote = m.compact.mock.calls[0]?.[3]?.fullSourceNote as (
			id: string,
		) => string;
		expect(fullSourceNote("ctx-1")).toContain("fabric_get_project_context");
		expect(out.isError).toBe(false);
		const body = JSON.parse(out.text);
		expect(body.count).toBe(1);
		expect(body.results).toBe("### From: spec.md");
	});

	it("says so when nothing matches", async () => {
		m.retrieve.mockResolvedValue([]);
		const { tools } = family("allowed");

		const body = JSON.parse(
			(await call(tools, { projectId: "proj-1", query: "x" })).text,
		);

		expect(body.count).toBe(0);
		expect(m.compact).not.toHaveBeenCalled();
	});

	it("refuses a project the caller cannot reach, without searching", async () => {
		const { tools } = family("not-found");

		const out = await call(tools, { projectId: "proj-other", query: "x" });

		expect(out.isError).toBe(true);
		expect(m.retrieve).not.toHaveBeenCalled();
	});

	it("refuses a caller without read permission on the project", async () => {
		const { tools } = family("forbidden");

		const out = await call(tools, { projectId: "proj-1", query: "x" });

		expect(out.isError).toBe(true);
		expect(m.retrieve).not.toHaveBeenCalled();
	});

	it("requires a projectId and a query", async () => {
		const { tools } = family("allowed");

		expect((await call(tools, { query: "x" })).isError).toBe(true);
		expect((await call(tools, { projectId: "proj-1" })).isError).toBe(true);
	});
});
