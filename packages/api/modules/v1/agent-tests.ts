import { ORPCError } from "@orpc/server";
import {
	AGENT_TEST_MAX_BYTES,
	type AgentTestActor,
	AgentTestError,
	agentTestCaseArchiveSchema,
	agentTestCaseCreateSchema,
	agentTestCaseListSchema,
	agentTestCaseUpdateSchema,
	agentTestCompareSchema,
	agentTestErrorDataSchema,
	agentTestRunListSchema,
	agentTestRunStartSchema,
} from "@repo/temporal/agent-test-contracts";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { RecordAuditFromRequestInput } from "../../lib/audit";
import { recordAuditFromRequest } from "../../lib/audit";
import {
	type AgentPreviewSelectionPolicy,
	agentPreviewSelectionScopePolicy,
} from "../agents/lib/agent-preview-selection-policy";
import {
	archiveAgentTestCaseCommand,
	cancelAgentTestRunCommand,
	compareAgentTestRunsCommand,
	createAgentTestCaseCommand,
	getAgentTestRunCommand,
	listAgentTestCasesCommand,
	listAgentTestRunsCommand,
	startAgentTestRunCommand,
	updateAgentTestCaseCommand,
} from "../agents/lib/agent-test-commands";
import { requireScope } from "../external-api/middleware/api-key-auth";
import type { ExternalApiVariables } from "../external-api/types";
import { ok, resolveV1Context } from "./helpers";

