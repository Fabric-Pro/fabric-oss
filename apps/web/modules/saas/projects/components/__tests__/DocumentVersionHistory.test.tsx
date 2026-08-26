/**
 * DocumentVersionHistory — version authorship rendering.
 *
 * Before U5 this panel rendered the literal string "Editor" for every version
 * that had any `changedBy` at all, so no version ever showed a real author. The
 * server now resolves `author: { kind, name }` and the panel renders it.
 *
 * What these tests pin:
 *  - a human's name renders (not "Editor", not a raw id);
 *  - the auto-refresh agent renders as a NAMED, visually distinct identity — a
 *    different icon AND the brand accent — so it cannot be mistaken for a
 *    teammate (R13);
 *  - a legacy row with no author renders no author line rather than crashing.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listVersions = vi.fn();

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({ organizationId: "org-1" }),
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			documents: {
				get: { queryKey: () => ["document"] },
				versions: {
					list: {
						queryOptions: () => ({
							queryKey: ["versions"],
							queryFn: () => listVersions(),
						}),
						queryKey: () => ["versions"],
					},
					restore: {
						mutationOptions: (opts: unknown) => ({
							mutationFn: async () => ({}),
							...(opts as Record<string, unknown>),
						}),
					},
				},
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

// The real diff viewer drags in TipTap; it is not under test here.
vi.mock("../VersionDiffViewer", () => ({
	VersionDiffViewer: () => null,
}));

import { DocumentVersionHistory } from "../DocumentVersionHistory";

const version = (overrides: Record<string, unknown> = {}) => ({
	id: "ver-1",
	version: 1,
	content: "some words here",
	changeDescription: null,
	changedBy: "user-1",
	author: { kind: "HUMAN", name: "Ada Lovelace" },
	createdAt: "2026-07-01T00:00:00.000Z",
	promptVersion: null,
	...overrides,
});

const renderPanel = () =>
	render(
		<QueryClientProvider
			client={
				new QueryClient({
					defaultOptions: { queries: { retry: false } },
				})
			}
		>
			<DocumentVersionHistory
				open={true}
				onOpenChange={vi.fn()}
				projectId="p1"
				documentId="doc-1"
				currentVersion={3}
				currentContent="current"
			/>
		</QueryClientProvider>,
	);

/** The rendered author line for a given display name. */
const authorLine = (name: string) => screen.getByText(name).closest("span");

/**
 * All rendered text. NOT `render()`'s `container` — the panel is a Radix Sheet,
 * which portals its content to `document.body`, leaving `container` empty. A
 * `container.textContent` assertion here would pass vacuously.
 */
const renderedText = () => document.body.textContent ?? "";

beforeEach(() => {
	vi.clearAllMocks();
});

describe("DocumentVersionHistory — author", () => {
	it("renders a human author's name, not the old hardcoded 'Editor'", async () => {
		listVersions.mockResolvedValue({
			versions: [
				version({ author: { kind: "HUMAN", name: "Ada Lovelace" } }),
			],
		});

		renderPanel();

		expect(await screen.findByText("Ada Lovelace")).toBeInTheDocument();
		expect(screen.queryByText("Editor")).not.toBeInTheDocument();
	});

	it("never renders the raw changedBy id", async () => {
		listVersions.mockResolvedValue({
			versions: [
				version({
					changedBy: "clx0000000rawuserid",
					author: { kind: "HUMAN", name: "Ada Lovelace" },
				}),
			],
		});

		renderPanel();

		await screen.findByText("Ada Lovelace");
		expect(renderedText()).not.toContain("clx0000000rawuserid");
	});

	it("renders the refresh agent by name", async () => {
		listVersions.mockResolvedValue({
			versions: [
				version({
					changedBy: "agent:living-docs-refresh",
					author: { kind: "AI_AGENT", name: "Fabric Refresh Agent" },
				}),
			],
		});

		renderPanel();

		expect(
			await screen.findByText("Fabric Refresh Agent"),
		).toBeInTheDocument();
	});

	it("distinguishes the agent from a person by icon AND accent, not by name alone", async () => {
		listVersions.mockResolvedValue({
			versions: [
				version({
					id: "ver-2",
					version: 2,
					changedBy: "agent:living-docs-refresh",
					author: { kind: "AI_AGENT", name: "Fabric Refresh Agent" },
				}),
				version({
					id: "ver-1",
					version: 1,
					author: { kind: "HUMAN", name: "Ada Lovelace" },
				}),
			],
		});

		renderPanel();

		await screen.findByText("Fabric Refresh Agent");

		const agent = authorLine("Fabric Refresh Agent");
		const human = authorLine("Ada Lovelace");

		// Different icon: the agent gets a bot glyph, the person a user glyph.
		expect(agent?.querySelector("svg.lucide-bot")).toBeTruthy();
		expect(agent?.querySelector("svg.lucide-user")).toBeFalsy();
		expect(human?.querySelector("svg.lucide-user")).toBeTruthy();
		expect(human?.querySelector("svg.lucide-bot")).toBeFalsy();

		// Different emphasis: the agent carries the brand accent, the person
		// stays in the muted metadata row.
		expect(agent?.className).toContain("text-primary");
		expect(human?.className).not.toContain("text-primary");

		// The distinction is NOT color-only — the icon above and the name itself
		// both carry it. Guard that the two names never collapse into one label.
		expect(renderedText()).toContain("Ada Lovelace");
		expect(renderedText()).toContain("Fabric Refresh Agent");
	});

	it("renders a legacy version with no author without crashing", async () => {
		listVersions.mockResolvedValue({
			versions: [version({ changedBy: null, author: null, version: 1 })],
		});

		renderPanel();

		// The version row itself still renders...
		expect(await screen.findByText("v1")).toBeInTheDocument();
		// ...with no author line at all (and certainly not the old "Editor").
		expect(screen.queryByText("Editor")).not.toBeInTheDocument();
		expect(document.querySelector("svg.lucide-user")).toBeNull();
		expect(document.querySelector("svg.lucide-bot")).toBeNull();
	});

	it("renders a deleted user's neutral fallback name as given by the server", async () => {
		listVersions.mockResolvedValue({
			versions: [
				version({
					changedBy: "clxdeleted00000000",
					author: { kind: "HUMAN", name: "Unknown user" },
				}),
			],
		});

		renderPanel();

		expect(await screen.findByText("Unknown user")).toBeInTheDocument();
		expect(renderedText()).not.toContain("clxdeleted00000000");
	});
});
