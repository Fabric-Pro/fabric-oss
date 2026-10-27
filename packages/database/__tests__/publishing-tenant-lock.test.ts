import { describe, expect, it } from "vitest";
import { uniqueViolationConstraint } from "../prisma/queries/projects/publishing-tenant-lock";

function adapterViolation(constraint: unknown, diagnostics = {}) {
	return {
		code: "P2002",
		meta: {
			driverAdapterError: {
				name: "DriverAdapterError",
				cause: {
					originalCode: "23505",
					kind: "UniqueConstraintViolation",
					constraint,
					...diagnostics,
				},
			},
		},
	};
}

describe("uniqueViolationConstraint", () => {
	it("reads the adapter-pg 7.10.1 index field without diagnostic text", () => {
		// adapter-pg's 23505 mapper uses index when pg supplies constraint.
		// The real-error case in publishing-suite-constraints checks this shape.
		expect(
			uniqueViolationConstraint(
				adapterViolation({ index: "example_active_key" }),
			),
		).toBe("example_active_key");
	});

	it("prefers the structured index to message parsing", () => {
		expect(
			uniqueViolationConstraint(
				adapterViolation(
					{ index: "example_active_key" },
					{
						originalMessage:
							'unique constraint "example_other_key"',
					},
				),
			),
		).toBe("example_active_key");
	});

	it.each(["example_active_key", { name: "example_active_key" }])(
		"retains the legacy structured form %j",
		(constraint) => {
			expect(
				uniqueViolationConstraint(adapterViolation(constraint)),
			).toBe("example_active_key");
		},
	);

	it.each(["originalMessage", "message", "detail"])(
		"retains the anchored %s fallback for field-only constraints",
		(field) => {
			expect(
				uniqueViolationConstraint(
					adapterViolation(
						{ fields: ['"topicId"'] },
						{
							[field]:
								'duplicate key violates unique constraint "example_active_key"',
						},
					),
				),
			).toBe("example_active_key");
		},
	);

	it.each([
		{ target: "example_active_key" },
		{ target: ["example_active_key"] },
	])("retains meta.target $target", ({ target }) => {
		expect(
			uniqueViolationConstraint({ code: "P2002", meta: { target } }),
		).toBe("example_active_key");
	});

	it("does not mistake a quoted column for an index name", () => {
		expect(
			uniqueViolationConstraint(
				adapterViolation(
					{ index: 42, fields: ['"topicId"'] },
					{ detail: 'Key ("topicId")=(example) already exists' },
				),
			),
		).toBeNull();
		expect(uniqueViolationConstraint({ code: "P2028" })).toBeNull();
	});
});
