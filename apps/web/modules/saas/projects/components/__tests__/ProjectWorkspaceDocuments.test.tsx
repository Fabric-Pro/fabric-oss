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
	list: vi.fn(),
	add: vi.fn(),
	remove: vi.fn(),
	read: vi.fn(),
	readContent: vi.fn(),
	invalidate: vi.fn(),
	queries: vi.fn(),
	toast: vi.fn(),
	page: {
		permissions: { canAdd: true, canRemove: true },
		links: [] as unknown[],
		hasMore: false,
		nextOffset: null,
	},
	queryError: false,
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			contexts: {
				workspaceDocuments: {
					list: m.list,
					add: m.add,
					remove: m.remove,
					read: m.read,
				},
			},
		},
		documentWorkspaces: {
			list: vi.fn(),
			documents: { list: vi.fn(), readContent: m.readContent },
		},
	},
}));
vi.mock("@tanstack/react-query", () => ({
	useQuery: (options: unknown) => m.queries(options),
	useQueryClient: () => ({ invalidateQueries: m.invalidate }),
}));
vi.mock("sonner", () => ({ toast: { success: m.toast } }));
vi.mock("next-intl", () => ({
	useTranslations: () => (key: string, values?: Record<string, unknown>) => {
		let v: unknown = en.projects.contexts.workspaceLinks;
		for (const part of key.split(".")) {
			v = (v as Record<string, unknown>)?.[part];
		}
		return typeof v === "string"
			? v.replace(/\{(\w+)\}/g, (_, name) =>
					String(values?.[name] ?? name),
				)
			: key;
	},
}));

import { ProjectWorkspaceDocuments } from "../ProjectWorkspaceDocuments";

