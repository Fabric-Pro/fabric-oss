import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	prompt: null as Record<string, unknown> | null,
	runs: {} as Record<string, { status: string } | null>,
	ask: vi.fn(),
}));

vi.mock("@shared/lib/orpc-query-utils", () => {
	const proc = (name: string) => ({
		queryOptions: () => ({ queryKey: [name] }),
	});
	return {
		orpc: {
			projects: {
				ragSettings: {
					chunkingCheck: proc("chunkingCheck"),
					chunkingRuns: proc("chunkingRuns"),
				},
			},
		},
	};
});

vi.mock("@tanstack/react-query", () => ({
	useQuery: (options: { queryKey: string[] }) =>
		options.queryKey[0] === "chunkingCheck"
			? { data: { prompt: m.prompt } }
			: { data: m.runs },
}));

vi.mock("../ChunkingAnalysis", () => ({
	useChunkingAnalysis: () => ({ ask: m.ask, starting: false, dialog: null }),
}));

import { ChunkingCheckPrompt } from "../ChunkingCheckPrompt";

const base = {
	lastCheckedAt: "2026-01-10T00:00:00.000Z",
	sources: 240,
	sourcesAtLastCheck: 100,
	addedSince: 140,
	embeddingModel: "model-b",
	embeddingModelAtLastCheck: "model-a",
};

beforeEach(() => {
	vi.clearAllMocks();
	window.localStorage.clear();
	m.prompt = null;
	m.runs = {};
});

describe("ChunkingCheckPrompt", () => {
	it("shows nothing when the server sees no reason to check", () => {
		const { container } = render(<ChunkingCheckPrompt projectId="p1" />);
		expect(container).toBeEmptyDOMElement();
	});

	it("explains the change in plain words and runs a check on Check now", () => {
		m.prompt = { reason: "content-changed", ...base };
		render(<ChunkingCheckPrompt projectId="p1" />);
		expect(
			screen.getByText("This project's content changed a lot"),
		).toBeInTheDocument();
		expect(screen.getByText(/from 100 to 240 sources/)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Check now" }));
		expect(m.ask).toHaveBeenCalledWith("MEASURE");
	});

	it("remembers Not now, but a model change still shows through it", () => {
		m.prompt = { reason: "content-changed", ...base };
		const { unmount } = render(<ChunkingCheckPrompt projectId="p1" />);
		fireEvent.click(screen.getByRole("button", { name: "Not now" }));
		expect(screen.queryByText("Check now")).not.toBeInTheDocument();
		unmount();

		render(<ChunkingCheckPrompt projectId="p1" />);
		expect(screen.queryByText("Check now")).not.toBeInTheDocument();

		m.prompt = { reason: "model-changed", ...base };
		render(<ChunkingCheckPrompt projectId="p1" />);
		expect(
			screen.getByText(
				"Your organization switched to a new search model",
			),
		).toBeInTheDocument();
	});

	it("stays out of the way while a check or re-chunk is running", () => {
		m.prompt = { reason: "stale", ...base };
		m.runs = { rechunk: { status: "RUNNING" } };
		const { container } = render(<ChunkingCheckPrompt projectId="p1" />);
		expect(container).toBeEmptyDOMElement();
	});

	it("on the overview, leads to the retrieval settings instead", () => {
		m.prompt = { reason: "never-checked", ...base };
		render(
			<ChunkingCheckPrompt
				projectId="p1"
				settingsHref="/settings/retrieval"
			/>,
		);
		expect(screen.getByRole("link", { name: "Check now" })).toHaveAttribute(
			"href",
			"/settings/retrieval",
		);
	});
});
