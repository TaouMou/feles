// Checks WCAG contrast ratios for the color pairs that carry text, in every theme in themes/.
// Translucent colors are flattened onto the surface they sit on before measuring, so a #ffffff1a
// hover counts as the light tint it shows, not as white.
//
// Thresholds:
// - Text (4.5:1, WCAG AA for normal text): editor, sidebar, active tab, status bar and its hover,
//   debugging and remote items, buttons, list selection and the active line number.
// - Secondary (3:1): inactive tabs, inactive line numbers and comments, which are meant to recede.
//
// Prints a table per theme and exits with 1 if any pair falls below its threshold.
//
// Usage: node scripts/check-contrast.js

const fs = require("fs");
const path = require("path");

const themesDir = path.join(__dirname, "..", "themes");

const TEXT = 4.5;
const SECONDARY = 3;

// Each color is a list of keys to try in order, like VS Code's own fallbacks, and `on` is the surface
// a translucent background is flattened onto (the editor background when left out).
const pairs = [
	{ label: "editor", fg: ["editor.foreground", "foreground"], bg: ["editor.background"], min: TEXT },
	{ label: "sidebar", fg: ["sideBar.foreground", "foreground"], bg: ["sideBar.background"], on: "editor.background", min: TEXT },
	{ label: "active tab", fg: ["tab.activeForeground", "foreground"], bg: ["tab.activeBackground"], on: "editorGroupHeader.tabsBackground", min: TEXT },
	{ label: "inactive tab", fg: ["tab.inactiveForeground", "foreground"], bg: ["tab.inactiveBackground"], on: "editorGroupHeader.tabsBackground", min: SECONDARY },
	{ label: "status bar", fg: ["statusBar.foreground", "foreground"], bg: ["statusBar.background"], on: "editor.background", min: TEXT },
	{ label: "status bar hover", fg: ["statusBarItem.hoverForeground", "statusBar.foreground", "foreground"], bg: ["statusBarItem.hoverBackground"], on: "statusBar.background", min: TEXT },
	{ label: "status bar debugging", fg: ["statusBar.debuggingForeground", "statusBar.foreground", "foreground"], bg: ["statusBar.debuggingBackground"], on: "editor.background", min: TEXT },
	// While debugging, the hover background is drawn over the debugging color, not the normal status bar
	{ label: "status bar hover (debugging)", fg: ["statusBarItem.hoverForeground", "statusBar.debuggingForeground", "foreground"], bg: ["statusBarItem.hoverBackground"], on: "statusBar.debuggingBackground", min: TEXT },
	{ label: "remote item", fg: ["statusBarItem.remoteForeground", "statusBar.foreground", "foreground"], bg: ["statusBarItem.remoteBackground"], on: "statusBar.background", min: TEXT },
	{ label: "remote item hover", fg: ["statusBarItem.remoteHoverForeground", "statusBarItem.remoteForeground", "foreground"], bg: ["statusBarItem.remoteHoverBackground"], on: "statusBarItem.remoteBackground", min: TEXT },
	{ label: "button", fg: ["button.foreground"], bg: ["button.background"], on: "sideBar.background", min: TEXT },
	{ label: "button hover", fg: ["button.foreground"], bg: ["button.hoverBackground"], on: "sideBar.background", min: TEXT },
	{ label: "secondary button", fg: ["button.secondaryForeground"], bg: ["button.secondaryBackground"], on: "sideBar.background", min: TEXT },
	{ label: "secondary button hover", fg: ["button.secondaryForeground"], bg: ["button.secondaryHoverBackground"], on: "sideBar.background", min: TEXT },
	{ label: "list selection", fg: ["list.activeSelectionForeground", "foreground"], bg: ["list.activeSelectionBackground"], on: "sideBar.background", min: TEXT },
	{ label: "active line number", fg: ["editorLineNumber.activeForeground"], bg: ["editor.background"], min: TEXT },
	{ label: "line number", fg: ["editorLineNumber.foreground"], bg: ["editor.background"], min: SECONDARY },
	{ label: "comment", fg: ["@comment"], bg: ["editor.background"], min: SECONDARY }
];

// Removes // and /* */ comments outside of strings, so URLs in values survive.
function stripComments(text) {
	let out = "";
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === '"') {
			const start = i;
			for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
			out += text.slice(start, i + 1);
		} else if (c === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i++;
			out += "\n";
		} else if (c === "/" && text[i + 1] === "*") {
			i = text.indexOf("*/", i + 2);
			if (i < 0) break;
			i++;
		} else out += c;
	}
	// Trailing commas are allowed in VS Code's JSONC too
	return out.replace(/,(\s*[}\]])/g, "$1");
}

