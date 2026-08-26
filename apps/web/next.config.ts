import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { withContentCollections } from "@content-collections/next";
// @ts-expect-error - PrismaPlugin is not typed
import { PrismaPlugin } from "@prisma/nextjs-monorepo-workaround-plugin";
import type { NextConfig } from "next";
import nextIntlPlugin from "next-intl/plugin";

const withNextIntl = nextIntlPlugin("./modules/i18n/request.ts");

/**
 * Fail the BUILD if the sharp/libvips native package the
 * `outputFileTracingIncludes` glob below must match is not where the glob
 * looks. The tracer treats a no-match include as a silent no-op — and a
 * missing libvips is precisely the 2026-07-22 staging outage (green build,
 * every server invocation dead at dlopen). This converts that silent runtime
 * failure into a red build the moment anything moves the target: a pnpm major
 * changing the store layout, a node-linker change, or a platform variant the
 * glob doesn't cover. Linux server builds only — win32/darwin sharp bundles
 * libvips inside the platform addon and has no separate libvips package.
 */
function assertSharpLibvipsTraceable(): void {
	const isLinuxServerBuild =
		process.platform === "linux" &&
		(process.env.VERCEL === "1" || process.env.DOCKER_BUILD === "true");
	if (!isLinuxServerBuild) {
		return;
	}
	const storeDir = path.resolve(__dirname, "../../node_modules/.pnpm");
	const entries = fs.existsSync(storeDir) ? fs.readdirSync(storeDir) : [];
	// Must mirror the outputFileTracingIncludes globs EXACTLY (glibc x64 +
	// arm64, deliberately not musl): a store holding only a variant the globs
	// don't trace has to fail here, not at runtime.
	if (
		!entries.some((entry) =>
			/^@img\+sharp-libvips-linux-(x64|arm64)@/.test(entry),
		)
	) {
		throw new Error(
			"sharp/libvips guard: no @img+sharp-libvips-linux-{x64,arm64} " +
				`package found in ${storeDir} — the outputFileTracingIncludes ` +
				"globs in next.config.ts would silently match nothing and every " +
				"deployed function would crash at import with ERR_DLOPEN_FAILED " +
				"(see the 2026-07-22 staging outage). Fix the glob/store layout " +
				"before deploying.",
		);
	}
}
assertSharpLibvipsTraceable();

/**
 * Database providers this app cannot connect to. Prisma ships a WASM query
 * engine AND a WASM query compiler for every database it supports, and the file
 * tracer copies the whole `@prisma/client/runtime` directory into EVERY
 * serverless function. Measured on a real build of `/api/[[...rest]]`: 42.6 MB
 * of a 157 MB traced bundle was engines for databases this app has no
 * datasource for — more than a quarter of the function, repeated per function.
 *
 * Nothing can reach them at runtime. The datasource is `provider =
 * "postgresql"` and the generated client imports one compiler by literal name
 * (`@prisma/client/runtime/query_compiler_bg.postgresql.mjs`) — there is no
 * dynamic provider interpolation for the tracer to resolve conservatively, and
 * `query_engine_bg.*` is not referenced by the generated client at all.
 */
const PRISMA_UNUSED_DB_PROVIDERS = [
	"cockroachdb",
	"mysql",
	"sqlite",
	"sqlserver",
] as const;

/** Generated Prisma client — the module that actually picks the engine. */
const PRISMA_GENERATED_CLIENT = path.resolve(
	__dirname,
	"../../packages/database/prisma/generated/internal/class.js",
);

/** Committed schema — the fallback source of truth when nothing is generated. */
const PRISMA_SCHEMA = path.resolve(
	__dirname,
	"../../packages/database/prisma/schema.prisma",
);

/** pnpm virtual-store directory the exclude globs below are written against. */
const PNPM_STORE_DIR = path.resolve(__dirname, "../../node_modules/.pnpm");

