import * as vscode from "vscode";
import { markerPositions } from "../core/deeFile";
import { mapErrorsToFile, parseHostErrors } from "../core/errorMap";

export class DeeDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection("dee");

  /** Map a host compile-error payload onto the local file and publish squiggles. */
  publishServerErrors(document: vscode.TextDocument, serverMessage: string): number {
    const errors = parseHostErrors(serverMessage);
    let mapped;
    try {
      mapped = mapErrorsToFile(errors, markerPositions(document.getText()));
    } catch {
      mapped = errors.map((e) => ({ ...e, fileLine: undefined }));
    }
    const diagnostics = mapped.map((error) => {
      const line = error.fileLine ?? 0;
      const column = Math.max((error.column ?? 1) - 1, 0);
      const range =
        error.fileLine !== undefined
          ? new vscode.Range(line, column, line, Math.max(column, document.lineAt(Math.min(line, document.lineCount - 1)).text.length))
          : new vscode.Range(0, 0, 0, 0);
      const diagnostic = new vscode.Diagnostic(
        range,
        error.message,
        error.severity === "warning" ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error,
      );
      diagnostic.source = "MES DEE";
      return diagnostic;
    });
    this.collection.set(document.uri, diagnostics);
    return diagnostics.length;
  }

  clear(uri: vscode.Uri): void {
    this.collection.delete(uri);
  }

  dispose(): void {
    this.collection.dispose();
  }
}
