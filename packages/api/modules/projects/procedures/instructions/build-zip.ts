/**
 * The archive builder itself now lives in `@repo/instructions/export`.
 *
 * It moved because publishing a snapshot pre-builds its archive
 * (`warmInstructionSnapshotExport`), and a snapshot can be published from a
 * Temporal activity as well as from these procedures — a Temporal worker
 * cannot import `@repo/api`. This file stays as a re-export so the two
 * surfaces that reach the builder BY PATH keep working unchanged: `apps/web`'s
 * MCP gateway dynamically imports it (`platform-tools.ts`), and the v1 route
 * and several tests mock it here.
 *
 * Only the builder is re-exported. The warm helper has no path-bound caller,
 * so every one of its call sites imports `@repo/instructions/export`
 * directly — including the two procedures next door.
 */
export { buildInstructionSnapshotZip } from "@repo/instructions/export";
