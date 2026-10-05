/**
 * Ratchet: no NEW procedure may consume the caller-supplied organization
 * directly — outside the resolvers that enforce the authorized project.
 *
 * WHY. `resolveOrganizationId` is where the authorized-project binding is
 * enforced (`lib/authorized-project-binding.ts`): once a project permission
 * check has run, a different input organization is refused and the project's
 * own is returned. A handler that reads `input.organizationId` itself — and
 * stamps it on a row, forwards it into a helper, a workflow start, a lifecycle
 * dispatch or audit metadata — is out of that resolver's reach. Fizzy #2904
 * found the scan starters doing exactly that (scans billed to, and findings
 * stamped with, a caller-named organization) and task creation firing another
 * organization's agent triggers.
 *
 * WHAT COUNTS. Inside a procedure's handler (the function that destructures
 * `{ input }` — a helper's own `input` parameter is not oRPC input), any use of
 * `input.organizationId`, `input?.organizationId`, `opts.input.organizationId`,
 * or a binding destructured from `input` as `organizationId` (aliases
 * included), EXCEPT:
 *  - the first argument of a resolver or verifier that refuses a wrong
 *    organization: `resolveOrganizationId`, `resolveOrganizationIdForCaller`,
 *    `resolveSourceCredentialOrganizationId`, `resolveProjectOrganizationId`,
 *    `assertInputOrgMatchesProject`, `requireOrganizationMembership`,
 *    `requireOrganizationAdmin`, `getOrganizationMembership` — and the second
 *    of `authorizeInputOrganization`;
 *  - `clientOrganizationId: <it>` — the publishing suite's guard convention,
 *    where the query layer compares it with the project row and throws;
 *  - a comparison (`===`, `!==`, `==`, `!=`), a negation, a bare `if` test or
 *    `typeof`: reading it to refuse is not consuming it.
 *
 * WHOLE INPUT. Handing `input` on whole — `helper(input)`, `{ ...input }`,
 * `{ input }`, `{ data: input }` — carries its organization along, so it counts
 * when the procedure's `.input(...)` schema can carry `organizationId`. The
 * schema is read through same-file variables and relative imports; one that
 * cannot be read (a package import) counts as carrying it. Not counted:
 * `Object.keys(input)` (key names only) and `{ ...input, organizationId }`,
 * where the later property replaces the input's.
 *
 * CREDIT is given only for a TARGET-organization verification
 * (`requireInputOrgPermission` and the membership helpers the unverified-input
 * ratchet already accepts), because those check the caller against the very
 * organization the input names. It is scoped to the procedure that consumes:
 * a CALL in its `.handler(...)` chain or body (or in a same-file procedure
 * variable that chain is built on, or a same-file function that itself calls
 * one). A sibling procedure in the same file earns nothing, and neither does a
 * name in a comment — comments are not AST nodes. `requireProjectPermission`
 * earns nothing either: it authorizes a project, and the whole point is that a
 * handler reading the input around the resolver escapes what that
 * authorization implies.
 *
 * The baseline lists the raw consumers that predate this ratchet and were not
 * fixed. Every entry is debt, not a statement of safety; entries may only be
 * REMOVED.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import baseline from "./input-org-raw-consumer-baseline.json";

const repoRoot = resolve(__dirname, "../../..");
const modulesRoot = resolve(repoRoot, "packages/api/modules");

/**
 * Target-organization verifications: the names `input-org-unverified-ratchet`
 * accepts, plus `authorizeInputOrganization` — the handler-side form of
 * `requireInputOrgPermission`, which runs the same check. Matched as CALLS in
 * the AST of the procedure that consumes the organization, so neither a
 * comment nor a sibling procedure in the same file earns credit.
 */
const ORG_VERIFIERS = new Set([
	"requireInputOrgPermission",
	"authorizeInputOrganization",
	"requireOrganizationMembership",
	"requireOrganizationAdmin",
	"verifyOrganizationMembership",
	"requireOrgMembership",
	"getOrganizationMembership",
]);

