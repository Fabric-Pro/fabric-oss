/**
 * Tech-stack detection. Parses dependency manifests (package.json, *.csproj,
 * go.mod, Cargo.toml, pom.xml, requirements.txt, pyproject.toml, composer.json,
 * Gemfile, build.gradle) into a flat list of frameworks/libraries with versions.
 * Pure + deterministic (unit-testable). Manifests are read separately from the
 * analysable source set (they aren't "code" but they describe the stack).
 */
import type { TechStackEntry } from "../types";
import { normalizePath } from "./languages";

export type { TechStackEntry };

/** Manifest filenames we read in addition to the analysable source files. */
const MANIFEST_FILENAMES = [
	"package.json",
	"go.mod",
	"cargo.toml",
	"requirements.txt",
	"pyproject.toml",
	"composer.json",
	"gemfile",
	"pom.xml",
	"build.gradle",
	"build.gradle.kts",
];

/** True if a path is a manifest we should read for the tech stack. */
export function isManifestPath(filePath: string): boolean {
	const base = normalizePath(filePath).split("/").pop()?.toLowerCase() ?? "";
	return MANIFEST_FILENAMES.includes(base) || base.endsWith(".csproj");
}

const KNOWN_FRAMEWORKS = new Set(
	[
		"react",
		"react-dom",
		"next",
		"vue",
		"nuxt",
		"svelte",
		"@angular/core",
		"angular",
		"solid-js",
		"express",
		"fastify",
		"@nestjs/core",
		"nestjs",
		"koa",
		"hono",
		"django",
		"flask",
		"fastapi",
		"rails",
		"sinatra",
		"laravel/framework",
		"symfony/symfony",
		"spring-boot",
		"org.springframework.boot",
		"quartz",
		"quartz.net",
		"microsoft.aspnetcore",
		"microsoft.aspnetcore.app",
		"microsoft.net.sdk.web",
		"blazor",
		"gin-gonic/gin",
		"actix-web",
		"axum",
		"rocket",
		"tokio",
	].map((s) => s.toLowerCase()),
);

function classify(name: string): "framework" | "library" {
	const n = name.toLowerCase();
	if (KNOWN_FRAMEWORKS.has(n)) {
		return "framework";
	}
	// Heuristic: ASP.NET / Spring / Microsoft.AspNetCore.* families are frameworks.
	if (
		n.startsWith("microsoft.aspnetcore") ||
		n.startsWith("org.springframework")
	) {
		return "framework";
	}
	return "library";
}

function entry(
	ecosystem: string,
	name: string,
	version: string | null,
	dev = false,
	kind?: TechStackEntry["kind"],
): TechStackEntry {
	return {
		ecosystem,
		name,
		version: version?.trim() || null,
		kind: kind ?? classify(name),
		dev,
	};
}

function parsePackageJson(content: string): TechStackEntry[] {
	const out: TechStackEntry[] = [];
	try {
		const pkg = JSON.parse(content) as {
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
			engines?: Record<string, string>;
		};
		for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
			out.push(entry("npm", name, version, false));
		}
		for (const [name, version] of Object.entries(
			pkg.devDependencies ?? {},
		)) {
			out.push(entry("npm", name, version, true));
		}
		if (pkg.engines?.node) {
			out.push(entry("npm", "node", pkg.engines.node, false, "runtime"));
		}
	} catch {
		// ignore malformed package.json
	}
	return out;
}

function parseCsproj(content: string): TechStackEntry[] {
	const out: TechStackEntry[] = [];
	const ref =
		/<PackageReference\s+Include="([^"]+)"(?:[^>]*?\sVersion="([^"]+)")?/gi;
	let m: RegExpExecArray | null = ref.exec(content);
	while (m !== null) {
		out.push(entry("nuget", m[1], m[2] ?? null, false));
		m = ref.exec(content);
	}
	const tfm = /<TargetFrameworks?>([^<]+)<\/TargetFrameworks?>/i.exec(
		content,
	);
	if (tfm) {
		for (const fw of tfm[1].split(";")) {
			out.push(entry("nuget", ".NET", fw.trim(), false, "runtime"));
		}
	}
	return out;
}

