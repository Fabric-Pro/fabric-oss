import {
	configureSchema,
	RunQualityError,
} from "@repo/utils/run-quality-contracts";
import { Hono } from "hono";
import { beforeEach, expect, it, vi } from "vitest";
import type { ExternalApiVariables } from "../../external-api/types";

const m = vi.hoisted(() => ({
	policy: vi.fn(),
	configure: vi.fn(),
	list: vi.fn(),
	get: vi.fn(),
	cancel: vi.fn(),
	compare: vi.fn(),
	resolve: vi.fn(),
	scope: vi.fn(),
	scopes: ["agents:read", "agents:write"] as string[],
	live: true,
	boundProjectId: undefined as string | undefined,
}));
vi.mock("../../run-quality/lib/commands", () => ({
	getRunQualityPolicy: m.policy,
	configureRunQualityPolicy: m.configure,
	listRunQualityAssessments: m.list,
	getRunQualityAssessment: m.get,
	cancelRunQualityAssessment: m.cancel,
	compareRunQualityAssessments: m.compare,
}));
vi.mock("../helpers", () => ({
	ok: (data: unknown) => ({ data }),
	resolveV1Context: m.resolve,
}));
vi.mock("../../external-api/middleware/api-key-auth", () => ({
	requireScope:
		(scope: string) => async (c: any, next: () => Promise<void>) => {
			m.scope(scope);
			if (!m.live) {
				return c.json({ error: { code: "FORBIDDEN" } }, 403);
			}
			await next();
		},
}));

import { registerRunQualityRoutes } from "../run-quality";

const app = new Hono<{ Variables: ExternalApiVariables }>();
app.use("*", async (c, next) => {
	c.set("externalApiContext", {
		userId: "example-user",
		scopes: m.scopes,
		boundProjectId: m.boundProjectId,
	} as any);
	await next();
});
registerRunQualityRoutes(app);
const target = { targetType: "AGENT", targetId: "example-agent" };
beforeEach(() => {
	vi.clearAllMocks();
	m.scopes = ["agents:read", "agents:write"];
	m.live = true;
	m.boundProjectId = undefined;
	m.resolve.mockResolvedValue({
		userId: "example-user",
		organizationId: "example-org",
	});
	for (const command of [
		m.policy,
		m.configure,
		m.list,
		m.get,
		m.cancel,
		m.compare,
	]) {
		command.mockResolvedValue({ saved: true });
	}
});
const paths = [
	[
		"GET",
		"/run-quality/policy?targetType=AGENT&targetId=example-agent",
		undefined,
		"policy",
		target,
		false,
	],
	[
		"PUT",
		"/run-quality/policy",
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
		"configure",
		undefined,
		true,
	],
	[
		"GET",
		"/run-quality/assessments?targetType=AGENT&targetId=example-agent",
		undefined,
		"list",
		{ ...target, limit: 20, offset: 0 },
		false,
	],
	[
		"GET",
		"/run-quality/assessments/example-check?targetType=AGENT&targetId=example-agent",
		undefined,
		"get",
		{ ...target, assessmentId: "example-check" },
		false,
	],
	[
		"POST",
		"/run-quality/assessments/example-check/cancel",
		target,
		"cancel",
		{ ...target, assessmentId: "example-check" },
		true,
	],
	[
		"POST",
		"/run-quality/compare",
		{ ...target, leftId: "left", rightId: "right" },
		"compare",
		undefined,
		false,
	],
] as const;
it.each(paths)(
	"routes %s %s through scopes and canonical current actor",
	async (method, path, body, command, expected, write) => {
		const response = await app.request(path, {
			method,
			...(body
				? {
						headers: { "content-type": "application/json" },
						body: JSON.stringify(body),
					}
				: {}),
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
		expect(m[command]).toHaveBeenCalledWith(
			{ userId: "example-user", organizationId: "example-org" },
			expect.objectContaining(
				expected ??
					(command === "configure"
						? configureSchema.parse(body)
						: body) ??
					{},
			),
			expect.any(Function),
		);
		expect(m.scope.mock.calls.map((call) => call[0])).toEqual(
			write ? ["agents:read", "agents:write"] : ["agents:read"],
		);
	},
);
it("distinguishes missing scopes and revoked current permission even for wildcard keys", async () => {
	m.scopes = ["agents:read"];
	let response = await app.request(
		"/run-quality/assessments/example-check/cancel",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(target),
		},
	);
	expect(response.status).toBe(403);
	expect(await response.json()).toMatchObject({
		error: { code: "INSUFFICIENT_SCOPE" },
	});
	expect(m.cancel).not.toHaveBeenCalled();
	m.scopes = ["*"];
	m.live = false;
	response = await app.request(
		"/run-quality/policy?targetType=AGENT&targetId=example-agent",
	);
	expect(response.status).toBe(403);
	expect(m.scope).toHaveBeenCalledWith("agents:read");
	expect(m.policy).not.toHaveBeenCalled();
});
it("does not let an agent-scoped key access workflow quality", async () => {
	const response = await app.request(
		"/run-quality/policy?targetType=WORKFLOW&targetId=example-flow",
	);
	expect(response.status).toBe(403);
	expect(m.policy).not.toHaveBeenCalled();
});
it("rejects actor overrides and mismatched request identities before dispatch", async () => {
	const response = await app.request("/run-quality/compare", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			...target,
			leftId: "left",
			rightId: "right",
			userId: "different",
		}),
	});
	expect(response.status).toBe(400);
	expect(m.compare).not.toHaveBeenCalled();
});
it("withholds revoked source results and rejects unavailable organization context", async () => {
	m.get.mockRejectedValue(
		new RunQualityError("FORBIDDEN", "Source access changed."),
	);
	let response = await app.request(
		"/run-quality/assessments/example-check?targetType=AGENT&targetId=example-agent",
	);
	expect(response.status).toBe(403);
	m.resolve.mockResolvedValue({
		error: "Organization required",
		status: 403,
	});
	response = await app.request(
		"/run-quality/policy?targetType=AGENT&targetId=example-agent",
	);
	expect(response.status).toBe(403);
	expect(m.policy).not.toHaveBeenCalled();
});

it("requires source scopes independently of domain permission before releasing recorded grades", async () => {
	m.get.mockImplementation(async (_actor, _input, policy) => {
		await policy({ workspaceIds: ["example-private"], skillIds: [] });
		return { report: { passed: 1 } };
	});
	const response = await app.request(
		"/run-quality/assessments/example-check?targetType=AGENT&targetId=example-agent",
	);
	expect(response.status).toBe(403);
	expect(await response.json()).toMatchObject({
		error: { code: "INSUFFICIENT_SCOPE" },
	});
	m.scopes.push("workspaces:read");
	expect(
		(
			await app.request(
				"/run-quality/assessments/example-check?targetType=AGENT&targetId=example-agent",
			)
		).status,
	).toBe(200);
});

it.each(paths)(
	"refuses bound-project credentials before %s %s reaches tenant or command",
	async (method, path, body) => {
		m.boundProjectId = "example-project";
		m.scopes = ["*"];
		const response = await app.request(path, {
			method,
			...(body
				? {
						headers: { "content-type": "application/json" },
						body: JSON.stringify(body),
					}
				: {}),
		});
		expect(response.status).toBe(403);
		expect((await response.json()).error.code).toBe("FORBIDDEN");
		expect(m.resolve).not.toHaveBeenCalled();
		for (const command of [
			m.policy,
			m.configure,
			m.list,
			m.get,
			m.cancel,
			m.compare,
		])
			expect(command).not.toHaveBeenCalled();
	},
);
