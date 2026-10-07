/**
 * Native repository history on Azure DevOps: the list endpoint carries no
 * parents, so Compare and Revert wait for the selected commit's own parent
 * read, and the other providers keep what their list already says.
 *
 * `repository.listCommits` and `repository.getCommitParent` are the mocked
 * procedures; copy is the real `en.json`.
 */
import en from "@repo/i18n/translations/en.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

function resolve(path: string): unknown {
	return path.split(".").reduce<unknown>((node, key) => {
		if (node && typeof node === "object") {
			return (node as Record<string, unknown>)[key];
		}
		return undefined;
	}, en);
}

vi.mock("next-intl", () => ({
	useTranslations: (namespace: string) => {
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

const mocks = vi.hoisted(() => ({
	parentCalls: [] as Array<Record<string, unknown>>,
	parentFails: { current: false },
	parents: new Map<string, string | null>(),
}));

vi.mock("@shared/lib/orpc-query-utils", async () => {
	const { skipToken } = await import("@tanstack/react-query");
	return {
		orpc: {
			projects: {
				instructions: {
					repository: {
						listCommits: {
							queryOptions: (o: { input: unknown }) => ({
								queryKey: ["listCommits", o.input],
								queryFn: async () => ({
									commits: [SHA_A, SHA_B].map((sha) => ({
										sha,
										author: { name: "Example Member" },
										date: new Date().toISOString(),
										message: `Change ${sha.slice(0, 3)}`,
										url: `https://dev.azure.com/example-org/proj/_git/instructions/commit/${sha}`,
										parent: null,
										published: null,
										refused: false,
										isFabric: false,
									})),
									nextCursor: null,
								}),
							}),
						},
						getCommitParent: {
							queryOptions: (o: {
								input: Record<string, unknown> | symbol;
							}) => ({
								queryKey: ["commitParent", o.input],
								queryFn:
									o.input === skipToken ||
									typeof o.input === "symbol"
										? skipToken
										: async () => {
												mocks.parentCalls.push(o.input);
												if (mocks.parentFails.current) {
													throw new Error(
														"unreachable",
													);
												}
												return {
													sha: o.input.sha,
													parent:
														mocks.parents.get(
															String(o.input.sha),
														) ?? null,
												};
											},
							}),
						},
					},
					repositorySync: {
						listCommits: {
							queryOptions: () => ({
								queryKey: ["syncListCommits"],
								enabled: false,
							}),
							key: () => ["listCommits"],
						},
						compareCommits: {
							queryOptions: (o: { input: unknown }) => ({
								queryKey: ["compareCommits", o.input],
								queryFn: async () => ({
									from: { sha: "" },
									to: { sha: "" },
									added: [],
									removed: [],
									changed: [],
									truncated: false,
								}),
							}),
						},
						readCommitFile: {
							queryOptions: (o: { input: unknown }) => ({
								queryKey: ["readCommitFile", o.input],
								queryFn: async () => ({ state: "absent" }),
							}),
						},
					},
					revertCommit: {
						mutationOptions: (
							opts: Record<string, unknown> = {},
						) => ({
							mutationFn: async () => ({}),
							...opts,
						}),
					},
				},
			},
		},
	};
});
vi.mock("@saas/shared/components/ConfirmationAlertProvider", () => ({
	useConfirmationAlert: () => ({ confirm: vi.fn() }),
}));
vi.mock("sonner", () => ({
	toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { InstructionsCommits } from "../InstructionsCommits";

const SHA_A = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const SHA_B = "b2c3d4e5f60718293a4b5c6d7e8f901234567890";
const PARENT_A = "9".repeat(40);
const PARENT_B = "8".repeat(40);

function renderCommits(provider: string) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<InstructionsCommits
				projectId="p"
				open
				onOpenChange={() => undefined}
				provider={provider}
				branch="main"
				rootPath=""
				published={{ sha: null, version: null }}
				canRevert
				canCompare
				onChanged={() => undefined}
				repositoryPin={{ generation: 3, commitSha: SHA_A }}
			/>
		</QueryClientProvider>,
	);
}

const detail = () => screen.getByTestId("commit-detail");

beforeEach(() => {
	mocks.parentCalls.length = 0;
	mocks.parentFails.current = false;
	mocks.parents.clear();
	mocks.parents.set(SHA_A, PARENT_A);
	mocks.parents.set(SHA_B, PARENT_B);
});

describe("InstructionsCommits — Azure DevOps parents", () => {
	it("offers Compare and Revert once the selected commit's parent has loaded, reading only that commit", async () => {
		renderCommits("AZURE_DEVOPS");

		await waitFor(() =>
			expect(
				within(detail()).getByRole("button", {
					name: "Compare with parent",
				}),
			).toBeInTheDocument(),
		);
		expect(
			within(detail()).getByRole("button", { name: "Revert" }),
		).toBeInTheDocument();
		expect(mocks.parentCalls).toEqual([
			{ projectId: "p", generation: 3, sha: SHA_A },
		]);
	});

	it("reads the parent of the next commit the person selects, and no other", async () => {
		const user = userEvent.setup();
		renderCommits("AZURE_DEVOPS");
		await screen.findByRole("heading", { name: "Change a1b" });

		await user.click(screen.getByRole("button", { name: /Change b2c/ }));

		await waitFor(() =>
			expect(mocks.parentCalls.map((call) => call.sha)).toEqual([
				SHA_A,
				SHA_B,
			]),
		);
		expect(
			await within(detail()).findByRole("button", {
				name: "Compare with parent",
			}),
		).toBeInTheDocument();
	});

	it("keeps both actions hidden for a commit whose parent cannot be read", async () => {
		mocks.parentFails.current = true;
		renderCommits("AZURE_DEVOPS");
		await screen.findByRole("heading", { name: "Change a1b" });

		await waitFor(() => expect(mocks.parentCalls).toHaveLength(1));
		expect(
			within(detail()).queryByRole("button", {
				name: "Compare with parent",
			}),
		).not.toBeInTheDocument();
		expect(
			within(detail()).queryByRole("button", { name: "Revert" }),
		).not.toBeInTheDocument();
	});

	it("does not read parents for a provider that lists them itself", async () => {
		renderCommits("GITHUB");
		await screen.findByRole("heading", { name: "Change a1b" });

		expect(mocks.parentCalls).toEqual([]);
	});
});
