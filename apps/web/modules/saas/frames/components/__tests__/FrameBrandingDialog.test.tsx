import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";

const m = vi.hoisted(() => ({
	get: vi.fn(),
	apply: vi.fn(),
	close: vi.fn(),
	userId: "example-user",
}));
vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({ user: { id: m.userId } }),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { frames: { branding: { get: m.get, apply: m.apply } } },
}));

import { FrameBrandingDialog } from "../FrameBrandingDialog";

const revision = "2026-11-05T10:00:00.000Z";
const company = {
	version: 2,
	name: "Example company",
	hasPalette: true,
	primaryColor: "#334155",
	accentColors: [],
	displayFontFamily: "Poppins",
	bodyFontFamily: "Inter",
	coverStyle: "DARK",
};
const client = {
	...company,
	version: 8,
	name: "Example client",
	primaryColor: "#0f766e",
	coverStyle: "LIGHT",
};
const choices = () => ({
	frameUpdatedAt: revision,
	projectId: "example-project",
	current: null,
	canApply: true,
	blockedReason: null,
	company,
	client,
});
function setup() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false, retryDelay: 0 } },
	});
	const tree = () => (
		<QueryClientProvider client={queryClient}>
			<FrameBrandingDialog
				frameId="example-frame"
				organizationId="example-org"
				updatedAt={revision}
				open
				onOpenChange={m.close}
			/>
		</QueryClientProvider>
	);
	const view = render(tree());
	return {
		...view,
		queryClient,
		rerenderIdentity: () => view.rerender(tree()),
	};
}
beforeEach(() => {
	vi.clearAllMocks();
	m.userId = "example-user";
	m.get.mockResolvedValue(choices());
	m.apply.mockResolvedValue({ updatedAt: "2026-11-05T11:00:00.000Z" });
});

describe("Frame branding review", () => {
	it("stages the client choice, then applies exactly the reviewed brand and content versions", async () => {
		const user = userEvent.setup();
		setup();
		await screen.findByText("Example client");
		await user.click(screen.getByRole("radio", { name: "source.CLIENT" }));
		expect(m.apply).not.toHaveBeenCalled();
		expect(screen.getByText("#0f766e")).toBeInTheDocument();
		await user.click(
			screen.getByRole("button", { name: "apply", exact: true }),
		);
		await waitFor(() =>
			expect(m.apply).toHaveBeenCalledWith({
				id: "example-frame",
				organizationId: "example-org",
				source: "CLIENT",
				expectedBrandVersion: 8,
				expectedUpdatedAt: revision,
			}),
		);
		await waitFor(() => expect(m.close).toHaveBeenCalledWith(false));
	});
	it("keeps published Frames read-only and never invents a missing client palette", async () => {
		m.get.mockResolvedValue({
			...choices(),
			client: { ...client, hasPalette: false },
			canApply: false,
			blockedReason: "PUBLISHED",
		});
		setup();
		await screen.findByText("blocked.PUBLISHED");
		expect(
			screen.getByRole("radio", { name: "source.CLIENT" }),
		).toBeDisabled();
		expect(
			screen.getByRole("button", { name: "apply", exact: true }),
		).toBeDisabled();
		expect(m.apply).not.toHaveBeenCalled();
	});
	it("requires reloading content changed since the Frame visible to the reviewer", async () => {
		m.get.mockResolvedValue({
			...choices(),
			frameUpdatedAt: "2026-11-05T10:30:00.000Z",
		});
		setup();
		await screen.findByText("contentChanged");
		expect(
			screen.getByRole("button", { name: "apply", exact: true }),
		).toBeDisabled();
		expect(
			screen.getByRole("button", { name: "reloadFrame" }),
		).toBeEnabled();
	});
	it("refreshes stale brand values after conflict without automatically retrying a write", async () => {
		const user = userEvent.setup();
		setup();
		await screen.findByText("Example client");
		await user.click(screen.getByRole("radio", { name: "source.CLIENT" }));
		m.get.mockResolvedValue({
			...choices(),
			client: { ...client, version: 9, primaryColor: "#123456" },
		});
		m.apply.mockRejectedValueOnce(
			Object.assign(new Error("private detail"), { code: "CONFLICT" }),
		);
		await user.click(
			screen.getByRole("button", { name: "apply", exact: true }),
		);
		expect(await screen.findByText("changed")).toBeInTheDocument();
		expect(await screen.findByText("#123456")).toBeInTheDocument();
		expect(m.apply).toHaveBeenCalledTimes(1);
		expect(screen.queryByText("private detail")).not.toBeInTheDocument();
		await user.click(
			screen.getByRole("button", { name: "apply", exact: true }),
		);
		await waitFor(() =>
			expect(m.apply).toHaveBeenLastCalledWith(
				expect.objectContaining({ expectedBrandVersion: 9 }),
			),
		);
	});
	it("does not reuse an earlier actor's cached brand when the next read fails", async () => {
		const view = setup();
		await screen.findByText("Example client");
		m.userId = "example-user-b";
		m.get.mockRejectedValue(new Error("forbidden"));
		view.rerenderIdentity();
		expect(screen.queryByText("Example client")).not.toBeInTheDocument();
		expect(await screen.findByText("loadFailed")).toBeInTheDocument();
	});
	it("labels the brand review and choices accessibly", async () => {
		setup();
		await screen.findByText("Example client");
		expect(
			(
				await axe(screen.getByRole("dialog"), {
					rules: { "color-contrast": { enabled: false } },
				})
			).violations,
		).toEqual([]);
	});
});
