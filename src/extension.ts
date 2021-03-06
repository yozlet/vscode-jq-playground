"use strict";

import * as vscode from "vscode";
import * as child_process from "child_process";
import * as download from "download";
import * as fs from "fs";
import * as path from "path";

import { EditorDataHandler, OutputDataHandler } from "./dataHandler";
import { WorkspaceFilesCompletionItemProvider } from "./autocomplete";

const BINARIES = {
  darwin: "https://github.com/stedolan/jq/releases/download/jq-1.5/jq-osx-amd64",
  linux: "https://github.com/stedolan/jq/releases/download/jq-1.5/jq-linux64",
  win32: "https://github.com/stedolan/jq/releases/download/jq-1.5/jq-win64.exe",
};

const BIN_DIR = path.join(__dirname, "..", "bin");
const FILEPATH = path.join(BIN_DIR, /^win32/.test(process.platform) ? "./jq.exe" : "./jq");
const LANGUAGES = ["jq"];
const EXECUTE_JQ_COMMAND = "extension.executeJqCommand";
const CODE_LENS_TITLE = "jq";

const Logger = vscode.window.createOutputChannel("jq output");

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(vscode.commands.registerCommand("extension.openManual", openManual));
  context.subscriptions.push(vscode.commands.registerCommand("extension.openTutorial", openTutorial));
  context.subscriptions.push(vscode.commands.registerCommand("extension.openPlay", openPlay));
  context.subscriptions.push(vscode.commands.registerCommand("extension.runQueryOutput", runQueryOutput));
  context.subscriptions.push(vscode.commands.registerCommand("extension.runQueryEditor", runQueryEditor));

  setupEnvironment()
    .then(() => {
      context.subscriptions.push(vscode.commands.registerCommand(EXECUTE_JQ_COMMAND, executeJqCommand));
      context.subscriptions.push(vscode.languages.registerCodeLensProvider(LANGUAGES, { provideCodeLenses }));
      context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(LANGUAGES, new WorkspaceFilesCompletionItemProvider())
      );
    })
    .catch((error) => {
      Logger.appendLine(error);
    });
}

// tslint:disable-next-line:no-empty
export function deactivate() {}

function openManual() {
  vscode.commands.executeCommand("vscode.open", vscode.Uri.parse("https://stedolan.github.io/jq/manual/"));
}

function openTutorial() {
  vscode.commands.executeCommand("vscode.open", vscode.Uri.parse("https://stedolan.github.io/jq/tutorial/"));
}

function openPlay() {
  vscode.window.showInputBox({ prompt: "jq query", value: "." }).then((query) => {
    const json = encodeURIComponent(vscode.window.activeTextEditor.document.getText().replace(/\n|\s{2,}$/g, "%0A"));
    vscode.commands.executeCommand(
      "vscode.open",
      vscode.Uri.parse(`https://jqplay.org/jq?j=${json}&q=${encodeURIComponent(query)}`)
    );
  });
}

function runQueryOutput() {
  doRunQuery("output");
}

function runQueryEditor() {
  doRunQuery("editor");
}

function doRunQuery(openResult) {
  const editor = vscode.window.activeTextEditor;

  if (editor.selection.isEmpty) {
    const position: vscode.Position = editor.selection.active;
    const queryLine = new vscode.Range(
      new vscode.Position(position.line, 0),
      new vscode.Position(position.line, position.character)
    );

    const match: IJqMatch = {
      document: vscode.window.activeTextEditor.document,
      range: queryLine,
      openResult,
    };

    if (editor.document.lineAt(position).text.startsWith("jq")) {
      executeJqCommand(match);
    } else {
      vscode.window.showWarningMessage("Current line does not contain jq query string");
    }
  }
}

function setupEnvironment(): Promise<any> {
  if (!fs.existsSync(BIN_DIR)) {
    fs.mkdirSync(BIN_DIR);
  }

  if (!fs.existsSync(FILEPATH)) {
    if (!BINARIES[process.platform]) {
      return Promise.reject(`Platform (${process.platform}) not supported!`);
    }

    Logger.append(`Download jq binary for platform (${process.platform})...`);
    return download(BINARIES[process.platform]).then((data) => {
      fs.writeFileSync(FILEPATH, data);
      if (!/^win32/.test(process.platform)) {
        fs.chmodSync(FILEPATH, "0777");
      }
      Logger.append(" [ OK ]");
      Logger.show();
    });
  }

  return Promise.resolve();
}

function provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken) {
  const matches: IJqMatch[] = findRegexes(document);
  return matches
    .map((match) => {
      return [
        new vscode.CodeLens(match.range, {
          title: CODE_LENS_TITLE + " → to output",
          command: EXECUTE_JQ_COMMAND,
          arguments: [match],
        }),
        new vscode.CodeLens(match.range, {
          title: CODE_LENS_TITLE + " → to editor",
          command: EXECUTE_JQ_COMMAND,
          arguments: [{ ...match, openResult: "editor" }],
        }),
      ];
    })
    .reduce((a, b) => a.concat(b));
}

