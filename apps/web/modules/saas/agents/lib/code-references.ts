/**
 * Code Reference Parser
 *
 * Parses file:line references from user input to enable
 * automatic code fetching from connected repositories.
 *
 * Supported formats:
 * - src/utils/auth.ts:45
 * - app/page.tsx:10-25
 * - components/Button.tsx:15
 */

export interface CodeReference {
	filePath: string;
	lineStart: number;
	lineEnd?: number;
	fullMatch: string;
}

export interface ExtractedLineWindow {
	content: string;
	lineStart: number;
	lineEnd: number;
}

export interface ModuleContextSummary {
	exportedSymbols: string[];
	localImports: string[];
	externalDependencies: string[];
	likelyRelatedFiles: string[];
}

interface ImportReference {
	source: string;
	specifiers: string[];
}

export interface BuildCodeSnippetPromptOptions {
	surroundingLines?: number;
	includeImports?: boolean;
	importSearchLines?: number;
	includeModuleSummary?: boolean;
	maxRelatedFiles?: number;
}

const CODE_REFERENCE_REGEX =
	/(\S+\.(?:js|ts|tsx|jsx|py|go|rs|java|cpp|c|h|cs|rb|php|swift|kt|scala|rs|vue|svelte|mjs|cjs)):(\d+)(?:-(\d+))?/gi;

const DEFAULT_SURROUNDING_LINES = 8;
const DEFAULT_IMPORT_SEARCH_LINES = 40;

export function extractCodeReferences(text: string): CodeReference[] {
	const matches = [...text.matchAll(CODE_REFERENCE_REGEX)];
	return matches.map((match) => ({
		filePath: match[1],
		lineStart: Number.parseInt(match[2], 10),
		lineEnd: match[3] ? Number.parseInt(match[3], 10) : undefined,
		fullMatch: match[0],
	}));
}

export function hasCodeReferences(text: string): boolean {
	return CODE_REFERENCE_REGEX.test(text);
}

export function formatCodeReference(ref: CodeReference): string {
	if (ref.lineEnd && ref.lineEnd !== ref.lineStart) {
		return `${ref.filePath}:${ref.lineStart}-${ref.lineEnd}`;
	}
	return `${ref.filePath}:${ref.lineStart}`;
}

