"use strict";

const vscode = require("vscode");
const {
	findTaggedTypeReferences,
	flattenHoverMarkdown,
	isVersionAtLeast,
	parseLayoutFromHoverMarkdown
} = require("./lib/layout");

const MINIMUM_CPPTOOLS_VERSION = [1, 35, 3];
const SUPPORTED_LANGUAGES = new Set(["c", "cpp", "cuda-cpp"]);
const LAYOUT_CACHE_LIMIT = 2000;
const REFERENCE_CACHE_LIMIT = 12;

let decorationType;
let output;
let debounceTimer;
let configurationRetryTimer;
let updateGeneration = 0;
let cacheEpoch = 0;
let cpptoolsActivation;
let decoratedEditor;
let updateQueue = Promise.resolve();
const layoutCache = new Map();
const pendingQueries = new Map();
const referenceCache = new Map();
const shownWarnings = new Set();

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context)
{
	output = vscode.window.createOutputChannel("Inline Struct Size");
	decorationType = vscode.window.createTextEditorDecorationType({
		after: {
			margin: "0 0 0 0.9rem",
			color: new vscode.ThemeColor("editorCodeLens.foreground"),
			fontStyle: "italic"
		}
	});

	context.subscriptions.push(output);
	context.subscriptions.push(decorationType);
	context.subscriptions.push(vscode.commands.registerCommand("inlineStructSize.refresh", () => {
		invalidateLayoutCache();
		scheduleUpdate(0);
	}));
	context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
		clearPreviousEditor(editor);
		scheduleUpdate(0);
	}));
	context.subscriptions.push(vscode.window.onDidChangeTextEditorVisibleRanges(event => {
		if (event.textEditor === vscode.window.activeTextEditor)
			scheduleUpdate(75);
	}));
	context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
		const editor = vscode.window.activeTextEditor;
		if (editor && event.document === editor.document) {
			invalidateLayoutCache();
			invalidateDocumentReferences(event.document);
			scheduleUpdate();
		}
	}));
	context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(document => {
		invalidateLayoutCache();
		invalidateDocumentReferences(document);
	}));
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
		const inlineSettingsChanged = event.affectsConfiguration("inlineStructSize");
		const cppSettingsChanged = event.affectsConfiguration("C_Cpp");
		if (inlineSettingsChanged || cppSettingsChanged) {
			invalidateLayoutCache();
			scheduleUpdate(cppSettingsChanged ? 500 : 0);
		}
		if (cppSettingsChanged) {
			clearTimeout(configurationRetryTimer);
			configurationRetryTimer = setTimeout(() => {
				invalidateLayoutCache();
				scheduleUpdate(0);
			}, 2000);
		}
	}));

	scheduleUpdate(0);
}

function deactivate()
{
	clearTimeout(debounceTimer);
	clearTimeout(configurationRetryTimer);
}

/**
 * @param {number | undefined} delay
 */
function scheduleUpdate(delay)
{
	const generation = ++updateGeneration;
	clearTimeout(debounceTimer);

	const editor = vscode.window.activeTextEditor;
	if (!editor)
		clearPreviousEditor(undefined);
	const configuredDelay = editor
		? vscode.workspace.getConfiguration("inlineStructSize", editor.document.uri).get("debounceMs", 350)
		: 350;
	const wait = typeof delay === "number" ? delay : configuredDelay;

	debounceTimer = setTimeout(() => {
		updateQueue = updateQueue
			.catch(error => output.appendLine(`Update failed: ${formatError(error)}`))
			.then(() => updateEditor(vscode.window.activeTextEditor, generation))
			.catch(error => output.appendLine(`Update failed: ${formatError(error)}`));
	}, wait);
}

/**
 * @param {vscode.TextEditor | undefined} editor
 * @param {number} generation
 */
async function updateEditor(editor, generation)
{
	if (!editor)
		return;

	const document = editor.document;
	const settings = vscode.workspace.getConfiguration("inlineStructSize", document.uri);
	if (!settings.get("enabled", true) || !SUPPORTED_LANGUAGES.has(document.languageId)) {
		editor.setDecorations(decorationType, []);
		if (decoratedEditor === editor)
			decoratedEditor = undefined;
		return;
	}

	if (!(await ensureCppToolsReady())) {
		editor.setDecorations(decorationType, []);
		if (decoratedEditor === editor)
			decoratedEditor = undefined;
		return;
	}

	const configurationProblem = getCppConfigurationProblem(document.uri);
	if (configurationProblem) {
		editor.setDecorations(decorationType, []);
		if (decoratedEditor === editor)
			decoratedEditor = undefined;
		warnOnce(configurationProblem.key, configurationProblem.message);
		return;
	}

	if (!isCurrentUpdate(editor, document, generation))
		return;

	const offsetRanges = visibleOffsetRanges(editor);
	const configuredMaxReferences = settings.get("maxReferences", 60);
	const maxReferences = Number.isFinite(configuredMaxReferences)
		? Math.max(1, Math.floor(configuredMaxReferences))
		: 60;
	const references = getVisibleReferences(document, offsetRanges, maxReferences);
	if (references.length === 0) {
		editor.setDecorations(decorationType, []);
		if (decoratedEditor === editor)
			decoratedEditor = undefined;
		return;
	}

	editor.setDecorations(decorationType, makeDecorations(document, references, settings));
	decoratedEditor = editor;

	const concurrency = settings.get("queryConcurrency", 4);
	await forEachWithConcurrency(references, concurrency, async reference => {
		if (!isCurrentUpdate(editor, document, generation))
			return;
		await getLayout(document, reference);
	});

	if (!isCurrentUpdate(editor, document, generation))
		return;

	editor.setDecorations(decorationType, makeDecorations(document, references, settings));
	decoratedEditor = editor;
}