/** Calls whose FIRST argument may be the input organization. */
const SANCTIONED_FIRST_ARG = new Set([
	"resolveOrganizationId",
	"resolveOrganizationIdForCaller",
	"resolveSourceCredentialOrganizationId",
	"resolveProjectOrganizationId",
	"assertInputOrgMatchesProject",
	"requireOrganizationMembership",
	"requireOrganizationAdmin",
	"getOrganizationMembership",
	"assertRowInAuthorizedOrganization",
	"requireAuthorizedRowOrganization",
]);

/** Calls whose SECOND argument may be the input organization. */
const SANCTIONED_SECOND_ARG = new Set(["authorizeInputOrganization"]);

const COMPARISON_OPERATORS = new Set([
	ts.SyntaxKind.EqualsEqualsEqualsToken,
	ts.SyntaxKind.ExclamationEqualsEqualsToken,
	ts.SyntaxKind.EqualsEqualsToken,
	ts.SyntaxKind.ExclamationEqualsToken,
]);

function propertyKey(element: ts.BindingElement): string {
	return (element.propertyName ?? element.name).getText();
}

/** Whether `fn` takes oRPC input (`({ input })`) or a helper's own `input`. */
function inputBindingOf(
	fn: ts.SignatureDeclaration,
): "handler" | "helper" | null {
	for (const parameter of fn.parameters) {
		if (
			ts.isIdentifier(parameter.name) &&
			parameter.name.text === "input"
		) {
			return "helper";
		}
		if (ts.isObjectBindingPattern(parameter.name)) {
			for (const element of parameter.name.elements) {
				if (
					propertyKey(element) === "input" &&
					ts.isIdentifier(element.name) &&
					element.name.text === "input"
				) {
					return "handler";
				}
			}
		}
	}
	return null;
}

function isHandlerInput(identifier: ts.Identifier): boolean {
	let node: ts.Node | undefined = identifier.parent;
	while (node) {
		if (ts.isFunctionLike(node)) {
			const binding = inputBindingOf(node);
			if (binding) {
				return binding === "handler";
			}
		}
		node = node.parent;
	}
	return false;
}

function isInputExpression(expression: ts.Expression): boolean {
	if (ts.isIdentifier(expression)) {
		return expression.text === "input" && isHandlerInput(expression);
	}
	// `opts.input` — the middleware/handler options object read whole.
	return (
		ts.isPropertyAccessExpression(expression) &&
		expression.name.text === "input" &&
		ts.isIdentifier(expression.expression) &&
		expression.expression.text === "opts"
	);
}

function calleeName(call: ts.CallExpression): string {
	const callee = call.expression;
	if (ts.isIdentifier(callee)) {
		return callee.text;
	}
	if (ts.isPropertyAccessExpression(callee)) {
		return callee.name.text;
	}
	return "";
}

/** Whether this read of the input organization is a consumption. */
function isConsumption(read: ts.Expression): boolean {
	let node: ts.Node = read;
	let parent = node.parent;
	// Look through wrappers that do not change which organization it is —
	// including `?? null`, which only normalises an absent one.
	while (
		parent &&
		(ts.isParenthesizedExpression(parent) ||
			ts.isNonNullExpression(parent) ||
			ts.isAsExpression(parent) ||
			(ts.isBinaryExpression(parent) &&
				parent.operatorToken.kind ===
					ts.SyntaxKind.QuestionQuestionToken &&
				parent.left === node &&
				(parent.right.kind === ts.SyntaxKind.NullKeyword ||
					(ts.isIdentifier(parent.right) &&
						parent.right.text === "undefined"))))
	) {
		node = parent;
		parent = parent.parent;
	}
	if (!parent) {
		return true;
	}
	if (ts.isCallExpression(parent)) {
		const index = parent.arguments.indexOf(node as ts.Expression);
		const name = calleeName(parent);
		if (index === 0 && SANCTIONED_FIRST_ARG.has(name)) {
			return false;
		}
		if (index === 1 && SANCTIONED_SECOND_ARG.has(name)) {
			return false;
		}
	}
	if (
		ts.isPropertyAssignment(parent) &&
		parent.initializer === node &&
		parent.name.getText() === "clientOrganizationId"
	) {
		return false;
	}
	if (
		ts.isBinaryExpression(parent) &&
		COMPARISON_OPERATORS.has(parent.operatorToken.kind)
	) {
		return false;
	}
	if (
		(ts.isPrefixUnaryExpression(parent) &&
			parent.operator === ts.SyntaxKind.ExclamationToken) ||
		ts.isTypeOfExpression(parent) ||
		(ts.isIfStatement(parent) && parent.expression === node)
	) {
		return false;
	}
	return true;
}

