import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { NuqsTestingAdapter } from "nuqs/adapters/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.unmock("next-intl");

import messages from "../../../../../../../packages/i18n/translations/en.json";

const m = vi.hoisted(() => ({
	list: vi.fn(),
	get: vi.fn(),
	sources: vi.fn(),
	privateSources: vi.fn(),
	actor: { id: "example-user" },
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			deliverySources: { list: m.privateSources },
			deliverySignals: {
				list: m.list,
				get: m.get,
				sourceConfiguration: m.sources,
			},
		},
	},
}));
vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({ user: m.actor }),
}));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "example-org",
		basePath: "/app/example-team",
	}),
}));
vi.mock("@saas/get-started/components/PageTourButton", () => ({
	PageTourButton: () => null,
}));

import { ProjectDeliverySignals } from "../ProjectDeliverySignals";

const item = {
	id: "example-item",
	identifier: "US-1",
	title: "A detailed saved work item whose complete title must stay readable",
	source: "SLACK",
	kind: "PROJECT_WORK_ITEM",
	draftingStage: "DRAFT",
	createdAt: "2026-11-01T00:00:00Z",
	href: "/app/example-team/projects/example-project/stories/example-item",
};
const page = (items = [item], nextCursor: string | null = null) => ({
	version: 1,
	coverage: "PROJECT_WORK_ITEMS_ONLY",
	items,
	nextCursor,
});
function view(projectId = "example-project") {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	});
	const rendered = render(
		<QueryClientProvider client={client}>
			<NextIntlClientProvider locale="en" messages={messages}>
				<NuqsTestingAdapter>
					<ProjectDeliverySignals projectId={projectId} />
				</NuqsTestingAdapter>
			</NextIntlClientProvider>
		</QueryClientProvider>,
	);
	return { ...rendered, queryClient: client };
}
beforeEach(() => {
	vi.resetAllMocks();
	m.actor.id = "example-user";
	m.privateSources.mockResolvedValue({
		version: 1,
		watches: [],
		connections: [],
		availability: { state: "UNAVAILABLE", reason: "NOT_ENABLED" },
	});
	m.list.mockResolvedValue(page());
	m.get.mockResolvedValue(item);
	m.sources.mockResolvedValue({
		version: 1,
		items: [{ source: "SLACK", state: "CONFIGURED_NOT_CHECKED" }],
	});
});
describe("project Delivery history", () => {
	it("retains rows after a transient background refresh failure", async () => {
		m.list
			.mockResolvedValueOnce(page())
			.mockRejectedValueOnce({ code: "INTERNAL_SERVER_ERROR" });
		const { queryClient } = view();
		await screen.findByText(item.title);
		await act(async () => {
			await queryClient.refetchQueries({
				predicate: (query) => query.queryKey.at(-1) === "list",
			});
		});
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"loaded results are still shown",
		);
		expect(screen.getByText(item.title)).toBeInTheDocument();
	});
	it("restarts pagination when a server cursor no longer resolves", async () => {
		m.list
			.mockResolvedValueOnce(page([item], "example-stale-cursor"))
			.mockRejectedValueOnce({ code: "BAD_REQUEST" })
			.mockResolvedValueOnce(
				page([{ ...item, title: "Reloaded first page" }]),
			);
		view();
		fireEvent.click(
			await screen.findByRole("button", { name: "Load more" }),
		);
		await screen.findByRole("alert");
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(
			await screen.findByText("Reloaded first page"),
		).toBeInTheDocument();
		expect(m.list.mock.calls.at(-1)[0].cursor).toBeUndefined();
	});
	it("retains loaded rows after a transient next-page failure and retries the same cursor", async () => {
		m.list
			.mockResolvedValueOnce(page([item], "example-cursor"))
			.mockRejectedValueOnce({ code: "INTERNAL_SERVER_ERROR" })
			.mockResolvedValueOnce(
				page([
					{
						...item,
						id: "example-next",
						title: "Recovered next page",
					},
				]),
			);
		view();
		fireEvent.click(
			await screen.findByRole("button", { name: "Load more" }),
		);
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"loaded results are still shown",
		);
		expect(screen.getByText(item.title)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(
			await screen.findByText("Recovered next page"),
		).toBeInTheDocument();
		expect(m.list.mock.calls.at(-1)[0].cursor).toBe("example-cursor");
	});
	it.each(["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND"])(
		"hides loaded rows after an authoritative %s refusal",
		async (code) => {
			m.list
				.mockResolvedValueOnce(page([item], "example-cursor"))
				.mockRejectedValueOnce({ code });
			view();
			fireEvent.click(
				await screen.findByRole("button", { name: "Load more" }),
			);
			await screen.findByRole("alert");
			expect(screen.queryByText(item.title)).not.toBeInTheDocument();
		},
	);
	it("explains a missing workspace address without mislabeling it as lost project access", async () => {
		m.list.mockRejectedValue({
			code: "CONFLICT",
			data: { code: "ORGANIZATION_ROUTE_UNAVAILABLE" },
		});
		view();
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"workspace address is unavailable",
		);
		expect(screen.queryByText(item.title)).not.toBeInTheDocument();
	});
	it("starts with concise scope and full readable titles, not an expanded run or configuration panel", async () => {
		view();
		expect(await screen.findByText(item.title)).toBeInTheDocument();
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		expect(screen.getByText(item.title)).not.toHaveClass("truncate");
		expect(
			screen.getByText(
				/Incoming messages and review proposals are not included/,
			),
		).toBeInTheDocument();
		const sources = await screen.findByText("Your saved sources");
		expect(sources.closest("details")).not.toHaveAttribute("open");
	});
	it("opens a reauthorized minimized drawer, supports Escape and refetches on reopen", async () => {
		view();
		fireEvent.click(await screen.findByRole("button", { name: /US-1/ }));
		const dialog = await screen.findByRole("dialog");
		expect(await within(dialog).findByText(item.title)).toBeInTheDocument();
		expect(
			within(dialog).getByRole("link", { name: "Open work item" }),
		).toHaveAttribute("href", item.href);
		expect(m.get).toHaveBeenCalledWith(
			{ projectId: "example-project", id: item.id },
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		fireEvent.keyDown(document, { key: "Escape" });
		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);
		fireEvent.click(screen.getByRole("button", { name: /US-1/ }));
		await screen.findByRole("dialog");
		await waitFor(() => expect(m.get).toHaveBeenCalledTimes(2));
	});
	it("loads the next bounded page using only the server cursor", async () => {
		m.list
			.mockResolvedValueOnce(page([item], "example-cursor"))
			.mockResolvedValueOnce(
				page([
					{
						...item,
						id: "example-older",
						identifier: "US-0",
						title: "Older saved work",
					},
				]),
			);
		view();
		fireEvent.click(
			await screen.findByRole("button", { name: "Load more" }),
		);
		expect(await screen.findByText("Older saved work")).toBeInTheDocument();
		expect(m.list.mock.calls[1][0]).toMatchObject({
			projectId: "example-project",
			cursor: "example-cursor",
			limit: 20,
		});
	});
	it("submits search deliberately and resets cursor scope", async () => {
		view();
		await screen.findByText(item.title);
		fireEvent.change(screen.getByLabelText("Find saved work"), {
			target: { value: "release plans" },
		});
		expect(m.list).toHaveBeenCalledTimes(1);
		fireEvent.click(
			screen.getByRole("button", { name: "Search", exact: true }),
		);
		await waitFor(() =>
			expect(m.list.mock.calls.at(-1)[0]).toMatchObject({
				search: "release plans",
				cursor: undefined,
			}),
		);
	});
	it("keeps missing setup permission out of the UI without hiding project history", async () => {
		m.sources.mockRejectedValue({
			code: "FORBIDDEN",
			data: { code: "INSUFFICIENT_PERMISSION" },
		});
		view();
		expect(await screen.findByText(item.title)).toBeInTheDocument();
		await waitFor(() => expect(m.sources).toHaveBeenCalled());
		expect(
			screen.queryByText("Your saved sources"),
		).not.toBeInTheDocument();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});
	it("shows an honest empty state and an existing Roadmap action", async () => {
		m.list.mockResolvedValue(page([]));
		view();
		expect(
			await screen.findByText("No saved work matches this view"),
		).toBeInTheDocument();
		expect(
			screen.getByRole("link", { name: "Open Roadmap" }),
		).toHaveAttribute(
			"href",
			"/app/example-team/projects/example-project?tab=stories",
		);
	});
	it("reads the organization restoration error field without rendering raw errors", async () => {
		m.list.mockRejectedValue({
			code: "FORBIDDEN",
			message: "private-provider-error",
			data: { errorCode: "ORGANIZATION_DELETED" },
		});
		view();
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"This organization is in the trash",
		);
		expect(
			screen.getByRole("link", { name: "Manage organizations" }),
		).toHaveAttribute("href", "/app");
		expect(
			screen.queryByText("private-provider-error"),
		).not.toBeInTheDocument();
	});
	it.each([403, 503])(
		"keeps S1 history visible when optional private source access fails with %s",
		async (status) => {
			m.privateSources.mockRejectedValue({
				status,
				code: status === 403 ? "FORBIDDEN" : "SERVICE_UNAVAILABLE",
			});
			view();
			expect(await screen.findByText(item.title)).toBeVisible();
			await waitFor(() => expect(m.privateSources).toHaveBeenCalled());
			expect(screen.getByText(item.title)).toBeVisible();
			if (status === 403) {
				await waitFor(() =>
					expect(
						screen.queryByText(
							messages.deliveryPrivateSources.title,
						),
					).not.toBeInTheDocument(),
				);
			}
		},
	);
	it("shows the collapsed unavailable panel alongside saved work without an active capture action", async () => {
		view();
		await screen.findByText(item.title);
		const title = await screen.findByText(
			messages.deliveryPrivateSources.title,
		);
		expect(title.closest("details")).not.toHaveAttribute("open");
		expect(
			screen.queryByRole("button", {
				name: messages.deliveryPrivateSources.capture,
			}),
		).not.toBeInTheDocument();
	});
});