/**
 * @returns {Promise<boolean>}
 */
async function ensureCppToolsReady()
{
	const extension = vscode.extensions.getExtension("ms-vscode.cpptools");
	if (!extension) {
		warnOnce(
			"cpptools-missing",
			"Inline Struct Size requires the Microsoft C/C++ extension (ms-vscode.cpptools)."
		);
		return false;
	}

	const version = extension.packageJSON && extension.packageJSON.version
		? String(extension.packageJSON.version)
		: "";
	const supported = isVersionAtLeast(version, MINIMUM_CPPTOOLS_VERSION);
	if (supported === false) {
		warnOnce(
			"cpptools-old",
			`Inline Struct Size requires Microsoft C/C++ 1.35.3 or newer. Installed version: ${version}.`,
			true
		);
		return false;
	}

	if (!cpptoolsActivation) {
		cpptoolsActivation = extension.activate().then(
			() => true,
			error => {
				cpptoolsActivation = undefined;
				output.appendLine(`Failed to activate Microsoft C/C++: ${formatError(error)}`);
				warnOnce("cpptools-activation", "Microsoft C/C++ could not be activated. See Output > Inline Struct Size.");
				return false;
			}
		);
	}

	return cpptoolsActivation;
}

/**
 * @param {vscode.Uri} uri
 * @returns {{key: string, message: string} | undefined}
 */
function getCppConfigurationProblem(uri)
{
	const cpp = vscode.workspace.getConfiguration("C_Cpp", uri);
	if (cpp.get("intelliSenseEngine", "default") !== "default") {
		return {
			key: "intellisense-disabled",
			message: "Inline Struct Size requires C_Cpp.intelliSenseEngine to be set to default."
		};
	}

	if (cpp.get("hover", "default") === "disabled") {
		return {
			key: "hover-disabled",
			message: "Inline Struct Size requires C_Cpp.hover to be enabled."
		};
	}

	if (cpp.get("hoverShowTypeSizeAndAlignment", true) === false) {
		return {
			key: "layout-hover-disabled",
			message: "Inline Struct Size requires C_Cpp.hoverShowTypeSizeAndAlignment to be enabled."
		};
	}

	return undefined;
}

/**
 * @param {vscode.TextEditor} editor
 * @returns {{start: number, end: number}[]}
 */
function visibleOffsetRanges(editor)
{
	const document = editor.document;
	return editor.visibleRanges.map(range => {
		const startLine = Math.max(0, Math.min(range.start.line, document.lineCount - 1));
		const endLine = Math.max(0, Math.min(range.end.line, document.lineCount - 1));
		return {
			start: document.offsetAt(document.lineAt(startLine).range.start),
			end: document.offsetAt(document.lineAt(endLine).range.end)
		};
	});
}

/**
 * @param {vscode.TextDocument} document
 * @param {{start: number, end: number, queryOffset: number, kind: string, typeName: string}} reference
 * @returns {Promise<{size: number, alignment: number | undefined} | undefined>}
 */
async function getLayout(document, reference)
{
	const key = cacheKey(document, reference);
	if (layoutCache.has(key))
		return layoutCache.get(key);
	if (pendingQueries.has(key))
		return pendingQueries.get(key);

	const query = queryLayout(document, reference)
		.then(layout => {
			if (layout) {
				layoutCache.set(key, layout);
				trimMap(layoutCache, LAYOUT_CACHE_LIMIT);
			}
			return layout;
		})
		.finally(() => pendingQueries.delete(key));

	pendingQueries.set(key, query);
	return query;
}

/**
 * @param {vscode.TextDocument} document
 * @param {{queryOffset: number, kind: string, typeName: string}} reference
 * @returns {Promise<{size: number, alignment: number | undefined} | undefined>}
 */
async function queryLayout(document, reference)
{
	try {
		const position = document.positionAt(reference.queryOffset);
		const hovers = await vscode.commands.executeCommand(
			"vscode.executeHoverProvider",
			document.uri,
			position
		);
		return parseLayoutFromHoverMarkdown(flattenHoverMarkdown(hovers));
	} catch (error) {
		output.appendLine(
			`Hover query failed for ${reference.kind} ${reference.typeName} in ${document.fileName}: ${formatError(error)}`
		);
		return undefined;
	}
}

