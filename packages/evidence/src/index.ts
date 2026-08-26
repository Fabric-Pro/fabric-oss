/**
 * @repo/evidence
 *
 * Evidence.dev project generator for Fabric reports.
 *
 * This package provides utilities to generate Evidence projects from
 * Fabric report templates and data, and build them into static HTML dashboards.
 *
 * @example
 * ```typescript
 * import { generateEvidenceProject, buildEvidenceProject } from '@repo/evidence';
 *
 * // Generate Evidence project from Fabric report data
 * const project = await generateEvidenceProject({
 *   template,
 *   dataResults,
 *   aiResults,
 *   parameters,
 * });
 *
 * // Build the project
 * const result = await buildEvidenceProject({
 *   projectDir: project.projectDir,
 *   outputDir: '/tmp/output',
 * });
 *
 * // Use the built HTML
 * if (result.success) {
 *   const html = await fs.readFile(path.join(result.outputDir, 'index.html'));
 * }
 * ```
 */

export type { BuildOptions, BuildResult } from "./builder/docker-builder";
// Builder
export {
	buildEvidenceProject,
	DEFAULT_DOCKER_IMAGE,
	ensureBuilderImage,
	isBuilderImageAvailable,
	isDockerAvailable,
	packageAsInlineHtml,
	readBuildOutput,
} from "./builder/docker-builder";
// Components
export * from "./components";
export {
	createMetricsFromData,
	generateDataSourceContent,
	getDataSourcePath,
	mapDataSources,
	sanitizeSourceName,
} from "./generator/data-source-mapper";
// Generator
export {
	cleanupProject,
	generateEvidenceProject,
	getProjectSummary,
} from "./generator/project-generator";
export {
	generateFrontmatter,
	generatePageContent,
	generatePages,
} from "./generator/template-mapper";
// Types
export * from "./types";
