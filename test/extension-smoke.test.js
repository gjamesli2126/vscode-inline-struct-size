"use strict";

const assert = require("node:assert/strict");
const Module = require("node:module");
const test = require("node:test");

test("activates, queries cpptools hover, and applies an after decoration", async () => {
	const source = "struct sample *value;\n";
	const decorationCalls = [];
	const executedCommands = [];
	const disposables = [];

	class MarkdownString {
		constructor(value = "")
		{
			this.value = value;
		}

		appendMarkdown(value)
		{
			this.value += value;
		}
	}

	class Range {
		constructor(start, end)
		{
			this.start = start;
			this.end = end;
		}
	}

	const document = {
		languageId: "c",
		version: 1,
		fileName: "/workspace/sample.c",
		lineCount: 1,
		uri: {
			toString: () => "file:///workspace/sample.c"
		},
		getText: () => source,
		lineAt: () => ({
			range: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: source.length - 1 }
			}
		}),
		offsetAt: position => position.character,
		positionAt: offset => ({ line: 0, character: offset })
	};

	const editor = {
		document,
		visibleRanges: [{
			start: { line: 0, character: 0 },
			end: { line: 0, character: source.length - 1 }
		}],
		setDecorations: (_type, options) => decorationCalls.push(options)
	};

	const fakeVscode = {
		ThemeColor: class ThemeColor {
			constructor(id)
			{
				this.id = id;
			}
		},
		MarkdownString,
		Range,
		window: {
			activeTextEditor: editor,
			createOutputChannel: () => ({
				appendLine: () => {},
				dispose: () => {}
			}),
			createTextEditorDecorationType: () => ({
				dispose: () => {}
			}),
			onDidChangeActiveTextEditor: () => disposable(),
			onDidChangeTextEditorVisibleRanges: () => disposable(),
			showWarningMessage: async () => undefined
		},
		workspace: {
			getConfiguration: section => ({
				get: (key, fallback) => {
					if (section === "inlineStructSize") {
						const values = {
							enabled: true,
							showAlignment: true,
							debounceMs: 0,
							maxReferences: 60,
							queryConcurrency: 4
						};
						return Object.hasOwn(values, key) ? values[key] : fallback;
					}
					return fallback;
				}
			}),
			onDidChangeTextDocument: () => disposable(),
			onDidCloseTextDocument: () => disposable(),
			onDidChangeConfiguration: () => disposable()
		},
		commands: {
			registerCommand: () => disposable(),
			executeCommand: async (command) => {
				executedCommands.push(command);
				if (command === "vscode.executeHoverProvider") {
					return [{
						contents: [{
							value: "```c\nstruct sample\n```  \n**Size:** 16 B  \n**Alignment:** 8 B"
						}]
					}];
				}
				return undefined;
			}
		},
		extensions: {
			getExtension: id => id === "ms-vscode.cpptools"
				? {
					packageJSON: { version: "1.35.4" },
					activate: async () => ({})
				}
				: undefined
		}
	};

	function disposable()
	{
		const value = { dispose: () => {} };
		disposables.push(value);
		return value;
	}

	const originalLoad = Module._load;
	Module._load = function(request, parent, isMain) {
		if (request === "vscode")
			return fakeVscode;
		return originalLoad.call(this, request, parent, isMain);
	};

	try {
		const extensionPath = require.resolve("../extension");
		delete require.cache[extensionPath];
		const extension = require("../extension");
		const context = { subscriptions: [] };
		extension.activate(context);

		await new Promise(resolve => setTimeout(resolve, 50));

		assert.deepEqual(executedCommands, ["vscode.executeHoverProvider"]);
		const finalDecorations = decorationCalls.at(-1);
		assert.equal(finalDecorations.length, 1);
		assert.equal(finalDecorations[0].renderOptions.after.contentText, "16 B · align 8 B");
		assert.match(finalDecorations[0].hoverMessage.value, /did not compile or run a probe/);

		extension.deactivate();
		for (const item of context.subscriptions)
			item.dispose?.();
	} finally {
		Module._load = originalLoad;
	}
});
