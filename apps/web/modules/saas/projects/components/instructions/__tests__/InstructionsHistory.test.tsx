/**
 * Coverage for `InstructionsHistory`'s publish/delete mutations, added per
 * controller ruling R26: neither action had a test before this round.
 * Assertions target the translation KEY, not English copy, since the point
 * here is the wiring (CONFLICT surfacing, `onChanged` on success, which
 * statuses offer Delete), not the copy itself — with one exception, the
 * `t.raw()` label maps, which the local `next-intl` mock below resolves for
 * real because a lookup INTO them is the behaviour under test.
 */
import en from "@repo/i18n/translations/en.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

/**
 * `t()` keeps echoing the KEY, so the mutation-wiring assertions above stay
 * key-based; only `t.raw()` resolves the real `en.json` object. The shared
 * mock in `vitest.setup.ts` returns the key from `t.raw` too, which would
 * make `reasonLabels` a string and every lookup on it `undefined` — i.e.
 * the rendered label would silently fall back to the raw reason, which is
 * exactly the M3 bug these tests pin.
 */
vi.mock("next-intl", () => ({
	useTranslations: (namespace: string) => {
		const t = (key: string, values?: Record<string, unknown>) =>
			values === undefined
				? key
				: `${key}:${Object.values(values).join(",")}`;
		t.raw = (key: string) =>
			`${namespace}.${key}`
				.split(".")
				.reduce<unknown>(
					(node, part) =>
						node && typeof node === "object"
							? (node as Record<string, unknown>)[part]
							: undefined,
					en,
				);
		return t;
	},
	useLocale: () => "en",
	useFormatter: () => ({
		dateTime: (d: Date) => d.toISOString(),
		number: (n: number) => String(n),
		relativeTime: (d: Date) => d.toISOString(),
	}),
	useMessages: () => ({}),
	NextIntlClientProvider: ({ children }: { children: ReactNode }) => children,
}));

function mutationOptionsStub(
	mutationFn: (input: { snapshotId: string }) => Promise<unknown>,
) {
	return (
		opts: {
			onSuccess?: (data: unknown, vars: unknown) => void;
			onError?: (error: Error) => void;
		} = {},
	) => ({
		mutationFn,
		...opts,
	});
}

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			instructions: {
				publish: {
					mutationOptions: mutationOptionsStub(async (input) => {
						if (input.snapshotId === "fail") {
							throw new Error(
								"A newer version is already published",
							);
						}
						return { published: true };
					}),
				},
				delete: {
					mutationOptions: mutationOptionsStub(async (input) => {
						if (input.snapshotId === "fail") {
							throw new Error(
								"The published snapshot cannot be deleted",
							);
						}
						return { deleted: true };
					}),
				},
				createDownloadUrl: {
					mutationOptions: mutationOptionsStub(async () => ({
						url: "https://example.com/download",
						fileCount: 0,
					})),
				},
			},
		},
	},
}));

import { InstructionsHistory } from "../InstructionsHistory";

function TestQueryProvider({ children }: { children: ReactNode }) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

