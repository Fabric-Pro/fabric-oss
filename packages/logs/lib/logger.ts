import { appendFileSync } from "node:fs";
import { getCorrelationIdFromContext } from "@repo/utils/correlation-id";
import { getOrganizationIdFromLogContext } from "@repo/utils/organization-log-context";
import { createConsola } from "consola";

// One log call, one line — in every environment.
//
// consola's default object pretty-printing breaks a single call across ~7 lines.
// Wherever the stream is captured rather than read at a terminal (Log Analytics
// in prod/staging, the Aspire console buffer locally) each of those lines is a
// separate record, which multiplies ingestion — object-continuation lines were
// 34% of all prod container log rows — and makes events ungreppable, since the
// message and its fields land in separate records sharing no key.
//
// This is deliberately NOT gated on NODE_ENV: a grep tuned locally has to work
// against prod, and nothing in this repo logs to a real TTY anyway (everything
// runs under Aspire, which pipes stdout).
//
// Error stack traces are unaffected and still print multi-line — that is the
// one case where the extra lines carry information.
export const logger = createConsola({
	formatOptions: {
		date: false,
		compact: true,
		breakLength: Number.POSITIVE_INFINITY,
	},
});

// Server-only checks. This file already imports `node:fs` at the top, so
// it is never bundled into the browser (the audit-log feature inventoried
// every consumer of `@repo/logs` and confirmed they are all server-side).
// We still keep the `window` check below as defense-in-depth for downstream
// packages whose tsconfig omits the DOM lib.
const isServerSide =
	typeof (globalThis as { window?: unknown }).window === "undefined";

// Auto-bind correlation ID from AsyncLocalStorage into every log entry.
//
// Why: every request-scoped log line (Prisma query, Hono middleware,
// procedure handler, downstream fetch) shares the same correlation ID
// because `asyncCorrelationMiddleware` wrapped the request in
// `runWithCorrelationId`. Stamping it onto each entry's args lets
// operators `grep correlationId=req_xyz` and trace one user action
// end-to-end through the server logs without every callsite having to
// manually pass the ID.
//
// Server-only — `node:async_hooks` is not available in the browser.
// Reporter runs first (before file sink) so its mutation persists into
// downstream reporters. Never throws — a logging failure must not break
// the originating call.
if (isServerSide) {
	logger.addReporter({
		log: (entry) => {
			try {
				const id = getCorrelationIdFromContext();
				if (!id) {
					return;
				}
				// Find the trailing meta object — convention in this
				// codebase is `logger.info("msg", { ...meta })`. If
				// present and not an Array/Error, merge correlationId
				// (don't clobber an explicit caller-supplied value).
				// Otherwise append a new meta object so structured-log
				// consumers (file sink, OTEL exporter) see it.
				const lastIdx = entry.args.length - 1;
				const lastArg = entry.args[lastIdx];
				if (
					lastArg &&
					typeof lastArg === "object" &&
					!Array.isArray(lastArg) &&
					!(lastArg instanceof Error)
				) {
					const meta = lastArg as Record<string, unknown>;
					if (meta.correlationId === undefined) {
						meta.correlationId = id;
					}
				} else {
					entry.args.push({ correlationId: id });
				}
			} catch {
				// Reporter MUST NOT throw — would loop forever via the
				// log call itself. Swallow silently.
			}
		},
	});

	// Auto-bind organization id from AsyncLocalStorage onto every log entry.
	//
	// Same shape as the correlationId reporter above: activities run inside
	// `runWithOrganizationLogContext` and every entry they emit — including
	// helper functions and dependencies — is tagged, so tenant-scoped log
	// queries (the bug-analysis predicate filters Properties["organizationId"])
	// match the rows an analysis produced. Merges into the trailing meta
	// object without clobbering an explicit caller-supplied value; appends a
	// meta object when the call had none.
	logger.addReporter({
		log: (entry) => {
			try {
				const organizationId = getOrganizationIdFromLogContext();
				if (!organizationId) {
					return;
				}
				const lastIdx = entry.args.length - 1;
				const lastArg = entry.args[lastIdx];
				if (
					lastArg &&
					typeof lastArg === "object" &&
					!Array.isArray(lastArg) &&
					!(lastArg instanceof Error)
				) {
					const meta = lastArg as Record<string, unknown>;
					if (meta.organizationId === undefined) {
						meta.organizationId = organizationId;
					}
				} else {
					entry.args.push({ organizationId });
				}
			} catch {
				// Swallow — same loop-safety rule as above.
			}
		},
	});
}

// Optional file sink — enable by setting LOG_FILE=/path/to/log in env.
// Appends each log entry as a JSON line so the rolling Aspire console buffer
// (which CopilotKit registration noise can churn through within seconds)
// stops being the only place to grep server-side events. Registered AFTER
// the correlation reporter so the file lines already include correlationId.
if (isServerSide && process.env.LOG_FILE) {
	const logFile = process.env.LOG_FILE;
	logger.addReporter({
		log: (entry) => {
			try {
				const line = `${JSON.stringify({
					ts: new Date().toISOString(),
					level: entry.type,
					tag: entry.tag,
					args: entry.args,
				})}\n`;
				appendFileSync(logFile, line);
			} catch {
				// Swallow — file logging is best-effort and must never break
				// the actual log call. Errors here would loop forever via the
				// reporter itself.
			}
		},
	});
}
