import en from "@repo/i18n/translations/en.json";
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";

const m = vi.hoisted(() => ({
	assemble: vi.fn(),
	download: vi.fn(),
	queries: vi.fn(),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { projects: { contexts: { assemble: m.assemble } } },
}));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		documentWorkspaces: {
			list: {
				queryOptions: (options: object) => ({
					name: "workspaces",
					...options,
				}),
			},
			documents: {
				list: {
					queryOptions: (options: object) => ({
						name: "documents",
						...options,
					}),
				},
			},
		},
	},
}));
vi.mock("@tanstack/react-query", () => ({
	useQuery: (options: unknown) => m.queries(options),
}));
vi.mock("../../lib/markdown-to-document", () => ({
	triggerBlobDownload: m.download,
}));
vi.mock("next-intl", () => ({
	useTranslations: () => (key: string, values?: Record<string, unknown>) => {
		const value =
			en.projects.contexts.selection[
				key as keyof typeof en.projects.contexts.selection
			];
		return (
			value?.replace(/\{(\w+)\}/g, (_, name) =>
				String(values?.[name] ?? name),
			) ?? key
		);
	},
}));

import { ContextSelectionPanel } from "../ContextSelectionPanel";

const copy = en.projects.contexts.selection;
const props = {
	projectId: "example-project",
	organizationId: "example-org",
	sources: [
		{ id: "example-source", title: "Example source", version: "one" },
		{ id: "example-other", title: "Other source", version: "one" },
	],
};
const revision = "a".repeat(64);
function packet() {
	return {
		version: 1,
		contentRole: "reference_data",
		currentRead: true,
		snapshotConsistent: false,
		historicalVersionsAvailable: false,
		selectionHash: "b".repeat(64),
		organizationId: props.organizationId,
		projectId: props.projectId,
		sources: [
			{
				selectionIndex: 0,
				ref: {
					sourceKind: "project_context",
					sourceId: "example-source",
					required: true,
					expectedRevision: revision,
				},
				title: "Example source",
				sourceRevision: revision,
				excerptHash: revision,
				content: "Example private reference text",
				byteLength: 30,
				truncated: true,
				contentRole: "reference_data",
				range: {
					offset: 0,
					returnedCharacters: 30,
					nextOffset: 30,
					offsetUnit: "unicode_code_points",
				},
			},
		],
		omissions: [],
	};
}
beforeEach(() => {
	vi.clearAllMocks();
	m.assemble.mockResolvedValue(packet());
	m.queries.mockReturnValue({
		data: undefined,
		isFetching: false,
		isError: false,
	});
});
async function select() {
	await userEvent.click(screen.getByRole("button", { name: copy.title }));
	await userEvent.click(
		screen.getByRole("checkbox", { name: "Example source" }),
	);
}
describe("selected context panel", () => {
	it("reads only on inspection; displays escaped content, exact revision and truncation", async () => {
		render(<ContextSelectionPanel {...props} />);
		expect(m.assemble).not.toHaveBeenCalled();
		expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
		await select();
		expect(m.assemble).not.toHaveBeenCalled();
		await userEvent.click(
			screen.getByRole("button", { name: copy.inspect }),
		);
		await screen.findByText("Example private reference text");
		expect(screen.getByText(revision)).toBeVisible();
		expect(screen.getByText(copy.excerpt)).toBeVisible();
		expect(m.assemble).toHaveBeenCalledWith({
			projectId: props.projectId,
			organizationId: props.organizationId,
			selections: [
				{ sourceKind: "project_context", sourceId: "example-source" },
			],
		});
	});
	it("rechecks displayed pins before export; denial removes excerpts and no file is exported", async () => {
		render(<ContextSelectionPanel {...props} />);
		await select();
		await userEvent.click(
			screen.getByRole("button", { name: copy.inspect }),
		);
		await screen.findByText("Example private reference text");
		m.assemble.mockRejectedValueOnce(new Error("example-sensitive-error"));
		await userEvent.click(
			screen.getByRole("button", { name: copy.download }),
		);
		await screen.findByRole("alert");
		expect(m.assemble.mock.calls[1][0].selections).toEqual(
			packet().sources.map((s) => s.ref),
		);
		expect(m.download).not.toHaveBeenCalled();
		expect(
			screen.queryByText("Example private reference text"),
		).not.toBeInTheDocument();
		expect(
			screen.queryByText("example-sensitive-error"),
		).not.toBeInTheDocument();
	});
	it("exports only after successful current revision recheck", async () => {
		render(<ContextSelectionPanel {...props} />);
		await select();
		await userEvent.click(
			screen.getByRole("button", { name: copy.inspect }),
		);
		await screen.findByText("Example private reference text");
		await userEvent.click(
			screen.getByRole("button", { name: copy.download }),
		);
		await waitFor(() => expect(m.download).toHaveBeenCalledOnce());
		expect(m.assemble).toHaveBeenCalledTimes(2);
	});
	it("invalidates pending reads on selection change and clears content when closed", async () => {
		let resolve: (value: unknown) => void = () => {};
		m.assemble.mockImplementationOnce(
			() =>
				new Promise((r) => {
					resolve = r;
				}),
		);
		render(<ContextSelectionPanel {...props} />);
		await select();
		await userEvent.click(
			screen.getByRole("button", { name: copy.inspect }),
		);
		await userEvent.click(
			screen.getByRole("checkbox", { name: "Other source" }),
		);
		await act(async () => resolve(packet()));
		expect(
			screen.queryByText("Example private reference text"),
		).not.toBeInTheDocument();
		await userEvent.click(
			screen.getByRole("button", { name: copy.inspect }),
		);
		await screen.findByText("Example private reference text");
		await userEvent.click(screen.getByRole("button", { name: copy.title }));
		expect(
			screen.queryByText("Example private reference text"),
		).not.toBeInTheDocument();
	});
	it("invalidates old project replies and selection on scope changes", async () => {
		let resolve: (value: unknown) => void = () => {};
		m.assemble.mockImplementationOnce(
			() =>
				new Promise((r) => {
					resolve = r;
				}),
		);
		const view = render(<ContextSelectionPanel {...props} />);
		await select();
		await userEvent.click(
			screen.getByRole("button", { name: copy.inspect }),
		);
		view.rerender(
			<ContextSelectionPanel
				{...props}
				projectId="example-other-project"
			/>,
		);
		await act(async () => resolve(packet()));
		expect(
			screen.queryByText("Example private reference text"),
		).not.toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: copy.inspect }),
		).toBeDisabled();
	});
	it("guards double click before React state commits", async () => {
		m.assemble.mockReturnValue(new Promise(() => {}));
		render(<ContextSelectionPanel {...props} />);
		await select();
		const button = screen.getByRole("button", { name: copy.inspect });
		fireEvent.click(button);
		fireEvent.click(button);
		expect(m.assemble).toHaveBeenCalledOnce();
	});
	it("browses metadata only on request; Workspace denial leaves project inspection usable", async () => {
		m.queries.mockImplementation(
			(options: { name: string; enabled?: boolean }) => ({
				data: undefined,
				isFetching: false,
				isError: options.name === "workspaces" && options.enabled,
			}),
		);
		render(<ContextSelectionPanel {...props} />);
		await select();
		expect(
			m.queries.mock.calls.filter(([options]) => options.enabled),
		).toHaveLength(0);
		await userEvent.click(
			screen.getByRole("button", { name: copy.browse }),
		);
		await screen.findByText(copy.workspaceError);
		expect(
			screen.getByRole("button", { name: copy.inspect }),
		).toBeEnabled();
	});
	it("keeps selection bounded and escapes source markup", async () => {
		const sources = Array.from({ length: 13 }, (_, i) => ({
			id: `example-source-${i}`,
			title: `Example choice ${i}`,
			version: "one",
		}));
		const view = render(
			<ContextSelectionPanel {...props} sources={sources} />,
		);
		await userEvent.click(screen.getByRole("button", { name: copy.title }));
		for (let i = 0; i < 12; i++)
			await userEvent.click(
				screen.getByRole("checkbox", { name: `Example choice ${i}` }),
			);
		expect(
			screen.getByRole("checkbox", { name: "Example choice 12" }),
		).toBeDisabled();
		const result = packet();
		result.sources[0].content = "<script>exampleUntrusted()</script>";
		m.assemble.mockResolvedValue(result);
		await userEvent.click(
			screen.getByRole("button", { name: copy.inspect }),
		);
		await screen.findByText("<script>exampleUntrusted()</script>");
		expect(view.container.querySelector("script")).toBeNull();
	});
	it("has labelled controls and no detected accessibility violations", async () => {
		const view = render(<ContextSelectionPanel {...props} />);
		expect((await axe(view.container)).violations).toEqual([]);
		await select();
		await userEvent.click(
			screen.getByRole("button", { name: copy.inspect }),
		);
		await screen.findByText("Example private reference text");
		expect((await axe(view.container)).violations).toEqual([]);
	});
});
