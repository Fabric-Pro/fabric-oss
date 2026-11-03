/**
 * "Import project from repository" (specs/2026-10-21-ai-artifacts-hub §3.1
 * step 1): read a GitHub repository the user can reach and propose the new
 * project's name, description, tech stack and phase, and say how many AI
 * tool files it holds (offered for moving right after the import).
 *
 * Read-only: nothing is created here. The import itself is `projects.create`
 * followed by `projects.existingSetup.start`, which connects the repository
 * with the same credential and starts the code analysis.
 *
 * The description is written by the model from the README and manifests;
 * when the model is unavailable it falls back to the repository's own
 * description and the README's first paragraph, so the import never depends
 * on an AI provider.
 *
 * AUTHORIZATION: tenantProtectedProcedure + PROJECT_CREATE in the resolved
 * organization (as `projects.create`), membership verified.
 */
import { ORPCError } from "@orpc/client";
import { generateText, getAIModelWithMetadata } from "@repo/ai";
import { isManifestPath, parseTechStack } from "@repo/atlas";
import { listRepositoryTree, readRepositoryFile } from "@repo/connectors";
import {
	planConsolidation,
	type RepositoryProfile,
	repositoryProfile,
} from "@repo/instructions";
import { getGitHubWorkflowCredential } from "@repo/integrations/github";
import { logger } from "@repo/logs";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";

const MAX_MANIFESTS = 20;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_README_CHARS = 12_000;
const MAX_TECH = 15;

const SYSTEM_PROMPT = `You write the brief of a software project for a delivery platform, from its repository's README and dependency manifests.
Write 3–6 sentences of plain prose: what the product is and who it is for, its main capabilities, and how it is built (architecture and key technologies).
Use only facts present in the input; never invent features, customers or numbers. No headings, no lists, no marketing language.`;

/** Markdown to plain prose: no images, badges, HTML, emphasis or link syntax. */
function plainText(block: string): string {
	return block
		.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/<[^>]+>/g, "")
		.replace(/[*_`]+/g, "")
		.replace(/^\s*[-*+]\s+/gm, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** The README's opening prose, up to about 700 characters: the brief when no model is available. */
function readmeBrief(readme: string): string {
	const parts: string[] = [];
	let length = 0;
	for (const raw of readme.split(/\r?\n\s*\r?\n/)) {
		const block = raw.trim();
		if (
			block === "" ||
			block.startsWith("#") ||
			block.startsWith("```") ||
			block.startsWith("|") ||
			block.startsWith("[!")
		) {
			if (parts.length > 0 && block.startsWith("#")) {
				break;
			}
			continue;
		}
		const text = plainText(block);
		if (text.length < 20) {
			continue;
		}
		parts.push(text);
		length += text.length;
		if (length > 700) {
			break;
		}
	}
	return parts.join("\n\n");
}

/** Package names folded into the technology a person would name. */
const TECH_FAMILIES: [RegExp, string][] = [
	[/^microsoft\.aspnetcore/i, "ASP.NET Core"],
	[/^microsoft\.entityframeworkcore/i, "Entity Framework Core"],
	[/^microsoft\.orleans/i, "Orleans"],
	[/^microsoft\.azure\.cosmos/i, "Azure Cosmos DB"],
	[/^azure\./i, "Azure SDK"],
	[/^react-dom$/i, "React"],
	[/^react$/i, "React"],
	[/^next$/i, "Next.js"],
	[/^vue$/i, "Vue"],
	[/^@angular\/core$/i, "Angular"],
	[/^vite$/i, "Vite"],
	[/^tailwindcss$/i, "Tailwind CSS"],
	[/^typescript$/i, "TypeScript"],
	[/^express$/i, "Express"],
	[/^django$/i, "Django"],
	[/^fastapi$/i, "FastAPI"],
	[/^flask$/i, "Flask"],
];

function familyOf(raw: string): string | null {
	// Manifests can carry a BOM, zero-width characters or surrounding space.
	const name = raw.replace(/[​-‍﻿]/g, "").trim();
	if (/\.(testing|tests?)$|^xunit|^nunit|^moq$/i.test(name)) {
		return null;
	}
	for (const [pattern, family] of TECH_FAMILIES) {
		if (pattern.test(name)) {
			return family;
		}
	}
	return name;
}

