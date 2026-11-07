import { ORPCError } from "@orpc/server";
import { db } from "@repo/database";
import type { Hono } from "hono";
import { ZodError, z } from "zod";
import {
	type ExternalApiVariables,
	isOrganizationBoundKey,
} from "../external-api/types";
import { getDeliverySignalSourceConfiguration } from "../projects/lib/delivery-signal-sources";
import {
	deliverySignalErrorCode,
	deliverySignalNotFound,
	getDeliverySignal,
	listDeliverySignals,
	requireDeliverySignalProjectAccess,
	requireDeliverySignalScopes,
} from "../projects/lib/delivery-signals";
import { ok } from "./helpers";

const querySchema = z.strictObject({
	org: z.string().trim().min(1).max(200).optional(),
	source: z.string().optional(),
	search: z.string().optional(),
	limit: z.string().regex(/^\d+$/).optional(),
	cursor: z.string().optional(),
});
export function registerDeliverySignalRoutes(
	app: Hono<{ Variables: ExternalApiVariables }>,
) {
	for (const operation of ["list", "get", "sources"] as const) {
		const path =
			operation === "sources"
				? "/projects/:projectId/delivery/sources"
				: `/projects/:projectId/delivery/signals${operation === "get" ? "/:id" : ""}`;
		app.get(path, async (c) => {
			c.header("Cache-Control", "private, no-store");
			try {
				const credential = c.get("externalApiContext");
				requireDeliverySignalScopes(
					credential.scopes,
					operation === "sources",
				);
				const query = querySchema.parse(c.req.query());
				if (
					operation !== "list" &&
					(query.source !== undefined ||
						query.search !== undefined ||
						query.limit !== undefined ||
						query.cursor !== undefined)
				) {
					throw new ORPCError("BAD_REQUEST", {
						message: "Invalid project history request.",
					});
				}
				const projectId = c.req.param("projectId") ?? "";
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
				// Use the same opaque visibility/tenant guard as every other
				// transport before interpreting a caller's optional org selector.
				const access = await requireDeliverySignalProjectAccess(
					actor,
					projectId,
				);
				if (query.org) {
					const named = await db.organization.findFirst({
						where: { id: access.organizationId, slug: query.org },
						select: { id: true },
					});
					if (!named) {
						deliverySignalNotFound();
					}
				}
				const result =
					operation === "sources"
						? await getDeliverySignalSourceConfiguration(actor, {
								projectId,
							})
						: operation === "get"
							? await getDeliverySignal(actor, {
									projectId,
									id: c.req.param("id"),
								})
							: await listDeliverySignals(actor, {
									projectId,
									...(query.source !== undefined
										? { source: query.source }
										: {}),
									...(query.search !== undefined
										? { search: query.search }
										: {}),
									...(query.limit !== undefined
										? { limit: Number(query.limit) }
										: {}),
									...(query.cursor !== undefined
										? { cursor: query.cursor }
										: {}),
								});
				return c.json(ok(result));
			} catch (error) {
				if (error instanceof ZodError) {
					return c.json(
						{
							error: {
								code: "BAD_REQUEST",
								message: "Invalid project history request.",
							},
						},
						400,
					);
				}
				if (error instanceof ORPCError) {
					const status =
						error.code === "FORBIDDEN"
							? 403
							: error.code === "NOT_FOUND"
								? 404
								: error.code === "UNAUTHORIZED"
									? 401
									: error.code === "BAD_REQUEST"
										? 400
										: error.code === "CONFLICT"
											? 409
											: 500;
					return c.json(
						{
							error: {
								code: deliverySignalErrorCode(error),
								message:
									status === 500
										? "Project history is temporarily unavailable."
										: error.message,
							},
						},
						status,
					);
				}
				throw error;
			}
		});
	}
}
