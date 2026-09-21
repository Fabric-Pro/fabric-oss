/**
 * Server-only surface of `@repo/instructions`.
 *
 * Deliberately NOT re-exported from `src/index.ts`: `apps/web` imports the
 * package root from client components, and the root must stay free of
 * `@repo/database`, `@repo/storage` and `archiver`. Reach this through the
 * `@repo/instructions/export` subpath instead.
 */
export {
	buildInstructionSnapshotZip,
	warmInstructionSnapshotExport,
} from "./build-zip";
