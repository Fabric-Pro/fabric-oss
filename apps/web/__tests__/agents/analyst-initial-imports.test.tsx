import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { AgentChatCopilotKit } from "@saas/agents/components/AgentChatCopilotKit";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ChangeEvent } from "react";
import { renderToString } from "react-dom/server";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

const loaded = vi.hoisted(() => new Set<string>());
vi.mock("@saas/agents/lib/data-analyst-runtime-protocol", async (original) => {
	loaded.add("protocol schemas");
	return original<
		typeof import("@saas/agents/lib/data-analyst-runtime-protocol")
	>();
});
vi.mock("@saas/agents/lib/data-analyst-runtime-events", async (original) => {
	loaded.add("event schemas");
	return original<
		typeof import("@saas/agents/lib/data-analyst-runtime-events")
	>();
});
vi.mock("@saas/agents/lib/direct-runtime-transport", async (original) => {
	loaded.add("runtime transport");
	return original<
		typeof import("@saas/agents/lib/direct-runtime-transport")
	>();
});
vi.mock("@saas/agents/lib/request-reply-runtime", async (original) => {
	loaded.add("request reply");
	return original<typeof import("@saas/agents/lib/request-reply-runtime")>();
});
vi.mock("@saas/agents/components/FabricChat/shared/ToolCallList", () => {
	loaded.add("tool output");
	return { ToolCallList: () => null };
});
vi.mock("@saas/agents/components/FabricChat/shared/AnsweredByModel", () => {
	loaded.add("model footer");
	return { AnsweredByModel: () => null };
});
vi.mock("@saas/shared/components/copilot/use-chatgpt-plan-spent-action", () => {
	loaded.add("billing action");
	return { useChatgptPlanSpentAction: () => vi.fn() };
});
vi.mock("@saas/agents/components/AgentChatGeneral", () => {
	loaded.add("legacy general chat");
	return { AgentChatGeneral: () => null };
});
vi.mock("@saas/agents/components/AgentChatAPI", () => {
	loaded.add("legacy API chat");
	return { AgentChatAPI: () => null };
});
vi.mock("@saas/agents/components/AgentChatDocument", () => {
	loaded.add("legacy document chat");
	return { AgentChatDocument: () => null };
});
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useEffectiveOrganizationId: (id?: string | null) =>
		id === undefined ? "example-org" : id,
	useOrganizationContext: () => ({
		organizationId: "example-org",
		basePath: "/app/example-org",
	}),
}));
vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => true,
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { agents: { registry: { get: vi.fn() } } },
}));
vi.mock("@tanstack/react-query", () => ({
	useQuery: ({ queryKey }: { queryKey: string[] }) =>
		queryKey[0] === "aiConfigStatus"
			? { data: { isConfigured: true }, isLoading: false }
			: {
					data: { agentId: "data_analyst", metadata: null },
					isLoading: false,
				},
}));
vi.mock("@saas/payments/lib/ai-usage-limit-toast", () => ({
	useShowAiUsageLimitToast: () => vi.fn(),
}));
vi.mock("@saas/agents/components/FabricChat/shared/ChatInput", () => ({
	ChatInput: ({
		value,
		onChange,
		placeholder,
	}: {
		value: string;
		onChange: (value: string) => void;
		placeholder: string;
	}) => (
		<textarea
			value={value}
			placeholder={placeholder}
			onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
				onChange(event.target.value)
			}
		/>
	),
}));

describe("Analyst local dependency boundary", () => {
	it("keeps traced generation and result modules out of the local organization-chat import graph", () => {
		const root = process.cwd();
		const visited = new Set<string>();
		const forbidden = new Set<string>();
		const resolve = (specifier: string, importer: string) => {
			const base = specifier.startsWith(".")
				? path.resolve(path.dirname(importer), specifier)
				: specifier.startsWith("@saas/")
					? path.join(root, "modules/saas", specifier.slice(6))
					: specifier.startsWith("@shared/")
						? path.join(root, "modules/shared", specifier.slice(8))
						: specifier.startsWith("@ui/")
							? path.join(root, "modules/ui", specifier.slice(4))
							: specifier.startsWith("@/")
								? path.join(root, specifier.slice(2))
								: null;
			return (
				base &&
				[
					base,
					`${base}.ts`,
					`${base}.tsx`,
					path.join(base, "index.ts"),
					path.join(base, "index.tsx"),
				].find(
					(candidate) =>
						/\.tsx?$/.test(candidate) && existsSync(candidate),
				)
			);
		};
		const visit = (file: string) => {
			if (visited.has(file)) {
				return;
			}
			visited.add(file);
			const source = ts.createSourceFile(
				file,
				readFileSync(file, "utf8"),
				ts.ScriptTarget.Latest,
				true,
			);
			for (const statement of source.statements) {
				if (
					!ts.isImportDeclaration(statement) &&
					!ts.isExportDeclaration(statement)
				) {
					continue;
				}
				if (
					!statement.moduleSpecifier ||
					!ts.isStringLiteral(statement.moduleSpecifier)
				) {
					continue;
				}
				if (ts.isImportDeclaration(statement)) {
					if (statement.importClause?.isTypeOnly) {
						continue;
					}
					const clause = statement.importClause;
					if (
						clause &&
						!clause.name &&
						clause.namedBindings &&
						ts.isNamedImports(clause.namedBindings) &&
						clause.namedBindings.elements.every(
							(element) => element.isTypeOnly,
						)
					) {
						continue;
					}
				} else if (
					statement.isTypeOnly ||
					(statement.exportClause &&
						ts.isNamedExports(statement.exportClause) &&
						statement.exportClause.elements.every(
							(element) => element.isTypeOnly,
						))
				) {
					continue;
				}
				const specifier = statement.moduleSpecifier.text;
				if (
					specifier === "zod" ||
					specifier.startsWith("zod/") ||
					specifier.startsWith("@ag-ui/")
				) {
					forbidden.add(
						`${path.relative(root, file)} -> ${specifier}`,
					);
				}
				const dependency = resolve(specifier, file);
				if (!dependency) {
					continue;
				}
				if (
					/(data-analyst-runtime-(events|protocol)|direct-runtime-transport|request-reply-runtime|ToolCallList|DataAnalystAssistantTurn|AgentChat(API|Document|General))\.tsx?$/.test(
						dependency,
					)
				) {
					forbidden.add(path.relative(root, dependency));
				}
				visit(dependency);
			}
		};
		// This follows application-local declarations, not package implementations
		// or the emitted bundler graph. Those remain deployment checks.
		visit(
			path.join(
				root,
				"modules/saas/agents/components/OrganizationAgentChatView.tsx",
			),
		);
		expect([...forbidden]).toEqual([]);
	});

	it("keeps the empty Analyst parent lazy through SSR and mock-composer focus and draft changes", () => {
		const view = <AgentChatCopilotKit agentId="example-registration" />;
		const html = renderToString(view);
		expect(html).toContain("Data analyst");
		expect(html).toContain("Ask about your data");
		expect([...loaded]).toEqual([]);
		render(view);
		const input = screen.getByPlaceholderText("Ask about your data…");
		fireEvent.focus(input);
		fireEvent.change(input, { target: { value: "Unsent draft" } });
		expect(input).toHaveValue("Unsent draft");
		expect([...loaded]).toEqual([]);
	});
});
