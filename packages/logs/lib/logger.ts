import { appendFileSync } from "node:fs";
import { getCorrelationIdFromContext } from "@repo/utils/correlation-id";
import { redactLogEntry, redactLogText } from "@repo/utils/log-redaction";
import { getOrganizationIdFromLogContext } from "@repo/utils/organization-log-context";
import { createConsola, type LogObject } from "consola";

// Server-only checks. This file already imports `node:fs` at the top, so
// it is never bundled into the browser (the audit-log feature inventoried
// every consumer of `@repo/logs` and confirmed they are all server-side).
// We still keep the `window` check below as defense-in-depth for downstream
// packages whose tsconfig omits the DOM lib.
const isServerSide =
	typeof (globalThis as { window?: unknown }).window === "undefined";

/** A warn/error/fatal log line, redacted and ready to hand to an external
 *  sink (an APM/log platform). `@repo/logs` never talks to one directly —
 *  see `addLogSink` below. */
export type LogSinkLevel = "warn" | "error" | "fatal";

export interface LogSinkRecord {
	level: LogSinkLevel;
	message: string;
	properties: Record<string, unknown>;
	/** The `Error` instance passed as one of the call's args, if any. Its
	 *  `message` has already been redacted the same way `properties` has;
	 *  its `stack` is untouched (stack frames name files, not secrets). */
	error?: Error;
}

export type LogSink = (record: LogSinkRecord) => void;

const SINK_LEVELS: ReadonlySet<string> = new Set<LogSinkLevel>([
	"warn",
	"error",
	"fatal",
]);

/**
 * Pull `{ message, properties, error }` out of a raw consola call. The
 * codebase mixes two call conventions — `logger.warn("msg", { ...meta })`
 * and `logger.warn({ err }, "msg")` — so this scans every arg rather than
 * assuming positions: the first string is the message, the first `Error`
 * instance is the error, and every plain object (order-independent) merges
 * into `properties`. Reporters registered before this one (correlationId,
 * organizationId) have already merged their fields into a trailing meta
 * object by the time this runs, so those land in `properties` for free.
 */
function extractSinkFields(args: unknown[]): {
	message: string;
	properties: Record<string, unknown>;
	error?: Error;
} {
	let message: string | undefined;
	let error: Error | undefined;
	let properties: Record<string, unknown> | undefined;
	for (const arg of args) {
		if (typeof arg === "string" && message === undefined) {
			message = arg;
		} else if (arg instanceof Error) {
			error ??= arg;
		} else if (arg && typeof arg === "object" && !Array.isArray(arg)) {
			properties = { ...properties, ...(arg as Record<string, unknown>) };
		}
	}
	return { message: message ?? "", properties: properties ?? {}, error };
}

/** Redact an Error's message the same way log text is redacted, without
 *  mutating the original (other code may still hold and inspect it). */
function redactError(error: Error): Error {
	const { text, redactionCount } = redactLogText(error.message);
	if (redactionCount === 0) {
		return error;
	}
	const redacted = new Error(text);
	redacted.name = error.name;
	redacted.stack = error.stack;
	return redacted;
}

/**
 * Every external sink currently attached, keyed by the id passed to
 * `addLogSink` (or a fresh, module-private `Symbol()` for an anonymous
 * add). Lives on `globalThis` — see `getLogger` below for why — so a
 * second evaluation of this module sees, and can replace, sinks the first
 * evaluation registered.
 */
type SinkRegistry = Map<string | symbol, LogSink>;

const SINKS_KEY = Symbol.for("fabric.repo-logs.log-sinks");

function getSinkRegistry(): SinkRegistry {
	const target = globalThis as Record<PropertyKey, unknown>;
	let registry = target[SINKS_KEY] as SinkRegistry | undefined;
	if (!registry) {
		registry = new Map();
		target[SINKS_KEY] = registry;
	}
	return registry;
}

/**
 * One reporter, registered once at logger-creation time, that fans a
 * warn/error/fatal entry out to every sink currently in the registry. New
 * sinks never need their own reporter — they just join the registry this
 * reporter already reads from, which is what makes `addLogSink` idempotent
 * per id rather than accumulating one reporter per call.
 */
