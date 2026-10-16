// @vitest-environment node
/**
 * Document libraries were called Workspaces until Workspaces became the pages
 * Fabric Agent writes. A person reading "Go to Workspaces -> Create Workspace"
 * for a document library lands on the wrong feature, so user-facing copy that
 * means a library must say library. These checks read the copy itself - the
 * app's strings, the translations and the docs - instead of trusting that the
 * rename was finished by hand, and fail on a leftover.
 *
 * Not caught on purpose: "workspace" for the whole organization or for another
 * product's workspace (Slack, Notion, Google), identifiers a client still sends
 * (`/workspaces`, `workspaceIds`, `fabric_list_workspaces`), and the pages that
 * explain the rename.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const WEB_ROOT = path.resolve(__dirname, "../../../..");
const REPO_ROOT = path.resolve(WEB_ROOT, "../..");

function walk(directory: string, extensions: string[]): string[] {
	const found: string[] = [];
	for (const name of readdirSync(directory)) {
		if (
			name === "node_modules" ||
			name === ".next" ||
			name === "__tests__"
		) {
			continue;
		}
		const full = path.join(directory, name);
		if (statSync(full).isDirectory()) {
			found.push(...walk(full, extensions));
		} else if (extensions.some((extension) => name.endsWith(extension))) {
			found.push(full);
		}
	}
	return found;
}

const relative = (file: string) =>
	path.relative(REPO_ROOT, file).replaceAll("\\", "/");

/** The text a person can read in a source file: its code and strings, not its comments. */
function readCopy(file: string): string {
	const text = readFileSync(file, "utf8");
	return /\.tsx?$/.test(file)
		? text
				.replace(/\/\*[\s\S]*?\*\//g, "")
				.replace(/(^|[^:])\/\/.*$/gm, "$1")
		: text;
}

/** Phrases that can only mean a document library, in any user-facing string. */
const LIBRARY_CALLED_WORKSPACE: Array<[string, RegExp]> = [
	["Document Workspaces", /Document Workspaces/],
	["Workspaces & integrations", /Workspaces (&|and|&amp;) integrations/i],
	["Connected workspaces", /Connected workspaces/i],
	["Select a workspace", /Select a workspace/i],
	["select workspaces ... via RAG", /select workspaces to provide/i],
	["documents and workspaces", /documents and workspaces/i],
	["Workspace document chat", /Workspace(-| )?(document chat|Dokumentchat)/i],
	["Browse workspaces", /Browse workspaces/i],
	["N workspaces available", /\bworkspaces? available\b/i],
];

describe("the app's strings call a document library a library", () => {
	const sources = [
		...walk(path.join(WEB_ROOT, "modules"), [".ts", ".tsx"]),
		...walk(path.join(WEB_ROOT, "app"), [".ts", ".tsx"]),
		path.join(REPO_ROOT, "packages/i18n/translations/en.json"),
		path.join(REPO_ROOT, "packages/i18n/translations/de.json"),
	];

	it("finds the sources it is meant to read", () => {
		expect(sources.length).toBeGreaterThan(500);
		expect(
			sources.some((file) => file.endsWith("CreateInstanceDialog.tsx")),
		).toBe(true);
		expect(sources.some((file) => file.endsWith("en.json"))).toBe(true);
	});

	it.each(LIBRARY_CALLED_WORKSPACE)("has no '%s'", (_label, phrase) => {
		const offenders = sources
			.filter((file) => !file.endsWith("libraries-copy-drift.test.ts"))
			.filter((file) => phrase.test(readCopy(file)))
			.map(relative);

		expect(offenders).toEqual([]);
	});
});

describe("the docs call a document library a library", () => {
	const DOCS_ROOT = path.join(WEB_ROOT, "content/docs");
	const docs = walk(DOCS_ROOT, [".mdx"]);

	/**
	 * Pages that mention the old name on purpose: the API reference keeps the
	 * `/workspaces` routes and scopes clients still use, the glossary and the
	 * Libraries page explain the rename, the Workspaces page says what it is not,
	 * and the prompts page uses "workspace" for the whole organization.
	 */
	const EXPLAINS_THE_OLD_NAME = [
		/^api\/overview(\.de)?\.mdx$/,
		/^glossary(\.de)?\.mdx$/,
		/^features\/libraries(\.de)?\.mdx$/,
		/^features\/workspace-pages(\.de)?\.mdx$/,
		/^features\/prompts(\.de)?\.mdx$/,
	];
	const ANOTHER_PRODUCTS_WORKSPACE =
		/slack|notion|google|linear|atlassian|jira/i;
	const MEANS_DOCUMENTS =
		/\bdocuments?\b|\bRAG\b|\bupload|\battach|\bDokument|hochlad|anh.ngen/i;
	const WORKSPACE_WORD = /\bworkspaces?\b|\bWorkspaces?\b|-Workspace\b/i;

	it("finds the docs it is meant to read", () => {
		expect(docs.length).toBeGreaterThan(80);
		expect(
			docs.some((file) =>
				file.replaceAll("\\", "/").endsWith("core-concepts/rag.de.mdx"),
			),
		).toBe(true);
	});

	it("never calls a library a workspace outside the pages that explain the rename", () => {
		const offenders: string[] = [];
		for (const file of docs) {
			const name = path.relative(DOCS_ROOT, file).replaceAll("\\", "/");
			if (EXPLAINS_THE_OLD_NAME.some((pattern) => pattern.test(name))) {
				continue;
			}
			readFileSync(file, "utf8")
				.split("\n")
				.forEach((line, index) => {
					if (
						WORKSPACE_WORD.test(line) &&
						MEANS_DOCUMENTS.test(line) &&
						!ANOTHER_PRODUCTS_WORKSPACE.test(line) &&
						!/`[^`]*workspace[^`]*`/i.test(line)
					) {
						offenders.push(`${name}:${index + 1}: ${line.trim()}`);
					}
				});
		}

		expect(offenders).toEqual([]);
	});

	it("keeps the German twin of the RAG page in step with the English one", () => {
		const german = readFileSync(
			path.join(DOCS_ROOT, "core-concepts/rag.de.mdx"),
			"utf8",
		);

		expect(german).not.toMatch(/Workspace/);
		expect(german).toMatch(/Bibliothek/);
	});
});
