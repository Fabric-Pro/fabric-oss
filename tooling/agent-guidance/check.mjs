#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MAX_ROOT_BYTES = 20 * 1024;
export const MAX_CLAUDE_BYTES = 4 * 1024;

const REQUIRED_ROOT_POLICY = [
	{
		name: "organization-only tenancy",
		clause: "An organization is the only tenant context.",
	},
	{
		name: "Prisma migration safety",
		clause: "Never run `prisma db push`.",
	},
	{
		name: "public identifier hygiene",
		clause: "This public repository must contain only synthetic identifiers.",
	},
	{
		name: "changeset-or-skip decision",
		clause: "Every PR must choose exactly one: a non-empty changeset or the `skip-changeset` label.",
	},
	{
		name: "DCO sign-off",
		clause: "Every commit requires DCO sign-off through `git commit -s`.",
	},
];

const REQUIRED_NESTED_GUIDANCE = [
	{ agents: "apps/web/AGENTS.md", claude: "apps/web/CLAUDE.md" },
	{ agents: "packages/api/AGENTS.md", claude: "packages/api/CLAUDE.md" },
	{
		agents: "packages/database/AGENTS.md",
		claude: "packages/database/CLAUDE.md",
	},
	{
		agents: "packages/temporal/AGENTS.md",
		claude: "packages/temporal/CLAUDE.md",
	},
];

const MARKDOWN_LINK = /(?<!!)\[[^\]]*\]\(([^)]+)\)/g;

async function exists(path) {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if (error?.code === "ENOENT") {
			return false;
		}
		throw error;
	}
}

function localLinkTarget(rawTarget) {
	const target = rawTarget.trim().replace(/^<|>$/g, "");
	if (
		!target ||
		target.startsWith("#") ||
		isAbsolute(target) ||
		/^[a-z][a-z\d+.-]*:/i.test(target)
	) {
		return undefined;
	}
	return decodeURIComponent(target.split("#", 1)[0].split("?", 1)[0]);
}

function hasTopLevelAgentsImport(content) {
	let fence;
	for (const line of content.split(/\r?\n/)) {
		const marker = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/)?.[1];
		if (marker) {
			if (!fence) {
				fence = { character: marker[0], length: marker.length };
			} else if (
				marker[0] === fence.character &&
				marker.length >= fence.length
			) {
				fence = undefined;
			}
			continue;
		}
		if (!fence && line.trim() === "@AGENTS.md") {
			return true;
		}
	}
	return false;
}

async function validateLinks(rootDir, relativePath, content) {
	const errors = [];
	for (const match of content.matchAll(MARKDOWN_LINK)) {
		const target = localLinkTarget(match[1]);
		if (!target) {
			continue;
		}
		const resolved = resolve(rootDir, dirname(relativePath), target);
		if (
			!resolved.startsWith(`${resolve(rootDir)}/`) &&
			resolved !== resolve(rootDir)
		) {
			errors.push(
				`${relativePath}: link escapes repository: ${match[1]}`,
			);
			continue;
		}
		if (!(await exists(resolved))) {
			errors.push(
				`${relativePath}: broken repository-relative link: ${target}`,
			);
		}
	}
	return errors;
}

export async function validateGuidance(rootDir) {
	const errors = [];
	const files = [
		"AGENTS.md",
		"CLAUDE.md",
		"CONTRIBUTING.md",
		".github/PULL_REQUEST_TEMPLATE.md",
		".github/workflows/changeset-check.yml",
		...REQUIRED_NESTED_GUIDANCE.flatMap(({ agents, claude }) => [
			agents,
			claude,
		]),
	];
	const contents = new Map();

	for (const relativePath of files) {
		const absolutePath = resolve(rootDir, relativePath);
		try {
			contents.set(relativePath, await readFile(absolutePath, "utf8"));
		} catch (error) {
			if (error?.code === "ENOENT") {
				errors.push(
					`${relativePath}: required instruction file is missing`,
				);
				continue;
			}
			throw error;
		}
	}

	const agents = contents.get("AGENTS.md");
	if (agents) {
		const lines = new Set(agents.split(/\r?\n/));
		const bytes = Buffer.byteLength(agents);
		if (bytes > MAX_ROOT_BYTES) {
			errors.push(
				`AGENTS.md: ${bytes} bytes exceeds ${MAX_ROOT_BYTES} bytes`,
			);
		}
		for (const requirement of REQUIRED_ROOT_POLICY) {
			if (!lines.has(requirement.clause)) {
				errors.push(
					`AGENTS.md: missing required ${requirement.name} policy`,
				);
			}
		}
	}

	const claude = contents.get("CLAUDE.md");
	if (claude) {
		const bytes = Buffer.byteLength(claude);
		if (bytes > MAX_CLAUDE_BYTES) {
			errors.push(
				`CLAUDE.md: ${bytes} bytes exceeds ${MAX_CLAUDE_BYTES} bytes`,
			);
		}
		if (!hasTopLevelAgentsImport(claude)) {
			errors.push(
				"CLAUDE.md: must delegate shared policy to canonical AGENTS.md",
			);
		}
	}

	for (const { claude: relativePath } of REQUIRED_NESTED_GUIDANCE) {
		const content = contents.get(relativePath);
		if (content !== undefined && content.trim() !== "@AGENTS.md") {
			errors.push(
				`${relativePath}: must be import-only and contain only @AGENTS.md for its local AGENTS.md`,
			);
		}
	}

	const pullRequestTemplate = contents.get(
		".github/PULL_REQUEST_TEMPLATE.md",
	);
	if (
		pullRequestTemplate &&
		(!/^## Local smoke test$/im.test(pullRequestTemplate) ||
			!/automated tests[^\n]*cannot cover/i.test(pullRequestTemplate))
	) {
		errors.push(
			".github/PULL_REQUEST_TEMPLATE.md: missing conditional local smoke-test section",
		);
	}

	const changesetWorkflow = contents.get(
		".github/workflows/changeset-check.yml",
	);
	const trustedReleaseExemption =
		/!\(\s*vars\.RELEASE_APP_LOGIN != ''\s*&&\s*github\.event\.pull_request\.user\.login == vars\.RELEASE_APP_LOGIN\s*&&\s*github\.event\.pull_request\.head\.repo\.full_name == github\.repository\s*&&\s*github\.event\.pull_request\.head\.ref == 'changeset-release\/master'\s*\)/;
	if (changesetWorkflow && !trustedReleaseExemption.test(changesetWorkflow)) {
		errors.push(
			".github/workflows/changeset-check.yml: missing trusted release PR exemption",
		);
	}

	const obsoleteDualContext =
		/every feature[\s\S]{0,160}(?:must|should)[\s\S]{0,160}support[\s\S]{0,160}both[\s\S]{0,160}personal[\s\S]{0,160}(?:and|&)\s*(?:an\s+)?organization/i;
	for (const [relativePath, content] of contents) {
		if (obsoleteDualContext.test(content)) {
			errors.push(
				`${relativePath}: contains obsolete dual-context mandate`,
			);
		}
	}

	for (const [relativePath, content] of contents) {
		if (relativePath === "CONTRIBUTING.md") {
			continue;
		}
		errors.push(...(await validateLinks(rootDir, relativePath, content)));
	}

	return errors;
}

async function main() {
	const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
	const errors = await validateGuidance(rootDir);
	if (errors.length > 0) {
		console.error("Agent guidance validation failed:");
		for (const error of errors) {
			console.error(`- ${error}`);
		}
		process.exitCode = 1;
		return;
	}
	console.log("Agent guidance validation passed.");
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	await main();
}
