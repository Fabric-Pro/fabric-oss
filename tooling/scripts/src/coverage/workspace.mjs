import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

export function readWorkspace(
	root,
	entries = JSON.parse(
		execFileSync(
			"pnpm",
			["list", "--recursive", "--depth", "-1", "--json"],
			{ cwd: root, encoding: "utf8" },
		),
	),
) {
	const packages = [];
	const noVitest = [];
	for (const { name, path } of entries.sort((a, b) =>
		a.name.localeCompare(b.name),
	)) {
		const { scripts } = JSON.parse(
			readFileSync(join(path, "package.json"), "utf8"),
		);
		const list = /^(?:pnpm (?:exec )?)?vitest(?:\s|$)/.test(
			scripts?.test?.trim(),
		)
			? packages
			: noVitest;
		list.push({ name, dir: relative(root, path) || "." });
	}
	return { packages, noVitest };
}

export function coverageJobs(packages) {
	const jobs = [];
	const rest = [];
	for (const pkg of packages) {
		const shards = { "@repo/web": 3, "@repo/temporal": 2, "@repo/api": 1 }[
			pkg.name
		];
		if (!shards) {
			rest.push({ ...pkg, index: 1, shards: 1 });
			continue;
		}
		const name = pkg.name.split("/").at(-1);
		for (let index = 1; index <= shards; index++) {
			jobs.push({
				id: `${name}-${index}`,
				runs: [{ ...pkg, index, shards }],
			});
		}
	}
	const middle = rest.length > 15 ? Math.ceil(rest.length / 2) : rest.length;
	for (const [index, runs] of [
		rest.slice(0, middle),
		rest.slice(middle),
	].entries()) {
		if (runs.length) {
			jobs.push({ id: `rest-${index + 1}`, runs });
		}
	}
	return jobs;
}
