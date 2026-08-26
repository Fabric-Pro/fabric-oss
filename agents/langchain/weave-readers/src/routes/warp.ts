import { generateText, stepCountIs } from "ai";
import { Hono } from "hono";
import { resolveReaderModel } from "../lib/llm.js";
import {
	formatProjectSpecsDisplay,
	loadProjectSpecs,
	mergeWithDefaults,
} from "../lib/project-specs.js";
import { withRetry } from "../lib/retry.js";
import {
	extractText,
	getVerifiedTenant,
	normalizeMetadata,
	sseTextResponse,
} from "../lib/route-utils.js";
import { createSandboxClient } from "../lib/sandbox-client.js";
import { SECURITY_PATTERNS as DETAILED_SECURITY_PATTERNS } from "../lib/security-patterns.js";
import {
	findRelevantSpecs,
	formatSpecCitations,
} from "../lib/security-specs.js";
import { step1DiffScan } from "../lib/warp-triage.js";
import { WARP_SYSTEM_PROMPT } from "../prompts/warp-system.js";
import { createReadOnlySandboxTools } from "../tools/sandbox.js";

export const warpRoute = new Hono();

// Re-export for backward compatibility - flatten patterns to string array
// New code should import from security-patterns.ts directly
export const SECURITY_PATTERNS = DETAILED_SECURITY_PATTERNS.flatMap(
	(p) => p.grepPatterns,
);

const DEFAULT_TOOL_STEPS = 10;
const MAX_TOOL_STEPS = Number(
	process.env.WARP_MAX_TOOL_STEPS || DEFAULT_TOOL_STEPS,
);

import type { Context } from "hono";

async function buildWarpResponse(
	body: unknown,
	honoCtx?: Context,
): Promise<string> {
	const parsed = body as {
		message?: unknown;
		metadata?: unknown;
		changedFiles?: string[];
	};
	const prompt = extractText(parsed.message);
	const metadata = normalizeMetadata(parsed.metadata);
	const changedFiles = parsed.changedFiles || [];
	const tenant = honoCtx
		? getVerifiedTenant(honoCtx, metadata)
		: metadata.tenantContext;
	const model = await resolveReaderModel(tenant);

	const userContent = `Security review request: ${prompt || "Review the implementation for security vulnerabilities."}`;

	// Step 1: Run triage to determine scan depth
	const triage = step1DiffScan(changedFiles);

	// If no sandbox, use single-shot reasoning
	if (!metadata.sandboxSessionId || !metadata.workDir) {
		const specContext =
			triage.estimatedComplexity !== "minimal"
				? "\n\nRelevant security specs identified for this codebase:"
				: "";

		const result = await withRetry(
			() =>
				generateText({
					model: model,
					system: WARP_SYSTEM_PROMPT,
					messages: [
						{
							role: "user",
							content: `${userContent}${specContext}\n\nTriage result: ${triage.skipReason || "Full security scan recommended"}`,
						},
					],
				}),
			{ label: "warp-generateText", circuitKey: "warp" },
		);

		return `${result.text}\n\n> **Note:** This security audit was performed without sandbox access. File-level vulnerability scanning was not possible.`;
	}

	const sandbox = createSandboxClient({
		sessionId: metadata.sandboxSessionId,
		workDir: metadata.workDir,
		branch: "",
		userId: tenant.userId,
		organizationId: tenant.organizationId,
	});

	const tools = createReadOnlySandboxTools(sandbox);

	// Load project-specific specs if available
	const projectSpecs = await loadProjectSpecs(sandbox);
	const patternsToUse = projectSpecs
		? mergeWithDefaults(projectSpecs, DETAILED_SECURITY_PATTERNS)
		: DETAILED_SECURITY_PATTERNS;

	// Build enhanced context with triage results
	const patternList = patternsToUse
		.map(
			(p) =>
				`[${p.severity}] ${p.name}: ${p.grepPatterns.slice(0, 2).join(", ")}`,
		)
		.join("\n");

	let contextHint = userContent;

	// Add project specs info if loaded
	if (projectSpecs) {
		contextHint += `\n\n${formatProjectSpecsDisplay(projectSpecs)}`;
	}

	// Add triage context
	if (triage.skipReason) {
		contextHint += `\n\n**Triage Result:** ${triage.skipReason}`;
	} else if (triage.estimatedComplexity === "minimal") {
		contextHint +=
			"\n\n**Triage Result:** Minimal scan - documentation/config only";
	} else {
		contextHint += `\n\n**Triage Result:** Full scan recommended (${triage.estimatedComplexity} complexity)`;
	}

	// Add security patterns organized by category
	contextHint += `\n\n**Security Patterns by Category:**\n${patternList}`;

	// Add relevant RFC specs if this is a meaningful scan
	if (triage.estimatedComplexity === "full") {
		const codeSample = changedFiles.join(" ");
		const relevantSpecs = findRelevantSpecs(codeSample);
		if (relevantSpecs.length > 0) {
			contextHint += `\n\n**Relevant RFC/Spec References:**\n${formatSpecCitations(relevantSpecs.slice(0, 3))}`;
		}
	}

	// Add instructions based on triage
	if (triage.estimatedComplexity === "minimal") {
		contextHint +=
			"\n\nSince only documentation/config files were changed, focus on:\n" +
			"- Verifying no security-related content was added\n" +
			"- Checking for exposed secrets in documentation\n" +
			"- Confirming no security misconfigurations";
	} else if (triage.estimatedComplexity === "partial") {
		contextHint +=
			"\n\nPerform a targeted scan focusing on:\n" +
			"- High and critical severity patterns\n" +
			"- Authentication and authorization patterns\n" +
			"- Input validation issues";
	} else {
		contextHint +=
			"\n\nThis is a security-sensitive area. Perform a thorough scan covering:\n" +
			"- All security pattern categories\n" +
			"- Authentication and session management\n" +
			"- Cryptographic implementations\n" +
			"- Access control mechanisms";
	}

	contextHint +=
		"\n\nUse the searchCode and readFile tools to thoroughly investigate for security issues.";

	// Run LLM with enhanced context
	const result = await withRetry(
		() =>
			generateText({
				model: model,
				system: WARP_SYSTEM_PROMPT,
				messages: [{ role: "user", content: contextHint }],
				tools,
				stopWhen: stepCountIs(MAX_TOOL_STEPS),
			}),
		{ label: "warp-generateText", circuitKey: "warp" },
	);

	return result.text;
}

warpRoute.post("/", async (c) => {
	try {
		const body = await c.req.json();
		return sseTextResponse(await buildWarpResponse(body, c));
	} catch (error) {
		return c.json(
			{ error: error instanceof Error ? error.message : "Unknown error" },
			500,
		);
	}
});

warpRoute.get("/health", (c) =>
	c.json({
		status: "healthy",
		agent: "warp",
		bias: "security-oriented, skeptical",
		capabilities: [
			"security-audit",
			"vulnerability-scan",
			"tool-calling",
			"llm-reasoning",
			"3-step-triage",
			"rfc-citations",
		],
	}),
);
