/**
 * Vitest setup file
 *
 * Sets up environment variables needed for tests.
 */

// Set a mock DATABASE_URL for tests that import modules that depend on it
// This prevents the "DATABASE_URL is not set" error during test imports
process.env.DATABASE_URL =
	process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";