function parseGoMod(content: string): TechStackEntry[] {
	const out: TechStackEntry[] = [];
	const goVer = /^\s*go\s+([\d.]+)/m.exec(content);
	if (goVer) {
		out.push(entry("go", "go", goVer[1], false, "runtime"));
	}
	// require ( ... ) block + single-line requires
	const block = /require\s*\(([\s\S]*?)\)/g;
	let b: RegExpExecArray | null = block.exec(content);
	while (b !== null) {
		for (const line of b[1].split("\n")) {
			const r = /^\s*([^\s]+)\s+(v[\w.\-+]+)/.exec(line);
			if (r) {
				out.push(entry("go", r[1], r[2], /\/\/\s*indirect/.test(line)));
			}
		}
		b = block.exec(content);
	}
	const single = /^\s*require\s+([^\s(]+)\s+(v[\w.\-+]+)/gm;
	let s: RegExpExecArray | null = single.exec(content);
	while (s !== null) {
		out.push(entry("go", s[1], s[2], false));
		s = single.exec(content);
	}
	return out;
}

function parseRequirements(content: string): TechStackEntry[] {
	const out: TechStackEntry[] = [];
	for (const raw of content.split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#") || line.startsWith("-")) {
			continue;
		}
		const m = /^([A-Za-z0-9._-]+)\s*(?:[=<>!~]=?\s*([\w.*+-]+))?/.exec(
			line,
		);
		if (m) {
			out.push(entry("pip", m[1], m[2] ?? null, false));
		}
	}
	return out;
}

function parseTomlDeps(content: string, ecosystem: string): TechStackEntry[] {
	const out: TechStackEntry[] = [];
	// [dependencies] / [tool.poetry.dependencies] / [project.dependencies-ish]
	const section = /\[(?:tool\.poetry\.)?dependencies\]([\s\S]*?)(?:\n\[|$)/gi;
	let sec: RegExpExecArray | null = section.exec(content);
	while (sec !== null) {
		for (const line of sec[1].split("\n")) {
			const m =
				/^\s*([A-Za-z0-9._-]+)\s*=\s*["{]?\s*"?([\w.*^~>=<\s-]+)?/.exec(
					line,
				);
			if (m?.[1] && m[1].toLowerCase() !== "python") {
				out.push(
					entry(ecosystem, m[1], (m[2] ?? "").trim() || null, false),
				);
			}
		}
		sec = section.exec(content);
	}
	return out;
}

function parseComposer(content: string): TechStackEntry[] {
	const out: TechStackEntry[] = [];
	try {
		const json = JSON.parse(content) as {
			require?: Record<string, string>;
			"require-dev"?: Record<string, string>;
		};
		for (const [name, version] of Object.entries(json.require ?? {})) {
			if (name === "php") {
				out.push(entry("composer", "php", version, false, "runtime"));
			} else {
				out.push(entry("composer", name, version, false));
			}
		}
		for (const [name, version] of Object.entries(
			json["require-dev"] ?? {},
		)) {
			out.push(entry("composer", name, version, true));
		}
	} catch {
		// ignore
	}
	return out;
}

function parseGemfile(content: string): TechStackEntry[] {
	const out: TechStackEntry[] = [];
	const gem = /^\s*gem\s+['"]([^'"]+)['"](?:\s*,\s*['"]([^'"]+)['"])?/gm;
	let m: RegExpExecArray | null = gem.exec(content);
	while (m !== null) {
		out.push(entry("rubygems", m[1], m[2] ?? null, false));
		m = gem.exec(content);
	}
	return out;
}

function parsePomXml(content: string): TechStackEntry[] {
	const out: TechStackEntry[] = [];
	const dep =
		/<dependency>[\s\S]*?<artifactId>([^<]+)<\/artifactId>(?:[\s\S]*?<version>([^<]+)<\/version>)?[\s\S]*?<\/dependency>/gi;
	let m: RegExpExecArray | null = dep.exec(content);
	while (m !== null) {
		out.push(entry("maven", m[1], m[2] ?? null, false));
		m = dep.exec(content);
	}
	return out;
}

function parseGradle(content: string): TechStackEntry[] {
	const out: TechStackEntry[] = [];
	const dep =
		/(?:implementation|api|compile|testImplementation|runtimeOnly)\s*[(\s]['"]([^'":]+):([^'":]+):([^'"]+)['"]/g;
	let m: RegExpExecArray | null = dep.exec(content);
	while (m !== null) {
		out.push(entry("gradle", `${m[1]}:${m[2]}`, m[3], /test/i.test(m[0])));
		m = dep.exec(content);
	}
	return out;
}

export interface ManifestFile {
	path: string;
	content: string;
}

/**
 * The package identities this repository PUBLISHES / owns — every workspace
 * package name, the Go module path, the .NET package/assembly id, etc. Used by
 * the cross-repo detector to find a precise `DEPENDS_ON`: another repo that
 * lists one of these as a dependency genuinely consumes this repo's code.
 *
 * Pure + deterministic. Reads the SAME manifest set as `parseTechStack` (so a
 * monorepo's every `@scope/*` package is captured), just the identity side of
 * each manifest rather than its dependencies.
 */
export function parsePublishedPackages(files: ManifestFile[]): string[] {
	const names = new Set<string>();
	for (const f of files) {
		const base =
			normalizePath(f.path).split("/").pop()?.toLowerCase() ?? "";
		try {
			if (base === "package.json") {
				const pkg = JSON.parse(f.content) as { name?: unknown };
				if (typeof pkg.name === "string" && pkg.name.trim()) {
					names.add(pkg.name.trim());
				}
			} else if (base.endsWith(".csproj")) {
				const pid = /<PackageId>\s*([^<]+?)\s*<\/PackageId>/i.exec(
					f.content,
				);
				const asm =
					/<AssemblyName>\s*([^<]+?)\s*<\/AssemblyName>/i.exec(
						f.content,
					);
				const name =
					pid?.[1] ??
					asm?.[1] ??
					normalizePath(f.path)
						.split("/")
						.pop()
						?.replace(/\.csproj$/i, "");
				if (name?.trim()) {
					names.add(name.trim());
				}
			} else if (base === "go.mod") {
				const m = /^\s*module\s+(\S+)/m.exec(f.content);
				if (m?.[1]) {
					names.add(m[1].trim());
				}
			} else if (base === "cargo.toml") {
				const m = /\[package\][\s\S]*?\bname\s*=\s*"([^"]+)"/.exec(
					f.content,
				);
				if (m?.[1]) {
					names.add(m[1].trim());
				}
			} else if (base === "pyproject.toml") {
				const m =
					/\[(?:tool\.poetry|project)\][\s\S]*?\bname\s*=\s*"([^"]+)"/.exec(
						f.content,
					);
				if (m?.[1]) {
					names.add(m[1].trim());
				}
			} else if (base === "composer.json") {
				const json = JSON.parse(f.content) as { name?: unknown };
				if (typeof json.name === "string" && json.name.trim()) {
					names.add(json.name.trim());
				}
			}
		} catch {
			// ignore malformed manifest — identity is best-effort
		}
	}
	names.delete("");
	return [...names].sort();
}

