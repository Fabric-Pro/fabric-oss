/**
 * Root postinstall: rebuild gitignored dist/ outputs that local dev needs but
 * that nothing in the Aspire dev path builds.
 *
 * - @fabricorg/* publishable packages export compiled dist/; the Aspire web
 *   resource runs plain `next dev` (no turbo), so a fresh pull leaves them
 *   missing and web dev fails with "Module not found".
 * - The weave-* agent containers bind-mount the repo and run `node
 *   dist/index.js`, only building when dist/index.js is MISSING — a stale
 *   bundle survives every pull.
 *
 * Skipped on Vercel/CI: those environments build through turbo (whose
 * `build` task depends on `^build`), may use scoped installs where the agent
 * workspaces' devDependencies are absent, and never run the Aspire dev path.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

if (process.env.VERCEL || process.env.CI) {
	console.log(
		"postinstall: CI/Vercel detected — skipping local dev dist build",
	);
	process.exit(0);
}

const filters = [
	"@fabricorg/*",
	"weave-readers",
	"weave-planners",
	"weave-shuttle",
].flatMap((f) => ["--filter", f]);

// Invoke turbo's JS entry point via the current Node executable — works on
// every platform without a shell (Semgrep flags `shell: true`, and Windows
// can't spawn .cmd shims without one).
const turboBin = createRequire(import.meta.url).resolve("turbo/bin/turbo");

try {
	execFileSync(process.execPath, [turboBin, "build", ...filters], {
		stdio: "inherit",
	});
} catch {
	process.exit(1);
}
