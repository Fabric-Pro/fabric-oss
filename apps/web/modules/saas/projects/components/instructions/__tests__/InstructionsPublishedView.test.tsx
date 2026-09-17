/**
 * `InstructionsPublishedView` (and the `InstructionsRejectedBanner` it
 * composes) route every string through `useTranslations`, and the point of
 * this test is specifically to verify DYNAMIC values (a version number, file
 * counts, an uploader's name) are threaded correctly into that copy. The
 * shared `next-intl` mock in `vitest.setup.ts` only echoes the translation
 * KEY back and ignores interpolation values entirely, which would make that
 * unverifiable — so this suite overrides it with one that resolves the REAL
 * `en.json` copy and performs the `{name}`-style substitution, the same
 * technique `components/__tests__/DocumentsList-queued.test.tsx` uses.
 */
import type { InstructionRejection } from "@repo/database";
import en from "@repo/i18n/translations/en.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

function resolve(path: string): unknown {
	return path.split(".").reduce<unknown>((node, key) => {
		if (node && typeof node === "object") {
			return (node as Record<string, unknown>)[key];
		}
		return undefined;
	}, en);
}

function makeT(namespace: string) {
	const t = (key: string, values?: Record<string, unknown>) => {
		const raw = resolve(`${namespace}.${key}`);
		if (typeof raw !== "string") {
			throw new Error(`missing translation: ${namespace}.${key}`);
		}
		let out = raw;
		for (const [name, value] of Object.entries(values ?? {})) {
			out = out.replaceAll(`{${name}}`, String(value));
		}
		return out;
	};
	t.raw = (key: string) => resolve(`${namespace}.${key}`);
	return t;
}

vi.mock("next-intl", () => ({
	useTranslations: (namespace: string) => makeT(namespace),
	useLocale: () => "en",
	useFormatter: () => ({
		dateTime: (d: Date) => d.toISOString(),
		number: (n: number) => String(n),
		relativeTime: (d: Date) => d.toISOString(),
	}),
	useMessages: () => ({}),
	NextIntlClientProvider: ({ children }: { children: ReactNode }) => children,
}));

// `PageTourButton` (rendered in the header) calls `useFeatureFlag`, which
// throws without a `FeatureFlagProvider` ancestor — this view has none, so
// stub the hook the same way `ContextUploaderDialog.test.tsx` does. The
// PUBLISHING_SUITE value itself is irrelevant to this page's tour.
vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => false,
}));

const finalizeCalls: Array<Record<string, unknown>> = [];

function queryOptionsStub(queryFn: () => Promise<unknown>) {
	return (o: { input: unknown }) => ({
		queryKey: ["stub-query", o.input],
		queryFn,
	});
}

function mutationOptionsStub(mutationFn: (input: unknown) => Promise<unknown>) {
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
				listFiles: {
					queryOptions: queryOptionsStub(async () => []),
				},
				getSettings: {
					queryOptions: queryOptionsStub(async () => ({
						ignoreGlobs: null,
						defaultIgnoreGlobs: [],
						sourceOfTruth: null,
					})),
				},
				createDownloadUrl: {
					mutationOptions: mutationOptionsStub(async () => ({
						url: "https://example.com/download",
						fileCount: 0,
					})),
				},
				publish: {
					mutationOptions: mutationOptionsStub(async () => ({
						published: true,
					})),
				},
				delete: {
					mutationOptions: mutationOptionsStub(async () => ({
						deleted: true,
					})),
				},
				updateSettings: {
					mutationOptions: mutationOptionsStub(async () => ({
						ok: true,
					})),
				},
				finalize: {
					mutationOptions: mutationOptionsStub(
						async (input: unknown) => {
							finalizeCalls.push(
								input as Record<string, unknown>,
							);
							return { status: "VALIDATING" };
						},
					),
				},
			},
		},
	},
}));

import { InstructionsPublishedView } from "../InstructionsPublishedView";

function TestQueryProvider({ children }: { children: ReactNode }) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

