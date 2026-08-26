import type { Env, ExecuteCodeRequest, ExecuteCodeResponse } from "./types";

/**
 * The TypeScript compiler, loaded on first use rather than at module init.
 *
 * `typescript` is a Node library: importing it runs `getNodeSystem()`, which
 * touches `__filename`. That identifier does not exist in the Workers runtime,
 * so a top-level import made the uploaded script throw during validation —
 * "Uncaught ReferenceError: __filename is not defined" — and no deploy could
 * succeed, whatever else was in the bundle.
 *
 * Deferring it means the reference is only evaluated if somebody actually
 * transpiles TypeScript, which only `/execute` does, and `/execute` refuses
 * before reaching here unless the Dynamic Worker Loader binding exists.
 */
async function typescriptCompiler() {
	return (await import("typescript")).default;
}

function buildModuleSource(code: string): string {
	return `
const formatValue = (value) => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

export default {
  async run(env) {
    const logs = [];
    const originalConsole = globalThis.console;
    const capture = (type, args) => {
      logs.push({ type, text: args.map(formatValue).join(" ") });
    };

    globalThis.console = {
      ...originalConsole,
      log: (...args) => capture("stdout", args),
      info: (...args) => capture("stdout", args),
      warn: (...args) => capture("stderr", args),
      error: (...args) => capture("stderr", args),
    };

    try {
      async function __fabricUserMain(env) {
${code}
      }

      const value = await __fabricUserMain(env);
      return { logs, value };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logs.push({ type: "stderr", text: message });
      return { logs, error: message };
    } finally {
      globalThis.console = originalConsole;
    }
  }
};
`;
}

async function transpileSource(
	code: string,
	language: ExecuteCodeRequest["language"],
): Promise<string> {
	if (language === "javascript") {
		return buildModuleSource(code);
	}

	const ts = await typescriptCompiler();
	return ts.transpileModule(buildModuleSource(code), {
		compilerOptions: {
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.ES2022,
		},
	}).outputText;
}

function toResultPayload(
	request: ExecuteCodeRequest,
	startedAt: number,
	runResult: unknown,
): ExecuteCodeResponse {
	const executionTime = Date.now() - startedAt;
	const payload =
		runResult && typeof runResult === "object"
			? (runResult as {
					logs?: Array<{ type: "stdout" | "stderr"; text: string }>;
					value?: unknown;
					error?: string;
				})
			: {};

	const results =
		payload.value === undefined
			? undefined
			: typeof payload.value === "string"
				? [{ type: "text" as const, text: payload.value }]
				: [{ type: "json" as const, json: payload.value }];

	return {
		code: request.code,
		logs: payload.logs ?? [],
		results,
		error: payload.error,
		executionCount: 1,
		executionTime,
	};
}

export async function executeDynamicWorkerCode(
	env: Env,
	request: ExecuteCodeRequest,
): Promise<ExecuteCodeResponse> {
	const startedAt = Date.now();
	const moduleSource = await transpileSource(request.code, request.language);

	// The route guards this too; keeping the check here means the executor cannot
	// be called into a null binding from a future caller that forgets to.
	const loader = env.LOADER;
	if (!loader) {
		throw new Error(
			"Dynamic Worker Loader binding is not available in this deployment.",
		);
	}

	const worker = loader.load({
		compatibilityDate: "2026-03-24",
		mainModule: "agent.js",
		modules: {
			"agent.js": moduleSource,
		},
		env: {
			METADATA: {
				language: request.language,
				timeout: request.timeout ?? 30000,
			},
		},
		globalOutbound: null,
	});

	const timeout = request.timeout ?? 30000;
	const timeoutPromise = new Promise<never>((_, reject) => {
		setTimeout(
			() => reject(new Error(`Execution timed out after ${timeout}ms`)),
			timeout,
		);
	});

	const runPromise = worker.getEntrypoint().run({
		timeout,
	});

	try {
		const runResult = await Promise.race([runPromise, timeoutPromise]);
		return toResultPayload(request, startedAt, runResult);
	} catch (error) {
		return {
			code: request.code,
			logs: [
				{
					type: "stderr",
					text:
						error instanceof Error
							? error.message
							: "Dynamic Worker execution failed",
				},
			],
			error:
				error instanceof Error
					? error.message
					: "Dynamic Worker execution failed",
			executionCount: 1,
			executionTime: Date.now() - startedAt,
		};
	}
}
