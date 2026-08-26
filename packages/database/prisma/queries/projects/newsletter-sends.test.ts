import { describe, expect, it } from "vitest";
import {
	buildMemberSendsListArgs,
	buildPublicArchiveListArgs,
	buildSendsListArgs,
} from "./newsletter";

// The admin-UI projection consumed by ProjectNewsletterSettings.tsx. Asserted in
// one place so the leak-regression (Codex §5) and the default/filter tests stay
// in sync — none of the five internal fields may appear here.
const ADMIN_SELECT = {
	id: true,
	status: true,
	skipReason: true,
	createdAt: true,
	trigger: true,
	sentCount: true,
	recipientCount: true,
	failedCount: true,
	// The project's own Distribution setting — the history row uses it to
	// decide whether a chat detail panel exists at all (Fizzy #2013). Not one
	// of the internal fields the leak guard below forbids.
	deliveryDestination: true,
	// The project's own Approval setting — the badge needs it to tell "being
	// curated for review" apart from "being sent" (Fizzy #2172). Like
	// deliveryDestination above, not one of the internal fields the leak guard
	// below forbids.
	requireApproval: true,
} as const;

describe("buildSendsListArgs", () => {
	it("defaults to 15 rows, offset 0, deterministic order, no status filter", () => {
		expect(buildSendsListArgs("p1", {})).toEqual({
			where: { projectId: "p1" },
			select: ADMIN_SELECT,
			orderBy: [{ createdAt: "desc" }, { id: "desc" }],
			take: 15,
			skip: 0,
		});
	});

	it("maps the sent filter to SENT and PARTIAL", () => {
		expect(
			buildSendsListArgs("p1", {
				status: "sent",
				limit: 50,
				offset: 100,
			}),
		).toEqual({
			where: { projectId: "p1", status: { in: ["SENT", "PARTIAL"] } },
			select: ADMIN_SELECT,
			orderBy: [{ createdAt: "desc" }, { id: "desc" }],
			take: 50,
			skip: 100,
		});
	});

	it("ignores the all filter (no status clause)", () => {
		expect(buildSendsListArgs("p1", { status: "all" }).where).toEqual({
			projectId: "p1",
		});
	});
});

describe("buildSendsListArgs — member-safe projection (Codex §5)", () => {
	it("selects only admin-UI fields, never internal ones", () => {
		const args = buildSendsListArgs("p1", {}) as {
			select: Record<string, true>;
		};
		expect(args.select).toEqual({
			id: true,
			status: true,
			skipReason: true,
			createdAt: true,
			trigger: true,
			sentCount: true,
			recipientCount: true,
			failedCount: true,
			deliveryDestination: true,
			requireApproval: true,
		});
		for (const f of [
			"aiUsageTokens",
			"temporalWorkflowId",
			"triggeredByUserId",
			"errorMessage",
			"dedupeKey",
			"content",
		]) {
			expect(args.select).not.toHaveProperty(f);
		}
	});

	it("carries requireApproval so the badge can tell curating apart from sending", () => {
		const args = buildSendsListArgs("p1", {});
		expect(args.select).toHaveProperty("requireApproval", true);
	});
});

describe("buildMemberSendsListArgs", () => {
	it("filters to SENT/PARTIAL/PENDING, projects safe fields, orders newest-first", () => {
		const args = buildMemberSendsListArgs("p1", {
			limit: 15,
			offset: 30,
		}) as unknown as {
			where: { projectId: string; status: { in: string[] } };
			select: Record<string, true>;
			orderBy: Array<Record<string, string>>;
			take: number;
			skip: number;
		};
		expect(args.where).toEqual({
			projectId: "p1",
			status: { in: ["SENT", "PARTIAL", "PENDING"] },
		});
		expect(args.select).toEqual({
			id: true,
			status: true,
			createdAt: true,
			content: true,
		});
		expect(args.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
		expect(args.take).toBe(15);
		expect(args.skip).toBe(30);
	});

	it("never projects internal fields", () => {
		const args = buildMemberSendsListArgs("p1", {}) as {
			select: Record<string, true>;
		};
		for (const f of [
			"aiUsageTokens",
			"temporalWorkflowId",
			"triggeredByUserId",
			"errorMessage",
			"dedupeKey",
			"skipReason",
		]) {
			expect(args.select).not.toHaveProperty(f);
		}
	});

	it("applies defaults limit 15 / offset 0", () => {
		const args = buildMemberSendsListArgs("p1", {}) as {
			take: number;
			skip: number;
		};
		expect(args.take).toBe(15);
		expect(args.skip).toBe(0);
	});
});

describe("buildPublicArchiveListArgs", () => {
	it("filters to SENT/PARTIAL only, safe projection, newest-first", () => {
		const a = buildPublicArchiveListArgs("p1", {
			limit: 50,
			offset: 100,
		}) as unknown as {
			where: { projectId: string; status: { in: string[] } };
			select: Record<string, true>;
			orderBy: Array<Record<string, string>>;
			take: number;
			skip: number;
		};
		expect(a.where).toEqual({
			projectId: "p1",
			status: { in: ["SENT", "PARTIAL"] },
		});
		expect(a.where.status.in).not.toContain("PENDING");
		expect(a.select).toEqual({
			id: true,
			status: true,
			createdAt: true,
			content: true,
		});
		for (const f of [
			"aiUsageTokens",
			"temporalWorkflowId",
			"triggeredByUserId",
			"errorMessage",
			"dedupeKey",
		]) {
			expect(a.select).not.toHaveProperty(f);
		}
		expect(a.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
		expect(a.take).toBe(50);
		expect(a.skip).toBe(100);
	});
});