/**
 * Every database provider this build can actually reach, read from the
 * artifacts rather than assumed.
 *
 * Prefers the generated client because that is what ships: its `activeProvider`
 * and its literal `query_*_bg.<provider>` imports are the real answer. Falls
 * back to the committed schema's `datasource` block when the client has not been
 * generated yet. Returns an empty set only when NEITHER source yields anything,
 * which the caller treats as a failure rather than a pass.
 */
function resolvePrismaProviders(): Set<string> {
	const providers = new Set<string>();
	if (fs.existsSync(PRISMA_GENERATED_CLIENT)) {
		const source = fs.readFileSync(PRISMA_GENERATED_CLIENT, "utf8");
		for (const match of source.matchAll(
			/query_(?:engine|compiler)_bg\.([a-z]+)\./g,
		)) {
			providers.add(match[1]);
		}
		const activeProvider = source.match(
			/"activeProvider"\s*:\s*"([a-z]+)"/,
		)?.[1];
		if (activeProvider) {
			providers.add(activeProvider);
		}
	}
	if (providers.size === 0 && fs.existsSync(PRISMA_SCHEMA)) {
		// `datasource db { provider = "postgresql" ... }` — the generator block's
		// own `provider` is a generator name, so anchor on the datasource block.
		// Comments are stripped first: `// provider = "mysql"` sitting above the
		// real line would otherwise read as the active provider and fail the
		// build, and a `}` inside a comment would truncate the block match.
		const schema = stripPrismaComments(
			fs.readFileSync(PRISMA_SCHEMA, "utf8"),
		);
		for (const block of schema.matchAll(
			/datasource\s+\w+\s*\{([^}]*)\}/g,
		)) {
			const provider = block[1].match(/provider\s*=\s*"([a-z]+)"/)?.[1];
			if (provider) {
				providers.add(provider);
			}
		}
	}
	return providers;
}

/**
 * Drop `//` comments from Prisma schema text, leaving quoted strings intact so a
 * `postgresql://…` URL literal does not get cut in half.
 */
function stripPrismaComments(schema: string): string {
	return schema
		.split("\n")
		.map((line) => {
			let quoted = false;
			for (let i = 0; i < line.length; i++) {
				if (line[i] === '"' && line[i - 1] !== "\\") {
					quoted = !quoted;
				} else if (!quoted && line[i] === "/" && line[i + 1] === "/") {
					return line.slice(0, i);
				}
			}
			return line;
		})
		.join("\n");
}

/**
 * Fail the BUILD if the provider this app actually uses is one the exclude
 * below strips from the traced output.
 *
 * The exclude is a size optimization, but it fails in the same direction as the
 * libvips include above: a glob that matches nothing is a SILENT no-op, and a
 * glob that matches too much produces a green build whose functions die at the
 * first query. Switching the datasource — or generating for a second provider —
 * without updating `PRISMA_UNUSED_DB_PROVIDERS` would strip the engine the app
 * has just started needing.
 *
 * Requires POSITIVE evidence. "I could not tell which provider is in use" is
 * not the same as "the excluded ones are unused", so an unreadable or
 * unrecognised artifact fails the build rather than silently keeping the
 * exclude active — the failure mode if a future Prisma release rebundles its
 * output or builds the import specifier indirectly.
 */
function assertPrismaEngineExcludesAreSafe(): void {
	const providers = resolvePrismaProviders();
	if (providers.size === 0) {
		throw new Error(
			"Prisma engine trace guard: could not determine which database provider this build uses — " +
				`neither ${PRISMA_GENERATED_CLIENT} nor ${PRISMA_SCHEMA} yielded one. next.config.ts strips ` +
				`the WASM engines for ${PRISMA_UNUSED_DB_PROVIDERS.join(", ")} from output file tracing, and ` +
				"cannot prove that is still safe. Run `pnpm --filter @repo/database generate` before building, " +
				"or update the guard if Prisma's generated output has changed shape.",
		);
	}
	const stripped = PRISMA_UNUSED_DB_PROVIDERS.filter((provider) =>
		providers.has(provider),
	);
	if (stripped.length > 0) {
		throw new Error(
			`Prisma engine trace guard: this build uses the ${stripped.join(", ")} provider, ` +
				"but next.config.ts lists it in PRISMA_UNUSED_DB_PROVIDERS and excludes its WASM engine from " +
				"output file tracing. Deployed functions would build green and then fail on their first query. " +
				"Remove the provider from PRISMA_UNUSED_DB_PROVIDERS.",
		);
	}
}
assertPrismaEngineExcludesAreSafe();

