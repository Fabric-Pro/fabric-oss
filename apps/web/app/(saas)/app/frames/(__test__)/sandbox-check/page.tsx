import {
	type FrameDocumentView,
	FrameRenderer,
} from "@saas/frames/components/FrameRenderer";
import { notFound } from "next/navigation";

/**
 * Internal fixture for the project-frame sandbox browser test
 * (`tests/frames/project-frame-sandbox.spec.ts`). Renders a project-scoped
 * frame whose script tries to escape the sandbox; the spec asserts that
 * `window.parent.document` throws and outbound `fetch` is blocked by the CSP.
 *
 * Not available in production builds. The folder is a route group named
 * `(__test__)` because a plain `__test__` folder would be a Next.js private
 * folder and never route; the page is served at `/app/frames/sandbox-check`.
 */
export const dynamic = "force-dynamic";

const FIXTURE: FrameDocumentView = {
	version: 1,
	kind: "frame",
	title: "Project frame sandbox check",
	blocks: [
		{
			id: "escape-attempts",
			type: "html",
			title: "Escape attempts",
			content: `<!doctype html>
<html>
<head>
<style>body{font-family:system-ui,sans-serif;padding:16px}</style>
</head>
<body>
<h1 id="heading">Sandbox fixture</h1>
<p id="parent-access">pending</p>
<p id="fetch-access">pending</p>
<iframe id="nested" src="https://example.com/"></iframe>
<script>
(function () {
	var parentEl = document.getElementById("parent-access");
	try {
		void window.parent.document;
		parentEl.textContent = "accessible";
	} catch (error) {
		parentEl.textContent = "blocked";
	}
	var fetchEl = document.getElementById("fetch-access");
	fetch("https://example.com/", { mode: "no-cors" })
		.then(function () { fetchEl.textContent = "allowed"; })
		.catch(function () { fetchEl.textContent = "blocked"; });
})();
</script>
</body>
</html>`,
		},
	],
};

export default function ProjectFrameSandboxCheckPage() {
	if (process.env.NODE_ENV === "production") {
		notFound();
	}

	return (
		<div className="mx-auto max-w-4xl p-6" data-testid="sandbox-check-page">
			<p className="editorial-label">Internal fixture</p>
			<h1 className="font-serif text-3xl">Project frame sandbox check</h1>
			<div className="mt-6">
				<FrameRenderer frame={FIXTURE} projectScoped />
			</div>
		</div>
	);
}
