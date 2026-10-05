import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { expect, it } from "vitest";

it.each([
	{
		pendingProjectId: "example-project",
		instanceToolConfig: null,
		expectedProjectId: "example-project",
	},
	{
		pendingProjectId: null,
		instanceToolConfig: null,
		expectedProjectId: undefined,
	},
	{
		pendingProjectId: null,
		instanceToolConfig: { boundProjectId: "example-project" },
		expectedProjectId: null,
	},
])(
	"passes dedicated agent project state $expectedProjectId and its removal handler",
	({ pendingProjectId, instanceToolConfig, expectedProjectId }) => {
		const source = readFileSync(
			"modules/saas/agents/components/fabric-ai/FabricAIClient.tsx",
			"utf8",
		);
		const ast = ts.createSourceFile(
			"client.tsx",
			source,
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TSX,
		);
		let found: ts.JsxSelfClosingElement | undefined;
		const visit = (node: ts.Node) => {
			if (
				ts.isJsxSelfClosingElement(node) &&
				node.tagName.getText(ast) === "FabricDirectChat" &&
				node.getText(ast).includes("agent-direct-")
			) {
				found = node;
			}
			ts.forEachChild(node, visit);
		};
		visit(ast);
		if (!found) {
			throw new Error("Dedicated agent JSX not found.");
		}
		const remove = () => {};
		const globals: Record<string, unknown> = {
			pendingProjectId,
			instanceToolConfig,
			instanceId: "example-agent",
			handleProjectRemove: remove,
			FabricDirectChat: () => null,
		};
		const identifiers = (node: ts.Node) => {
			if (ts.isIdentifier(node) && !(node.getText(ast) in globals)) {
				globals[node.getText(ast)] = null;
			}
			ts.forEachChild(node, identifiers);
		};
		identifiers(found);
		globals.React = {
			createElement: (_type: unknown, props: unknown) => ({ props }),
		};
		globals.chrome = {};
		globals.handoffForChat = { draft: "Example prompt" };
		globals.contextLaunch = { prompt: "Example prompt" };
		const code = ts.transpileModule(
			`globalThis.captured=${found.getText(ast)}`,
			{
				compilerOptions: {
					jsx: ts.JsxEmit.React,
					target: ts.ScriptTarget.ES2022,
				},
			},
		).outputText;
		vm.runInNewContext(code, globals);
		expect(
			(globals.captured as { props: Record<string, unknown> }).props,
		).toMatchObject({
			attachedProjectId: expectedProjectId,
			onProjectRemove: remove,
		});
	},
);