/** The `.handler(...)` call a node sits in, if any. */
function enclosingHandlerCall(node: ts.Node): ts.CallExpression | null {
	let current: ts.Node | undefined = node.parent;
	while (current) {
		if (
			ts.isCallExpression(current) &&
			ts.isPropertyAccessExpression(current.expression) &&
			current.expression.name.text === "handler"
		) {
			return current;
		}
		current = current.parent;
	}
	return null;
}

function topLevelStatement(node: ts.Node): ts.Node {
	let current = node;
	while (current.parent && !ts.isSourceFile(current.parent)) {
		current = current.parent;
	}
	return current;
}

/** Same-file `const name = <initializer>`, if any. */
function localInitializer(
	file: ts.SourceFile,
	name: string,
): ts.Expression | null {
	let found: ts.Expression | null = null;
	const visit = (node: ts.Node) => {
		if (found) {
			return;
		}
		if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.name.text === name &&
			node.initializer
		) {
			found = node.initializer;
			return;
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return found;
}

/**
 * The nodes that make up the procedure a consuming read belongs to: its
 * `.handler(...)` call (the middleware chain and the handler body), plus the
 * initializer of a same-file procedure variable the chain is built on
 * (`const base = tenantProtectedProcedure.use(...)`), followed transitively.
 * Outside a handler, the read's top-level statement.
 */
function procedureScope(file: ts.SourceFile, node: ts.Node): ts.Node[] {
	const handlerCall = enclosingHandlerCall(node);
	if (!handlerCall) {
		return [topLevelStatement(node)];
	}
	const scope: ts.Node[] = [handlerCall];
	const seen = new Set<string>();
	let chain: ts.Expression = handlerCall.expression;
	for (;;) {
		while (
			ts.isCallExpression(chain) ||
			ts.isPropertyAccessExpression(chain)
		) {
			chain = chain.expression;
		}
		if (!ts.isIdentifier(chain) || seen.has(chain.text)) {
			break;
		}
		seen.add(chain.text);
		const initializer = localInitializer(file, chain.text);
		if (!initializer) {
			break;
		}
		scope.push(initializer);
		chain = initializer;
	}
	return scope;
}

function containsCallTo(root: ts.Node, names: ReadonlySet<string>): boolean {
	let found = false;
	const visit = (node: ts.Node) => {
		if (found) {
			return;
		}
		if (ts.isCallExpression(node) && names.has(calleeName(node))) {
			found = true;
			return;
		}
		ts.forEachChild(node, visit);
	};
	visit(root);
	return found;
}

/**
 * The verifiers as this file sees them: `ORG_VERIFIERS`, plus any same-file
 * function whose body calls one (`authorizedConnectOrganization` wrapping
 * `authorizeInputOrganization`), followed to a fixed point.
 */
function fileVerifiers(file: ts.SourceFile): Set<string> {
	const functions: Array<{ name: string; body: ts.Node }> = [];
	const visit = (node: ts.Node) => {
		if (ts.isFunctionDeclaration(node) && node.name && node.body) {
			functions.push({ name: node.name.text, body: node.body });
		}
		if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.initializer &&
			(ts.isArrowFunction(node.initializer) ||
				ts.isFunctionExpression(node.initializer))
		) {
			functions.push({
				name: node.name.text,
				body: node.initializer.body,
			});
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	const verifiers = new Set(ORG_VERIFIERS);
	for (let grew = true; grew; ) {
		grew = false;
		for (const fn of functions) {
			if (!verifiers.has(fn.name) && containsCallTo(fn.body, verifiers)) {
				verifiers.add(fn.name);
				grew = true;
			}
		}
	}
	return verifiers;
}

/** Whether the procedure a read belongs to verifies the target organization. */
function procedureVerifiesOrganization(
	file: ts.SourceFile,
	node: ts.Node,
	verifiers: ReadonlySet<string>,
): boolean {
	return procedureScope(file, node).some((root) =>
		containsCallTo(root, verifiers),
	);
}

/** Calls that read the input's shape, never an organization in it. */
const WHOLE_INPUT_SHAPE_READERS = new Set(["Object.keys"]);

/** Identifiers in a schema expression that are not schema references. */
const SCHEMA_NON_REFERENCES = new Set(["z", "undefined", "true", "false"]);

/**
 * Whether a procedure's input schema can carry `organizationId`. Follows
 * same-file schema variables and relative imports; a schema it cannot read
 * (a package import, a missing file) counts as carrying one, so an unreadable
 * schema never passes.
 */
function schemaCanCarryOrganization(
	expression: ts.Node,
	file: ts.SourceFile,
	fileName: string,
	seen: Set<string> = new Set(),
): boolean {
	if (expression.getText(file).includes("organizationId")) {
		return true;
	}
	const references: string[] = [];
	const collect = (node: ts.Node) => {
		// A schema inside an object literal (`z.object({ browser: browserSchema })`,
		// `.extend({ ... })`) is a FIELD's schema: it cannot add a top-level
		// `organizationId`, and the field names themselves were matched above.
		if (ts.isObjectLiteralExpression(node)) {
			return;
		}
		if (
			ts.isIdentifier(node) &&
			!SCHEMA_NON_REFERENCES.has(node.text) &&
			!(
				ts.isPropertyAccessExpression(node.parent) &&
				node.parent.name === node
			) &&
			!(ts.isPropertyAssignment(node.parent) && node.parent.name === node)
		) {
			references.push(node.text);
		}
		ts.forEachChild(node, collect);
	};
	collect(expression);
	for (const name of references) {
		const key = `${fileName}#${name}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		const local = localInitializer(file, name);
		if (local) {
			if (schemaCanCarryOrganization(local, file, fileName, seen)) {
				return true;
			}
			continue;
		}
		const imported = importedDeclaration(file, fileName, name);
		if (imported === "unreadable") {
			return true;
		}
		if (
			imported &&
			schemaCanCarryOrganization(
				imported.expression,
				imported.file,
				imported.file.fileName,
				seen,
			)
		) {
			return true;
		}
	}
	return false;
}

/**
 * The declaration `name` is imported from, when the import is relative and
 * readable. `"unreadable"` for a package import or a missing file; `null` when
 * `name` is not imported at all (a parameter, a global).
 */
function importedDeclaration(
	file: ts.SourceFile,
	fileName: string,
	name: string,
): { expression: ts.Expression; file: ts.SourceFile } | "unreadable" | null {
	for (const statement of file.statements) {
		if (
			!ts.isImportDeclaration(statement) ||
			!ts.isStringLiteral(statement.moduleSpecifier)
		) {
			continue;
		}
		const bindings = statement.importClause?.namedBindings;
		if (!bindings || !ts.isNamedImports(bindings)) {
			continue;
		}
		const element = bindings.elements.find(
			(candidate) => candidate.name.text === name,
		);
		if (!element) {
			continue;
		}
		const specifier = statement.moduleSpecifier.text;
		if (!specifier.startsWith(".")) {
			return "unreadable";
		}
		const base = resolve(fileName, "..", specifier);
		const candidates = [
			`${base}.ts`,
			`${base}.tsx`,
			resolve(base, "index.ts"),
		];
		const target = candidates.find((candidate) => existsSync(candidate));
		if (!target) {
			return "unreadable";
		}
		const targetFile = ts.createSourceFile(
			target,
			readFileSync(target, "utf-8"),
			ts.ScriptTarget.Latest,
			true,
		);
		const exportedName = (element.propertyName ?? element.name).text;
		const initializer = localInitializer(targetFile, exportedName);
		return initializer
			? { expression: initializer, file: targetFile }
			: "unreadable";
	}
	return null;
}

/** The `.input(...)` schemas on a handler call's chain. */
function inputSchemasOf(handlerCall: ts.CallExpression): ts.Expression[] {
	const schemas: ts.Expression[] = [];
	let chain: ts.Expression = handlerCall.expression;
	while (ts.isCallExpression(chain) || ts.isPropertyAccessExpression(chain)) {
		if (
			ts.isCallExpression(chain) &&
			ts.isPropertyAccessExpression(chain.expression) &&
			chain.expression.name.text === "input" &&
			chain.arguments[0]
		) {
			schemas.push(chain.arguments[0]);
		}
		chain = chain.expression;
	}
	return schemas;
}

/**
 * Whether a whole-`input` reference hands the input on: as a call argument, a
 * spread, a shorthand `{ input }` or a property value. Any of those carries the
 * caller's organization along with it.
 */
function isWholeInputForwarding(reference: ts.Expression): boolean {
	let node: ts.Node = reference;
	let parent = node.parent;
	while (
		parent &&
		(ts.isParenthesizedExpression(parent) ||
			ts.isNonNullExpression(parent) ||
			ts.isAsExpression(parent) ||
			ts.isSatisfiesExpression(parent))
	) {
		node = parent;
		parent = parent.parent;
	}
	if (!parent) {
		return false;
	}
	if (ts.isCallExpression(parent)) {
		return (
			parent.arguments.includes(node as ts.Expression) &&
			!WHOLE_INPUT_SHAPE_READERS.has(parent.expression.getText())
		);
	}
	// `{ ...input, organizationId }`: a later property replaces the spread one.
	if (ts.isSpreadAssignment(parent)) {
		const literal = parent.parent;
		const position = literal.properties.indexOf(parent);
		return !literal.properties.some(
			(property, index) =>
				index > position &&
				(ts.isPropertyAssignment(property) ||
					ts.isShorthandPropertyAssignment(property)) &&
				property.name.getText() === "organizationId",
		);
	}
	return (
		ts.isSpreadElement(parent) ||
		ts.isShorthandPropertyAssignment(parent) ||
		(ts.isPropertyAssignment(parent) && parent.initializer === node)
	);
}

/**
 * The 1-based lines on which `source` consumes the caller-supplied
 * organization in a procedure that does not verify it.
 */
function findRawInputOrgConsumers(source: string, fileName = "x.ts"): number[] {
	const file = ts.createSourceFile(
		fileName,
		source,
		ts.ScriptTarget.Latest,
		true,
	);
	const hits: ts.Node[] = [];
	const aliases: Array<{ name: string; declaration: ts.Node }> = [];

	const collectAliases = (pattern: ts.ObjectBindingPattern) => {
		for (const element of pattern.elements) {
			if (
				propertyKey(element) === "organizationId" &&
				ts.isIdentifier(element.name)
			) {
				aliases.push({
					name: element.name.text,
					declaration: element.name,
				});
			}
		}
	};

	const visit = (node: ts.Node) => {
		if (
			(ts.isPropertyAccessExpression(node) ||
				ts.isPropertyAccessChain(node)) &&
			node.name.text === "organizationId" &&
			isInputExpression(node.expression) &&
			isConsumption(node)
		) {
			hits.push(node);
		}
		// `helper(input)`, `{ ...input }`, `{ input }`: the whole input, and
		// any organization in it, handed on.
		if (
			ts.isExpression(node) &&
			isInputExpression(node) &&
			!(
				ts.isPropertyAccessExpression(node.parent) &&
				node.parent.expression === node
			) &&
			isWholeInputForwarding(node)
		) {
			const handlerCall = enclosingHandlerCall(node);
			const schemas = handlerCall ? inputSchemasOf(handlerCall) : [];
			if (
				schemas.length === 0 ||
				schemas.some((schema) =>
					schemaCanCarryOrganization(schema, file, fileName),
				)
			) {
				hits.push(node);
			}
		}
		if (
			ts.isVariableDeclaration(node) &&
			node.initializer &&
			ts.isObjectBindingPattern(node.name) &&
			isInputExpression(node.initializer)
		) {
			collectAliases(node.name);
		}
		// `({ input: { organizationId } })`
		if (ts.isParameter(node) && ts.isObjectBindingPattern(node.name)) {
			for (const element of node.name.elements) {
				if (
					propertyKey(element) === "input" &&
					ts.isObjectBindingPattern(element.name)
				) {
					collectAliases(element.name);
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(file);

	for (const alias of aliases) {
		let scope: ts.Node = alias.declaration;
		while (!ts.isFunctionLike(scope) && !ts.isSourceFile(scope)) {
			scope = scope.parent;
		}
		const walk = (node: ts.Node) => {
			if (
				ts.isIdentifier(node) &&
				node.text === alias.name &&
				node !== alias.declaration
			) {
				const parent = node.parent;
				const isPropertyName =
					(ts.isPropertyAccessExpression(parent) &&
						parent.name === node) ||
					(ts.isPropertyAssignment(parent) && parent.name === node) ||
					ts.isBindingElement(parent);
				if (ts.isShorthandPropertyAssignment(parent)) {
					hits.push(node);
				} else if (!isPropertyName && isConsumption(node)) {
					hits.push(node);
				}
			}
			ts.forEachChild(node, walk);
		};
		walk(scope);
	}

	const verifiers = fileVerifiers(file);
	const lines = new Set<number>();
	for (const hit of hits) {
		if (!procedureVerifiesOrganization(file, hit, verifiers)) {
			lines.add(
				file.getLineAndCharacterOfPosition(hit.getStart()).line + 1,
			);
		}
	}
	return [...lines].sort((x, y) => x - y);
}

function findProcedureFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = resolve(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== "__tests__") {
				out.push(...findProcedureFiles(full));
			}
			continue;
		}
		if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) {
			continue;
		}
		if (
			!dir.includes(`${sep}procedures${sep}`) &&
			!dir.endsWith("procedures")
		) {
			continue;
		}
		out.push(full);
	}
	return out;
}

/** Each raw-consumer file, repository-relative, with its consuming lines. */
function rawConsumers(): Map<string, number[]> {
	const found = new Map<string, number[]>();
	for (const absFile of findProcedureFiles(modulesRoot)) {
		const content = readFileSync(absFile, "utf-8");
		const lines = findRawInputOrgConsumers(content, absFile);
		if (lines.length > 0) {
			found.set(relative(repoRoot, absFile).split(sep).join("/"), lines);
		}
	}
	return found;
}

function rawConsumerFiles(): string[] {
	return [...rawConsumers().keys()].sort();
}

describe("input-org raw-consumer ratchet (Fizzy #2904)", () => {
	it("introduces no new procedure that consumes the input organization directly", () => {
		const known = new Set(baseline as string[]);
		const consumers = rawConsumers();
		const added = [...consumers.keys()]
			.filter((file) => !known.has(file))
			.sort();

		expect(
			added,
			"These procedures read `input.organizationId` (or a binding destructured from it, or hand on\n" +
				"the whole input while its schema can carry one) and use it outside the resolvers. That bypasses the authorized-project binding: the value is whatever\n" +
				"the caller sent.\n\n" +
				"In a project-scoped handler, take the organization from\n" +
				"`resolveProjectOrganizationId(input.organizationId, projectId)` (or `resolveOrganizationId`)\n" +
				"BEFORE any write. In an organization-level one, add\n" +
				"`.use(requireInputOrgPermission(Permissions.<PERMISSION>))`.\n\n" +
				"Do NOT add these to input-org-raw-consumer-baseline.json — that ledger only shrinks.\n\n" +
				added
					.map((f) => `  - ${f}:${consumers.get(f)?.join(",")}`)
					.join("\n"),
		).toEqual([]);
	});

	it("keeps the baseline honest — entries that no longer match are removed", () => {
		const current = new Set(rawConsumerFiles());
		const stale = (baseline as string[]).filter((f) => !current.has(f));

		expect(
			stale,
			"These files are on the raw-consumer baseline but no longer match — they were fixed or removed.\n" +
				"Delete them from input-org-raw-consumer-baseline.json:\n\n" +
				stale.map((f) => `  - ${f}`).join("\n"),
		).toEqual([]);
	});

	describe("the detector", () => {
		const handler = (body: string) =>
			`export const p = tenantProtectedProcedure.handler(async ({ input, context }) => {\n${body}\n});`;

		it.each([
			[
				"a forwarded property read",
				"await startProjectScan({ organizationId: input.organizationId ?? null });",
			],
			[
				"an optional-chain read",
				"const organizationId = input?.organizationId;\nawait run(organizationId);",
			],
			[
				"a destructured binding passed on as shorthand",
				"const { projectId, organizationId } = input;\ndispatchLifecycleEvent({ projectId, organizationId });",
			],
			[
				"an aliased destructured binding",
				"const { organizationId: orgId } = input;\nawait write(orgId);",
			],
		])("flags %s", (_label, body) => {
			expect(findRawInputOrgConsumers(handler(body))).not.toEqual([]);
		});

		it("flags a binding destructured in the parameter list", () => {
			const source =
				"export const p = x.handler(async ({ input: { organizationId } }) =>\n" +
				"\twrite(organizationId),\n);";
			expect(findRawInputOrgConsumers(source)).toEqual([2]);
		});

		it.each([
			[
				"the resolver",
				"const organizationId = resolveOrganizationId(input.organizationId, context.session);\nawait write(organizationId);",
			],
			[
				"the project-organization resolver on a destructured binding",
				"const { projectId, organizationId: requested } = input;\nconst organizationId = await resolveProjectOrganizationId(requested, projectId);",
			],
			[
				"a guard comparison",
				"if (input.organizationId !== project.organizationId) { throw new Error(); }",
			],
			[
				"the publishing guard",
				"await load({ clientOrganizationId: input.organizationId ?? null });",
			],
			[
				"target-organization authorization",
				"await authorizeInputOrganization(Permissions.X, input.organizationId, context);",
			],
		])("does not flag %s", (_label, body) => {
			expect(findRawInputOrgConsumers(handler(body))).toEqual([]);
		});

		describe("whole-input forwarding", () => {
			const procedure = (schema: string, body: string) =>
				`export const p = tenantProtectedProcedure\n\t.input(${schema})\n\t.handler(async ({ input, context }) => {\n${body}\n});`;
			const withOrganization =
				"z.object({ projectId: z.string(), organizationId: z.string().nullable().optional() })";

			it.each([
				["as a call argument", "return await createThing(input);"],
				[
					"as a spread",
					"return await createThing({ ...input, userId: 1 });",
				],
				[
					"as a shorthand property",
					"return await createThing({ input, user });",
				],
				[
					"as a property value",
					"return await createThing({ data: input });",
				],
			])("flags the input handed on %s", (_label, body) => {
				expect(
					findRawInputOrgConsumers(procedure(withOrganization, body)),
				).toEqual([4]);
			});

			it("follows a same-file schema variable", () => {
				const source =
					"const base = z.object({ organizationId: z.string().optional() });\n" +
					"const schema = base.extend({ name: z.string() });\n" +
					procedure("schema", "return await createThing(input);");
				expect(findRawInputOrgConsumers(source)).toEqual([6]);
			});

			it("treats a schema it cannot read as carrying an organization", () => {
				const source =
					'import { sharedSchema } from "@repo/shared";\n' +
					procedure(
						"sharedSchema",
						"return await createThing(input);",
					);
				expect(findRawInputOrgConsumers(source)).toEqual([5]);
			});

			it.each([
				[
					"a schema without organizationId",
					"z.object({ projectId: z.string(), browser: browserSchema })",
					"return await createThing(input);",
				],
				[
					"the organization replaced after the spread",
					withOrganization,
					"const organizationId = resolveOrganizationId(input.organizationId, context.session);\nreturn await createThing({ ...input, organizationId });",
				],
				[
					"a read of the key names only",
					withOrganization,
					"return Object.keys(input).filter((key) => key !== 'projectId');",
				],
			])("does not flag %s", (_label, schema, body) => {
				expect(
					findRawInputOrgConsumers(procedure(schema, body)),
				).toEqual([]);
			});
		});

		describe("verification credit", () => {
			it("credits only the procedure that verifies, not its sibling", () => {
				const source = [
					"export const verified = tenantProtectedProcedure",
					"\t.use(requireInputOrgPermission(Permissions.X))",
					"\t.handler(async ({ input }) => write(input.organizationId));",
					"export const unverified = tenantProtectedProcedure",
					"\t.handler(async ({ input }) => write(input.organizationId));",
				].join("\n");
				expect(findRawInputOrgConsumers(source)).toEqual([5]);
			});

			it("gives no credit for a verifier named only in a comment", () => {
				const source = [
					"// requireInputOrgPermission(Permissions.X) runs upstream",
					"export const p = tenantProtectedProcedure",
					"\t/* authorizeInputOrganization(Permissions.X, id, context) */",
					"\t.handler(async ({ input }) => write(input.organizationId));",
				].join("\n");
				expect(findRawInputOrgConsumers(source)).toEqual([4]);
			});

			it("credits a verifier on a same-file base procedure", () => {
				const source = [
					"const base = tenantProtectedProcedure.use(requireInputOrgPermission(Permissions.X));",
					"export const p = base",
					"\t.handler(async ({ input }) => write(input.organizationId));",
				].join("\n");
				expect(findRawInputOrgConsumers(source)).toEqual([]);
			});

			it("credits a same-file function that calls a verifier", () => {
				const source = [
					"async function authorized(id, context) {",
					"\treturn authorizeInputOrganization(Permissions.X, id, context);",
					"}",
					"export const p = tenantProtectedProcedure.handler(async ({ input, context }) => {",
					"\tawait authorized(input.organizationId, context);",
					"\treturn write(input.organizationId);",
					"});",
				].join("\n");
				expect(findRawInputOrgConsumers(source)).toEqual([]);
			});
		});

		it("ignores a helper's own `input` parameter", () => {
			const source =
				"async function startRun(input: { organizationId: string }) {\n" +
				"\tawait write({ organizationId: input.organizationId });\n}";
			expect(findRawInputOrgConsumers(source)).toEqual([]);
		});

		// The fixed files from Fizzy #2904 must read clean. If one regresses,
		// it fails here and in the first test above.
		it.each([
			"projects/procedures/scan/trigger-scan.ts",
			"projects/procedures/scan/start-grouping.ts",
			"projects/procedures/scan/start-review.ts",
			"projects/procedures/scan/apply-grouping.ts",
			"projects/procedures/scan/readd-grouping-theme.ts",
			"projects/procedures/stories/tasks/create-task.ts",
			"projects/procedures/rag-settings/update-rag-settings.ts",
			"projects/procedures/resolve-active-mentions.ts",
		])("reads %s as clean", (file) => {
			const source = readFileSync(resolve(modulesRoot, file), "utf-8");
			expect(findRawInputOrgConsumers(source, file)).toEqual([]);
		});
	});
});
