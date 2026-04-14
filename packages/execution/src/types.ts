/**
 * Internal helper types for the execution package.
 *
 * These models sit between the pure contracts package and the orchestration
 * code that compiles, materializes, and executes requests.
 */
import type {
  CompiledRequestStep,
  CompiledRunSnapshot,
  EnrichedDiagnostic,
  FlatVariableValue,
  ProjectFiles,
  ResolvedRequestModel,
  SessionRecord,
  VariableExplanation,
} from "@exit-zero-labs/runmark-contracts";

/** Common location options accepted by CLI and MCP entrypoints. */
export interface EngineOptions {
  cwd?: string | undefined;
  projectRoot?: string | undefined;
}

/** Result returned by `runmark init` after writing starter project files. */
export interface InitProjectResult {
  rootDir: string;
  createdPaths: string[];
  nextSteps: string[];
}

/** Loaded tracked project state shared across compile and execution flows. */
export interface LoadedProjectContext {
  rootDir: string;
  project: ProjectFiles;
}

/**
 * Inputs required to materialize a concrete request from a compiled run step.
 *
 * The execution layer keeps extracted values, secret values, and process
 * environment data separate so provenance remains explicit.
 */
export interface RequestResolutionContext {
  projectRoot: string;
  compiled: CompiledRunSnapshot;
  step: CompiledRequestStep;
  stepOutputs: Record<string, Record<string, FlatVariableValue>>;
  secretStepOutputs: Record<string, string[]>;
  secrets: Record<string, string>;
  processEnv: NodeJS.ProcessEnv;
}

/** Resolved scalar plus provenance and secret metadata. */
export interface ResolvedScalarValue {
  value: FlatVariableValue;
  source: VariableExplanation["source"];
  secret: boolean;
  secretValues: string[];
}

/** Concrete request plus variable explanations returned by materialization. */
export interface RequestMaterializationResult {
  request: ResolvedRequestModel;
  variables: VariableExplanation[];
}

/** Extracted step outputs persisted into session state after a successful step. */
export interface ExtractedStepOutputs {
  values: Record<string, FlatVariableValue>;
  secretOutputKeys: string[];
}

/** Session mutation result returned by step executors. */
export interface RequestExecutionOutcome {
  session: SessionRecord;
  success: boolean;
  diagnostics: EnrichedDiagnostic[];
}