type Env = { Variables: ExternalApiVariables };
type Audit = (event: RecordAuditFromRequestInput) => unknown;
export function registerAgentTestRoutes(app: Hono<Env>) {
	async function invoke(
		c: Context<Env>,
		command: (
			actor: AgentTestActor,
			audit: Audit,
			policy: AgentPreviewSelectionPolicy,
		) => Promise<unknown>,
	) {
		c.header("Cache-Control", "private, no-store");
		const api = c.get("externalApiContext");
		const resolved = await resolveV1Context(api, c.req.query("org"));
		if ("error" in resolved) {
			return c.json(
				{
					error: {
						code: "ORGANIZATION_REQUIRED",
						message: resolved.error,
					},
				},
				resolved.status,
			);
		}
		if (!resolved.organizationId) {
			return c.json(
				{
					error: {
						code: "ORGANIZATION_REQUIRED",
						message: "An organization is required.",
					},
				},
				403,
			);
		}
		try {
			return c.json(
				ok(
					await command(
						{
							userId: resolved.userId,
							organizationId: resolved.organizationId,
							external: true,
						},
						(event) =>
							recordAuditFromRequest(
								{ headers: c.req.raw.headers },
								{
									...event,
									actor: {
										type:
											api.keyType === "oauth"
												? "agent"
												: "api_key",
										userId: api.userId,
									},
								},
							),
						agentPreviewSelectionScopePolicy(api.scopes),
					),
				),
			);
		} catch (error) {
			if (error instanceof z.ZodError || error instanceof SyntaxError) {
				return c.json(
					{
						error: {
							code: "BAD_REQUEST",
							message: "Use the declared agent-test schema.",
						},
					},
					400,
				);
			}
			if (error instanceof AgentTestError || error instanceof ORPCError) {
				const admissionData =
					error instanceof AgentTestError
						? agentTestErrorDataSchema.safeParse(error.data)
						: undefined;
				const insufficient =
					error instanceof ORPCError &&
					error.data &&
					typeof error.data === "object" &&
					"code" in error.data &&
					error.data.code === "INSUFFICIENT_SCOPE";
				const status =
					error.code === "FORBIDDEN"
						? 403
						: error.code === "NOT_FOUND"
							? 404
							: error.code === "CONFLICT"
								? 409
								: error.code === "SERVICE_UNAVAILABLE"
									? 503
									: 400;
				return c.json(
					{
						error: {
							code: insufficient
								? "INSUFFICIENT_SCOPE"
								: error.code,
							message: error.message,
							...(admissionData?.success
								? { data: admissionData.data }
								: {}),
						},
					},
					status,
				);
			}
			throw error;
		}
	}
	const paging = (c: Context<Env>) => ({
		limit:
			c.req.query("limit") === undefined
				? undefined
				: Number(c.req.query("limit")),
		cursor: c.req.query("cursor"),
	});
	app.get("/agent-tests/cases", requireScope("agents:read"), (c) =>
		invoke(c, (actor, _audit, policy) =>
			listAgentTestCasesCommand(
				actor,
				agentTestCaseListSchema.parse({
					instanceId: c.req.query("instanceId"),
					...paging(c),
				}),
				policy,
			),
		),
	);
	app.post(
		"/agent-tests/cases",
		requireScope("agents:execute"),
		bodyLimit({ maxSize: AGENT_TEST_MAX_BYTES }),
		async (c) =>
			invoke(c, async (actor, audit, policy) =>
				createAgentTestCaseCommand(
					actor,
					agentTestCaseCreateSchema.parse(
						await c.req.json().catch(() => null),
					),
					audit,
					policy,
				),
			),
	);
	app.patch(
		"/agent-tests/cases/:caseId",
		requireScope("agents:execute"),
		bodyLimit({ maxSize: AGENT_TEST_MAX_BYTES }),
		async (c) =>
			invoke(c, async (actor, audit, policy) => {
				const body = agentTestCaseUpdateSchema
					.omit({ caseId: true })
					.parse(await c.req.json().catch(() => null));
				return updateAgentTestCaseCommand(
					actor,
					{ ...body, caseId: c.req.param("caseId") },
					audit,
					policy,
				);
			}),
	);
	app.delete(
		"/agent-tests/cases/:caseId",
		requireScope("agents:execute"),
		bodyLimit({ maxSize: 1024 }),
		async (c) =>
			invoke(c, async (actor, audit, policy) => {
				const text = await c.req.text();
				if (text.trim()) {
					z.strictObject({}).parse(JSON.parse(text));
				}
				return archiveAgentTestCaseCommand(
					actor,
					agentTestCaseArchiveSchema.parse({
						caseId: c.req.param("caseId"),
						revision: Number(c.req.query("revision")),
					}),
					audit,
					policy,
				);
			}),
	);
	app.post(
		"/agent-tests/runs",
		requireScope("agents:execute"),
		bodyLimit({ maxSize: AGENT_TEST_MAX_BYTES }),
		async (c) =>
			invoke(c, async (actor, audit, policy) =>
				startAgentTestRunCommand(
					actor,
					agentTestRunStartSchema.parse(
						await c.req.json().catch(() => null),
					),
					audit,
					policy,
				),
			),
	);
	app.get("/agent-tests/runs", requireScope("agents:read"), (c) =>
		invoke(c, (actor, _audit, policy) =>
			listAgentTestRunsCommand(
				actor,
				agentTestRunListSchema.parse({
					caseId: c.req.query("caseId"),
					...paging(c),
				}),
				policy,
			),
		),
	);
	app.get("/agent-tests/runs/:testRunId", requireScope("agents:read"), (c) =>
		invoke(c, (actor, _audit, policy) =>
			getAgentTestRunCommand(
				actor,
				{ testRunId: c.req.param("testRunId") },
				policy,
			),
		),
	);
	app.post(
		"/agent-tests/runs/:testRunId/cancel",
		requireScope("agents:execute"),
		bodyLimit({ maxSize: 1024 }),
		async (c) =>
			invoke(c, async (actor, audit, policy) => {
				const text = await c.req.text();
				if (text.trim()) {
					z.strictObject({}).parse(JSON.parse(text));
				}
				return cancelAgentTestRunCommand(
					actor,
					{ testRunId: c.req.param("testRunId") },
					audit,
					policy,
				);
			}),
	);
	app.post(
		"/agent-tests/compare",
		requireScope("agents:read"),
		bodyLimit({ maxSize: 1024 }),
		async (c) =>
			invoke(c, async (actor, _audit, policy) =>
				compareAgentTestRunsCommand(
					actor,
					agentTestCompareSchema.parse(
						await c.req.json().catch(() => null),
					),
					policy,
				),
			),
	);
}
