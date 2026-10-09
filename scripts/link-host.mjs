#!/usr/bin/env node
/**
 * Link the host-provided packages that pi injects at runtime into `node_modules/`,
 * so `tsc` and the test runner can resolve them.
 *
 * These are deliberately NOT dependencies:
 *   - pi's docs require host packages (`@earendil-works/pi-coding-agent`,
 *     `typebox`) in `peerDependencies` only — shipping a physical copy risks
 *     duplicate module instances and registries.
 *   - Linking to the *running pi installation* gives one physical copy on disk,
 *     so module identity is preserved rather than duplicated.
 *
 * Run after `npm install`:   npm run dev:link
 */

import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NODE_MODULES = join(ROOT, "node_modules");

/** Packages pi provides to extensions; `null` means "resolve from the host pi install". */
const HOST_PACKAGES = ["@earendil-works/pi-coding-agent", "typebox"];

function findHostRoot() {
	const candidates = [
		process.env.PI_HOST_MODULES,
		// A globally installed pi
		hostModulesFromGitHubStylePath(),
		// `node` resolving pi from a global install
		tryResolve("@earendil-works/pi-coding-agent"),
	].filter(Boolean);

	for (const candidate of candidates) {
		const marker = join(candidate, "@earendil-works", "pi-coding-agent", "package.json");
		const flat = join(candidate, "pi-coding-agent", "package.json");
		if (existsSync(marker)) return candidate;
		if (existsSync(flat)) return candidate;
	}
	return undefined;
}

function hostModulesFromGitHubStylePath() {
	try {
		const require = createRequire(import.meta.url);
		const piEntry = require.resolve("@earendil-works/pi-coding-agent");
		// .../node_modules/@earendil-works/pi-coding-agent/dist/index.js
		const parts = piEntry.split(/[\\/]/);
		const index = parts.lastIndexOf("node_modules");
		return index >= 0 ? parts.slice(0, index + 1).join("/") : undefined;
	} catch {
		return undefined;
	}
}

function tryResolve(specifier) {
	try {
		const require = createRequire(join(ROOT, "package.json"));
		const entry = require.resolve(specifier);
		const parts = entry.split(/[\\/]/);
		const index = parts.lastIndexOf("node_modules");
		return index >= 0 ? parts.slice(0, index + 1).join("/") : undefined;
	} catch {
		return undefined;
	}
}

function link(target, linkPath) {
	mkdirSync(dirname(linkPath), { recursive: true });
	if (existsSync(linkPath)) rmSync(linkPath, { recursive: true, force: true });
	// "junction" is required on Windows without developer mode; it is a plain
	// directory symlink elsewhere.
	symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

function main() {
	const hostRoot = findHostRoot();
	if (!hostRoot) {
		console.error("Could not locate a pi installation. Set PI_HOST_MODULES to its node_modules directory.");
		process.exit(1);
	}

	console.log(`host: ${hostRoot}`);
	for (const name of HOST_PACKAGES) {
		const source = join(hostRoot, name);
		if (!existsSync(source)) {
			// pi nests some deps; try the package's own node_modules.
			const nested = join(hostRoot, "@earendil-works", "pi-coding-agent", "node_modules", name);
			if (!existsSync(nested)) {
				console.warn(`  skip ${name} (not found)`);
				continue;
			}
			link(nested, join(NODE_MODULES, name));
			console.log(`  linked ${name} (nested)`);
			continue;
		}
		link(source, join(NODE_MODULES, name));
		console.log(`  linked ${name}`);
	}
	console.log("done — now run: npm run verify");
}

main();
