/**
 * Symbol Extraction Activity
 *
 * Extracts function/class/enum names from source code using regex heuristics.
 * This is a best-effort enhancement to chunk-based search — not a full AST parser.
 *
 * Supported languages:
 * - TypeScript/JavaScript: function, class, const/let/var patterns, interface, enum, type
 * - Python: def, class, async def
 * - Go: func, type, struct, interface
 * - Rust: fn, struct, enum, trait, impl
 * - Java: method, class, interface, enum
 */

import { readFileSync } from "node:fs";
import { Context } from "@temporalio/activity";
import { jobIncrement, jobStep } from "../lib/job-progress";

export interface ExtractSymbolsInput {
	filePath: string;
	content: string;
	language: string;
	projectId: string;
	userId: string;
	organizationId?: string | null;
}

export interface ExtractedSymbol {
	name: string;
	type: string;
	filePath: string;
	lineStart: number;
	lineEnd: number | null;
	signature: string | null;
	language: string;
	projectId: string;
	userId: string;
	organizationId: string | null;
}

const MAX_SYMBOLS_PER_FILE = 50;

const TEST_FILE_PATTERNS = [
	/\.test\./i,
	/\.spec\./i,
	/__tests__/i,
	/__mocks__/i,
];

function isTestFile(filePath: string): boolean {
	return TEST_FILE_PATTERNS.some((pattern) => pattern.test(filePath));
}

// =============================================================================
// Language-specific regex patterns
// =============================================================================

interface SymbolPattern {
	regex: RegExp;
	type: string;
	extractName: (match: RegExpExecArray) => string | null;
	extractSignature?: (
		match: RegExpExecArray,
		lines: string[],
		lineIndex: number,
	) => string | null;
}

function getPatternsForLanguage(language: string): SymbolPattern[] {
	switch (language.toLowerCase()) {
		case "typescript":
		case "javascript":
			return getTypeScriptPatterns();
		case "python":
			return getPythonPatterns();
		case "go":
			return getGoPatterns();
		case "rust":
			return getRustPatterns();
		case "java":
			return getJavaPatterns();
		case "ruby":
			return getRubyPatterns();
		case "php":
			return getPhpPatterns();
		case "csharp":
			return getCSharpPatterns();
		case "kotlin":
			return getKotlinPatterns();
		case "swift":
			return getSwiftPatterns();
		case "cpp":
		case "c":
			return getCppPatterns();
		default:
			return getGenericPatterns();
	}
}

function getTypeScriptPatterns(): SymbolPattern[] {
	return [
		{
			regex: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm,
			type: "function",
			extractName: (m) => m[1],
			extractSignature: (m, lines, lineIdx) => {
				const line = lines[lineIdx];
				const sigMatch = line.match(/function\s+\w+\s*\([^)]*\)/);
				return sigMatch ? sigMatch[0] : null;
			},
		},
		{
			regex: /^(?:export\s+)?class\s+(\w+)/gm,
			type: "class",
			extractName: (m) => m[1],
		},
		{
			regex: /^(?:export\s+)?interface\s+(\w+)/gm,
			type: "interface",
			extractName: (m) => m[1],
		},
		{
			regex: /^(?:export\s+)?enum\s+(\w+)/gm,
			type: "enum",
			extractName: (m) => m[1],
		},
		{
			regex: /^(?:export\s+)?type\s+(\w+)\s*=/gm,
			type: "type",
			extractName: (m) => m[1],
		},
		{
			regex: /^(?:export\s+)?const\s+(\w+)\s*[:=]/gm,
			type: "const",
			extractName: (m) => m[1],
		},
		{
			regex: /^(?:export\s+)?(?:let|var)\s+(\w+)\s*[:=]/gm,
			type: "variable",
			extractName: (m) => m[1],
		},
		// Arrow functions assigned to const: const foo = () => {}
		{
			regex: /^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/gm,
			type: "function",
			extractName: (m) => m[1],
		},
		// Method definitions in classes
		{
			regex: /^\s+(?:async\s+)?(\w+)\s*\([^)]*\)\s*[:{]/gm,
			type: "method",
			extractName: (m) => m[1],
		},
	];
}

