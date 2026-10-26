# Inline Struct Size

Inline Struct Size displays Microsoft C/C++ IntelliSense type layout beside
explicit C/C++ tagged-type references:

```c
struct request *req;  // visually followed by: 128 B · align 8 B
```

The annotation is a VS Code decoration. It is not inserted into the file, is
not copied with the source, and does not appear in Git diffs.

## Installation

1. Download the `.vsix` file from the
   [latest GitHub release](https://github.com/gjamesli2126/vscode-inline-struct-size/releases/latest).
2. In VS Code, run **Extensions: Install from VSIX...** from the Command
   Palette and select the downloaded file.

Or install it from a terminal:

```sh
code --install-extension inline-struct-size-0.1.0.vsix
```

Ensure Microsoft C/C++ (`ms-vscode.cpptools`) 1.35.3 or newer is installed,
then open a C, C++, or CUDA C++ file. Run **Inline Struct Size: Refresh** if
decorations do not appear after IntelliSense finishes parsing.

## Requirements

- Microsoft C/C++ (`ms-vscode.cpptools`) 1.35.3 or newer.
- `C_Cpp.intelliSenseEngine` set to `default`.
- C/C++ hovers enabled.
- On C/C++ 1.35.4 or newer,
  `C_Cpp.hoverShowTypeSizeAndAlignment` enabled (its default is `true`).

The extension warns instead of running when the installed Microsoft C/C++
extension is too old or the required hover settings are disabled. It never
changes user or workspace settings.

## How it works

Only visible `struct Foo`, `union Foo`, and `class Foo` occurrences in the
active editor are scanned. For each occurrence, the extension asks VS Code's
normal hover provider for the type information, reads the size/alignment
emitted by Microsoft C/C++, and renders the result using an `after` decoration.

This extension:

- does not run `autogen.sh`, `configure`, or `make`;
- does not generate, compile, or execute probe source;
- does not create temporary source or executable files;
- does not write anything into the opened repository.

Microsoft C/C++ may independently query a compiler supplied by user settings,
workspace settings, `c_cpp_properties.json`, `compile_commands.json`, or a
configuration provider to discover system headers and predefined macros. An
explicitly empty `compilerPath` skips that query for the configuration in
which it is set. This extension neither controls nor changes those
configurations.

## Settings

- `inlineStructSize.enabled` — enable decorations (default `true`).
- `inlineStructSize.showAlignment` — include alignment (default `true`).
- `inlineStructSize.debounceMs` — refresh debounce (default `350` ms).
- `inlineStructSize.maxReferences` — visible references queried per refresh
  (default `60`).
- `inlineStructSize.queryConcurrency` — simultaneous hover requests (default
  `4`).

Run **Inline Struct Size: Refresh** after changing IntelliSense configuration
or while Microsoft C/C++ is still finishing its first parse.

## Limitations

- Values reflect the active IntelliSense target, include paths, defines,
  packing, and conditional-compilation state. A macOS configuration is not a
  Linux EFA ABI measurement.
- Missing headers such as `config.h`, unresolved nested types, or incorrect
  preprocessor defines can make a value unavailable or inaccurate.
- The first version recognizes explicit tagged references only. A typedef-only
  use such as `efa_rdm_ope *txe` is not annotated.
- Microsoft C/C++ exposes size/alignment as hover Markdown rather than a
  structured public API. A future change to that Markdown may require updating
  the parser.

If the existing **VisualStruct Size** extension is enabled, disable it to avoid
its separate compiler-probe behavior and duplicate decorations.

## Development

```sh
npm test
npm run check
```

Development requires Node.js 18 or newer. To package it locally, run:

```sh
npx @vscode/vsce package
```