function parseHex(hex) {
	const m = /^#([0-9a-f]{3,8})$/i.exec(hex.trim());
	if (!m || ![3, 4, 6, 8].includes(m[1].length)) throw new Error(`not a hex color: ${hex}`);
	let h = m[1];
	if (h.length <= 4) h = [...h].map((c) => c + c).join("");
	const n = (i) => parseInt(h.slice(i, i + 2), 16);
	return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
}

const toHex = ({ r, g, b }) => "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

// Source-over compositing of `top` onto an opaque `bottom`
function flatten(top, bottom) {
	const mix = (t, b) => t * top.a + b * (1 - top.a);
	return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a: 1 };
}

function luminance({ r, g, b }) {
	const lin = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
	return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a, b) {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

// The last tokenColors rule scoped exactly to `scope` wins, as in VS Code
function tokenForeground(theme, scope) {
	let found;
	for (const rule of theme.tokenColors || []) {
		const scopes = Array.isArray(rule.scope) ? rule.scope : String(rule.scope || "").split(",");
		if (scopes.map((s) => s.trim()).includes(scope) && rule.settings && rule.settings.foreground) found = rule.settings.foreground;
	}
	return found;
}

function lookup(theme, keys) {
	for (const key of keys) {
		const value = key.startsWith("@") ? tokenForeground(theme, key.slice(1)) : theme.colors[key];
		if (value) return { key, color: parseHex(value) };
	}
	return null;
}

// What each surface is drawn on, for flattening a translucent surface. Anything not listed sits on the editor.
const under = {
	"editor.background": null,
	"statusBarItem.remoteBackground": "statusBar.background"
};

function checkTheme(theme) {
	// The editor background is the bottom of every stack; if it is itself translucent it sits on the
	// workbench, which is black or white depending on the theme type
	const canvas = parseHex(theme.type === "light" ? "#ffffff" : "#000000");
	const surface = (key) => {
		const below = key in under ? under[key] : "editor.background";
		const base = below ? surface(below) : canvas;
		return theme.colors[key] ? flatten(parseHex(theme.colors[key]), base) : base;
	};

	return pairs.map((pair) => {
		const fg = lookup(theme, pair.fg);
		const bg = lookup(theme, pair.bg);
		if (!fg || !bg) return { pair, missing: !fg ? pair.fg[0] : pair.bg[0] };
		const bgFlat = bg.key === "editor.background" ? surface(bg.key) : flatten(bg.color, surface(pair.on || "editor.background"));
		const fgFlat = flatten(fg.color, bgFlat);
		const ratio = contrast(fgFlat, bgFlat);
		return { pair, fg: toHex(fgFlat), bg: toHex(bgFlat), fgKey: fg.key, ratio, pass: ratio >= pair.min };
	});
}

const files = fs.readdirSync(themesDir).filter((f) => f.endsWith("-color-theme.json")).sort();
const failures = [];

for (const file of files) {
	const theme = JSON.parse(stripComments(fs.readFileSync(path.join(themesDir, file), "utf8")));
	const results = checkTheme(theme);
	const width = Math.max(...pairs.map((p) => p.label.length));

	console.log(`\n${theme.name} (${file})`);
	console.log(`  ${"pair".padEnd(width)}  fg       bg       ratio   min  result`);
	for (const r of results) {
		if (r.missing) {
			console.log(`  ${r.pair.label.padEnd(width)}  ${"-".padEnd(7)}  ${"-".padEnd(7)}  ${"-".padStart(5)}  ${r.pair.min.toFixed(1).padStart(4)}  skip (no ${r.missing})`);
			continue;
		}
		const result = r.pass ? "ok" : "FAIL";
		const via = r.fgKey !== r.pair.fg[0] ? ` (fg from ${r.fgKey})` : "";
		console.log(`  ${r.pair.label.padEnd(width)}  ${r.fg}  ${r.bg}  ${r.ratio.toFixed(2).padStart(5)}  ${r.pair.min.toFixed(1).padStart(4)}  ${result}${via}`);
		if (!r.pass) failures.push(`${theme.name}: ${r.pair.label} ${r.ratio.toFixed(2)}:1 (needs ${r.pair.min}:1)`);
	}
}

if (failures.length) {
	console.log(`\n${failures.length} pair(s) below threshold:`);
	for (const f of failures) console.log(`  ${f}`);
	process.exit(1);
}
console.log(`\nAll pairs pass in ${files.length} themes.`);
