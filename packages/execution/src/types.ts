import type {
  CompiledRequestStep,
  CompiledRunSnapshot,
  EnrichedDiagnostic,
  FlatVariableValue,
  ProjectFiles,
  ResolvedRequestModel,
  SessionRecord,
  VariableExplanation,
} from "@exit-zero-labs/httpi-contracts";

export interface EngineOptions {
  cwd?: string | undefined;
  projectRoot?: string | undefined;
}

export interface InitProjectResult {
  rootDir: string;
  createdPaths: string[];
}

export interface LoadedProjectContext {
  rootDir: string;
  project: ProjectFiles;
}

export interface RequestResolutionContext {
  projectRoot: string;
  compiled: CompiledRunSnapshot;
  step: CompiledRequestStep;
  stepOutputs: Record<string, Record<string, FlatVariableValue>>;
  secretStepOutputs: Record<string, string[]>;
  secrets: Record<string, string>;
  processEnv: NodeJS.ProcessEnv;
}

export interface ResolvedScalarValue {
  value: FlatVariableValue;
  source: VariableExplanation["source"];
  secret: boolean;
  secretValues: string[];
}

export interface RequestMaterializationResult {
  request: ResolvedRequestModel;
  variables: VariableExplanation[];
}

export interface ExtractedStepOutputs {
  values: Record<string, FlatVariableValue>;
  secretOutputKeys: string[];
}

export interface RequestExecutionOutcome {
  session: SessionRecord;
  success: boolean;
  diagnostics: EnrichedDiagnostic[];
}