function getPythonPatterns(): SymbolPattern[] {
	return [
		{
			regex: /^\s*def\s+(\w+)\s*\(/gm,
			type: "function",
			extractName: (m) => m[1],
			extractSignature: (m, lines, lineIdx) => {
				const line = lines[lineIdx];
				const sigMatch = line.match(/def\s+\w+\s*\([^)]*\)/);
				return sigMatch ? sigMatch[0] : null;
			},
		},
		{
			regex: /^\s*async\s+def\s+(\w+)\s*\(/gm,
			type: "function",
			extractName: (m) => m[1],
			extractSignature: (m, lines, lineIdx) => {
				const line = lines[lineIdx];
				const sigMatch = line.match(/async\s+def\s+\w+\s*\([^)]*\)/);
				return sigMatch ? sigMatch[0] : null;
			},
		},
		{
			regex: /^\s*class\s+(\w+)/gm,
			type: "class",
			extractName: (m) => m[1],
		},
	];
}

function getGoPatterns(): SymbolPattern[] {
	return [
		{
			regex: /^func\s+(?:\([^)]*\)\s+)?(\w+)\s*\(/gm,
			type: "function",
			extractName: (m) => m[1],
		},
		{
			regex: /^type\s+(\w+)\s+struct\b/gm,
			type: "struct",
			extractName: (m) => m[1],
		},
		{
			regex: /^type\s+(\w+)\s+interface\b/gm,
			type: "interface",
			extractName: (m) => m[1],
		},
		{
			regex: /^type\s+(\w+)\s+/gm,
			type: "type",
			extractName: (m) => m[1],
		},
	];
}

