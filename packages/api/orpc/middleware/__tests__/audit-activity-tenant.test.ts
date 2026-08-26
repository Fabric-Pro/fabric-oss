/**
 * Tenant resolution for automatically-captured activity rows.
 *
 * The helper unit tests next door cover the capture DECISION. These cover where
 * the row lands, which is a different question and the one that was wrong.
 *
 * The original middleware passed no `organizationId` at all. The org audit
 * viewer filters strictly on `organizationId = <org>`, so every activity row
 * from work done inside an organization was written into the acting user's
 * PERSONAL bucket and was invisible to org admins and auditors — i.e. the
 * completeness this middleware exists to provide was absent exactly where an
 * auditor would look for it. Nothing failed; the rows simply went to the wrong
 * tenant.
 *
 * These tests assert the destination, not just that a row was written.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const recorded = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[] }));

vi.mock("../../../lib/audit", () => ({
	recordAuditFromRequest: (_ctx: unknown, input: Record<string, unknown>) => {
		recorded.calls.push(input);
	},
}));

// The dedup flag is irrelevant here; force "no curated row written" so capture
// always proceeds and the tenant assertion is what decides each test.
vi.mock("../audit-timing-middleware", () => ({
	hasCuratedAuditWritten: () => false,
}));

import { auditActivityMiddleware } from "../audit-activity-middleware";

/** Drive the middleware the way oRPC does: options object, then input. */
async function runMiddleware(args: {
	path: string[];
	input?: unknown;
	activeOrganizationId?: string | null;
	method?: string;
	output?: unknown;
}) {
	const procedure = {
		"~orpc": { route: { method: args.method ?? "POST" } },
	};
	const context = {
		headers: new Headers(),
		user: { id: "user_1", email: "u@example.com", name: "U" },
		session: {
			id: "sess_1",
			activeOrganizationId: args.activeOrganizationId ?? null,
		},
	};
	// biome-ignore lint/suspicious/noExplicitAny: driving the middleware directly
	await (auditActivityMiddleware as any)(
		{
			context,
			path: args.path,
			procedure,
			next: async () => ({
				output: args.output ?? { id: "res_1" },
				context,
			}),
		},
		args.input,
	);
	return recorded.calls;
}

beforeEach(() => {
	recorded.calls.length = 0;
	delete process.env.FABRIC_AUDIT_ACTIVITY_CAPTURE_DISABLED;
	delete process.env.FABRIC_AUDIT_ACTIVITY_CAPTURE_SKIP_PATHS;
});

describe("activity row tenant resolution", () => {
	it("writes the session's active organization onto the row", async () => {
		// The regression: this used to be undefined, so the row landed in the
		// actor's personal bucket and never appeared in the org's audit log.
		const calls = await runMiddleware({
			path: ["projects", "create"],
			activeOrganizationId: "org_abc",
		});
		expect(calls).toHaveLength(1);
		expect(calls[0].organizationId).toBe("org_abc");
	});

	it("writes null for a genuinely personal-context call", async () => {
		const calls = await runMiddleware({
			path: ["projects", "create"],
			activeOrganizationId: null,
		});
		expect(calls[0].organizationId).toBeNull();
	});

	it("lets an explicit organizationId on the input win over the session", async () => {
		// Mirrors the error middleware's rule: a procedure that names its tenant
		// explicitly is authoritative, including when it names personal context.
		const calls = await runMiddleware({
			path: ["projects", "stories", "update"],
			activeOrganizationId: "org_from_session",
			input: { organizationId: "org_from_input" },
		});
		expect(calls[0].organizationId).toBe("org_from_input");
	});

	it("honours an explicit null on the input as personal context", async () => {
		const calls = await runMiddleware({
			path: ["projects", "stories", "update"],
			activeOrganizationId: "org_from_session",
			input: { organizationId: null },
		});
		expect(calls[0].organizationId).toBeNull();
	});

	it("carries projectId through when the input names one", async () => {
		const calls = await runMiddleware({
			path: ["projects", "stories", "update"],
			activeOrganizationId: "org_abc",
			input: { projectId: "proj_1" },
		});
		expect(calls[0].projectId).toBe("proj_1");
	});

	it("records the derived action and procedure path", async () => {
		const calls = await runMiddleware({
			path: ["projects", "create"],
			activeOrganizationId: "org_abc",
		});
		expect(calls[0].action).toBe("activity.projects.create");
		expect(calls[0].category).toBe("activity");
		expect(calls[0].outcome).toBe("success");
	});

	it("writes nothing for a GET", async () => {
		const calls = await runMiddleware({
			path: ["projects", "list"],
			method: "GET",
			activeOrganizationId: "org_abc",
		});
		expect(calls).toHaveLength(0);
	});

	it("writes nothing for an unauthenticated call", async () => {
		const procedure = { "~orpc": { route: { method: "POST" } } };
		const context = { headers: new Headers() };
		// biome-ignore lint/suspicious/noExplicitAny: driving the middleware directly
		await (auditActivityMiddleware as any)(
			{
				context,
				path: ["contact", "submit"],
				procedure,
				next: async () => ({ output: {}, context }),
			},
			{},
		);
		expect(recorded.calls).toHaveLength(0);
	});

	it("returns the handler's original output untouched", async () => {
		const procedure = { "~orpc": { route: { method: "POST" } } };
		const context = {
			headers: new Headers(),
			user: { id: "user_1", email: "u@example.com", name: "U" },
			session: { id: "s", activeOrganizationId: "org_abc" },
		};
		const original = { output: { id: "res_9", extra: true }, context };
		// biome-ignore lint/suspicious/noExplicitAny: driving the middleware directly
		const result = await (auditActivityMiddleware as any)(
			{
				context,
				path: ["projects", "create"],
				procedure,
				next: async () => original,
			},
			{},
		);
		expect(result).toBe(original);
	});
});
