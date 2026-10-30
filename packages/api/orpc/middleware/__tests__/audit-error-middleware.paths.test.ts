/**
 * REDACTED_BODY_FIELDS and REDACTED_SECRET_FIELDS are keyed by dotted router
 * path and list fields by name, all hardcoded. A renamed procedure or field would silently stop being
 * redacted, so every entry is checked against the real router: the path must
 * resolve to a procedure, and each field must be declared by its input
 * schema as far as the schema declares its shape.
 */

import { isProcedure, unlazyRouter } from "@orpc/server";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { router } from "../../router";
import {
	REDACTED_BODY_FIELDS,
	REDACTED_SECRET_FIELDS,
} from "../audit-error-middleware";

type JsonSchema = {
	type?: string | string[];
	properties?: Record<string, JsonSchema>;
	additionalProperties?: boolean | JsonSchema;
	items?: JsonSchema;
	anyOf?: JsonSchema[];
	oneOf?: JsonSchema[];
	allOf?: JsonSchema[];
};

/** The schema itself and every branch of a union or intersection. */
function variants(schema: JsonSchema): JsonSchema[] {
	return [
		schema,
		...[
			...(schema.anyOf ?? []),
			...(schema.oneOf ?? []),
			...(schema.allOf ?? []),
		].flatMap(variants),
	];
}

/**
 * Whether `segments` names a field the schema declares. A step whose schema
 * declares no properties (a record, `z.any()`) is opaque, so the rest of the
 * path is accepted from there; the first step always has to be declared. An
 * object that declares some properties and takes any other key besides (a
 * `.catchall()` or `.passthrough()`, whose JSON Schema has an
 * `additionalProperties` schema) declares an undeclared key through that
 * schema. A plain `z.object` emits no `additionalProperties` for its input,
 * so an undeclared key is still reported there.
 */
function declares(
	schema: JsonSchema,
	segments: readonly string[],
	depth = 0,
): boolean {
	const [segment, ...rest] = segments;
	if (segment === undefined) {
		return true;
	}
	const eachElement = segment.endsWith("[]");
	const key = eachElement ? segment.slice(0, -2) : segment;
	const shapes = variants(schema).filter((variant) => variant.properties);
	if (shapes.length === 0) {
		return depth > 0;
	}
	return shapes.some((shape) => {
		const field =
			shape.properties?.[key] ??
			(typeof shape.additionalProperties === "object"
				? shape.additionalProperties
				: undefined);
		if (!field) {
			return false;
		}
		if (!eachElement) {
			return declares(field, rest, depth + 1);
		}
		// An open value (`z.unknown()`, a catchall's) may be an array of
		// anything, so the rest of the path is accepted from there.
		return (
			isOpen(field) ||
			variants(field).some(
				(variant) =>
					variant.items !== undefined &&
					declares(variant.items, rest, depth + 1),
			)
		);
	});
}

/** Whether the schema says nothing about its value's shape (`{}`). */
function isOpen(schema: JsonSchema): boolean {
	return variants(schema).every(
		(variant) =>
			variant.type === undefined &&
			variant.properties === undefined &&
			variant.items === undefined &&
			variant.additionalProperties === undefined,
	);
}

function procedureAt(resolved: unknown, path: string): unknown {
	let node = resolved;
	for (const key of path.split(".")) {
		if (!node || typeof node !== "object" || isProcedure(node)) {
			return undefined;
		}
		node = (node as Record<string, unknown>)[key];
	}
	return node;
}

/** Each problem with the entry, or none. */
function checkEntry(
	resolved: unknown,
	path: string,
	fields: readonly string[],
): string[] {
	const procedure = procedureAt(resolved, path);
	if (!isProcedure(procedure)) {
		return [`${path}: no such procedure`];
	}
	const inputSchema = procedure["~orpc"].inputSchema;
	if (!inputSchema) {
		return [`${path}: takes no input`];
	}
	const schema = z.toJSONSchema(inputSchema as z.ZodType, {
		io: "input",
		unrepresentable: "any",
	}) as JsonSchema;
	return fields
		.filter((field) => !declares(schema, field.split(".")))
		.map((field) => `${path}: no input field ${field}`);
}

describe("REDACTED_BODY_FIELDS and REDACTED_SECRET_FIELDS against the router", () => {
	let resolved: unknown;

	beforeAll(async () => {
		resolved = await unlazyRouter(router);
	}, 300_000);

	it("names only procedures and input fields the router has", () => {
		const problems = [
			...REDACTED_BODY_FIELDS,
			...REDACTED_SECRET_FIELDS,
		].flatMap(([path, fields]) => checkEntry(resolved, path, fields));

		expect(problems).toEqual([]);
	});

	it("reports a missing procedure or field, and accepts a path through a record", () => {
		expect(
			checkEntry(resolved, "projects.documents.nope", ["content"]),
		).toEqual(["projects.documents.nope: no such procedure"]);
		expect(
			checkEntry(resolved, "projects.documents.update", ["body"]),
		).toEqual(["projects.documents.update: no input field body"]);
		expect(
			checkEntry(resolved, "frames.update", ["blocks[].body", "title[]"]),
		).toEqual([
			"frames.update: no input field blocks[].body",
			"frames.update: no input field title[]",
		]);
		// `projectManagementAdditionalContext` is a record: its keys are the
		// client's, so the path is accepted past it.
		expect(
			checkEntry(resolved, "projects.create", [
				"projectManagementAdditionalContext.anyKey",
			]),
		).toEqual([]);
	});

	it("accepts any key of an object with a catchall, and only of such an object", () => {
		// `execution` declares only `id` and keeps every other key the client
		// sends, so the record's body fields are declared through its catchall,
		// arrays of them included.
		expect(
			checkEntry(resolved, "agents.conversations.saveTurn", [
				"execution.anyKey",
				"execution.stepResults[].toolCalls[].args",
			]),
		).toEqual([]);
		// A message part passes through any key; the message itself does not.
		expect(
			checkEntry(resolved, "ai.chats.messages.add", [
				"messages[].parts[].input",
				"messages[].nope",
			]),
		).toEqual(["ai.chats.messages.add: no input field messages[].nope"]);
	});
});
