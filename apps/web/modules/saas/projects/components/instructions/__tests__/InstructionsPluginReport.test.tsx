/**
 * What a coding-tool plugin leaves out of the published instructions, shown to
 * the admin who reads the Coding Instructions tab: nothing at all when the
 * plugin carries everything, otherwise how many files it leaves out, behind a
 * toggle, each with its path and the reason in plain words, and where the
 * standard layout is described.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", async () =>
	(await import("../../../__tests__/en-copy")).nextIntlMock(),
);

const { reportMock } = vi.hoisted(() => ({ reportMock: vi.fn() }));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			instructions: {
				getPluginReport: {
					queryOptions: (options: { input: unknown }) => ({
						...options,
						queryKey: ["pluginReport", options.input],
						queryFn: () => reportMock(options.input),
					}),
				},
			},
		},
	},
}));

import { InstructionsPluginReport } from "../InstructionsPluginReport";

const READY = {
	state: "ready",
	mode: "UPLOAD",
	carriedCount: 9,
	rulesCount: 2,
	leftOutCount: 3,
	leftOut: [
		{ path: "docs/guide.md", reason: "outside-plugin-folders" },
		{ path: "skills/loose.md", reason: "skill-needs-folder" },
		{ path: "skills/deploy/logo.png", reason: "not-text" },
	],
	truncated: false,
};

function mount() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<InstructionsPluginReport projectId="project_1" />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	reportMock.mockReset();
});

describe("InstructionsPluginReport", () => {
	it("says nothing when the plugin carries every file", async () => {
		reportMock.mockResolvedValue({
			...READY,
			leftOutCount: 0,
			leftOut: [],
		});

		const { container } = mount();
		await vi.waitFor(() => expect(reportMock).toHaveBeenCalled());

		expect(container).toBeEmptyDOMElement();
	});

	it.each([["nothing-published"], ["unavailable"]])(
		"says nothing while the answer is %s",
		async (state) => {
			reportMock.mockResolvedValue({
				...READY,
				state,
				leftOutCount: 0,
				leftOut: [],
			});

			const { container } = mount();
			await vi.waitFor(() => expect(reportMock).toHaveBeenCalled());

			expect(container).toBeEmptyDOMElement();
		},
	);

	it("asks for the project's report", async () => {
		reportMock.mockResolvedValue(READY);

		mount();

		await screen.findByRole("button", {
			name: /3 files are not delivered to coding tools/,
		});
		expect(reportMock).toHaveBeenCalledWith({ projectId: "project_1" });
	});

	it("counts the files the plugin leaves out, folded away until asked", async () => {
		reportMock.mockResolvedValue(READY);
		const user = userEvent.setup();
		mount();

		const toggle = await screen.findByRole("button", {
			name: /3 files are not delivered to coding tools/,
		});

		expect(toggle).toHaveAttribute("aria-expanded", "false");
		expect(screen.queryByText("docs/guide.md")).not.toBeInTheDocument();

		await user.click(toggle);

		expect(toggle).toHaveAttribute("aria-expanded", "true");
		expect(screen.getByText("docs/guide.md")).toBeInTheDocument();
	});

	it("gives each path its reason in plain words", async () => {
		reportMock.mockResolvedValue(READY);
		const user = userEvent.setup();
		mount();
		await user.click(await screen.findByRole("button"));

		const rows = screen.getAllByRole("listitem");

		expect(rows).toHaveLength(3);
		expect(within(rows[0]).getByText("docs/guide.md")).toBeVisible();
		expect(rows[0]).toHaveTextContent(
			/skills\/, agents\/, commands\/ or rules\//,
		);
		expect(rows[1]).toHaveTextContent(/skills\/<name>\/SKILL\.md/);
		expect(rows[2]).toHaveTextContent(/not a text file/i);
	});

	it("points at the standard layout", async () => {
		reportMock.mockResolvedValue(READY);
		const user = userEvent.setup();
		mount();
		await user.click(await screen.findByRole("button"));

		expect(
			screen.getByText(/skills\/<name>\/SKILL\.md/, {
				selector: "p",
			}),
		).toHaveTextContent(/agents\/<name>\.md/);
	});

	it("uses the singular for one file", async () => {
		reportMock.mockResolvedValue({
			...READY,
			leftOutCount: 1,
			leftOut: [READY.leftOut[0]],
		});

		mount();

		expect(
			await screen.findByRole("button", {
				name: /1 file is not delivered to coding tools/,
			}),
		).toBeInTheDocument();
	});

	it("says when the list was cut", async () => {
		reportMock.mockResolvedValue({
			...READY,
			leftOutCount: 450,
			truncated: true,
		});
		const user = userEvent.setup();
		mount();

		await user.click(
			await screen.findByRole("button", {
				name: /450 files are not delivered/,
			}),
		);

		expect(screen.getByText(/first 3 of 450/i)).toBeInTheDocument();
	});
});
