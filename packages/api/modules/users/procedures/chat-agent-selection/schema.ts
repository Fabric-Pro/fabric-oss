import { z } from "zod";

/**
 * Procedure-side mirror of `PersistedSelectedAgentSchema` from
 * `@repo/database/prisma/queries/chat-agent-selection`. Defined locally
 * with the api package's own zod version so it is assignable to oRPC's
 * `.input()` / `.output()` slots — the cross-package re-export trips
 * Zod's TS-internal `version.minor` mismatch when packages pin different
 * Zod 4.x patches.
 *
 * MUST stay in lockstep with the database export. Any change here MUST
 * be mirrored there (and vice versa). The shape is enforced at runtime
 * by the database-side schema when entries are read back; the local
 * schema only governs the wire boundary.
 */
export const ApiPersistedSelectedAgentSchema = z.object({
	agentId: z.string().min(1),
	name: z.string().min(1),
	vendor: z.string().optional(),
	modelOverride: z.string().optional(),
	instanceId: z.string().optional(),
	description: z.string().nullable().optional(),
	workspaceIds: z.array(z.string()).optional(),
	enabledMcpConfigIds: z.array(z.string()).nullable().optional(),
	enabledIntegrationIds: z.array(z.string()).optional(),
});
