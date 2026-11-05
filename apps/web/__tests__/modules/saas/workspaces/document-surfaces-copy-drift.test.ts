// @vitest-environment node
/** The document and generated-page product names must stay aligned with their routes and tools. */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
const WEB = path.resolve(__dirname, "../../../..");
const read = (file: string) => readFileSync(path.join(WEB, file), "utf8");
function sources(directory: string): string[] {
	return readdirSync(path.join(WEB, directory), {
		withFileTypes: true,
	}).flatMap((entry) =>
		entry.isDirectory() && entry.name !== "__tests__"
			? sources(`${directory}/${entry.name}`)
			: entry.isFile() && /\.tsx?$/.test(entry.name)
				? [`${directory}/${entry.name}`]
				: [],
	);
}
describe("document Workspaces and generated Pages", () => {
	it("keeps document-workspace copy and routes distinct from Pages", () => {
		const copy = sources("modules/saas/workspaces").map(read).join("\n");
		expect(copy).not.toMatch(/\b[Ll]ibrar(?:y|ies)\b/);
		expect(copy).toContain("documentWorkspaces");
		expect(
			read("modules/saas/workspaces/components/WorkspaceCard.tsx"),
		).toContain("/workspaces/");
		expect(
			read(
				"modules/saas/workspaces/components/WorkspaceDocumentChatDialog.tsx",
			),
		).toContain("/api/workspaces/chat");
	});
	it("names generated pages Pages and sends their links to /pages", () => {
		expect(read("modules/saas/pages/components/PagesHero.tsx")).toContain(
			'title="Pages"',
		);
		const list = read("modules/saas/pages/components/PagesList.tsx");
		expect(list).toContain("/pages/");
		expect(list).toContain("New page");
		expect(
			read("modules/saas/pages/components/PageCopyButton.tsx"),
		).toContain("/pages/");
	});
	it("explains both features without telling document users to open Pages", () => {
		const documents = read("content/docs/features/libraries.mdx");
		const pages = read("content/docs/features/workspace-pages.mdx");
		expect(documents).toMatch(/title: Workspaces/);
		expect(documents).toContain("New Workspace");
		expect(pages).toMatch(/title: Pages/);
		expect(pages).toContain("**[Workspaces]");
		expect(documents).not.toContain("Workspaces in the sidebar are now");
	});
});
