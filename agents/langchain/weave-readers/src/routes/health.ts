/**
 * Health check route
 */

import { Hono } from "hono";

export const healthRoute = new Hono();

healthRoute.get("/", (c) => {
	return c.json({
		status: "healthy",
		service: "weave-readers",
		agents: ["thread", "spindle", "weft", "warp"],
		timestamp: new Date().toISOString(),
	});
});
