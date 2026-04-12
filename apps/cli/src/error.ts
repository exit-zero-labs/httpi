import { isDiagnostic, type Diagnostic } from "@exit-zero-labs/httpi-contracts";
import {
  coerceErrorMessage,
  exitCodes,
  isHttpiError,
} from "@exit-zero-labs/httpi-shared";

export interface CliFailure {
  message: string;
  exitCode: number;
}

export function toCliFailure(error: unknown): CliFailure {
  if (isHttpiError(error)) {
    return {
      message: renderCliFailureMessage(error.message, error.details),
      exitCode: error.exitCode,
    };
  }

  return {
    message: coerceErrorMessage(error),
    exitCode: exitCodes.internalError,
  };
}

export function formatCliDiagnostics(diagnostics: Diagnostic[]): string {
  return diagnostics
    .map((diagnostic) => formatCliDiagnostic(diagnostic))
    .join("\n");
}

function renderCliFailureMessage(message: string, details: unknown): string {
  if (details === undefined) {
    return message;
  }

  const diagnostics = extractDiagnostics(details);
  if (diagnostics) {
    const formattedDiagnostics = formatCliDiagnostics(diagnostics);
    return formattedDiagnostics ? `${message}\n${formattedDiagnostics}` : message;
  }

  const formattedDetails = JSON.stringify(details, null, 2);
  return formattedDetails ? `${message}\n${formattedDetails}` : message;
}

function formatCliDiagnostic(diagnostic: Diagnostic): string {
  const file = diagnostic.file ?? "<unknown>";
  const line = diagnostic.line ?? 1;
  const column = diagnostic.column ?? 1;
  const header = `${file}:${line}:${column}: ${diagnostic.level}[${diagnostic.code}]: ${diagnostic.message}`;

  return diagnostic.hint ? `${header}\n  hint: ${diagnostic.hint}` : header;
}

function extractDiagnostics(details: unknown): Diagnostic[] | undefined {
  if (!Array.isArray(details) || details.length === 0) {
    return undefined;
  }

  return details.every(isDiagnostic) ? details : undefined;
}
