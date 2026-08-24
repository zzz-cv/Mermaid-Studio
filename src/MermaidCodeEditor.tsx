import Editor, { loader, type Monaco } from "@monaco-editor/react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

loader.config({ monaco });
(self as typeof self & { MonacoEnvironment?: { getWorker: () => Worker } }).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

function configureMonaco(instance: Monaco) {
  if (!instance.languages.getLanguages().some((language) => language.id === "mermaid")) {
    instance.languages.register({ id: "mermaid", extensions: [".mmd", ".mermaid", ".md"] });
    instance.languages.setMonarchTokensProvider("mermaid", {
      keywords: ["flowchart", "graph", "sequenceDiagram", "classDiagram", "stateDiagram-v2", "stateDiagram", "erDiagram", "gantt", "subgraph", "end", "participant", "actor", "class", "state", "section", "title", "dateFormat"],
      tokenizer: {
        root: [
          [/%%.*$/, "comment"],
          [/(-->|---|-.->|==>|--x|--o|->>|-->>|\|\||\|\{|\}\||\[\*\])/, "operator"],
          [/[{}()[\]]/, "delimiter.bracket"],
          [/"[^"]*"/, "string"],
          [/[A-Za-z_][\w-]*/, { cases: { "@keywords": "keyword", "@default": "identifier" } }],
          [/\d+(?:\.\d+)?/, "number"],
          [/[：]/, "delimiter"],
        ],
      },
    });
  }
  instance.editor.defineTheme("mermaid-studio-light", {
    base: "vs",
    inherit: true,
    rules: [
      { token: "comment", foreground: "87958D", fontStyle: "italic" },
      { token: "keyword", foreground: "B0187B" },
      { token: "operator", foreground: "1357D6" },
      { token: "delimiter.bracket", foreground: "0759DB" },
      { token: "string", foreground: "3C6F57" },
      { token: "number", foreground: "8E5D20" },
      { token: "identifier", foreground: "A31570" },
    ],
    colors: {
      "editor.background": "#FFFFFF",
      "editor.foreground": "#28342D",
      "editorLineNumber.foreground": "#7C9A8A",
      "editorLineNumber.activeForeground": "#225F48",
      "editor.lineHighlightBackground": "#F2F5F3",
      "editor.lineHighlightBorder": "#E3E9E5",
      "editorCursor.foreground": "#2F7455",
      "editor.selectionBackground": "#DCEBE2",
      "editor.inactiveSelectionBackground": "#E9F1EC",
      "editorIndentGuide.background1": "#E5EAE7",
      "editorIndentGuide.activeBackground1": "#A9BBB0",
      "editorGutter.background": "#FFFFFF",
    },
  });
}

export default function MermaidCodeEditor({ value, fontSize, onChange, onSave }: {
  value: string;
  fontSize: number;
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  return <Editor
    language="mermaid"
    theme="mermaid-studio-light"
    value={value}
    beforeMount={configureMonaco}
    onMount={(editor, instance) => editor.addCommand(instance.KeyMod.CtrlCmd | instance.KeyCode.KeyS, onSave)}
    onChange={(next) => onChange(next ?? "")}
    options={{
      automaticLayout: true,
      fontFamily: "'Cascadia Code', 'JetBrains Mono', Consolas, 'Microsoft YaHei', monospace",
      fontSize,
      lineHeight: fontSize + 10,
      lineNumbersMinChars: 3,
      glyphMargin: true,
      folding: false,
      minimap: { enabled: false },
      padding: { top: 14, bottom: 28 },
      renderLineHighlight: "all",
      renderWhitespace: "selection",
      scrollBeyondLastLine: true,
      smoothScrolling: true,
      tabSize: 2,
      wordWrap: "on",
      bracketPairColorization: { enabled: true },
      overviewRulerBorder: false,
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      scrollbar: { verticalScrollbarSize: 9, horizontalScrollbarSize: 9 },
    }}
  />;
}