interface IJqMatch {
  document: vscode.TextDocument;
  range: vscode.Range;
  openResult: string;
}

function findRegexes(document: vscode.TextDocument): IJqMatch[] {
  const matches: IJqMatch[] = [];
  for (let i = 0; i < document.lineCount; i++) {
    const line = document.lineAt(i);
    let match: RegExpExecArray | null;
    const regex = /^(jq)\s+(.+?)/g;
    regex.lastIndex = 0;
    const text = line.text.substr(0, 1000);
    // tslint:disable-next-line:no-conditional-assignment
    while ((match = regex.exec(text))) {
      const result = jqMatch(document, i);
      if (result) {
        matches.push(result);
      }
    }
  }
  return matches;
}

function jqMatch(document: vscode.TextDocument, line: number) {
  return {
    document,
    openResult: "output",
    range: new vscode.Range(line, 0, line, 30),
  };
}

function executeJqCommand(params) {
  const document: vscode.TextDocument = params.document;
  const query: string = document.lineAt(params.range.start.line).text.replace(/jq\s+/, "");
  const context: string = document.lineAt(params.range.start.line + 1).text;

  if (isUrl(context)) {
    download(context)
      .then((data) => jsonParser(data.toString()))
      .then((json) => jqCommand(query, json, outputDataHandlerFactory(params.openResult)))
      .catch((err) => {
        Logger.append(err);
        Logger.show();
      });
  } else if (isWorksaceFile(context, vscode.workspace.textDocuments)) {
    const text: string = getWorksaceFile(context, vscode.workspace.textDocuments);
    jsonParser(text).then((json) => jqCommand(query, json, outputDataHandlerFactory(params.openResult)));
  } else if (isFilepath(context)) {
    const fileName: string = getFileName(document, context);
    if (fs.existsSync(fileName)) {
      jsonParser(fs.readFileSync(fileName).toString()).then((json) => {
        jqCommand(query, json, outputDataHandlerFactory(params.openResult));
      });
    }
  } else {
    const contextLines = [context];
    let line = params.range.start.line + 2;
    // tslint:disable-next-line:no-conditional-assignment
    while (line < document.lineCount) {
      let lineText = document.lineAt(line++).text;
      if (lineText.search(/^(jq)\s+(.+?)|#/) === 0) {
        break;
      }
      contextLines.push(lineText);
    }
    jsonParser(contextLines.join(" ")).then((json) =>
      jqCommand(query, json, outputDataHandlerFactory(params.openResult))
    );
  }
}

function jsonParser(text: string): Promise<any> {
  return new Promise((resolve, reject) => {
    try {
      resolve(JSON.parse(text));
    } catch (e) {
      try {
        // tslint:disable-next-line:prefer-const variable-name
        let __jq_tmp_variable = "";
        // tslint:disable-next-line:no-eval
        eval(`__jq_tmp_variable = ${text};`);
        const fixed = JSON.parse(JSON.stringify(__jq_tmp_variable));
        resolve(fixed);
      } catch (e) {
        vscode.window.showErrorMessage(e.message);
        reject("Unable to fix JSON, check document format");
      }
    }
  });
}

function isWorksaceFile(context: string, textDocuments: vscode.TextDocument[]): boolean {
  return textDocuments.filter((document) => document.fileName === context).length === 1;
}

function getWorksaceFile(context: string, textDocuments: vscode.TextDocument[]): string {
  for (const document of textDocuments) {
    if (document.fileName === context) {
      return document.getText();
    }
  }
  return "";
}

function jqCommand(statement: string, jsonObj: any, outputHandler) {
  if (jsonObj === undefined) {
    return;
  }

  const jqPprocess = child_process.spawn(FILEPATH, [statement]);
  jqPprocess.stdin.write(JSON.stringify(jsonObj));
  jqPprocess.stdin.end();

  jqPprocess.stdout.on("data", (data) => outputHandler.onData(data));
  jqPprocess.on("close", () => outputHandler.onClose());

  jqPprocess.stderr.on("data", (error) => {
    // vscode.window.showErrorMessage(error.toString());
    outputHandler.onData("[ERROR] - " + error.toString());
  });
}

function outputDataHandlerFactory(type: string) {
  if (type === "editor") {
    return new EditorDataHandler();
  }
  return new OutputDataHandler(Logger);
}

function isUrl(context: string): boolean {
  return context.search(/^http(s)?/) !== -1;
}

function isFilepath(context: string): boolean {
  return context.search(/^(\/|\.{1,2}\/|~\/)/) !== -1;
}

function getFileName(document: vscode.TextDocument, context: string): string {
  if (context.search("/") === 0) {
    return context;
  } else {
    return path.join(path.dirname(document.fileName), context);
  }
}
