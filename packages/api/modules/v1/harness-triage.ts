import { ORPCError } from "@orpc/server";
import { db } from "@repo/database";
import type { Hono } from "hono";
import { z } from "zod";
import {
	type ExternalApiVariables,
	isOrganizationBoundKey,
} from "../external-api/types";
import {
	authorizeTriage,
	privateTriageCommands,
	requireTriageScopes,
	type TriageActor,
} from "../projects/lib/harness-triage-commands";
import {
	triageCredentialFromFacts,
	triageListInput,
	triageReviewInput,
	triageRunInput,
	triageStartInput,
} from "../projects/lib/harness-triage-contracts";
import { ok } from "./helpers";

const root = "/projects/:projectId/delivery/triage";
const routes = [
	{ op: "list", method: "GET", suffix: "", input: triageListInput },
	{ op: "start", method: "POST", suffix: "", input: triageStartInput },
	{ op: "status", method: "GET", suffix: "/:runId", input: triageRunInput },
	{
		op: "result",
		method: "GET",
		suffix: "/:runId/result",
		input: triageRunInput,
	},
	{
		op: "cancel",
		method: "POST",
		suffix: "/:runId/cancel",
		input: triageRunInput,
	},
	{
		op: "review",
		method: "POST",
		suffix: "/:runId/review",
		input: triageReviewInput,
	},
] as const;
export function registerHarnessTriageRoutes(
	app: Hono<{ Variables: ExternalApiVariables }>,
) {
	for (const route of routes) {
		app.on(route.method, root + route.suffix, async (c) => {
			c.header("Cache-Control", "private, no-store");
			try {
				const key = c.get("externalApiContext");
				const actor: TriageActor = {
					userId: key.userId,
					boundProjectId: key.boundProjectId,
					...(isOrganizationBoundKey(key)
						? {
								organizationBinding: {
									organizationId: key.organizationId,
								},
							}
						: {}),
					credential: triageCredentialFromFacts(
						key.keyType === "personal"
							? "USER_API_KEY"
							: key.keyType === "organization"
								? "ORGANIZATION_API_KEY"
								: "OAUTH_CLIENT",
						key.keyId,
						key.scopes,
						key.organizationId,
						key.boundProjectId,
						"api",
					),
				};
				requireTriageScopes(actor.credential, route.op);
				const query = (
					route.op === "list"
						? z.strictObject({
								org: z.string().min(1).max(200).optional(),
								before: z.string().max(2048).optional(),
							})
						: z.strictObject({
								org: z.string().min(1).max(200).optional(),
							})
				).parse(c.req.query());
				const body =
					route.method === "POST"
						? z
								.record(z.string(), z.unknown())
								.parse(JSON.parse((await c.req.text()) || "{}"))
						: {};
				if (
					[
						"projectId",
						"runId",
						"organizationId",
						"actorId",
						"credential",
					].some((k) => k in body)
				) {
					throw new ORPCError("BAD_REQUEST", {
						message:
							"Path and identity fields cannot be overridden.",
					});
				}
				const projectId = c.req.param("projectId") ?? "";
				const runId = c.req.param("runId");
				const input = route.input.parse({
					...body,
					projectId,
					...(runId ? { runId } : {}),
					...("before" in query ? { before: query.before } : {}),
				});
				if (query.org) {
					const scope = await authorizeTriage(
						actor,
						projectId,
						route.op,
					);
					if (
						!(await db.organization.findFirst({
							where: {
								id: scope.organizationId,
								slug: query.org,
							},
							select: { id: true },
						}))
					) {
						throw new ORPCError("NOT_FOUND");
					}
				}
				return c.json(
					ok(await privateTriageCommands[route.op](actor, input)),
				);
			} catch (error) {
				if (
					error instanceof z.ZodError ||
					error instanceof SyntaxError
				) {
					return c.json(
						{
							error: {
								code: "INVALID_INPUT",
								message: "Invalid private triage request.",
							},
						},
						400,
					);
				}
				if (error instanceof ORPCError) {
					return c.json(
						{
							error: {
								code:
									(
										error.data as
											| { code?: string }
											| undefined
									)?.code ?? error.code,
								message: error.message,
							},
						},
						error.status as 400,
					);
				}
				return c.json(
					{
						error: {
							code: "TRIAGE_UNAVAILABLE",
							message:
								"Private signal review is temporarily unavailable.",
						},
					},
					503,
				);
			}
		});
	}
}