function techNames(manifests: { path: string; content: string }[]): string[] {
	const entries = parseTechStack(manifests).filter(
		(entry) =>
			!entry.dev &&
			(entry.kind === "framework" || entry.kind === "runtime"),
	);
	const names: string[] = [];
	for (const entry of entries) {
		const name = familyOf(entry.name);
		if (name && !names.includes(name)) {
			names.push(name);
		}
	}
	return names.slice(0, MAX_TECH);
}

/**
 * The phase a repository suggests, from its file list: application code means
 * the product is being built; documents alone mean it is still being planned.
 * `null` (nothing proposed; the person chooses) when the file list could not
 * be read or holds nothing that counts.
 */
export function proposedPhaseOf(
	profile: RepositoryProfile | null,
): "DEVELOPMENT_EXECUTION" | "DISCOVERY_PLANNING" | null {
	if (!profile || profile.kind === "empty") {
		return null;
	}
	return profile.codeFileCount > 0
		? "DEVELOPMENT_EXECUTION"
		: "DISCOVERY_PLANNING";
}

export const previewRepositoryImportProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.PROJECT_CREATE))
	.route({
		method: "POST",
		path: "/projects/import/preview",
		tags: ["Projects"],
		summary:
			"Propose a project's name, brief, tech stack and phase from a repository",
	})
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
			owner: z.string().regex(/^[A-Za-z0-9-]{1,100}$/),
			repo: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
			/** Omitted for a pasted URL: read from GitHub. */
			defaultBranch: z.string().min(1).max(255).optional(),
			/** The repository's own description and main language, from the picker. */
			description: z.string().max(1000).nullable().optional(),
			language: z.string().max(100).nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		if (
			organizationId &&
			!(await verifyOrganizationMembership(
				organizationId,
				context.user.id,
			))
		) {
			throw new ORPCError("FORBIDDEN", {
				message: "You are not a member of this organization",
			});
		}
		const credential = await getGitHubWorkflowCredential(
			context.user.id,
			organizationId ?? undefined,
		);
		if (!credential) {
			throw new ORPCError("PRECONDITION_FAILED", {
				message:
					"Connect GitHub in your integrations to import a repository.",
				data: { code: "GITHUB_NOT_CONNECTED" },
			});
		}
		// The repository itself: its canonical name, default branch, and the
		// description and language a pasted URL does not carry.
		const meta = await fetch(
			`https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`,
			{
				headers: {
					Authorization: `Bearer ${credential.token}`,
					Accept: "application/vnd.github+json",
					"X-GitHub-Api-Version": "2022-11-28",
				},
				signal: AbortSignal.timeout(15_000),
			},
		).catch(() => null);
		if (!meta?.ok) {
			logger.warn("[projects.import] repository metadata read failed", {
				status: meta?.status ?? null,
				credential: credential.kind,
			});
			throw new ORPCError("BAD_REQUEST", {
				message:
					meta &&
					(meta.status === 404 ||
						meta.status === 403 ||
						meta.status === 401)
						? `Your GitHub connection (${credential.kind === "pat" ? "token" : "sign-in"}) cannot see ${input.owner}/${input.repo}. Check the name, or give the token access to it.`
						: "Couldn't reach GitHub to read the repository. Try again.",
				data: { code: "REPOSITORY_UNREADABLE" },
			});
		}
		const info = (await meta.json()) as {
			name?: string;
			owner?: { login?: string };
			html_url?: string;
			default_branch?: string;
			description?: string | null;
			language?: string | null;
		};
		const owner = info.owner?.login ?? input.owner;
		const repoName = info.name ?? input.repo;
		const defaultBranch =
			input.defaultBranch ?? info.default_branch ?? "main";
		const repoDescription = input.description ?? info.description ?? null;
		const language = input.language ?? info.language ?? null;
		const repository = {
			provider: "GITHUB" as const,
			token: credential.token,
			repositoryUrl: `https://github.com/${owner}/${repoName}`,
			owner,
			repo: repoName,
			branch: defaultBranch,
		};
		// The repository itself was read above, so a tree that does not come
		// back in time (a large repository, a slow answer) only costs the
		// proposal its stack and file count: the README is read by name.
		const tree = await listRepositoryTree(repository);
		if (!tree.ok) {
			logger.warn("[projects.import] repository tree read failed", {
				outcome: tree.outcome,
				sizeKb: (info as { size?: number }).size ?? null,
			});
		}
		const files = tree.ok
			? tree.entries.filter((entry) => entry.type === "file")
			: [{ path: "README.md", type: "file" as const }];
		const read = async (path: string) => {
			const result = await readRepositoryFile({
				...repository,
				path,
				maxBytes: MAX_FILE_BYTES,
			});
			return result.ok && result.state === "found"
				? Buffer.from(result.bytes).toString("utf8")
				: null;
		};

		const readmePath =
			files.find((f) => /^readme(\.md|\.markdown|\.txt)?$/i.test(f.path))
				?.path ?? null;
		const manifestPaths = files
			.map((f) => f.path)
			.filter(
				(path) =>
					isManifestPath(path) &&
					path.split("/").length <= 4 &&
					!/(^|\/)(node_modules|vendor|dist|build|test|tests|examples?)\//i.test(
						path,
					),
			)
			.sort((a, b) => a.split("/").length - b.split("/").length)
			.slice(0, MAX_MANIFESTS);
		const [readme, ...manifestContents] = await Promise.all([
			readmePath ? read(readmePath) : Promise.resolve(null),
			...manifestPaths.map(read),
		]);
		const manifests = manifestPaths
			.map((path, i) => ({ path, content: manifestContents[i] ?? null }))
			.filter(
				(m): m is { path: string; content: string } =>
					m.content !== null,
			);

		const techStack = techNames(manifests);
		if (language && !techStack.includes(language)) {
			techStack.unshift(language);
		}

		const fallback = [
			repoDescription?.trim(),
			readme ? readmeBrief(readme) : "",
		]
			.filter((part): part is string => !!part)
			.join("\n\n");
		let description = fallback;
		let generated = false;
		if (readme || manifests.length > 0) {
			try {
				const { model, trackUsage } = await getAIModelWithMetadata(
					{ taskType: "SIMPLE", complexity: "medium" },
					{
						userId: context.user.id,
						organizationId: organizationId ?? undefined,
						jobType: "context-summarization",
					},
				);
				const result = await generateText({
					model,
					instructions: SYSTEM_PROMPT,
					prompt: [
						`Repository: ${owner}/${repoName}`,
						repoDescription
							? `GitHub description: ${repoDescription}`
							: "",
						`Detected technologies: ${techStack.join(", ") || "unknown"}`,
						readme
							? `README:\n${readme.slice(0, MAX_README_CHARS)}`
							: "",
						...manifests
							.slice(0, 5)
							.map(
								(m) =>
									`Manifest ${m.path}:\n${m.content.slice(0, 2000)}`,
							),
					]
						.filter(Boolean)
						.join("\n\n"),
				});
				trackUsage();
				if (result.text.trim().length > 0) {
					description = result.text.trim();
					generated = true;
				}
			} catch (error) {
				logger.warn(
					"[projects.import] brief generation failed; using README",
					{
						error:
							error instanceof Error ? error.name : typeof error,
					},
				);
			}
		}

		const plan = planConsolidation(
			files.map((f) => ({
				path: f.path,
				...(f.blobId ? { oid: f.blobId } : {}),
				...(f.mode ? { mode: f.mode } : {}),
			})),
		);
		const projectPhase = proposedPhaseOf(
			tree.ok ? repositoryProfile(files.map((f) => f.path)) : null,
		);
		return {
			repository: {
				owner,
				name: repoName,
				htmlUrl: info.html_url ?? repository.repositoryUrl,
				defaultBranch,
			},
			name: repoName,
			description,
			descriptionGenerated: generated,
			techStack,
			projectPhase,
			aiFileCount: plan.items.filter((item) => item.defaultIncluded)
				.length,
		};
	});