/**
 * @param {vscode.TextDocument} document
 * @param {{end: number, kind: string, typeName: string, start: number, queryOffset: number}[]} references
 * @param {vscode.WorkspaceConfiguration} settings
 * @returns {vscode.DecorationOptions[]}
 */
function makeDecorations(document, references, settings)
{
	const showAlignment = settings.get("showAlignment", true);
	const decorations = [];

	for (const reference of references) {
		const layout = layoutCache.get(cacheKey(document, reference));
		if (!layout)
			continue;

		const position = document.positionAt(reference.end);
		const contentText = showAlignment && layout.alignment !== undefined
			? `${layout.size} B · align ${layout.alignment} B`
			: `${layout.size} B`;
		const hover = new vscode.MarkdownString();
		hover.appendMarkdown("**IntelliSense type layout**  \n");
		hover.appendMarkdown(`Size: **${layout.size} bytes**  \n`);
		if (layout.alignment !== undefined)
			hover.appendMarkdown(`Alignment: **${layout.alignment} bytes**  \n`);
		hover.appendMarkdown("_Computed for the active C/C++ IntelliSense configuration. This extension did not compile or run a probe._");

		decorations.push({
			range: new vscode.Range(position, position),
			hoverMessage: hover,
			renderOptions: {
				after: {
					contentText
				}
			}
		});
	}

	return decorations;
}

/**
 * @param {vscode.TextDocument} document
 * @param {{start: number}} reference
 * @returns {string}
 */
function cacheKey(document, reference)
{
	return `${cacheEpoch}\u0000${document.uri.toString()}\u0000${document.version}\u0000${reference.start}`;
}

function invalidateLayoutCache()
{
	cacheEpoch++;
	layoutCache.clear();
	pendingQueries.clear();
}

/**
 * @param {vscode.TextDocument} document
 */
function invalidateDocumentReferences(document)
{
	const prefix = `${document.uri.toString()}\u0000`;
	for (const key of referenceCache.keys()) {
		if (key.startsWith(prefix))
			referenceCache.delete(key);
	}
}

/**
 * @param {vscode.TextDocument} document
 * @param {{start: number, end: number}[]} offsetRanges
 * @param {number} maximum
 * @returns {{start: number, end: number, queryOffset: number, kind: string, typeName: string}[]}
 */
function getVisibleReferences(document, offsetRanges, maximum)
{
	const key = `${document.uri.toString()}\u0000${document.version}`;
	let references = referenceCache.get(key);
	if (!references) {
		references = findTaggedTypeReferences(document.getText());
		referenceCache.set(key, references);
		trimMap(referenceCache, REFERENCE_CACHE_LIMIT);
	}

	return references
		.filter(reference => offsetRanges.some(range =>
			reference.start <= range.end && reference.end >= range.start))
		.slice(0, maximum);
}

/**
 * @param {Map<unknown, unknown>} map
 * @param {number} maximum
 */
function trimMap(map, maximum)
{
	while (map.size > maximum) {
		const oldest = map.keys().next();
		if (oldest.done)
			return;
		map.delete(oldest.value);
	}
}

/**
 * @param {vscode.TextEditor | undefined} nextEditor
 */
function clearPreviousEditor(nextEditor)
{
	if (!decoratedEditor || decoratedEditor === nextEditor)
		return;

	try {
		decoratedEditor.setDecorations(decorationType, []);
	} catch {
		// The editor may already have been disposed.
	}
	decoratedEditor = undefined;
}

/**
 * @param {vscode.TextEditor} editor
 * @param {vscode.TextDocument} document
 * @param {number} generation
 * @returns {boolean}
 */
function isCurrentUpdate(editor, document, generation)
{
	return generation === updateGeneration
		&& vscode.window.activeTextEditor === editor
		&& editor.document === document;
}

/**
 * @template T
 * @param {T[]} items
 * @param {number} requestedConcurrency
 * @param {(item: T) => Promise<void>} worker
 */
async function forEachWithConcurrency(items, requestedConcurrency, worker)
{
	let next = 0;
	const parsedConcurrency = Number.isFinite(requestedConcurrency)
		? Math.floor(requestedConcurrency)
		: 1;
	const concurrency = Math.max(1, Math.min(parsedConcurrency, items.length));
	const runners = Array.from({ length: concurrency }, async () => {
		while (next < items.length) {
			const index = next++;
			await worker(items[index]);
		}
	});
	await Promise.all(runners);
}

/**
 * @param {string} key
 * @param {string} message
 * @param {boolean} [offerExtensionSearch]
 */
function warnOnce(key, message, offerExtensionSearch)
{
	if (shownWarnings.has(key))
		return;
	shownWarnings.add(key);
	output.appendLine(message);

	if (offerExtensionSearch) {
		void vscode.window.showWarningMessage(message, "Open Extensions").then(selection => {
			if (selection === "Open Extensions")
				void vscode.commands.executeCommand("workbench.extensions.search", "@id:ms-vscode.cpptools");
		});
	} else {
		void vscode.window.showWarningMessage(message);
	}
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function formatError(error)
{
	return error instanceof Error ? error.message : String(error);
}

module.exports = {
	activate,
	deactivate
};
