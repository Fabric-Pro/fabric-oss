import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	list: vi.fn(),
}));

vi.mock("@repo/api/modules/projects/lib/code-repositories", () => ({
	CODE_REPOSITORIES_FOLDER: "repos",
	listProjectCodeRepositories: m.list,
}));

import { createCodeRepositoriesTools } from "../code-repositories-tools";
import type { GatewaySession } from "../types";

const session = { userId: "user-1" } as GatewaySession;

function family(status: "allowed" | "not-found" | "forbidden") {
	const gate = vi.fn(async () =>
		status === "allowed" ? { status, organizationId: "org-1" } : { status },
	);
	return {
		gate,
		tools: createCodeRepositoriesTools({
			resolveGatewayProjectWriteAccessWithHost: gate,
		}),
	};
}

async function call(
	tools: ReturnType<typeof family>["tools"],
	args: Record<string, unknown>,
) {
	const handler = tools.handlers.get("fabric_list_code_repositories");
	if (!handler) {
		throw new Error("tool not registered");
	}
	const result = await handler(args, session);
	const text = (result.content[0] as { text: string }).text;
	return { isError: result.isError === true, text };
}

describe("fabric_list_code_repositories", () => {
	beforeEach(() => {
		m.list.mockReset();
	});

	it("is a read under instructions:read", () => {
		const { tools } = family("allowed");
		expect(tools.scopes.fabric_list_code_repositories).toEqual({
			scope: "instructions:read",
			kind: "read",
		});
	});

	it("returns each repository with the repos/<folder> path to clone it into", async () => {
		m.list.mockResolvedValue([
			{
				id: "int-1",
				provider: "GITHUB",
				name: "example-org/app",
				cloneUrl: "https://github.com/example-org/app.git",
				defaultBranch: "main",
				roleTag: null,
				folder: "app",
			},
		]);
		const { tools, gate } = family("allowed");

		const out = await call(tools, { projectId: "proj-1" });

		expect(gate).toHaveBeenCalledWith("proj-1", session, "CONTEXT_READ");
		expect(out.isError).toBe(false);
		const body = JSON.parse(out.text);
		expect(body.repositories).toEqual([
			{
				name: "example-org/app",
				provider: "GITHUB",
				cloneUrl: "https://github.com/example-org/app.git",
				defaultBranch: "main",
				roleTag: null,
				path: "repos/app",
			},
		]);
		expect(body.message).toContain("git clone <cloneUrl> <path>");
	});

	it("refuses a project the caller cannot reach, without listing", async () => {
		const { tools } = family("not-found");

		const out = await call(tools, { projectId: "proj-other" });

		expect(out.isError).toBe(true);
		expect(m.list).not.toHaveBeenCalled();
	});

	it("refuses a caller without read permission on the project", async () => {
		const { tools } = family("forbidden");

		const out = await call(tools, { projectId: "proj-1" });

		expect(out.isError).toBe(true);
		expect(out.text).toContain("No permission");
		expect(m.list).not.toHaveBeenCalled();
	});

	it("requires a projectId", async () => {
		const { tools } = family("allowed");

		const out = await call(tools, {});

		expect(out.isError).toBe(true);
	});
});
