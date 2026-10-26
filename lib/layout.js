"use strict";

const TAG_KEYWORD_RE = /\b(struct|union|class)\b/g;
const ATTRIBUTE_KEYWORDS = new Set([
	"__attribute",
	"__attribute__",
	"__declspec",
	"_Alignas",
	"alignas"
]);

/**
 * Replaces comments and string/character literal content with spaces while
 * preserving offsets and newlines.
 *
 * @param {string} text
 * @returns {string}
 */
function maskCommentsAndStrings(text)
{
	const chars = text.split("");
	let i = 0;

	while (i < chars.length) {
		const ch = chars[i];
		const next = chars[i + 1];
		const rawString = matchRawStringStart(text, i);

		if (rawString) {
			const terminator = `)${rawString.delimiter}"`;
			const terminatorStart = text.indexOf(terminator, rawString.contentStart);
			const end = terminatorStart < 0
				? chars.length
				: terminatorStart + terminator.length;
			while (i < end) {
				if (chars[i] !== "\n" && chars[i] !== "\r")
					chars[i] = " ";
				i++;
			}
			continue;
		}

		if (ch === "/" && next === "/") {
			chars[i++] = " ";
			chars[i++] = " ";
			let continued;
			do {
				let lastNonWhitespace = "";
				while (i < chars.length && chars[i] !== "\n") {
					if (chars[i] !== "\r" && !/\s/.test(chars[i]))
						lastNonWhitespace = chars[i];
					if (chars[i] !== "\r")
						chars[i] = " ";
					i++;
				}
				continued = lastNonWhitespace === "\\";
				if (continued && i < chars.length)
					i++;
			} while (continued && i < chars.length);
			continue;
		}

		if (ch === "/" && next === "*") {
			chars[i++] = " ";
			chars[i++] = " ";
			while (i < chars.length - 1 && !(chars[i] === "*" && chars[i + 1] === "/")) {
				if (chars[i] !== "\n" && chars[i] !== "\r")
					chars[i] = " ";
				i++;
			}
			if (i < chars.length - 1) {
				chars[i++] = " ";
				chars[i++] = " ";
			}
			continue;
		}

		if (ch === "\"" || ch === "'") {
			const quote = ch;
			chars[i++] = " ";
			while (i < chars.length) {
				const current = chars[i];
				if (current !== "\n" && current !== "\r")
					chars[i] = " ";

				if (current === "\\") {
					if (i + 1 < chars.length && chars[i + 1] !== "\n" && chars[i + 1] !== "\r")
						chars[i + 1] = " ";
					i += 2;
					continue;
				}

				i++;
				if (current === quote)
					break;
			}
			continue;
		}

		i++;
	}

	return chars.join("");
}

/**
 * @param {string} text
 * @param {number} offset
 * @returns {{delimiter: string, contentStart: number} | undefined}
 */
function matchRawStringStart(text, offset)
{
	if (offset > 0 && /[A-Za-z0-9_]/.test(text[offset - 1]))
		return undefined;

	const first = text[offset];
	if (first !== "R" && first !== "u" && first !== "U" && first !== "L")
		return undefined;

	const match = /^(?:u8|u|U|L)?R"([^\s()\\]{0,16})\(/.exec(text.slice(offset, offset + 32));
	if (!match)
		return undefined;
	return {
		delimiter: match[1],
		contentStart: offset + match[0].length
	};
}

/**
 * Finds explicit `struct Foo`, `union Foo`, and `class Foo` occurrences.
 * Macro-definition placeholders and `enum class` declarations are excluded.
 *
 * @param {string} text
 * @param {{start: number, end: number}[]} [offsetRanges]
 * @returns {{
 *   kind: string,
 *   typeName: string,
 *   start: number,
 *   end: number,
 *   queryOffset: number
 * }[]}
 */
