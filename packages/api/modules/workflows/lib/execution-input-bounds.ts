/**
 * Upper bounds on what a manual start may carry into the engine.
 *
 * The start procedure accepted any `triggerData`, any `variables`, and any
 * number of node and edge bodies of any size. All of it is written to the
 * execution row's `jsonb` column and then serialised into the Temporal start
 * request as the workflow's single argument, so the request-rate limit
 * bounded how OFTEN a caller could do that and nothing bounded how MUCH.
 *
 * Ceilings, and what they sit under:
 *
 * - Temporal refuses a single payload above 2 MiB (`BlobSizeLimitError`) and
 *   a gRPC message above 4 MiB, and warns from 256 KiB. The whole workflow
 *   argument is ONE payload, so the parts below add up to well under 2 MiB
 *   even when every one of them is at its own ceiling.
 * - `jsonb` itself refuses nothing useful (values up to ~255 MiB), so the
 *   database is a place these bytes would happily go and sit forever.
 *
 * Sizes are measured on the JSON serialisation, in bytes, because that is
 * what both the column and the payload carry. Node COUNT reuses the
 * validator's own `MAX_WORKFLOW_NODES` so the schema never admits a graph the
 * validator would refuse a step later.
 */

import { z } from "zod";
import { MAX_WORKFLOW_NODES } from "./workflow-validation";

export const EXECUTION_INPUT_BOUNDS = {
	/** `triggerData`, serialised. */
	triggerDataBytes: 256 * 1024,
	/** `variables`, serialised. */
	variablesBytes: 256 * 1024,
	/** One node body (its config included), serialised. */
	nodeBytes: 32 * 1024,
	/** One edge body, serialised. */
	edgeBytes: 4 * 1024,
	/** Nodes posted inline. */
	nodes: MAX_WORKFLOW_NODES,
	/** Edges posted inline — a dense graph has a few per node, not more. */
	edges: MAX_WORKFLOW_NODES * 5,
	/** The posted graph as a whole (nodes and edges), serialised. Sits under
	 *  the per-item ceilings times the counts on purpose: those bound one
	 *  pathological item, this bounds the honest sum. */
	graphBytes: 1024 * 1024,
} as const;

/** Bytes of the JSON serialisation — what the column and the payload carry. */
export function jsonByteLength(value: unknown): number {
	const serialised = JSON.stringify(value);
	return serialised === undefined ? 0 : Buffer.byteLength(serialised, "utf8");
}

function withinBytes(maxBytes: number, label: string) {
	return (value: unknown, ctx: z.RefinementCtx) => {
		const bytes = jsonByteLength(value);
		if (bytes > maxBytes) {
			ctx.addIssue({
				code: "custom",
				message: `${label} is ${bytes} bytes serialised; the limit is ${maxBytes}`,
			});
		}
	};
}

/** A JSON object whose serialisation is at most `maxBytes`. */
export function boundedJsonRecord(maxBytes: number, label: string) {
	return z
		.record(z.string(), z.unknown())
		.superRefine(withinBytes(maxBytes, label));
}

/**
 * The inline graph a start may carry: bounded per item, in count, and as a
 * whole. Each half is optional on its own, exactly as before.
 */
export const boundedInlineGraphSchema = z
	.object({
		nodes: z
			.array(
				z
					.unknown()
					.superRefine(
						withinBytes(EXECUTION_INPUT_BOUNDS.nodeBytes, "A node"),
					),
			)
			.max(EXECUTION_INPUT_BOUNDS.nodes)
			.optional(),
		edges: z
			.array(
				z
					.unknown()
					.superRefine(
						withinBytes(
							EXECUTION_INPUT_BOUNDS.edgeBytes,
							"An edge",
						),
					),
			)
			.max(EXECUTION_INPUT_BOUNDS.edges)
			.optional(),
	})
	.superRefine((graph, ctx) => {
		if (graph.nodes === undefined && graph.edges === undefined) {
			return;
		}
		const bytes = jsonByteLength({
			nodes: graph.nodes ?? [],
			edges: graph.edges ?? [],
		});
		if (bytes > EXECUTION_INPUT_BOUNDS.graphBytes) {
			ctx.addIssue({
				code: "custom",
				message: `The posted graph is ${bytes} bytes serialised; the limit is ${EXECUTION_INPUT_BOUNDS.graphBytes}`,
			});
		}
	});
