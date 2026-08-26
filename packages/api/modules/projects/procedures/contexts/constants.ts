/**
 * Constants for project context download procedures.
 *
 * Ceilings and presign expiries for single-file and batch ZIP downloads of
 * project context sources. See spec §4.7 and §4.8 in
 * `docs/specs/2026-04-15-download-project-context-files/spec.md`.
 *
 * Shared here so both the single-file and batch procedures, plus their unit
 * tests, can import the values without a circular dependency between
 * procedure files.
 */

/** Maximum number of contexts allowed in a single batch ZIP request. */
export const MAX_BATCH_DOWNLOAD_CONTEXTS = 200 as const;

/** Maximum total source byte size allowed in a single batch ZIP request (500 MB). */
export const MAX_BATCH_DOWNLOAD_BYTES = 500 * 1024 * 1024;

/** Presigned URL expiry for the generated batch ZIP object (15 minutes). */
export const BATCH_PRESIGN_EXPIRY_SECONDS = 900 as const;

/** Presigned URL expiry for single-file downloads (5 minutes). */
export const SINGLE_PRESIGN_EXPIRY_SECONDS = 300 as const;
