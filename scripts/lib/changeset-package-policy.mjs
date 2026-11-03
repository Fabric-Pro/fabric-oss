#!/usr/bin/env node
// Built-ins only: CI runs this without installing the workspace.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const remedy =
	'Name "fabric-app": patch and any genuinely published @fabricorg/* package instead.';

function workspacePackages(root) {
	const yaml = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
	const section = /^packages:\s*\n((?:[ \t]+[^\n]*\n|\s*\n)*)/m.exec(
		yaml,
	)?.[1];
	if (!section) {
		throw new Error("workspace package patterns are missing");
	}
	const patterns = section
		.split("\n")
		.filter((line) => /^\s*-/.test(line))
		.map((line) => {
			const value = line
				.replace(/^\s*-\s*/, "")
				.trim()
				.replace(/^(["'])(.*)\1$/, "$2");
			if (!/^!?[a-zA-Z0-9_/*.-]+$/.test(value)) {
				throw new Error(`unsupported workspace pattern: ${value}`);
			}
			return value;
		});
	const excluded = patterns
		.filter((p) => p.startsWith("!"))
		.map(
			(p) =>
				new RegExp(
					`^${p
						.slice(1)
						.split("/")
						.map((s) =>
							s === "**"
								? ".*"
								: s
										.replaceAll(".", "\\.")
										.replaceAll("*", "[^/]*"),
						)
						.join("/")}$`,
				),
		);
	const dirs = new Set();
	function expand(parts, dir = "") {
		if (!parts.length) {
			dirs.add(dir);
			return;
		}
		const [part, ...rest] = parts;
		if (part === "**") {
			throw new Error(
				"positive recursive workspace globs are unsupported",
			);
		}
		const regex = new RegExp(
			`^${part.replaceAll(".", "\\.").replaceAll("*", ".*")}$`,
		);
		for (const entry of readdirSync(join(root, dir), {
			withFileTypes: true,
		})) {
			if (
				entry.isDirectory() &&
				entry.name !== "node_modules" &&
				!entry.name.startsWith(".") &&
				regex.test(entry.name)
			) {
				expand(rest, dir ? `${dir}/${entry.name}` : entry.name);
			}
		}
	}
	for (const pattern of patterns.filter((p) => !p.startsWith("!"))) {
		expand(pattern.split("/"));
	}
	const packages = new Map();
	for (const dir of dirs) {
		if (
			excluded.some((regex) => regex.test(dir) || regex.test(`${dir}/`))
		) {
			continue;
		}
		let manifest;
		try {
			manifest = JSON.parse(
				readFileSync(join(root, dir, "package.json"), "utf8"),
			);
		} catch (error) {
			if (error.code === "ENOENT") {
				continue;
			}
			throw error;
		}
		if (typeof manifest.name !== "string") {
			throw new Error(`package name missing: ${dir}`);
		}
		if (packages.has(manifest.name)) {
			throw new Error(`duplicate package: ${manifest.name}`);
		}
		packages.set(manifest.name, { dir, private: manifest.private });
	}
	return packages;
}

export function checkStatusFile(file, root = process.cwd()) {
	try {
		const status = JSON.parse(readFileSync(file, "utf8"));
		if (
			!Array.isArray(status?.changesets) ||
			!Array.isArray(status?.releases)
		) {
			throw new Error("invalid status arrays");
		}
		const validRelease = (r) =>
			r &&
			typeof r.name === "string" &&
			r.name.length > 0 &&
			["patch", "minor", "major", "none"].includes(r.type);
		if (
			!status.releases.every(validRelease) ||
			!status.changesets.every(
				(c) =>
					c &&
					typeof c.id === "string" &&
					Array.isArray(c.releases) &&
					c.releases.every(validRelease),
			)
		) {
			throw new Error("invalid status entries");
		}
		const packages = workspacePackages(root);
		const errors = [];
		for (const changeset of status.changesets) {
			for (const release of changeset.releases) {
				const pkg = packages.get(release.name);
				if (!pkg) {
					errors.push(
						`could not check: workspace package ${release.name} (changeset ${changeset.id}) was not found.`,
					);
				}
				if (
					!(
						release.name === "fabric-app" ||
						(release.name.startsWith("@fabricorg/") &&
							pkg &&
							pkg.private !== true)
					)
				) {
					errors.push(
						`Direct package: changeset ${changeset.id} names ${release.name}. ${remedy}`,
					);
				}
			}
		}
		for (const release of status.releases) {
			const pkg = packages.get(release.name);
			if (!pkg) {
				errors.push(
					`could not check: workspace release ${release.name} was not found. ${remedy}`,
				);
			} else if (!/^(packages|apps)\/[^/]+$/.test(pkg.dir)) {
				errors.push(
					`Cascade package: ${release.name} is in ${pkg.dir}. ${remedy}`,
				);
			}
		}
		return errors;
	} catch (error) {
		return [`could not check changeset package policy: ${error.message}`];
	}
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	const errors = checkStatusFile(process.argv[2]);
	for (const error of errors) {
		console.error(error);
	}
	process.exitCode = errors.length ? 1 : 0;
}