function findTaggedTypeReferences(text, offsetRanges)
{
	const masked = maskCommentsAndStrings(text);
	const references = [];
	const ranges = Array.isArray(offsetRanges) && offsetRanges.length > 0
		? offsetRanges
		: [{ start: 0, end: text.length }];

	TAG_KEYWORD_RE.lastIndex = 0;
	let match;
	while ((match = TAG_KEYWORD_RE.exec(masked)) !== null) {
		const kind = match[1];

		if (isInMacroDefinition(masked, match.index))
			continue;

		if (kind === "class") {
			const prefix = masked.slice(Math.max(0, match.index - 32), match.index);
			if (/\benum\s*$/.test(prefix))
				continue;
		}

		let cursor = skipWhitespace(masked, match.index + match[0].length);
		cursor = skipTypeAttributes(masked, cursor);
		const qualifiedName = parseQualifiedTypeName(masked, cursor);
		if (!qualifiedName)
			continue;

		if (!intersectsAnyRange(qualifiedName.start, qualifiedName.end, ranges))
			continue;

		const finalLength = qualifiedName.finalEnd - qualifiedName.finalStart;
		const queryOffset = qualifiedName.finalStart + Math.min(1, Math.max(0, finalLength - 1));

		references.push({
			kind,
			typeName: masked.slice(qualifiedName.start, qualifiedName.end).replace(/\s+/g, ""),
			start: qualifiedName.start,
			end: qualifiedName.end,
			queryOffset
		});
	}

	return references;
}

/**
 * @param {string} text
 * @param {number} offset
 * @returns {number}
 */
function skipWhitespace(text, offset)
{
	while (offset < text.length && /\s/.test(text[offset]))
		offset++;
	return offset;
}

/**
 * Skips attributes permitted between a tag keyword and its identifier, such
 * as `struct __attribute__((packed)) item` and `struct [[nodiscard]] item`.
 *
 * @param {string} text
 * @param {number} offset
 * @returns {number}
 */
function skipTypeAttributes(text, offset)
{
	let cursor = offset;

	for (;;) {
		cursor = skipWhitespace(text, cursor);
		if (text.startsWith("[[", cursor)) {
			const end = text.indexOf("]]", cursor + 2);
			if (end < 0)
				return cursor;
			cursor = end + 2;
			continue;
		}

		const identifier = readIdentifier(text, cursor);
		if (!identifier || !ATTRIBUTE_KEYWORDS.has(identifier.value))
			return cursor;

		const open = skipWhitespace(text, identifier.end);
		if (text[open] !== "(")
			return cursor;

		const end = findBalancedEnd(text, open, "(", ")");
		if (end === undefined)
			return cursor;
		cursor = end;
	}
}

/**
 * @param {string} text
 * @param {number} offset
 * @returns {{
 *   start: number,
 *   end: number,
 *   finalStart: number,
 *   finalEnd: number
 * } | undefined}
 */
function parseQualifiedTypeName(text, offset)
{
	let cursor = offset;
	const start = cursor;
	let finalStart;
	let finalEnd;

	if (text.startsWith("::", cursor))
		cursor = skipWhitespace(text, cursor + 2);

	for (;;) {
		const identifier = readIdentifier(text, cursor);
		if (!identifier)
			return undefined;

		finalStart = identifier.start;
		finalEnd = identifier.end;
		cursor = skipWhitespace(text, identifier.end);
		let segmentEnd = identifier.end;

		if (text[cursor] === "<") {
			const templateEnd = findBalancedEnd(text, cursor, "<", ">");
			if (templateEnd !== undefined) {
				segmentEnd = templateEnd;
				cursor = skipWhitespace(text, templateEnd);
			}
		}

		if (!text.startsWith("::", cursor)) {
			return {
				start,
				end: segmentEnd,
				finalStart,
				finalEnd
			};
		}

		cursor = skipWhitespace(text, cursor + 2);
	}
}

/**
 * @param {string} text
 * @param {number} offset
 * @returns {{value: string, start: number, end: number} | undefined}
 */
function readIdentifier(text, offset)
{
	const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(offset));
	if (!match)
		return undefined;
	return {
		value: match[0],
		start: offset,
		end: offset + match[0].length
	};
}

/**
 * Returns the offset immediately after a balanced delimited section.
 *
 * @param {string} text
 * @param {number} openOffset
 * @param {string} openCharacter
 * @param {string} closeCharacter
 * @returns {number | undefined}
 */
function findBalancedEnd(text, openOffset, openCharacter, closeCharacter)
{
	let depth = 0;
	for (let i = openOffset; i < text.length; i++) {
		if (text[i] === openCharacter)
			depth++;
		else if (text[i] === closeCharacter) {
			depth--;
			if (depth === 0)
				return i + 1;
		}
	}
	return undefined;
}

/**
 * @param {number} start
 * @param {number} end
 * @param {{start: number, end: number}[]} ranges
 * @returns {boolean}
 */
function intersectsAnyRange(start, end, ranges)
{
	return ranges.some(range => start <= range.end && end >= range.start);
}

/**
 * Detects whether an offset is within a possibly continued #define directive.
 *
 * @param {string} text
 * @param {number} offset
 * @returns {boolean}
 */