/** Parse all manifests into a de-duplicated, sorted tech-stack list. */
export function parseTechStack(files: ManifestFile[]): TechStackEntry[] {
	const all: TechStackEntry[] = [];
	for (const f of files) {
		const base =
			normalizePath(f.path).split("/").pop()?.toLowerCase() ?? "";
		if (base === "package.json") {
			all.push(...parsePackageJson(f.content));
		} else if (base.endsWith(".csproj")) {
			all.push(...parseCsproj(f.content));
		} else if (base === "go.mod") {
			all.push(...parseGoMod(f.content));
		} else if (base === "requirements.txt") {
			all.push(...parseRequirements(f.content));
		} else if (base === "pyproject.toml") {
			all.push(...parseTomlDeps(f.content, "pip"));
		} else if (base === "cargo.toml") {
			all.push(...parseTomlDeps(f.content, "cargo"));
		} else if (base === "composer.json") {
			all.push(...parseComposer(f.content));
		} else if (base === "gemfile") {
			all.push(...parseGemfile(f.content));
		} else if (base === "pom.xml") {
			all.push(...parsePomXml(f.content));
		} else if (base === "build.gradle" || base === "build.gradle.kts") {
			all.push(...parseGradle(f.content));
		}
	}

	// De-dupe by ecosystem+name (prefer a concrete version + non-dev).
	const byKey = new Map<string, TechStackEntry>();
	for (const e of all) {
		const key = `${e.ecosystem}:${e.name.toLowerCase()}`;
		const prev = byKey.get(key);
		if (!prev || (!prev.version && e.version) || (prev.dev && !e.dev)) {
			byKey.set(key, e);
		}
	}
	return [...byKey.values()].sort((a, b) => {
		// frameworks + runtimes first, then by name.
		const rank = (k: TechStackEntry["kind"]) =>
			k === "runtime" ? 0 : k === "framework" ? 1 : 2;
		return rank(a.kind) - rank(b.kind) || a.name.localeCompare(b.name);
	});
}