export function deduplicateCodeReferences(
	refs: CodeReference[],
): CodeReference[] {
	const seen = new Set<string>();
	return refs.filter((ref) => {
		const key = `${ref.filePath}:${ref.lineStart}`;
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}

function extractLines(
	content: string,
	lineStart: number,
	lineEnd?: number,
): string {
	const lines = content.split("\n");
	const start = Math.max(0, lineStart - 1);
	const end = lineEnd ? Math.min(lines.length, lineEnd) : start + 1;
	return lines.slice(start, end).join("\n");
}

export function extractLineWindow(
	content: string,
	lineStart: number,
	lineEnd?: number,
	surroundingLines = DEFAULT_SURROUNDING_LINES,
): ExtractedLineWindow {
	const lines = content.split("\n");
	const selectedEnd = lineEnd ?? lineStart;
	const windowStart = Math.max(1, lineStart - surroundingLines);
	const windowEnd = Math.min(lines.length, selectedEnd + surroundingLines);

	return {
		content: extractLines(content, windowStart, windowEnd),
		lineStart: windowStart,
		lineEnd: windowEnd,
	};
}

export function extractImportExportContext(
	content: string,
	maxLines = DEFAULT_IMPORT_SEARCH_LINES,
): string {
	const lines = content.split("\n").slice(0, maxLines);
	const extracted: string[] = [];
	let collectingMultiline = false;

	for (const rawLine of lines) {
		const line = rawLine.trim();

		if (!line) {
			if (collectingMultiline) {
				extracted.push(rawLine);
			}
			continue;
		}

		const startsHeader =
			line.startsWith("import ") ||
			line.startsWith("export ") ||
			line.startsWith("from ") ||
			line.startsWith("const ") ||
			line.startsWith("let ") ||
			line.startsWith("var ");

		if (startsHeader || collectingMultiline) {
			extracted.push(rawLine);
			collectingMultiline =
				!line.endsWith(";") &&
				!line.endsWith("}") &&
				!line.endsWith(")") &&
				!line.endsWith("]");
			continue;
		}

		if (extracted.length > 0) {
			break;
		}
	}

	return extracted.join("\n").trim();
}

function formatLineRange(lineStart: number, lineEnd?: number): string {
	if (lineEnd && lineEnd !== lineStart) {
		return `${lineStart}-${lineEnd}`;
	}
	return `${lineStart}`;
}

function formatNumberedLines(content: string, lineStart: number): string {
	return content
		.split("\n")
		.map((line, index) => `${lineStart + index} | ${line}`)
		.join("\n");
}

function extractImportReferences(content: string): ImportReference[] {
	const references: ImportReference[] = [];
	const lines = content.split("\n");
	const requireRegex =
		/(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*require\(['"]([^'"]+)['"]\)/;
	const pythonImportRegex =
		/(?:from\s+([\w.]+)\s+import\s+([\w*,\s]+)|import\s+([\w.]+))/;

	for (const line of lines.slice(0, 80)) {
		const trimmed = line.trim();
		if (
			trimmed.startsWith("//") ||
			trimmed.startsWith("#") ||
			trimmed.startsWith("/*") ||
			trimmed.startsWith("*")
		) {
			continue;
		}

		if (trimmed.startsWith("import ")) {
			const sourceMatch = trimmed.match(/from\s+['"]([^'"]+)['"]/);
			const sideEffectMatch = trimmed.match(/^import\s+['"]([^'"]+)['"]/);
			const source = sourceMatch?.[1] ?? sideEffectMatch?.[1];
			if (!source) {
				continue;
			}

			const clause = trimmed
				.replace(/^import\s+/, "")
				.replace(/\s+from\s+['"][^'"]+['"];?$/, "")
				.trim();
			const specifiers = clause
				.split(",")
				.flatMap((part) => part.split(/[{}]/))
				.map((part) => part.trim())
				.filter(Boolean)
				.map(
					(part) =>
						part
							.split(/\s+as\s+/i)
							.at(-1)
							?.trim() ?? part,
				)
				.filter((part) => part !== "type");

			references.push({ source, specifiers });
			continue;
		}

		const requireMatch = trimmed.match(requireRegex);
		if (requireMatch) {
			references.push({
				source: requireMatch[2],
				specifiers: [requireMatch[1]],
			});
			continue;
		}

		const pythonMatch = trimmed.match(pythonImportRegex);
		if (pythonMatch) {
			const source = pythonMatch[1] || pythonMatch[3];
			const specifiers = pythonMatch[2]
				? pythonMatch[2]
						.split(",")
						.map((part) => part.trim())
						.filter(Boolean)
				: source
					? [source.split(".").at(-1) ?? source]
					: [];
			if (source) {
				references.push({ source, specifiers });
			}
		}
	}

	return references;
}

export function extractImportedModules(content: string): string[] {
	return [
		...new Set(
			extractImportReferences(content).map(
				(reference) => reference.source,
			),
		),
	];
}

export function extractExportedSymbols(content: string): string[] {
	const symbols = new Set<string>();
	const exportPatterns = [
		/export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/g,
		/export\s+(?:const|let|var|class|interface|type|enum)\s+([A-Za-z0-9_]+)/g,
		/export\s*\{\s*([^}]+)\s*\}/g,
		/export\s+default\s+function\s+([A-Za-z0-9_]+)/g,
		/export\s+default\s+class\s+([A-Za-z0-9_]+)/g,
	];

	for (const pattern of exportPatterns) {
		for (const match of content.matchAll(pattern)) {
			if (!match[1]) {
				continue;
			}
			if (match[0].includes("{")) {
				for (const part of match[1].split(",")) {
					const normalized = part
						.trim()
						.split(/\s+as\s+/i)[0]
						?.trim();
					if (normalized) {
						symbols.add(normalized);
					}
				}
			} else {
				symbols.add(match[1].trim());
			}
		}
	}

	if (/export\s+default\s+/g.test(content)) {
		symbols.add("default");
	}

	return [...symbols];
}

export function identifyRelatedFiles(
	filePath: string,
	content: string,
	lineStart?: number,
	lineEnd?: number,
): string[] {
	const related: string[] = [];
	const seen = new Set<string>();
	const lastSlash = filePath.lastIndexOf("/");
	const dir = lastSlash === -1 ? "" : filePath.slice(0, lastSlash);
	const extensionMatch = filePath.match(/(\.[^.]+)$/);
	const extension = extensionMatch?.[1] ?? ".ts";
	const baseName = filePath.slice(lastSlash + 1).replace(/\.[^.]+$/, "");
	const selectedWindow =
		lineStart !== undefined
			? extractLineWindow(content, lineStart, lineEnd, 2).content
			: "";
	const importReferences = extractImportReferences(content);

	const addCandidate = (candidate: string) => {
		if (!candidate || candidate === filePath || seen.has(candidate)) {
			return;
		}
		seen.add(candidate);
		related.push(candidate);
	};

	const normalizedImportCandidates = importReferences
		.filter(
			(reference) =>
				reference.source.startsWith(".") &&
				!reference.source.endsWith(".css") &&
				!reference.source.endsWith(".scss"),
		)
		.map((reference) => {
			const normalized = reference.source
				.replace(/^\.\//, dir ? `${dir}/` : "")
				.replace(/\/$/, "");
			const relevanceScore = reference.specifiers.some((specifier) =>
				selectedWindow.includes(specifier),
			)
				? 1
				: 0;
			return {
				relevanceScore,
				candidates: [
					normalized,
					`${normalized}.ts`,
					`${normalized}.tsx`,
					`${normalized}/index.ts`,
					`${normalized}/index.tsx`,
				],
			};
		})
		.sort((a, b) => b.relevanceScore - a.relevanceScore);

	for (const group of normalizedImportCandidates) {
		for (const candidate of group.candidates) {
			addCandidate(candidate);
		}
	}

	const directSuggestions = [
		`${baseName}.test${extension}`,
		`${baseName}.spec${extension}`,
		`${baseName}.stories${extension}`,
		`${baseName}.types.ts`,
		`${baseName}.utils.ts`,
		`use${baseName}.ts`,
		"index.ts",
		"index.tsx",
	];
	for (const candidate of directSuggestions) {
		addCandidate(dir ? `${dir}/${candidate}` : candidate);
	}

	return related.slice(0, 10);
}

export function summarizeModuleContext(
	filePath: string,
	content: string,
): ModuleContextSummary {
	const importedModules = extractImportedModules(content);
	return {
		exportedSymbols: extractExportedSymbols(content).slice(0, 8),
		localImports: importedModules
			.filter((module) => module.startsWith("."))
			.slice(0, 8),
		externalDependencies: importedModules
			.filter(
				(module) => !module.startsWith(".") && !module.startsWith("/"),
			)
			.slice(0, 8),
		likelyRelatedFiles: identifyRelatedFiles(filePath, content).slice(0, 8),
	};
}

function formatModuleContextSummary(
	summary: ModuleContextSummary,
): string | null {
	const lines = [
		summary.exportedSymbols.length > 0
			? `Exports: ${summary.exportedSymbols.join(", ")}`
			: null,
		summary.localImports.length > 0
			? `Local imports: ${summary.localImports.join(", ")}`
			: null,
		summary.externalDependencies.length > 0
			? `External dependencies: ${summary.externalDependencies.join(", ")}`
			: null,
		summary.likelyRelatedFiles.length > 0
			? `Likely related files: ${summary.likelyRelatedFiles.join(", ")}`
			: null,
	].filter(Boolean);

	if (lines.length === 0) {
		return null;
	}

	return `Module context:\n- ${lines.join("\n- ")}`;
}

function formatRelatedFileSummary(file: {
	path: string;
	content: string;
}): string {
	const summary = summarizeModuleContext(file.path, file.content);
	const moduleContext = formatModuleContextSummary({
		exportedSymbols: summary.exportedSymbols.slice(0, 4),
		localImports: summary.localImports.slice(0, 4),
		externalDependencies: summary.externalDependencies.slice(0, 4),
		likelyRelatedFiles: [],
	});
	const header = extractImportExportContext(file.content, 20);
	const sections = [file.path, moduleContext];

	if (header) {
		sections.push(`Header:\n\`\`\`\n${header}\n\`\`\``);
	}

	return sections.join("\n");
}

export function buildCodeSnippetPrompt(
	filePath: string,
	content: string,
	lineStart: number,
	lineEnd?: number,
	options: BuildCodeSnippetPromptOptions = {},
): string {
	const selectedContent = extractLines(content, lineStart, lineEnd);
	const window = extractLineWindow(
		content,
		lineStart,
		lineEnd,
		options.surroundingLines ?? DEFAULT_SURROUNDING_LINES,
	);
	const importContext = options.includeImports
		? extractImportExportContext(
				content,
				options.importSearchLines ?? DEFAULT_IMPORT_SEARCH_LINES,
			)
		: "";
	const moduleContext =
		options.includeModuleSummary === false
			? null
			: formatModuleContextSummary(
					summarizeModuleContext(filePath, content),
				);
	const selectedRange = formatLineRange(lineStart, lineEnd);
	const windowRange = formatLineRange(window.lineStart, window.lineEnd);
	const sections = [
		`\n\nFile: ${filePath}:${selectedRange}`,
		moduleContext,
		importContext
			? `Header context:\n\`\`\`\n${formatNumberedLines(importContext, 1)}\n\`\`\``
			: null,
		window.content.trim() !== selectedContent.trim() ||
		window.lineStart !== lineStart ||
		(lineEnd ?? lineStart) !== window.lineEnd
			? `Surrounding context (${windowRange}):\n\`\`\`\n${formatNumberedLines(window.content, window.lineStart)}\n\`\`\``
			: null,
		`Selected lines (${selectedRange}):\n\`\`\`\n${formatNumberedLines(selectedContent, lineStart)}\n\`\`\``,
	].filter(Boolean);

	return `${sections.join("\n\n")}\n`;
}

export function buildComprehensiveFileContext(
	filePath: string,
	content: string,
	lineStart: number,
	lineEnd?: number,
	relatedFiles?: Array<{ path: string; content: string }>,
	options: BuildCodeSnippetPromptOptions = {},
): string {
	const mainSnippet = buildCodeSnippetPrompt(
		filePath,
		content,
		lineStart,
		lineEnd,
		{
			includeImports: true,
			surroundingLines: 10,
			includeModuleSummary: true,
			...options,
		},
	);

	let context = mainSnippet;
	const maxRelatedFiles = options.maxRelatedFiles ?? 2;
	const relatedSummaries = (relatedFiles ?? [])
		.slice(0, maxRelatedFiles)
		.map((file) => formatRelatedFileSummary(file));

	if (relatedSummaries.length > 0) {
		context += `\n---\nRelated files:\n\n${relatedSummaries.join("\n\n")}`;
	}

	return context;
}
