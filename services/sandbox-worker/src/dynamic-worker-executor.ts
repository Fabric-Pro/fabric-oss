import {
	DYNAMIC_CODE_LIMITS,
	ExecuteCodeRequestSchema,
	ExecuteCodeResponseSchema,
	readBoundedJson,
	type DynamicCodeLoader,
	type ExecuteCodeRequest,
	type ExecuteCodeResponse,
} from "../../../packages/sandbox/src/dynamic-worker";

function moduleSource(code: string): string {
	return `
const encode = new TextEncoder();
const stringify = JSON.stringify.bind(JSON);
export default {
  async fetch(request) {
    const { inputs, execution } = await request.json();
    const logs = [];
    let logBytes = 0;
    const capture = (type, args) => {
      if (logs.length >= ${DYNAMIC_CODE_LIMITS.logEntries}) return;
      const text = args.map(value => typeof value === "string" ? value : stringify(value)).join(" ").slice(0, 1024);
      const bytes = encode.encode(text).byteLength;
      if (logBytes + bytes > ${DYNAMIC_CODE_LIMITS.logBytes}) return;
      logBytes += bytes;
      logs.push({ type, text });
    };
    globalThis.console = {
      log: (...args) => capture("stdout", args),
      info: (...args) => capture("stdout", args),
      debug: (...args) => capture("stdout", args),
      warn: (...args) => capture("stderr", args),
      error: (...args) => capture("stderr", args),
    };
    try {
      async function userMain(inputs, execution) {
${code}
      }
      const value = await userMain(inputs, execution);
      const results = [{ type: "json", json: value }];
      const serialized = stringify(results);
      if (value === undefined || encode.encode(serialized).byteLength > ${DYNAMIC_CODE_LIMITS.outputBytes}) {
        throw new Error("Script must return a JSON value of at most 64 KiB");
      }
      return Response.json({ logs, results });
    } catch (error) {
      return Response.json({ logs, error: String(error instanceof Error ? error.message : error).slice(0, 1000) });
    }
  }
};`;
}

export async function executeDynamicWorkerCode(
	env: { LOADER?: DynamicCodeLoader },
	request: ExecuteCodeRequest,
): Promise<ExecuteCodeResponse> {
	const input = ExecuteCodeRequestSchema.parse(request);
	const loader = env.LOADER;
	if (!loader) {
		throw new Error(
			"Dynamic Worker Loader binding is not available in this deployment.",
		);
	}
	if (input.language !== "javascript") {
		throw new Error(
			"TypeScript must be compiled by the authenticated server client before execution",
		);
	}
	const startedAt = Date.now();
	const source = moduleSource(input.code);
	const worker = loader.load({
		compatibilityDate: "2026-03-24",
		mainModule: "script.js",
		modules: { "script.js": source },
		env: {},
		globalOutbound: null,
		limits: { cpuMs: DYNAMIC_CODE_LIMITS.cpuMs, subRequests: 0 },
	});
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	// This bounds response waiting. CPU termination is enforced by the loader limits.
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			controller.abort();
			reject(new Error("Script response deadline exceeded"));
		}, input.timeout);
	});
	try {
		const run = async () => {
			const response = await worker.getEntrypoint().fetch(
				new Request("https://script.invalid/", {
					method: "POST",
					body: JSON.stringify({
						inputs: input.inputs,
						execution: input.execution,
					}),
					signal: controller.signal,
				}),
			);
			const payload = await readBoundedJson(
				response,
				DYNAMIC_CODE_LIMITS.responseBytes,
			);
			if (
				!response.ok ||
				!payload ||
				typeof payload !== "object" ||
				Array.isArray(payload)
			) {
				throw new Error("Invalid script response");
			}
			return ExecuteCodeResponseSchema.parse({
				...payload,
				code: input.code,
				executionCount: 1,
				executionTime: Date.now() - startedAt,
			});
		};
		return await Promise.race([run(), deadline]);
	} catch (error) {
		return {
			code: input.code,
			logs: [],
			error:
				error instanceof Error
					? error.message.slice(0, 1000)
					: "Script execution failed",
			executionCount: 1,
			executionTime: Date.now() - startedAt,
		};
	} finally {
		clearTimeout(timer);
	}
}
