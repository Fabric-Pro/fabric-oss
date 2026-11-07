import { RunQualityError } from "@repo/utils/run-quality-contracts";
import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	policy: vi.fn(),
	configure: vi.fn(),
	list: vi.fn(),
	get: vi.fn(),
	cancel: vi.fn(),
	compare: vi.fn(),
}));
vi.mock("../lib/commands", () => ({
	getRunQualityPolicy: m.policy,
	configureRunQualityPolicy: m.configure,
	listRunQualityAssessments: m.list,
	getRunQualityAssessment: m.get,
	cancelRunQualityAssessment: m.cancel,
	compareRunQualityAssessments: m.compare,
}));
vi.mock("../../../orpc/procedures", () => ({
	tenantProtectedProcedure: {
		input: (schema: unknown) => ({
			handler: (handler: unknown) => ({ schema, handler }),
		}),
	},
	resolveOrganizationId: (
		input?: string,
		session?: { activeOrganizationId?: string },
	) => input ?? session?.activeOrganizationId,
}));

import { runQualityRouter } from "../router";

const router = runQualityRouter as unknown as Record<
	string,
	Record<
		string,
		{
			schema: { parse: (raw: unknown) => any };
			handler: (ctx: unknown) => Promise<unknown>;
		}
	>
>;
const target = { targetType: "AGENT", targetId: "example-agent" };
const context = {
	user: { id: "example-user" },
	session: { activeOrganizationId: "example-org" },
};
beforeEach(() => {
	vi.clearAllMocks();
	for (const fn of Object.values(m)) {
		fn.mockResolvedValue({ saved: true });
	}
});
it.each([
	["policy", "get", "policy", target],
	[
		"policy",
		"configure",
		"configure",
		{
			...target,
			expectedRevision: 2,
			enabled: true,
			rules: [
				{
					id: "check",
					name: "Delivery",
					required: true,
					checks: { requiredPhrases: ["Ready"] },
				},
			],
		},
	],
	["assessments", "list", "list", target],
	["assessments", "get", "get", { ...target, assessmentId: "example-check" }],
	[
		"assessments",
		"cancel",
		"cancel",
		{ ...target, assessmentId: "example-check" },
	],
	[
		"assessments",
		"compare",
		"compare",
		{ ...target, leftId: "left", rightId: "right" },
	],
] as const)(
	"delegates %s.%s through the same current actor command",
	async (section, operation, command, input) => {
		const procedure = router[section][operation];
		const parsed = procedure.schema.parse(input);
		await procedure.handler({
			input: parsed,
			context,
		});
		expect(m[command]).toHaveBeenCalledWith(
			{ userId: "example-user", organizationId: "example-org" },
			parsed,
		);
	},
);
it("rejects actor injection and missing organization before dispatch", async () => {
	expect(() =>
		router.policy.get.schema.parse({ ...target, userId: "different" }),
	).toThrow();
	await expect(
		router.policy.get.handler({
			input: target,
			context: { ...context, session: {} },
		}),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	expect(m.policy).not.toHaveBeenCalled();
});
it("preserves permission conflicts and translates unavailable state without leaking internals", async () => {
	m.get.mockRejectedValue(
		new RunQualityError("FORBIDDEN", "Source access changed."),
	);
	await expect(
		router.assessments.get.handler({
			input: { ...target, assessmentId: "example-check" },
			context,
		}),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	m.configure.mockRejectedValue(
		new RunQualityError("UNAVAILABLE", "Try again."),
	);
	await expect(
		router.policy.configure.handler({
			input: {
				...target,
				expectedRevision: 0,
				enabled: false,
				rules: [],
			},
			context,
		}),
	).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
});
