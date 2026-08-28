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

/**
 * Number of contexts a single batch ZIP carries. This is a truncation point,
 * not a refusal: a project holding more exports its first
 * `MAX_BATCH_DOWNLOAD_CONTEXTS` rows and names every excluded one in the
 * manifest, so the remainder stays retrievable through single-item download
 * (Fizzy #2228). It exists to bound how long the archive build can hold the
 * request handler open, which is why it is a count rather than a weight —
 * per-item overhead, not total bytes, is what the build time tracks.
 */
export const MAX_BATCH_DOWNLOAD_CONTEXTS = 200 as const;

/**
 * Maximum total source byte size allowed in a single batch ZIP request
 * (500 MB). Unlike the item ceiling this stays a genuine refusal — an archive
 * that cannot be built is a different thing from one deliberately partial, and
 * there is no truthful partial archive to hand back when the weight is the
 * problem.
 */
export const MAX_BATCH_DOWNLOAD_BYTES = 500 * 1024 * 1024;

/** Presigned URL expiry for the generated batch ZIP object (15 minutes). */
export const BATCH_PRESIGN_EXPIRY_SECONDS = 900 as const;

/** Presigned URL expiry for single-file downloads (5 minutes). */
export const SINGLE_PRESIGN_EXPIRY_SECONDS = 300 as const;
