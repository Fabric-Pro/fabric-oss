/**
 * The GitHub trigger exists to turn three indistinguishable "GitHub said no"
 * responses into three different instructions, so that mapping — not the happy
 * path — is what these tests pin down.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listGithubWorkflows, triggerGithubWorkflow } from "../github";

const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
	fetchMock = vi.fn();
	globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function reply(
	status: number,
	body: unknown = "",
	headers: Record<string, string> = {},
): Response {
	return new Response(
		status === 204
			? null
			: typeof body === "string"
				? body
				: JSON.stringify(body),
		{ status, headers },
	);
}

const base = {
	token: "gho_test",
	owner: "acme",
	repo: "store",
	workflowId: "1234",
	ref: "main",
};

describe("triggerGithubWorkflow", () => {
	it("treats 204 as a started run and offers the workflow page to watch", async () => {
		fetchMock.mockResolvedValue(reply(204));

		const result = await triggerGithubWorkflow(base);

		expect(result).toEqual({
			ok: true,
			// GitHub's dispatch endpoint deliberately returns no run id.
			runId: null,
			runUrl: "https://github.com/acme/store/actions/workflows/1234",
		});
	});

	it("posts the ref, and inputs only when there are some", async () => {
		fetchMock.mockResolvedValue(reply(204));

		await triggerGithubWorkflow(base);
		expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
			ref: "main",
		});

		await triggerGithubWorkflow({ ...base, inputs: { suite: "smoke" } });
		expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
			ref: "main",
			inputs: { suite: "smoke" },
		});
	});

	it("names a missing workflow_dispatch trigger as the customer's own fix", async () => {
		fetchMock.mockResolvedValue(
			reply(422, {
				message: "Workflow does not have 'workflow_dispatch' trigger.",
			}),
		);

		const result = await triggerGithubWorkflow(base);

		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.failure).toBe("NOT_DISPATCHABLE");
		expect(result.message).toContain("workflow_dispatch:");
		// It must be clear Fabric will not do this for them.
		expect(result.message).toContain(
			"does not modify your CI configuration",
		);
	});

	it("names a revoked credential on 401 instead of a generic failure", async () => {
		// GitHub answers a revoked or expired token with 401, not 403. Without its
		// own branch this fell through to "GitHub could not start the run (401)" —
		// accurate and useless, and it pointed at the wrong remedy.
		fetchMock.mockResolvedValue(reply(401, { message: "Bad credentials" }));

		const result = await triggerGithubWorkflow(base);

		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.failure).toBe("INSUFFICIENT_SCOPE");
		expect(result.message).toMatch(/revoked|expired/i);
		// It must not tell them to go and add a scope that is already there.
		expect(result.message).not.toContain("actions:write");
	});

	it("maps a plain 403 to the actions:write scope gap", async () => {
		fetchMock.mockResolvedValue(
			reply(403, { message: "Resource not accessible by integration" }),
		);

		const result = await triggerGithubWorkflow(base);

		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.failure).toBe("INSUFFICIENT_SCOPE");
		expect(result.message).toContain("actions:write");
	});

	it("does NOT blame the token when a 403 is really a rate limit", async () => {
		// GitHub reuses 403 for throttling; reporting that as a missing scope
		// sends the user to reissue a credential that was never the problem.
		fetchMock.mockResolvedValue(
			reply(
				403,
				{ message: "API rate limit exceeded" },
				{
					"x-ratelimit-remaining": "0",
				},
			),
		);

		const result = await triggerGithubWorkflow(base);

		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.failure).toBe("RATE_LIMITED");
		expect(result.message).not.toContain("actions:write");
	});

	it("reports a 404 as workflow-or-visibility, since GitHub conflates them", async () => {
		fetchMock.mockResolvedValue(reply(404, { message: "Not Found" }));

		const result = await triggerGithubWorkflow(base);

		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.failure).toBe("NOT_FOUND");
		expect(result.message).toContain("acme/store");
	});

	it("passes through a 422 that is not about workflow_dispatch", async () => {
		fetchMock.mockResolvedValue(
			reply(422, { message: 'Unexpected inputs provided: ["nope"]' }),
		);

		const result = await triggerGithubWorkflow(base);

		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.failure).toBe("PROVIDER_ERROR");
		expect(result.message).toContain("Unexpected inputs");
	});

	it("never leaks the credential into a user-facing message", async () => {
		fetchMock.mockResolvedValue(reply(500, "gho_test leaked in body"));

		const result = await triggerGithubWorkflow(base);

		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		// This used to assert the token appeared EXACTLY ONCE — conceding that
		// the quoted body carried it, and only checking we did not add a second
		// copy. The title promised something the assertion never enforced. The
		// body is now scrubbed before it is quoted, so the honest assertion is
		// zero.
		expect(result.message).not.toContain("gho_test");
		expect(result.message).toContain("[REDACTED]");
	});
});

describe("listGithubWorkflows", () => {
	it("returns only active workflows, since a disabled one cannot run", async () => {
		fetchMock.mockResolvedValue(
			reply(200, {
				workflows: [
					{
						id: 1,
						name: "E2E",
						path: ".github/workflows/e2e.yml",
						state: "active",
						html_url:
							"https://github.com/acme/store/actions/workflows/e2e.yml",
					},
					{
						id: 2,
						name: "Old",
						path: ".github/workflows/old.yml",
						state: "disabled_manually",
						html_url:
							"https://github.com/acme/store/actions/workflows/old.yml",
					},
				],
			}),
		);

		const workflows = await listGithubWorkflows({
			token: "gho_test",
			owner: "acme",
			repo: "store",
		});

		expect(workflows).toEqual([
			{
				id: "1",
				name: "E2E",
				path: ".github/workflows/e2e.yml",
				url: "https://github.com/acme/store/actions/workflows/e2e.yml",
			},
		]);
	});

	it("throws on a rejected credential rather than reporting an empty repo", async () => {
		fetchMock.mockResolvedValue(reply(401, { message: "Bad credentials" }));

		await expect(
			listGithubWorkflows({
				token: "bad",
				owner: "acme",
				repo: "store",
			}),
		).rejects.toThrow(/401/);
	});
});
