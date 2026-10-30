import { readFileSync } from "node:fs";
import { APIError } from "better-auth/api";
import ts from "typescript";
import { beforeEach, expect, it, vi } from "vitest";

const source = readFileSync(new URL("../../auth.ts", import.meta.url), "utf8");
const recordAudit = vi.fn();
const db = {
	user: { findUnique: vi.fn(async () => ({ email: "member@example.com" })) },
};
const syncSeatsAfterDeparture = vi.fn();
const revokeDepartingMemberAccess = vi.fn();
const logger = { error: vi.fn() };
const member = {
	userId: "example-member",
	organizationId: "example-org",
	role: "member",
};
function session(id = "example-admin") {
	return {
		user: { id, email: "dev@example.com", name: "Example" },
		session: { userId: id, impersonatedBy: "example-operator" },
	};
}
async function run(path: string, returned: unknown, current = session()) {
	const start = source.indexOf(
		'} else if (ctx.path === "/organization/remove-member")',
	);
	expect(start).toBeGreaterThanOrEqual(0);
	const end = source.indexOf(
		"\n\t\t}),\n\t\tbefore: createAuthMiddleware",
		start,
	);
	const block = source.slice(start + 2, end);
	const js = ts.transpile(`async function hook(ctx) { ${block} }`, {
		target: ts.ScriptTarget.ES2022,
	});
	const hook = new Function(
		"recordAudit",
		"db",
		"logger",
		"syncSeatsAfterDeparture",
		"revokeDepartingMemberAccess",
		`${js}; return hook;`,
	)(
		recordAudit,
		db,
		logger,
		syncSeatsAfterDeparture,
		revokeDepartingMemberAccess,
	);
	await hook({
		path,
		body: { organizationId: "example-org" },
		context: { returned, session: current },
	});
}
beforeEach(() => vi.clearAllMocks());
it("attributes an admin removal to the session user", async () => {
	await run("/organization/remove-member", { member });
	expect(recordAudit).toHaveBeenCalledTimes(1);
	expect(recordAudit).toHaveBeenCalledWith(
		expect.objectContaining({
			action: "org.member.removed",
			organizationId: "example-org",
			actor: expect.objectContaining({
				userId: "example-admin",
				emailSnapshot: "dev@example.com",
				nameSnapshot: "Example",
				impersonatedById: "example-operator",
			}),
			resource: {
				type: "user",
				id: member.userId,
				name: "member@example.com",
			},
			metadata: { previousRole: "member" },
		}),
	);
});
it("records self-removal (the in-app Leave button) as a departure", async () => {
	await run(
		"/organization/remove-member",
		{ member },
		session(member.userId),
	);
	expect(recordAudit.mock.calls[0][0].action).toBe("org.member.left");
	expect(recordAudit.mock.calls[0][0].actor.userId).toBe(member.userId);
	expect(recordAudit.mock.calls[0][0].resource.id).toBe(member.userId);
});
it("does not audit failed or missing removal responses", async () => {
	await run(
		"/organization/remove-member",
		new APIError("FORBIDDEN", { message: "Forbidden" }),
	);
	await run("/organization/remove-member", {});
	expect(recordAudit).not.toHaveBeenCalled();
});
it("audits a voluntary departure", async () => {
	await run("/organization/leave", { status: true }, session(member.userId));
	expect(recordAudit).toHaveBeenCalledTimes(1);
	expect(recordAudit).toHaveBeenCalledWith(
		expect.objectContaining({
			action: "org.member.left",
			organizationId: "example-org",
			actor: expect.objectContaining({ userId: member.userId }),
			resource: {
				type: "user",
				id: member.userId,
				name: "dev@example.com",
			},
		}),
	);
});
it("contains audit lookup failures after a committed removal", async () => {
	db.user.findUnique.mockRejectedValueOnce(new Error("unavailable"));
	await expect(
		run("/organization/remove-member", { member }),
	).resolves.toBeUndefined();
	expect(logger.error).toHaveBeenCalled();
});
it("does not record from the plugin hook", () => {
	const block = source.slice(
		source.indexOf("afterRemoveMember: async"),
		source.indexOf("openAPI()", source.indexOf("afterRemoveMember: async")),
	);
	expect(block).not.toContain("recordAudit");
	expect(block).not.toContain("db.user");
});

it("does not audit a failed leave", async () => {
	await run(
		"/organization/leave",
		new APIError("BAD_REQUEST", { message: "Cannot leave" }),
	);
	expect(recordAudit).not.toHaveBeenCalled();
	expect(revokeDepartingMemberAccess).not.toHaveBeenCalled();
});
it("contains synchronous audit failures on departure", async () => {
	recordAudit.mockImplementationOnce(() => {
		throw new Error("unavailable");
	});
	await expect(
		run("/organization/leave", { status: true }),
	).resolves.toBeUndefined();
	expect(logger.error).toHaveBeenCalled();
});