const copy = en.projects.contexts.workspaceLinks;
const props = {
	projectId: "example-project",
	organizationId: "example-org",
	organizationSlug: "example-team",
};
const revision = "a".repeat(64);
const docs = [
	{ id: "example-document", filename: "Example requirements" },
	{ id: "example-document-two", filename: "Example decisions" },
];
const row = {
	id: "example-link",
	availability: "CURRENT",
	sourceKind: "workspace_document",
	filename: docs[0].filename,
	documentId: docs[0].id,
	workspaceId: "example-workspace",
	workspaceName: "Example Workspace",
	sourceRevision: revision,
	sourceRevisionAtLink: revision,
	sharingGranted: false,
};
beforeEach(() => {
	vi.clearAllMocks();
	m.page = {
		permissions: { canAdd: true, canRemove: true },
		links: [],
		hasMore: false,
		nextOffset: null,
	};
	m.queryError = false;
	m.add.mockResolvedValue({ linkId: row.id, created: true });
	m.remove.mockResolvedValue({ removed: true });
	m.read.mockResolvedValue({
		text: "Example private preview",
		truncated: false,
	});
	m.readContent.mockResolvedValue({ revision, text: "E" });
	m.invalidate.mockResolvedValue(undefined);
	m.queries.mockImplementation((options: { queryKey: string[] }) => {
		const name = options.queryKey[0];
		return {
			data:
				name === "project-workspace-documents"
					? m.page
					: name === "workspace-link-picker"
						? {
								workspaces: [
									{
										id: row.workspaceId,
										name: row.workspaceName,
									},
								],
								hasMore: false,
							}
						: { documents: docs, hasMore: false },
			isError: name === "project-workspace-documents" && m.queryError,
			isFetching: false,
			isPending: false,
		};
	});
});
async function choose() {
	await userEvent.click(screen.getByRole("button", { name: copy.add }));
	await userEvent.click(
		screen.getByRole("combobox", { name: copy.chooseWorkspace }),
	);
	await userEvent.click(
		screen.getByRole("option", { name: row.workspaceName }),
	);
	await userEvent.click(
		screen.getByRole("checkbox", { name: docs[0].filename }),
	);
}
describe("Workspace documents in project context", () => {
	it("keeps an understandable empty state and loads no Workspace catalog until requested", () => {
		render(<ProjectWorkspaceDocuments {...props} />);
		expect(screen.getByText(copy.empty)).toBeVisible();
		expect(
			m.queries.mock.calls.filter(
				([opts]) => opts.queryKey[0] === "workspace-link-picker",
			),
		).toHaveLength(0);
		expect(m.readContent).not.toHaveBeenCalled();
	});
	it("links inspected revisions without uploading/copying body text", async () => {
		render(<ProjectWorkspaceDocuments {...props} />);
		await choose();
		await userEvent.click(
			screen.getByRole("button", { name: copy.confirmAdd }),
		);
		await waitFor(() => expect(m.add).toHaveBeenCalledOnce());
		expect(m.readContent).toHaveBeenCalledWith({
			organizationId: props.organizationId,
			workspaceId: row.workspaceId,
			documentId: row.documentId,
			offset: 0,
			limit: 1,
		});
		expect(m.add).toHaveBeenCalledWith({
			projectId: props.projectId,
			organizationId: props.organizationId,
			workspaceId: row.workspaceId,
			documentId: row.documentId,
			expectedRevision: revision,
		});
	});
	it("does not offer add/remove controls to a read-only actor", () => {
		m.page.permissions = { canAdd: false, canRemove: false };
		m.page.links = [row];
		render(<ProjectWorkspaceDocuments {...props} />);
		expect(screen.getByRole("button", { name: copy.add })).toBeDisabled();
		expect(
			screen.queryByRole("button", {
				name: /Remove .* from project context/,
			}),
		).not.toBeInTheDocument();
	});
	it("allows removing opaque unavailable links without source content or names", async () => {
		m.page.links = [
			{
				id: row.id,
				availability: "UNAVAILABLE",
				sourceKind: "workspace_document",
			},
		];
		render(<ProjectWorkspaceDocuments {...props} />);
		expect(screen.queryByText(docs[0].filename)).not.toBeInTheDocument();
		await userEvent.click(
			screen.getByRole("button", {
				name: copy.removeNamed.replace("{name}", copy.unavailableTitle),
			}),
		);
		await waitFor(() =>
			expect(m.remove).toHaveBeenCalledWith({
				projectId: props.projectId,
				organizationId: props.organizationId,
				linkId: row.id,
			}),
		);
		expect(m.read).not.toHaveBeenCalled();
		expect(m.readContent).not.toHaveBeenCalled();
	});
	it("clears cached metadata on list failure instead of displaying stale source names", () => {
		m.page.links = [row];
		m.queryError = true;
		render(<ProjectWorkspaceDocuments {...props} />);
		expect(screen.getByText(copy.loadError)).toBeVisible();
		expect(screen.queryByText(row.filename)).not.toBeInTheDocument();
	});
	it("previews only on request and discards late text after the preview is closed", async () => {
		m.page.links = [row];
		let resolve: (value: unknown) => void = () => {};
		m.read.mockImplementationOnce(
			() =>
				new Promise((r) => {
					resolve = r;
				}),
		);
		render(<ProjectWorkspaceDocuments {...props} />);
		expect(m.read).not.toHaveBeenCalled();
		await userEvent.click(
			screen.getByRole("button", { name: copy.preview }),
		);
		await userEvent.click(screen.getByRole("button", { name: "Close" }));
		await act(async () =>
			resolve({ text: "Example private preview", truncated: false }),
		);
		expect(
			screen.queryByText("Example private preview"),
		).not.toBeInTheDocument();
	});
	it("does not submit after project scope changes during source inspection", async () => {
		let resolve: (value: unknown) => void = () => {};
		m.readContent.mockImplementationOnce(
			() =>
				new Promise((r) => {
					resolve = r;
				}),
		);
		const view = render(<ProjectWorkspaceDocuments {...props} />);
		await choose();
		await userEvent.click(
			screen.getByRole("button", { name: copy.confirmAdd }),
		);
		view.rerender(
			<ProjectWorkspaceDocuments
				{...props}
				projectId="example-other-project"
			/>,
		);
		await act(async () => resolve({ revision }));
		expect(m.add).not.toHaveBeenCalled();
	});
	it("guards duplicate adds and retains only failed documents for a deliberate retry", async () => {
		let resolve: (value: unknown) => void = () => {};
		m.add
			.mockImplementationOnce(
				() =>
					new Promise((r) => {
						resolve = r;
					}),
			)
			.mockRejectedValueOnce(new Error("example-private-backend-error"));
		render(<ProjectWorkspaceDocuments {...props} />);
		await choose();
		await userEvent.click(
			screen.getByRole("checkbox", { name: docs[1].filename }),
		);
		const button = screen.getByRole("button", { name: copy.confirmAdd });
		fireEvent.click(button);
		fireEvent.click(button);
		await waitFor(() => expect(m.add).toHaveBeenCalledTimes(1));
		await act(async () => resolve({ linkId: row.id, created: true }));
		await waitFor(() => expect(m.add).toHaveBeenCalledTimes(2));
		expect(
			screen.queryByText("example-private-backend-error"),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", {
				name: copy.removeSelection.replace("{name}", docs[0].filename),
			}),
		).not.toBeInTheDocument();
		expect(
			screen.getByRole("button", {
				name: copy.removeSelection.replace("{name}", docs[1].filename),
			}),
		).toBeVisible();
	});
	it("renders freshness and has no detected accessibility violations", async () => {
		m.page.links = [{ ...row, availability: "UPDATED" }];
		const view = render(<ProjectWorkspaceDocuments {...props} />);
		expect(screen.getByText(copy.status.UPDATED)).toBeVisible();
		expect((await axe(view.container)).violations).toEqual([]);
	});
});