function getRustPatterns(): SymbolPattern[] {
	return [
		{
			regex: /^\s*fn\s+(\w+)\s*\(/gm,
			type: "function",
			extractName: (m) => m[1],
		},
		{
			regex: /^\s*pub\s+fn\s+(\w+)\s*\(/gm,
			type: "function",
			extractName: (m) => m[1],
		},
		{
			regex: /^\s*struct\s+(\w+)/gm,
			type: "struct",
			extractName: (m) => m[1],
		},
		{
			regex: /^\s*enum\s+(\w+)/gm,
			type: "enum",
			extractName: (m) => m[1],
		},
		{
			regex: /^\s*trait\s+(\w+)/gm,
			type: "trait",
			extractName: (m) => m[1],
		},
		{
			regex: /^\s*impl\s+(?:<[^>]+>\s+)?(\w+)/gm,
			type: "impl",
			extractName: (m) => m[1],
		},
	];
}

function getJavaPatterns(): SymbolPattern[] {
	return [
		{
			regex: /^(?:public|private|protected|static|\s)+[\w<>,\s]+\s+(\w+)\s*\([^)]*\)\s*\{/gm,
			type: "method",
			extractName: (m) => m[1],
		},
		{
			regex: /^(?:public\s+)?class\s+(\w+)/gm,
			type: "class",
			extractName: (m) => m[1],
		},
		{
			regex: /^(?:public\s+)?interface\s+(\w+)/gm,
			type: "interface",
			extractName: (m) => m[1],
		},
		{
			regex: /^(?:public\s+)?enum\s+(\w+)/gm,
			type: "enum",
			extractName: (m) => m[1],
		},
	];
}

function getRubyPatterns(): SymbolPattern[] {
	return [
		{
			regex: /^\s*def\s+(\w+)/gm,
			type: "function",
			extractName: (m) => m[1],
		},
		{
			regex: /^\s*class\s+(\w+)/gm,
			type: "class",
			extractName: (m) => m[1],
		},
		{
			regex: /^\s*module\s+(\w+)/gm,
			type: "module",
			extractName: (m) => m[1],
		},
	];
}

function getPhpPatterns(): SymbolPattern[] {
	return [
		{
			regex: /^(?:public|private|protected|static|\s)+function\s+(\w+)\s*\(/gm,
			type: "function",
			extractName: (m) => m[1],
		},
		{
			regex: /^class\s+(\w+)/gm,
			type: "class",
			extractName: (m) => m[1],
		},
		{
			regex: /^interface\s+(\w+)/gm,
			type: "interface",
			extractName: (m) => m[1],
		},
		{
			regex: /^trait\s+(\w+)/gm,
			type: "trait",
			extractName: (m) => m[1],
		},
	];
}

function getCSharpPatterns(): SymbolPattern[] {
	return [
		{
			regex: /^(?:public|private|protected|internal|static|\s)+[\w<>,\s]+\s+(\w+)\s*\([^)]*\)\s*\{/gm,
			type: "method",
			extractName: (m) => m[1],
		},
		{
			regex: /^(?:public\s+)?class\s+(\w+)/gm,
			type: "class",
			extractName: (m) => m[1],
		},
		{
			regex: /^(?:public\s+)?interface\s+(\w+)/gm,
			type: "interface",
			extractName: (m) => m[1],
		},
		{
			regex: /^(?:public\s+)?enum\s+(\w+)/gm,
			type: "enum",
			extractName: (m) => m[1],
		},
		{
			regex: /^(?:public\s+)?struct\s+(\w+)/gm,
			type: "struct",
			extractName: (m) => m[1],
		},
	];
}

function getKotlinPatterns(): SymbolPattern[] {
	return [
		{
			regex: /^(?:fun|public\s+fun|private\s+fun)\s+(\w+)\s*\(/gm,
			type: "function",
			extractName: (m) => m[1],
		},
		{
			regex: /^(?:class|data\s+class|sealed\s+class)\s+(\w+)/gm,
			type: "class",
			extractName: (m) => m[1],
		},
		{
			regex: /^(?:interface)\s+(\w+)/gm,
			type: "interface",
			extractName: (m) => m[1],
		},
		{
			regex: /^(?:object)\s+(\w+)/gm,
			type: "object",
			extractName: (m) => m[1],
		},
	];
}

function getSwiftPatterns(): SymbolPattern[] {
	return [
		{
			regex: /^(?:func|public\s+func|private\s+func)\s+(\w+)\s*\(/gm,
			type: "function",
			extractName: (m) => m[1],
		},
		{
			regex: /^(?:class|public\s+class|final\s+class)\s+(\w+)/gm,
			type: "class",
			extractName: (m) => m[1],
		},
		{
			regex: /^(?:struct|public\s+struct)\s+(\w+)/gm,
			type: "struct",
			extractName: (m) => m[1],
		},
		{
			regex: /^(?:protocol|public\s+protocol)\s+(\w+)/gm,
			type: "protocol",
			extractName: (m) => m[1],
		},
		{
			regex: /^(?:enum|public\s+enum)\s+(\w+)/gm,
			type: "enum",
			extractName: (m) => m[1],
		},
	];
}

function getCppPatterns(): SymbolPattern[] {
	return [
		{
			regex: /^[\w:*\s]+\s+(\w+)\s*\([^)]*\)\s*(?:const\s*)?\{/gm,
			type: "function",
			extractName: (m) => m[1],
		},
		{
			regex: /^(?:class|struct)\s+(\w+)/gm,
			type: "class",
			extractName: (m) => m[1],
		},
		{
			regex: /^enum\s+(?:class\s+)?(\w+)/gm,
			type: "enum",
			extractName: (m) => m[1],
		},
	];
}

function getGenericPatterns(): SymbolPattern[] {
	return [
		{
			regex: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm,
			type: "function",
			extractName: (m) => m[1],
		},
		{
			regex: /^(?:export\s+)?class\s+(\w+)/gm,
			type: "class",
			extractName: (m) => m[1],
		},
		{
			regex: /^\s*def\s+(\w+)\s*\(/gm,
			type: "function",
			extractName: (m) => m[1],
		},
	];
}

// =============================================================================
// Main extraction function
// =============================================================================

/**
 * Extract symbols from source code using regex heuristics.
 *
 * @returns Array of extracted symbols, limited to MAX_SYMBOLS_PER_FILE
 */
export function extractSymbolsFromCode(
	input: ExtractSymbolsInput,
): ExtractedSymbol[] {
	const { filePath, content, language, projectId, userId, organizationId } =
		input;

	// Skip test files
	if (isTestFile(filePath)) {
		return [];
	}

	const lines = content.split("\n");
	const patterns = getPatternsForLanguage(language);
	// Pre-compile a per-line (non-global) variant once per file rather than
	// once per line × pattern. Patterns stay global for callers that might
	// iterate them multi-line.
	const lineRegexes = patterns.map(
		(p) => new RegExp(p.regex.source, p.regex.flags.replace("g", "")),
	);
	const symbols: ExtractedSymbol[] = [];
	const seen = new Set<string>(); // Deduplicate by name+type+line

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		if (symbols.length >= MAX_SYMBOLS_PER_FILE) {
			break;
		}

		const line = lines[lineIndex];

		for (let p = 0; p < patterns.length; p++) {
			const pattern = patterns[p];
			const match = line.match(lineRegexes[p]) as RegExpExecArray | null;

			if (match) {
				const name = pattern.extractName(match);
				if (!name) {
					continue;
				}

				// Skip private/internal symbols that start with _
				if (name.startsWith("_")) {
					continue;
				}

				const dedupKey = `${name}:${pattern.type}:${lineIndex}`;
				if (seen.has(dedupKey)) {
					continue;
				}
				seen.add(dedupKey);

				// Extract signature if available
				let signature: string | null = null;
				if (pattern.extractSignature) {
					signature = pattern.extractSignature(
						match,
						lines,
						lineIndex,
					);
				} else {
					// Default signature: first 120 chars of the line
					signature = line.trim().slice(0, 120);
				}

				// Estimate lineEnd by looking for closing brace or blank line
				let lineEnd: number | null = null;
				if (
					pattern.type === "class" ||
					pattern.type === "function" ||
					pattern.type === "method" ||
					pattern.type === "struct" ||
					pattern.type === "impl" ||
					pattern.type === "trait"
				) {
					lineEnd = findBlockEnd(lines, lineIndex);
				}

				symbols.push({
					name,
					type: pattern.type,
					filePath,
					lineStart: lineIndex + 1, // 1-indexed
					lineEnd,
					signature,
					language,
					projectId,
					userId,
					organizationId: organizationId ?? null,
				});

				break; // Only match first pattern per line
			}
		}
	}

	return symbols;
}

export interface ExtractSymbolsActivityInput {
	files: Array<{
		relativePath: string;
		absolutePath: string;
		language: string | null;
	}>;
	projectId: string;
	userId: string;
	organizationId?: string | null;
}

export interface ExtractSymbolsActivityOutput {
	symbols: ExtractedSymbol[];
	filesProcessed: number;
	totalSymbols: number;
}

/**
 * Temporal activity: Extract symbols from a batch of files.
 */
export async function extractSymbolsActivity(
	input: ExtractSymbolsActivityInput,
): Promise<ExtractSymbolsActivityOutput> {
	const { files, projectId, userId, organizationId } = input;
	const allSymbols: ExtractedSymbol[] = [];

	for (const file of files) {
		if (!file.language) {
			continue;
		}

		try {
			const content = readFileSync(file.absolutePath, "utf-8");
			if (!content.trim()) {
				continue;
			}

			const symbols = extractSymbolsFromCode({
				filePath: file.relativePath,
				content,
				language: file.language,
				projectId,
				userId,
				organizationId,
			});

			allSymbols.push(...symbols);
		} catch {
			// Skip files that can't be read
		}
	}

	return {
		symbols: allSymbols,
		filesProcessed: files.length,
		totalSymbols: allSymbols.length,
	};
}

/**
 * Find the approximate end line of a code block by tracking brace depth.
 * Returns null if it can't be determined reliably.
 */
function findBlockEnd(lines: string[], startIndex: number): number | null {
	let braceDepth = 0;
	let foundOpenBrace = false;

	for (let i = startIndex; i < lines.length; i++) {
		const line = lines[i];
		for (const char of line) {
			if (char === "{" || char === "(") {
				braceDepth++;
				foundOpenBrace = true;
			} else if (char === "}" || char === ")") {
				braceDepth--;
			}
		}

		if (foundOpenBrace && braceDepth <= 0) {
			return i + 1; // 1-indexed
		}

		// Safety: stop after 200 lines to avoid runaway
		if (i - startIndex > 200) {
			return i + 1;
		}
	}

	return null;
}

// =============================================================================
// Database persistence activity
// =============================================================================

export interface PersistCodeSymbolsInput {
	projectId: string;
	userId: string;
	organizationId?: string | null;
	symbols: ExtractedSymbol[];
}

export interface PersistCodeSymbolsOutput {
	deletedCount: number;
	insertedCount: number;
}

/**
 * Temporal activity: Delete old symbols and persist new ones for a project.
 */
export async function persistCodeSymbolsActivity(
	input: PersistCodeSymbolsInput,
): Promise<PersistCodeSymbolsOutput> {
	const { createCodeSymbols, deleteCodeSymbolsByProject } = await import(
		"@repo/database"
	);

	// Delete old symbols for the project
	await deleteCodeSymbolsByProject(input.projectId);

	// Batch insert new symbols
	if (input.symbols.length === 0) {
		return { deletedCount: 0, insertedCount: 0 };
	}

	const dbSymbols = input.symbols.map((s) => ({
		projectId: s.projectId,
		name: s.name,
		type: s.type,
		filePath: s.filePath,
		lineStart: s.lineStart,
		lineEnd: s.lineEnd,
		signature: s.signature,
		language: s.language,
		userId: s.userId,
		organizationId: s.organizationId,
	}));

	const result = await createCodeSymbols(dbSymbols);

	await jobStep("symbols", "completed");
	await jobIncrement({ symbols: result.count });

	return {
		deletedCount: 0, // We don't track how many were deleted
		insertedCount: result.count,
	};
}

// =============================================================================
// Scalable per-batch extract + persist (for large repos)
// =============================================================================

export interface ExtractAndPersistSymbolsInput {
	files: Array<{
		relativePath: string;
		absolutePath: string;
		language: string | null;
	}>;
	projectId: string;
	userId: string;
	organizationId?: string | null;
}

/**
 * Extract symbols from a batch of files AND persist them within one activity, so
 * the (potentially large) symbol set never crosses the workflow boundary — only
 * a count is returned. This keeps the workflow history small and stays under
 * Temporal's per-payload size limit on a large repo, where accumulating every
 * file's symbols in the workflow (and persisting them in a single call) would
 * blow past both. Append-only: the caller deletes the project's existing symbols
 * once via `deleteProjectCodeSymbolsActivity` before looping over batches.
 */
export async function extractAndPersistSymbolsActivity(
	input: ExtractAndPersistSymbolsInput,
): Promise<{ insertedCount: number; filesProcessed: number }> {
	const { files, projectId, userId, organizationId } = input;
	const symbols: ExtractedSymbol[] = [];

	let processed = 0;
	for (const file of files) {
		// Heartbeat so a large batch never trips the heartbeat timeout.
		Context.current().heartbeat(`symbols ${++processed}/${files.length}`);
		if (!file.language) {
			continue;
		}
		try {
			const content = readFileSync(file.absolutePath, "utf-8");
			if (!content.trim()) {
				continue;
			}
			symbols.push(
				...extractSymbolsFromCode({
					filePath: file.relativePath,
					content,
					language: file.language,
					projectId,
					userId,
					organizationId,
				}),
			);
		} catch {
			// Skip files that can't be read
		}
	}

	const { createCodeSymbols, deleteCodeSymbolsByProjectAndFilePaths } =
		await import("@repo/database");

	// Idempotent per batch: clear any rows for exactly these files first, so a
	// Temporal activity retry (which re-extracts + re-inserts) can't leave
	// duplicate symbols behind. Scoped to the batch's file paths so it never
	// touches other batches' rows.
	await deleteCodeSymbolsByProjectAndFilePaths(
		projectId,
		files.map((f) => f.relativePath),
	);

	if (symbols.length === 0) {
		return { insertedCount: 0, filesProcessed: files.length };
	}

	const result = await createCodeSymbols(
		symbols.map((s) => ({
			projectId: s.projectId,
			name: s.name,
			type: s.type,
			filePath: s.filePath,
			lineStart: s.lineStart,
			lineEnd: s.lineEnd,
			signature: s.signature,
			language: s.language,
			userId: s.userId,
			organizationId: s.organizationId,
		})),
	);

	return { insertedCount: result.count, filesProcessed: files.length };
}

/**
 * Delete a project's existing code symbols. Called once before a full re-extract
 * so the per-batch `extractAndPersistSymbolsActivity` calls are pure appends.
 */
export async function deleteProjectCodeSymbolsActivity(input: {
	projectId: string;
}): Promise<void> {
	const { deleteCodeSymbolsByProject } = await import("@repo/database");
	await deleteCodeSymbolsByProject(input.projectId);
}
