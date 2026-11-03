/**
 * RAG Settings → per-type chunking (spec 2026-10-28 §6, §8a): the table of
 * content types shows only while the flag is on, every type starts on
 * Custom with the project's values, and saving a chunking change asks first
 * because it re-chunks the whole project.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	settings: {} as Record<string, unknown>,
	flag: true,
	mutate: vi.fn(),
}));

vi.mock("next-intl", () => ({
	useTranslations: () => {
		const t = (key: string) => key;
		t.raw = () => ({ title: "t", description: "d", confirm: "c" });
		return t;
	},
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({ organizationId: "org-example" }),
}));
vi.mock("../ProjectRepositoryIntegrationSettings", () => ({
	CodeSearchModeSetting: () => <div>How AI agents search code</div>,
}));

vi.mock("@shared/lib/orpc-query-utils", () => {
	const proc = (name: string) => ({
		queryOptions: () => ({ queryKey: [name] }),
		queryKey: () => [name],
		mutationOptions: () => ({}),
	});
	return {
		orpc: {
			projects: {
				ragSettings: {
					get: proc("get"),
					update: proc("update"),
					reprocess: proc("reprocess"),
					rechunkPreview: proc("rechunkPreview"),
					chunkingRuns: proc("chunkingRuns"),
					chunkingCheck: proc("chunkingCheck"),
					chunkingQuality: proc("chunkingQuality"),
					startChunkingAnalysis: proc("startChunkingAnalysis"),
					confirmChunkingAnalysis: proc("confirmChunkingAnalysis"),
					applyChunkingProposal: proc("applyChunkingProposal"),
					chunkingSources: proc("chunkingSources"),
				},
			},
			agents: { codeIndex: { status: proc("codeIndexStatus") } },
		},
	};
});

vi.mock("@tanstack/react-query", () => ({
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
	useMutation: (options: { mutationKey?: unknown }) => ({
		mutate: m.mutate,
		isPending: false,
		options,
	}),
	useQuery: (options: { queryKey: string[] }) => {
		switch (options.queryKey[0]) {
			case "get":
				return {
					isLoading: false,
					data: {
						settings: m.settings,
						contentAwareChunkingEnabled: m.flag,
					},
				};
			case "rechunkPreview":
				return {
					isLoading: false,
					data: {
						contexts: 12,
						documents: 3,
						characters: 40000,
						estimatedTokens: 10000,
					},
				};
			case "chunkingQuality":
				return {
					isLoading: false,
					data: {
						byType: [
							{
								contentType: "backlog",
								sources: 2,
								chunks: 9,
								sizes: {
									min: 120,
									p50: 900,
									p90: 2900,
									max: 3000,
								},
								profiles: ["setting"],
							},
						],
						problems: {
							cutMidSentence: 4,
							cutMidListItem: 7,
							splitTables: 0,
							tinyChunks: 1,
							notEmbedded: 0,
							truncatedKnowledge: {
								entries: 0,
								charactersLost: 0,
							},
						},
						examples: {},
						truncated: false,
						telemetry: null,
					},
				};
			case "chunkingSources":
				return {
					isLoading: false,
					data: {
						total: 2,
						rows: [
							{
								id: "c1",
								title: "docs/backlog.md",
								origin: "context",
								location: "docs/backlog.md",
								characters: 4200,
								chunks: 5,
								embedded: true,
								chunkedBy: ["setting"],
							},
						],
					},
				};
			case "codeIndexStatus":
				return { data: { filesIndexed: 120 } };
			default:
				return { data: { rechunk: null } };
		}
	},
}));

import { RagSettingsForm } from "../RagSettingsForm";

beforeEach(() => {
	vi.clearAllMocks();
	m.flag = true;
	m.settings = {
		chunkSize: 3000,
		chunkOverlap: 500,
		splitMethod: "DOCUMENT",
		embeddingModel: "TEXT_EMBEDDING_3_SMALL",
		topK: 50,
		similarityThreshold: 0.3,
		enableReranking: true,
		chunkByContentType: false,
	};
});

describe("RagSettingsForm content-type chunking", () => {
	it("shows the per-type table read-only while the flag is off", () => {
		m.flag = false;
		render(<RagSettingsForm projectId="p1" />);
		expect(screen.queryByText("Chunking by content type")).toBeNull();
		expect(screen.getByText("Chunks by content type")).toBeTruthy();
		// Without per-type rows the project values are the project's chunking.
		expect(screen.getByText("Split Method")).toBeTruthy();
	});

	it("starts every type on Custom with the project's values", () => {
		render(<RagSettingsForm projectId="p1" />);
		expect(
			screen.getByRole("combobox", { name: "Chunking for backlog" }),
		).toHaveTextContent("Custom");
		// The project-wide block is gone; each Custom row shows where it starts.
		expect(screen.queryByText("Split Method")).toBeNull();
		expect(
			screen.getByRole("combobox", { name: "Split method for backlog" }),
		).toHaveTextContent("Document (project)");
		expect(screen.getByLabelText("Chunk size for backlog")).toHaveAttribute(
			"placeholder",
			"3000 size",
		);
		expect(
			screen.getByLabelText("Chunk overlap for backlog"),
		).toHaveAttribute("placeholder", "500 overlap");
	});

	it("saves a Custom type's own size", () => {
		render(<RagSettingsForm projectId="p1" />);
		fireEvent.change(screen.getByLabelText("Chunk size for backlog"), {
			target: { value: "1200" },
		});
		fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
		fireEvent.click(
			screen.getByRole("button", { name: "Save and re-chunk" }),
		);
		expect(m.mutate).toHaveBeenCalledWith(
			expect.objectContaining({
				chunkProfiles: { backlog: { custom: true, chunkSize: 1200 } },
			}),
		);
	});

	it("shows the code search mode setting on RAG Settings too", () => {
		render(<RagSettingsForm projectId="p1" />);
		expect(screen.getByText("How AI agents search code")).toBeTruthy();
	});

	it("asks before saving a chunking change and shows what will be re-chunked", () => {
		m.settings.chunkProfiles = { backlog: { profile: "items" } };
		render(<RagSettingsForm projectId="p1" />);

		fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
		fireEvent.change(screen.getByLabelText("Target size for backlog"), {
			target: { value: "1500" },
		});
		fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

		expect(m.mutate).not.toHaveBeenCalled();
		expect(screen.getByText("Re-chunk this project?")).toBeTruthy();
		expect(screen.getByText(/12 context sources/)).toBeTruthy();
		expect(screen.getByText(/3 documents/)).toBeTruthy();

		fireEvent.click(
			screen.getByRole("button", { name: "Save and re-chunk" }),
		);
		expect(m.mutate).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "p1",
				chunkProfiles: { backlog: { profile: "items", target: 1500 } },
			}),
		);
	});

	it("shows the chunking quality in the per-type table, even with the flag off", () => {
		m.flag = false;
		render(<RagSettingsForm projectId="p1" />);
		expect(screen.getByText("backlog")).toBeTruthy();
		expect(screen.getByText("900 / 2,900 / 3,000")).toBeTruthy();
		expect(screen.getByText(/7 cut a list item/)).toBeTruthy();
		// Read-only without per-type chunking: no choice to make.
		expect(
			screen.queryByRole("combobox", { name: "Chunking for backlog" }),
		).toBeNull();
	});

	it("opens the sources of a type from its count", () => {
		render(<RagSettingsForm projectId="p1" />);
		fireEvent.click(
			screen.getByRole("button", {
				name: "Show the 2 sources of backlog",
			}),
		);
		expect(screen.getByText("Sources chunked as backlog")).toBeTruthy();
		expect(screen.getAllByText("docs/backlog.md").length).toBeGreaterThan(
			0,
		);
	});

	it("lists repository code only when the project searches code by RAG", () => {
		const { unmount } = render(<RagSettingsForm projectId="p1" />);
		expect(screen.queryByText("code")).toBeNull();
		unmount();
		m.settings = { ...m.settings, codeSearchMode: "RAG" };
		render(<RagSettingsForm projectId="p1" />);
		expect(screen.getByText("code")).toBeTruthy();
		expect(screen.getByText("120")).toBeTruthy();
	});
});

it("loads and saves the source limit while reranking is off", () => {
	m.settings.rerankTopK = 7;
	m.settings.enableReranking = false;
	render(<RagSettingsForm projectId="p1" />);
	const slider = screen.getByRole("slider", {
		name: "Maximum sources returned",
	});
	expect(slider.getAttribute("aria-valuenow")).toBe("7");
	expect(screen.getByText("Candidate chunks")).toBeTruthy();
	fireEvent.keyDown(slider, { key: "ArrowRight" });
	fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
	expect(m.mutate).toHaveBeenCalledWith(
		expect.objectContaining({ rerankTopK: 8 }),
	);
	expect(
		screen
			.getAllByRole("slider")
			.some((s) => s.getAttribute("aria-valuemax") === "100"),
	).toBe(true);
});

it("explains the semantic similarity floor and the keyword exception", () => {
	render(<RagSettingsForm projectId="p1" />);
	expect(screen.getByText("Minimum semantic similarity")).toBeTruthy();
	expect(
		screen.getByText(
			"Minimum similarity for semantic matches. Keyword matches are kept regardless.",
		),
	).toBeTruthy();
});
