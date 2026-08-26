/**
 * Kanban Status Procedures
 *
 * oRPC procedures for checking kanban CLI connection status.
 */

import { z } from "zod";
import {
	Permissions,
	publicProcedure,
	requirePermission,
} from "../../../orpc/procedures";

/**
 * Check kanban connection status.
 * This is a public endpoint that the frontend can poll to check
 * if the local kanban CLI is running.
 */
export const getKanbanConnectionStatus = publicProcedure
	.use(requirePermission(Permissions.STORY_UPDATE))
	.route({
		method: "GET",
		path: "/kanban/status",
		tags: ["Kanban"],
		summary: "Check kanban CLI connection status",
	})
	.output(
		z.object({
			isRunning: z.boolean(),
			version: z.string().optional(),
			port: z.number().default(3484),
		}),
	)
	.handler(async () => {
		// The frontend will actually check this directly against localhost
		// This endpoint exists for consistency and potential proxy scenarios
		return {
			isRunning: false, // Frontend should check localhost:3484 directly
			port: 3484,
		};
	});

/**
 * Get kanban health check.
 * Used by the frontend to verify kanban is accessible.
 */
export const healthCheck = publicProcedure
	.use(requirePermission(Permissions.STORY_UPDATE))
	.route({
		method: "GET",
		path: "/kanban/health",
		tags: ["Kanban"],
		summary: "Health check endpoint for kanban integration",
	})
	.output(
		z.object({
			status: z.enum(["healthy", "unhealthy"]),
			timestamp: z.string(),
		}),
	)
	.handler(async () => {
		return {
			status: "healthy",
			timestamp: new Date().toISOString(),
		};
	});
