/**
 * Evidence Project Generator
 *
 * Main generator that creates a complete Evidence project from Fabric report data.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as yaml from "js-yaml";

import type {
	EvidenceConfig,
	EvidenceTheme,
	GeneratedFile,
	GeneratorInput,
	GeneratorOutput,
} from "../types";
import {
	generateDataSourceContent,
	mapDataSources,
	sanitizeSourceName,
} from "./data-source-mapper";
import { generatePageContent, generatePages } from "./template-mapper";

/**
 * Generate a complete Evidence project from Fabric report input
 */
export async function generateEvidenceProject(
	input: GeneratorInput,
): Promise<GeneratorOutput> {
	const files: GeneratedFile[] = [];
	const warnings: string[] = [];

	// Create temp directory for the project
	const projectDir = await createTempProjectDir(input.template.name);

	try {
		// 1. Generate and write evidence.config.yaml
		const config = generateEvidenceConfig(input);
		const configPath = path.join(projectDir, "evidence.config.yaml");
		const configContent = yaml.dump(config);
		await fs.writeFile(configPath, configContent, "utf-8");
		files.push({
			path: "evidence.config.yaml",
			type: "config",
			size: Buffer.byteLength(configContent),
		});

		// 2. Create sources directory and write data sources
		const sourcesDir = path.join(projectDir, "sources");
		await fs.mkdir(sourcesDir, { recursive: true });

		const dataSources = mapDataSources(input.dataResults, input.aiResults);

		for (const source of dataSources) {
			const sourceDir = path.join(sourcesDir, source.name);
			await fs.mkdir(sourceDir, { recursive: true });

			const ext = source.type === "csv" ? "csv" : "json";
			const sourceFile = path.join(sourceDir, `${source.name}.${ext}`);
			const sourceContent = generateDataSourceContent(source);

			await fs.writeFile(sourceFile, sourceContent, "utf-8");

			files.push({
				path: `sources/${source.name}/${source.name}.${ext}`,
				type: "source",
				size: Buffer.byteLength(sourceContent),
			});

			// Write connection.yaml for the source
			const connectionConfig = {
				name: source.name,
				type: source.type === "csv" ? "csv" : "json",
			};
			const connectionPath = path.join(sourceDir, "connection.yaml");
			const connectionContent = yaml.dump(connectionConfig);
			await fs.writeFile(connectionPath, connectionContent, "utf-8");
		}

		// 3. Create pages directory and write pages
		const pagesDir = path.join(projectDir, "pages");
		await fs.mkdir(pagesDir, { recursive: true });

		const pages = generatePages({
			template: input.template,
			dataResults: input.dataResults,
			aiResults: input.aiResults,
			parameters: input.parameters,
			dateRange: input.dateRange,
		});

		for (const page of pages) {
			const pageFile = path.join(pagesDir, `${page.slug}.md`);
			const pageContent = generatePageContent(page);

			await fs.writeFile(pageFile, pageContent, "utf-8");

			files.push({
				path: `pages/${page.slug}.md`,
				type: "page",
				size: Buffer.byteLength(pageContent),
			});
		}

		// 4. Write theme if provided
		if (input.evidenceOverrides?.theme) {
			const themeDir = path.join(projectDir, "theme");
			await fs.mkdir(themeDir, { recursive: true });

			const themeContent = generateThemeCss(
				input.evidenceOverrides.theme,
			);
			const themePath = path.join(themeDir, "custom.css");

			await fs.writeFile(themePath, themeContent, "utf-8");

			files.push({
				path: "theme/custom.css",
				type: "theme",
				size: Buffer.byteLength(themeContent),
			});
		}

		// 5. Write package.json for Evidence project
		const packageJson = generatePackageJson(input.template.name);
		const packagePath = path.join(projectDir, "package.json");
		const packageContent = JSON.stringify(packageJson, null, 2);

		await fs.writeFile(packagePath, packageContent, "utf-8");

		files.push({
			path: "package.json",
			type: "config",
			size: Buffer.byteLength(packageContent),
		});

		// 6. Write .gitignore
		const gitignorePath = path.join(projectDir, ".gitignore");
		const gitignoreContent = generateGitignore();
		await fs.writeFile(gitignorePath, gitignoreContent, "utf-8");

		return {
			projectDir,
			files,
			warnings: warnings.length > 0 ? warnings : undefined,
		};
	} catch (error) {
		// Cleanup on error
		try {
			await fs.rm(projectDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
		throw error;
	}
}

/**
 * Create a temporary directory for the Evidence project
 */
async function createTempProjectDir(projectName: string): Promise<string> {
	const sanitizedName = sanitizeSourceName(projectName);
	// mkdtemp: a unique, freshly created directory that nothing could have
	// pre-created under the shared temp dir (the worker runs on shared infra).
	return fs.mkdtemp(
		path.join(os.tmpdir(), `fabric-evidence-${sanitizedName}-`),
	);
}

/**
 * Generate Evidence configuration
 */
function generateEvidenceConfig(input: GeneratorInput): EvidenceConfig {
	const { template, evidenceOverrides } = input;

	return {
		title: template.name,
		description: template.description || undefined,
		appearance: {
			title: template.name,
		},
		layout: {
			sidebar: evidenceOverrides?.layout?.sidebar ?? false,
			header: evidenceOverrides?.layout?.header ?? true,
		},
	};
}

/**
 * Generate theme CSS from theme configuration
 */
function generateThemeCss(theme: EvidenceTheme): string {
	const cssVars: string[] = [];

	if (theme.colors) {
		if (theme.colors.primary) {
			cssVars.push(`  --primary-color: ${theme.colors.primary};`);
		}
		if (theme.colors.secondary) {
			cssVars.push(`  --secondary-color: ${theme.colors.secondary};`);
		}
		if (theme.colors.accent) {
			cssVars.push(`  --accent-color: ${theme.colors.accent};`);
		}
		if (theme.colors.background) {
			cssVars.push(`  --background-color: ${theme.colors.background};`);
		}
		if (theme.colors.surface) {
			cssVars.push(`  --surface-color: ${theme.colors.surface};`);
		}
		if (theme.colors.text) {
			cssVars.push(`  --text-color: ${theme.colors.text};`);
		}
	}

	if (theme.fonts) {
		if (theme.fonts.heading) {
			cssVars.push(`  --font-heading: ${theme.fonts.heading};`);
		}
		if (theme.fonts.body) {
			cssVars.push(`  --font-body: ${theme.fonts.body};`);
		}
		if (theme.fonts.mono) {
			cssVars.push(`  --font-mono: ${theme.fonts.mono};`);
		}
	}

	if (theme.borderRadius) {
		cssVars.push(`  --border-radius: ${theme.borderRadius};`);
	}

	return `/* Fabric Custom Theme */
:root {
${cssVars.join("\n")}
}

/* Fabric branding */
.fabric-footer {
  font-size: 0.875rem;
  color: var(--text-color, #666);
  margin-top: 2rem;
  padding-top: 1rem;
  border-top: 1px solid var(--surface-color, #e5e5e5);
}

/* Metrics row layout */
.metrics-row {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  margin: 1rem 0;
}

.metrics-row > * {
  flex: 1;
  min-width: 200px;
}
`;
}

/**
 * Generate package.json for Evidence project
 */
function generatePackageJson(projectName: string): Record<string, unknown> {
	const sanitizedName = sanitizeSourceName(projectName);

	return {
		name: `fabric-report-${sanitizedName}`,
		version: "1.0.0",
		private: true,
		scripts: {
			dev: "evidence dev",
			build: "evidence build",
			preview: "evidence preview",
		},
		devDependencies: {
			"@evidence-dev/evidence": "latest",
			"@evidence-dev/core-components": "latest",
		},
	};
}

/**
 * Generate .gitignore content
 */
function generateGitignore(): string {
	return `# Evidence build output
.evidence/
build/

# Dependencies
node_modules/

# Logs
*.log

# OS
.DS_Store
Thumbs.db
`;
}

/**
 * Clean up a generated project directory
 */
export async function cleanupProject(projectDir: string): Promise<void> {
	await fs.rm(projectDir, { recursive: true, force: true });
}

/**
 * Get project summary for logging/debugging
 */
export function getProjectSummary(output: GeneratorOutput): string {
	const filesByType = output.files.reduce(
		(acc, f) => {
			acc[f.type] = (acc[f.type] || 0) + 1;
			return acc;
		},
		{} as Record<string, number>,
	);

	const totalSize = output.files.reduce((sum, f) => sum + f.size, 0);

	return `Evidence Project Generated:
  Directory: ${output.projectDir}
  Files: ${output.files.length} total
    - Config: ${filesByType.config || 0}
    - Sources: ${filesByType.source || 0}
    - Pages: ${filesByType.page || 0}
    - Theme: ${filesByType.theme || 0}
  Total Size: ${(totalSize / 1024).toFixed(2)} KB
  Warnings: ${output.warnings?.length || 0}`;
}