/**
 * Fail the BUILD if the pnpm layout the exclude globs are written against is
 * not the layout on disk.
 *
 * Same silent-no-op hazard the libvips guard exists for, pointing the other way:
 * an exclude that stops matching does not break anything at runtime, it quietly
 * hands back the 42.6 MB and re-arms the deploy failure this whole change exists
 * to prevent — on the build where someone changed the node-linker or bumped
 * pnpm, far from where they would look.
 *
 * VERCEL ONLY, deliberately. This is a size guard, not a safety guard: the 250 MB
 * ceiling it protects is Vercel's. On a self-hosted standalone Docker build a
 * no-op exclude costs some image size and nothing else, so blocking a valid
 * hoisted-node_modules Docker build over it would be the guard causing the
 * outage. The provider guard above runs everywhere, because THAT one is about
 * correctness.
 *
 * Asserts the globs can actually match rather than that the package name exists:
 * a stale store entry, or a future layout keeping the outer name while moving
 * the nested runtime, would pass a name-only check while matching no files.
 * Prisma dropping these engines entirely counts as success — nothing to exclude
 * is the goal state, not a failure.
 */
function assertPrismaExcludeGlobsMatchLayout(): void {
	if (process.env.VERCEL !== "1") {
		return;
	}
	const storeEntries = fs.existsSync(PNPM_STORE_DIR)
		? fs.readdirSync(PNPM_STORE_DIR)
		: [];
	const clientEntries = storeEntries.filter((entry) =>
		/^@prisma\+client@/.test(entry),
	);
	const runtimeDirs = clientEntries
		.map((entry) =>
			path.join(
				PNPM_STORE_DIR,
				entry,
				"node_modules/@prisma/client/runtime",
			),
		)
		.filter((dir) => fs.existsSync(dir));

	if (runtimeDirs.length === 0) {
		throw new Error(
			"Prisma engine trace guard: no @prisma+client@*/node_modules/@prisma/client/runtime directory " +
				`found under ${PNPM_STORE_DIR}, so the outputFileTracingExcludes globs in next.config.ts ` +
				"match nothing and every serverless function silently ships ~42 MB of unused WASM engines — " +
				"against Vercel's 250 MB limit this app deploys close to. Rewrite the globs for the current " +
				"node-linker/store layout before deploying.",
		);
	}

	// Prove at least one file the globs target is really there. If Prisma has
	// stopped shipping per-provider engines altogether, there is nothing to
	// exclude and nothing to warn about.
	const targeted = runtimeDirs.some((dir) =>
		fs
			.readdirSync(dir)
			.some((file) =>
				PRISMA_UNUSED_DB_PROVIDERS.some((provider) =>
					new RegExp(
						`^query_(engine|compiler)_bg\\.${provider}\\.`,
					).test(file),
				),
			),
	);
	const anyProviderEngines = runtimeDirs.some((dir) =>
		fs
			.readdirSync(dir)
			.some((file) => /^query_(engine|compiler)_bg\./.test(file)),
	);
	if (!targeted && anyProviderEngines) {
		throw new Error(
			"Prisma engine trace guard: @prisma/client/runtime still ships per-provider WASM engines, but " +
				`none match the ${PRISMA_UNUSED_DB_PROVIDERS.join(", ")} filenames the ` +
				"outputFileTracingExcludes globs in next.config.ts target — so the excludes match nothing and " +
				"the unused engines ship anyway. Prisma has probably renamed them; update the globs.",
		);
	}
}
assertPrismaExcludeGlobsMatchLayout();

