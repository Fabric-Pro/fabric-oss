/**
 * The execution stream finds the caller's own execution whatever their active
 * organization (Fizzy #2904 review). `startExecution` stamps an execution with
 * its authorized project's organization; the stream used to filter on the
 * session's, so a project guest (no active organization) or a member whose
 * active organization is another got 404 for their own run.
 */
import { ORPCError } from "@orpc/client";
import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG_PROJECT = "org-example-project";
const ORG_OTHER = "org-example-other";
const USER_ID = "user-example-1";

const mocks = vi.hoisted(() => ({
	getSession: vi.fn(),
	executionFindFirst: vi.fn(),
	assertProjectPermission: vi.fn(),
	createStream: vi.fn(),
}));

vi.mock("@saas/auth/lib/server", () => ({ getSession: mocks.getSession }));
vi.mock("@repo/database", () => ({
	db: {
		weaveExecution: {
			findFirst: mocks.executionFindFirst,
			findUnique: vi.fn(),
		},
	},
}));
vi.mock("@repo/api/orpc/procedures", () => ({
	assertProjectPermission: mocks.assertProjectPermission,
	Permissions: { AGENT_READ: "agent:read" },
}));
vi.mock("@repo/api/modules/weave/procedures/stream-execution", () => ({
	createWeaveExecutionStream: mocks.createStream,
}));

import { GET } from "../route";

function request(query: string): NextRequest {
	const url = new URL(`https://app.example.com/api/weave/stream?${query}`);
	return {
		nextUrl: url,
		headers: new Headers(),
	} as unknown as NextRequest;
}

/** A stored execution, matched against the lookup's filter like the database. */
function storedExecution(organizationId: string | null) {
	const row = {
		id: "exec-1",
		workflowId: "weave-exec-exec-1",
		status: "RUNNING",
		projectId: "project-1",
		organizationId,
		userId: USER_ID,
	};
	mocks.executionFindFirst.mockImplementation(
		async ({ where }: { where: Record<string, unknown> }) =>
			Object.entries(where).every(
				([key, value]) =>
					(row as Record<string, unknown>)[key] === value,
			)
				? row
				: null,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.assertProjectPermission.mockResolvedValue({
		projectId: "project-1",
		organizationId: ORG_PROJECT,
	});
	mocks.createStream.mockReturnValue(new ReadableStream());
});

describe("GET /api/weave/stream", () => {
	it.each([
		["a project guest with no active organization", null],
		["a member whose active organization is another", ORG_OTHER],
	])("streams the caller's own execution for %s", async (_label, active) => {
		mocks.getSession.mockResolvedValue({
			user: { id: USER_ID },
			session: { activeOrganizationId: active },
		});
		storedExecution(ORG_PROJECT);

		const response = await GET(request("executionId=exec-1"));

		expect(response.status).toBe(200);
		expect(mocks.assertProjectPermission).toHaveBeenCalledWith(
			"project-1",
			USER_ID,
			"agent:read",
		);
		expect(mocks.createStream).toHaveBeenCalledWith(
			"exec-1",
			"weave-exec-exec-1",
			undefined,
		);
	});

	it("refuses another organization named for the run", async () => {
		mocks.getSession.mockResolvedValue({
			user: { id: USER_ID },
			session: { activeOrganizationId: ORG_OTHER },
		});
		storedExecution(ORG_PROJECT);

		const response = await GET(
			request(`executionId=exec-1&organizationId=${ORG_OTHER}`),
		);

		expect(response.status).toBe(400);
		expect(mocks.createStream).not.toHaveBeenCalled();
	});

	it("hides an execution stamped with another organization than its project's", async () => {
		mocks.getSession.mockResolvedValue({
			user: { id: USER_ID },
			session: { activeOrganizationId: ORG_OTHER },
		});
		storedExecution(ORG_OTHER);

		const response = await GET(request("executionId=exec-1"));

		expect(response.status).toBe(404);
		expect(mocks.createStream).not.toHaveBeenCalled();
	});

	it("hides an execution whose project the caller can no longer read", async () => {
		mocks.getSession.mockResolvedValue({
			user: { id: USER_ID },
			session: { activeOrganizationId: ORG_PROJECT },
		});
		storedExecution(ORG_PROJECT);
		mocks.assertProjectPermission.mockRejectedValue(
			new ORPCError("FORBIDDEN"),
		);

		const response = await GET(request("executionId=exec-1"));

		expect(response.status).toBe(404);
		expect(mocks.createStream).not.toHaveBeenCalled();
	});

	it("hides another caller's execution", async () => {
		mocks.getSession.mockResolvedValue({
			user: { id: "user-example-2" },
			session: { activeOrganizationId: ORG_PROJECT },
		});
		storedExecution(ORG_PROJECT);

		const response = await GET(request("executionId=exec-1"));

		expect(response.status).toBe(404);
		expect(mocks.assertProjectPermission).not.toHaveBeenCalled();
	});
});
