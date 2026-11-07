import { ORPCError } from "@orpc/server";
import { db } from "@repo/database";
import type { Hono } from "hono";
import { ZodError, z } from "zod";
import {
	type ExternalApiVariables,
	isOrganizationBoundKey,
} from "../external-api/types";
import { deliverySignalErrorCode } from "../projects/lib/delivery-signals";
import * as commands from "../projects/lib/delivery-source-commands";
import {
	type DeliverySourceOperation,
	deliverySourceCancelInput,
	deliverySourceCaptureInput,
	deliverySourceConfigureInput,
	deliverySourceEvidence,
	deliverySourceEvidenceInput,
	deliverySourceInspectInput,
	deliverySourceInspection,
	deliverySourceList,
	deliverySourceObservationInput,
	deliverySourceObservationPage,
	deliverySourceProjectInput,
	deliverySourceRequiredScopes,
	deliverySourceRun,
	deliverySourceStateInput,
	deliverySourceWatch,
	deliverySourceWatchInput,
} from "../projects/lib/delivery-source-contracts";
import { ok } from "./helpers";

const org = z.string().trim().min(1).max(200).optional();
const queryInput = z.strictObject({ org });
const observationQuery = queryInput.extend({
	cursor: z.string().max(2048).optional(),
	limit: z.string().regex(/^\d+$/).optional(),
});
const root = "/projects/:projectId/delivery/private-sources";
const routes = [
	{
		operation: "list",
		method: "GET",
		path: root,
		input: deliverySourceProjectInput,
		output: deliverySourceList,
		run: commands.listDeliverySourceWatches,
	},
	{
		operation: "inspect",
		method: "POST",
		path: `${root}/inspect`,
		input: deliverySourceInspectInput,
		output: deliverySourceInspection,
		run: commands.inspectDeliverySource,
	},
	{
		operation: "configure",
		method: "POST",
		path: root,
		input: deliverySourceConfigureInput,
		output: deliverySourceWatch,
		run: commands.configureDeliverySource,
	},
	{
		operation: "state",
		method: "POST",
		path: `${root}/:watchId/state`,
		input: deliverySourceStateInput,
		output: deliverySourceWatch,
		run: commands.updateDeliverySourceState,
	},
	{
		operation: "capture",
		method: "POST",
		path: `${root}/:watchId/capture`,
		input: deliverySourceCaptureInput,
		output: deliverySourceRun,
		run: commands.startDeliverySourceCapture,
	},
	{
		operation: "status",
		method: "GET",
		path: `${root}/:watchId/capture`,
		input: deliverySourceWatchInput,
		output: deliverySourceRun,
		run: commands.getDeliverySourceCaptureStatus,
	},
	{
		operation: "cancel",
		method: "POST",
		path: `${root}/:watchId/capture/cancel`,
		input: deliverySourceCancelInput,
		output: deliverySourceRun,
		run: commands.cancelDeliverySourceCapture,
	},
	{
		operation: "observations",
		method: "GET",
		path: `${root}/:watchId/observations`,
		input: deliverySourceObservationInput,
		output: deliverySourceObservationPage,
		run: commands.listDeliverySourceObservations,
	},
	{
		operation: "evidence",
		method: "GET",
		path: `${root}/:watchId/observations/:observationId`,
		input: deliverySourceEvidenceInput,
		output: deliverySourceEvidence,
		run: commands.getDeliverySourceEvidence,
	},
] as const;

/** Only canonical commands hold actor/object/owner/source authorization. */
export function registerDeliverySourceRoutes(
	app: Hono<{ Variables: ExternalApiVariables }>,
) {
	for (const route of routes) {
		app.on(route.method, route.path, async (c) => {
			c.header("Cache-Control", "private, no-store");
			try {
				const credential = c.get("externalApiContext");
				// State actions share the write ceiling; RESUME's network ceiling is checked after parsing.
				const operation: DeliverySourceOperation =
					route.operation === "state" ? "pause" : route.operation;
				const requireScopes = (operation: DeliverySourceOperation) => {
					if (
						!credential.scopes.includes("*") &&
						deliverySourceRequiredScopes(operation).some(
							(scope) => !credential.scopes.includes(scope),
						)
					) {
						throw new ORPCError("FORBIDDEN", {
							message: "Required source scopes are missing.",
							data: { code: "INSUFFICIENT_SCOPE" },
						});
					}
				};
				requireScopes(operation);
				const query = (
					route.operation === "observations"
						? observationQuery
						: queryInput
				).parse(c.req.query());
				const body: unknown =
					route.method === "POST" ? await c.req.json() : {};
				const projectId = c.req.param("projectId") ?? "";
				// Reject actor/tenant injection and path identity overrides rather than silently dropping them.
				const raw = z.record(z.string(), z.unknown()).parse(body);
				if (
					["projectId", "watchId", "observationId"].some(
						(key) => key in raw,
					)
				) {
					throw new ZodError([]);
				}
				const input = route.input.parse({
					...raw,
					projectId,
					...(c.req.param("watchId")
						? { watchId: c.req.param("watchId") }
						: {}),
					...(c.req.param("observationId")
						? { observationId: c.req.param("observationId") }
						: {}),
					...(route.operation === "observations"
						? {
								...("cursor" in query
									? { cursor: query.cursor }
									: {}),
								...("limit" in query &&
								query.limit !== undefined
									? { limit: Number(query.limit) }
									: {}),
							}
						: {}),
				});
				if (route.operation === "state" && "action" in input) {
					requireScopes(
						String(
							input.action,
						).toLowerCase() as DeliverySourceOperation,
					);
				}
				const actor = {
					userId: credential.userId,
					boundProjectId: credential.boundProjectId,
					...(isOrganizationBoundKey(credential)
						? {
								organizationBinding: {
									organizationId: credential.organizationId,
								},
							}
						: {}),
				};
				const access =
					await commands.requirePrivateDeliverySourceProject(
						actor,
						projectId,
						deliverySourceRequiredScopes(operation).includes(
							"projects:write",
						),
					);
				if (query.org) {
					const named = await db.organization.findFirst({
						where: { id: access.organizationId, slug: query.org },
						select: { id: true },
					});
					if (!named) {
						throw new ORPCError("NOT_FOUND", {
							message: "Project not found",
						});
					}
				}
				const result = await route.run(actor, input);
				return c.json(ok(route.output.parse(result)));
			} catch (error) {
				if (error instanceof ZodError || error instanceof SyntaxError) {
					return c.json(
						{
							error: {
								code: "BAD_REQUEST",
								message: "Invalid private source request.",
							},
						},
						400,
					);
				}
				if (error instanceof ORPCError) {
					const statuses = {
						UNAUTHORIZED: 401,
						FORBIDDEN: 403,
						NOT_FOUND: 404,
						BAD_REQUEST: 400,
						CONFLICT: 409,
						TOO_MANY_REQUESTS: 429,
						SERVICE_UNAVAILABLE: 503,
					} as const;
					const status =
						statuses[error.code as keyof typeof statuses] ?? 503;
					return c.json(
						{
							error: {
								code:
									status === 503 &&
									error.code !== "SERVICE_UNAVAILABLE"
										? "UNAVAILABLE"
										: deliverySignalErrorCode(error),
								message:
									status === 503
										? "Private sources are temporarily unavailable."
										: error.message,
							},
						},
						status,
					);
				}
				return c.json(
					{
						error: {
							code: "UNAVAILABLE",
							message:
								"Private sources are temporarily unavailable.",
						},
					},
					503,
				);
			}
		});
	}
}
