"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
	findTaggedTypeReferences,
	flattenHoverMarkdown,
	isVersionAtLeast,
	maskCommentsAndStrings,
	parseLayoutFromHoverMarkdown
} = require("../lib/layout");

test("finds explicit tagged type references and definitions", () => {
	const source = [
		"struct alpha *a;",
		"union beta value;",
		"class ns::gamma object;",
		"struct delta { int field; };",
		"struct ns::box<int>::entry<double> templated;"
	].join("\n");

	const references = findTaggedTypeReferences(source);
	assert.deepEqual(
		references.map(reference => [reference.kind, reference.typeName]),
		[
			["struct", "alpha"],
			["union", "beta"],
			["class", "ns::gamma"],
			["struct", "delta"],
			["struct", "ns::box<int>::entry<double>"]
		]
	);
	assert.equal(
		source.slice(references.at(-1).start, references.at(-1).end),
		"ns::box<int>::entry<double>"
	);
});

test("ignores comments, literals, enum class, and macro placeholders", () => {
	const source = [
		"// struct comment_only;",
		"const char *text = \"union string_only\";",
		"enum class mode { one };",
		"#define DECLARE(name) \\",
		"    struct name { int field; };",
		"struct real_type *value;"
	].join("\n");

	const references = findTaggedTypeReferences(source);
	assert.deepEqual(
		references.map(reference => reference.typeName),
		["real_type"]
	);
});

test("skips attributes before a real tag name", () => {
	const source = [
		"struct __attribute__((packed)) packed_item { char value; };",
		"struct [[nodiscard]] modern_item { int value; };",
		"struct __declspec(align(16)) windows_item { int value; };"
	].join("\n");

	assert.deepEqual(
		findTaggedTypeReferences(source).map(reference => reference.typeName),
		["packed_item", "modern_item", "windows_item"]
	);
});

test("ignores raw strings and backslash-continued line comments", () => {
	const source = [
		"const char *raw = R\"tag(struct raw_only)tag\";",
		"// continued comment \\",
		"struct continued_comment_only;",
		"struct visible;"
	].join("\n");

	assert.deepEqual(
		findTaggedTypeReferences(source).map(reference => reference.typeName),
		["visible"]
	);
});

test("filters references to visible offset ranges", () => {
	const source = "struct first *a;\nstruct second *b;\n";
	const secondStart = source.indexOf("struct second");
	const references = findTaggedTypeReferences(source, [{
		start: secondStart,
		end: source.length
	}]);

	assert.deepEqual(
		references.map(reference => reference.typeName),
		["second"]
	);
});

test("keeps offsets stable while masking", () => {
	const source = "struct live; /* struct hidden; */ struct live2;";
	const masked = maskCommentsAndStrings(source);
	assert.equal(masked.length, source.length);
	assert.equal(masked.indexOf("struct live"), source.indexOf("struct live"));
	assert.equal(masked.includes("struct hidden"), false);
});

test("flattens VS Code hover content", () => {
	const markdown = flattenHoverMarkdown([
		{ contents: [{ value: "```c\nstruct item\n```" }, "**Size:** 16 B"] },
		{ contents: [{ language: "c", value: "**Alignment:** 8 B" }] }
	]);

	assert.match(markdown, /struct item/);
	assert.match(markdown, /\*\*Size:\*\* 16 B/);
	assert.match(markdown, /\*\*Alignment:\*\* 8 B/);
});

test("parses Microsoft C/C++ English hover metrics", () => {
	const layout = parseLayoutFromHoverMarkdown(
		"```c\nstruct item\n```  \n**Size:** 1,024 B  \n**Alignment:** 8 B"
	);

	assert.deepEqual(layout, { size: 1024, alignment: 8 });
});

test("falls back to ordered localized metric labels", () => {
	const layout = parseLayoutFromHoverMarkdown(
		"```c\nstruct item\n```  \n**大小：** 64 B  \n**對齊：** 16 B"
			.replace(/：/g, ":")
	);

	assert.deepEqual(layout, { size: 64, alignment: 16 });
});

test("does not treat unrelated numeric hover metadata as a layout", () => {
	assert.equal(
		parseLayoutFromHoverMarkdown(
			"```c\nstruct item\n```  \n**Length:** 3 m  \n**Capacity:** 8 B"
		),
		undefined
	);
});

test("returns undefined when hover contains no layout", () => {
	assert.equal(
		parseLayoutFromHoverMarkdown("```c\nstruct incomplete\n```"),
		undefined
	);
});

test("compares cpptools versions including suffixes", () => {
	assert.equal(isVersionAtLeast("1.35.4-main", [1, 35, 3]), true);
	assert.equal(isVersionAtLeast("1.35.3", [1, 35, 3]), true);
	assert.equal(isVersionAtLeast("1.31.4", [1, 35, 3]), false);
	assert.equal(isVersionAtLeast("development", [1, 35, 3]), undefined);
});
