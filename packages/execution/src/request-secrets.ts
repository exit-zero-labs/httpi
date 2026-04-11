import type { SessionStepRecord } from "@exit-zero-labs/httpi-contracts";
import type { ExtractedStepOutputs } from "./types.js";

function formatSecretValue(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return value === null ? "null" : String(value);
}

export function uniqueSecretValues(secretValues: string[]): string[] {
  return [
    ...new Set(secretValues.filter((secretValue) => secretValue.length > 0)),
  ];
}

export function collectSecretOutputValues(
  outputs: ExtractedStepOutputs,
): string[] {
  return uniqueSecretValues(
    outputs.secretOutputKeys.flatMap((key) => {
      const secretValue = formatSecretValue(outputs.values[key]);
      return secretValue === undefined ? [] : [secretValue];
    }),
  );
}

export function collectSecretStepOutputs(
  stepRecords: Record<string, SessionStepRecord>,
): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(stepRecords).flatMap(([stepId, stepRecord]) =>
      stepRecord.secretOutputKeys && stepRecord.secretOutputKeys.length > 0
        ? [[stepId, [...stepRecord.secretOutputKeys]]]
        : [],
    ),
  );
}