/**
 * Build-version identifier baked into the bundle so the running client can be
 * compared against the latest deployment (see
 * modules/shared/lib/app-version.ts). Prefer an explicit override, then
 * Vercel's commit SHA, then the local git SHA; fall back to "dev" when none is
 * resolvable, in which case the version watcher stays inert.
 */
function resolveAppVersion(): string {
	const explicit = process.env.NEXT_PUBLIC_APP_VERSION?.trim();
	if (explicit) {
		return explicit;
	}
	const vercelSha = process.env.VERCEL_GIT_COMMIT_SHA?.trim();
	if (vercelSha) {
		return vercelSha;
	}
	try {
		const sha = execSync("git rev-parse HEAD", {
			stdio: ["ignore", "pipe", "ignore"],
		})
			.toString()
			.trim();
		if (sha) {
			return sha;
		}
	} catch {
		// No git available (e.g. some container builds) — fall through to dev.
	}
	return "dev";
}

const appVersion = resolveAppVersion();

const nextConfig: NextConfig = {
	// Expose the resolved build version to the client bundle and the
	// /api/version route so stale-build detection can compare loaded vs latest.
	env: {
		NEXT_PUBLIC_APP_VERSION: appVersion,
	},

	// Enable standalone output for Docker and Vercel deployments
	// This creates a minimal production build with all dependencies bundled
	// Set DOCKER_BUILD=true to enable (used in Docker and Vercel builds)
	output: process.env.DOCKER_BUILD === "true" ? "standalone" : undefined,

	// NFT DYNAMIC-OP HAZARD (contained — do not undo the mitigations).
	//
	// Turbopack special-cases child_process during output file tracing: a
	// spawn/exec whose COMMAND it cannot statically resolve makes it trace the
	// entire project into every route importing that module, announced as
	// "Encountered unexpected file in NFT list". `/*turbopackIgnore: true*/` is
	// NOT honored on child_process calls (it works for fs/path, and only on a
	// bare variable — vercel/next.js#95125), so the only fix is keeping the
	// command a literal: see the spawnKanban/spawnSyncKanban wrappers in
	// packages/temporal/src/lib/coding-execution/local-kanban-provider.ts, which
	// branch on an enum rather than passing a variable. Collapsing those back
	// into one dynamic call site re-arms the whole-monorepo trace.
	//
	// Measured 2026-08-16, three full builds: the warning does not fire and
	// there is no monorepo pull-in. /api/[[...rest]] traces 27.9 MB of repo
	// files, and all but 0.05 MB of that is this app's own .next output — no
	// agents/, docs/ or aspire/. local-kanban-provider.ts and security.ts are
	// not traced into the function at all.
	//
	// One trip point remains: packages/evidence/src/builder/docker-builder.ts
	// resolves path.join(__dirname, "../../docker"), reached through the same
	// activities barrel. (Its child_process calls are execFile with literal
	// program names now, so only the __dirname resolution is dynamic.) Its
	// observed cost is one file (packages/evidence/docker/Dockerfile), so it is
	// not worth restructuring — but it is the thing to look at first if the
	// warning ever returns. Re-check with `pnpm --filter web build` and the
	// function-size report at the tail of that build; the trace weight today is
	// ordinary dependency size, not this.

	// When the Vercel buildCommand runs the type-check as a SEPARATE turbo
	// task (NEXT_TYPECHECK_SPLIT=true), skip the in-build check: Next 16's
	// checker re-checks the full app (~120s) on every build and does not
	// honor incremental .tsbuildinfo state. The split `tsc --noEmit` task
	// DOES (measured: cold 138s → warm 23s via the .tsbuildinfo persisted in
	// .next/cache) and still fails the same deployment on type errors.
	//
	// The two MUST NOT overlap: running them in parallel OOM-killed the 16 GB
	// build machine (next@6GB heap + tsc@6GB heap + Turbopack native memory).
	// That used to be guaranteed by `@repo/web#type-check` dependsOn `build`;
	// it now depends on `typegen` instead, so the ordering lives in
	// apps/web/vercel.json, which runs `turbo type-check` and `turbo build` as
	// two `&&`-chained invocations (type-check first, so a type error fails
	// before the expensive build). tsc still sees fresh .next/types route
	// validations — `next typegen` writes the identical routes.d.ts /
	// validator.ts / cache-life.d.ts set — so gate fidelity is unchanged.
	// Plain `next build` (local, Docker) keeps the in-build check.
	typescript: {
		ignoreBuildErrors: process.env.NEXT_TYPECHECK_SPLIT === "true",
	},

	// Turbopack configuration for content-collections
	turbopack: {
		root: path.resolve(__dirname, "../.."),
		resolveAlias: {
			"content-collections": "./.content-collections/generated",
			// Turbopack can't resolve @repo/ai when imported transitively from
			// @repo/integrations. Explicit alias ensures resolution works.
			"@repo/ai": "../../packages/ai",
			// Same Turbopack limitation for the @repo/utils subpath export
			// `correlation-id` when imported transitively from @repo/logs.
			"@repo/utils/correlation-id":
				"../../packages/utils/lib/correlation-id.ts",
		},
	},

	// Optimize barrel imports for icon and component libraries
	// This automatically transforms: import { X } from 'lucide-react'
	// Into direct imports: import X from 'lucide-react/dist/esm/icons/x'
	// Results in 15-70% faster dev boot, 28% faster builds, 40% faster cold starts
	experimental: {
		turbopackFileSystemCacheForDev: true,

		// Page-data collection is what OOM-kills this build, not compilation.
		//
		// Measured on a failed Vercel build (16 GB container): compilation
		// finished in 2.2 min, then "Collecting page data using 7 workers"
		// walked memory from 2.2 GB to a peak of 15.79 GB — 99% of the
		// container — and the platform SIGKILLed it. Each worker is a separate
		// Node process that imports the app's server module graph, so peak
		// memory in that phase scales with the worker count, and this app's
		// graph is large enough that seven of them do not fit.
		//
		// `getNumberOfWorkers` in Next's build derives the count from the
		// machine when this is unset. Pinning it trades a little wall-clock in
		// one phase for a build that finishes: at ~2 GB per worker the same
		// phase has room to spare rather than living at 99%. `next build`
		// reports the peak on every run via scripts/build-with-memory-report.mjs,
		// so the effect of changing this number is visible in the build log
		// rather than inferred.
		cpus: 3,

		optimizePackageImports: [
			"lucide-react",
			"@radix-ui/react-icons",
			"date-fns",
			"@tanstack/react-query",
		],
	},

	// sharp >= 0.35 links its prebuilt addon DYNAMICALLY against libvips
	// shipped in the separate @img/sharp-libvips-* package (0.34 was found by
	// the tracer; 0.35's relocated .so was not). Because `sharp` is a
	// serverExternalPackage, the file tracer must copy those native files into
	// every serverless function — when it misses them, EVERY server invocation
	// dies at import with ERR_DLOPEN_FAILED "libvips-cpp.so.8.18.3: cannot
	// open shared object file" (staging outage, 2026-07-22, after #2126 bumped
	// sharp for GHSA-f88m-g3jw-g9cj).
	//
	// Deliberately ONLY the libvips lib/ dir (~12 MB): the addon package
	// itself IS traced (the runtime got far enough to dlopen), and the
	// api/[[...rest]] function already sits only a few MB under the 250 MB
	// limit — a broader @img/** include pushed it over and failed the deploy.
	// Both GLIBC variants are listed so an arm64 Docker build of the
	// self-hosted image matches too. NOT `linux*`: pnpm's libc detection also
	// installs the ~9 MB musl variant on the Vercel builder, and a wildcard
	// matching it pushed the catch-all function back over the limit (measured:
	// 255.89 MB). No repo image uses musl/alpine. The tracer treats a no-match
	// glob as a SILENT no-op, which is exactly the outage mode — hence the
	// boot assertion below.
	outputFileTracingIncludes: {
		"/*": [
			"../../node_modules/.pnpm/@img+sharp-libvips-linux-x64@*/node_modules/@img/sharp-libvips-linux-x64/lib/**/*",
			"../../node_modules/.pnpm/@img+sharp-libvips-linux-arm64@*/node_modules/@img/sharp-libvips-linux-arm64/lib/**/*",
		],
	},

	// Drop the WASM engines for databases this app has no datasource for (see
	// PRISMA_UNUSED_DB_PROVIDERS above for why they are unreachable, and
	// assertPrismaEngineExcludesAreSafe for the guard that keeps that true).
	// Measured on /api/[[...rest]]: 157.3 MB traced → 114.7 MB, i.e. 42.6 MB
	// back on EVERY function, against Vercel's 250 MB uncompressed limit that
	// this app was deploying within a few MB of.
	//
	// `/*` is the same route key the includes above use, and it demonstrably
	// reaches nested routes: the libvips .so it force-includes shows up in
	// /api/[[...rest]]'s trace. The engine and compiler families are spelled out
	// rather than globbed as `query_*_bg` so a future `query_<something>_bg`
	// family cannot be stripped without someone deciding to; the trailing `.*`
	// covers the plain, `.mjs` and `.wasm-base64` forms, shipped as separate
	// files.
	outputFileTracingExcludes: {
		"/*": PRISMA_UNUSED_DB_PROVIDERS.flatMap((provider) =>
			["query_engine_bg", "query_compiler_bg"].map(
				(family) =>
					"../../node_modules/.pnpm/@prisma+client@*/node_modules/@prisma/client/runtime/" +
					`${family}.${provider}.*`,
			),
		),
	},

	// Exclude packages from bundling to avoid module resolution issues
	// - Prisma: new prisma-client generator format issues
	// - Temporal: protobuf duplicate registration errors with Turbopack
	// - Template engines: use dynamic require() which doesn't work when bundled in ESM
	serverExternalPackages: [
		"sharp",
		"@prisma/client",
		"@prisma/adapter-pg",
		"@temporalio/client",
		"@temporalio/common",
		"@temporalio/proto",
		"@temporalio/workflow",
		"@temporalio/activity",
		"@temporalio/worker",
		"@temporalio/interceptors-opentelemetry",
		"@temporalio/nexus",
		"@temporalio/core-bridge",
		"protobufjs",
		"long",
		// Observability package (uses OpenTelemetry which has CJS/ESM interop issues)
		"@repo/observability",
		// OpenTelemetry packages (avoid bundling for instrumentation)
		"@opentelemetry/api",
		"@opentelemetry/api-logs",
		"@opentelemetry/sdk-node",
		"@opentelemetry/sdk-trace-node",
		"@opentelemetry/sdk-metrics",
		"@opentelemetry/sdk-logs",
		"@opentelemetry/resources",
		"@opentelemetry/semantic-conventions",
		"@opentelemetry/exporter-trace-otlp-http",
		"@opentelemetry/exporter-trace-otlp-grpc",
		"@opentelemetry/exporter-metrics-otlp-http",
		"@opentelemetry/exporter-metrics-otlp-grpc",
		"@opentelemetry/exporter-logs-otlp-http",
		"@opentelemetry/exporter-logs-otlp-grpc",
		"@opentelemetry/auto-instrumentations-node",
		// prom-client uses dynamic require of Node.js core modules
		"prom-client",
		"nunjucks",
		"handlebars",
		"mustache",
		"liquidjs",
		// LangChain packages (used by agent-core, pnpm isolation prevents Turbopack from finding them)
		"@langchain/anthropic",
		"@langchain/groq",
		"@langchain/openai",
		"@langchain/core",
		"langchain",
		// CopilotKit runtime (imports langchain/runnables/remote which doesn't bundle cleanly)
		"@copilotkit/runtime",
		// code-chunk + tree-sitter (native WASM, used by @repo/rag code chunker — only runs in Temporal)
		"code-chunk",
		"web-tree-sitter",
		"tree-sitter-typescript",
		"tree-sitter-javascript",
		"tree-sitter-python",
		"tree-sitter-go",
		"tree-sitter-rust",
		"tree-sitter-java",
		// Application Insights SDK + its diagnostic-channel publishers ship
		// optional driver shims (mysql, mongodb, redis, postgres, etc.) that
		// use dynamic `require()` and cannot be bundled by Turbopack/webpack.
		// Mark them external so Next.js loads them from node_modules at
		// runtime instead.
		"applicationinsights",
		"applicationinsights-native-metrics",
		"diagnostic-channel",
		"diagnostic-channel-publishers",
		"@azure/functions-core",
		"@azure/opentelemetry-instrumentation-azure-sdk",
	],

	transpilePackages: [
		"@agents/langchain-prd-agent",
		"@repo/agent-prompts",
		"@repo/api",
		"@repo/auth",
		"@repo/database",
		"@repo/ai",
		"@repo/config",
		"@repo/i18n",
		"@repo/mail",
		"@repo/payments",
		"@repo/storage",
		"@repo/utils",
		"@repo/logs",
		"@repo/mcp",
		"@repo/rag",
		"@repo/temporal",
		"@repo/agent-core",
		"@repo/agent-runtime",
		"@repo/agent-tools",
		"@repo/atlas",
		"@repo/code-validation",
		"@repo/agent-types",
		"@repo/letta",
		"@repo/openapi-tools",
		"@repo/integrations",
		"@repo/ai-token",
	],
	images: {
		remotePatterns: [
			{
				// google profile images
				protocol: "https",
				hostname: "lh3.googleusercontent.com",
			},
			{
				// github profile images
				protocol: "https",
				hostname: "avatars.githubusercontent.com",
			},
			{
				// icons8 framework icons
				protocol: "https",
				hostname: "img.icons8.com",
			},
			{
				// GitHub assets
				protocol: "https",
				hostname: "github.githubassets.com",
			},
			{
				// Playwright
				protocol: "https",
				hostname: "playwright.dev",
			},
			{
				// PostgreSQL
				protocol: "https",
				hostname: "www.postgresql.org",
			},
			{
				// SQLite
				protocol: "https",
				hostname: "www.sqlite.org",
			},
			{
				// Flaticon CDN (for icons)
				protocol: "https",
				hostname: "cdn-icons-png.flaticon.com",
			},
			{
				// Google static assets
				protocol: "https",
				hostname: "www.gstatic.com",
			},
			{
				// Google SSL static
				protocol: "https",
				hostname: "ssl.gstatic.com",
			},
			{
				// Slack assets
				protocol: "https",
				hostname: "a.slack-edge.com",
			},
			{
				// Linear
				protocol: "https",
				hostname: "linear.app",
			},
			{
				// Firecrawl
				protocol: "https",
				hostname: "www.firecrawl.dev",
			},
			{
				// Notion
				protocol: "https",
				hostname: "www.notion.so",
			},
			{
				// Brave
				protocol: "https",
				hostname: "brave.com",
			},
			{
				// Context7
				protocol: "https",
				hostname: "context7.com",
			},
			{
				// Supabase
				protocol: "https",
				hostname: "supabase.com",
			},
		],
	},
	async redirects() {
		return [
			// The testing docs moved from four sibling pages under /features to a
			// nested section, so the parts of one feature read as one feature.
			// These keep every link anyone has already shared or bookmarked alive.
			{
				source: "/docs/features/test-cases",
				destination: "/docs/features/testing/cases",
				permanent: true,
			},
			{
				source: "/docs/features/qa-settings",
				destination: "/docs/features/testing/settings",
				permanent: true,
			},
			{
				source: "/docs/features/pipeline-results",
				destination: "/docs/features/testing/ci-results",
				permanent: true,
			},
			{
				source: "/docs/features/pull-request-reviews",
				destination: "/docs/features/testing/pull-requests",
				permanent: true,
			},
			{
				source: "/app/settings",
				destination: "/app/settings/general",
				permanent: true,
			},
			{
				source: "/app/:organizationSlug/settings",
				destination: "/app/:organizationSlug/settings/general",
				permanent: true,
			},
			{
				source: "/app/admin",
				destination: "/app/admin/users",
				permanent: true,
			},
		];
	},
	async headers() {
		// Baseline security response headers, deliberately limited to headers
		// that are safe for EVERY route (no per-route exceptions needed):
		//  - HSTS pins HTTPS for this host. `includeSubDomains` is intentionally
		//    omitted so it cannot affect any *.fabric.pro subdomain that may not
		//    be served over HTTPS (a hard-to-reverse footgun); `preload` is also
		//    omitted for the same reason.
		//  - nosniff blocks MIME-type sniffing.
		//  - Referrer-Policy is set explicitly to the modern browser default.
		//  - Permissions-Policy denies powerful features the app does not use
		//    (verified: no getUserMedia/mediaDevices/geolocation usage in-app).
		//
		// Clickjacking protection (X-Frame-Options / CSP frame-ancestors) is
		// intentionally NOT set globally: several routes are meant to be embedded
		// cross-origin (/embed/*, /app/frames/*/embed, /app/*/frames/*/embed,
		// /share/frame/*), and only /embed currently sets its own frame-ancestors
		// (proxy.ts). A blanket X-Frame-Options would break the others. A precise
		// per-route framing policy is tracked as a SOC 2 hand-off item.
		const securityHeaders = [
			{ key: "Strict-Transport-Security", value: "max-age=31536000" },
			{ key: "X-Content-Type-Options", value: "nosniff" },
			{
				key: "Referrer-Policy",
				value: "strict-origin-when-cross-origin",
			},
			{
				key: "Permissions-Policy",
				value: "camera=(), microphone=(), geolocation=()",
			},
			// Content-Security-Policy in REPORT-ONLY mode (SOC 2 CC6.6). This does
			// NOT block anything — it measures what a future enforced CSP would
			// break, with violations POSTed to /api/security/csp-report. Kept
			// permissive for the first pass: Next.js App Router emits inline
			// hydration scripts and Radix/Tailwind emit inline styles (need
			// 'unsafe-inline'/'unsafe-eval'), and the app loads images/fonts/frames
			// from many https hosts. Enforced, nonce-based CSP is the follow-up.
			// `frame-ancestors` is deliberately omitted — framing is handled
			// per-route (proxy.ts sets it for /app; /embed routes are meant to be
			// embeddable cross-origin), so a global directive here would only
			// generate false-positive reports.
			{
				key: "Content-Security-Policy-Report-Only",
				value: [
					"default-src 'self'",
					"base-uri 'self'",
					"object-src 'none'",
					"img-src 'self' data: blob: https:",
					"font-src 'self' data:",
					"style-src 'self' 'unsafe-inline'",
					"script-src 'self' 'unsafe-inline' 'unsafe-eval'",
					"connect-src 'self' https: wss:",
					"frame-src 'self' https:",
					"worker-src 'self' blob:",
					"manifest-src 'self'",
					"form-action 'self'",
					"report-uri /api/security/csp-report",
					"report-to csp-endpoint",
				].join("; "),
			},
			{
				key: "Reporting-Endpoints",
				value: 'csp-endpoint="/api/security/csp-report"',
			},
		];
		return [
			{
				source: "/:path*",
				headers: securityHeaders,
			},
		];
	},
	webpack: (config, { webpack, isServer }) => {
		config.plugins.push(
			new webpack.IgnorePlugin({
				resourceRegExp: /^pg-native$/,
			}),
		);

		if (isServer) {
			config.plugins.push(new PrismaPlugin());
		}

		return config;
	},
};

export default withContentCollections(withNextIntl(nextConfig));
