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

function renderCliFailureMessage(message: string, details: unknown): string {
  if (details === undefined) {
    return message;
  }

  const formattedDetails = JSON.stringify(details, null, 2);
  return formattedDetails ? `${message}\n${formattedDetails}` : message;
}