describe("InstructionsPublishedView", () => {
	it("states the published version in one sentence and shows the rejected banner for a newer rejected upload", async () => {
		const rejection: InstructionRejection[] = [
			{
				path: ".claude/settings.json",
				reason: "secret",
				detail: "azure-devops-pat",
				line: 41,
			},
		];
		render(
			<InstructionsPublishedView
				projectId="p"
				published={
					{
						id: "s7",
						version: 7,
						status: "READY",
						fileCount: 452,
						excludedCount: 2164,
						createdAt: new Date(),
						source: "UPLOAD",
						user: { id: "u", name: "A. Member" },
						settingsFrozen: { layer: "fabricignore" },
					} as never
				}
				snapshots={
					[
						{
							id: "s8",
							version: 8,
							status: "REJECTED",
							rejection,
						} as never,
					] as never
				}
				onReplaceClick={() => undefined}
				onChanged={() => undefined}
			/>,
			{ wrapper: TestQueryProvider },
		);
		expect(screen.getByText("Version 7 is published")).toBeInTheDocument();
		expect(
			screen.getByText(
				/Uploaded by A\. Member .* from a folder\. 452 files stored, 2,164 left out/,
			),
		).toBeInTheDocument();
		expect(
			screen.getByRole("heading", {
				name: "Upload rejected: 1 file contains secrets",
			}),
		).toBeInTheDocument();
		expect(screen.getByText(".claude/settings.json")).toBeInTheDocument();
		expect(
			screen.getByText("Azure DevOps personal access token"),
		).toBeInTheDocument();
	});

	// R30/I2: FAILED is a dead branch until something writes it, and until
	// this banner exists there is no way back from one except re-uploading
	// the whole folder while the stuck row stays behind.
	it("offers 'Try again' for a FAILED newest snapshot and wires it to finalize", async () => {
		const onChanged = vi.fn();
		finalizeCalls.length = 0;
		render(
			<InstructionsPublishedView
				projectId="p"
				published={null}
				snapshots={
					[
						{
							id: "s3",
							version: 3,
							status: "FAILED",
							source: "UPLOAD",
							fileCount: 0,
							excludedCount: 0,
							createdAt: new Date(),
						} as never,
					] as never
				}
				onReplaceClick={() => undefined}
				onChanged={onChanged}
			/>,
			{ wrapper: TestQueryProvider },
		);

		const alert = screen.getByRole("alert");
		expect(alert).toHaveTextContent(
			"We could not finish checking this upload",
		);
		expect(alert).toHaveTextContent("Checking version 3 stopped");

		await userEvent.click(
			screen.getByRole("button", { name: "Try again" }),
		);

		await waitFor(() => expect(onChanged).toHaveBeenCalled());
		expect(finalizeCalls).toEqual([{ projectId: "p", snapshotId: "s3" }]);
	});

	// M7: `checking` was computed but rendered only as the third branch of a
	// `published ? … : checking ? … : …` chain, so it could never appear
	// while a version was published — which is exactly a REPLACE upload, the
	// case where the tab otherwise looks untouched for the whole check.
	it("says a newer upload is being checked while the previous version stays published", () => {
		render(
			<InstructionsPublishedView
				projectId="p"
				published={
					{
						id: "s7",
						version: 7,
						status: "READY",
						fileCount: 4,
						excludedCount: 0,
						createdAt: new Date(),
						source: "UPLOAD",
						user: { id: "u", name: "A. Member" },
					} as never
				}
				snapshots={
					[
						{
							id: "s8",
							version: 8,
							status: "VALIDATING",
							source: "UPLOAD",
							fileCount: 4,
							excludedCount: 0,
							createdAt: new Date(),
						} as never,
					] as never
				}
				onReplaceClick={() => undefined}
				onChanged={() => undefined}
			/>,
			{ wrapper: TestQueryProvider },
		);
		// Both lines: the published version is still the published one, AND
		// the new upload is visibly in progress.
		expect(screen.getByText("Version 7 is published")).toBeInTheDocument();
		const checking = screen.getByText(
			en.projects.codingInstructions.publishedView.checkingSummary,
		);
		expect(checking).toBeInTheDocument();
		// Announced without an interaction, so it needs a live region.
		expect(checking).toHaveAttribute("aria-live", "polite");
	});

	it("does not offer 'Try again' when the newest snapshot is READY", () => {
		render(
			<InstructionsPublishedView
				projectId="p"
				published={null}
				snapshots={
					[
						{
							id: "s3",
							version: 3,
							status: "READY",
							source: "UPLOAD",
							fileCount: 1,
							excludedCount: 0,
							createdAt: new Date(),
						} as never,
					] as never
				}
				onReplaceClick={() => undefined}
				onChanged={() => undefined}
			/>,
			{ wrapper: TestQueryProvider },
		);
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
	});
});
