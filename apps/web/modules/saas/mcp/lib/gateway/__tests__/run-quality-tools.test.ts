import {
	configureSchema,
	RunQualityError,
} from "@repo/utils/run-quality-contracts";
import { beforeEach, expect, it, vi } from "vitest";
import type { GatewaySession } from "../types";

const m = vi.hoisted(() => ({
	policy: vi.fn(),
	configure: vi.fn(),
	list: vi.fn(),
	get: vi.fn(),
	cancel: vi.fn(),
	compare: vi.fn(),
}));
vi.mock("@repo/api/modules/run-quality/lib/commands", () => ({
	getRunQualityPolicy: m.policy,
	configureRunQualityPolicy: m.configure,
	listRunQualityAssessments: m.list,
	getRunQualityAssessment: m.get,
	cancelRunQualityAssessment: m.cancel,
	compareRunQualityAssessments: m.compare,
}));

import { createRunQualityTools } from "../tools/run-quality-tools";

const family = createRunQualityTools();
const session = {
	userId: "example-user",
	organizationId: "example-org",
	credential: "organization-key",
	scopes: ["agents:read", "agents:write"],
} as unknown as GatewaySession;
const target = { targetType: "AGENT", targetId: "example-agent" };
beforeEach(() => {
	vi.clearAllMocks();
	for (const fn of Object.values(m)) {
		fn.mockResolvedValue({ saved: true });
	}
});
it("registers executable target-specific tools with honest read/write metadata and confirmation", () => {
	expect(family.definitions).toHaveLength(12);
	expect(family.handlers.size).toBe(12);
	expect(family.scopes.fabric_agent_quality_configure_policy.scope).toBe(
		"agents:write",
	);
	expect(family.scopes.fabric_workflow_quality_get_assessment.scope).toBe(
		"workflows:read",
	);
	expect(
		family.definitions.find(
			(tool) => tool.name === "fabric_agent_quality_configure_policy",
		)?.annotations?.readOnlyHint,
	).toBe(false);
});
it.each([
	["get_policy", "policy", target],
	[
		"configure_policy",
		"configure",
		{
			...target,
			expectedRevision: 0,
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
	["list_assessments", "list", target],
	["get_assessment", "get", { ...target, assessmentId: "example-check" }],
	[
		"cancel_assessment",
		"cancel",
		{ ...target, assessmentId: "example-check" },
	],
	[
		"compare_assessments",
		"compare",
		{ ...target, leftId: "left", rightId: "right" },
	],
] as const)(
	"dispatches %s with server-owned actor only",
	async (action, command, args) => {
		const result = await family.handlers.get(
			`fabric_agent_quality_${action}`,
		)?.(args, session);
		expect(result.isError).not.toBe(true);
		expect(m[command]).toHaveBeenCalledWith(
			{ userId: "example-user", organizationId: "example-org" },
			expect.objectContaining(
				command === "configure" ? configureSchema.parse(args) : args,
			),
			expect.any(Function),
		);
	},
);
it("rejects scope mismatch, target substitution and project/service authority", async () => {
	const run = family.handlers.get("fabric_agent_quality_get_policy")!;
	for (const current of [
		{ ...session, scopes: ["workflows:read"] },
		{ ...session, projectId: "example-project" },
		{ ...session, credential: "service" },
	]) {
		expect((await run(target, current as GatewaySession)).isError).toBe(
			true,
		);
	}
	expect(
		(await run({ ...target, targetType: "WORKFLOW" }, session)).isError,
	).toBe(true);
	expect(
		(await run({ ...target, userId: "different" }, session)).isError,
	).toBe(true);
	expect(m.policy).not.toHaveBeenCalled();
});
it("never treats wildcard scope as permission and withholds revoked source reports", async () => {
	m.get.mockRejectedValue(
		new RunQualityError("FORBIDDEN", "Source access changed."),
	);
	const result = await family.handlers.get(
		"fabric_agent_quality_get_assessment",
	)?.(
		{ ...target, assessmentId: "example-check" },
		{ ...session, scopes: ["*"] },
	);
	expect(result.isError).toBe(true);
	expect(m.get).toHaveBeenCalledTimes(1);
	expect(JSON.stringify(result)).not.toContain('"saved":true');
});

it("uses the same exact scope ceiling for discovery and invocation", async () => {
	const { scopeSatisfied } = await import("../tool-scope");
	const read = family.scopes.fabric_agent_quality_get_policy;
	const write = family.scopes.fabric_agent_quality_configure_policy;
	expect(
		scopeSatisfied(["mcp:read", "mcp:write"], read, "organization-key"),
	).toBe(false);
	expect(scopeSatisfied(["agents:write"], write, "organization-key")).toBe(
		false,
	);
	expect(
		scopeSatisfied(
			["agents:read", "agents:write"],
			write,
			"organization-key",
		),
	).toBe(true);
	expect(scopeSatisfied(["*"], write, "organization-key")).toBe(true);
});

it("subtracts unconsented source reads even when the caller can read the agent", async () => {
	m.get.mockImplementation(async (_actor, _input, policy) => {
		await policy({ workspaceIds: ["example-private"], skillIds: [] });
		return { passed: 1 };
	});
	const run = family.handlers.get("fabric_agent_quality_get_assessment")!;
	const result = await run(
		{ ...target, assessmentId: "example-check" },
		session,
	);
	expect(result.isError).toBe(true);
	expect(JSON.stringify(result)).toContain("INSUFFICIENT_SCOPE");
	expect(
		(
			await run(
				{ ...target, assessmentId: "example-check" },
				{ ...session, scopes: [...session.scopes, "workspaces:read"] },
			)
		).isError,
	).not.toBe(true);
});