function isInMacroDefinition(text, offset)
{
	let logicalStart = text.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;

	while (logicalStart > 0) {
		const previousLineEnd = logicalStart - 1;
		const previousLineStart = text.lastIndexOf("\n", previousLineEnd - 1) + 1;
		const previousLine = text.slice(previousLineStart, previousLineEnd).replace(/\r$/, "");
		if (!/\\\s*$/.test(previousLine))
			break;
		logicalStart = previousLineStart;
	}

	const firstLineEnd = text.indexOf("\n", logicalStart);
	const firstLine = text.slice(logicalStart, firstLineEnd < 0 ? text.length : firstLineEnd);
	return /^\s*#\s*define\b/.test(firstLine);
}

/**
 * Converts VS Code Hover content into one Markdown string without importing
 * the vscode module, so this helper remains unit-testable.
 *
 * @param {unknown} hovers
 * @returns {string}
 */
function flattenHoverMarkdown(hovers)
{
	if (!Array.isArray(hovers))
		return "";

	const values = [];
	for (const hover of hovers) {
		if (!hover || !Array.isArray(hover.contents))
			continue;

		for (const content of hover.contents) {
			if (typeof content === "string")
				values.push(content);
			else if (content && typeof content.value === "string")
				values.push(content.value);
		}
	}

	return values.join("\n");
}

/**
 * Parses the size/alignment pair currently emitted by Microsoft C/C++ hovers.
 * The generic fallback tolerates localized labels while retaining the emitted
 * order: size first, alignment second.
 *
 * @param {string} markdown
 * @returns {{size: number, alignment: number | undefined} | undefined}
 */
function parseLayoutFromHoverMarkdown(markdown)
{
	if (typeof markdown !== "string" || markdown.length === 0)
		return undefined;

	const size = matchMetric(markdown, "Size");
	const alignment = matchMetric(markdown, "Alignment");
	if (size !== undefined)
		return { size, alignment };

	const genericPair =
		/```[ \t]*\r?\n\s*\*\*[^*\r\n]{1,64}:\*\*\s*([0-9][0-9,]*)\s*([^\s\r\n*]+)[ \t]*(?: {2})?\r?\n\s*\*\*[^*\r\n]{1,64}:\*\*\s*([0-9][0-9,]*)\s*([^\s\r\n*]+)/g;
	let match;
	while ((match = genericPair.exec(markdown)) !== null) {
		const fallbackSize = parseInteger(match[1]);
		const fallbackAlignment = parseInteger(match[3]);
		const sameUnit = match[2].toLocaleLowerCase() === match[4].toLocaleLowerCase();
		const plausibleAlignment = fallbackAlignment !== undefined
			&& fallbackAlignment > 0
			&& (fallbackAlignment & (fallbackAlignment - 1)) === 0;
		const plausibleLayout = fallbackSize !== undefined
			&& plausibleAlignment
			&& fallbackSize >= fallbackAlignment
			&& fallbackSize % fallbackAlignment === 0;

		if (sameUnit && plausibleLayout)
			return { size: fallbackSize, alignment: fallbackAlignment };
	}

	return undefined;
}

/**
 * @param {string} markdown
 * @param {string} label
 * @returns {number | undefined}
 */
function matchMetric(markdown, label)
{
	const expression = new RegExp(
		`\\*\\*\\s*${label}\\s*:\\s*\\*\\*\\s*([0-9][0-9,]*)\\s*(?:B|bytes?)\\b`,
		"i"
	);
	const match = expression.exec(markdown);
	return match ? parseInteger(match[1]) : undefined;
}

/**
 * @param {string} value
 * @returns {number | undefined}
 */
function parseInteger(value)
{
	const parsed = Number(value.replace(/,/g, ""));
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * @param {string} version
 * @returns {[number, number, number] | undefined}
 */
function parseVersion(version)
{
	const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version));
	if (!match)
		return undefined;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * @param {string} actual
 * @param {[number, number, number]} minimum
 * @returns {boolean | undefined}
 */
function isVersionAtLeast(actual, minimum)
{
	const parsed = parseVersion(actual);
	if (!parsed)
		return undefined;

	for (let i = 0; i < minimum.length; i++) {
		if (parsed[i] > minimum[i])
			return true;
		if (parsed[i] < minimum[i])
			return false;
	}
	return true;
}

module.exports = {
	findTaggedTypeReferences,
	flattenHoverMarkdown,
	isVersionAtLeast,
	maskCommentsAndStrings,
	parseLayoutFromHoverMarkdown
};
