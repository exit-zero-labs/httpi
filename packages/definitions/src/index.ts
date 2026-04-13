/**
 * Public entrypoint for tracked-definition discovery, parsing, and compilation.
 *
 * Consumers should import from this file rather than individual modules when
 * they need project loading, root discovery, or snapshot compilation.
 */
export {
  createYamlDiagnosticResolver,
  enrichDiagnosticsFromFiles,
  finalizeDiagnostic,
} from "./diagnostic-locations.js";
export { loadProjectFiles } from "./project-loader.js";
export type { FindProjectRootOptions } from "./project-root.js";
export { findProjectRoot } from "./project-root.js";

export type { CompileSnapshotOptions } from "./snapshot-compiler.js";
export {
  assertProjectIsValid,
  compileRequestSnapshot,
  compileRunSnapshot,
} from "./snapshot-compiler.js";