function forwardToSinks(entry: LogObject): void {
	if (!SINK_LEVELS.has(entry.type)) {
		return;
	}
	const registry = getSinkRegistry();
	if (registry.size === 0) {
		return;
	}
	try {
		const raw = extractSinkFields(entry.args);
		const redacted = redactLogEntry({
			message: raw.message,
			properties: raw.properties,
		});
		if (!redacted) {
			// Fail closed — never forward what could not be redacted.
			return;
		}
		const record: LogSinkRecord = {
			level: entry.type as LogSinkLevel,
			message: redacted.message,
			properties: redacted.properties ?? {},
			error: raw.error ? redactError(raw.error) : undefined,
		};
		for (const sink of registry.values()) {
			try {
				sink(record);
			} catch {
				// One sink's failure must never block another, or the log call.
			}
		}
	} catch {
		// The sink pipeline must never break the log call.
	}
}

/**
 * The one consola logger for this process, created once and shared by
 * every module instance that imports `@repo/logs` — see the file header
 * comment on why that distinction matters.
 *
 * Bundlers (Next/Turbopack in particular) can compile this module into
 * more than one chunk/module layer for a single running process:
 * `instrumentation.ts`'s `register()` and an API route handler observably
 * ended up with separate instances of this module in staging. A
 * module-scoped `export const logger = createConsola(...)` gives each
 * instance its OWN logger with its OWN reporters — `addLogSink` calls made
 * against instrumentation's copy attach to a logger nothing else ever
 * logs through. `globalThis` is the one thing every module instance in a
 * process shares, so the logger — and its reporters, and the sink
 * registry above — live there instead.
 *
 * Reporters (correlationId, organizationId, the optional LOG_FILE sink,
 * and the sink-forwarding reporter) are attached exactly once, at
 * creation, inside this function — never at module top level — so
 * re-evaluating this module never adds a second copy of any of them to
 * the shared logger.
 */
const LOGGER_KEY = Symbol.for("fabric.repo-logs.logger");

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
function createLogger() {
	const created = createConsola({
		formatOptions: {
			date: false,
			compact: true,
			breakLength: Number.POSITIVE_INFINITY,
		},
	});

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
		created.addReporter({
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
		created.addReporter({
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
		created.addReporter({
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

	// The single fan-out reporter — registered once, here, at creation.
	// `addLogSink` never registers a reporter of its own; it only ever
	// mutates the shared registry this reporter reads from, which is what
	// keeps re-adding the same sink id (or re-evaluating this module)
	// from duplicating delivery.
	if (isServerSide) {
		created.addReporter({ log: forwardToSinks });
	}

	return created;
}

function getLogger() {
	const target = globalThis as Record<PropertyKey, unknown>;
	let instance = target[LOGGER_KEY] as
		| ReturnType<typeof createLogger>
		| undefined;
	if (!instance) {
		instance = createLogger();
		target[LOGGER_KEY] = instance;
	}
	return instance;
}

export const logger = getLogger();

/**
 * Attach a generic sink that receives every warn/error/fatal log line, in
 * ADDITION to (never instead of) the normal console output — this never
 * removes or replaces a reporter, so stdout stays byte-identical.
 *
 * Exists so an external platform (Application Insights) can receive this
 * process's logs without `@repo/logs` depending on the package that talks to
 * it (that dependency would run through `@repo/database`, which already
 * depends on `@repo/logs` — a cycle). The caller wires the two together
 * (see `apps/web/instrumentation.ts`).
 *
 * `id` names the logical sink. Passing the same `id` again REPLACES the
 * previous sink for that id rather than adding a second one — this is what
 * makes wiring idempotent across a module re-evaluation (e.g.
 * `instrumentation.ts`'s `register()` running more than once, or a route
 * handler importing a different module instance than `register()` did —
 * both now share the one registry above). Omitting `id` registers an
 * always-distinct anonymous sink (a fresh `Symbol()` per call), matching
 * the previous never-replaces behavior for callers that want that.
 *
 * Every field the sink receives has gone through the shared sensitive-key +
 * value-shape redactor (`@repo/utils/log-redaction`, the canonical one
 * AGENTS.md mandates — reachable here without a cycle, unlike
 * `redactSensitiveKeys` in `@repo/database`). Redaction failing closed means
 * the entry is DROPPED, never forwarded unredacted; the sink itself is also
 * wrapped so it can never throw back into the log call that triggered it.
 * Server-only, matching the rest of this file.
 */
export function addLogSink(sink: LogSink, id?: string): void {
	if (!isServerSide) {
		return;
	}
	getSinkRegistry().set(id ?? Symbol(), sink);
}