describe("InstructionsHistory", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(window, "confirm").mockReturnValue(true);
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("publish surfaces the server's CONFLICT message on failure and calls onChanged on success", async () => {
		const onChanged = vi.fn();
		render(
			<InstructionsHistory
				projectId="p"
				open
				onOpenChange={() => undefined}
				snapshots={[
					{
						id: "fail",
						version: 5,
						status: "READY",
						source: "UPLOAD",
						fileCount: 10,
						createdAt: new Date(),
					},
					{
						id: "ok",
						version: 6,
						status: "READY",
						source: "UPLOAD",
						fileCount: 10,
						createdAt: new Date(),
					},
				]}
				publishedId={null}
				onChanged={onChanged}
			/>,
			{ wrapper: TestQueryProvider },
		);
		const publishButtons = screen.getAllByRole("button", {
			name: "publishAction",
		});
		await userEvent.click(publishButtons[0]);
		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith(
				"A newer version is already published",
			),
		);
		expect(onChanged).not.toHaveBeenCalled();

		await userEvent.click(publishButtons[1]);
		await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
	});

	it("delete surfaces the server's CONFLICT message on failure and calls onChanged on success", async () => {
		const onChanged = vi.fn();
		render(
			<InstructionsHistory
				projectId="p"
				open
				onOpenChange={() => undefined}
				snapshots={[
					{
						id: "fail",
						version: 3,
						status: "READY",
						source: "UPLOAD",
						fileCount: 10,
						createdAt: new Date(),
					},
					{
						id: "ok",
						version: 4,
						status: "READY",
						source: "UPLOAD",
						fileCount: 10,
						createdAt: new Date(),
					},
				]}
				publishedId={null}
				onChanged={onChanged}
			/>,
			{ wrapper: TestQueryProvider },
		);
		const deleteButtons = screen.getAllByRole("button", {
			name: "deleteAction",
		});
		await userEvent.click(deleteButtons[0]);
		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith(
				"The published snapshot cannot be deleted",
			),
		);
		expect(onChanged).not.toHaveBeenCalled();

		await userEvent.click(deleteButtons[1]);
		await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
	});

	// M9: deleting a snapshot whose workflow is still running removes the row
	// the next activity reads, so it fails as a non-retryable
	// INSTRUCTION_SNAPSHOT_TENANT_MISMATCH — a tenancy-shaped error for a
	// self-inflicted click. Delete is offered only on a terminal status.
	it("offers Delete only for a snapshot whose workflow has finished", async () => {
		render(
			<InstructionsHistory
				projectId="p"
				open
				onOpenChange={() => undefined}
				snapshots={[
					{
						id: "validating",
						version: 9,
						status: "VALIDATING",
						source: "UPLOAD",
						fileCount: 3,
						createdAt: new Date(),
					},
					{
						id: "receiving",
						version: 8,
						status: "RECEIVING",
						source: "UPLOAD",
						fileCount: 3,
						createdAt: new Date(),
					},
					{
						id: "ready",
						version: 7,
						status: "READY",
						source: "UPLOAD",
						fileCount: 3,
						createdAt: new Date(),
					},
					{
						id: "rejected",
						version: 6,
						status: "REJECTED",
						source: "UPLOAD",
						fileCount: 3,
						createdAt: new Date(),
					},
					{
						id: "failed",
						version: 5,
						status: "FAILED",
						source: "UPLOAD",
						fileCount: 3,
						createdAt: new Date(),
					},
				]}
				publishedId={null}
				onChanged={() => undefined}
			/>,
			{ wrapper: TestQueryProvider },
		);
		// READY, REJECTED and FAILED only — not the two in-flight rows.
		expect(
			screen.getAllByRole("button", { name: "deleteAction" }),
		).toHaveLength(3);
	});

	// M3/M4: "See why" rendered the raw `reason` ("secret") and the
	// `(truncated)` cap sentinel as if it were a file, while the banner
	// showing the SAME rows translated both. M4: the version line was the
	// one hardcoded English string in the component.
	it("translates rejection reasons and folds the truncation sentinel into a summary line", async () => {
		render(
			<InstructionsHistory
				projectId="p"
				open
				onOpenChange={() => undefined}
				snapshots={[
					{
						id: "rejected",
						version: 4,
						status: "REJECTED",
						source: "UPLOAD",
						fileCount: 2,
						createdAt: new Date(),
						rejection: [
							{
								path: ".env",
								reason: "secret",
								detail: "aws-access-key",
							},
							{ path: "notes.md", reason: "hash_mismatch" },
							{
								path: "(truncated)",
								reason: "truncated",
								detail: "42 more",
							},
						],
					},
				]}
				publishedId={null}
				onChanged={() => undefined}
			/>,
			{ wrapper: TestQueryProvider },
		);
		await userEvent.click(
			screen.getByRole("button", { name: "seeWhyAction" }),
		);

		expect(screen.getByText("AWS access key id")).toBeTruthy();
		expect(screen.getByText("File changed during upload")).toBeTruthy();
		// The sentinel is a cap marker, never a file row.
		expect(screen.queryByText("(truncated)")).toBeNull();
		expect(screen.queryByText("truncated")).toBeNull();
		// `t()` still echoes, so this asserts the sentinel reached the SUMMARY
		// line carrying its detail, rather than the file table.
		expect(screen.getByText("truncatedSummary:42 more")).toBeTruthy();
		// M4: the version line goes through `t()` like every other string.
		expect(screen.getByText("versionLabel:4")).toBeTruthy();
	});
});
