import type {
  Diagnostic,
  EnrichedDiagnostic,
} from "@exit-zero-labs/httpi-contracts";
import { toDisplayDiagnosticFile } from "@exit-zero-labs/httpi-contracts";
import { readUtf8File } from "@exit-zero-labs/httpi-shared";
import type { Node, Pair, ParsedNode, Scalar, YAMLMap, YAMLSeq } from "yaml";
import {
  LineCounter,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
} from "yaml";

interface PathPropertySegment {
  kind: "property";
  value: string;
}

interface PathIndexSegment {
  kind: "index";
  value: number;
}

type PathSegment = PathPropertySegment | PathIndexSegment;

interface LocatedSequenceItem {
  item: ParsedNode;
  positionNode: Node;
}

export interface YamlDiagnosticResolver {
  readonly filePath: string;
  resolve(path?: string): Required<Pick<Diagnostic, "file" | "line" | "column">>;
}

export function createYamlDiagnosticResolver(
  filePath: string,
  rawContent: string,
): YamlDiagnosticResolver {
  const lineCounter = new LineCounter();
  const document = parseDocument(rawContent, {
    lineCounter,
    prettyErrors: false,
  });
  const fallbackPosition = positionFromOffset(
    lineCounter,
    getNodeOffset(document.contents) ?? 0,
  );

  return {
    filePath,
    resolve(path?: string) {
      const resolvedNode = findNodeForPath(document.contents, path);
      const resolvedPosition = positionFromOffset(
        lineCounter,
        getNodeOffset(resolvedNode) ?? 0,
      );
      return {
        file: toDisplayDiagnosticFile(filePath),
        line: resolvedPosition.line ?? fallbackPosition.line ?? 1,
        column: resolvedPosition.column ?? fallbackPosition.column ?? 1,
      };
    },
  };
}

export async function enrichDiagnosticsFromFiles(
  diagnostics: Diagnostic[],
): Promise<EnrichedDiagnostic[]> {
  const resolverCache = new Map<string, Promise<YamlDiagnosticResolver>>();

  return Promise.all(
    diagnostics.map(async (diagnostic) => {
      const filePath = diagnostic.file ?? diagnostic.filePath;
      if (!filePath || filePath.startsWith("$ENV:")) {
        return finalizeDiagnostic(diagnostic);
      }

      let resolverPromise = resolverCache.get(filePath);
      if (!resolverPromise) {
        resolverPromise = createYamlDiagnosticResolverFromFile(filePath).catch(() =>
          createFallbackDiagnosticResolver(filePath),
        );
        resolverCache.set(filePath, resolverPromise);
      }

      return finalizeDiagnostic(diagnostic, await resolverPromise);
    }),
  );
}

export function finalizeDiagnostic(
  diagnostic: Diagnostic,
  resolver?: YamlDiagnosticResolver,
): EnrichedDiagnostic {
  const resolvedFilePath = diagnostic.file ?? diagnostic.filePath ?? resolver?.filePath;
  const resolvedLocation = diagnostic.path
    ? resolver?.resolve(diagnostic.path)
    : undefined;
  const displayFile = resolvedFilePath
    ? toDisplayDiagnosticFile(resolvedFilePath)
    : "<unknown>";

  return {
    ...diagnostic,
    hint: diagnostic.hint ?? defaultDiagnosticHint(diagnostic),
    file: displayFile,
    filePath: displayFile,
    line: diagnostic.line ?? resolvedLocation?.line ?? 1,
    column: diagnostic.column ?? resolvedLocation?.column ?? 1,
  };
}

async function createYamlDiagnosticResolverFromFile(
  filePath: string,
): Promise<YamlDiagnosticResolver> {
  return createYamlDiagnosticResolver(filePath, await readUtf8File(filePath));
}

function createFallbackDiagnosticResolver(filePath: string): YamlDiagnosticResolver {
  return {
    filePath,
    resolve() {
      return {
        file: toDisplayDiagnosticFile(filePath),
        line: 1,
        column: 1,
      };
    },
  };
}

function findNodeForPath(
  rootNode: ParsedNode | null | undefined,
  path: string | undefined,
): Node | undefined {
  if (!rootNode || !path) {
    return rootNode ?? undefined;
  }

  const segments = tokenizeDiagnosticPath(path);
  if (segments.length === 0) {
    return rootNode;
  }

  let currentNode: ParsedNode | null | undefined = rootNode;
  let lastLocatedNode: Node | undefined = rootNode;

  for (const segment of segments) {
    if (isMap(currentNode)) {
      const matchedPair = findPair(currentNode, segment);
      if (!matchedPair) {
        return lastLocatedNode;
      }
      lastLocatedNode = matchedPair.key ?? matchedPair.value ?? lastLocatedNode;
      currentNode = matchedPair.value as ParsedNode | null | undefined;
      continue;
    }

    if (isSeq(currentNode)) {
      const matchedItem = findSequenceItem(currentNode, segment);
      if (!matchedItem) {
        return lastLocatedNode;
      }
      lastLocatedNode = matchedItem.positionNode;
      currentNode = matchedItem.item;
      continue;
    }

    return lastLocatedNode;
  }

  return lastLocatedNode;
}

function tokenizeDiagnosticPath(path: string): PathSegment[] {
  const segments: PathSegment[] = [];

  let index = 0;
  while (index < path.length) {
    const current = path[index];
    if (!current) {
      break;
    }
    if (current === ".") {
      index += 1;
      continue;
    }

    if (current === "[") {
      const next = path[index + 1];
      if (next === '"') {
        const quotedSegment = readQuotedPathSegment(path, index);
        if (!quotedSegment) {
          break;
        }
        segments.push({
          kind: "property",
          value: quotedSegment.value,
        });
        index = quotedSegment.nextIndex;
        continue;
      }

      const closeIndex = path.indexOf("]", index);
      if (closeIndex === -1) {
        break;
      }

      const bracketValue = path.slice(index + 1, closeIndex);
      if (/^\d+$/.test(bracketValue)) {
        segments.push({
          kind: "index",
          value: Number(bracketValue),
        });
      } else if (bracketValue.length > 0) {
        segments.push({
          kind: "property",
          value: bracketValue,
        });
      }

      index = closeIndex + 1;
      continue;
    }

    let endIndex = index;
    while (
      endIndex < path.length &&
      path[endIndex] !== "." &&
      path[endIndex] !== "["
    ) {
      endIndex += 1;
    }

    const propertyValue = path.slice(index, endIndex);
    if (/^\d+$/.test(propertyValue)) {
      segments.push({
        kind: "index",
        value: Number(propertyValue),
      });
    } else if (propertyValue.length > 0) {
      segments.push({
        kind: "property",
        value: propertyValue,
      });
    }

    index = endIndex;
  }

  return segments;
}

function readQuotedPathSegment(
  path: string,
  startIndex: number,
): {
  value: string;
  nextIndex: number;
} | undefined {
  let index = startIndex + 2;
  let encodedValue = '"';
  let escaped = false;

  while (index < path.length) {
    const current = path[index];
    if (!current) {
      return undefined;
    }

    encodedValue += current;
    if (escaped) {
      escaped = false;
      index += 1;
      continue;
    }

    if (current === "\\") {
      escaped = true;
      index += 1;
      continue;
    }

    if (current === '"') {
      break;
    }

    index += 1;
  }

  if (path[index] !== '"' || path[index + 1] !== "]") {
    return undefined;
  }

  return {
    value: JSON.parse(encodedValue) as string,
    nextIndex: index + 2,
  };
}

function findPair(
  mapNode: YAMLMap<ParsedNode, ParsedNode | null>,
  segment: PathSegment,
): Pair<ParsedNode, ParsedNode | null> | undefined {
  if (segment.kind !== "property") {
    return undefined;
  }

  return mapNode.items.find(
    (pair) => getScalarText(pair.key) === segment.value,
  );
}

function findSequenceItem(
  sequenceNode: YAMLSeq<ParsedNode | null>,
  segment: PathSegment,
): LocatedSequenceItem | undefined {
  if (segment.kind === "index") {
    const item = sequenceNode.items[segment.value];
    return item
      ? {
          item,
          positionNode: item,
        }
      : undefined;
  }

  for (const item of sequenceNode.items) {
    if (!isMap(item)) {
      continue;
    }

    const idPair = item.items.find(
      (pair) => getScalarText(pair.key) === "id" && getScalarText(pair.value) === segment.value,
    );
    if (idPair) {
      return {
        item,
        positionNode: idPair.key ?? idPair.value ?? item,
      };
    }
  }

  return undefined;
}

function getScalarText(node: Node | null | undefined): string | undefined {
  if (!node) {
    return undefined;
  }

  if (isScalar(node)) {
    return scalarToString(node);
  }

  return node.toString();
}

function scalarToString(node: Scalar<unknown>): string {
  return node.value === null ? "null" : String(node.value);
}

function getNodeOffset(node: Node | null | undefined): number | undefined {
  return typeof node?.range?.[0] === "number" ? node.range[0] : undefined;
}

function positionFromOffset(
  lineCounter: LineCounter,
  offset: number,
): {
  line?: number;
  column?: number;
} {
  const position = lineCounter.linePos(offset);
  return {
    line: position?.line,
    column: position?.col,
  };
}

function defaultDiagnosticHint(diagnostic: Diagnostic): string {
  switch (diagnostic.code) {
    case "YAML_PARSE_ERROR":
      return "Fix the YAML syntax near this location and retry.";
    case "UNSUPPORTED_SCHEMA_VERSION":
      return "Set schemaVersion to 1 for this tracked definition.";
    case "SECRET_LITERAL":
      return "Replace the literal with {{secrets.alias}} or $ENV:NAME so secrets stay out of tracked files.";
    case "EXPECTATION_FAILED":
      return "Update the expect block if the contract changed, or investigate why the response no longer matches.";
    case "EXTRACTION_FAILED":
      return "Update the extract path if the response contract changed, or verify that the response still includes this field.";
    case "DEFINITION_DRIFT":
      return "Start a fresh run or revert the tracked file before resuming this session.";
    case "DEFINITION_DELETED":
      return "Restore the tracked file or start a fresh run before resuming this session.";
    case "DEFINITION_PATH_INVALID":
      return "Restore the tracked file as a regular file inside the project root before resuming this session.";
    case "PROCESS_ENV_DRIFT":
      return "Re-run the workflow with the current environment instead of resuming a session created under different $ENV values.";
    case "PROCESS_ENV_MISSING":
      return "Set the missing environment variable or replace the $ENV reference at this location.";
    case "VARIABLE_UNRESOLVED":
      return "Define the referenced variable or update the template at this location.";
    case "VARIABLE_CYCLE":
      return "Break the variable cycle by removing the self-referential template chain at this location.";
    case "REQUEST_TIMEOUT_INVALID":
      return "Resolve timeoutMs to a positive number before running this request again.";
    case "DEFAULT_ENV_NOT_FOUND":
    case "RUN_ENV_NOT_FOUND":
    case "ENV_NOT_FOUND":
    case "REQUEST_NOT_FOUND":
    case "HEADER_BLOCK_NOT_FOUND":
    case "AUTH_BLOCK_NOT_FOUND":
      return "Create the missing referenced definition or update this reference to an existing one.";
    case "DUPLICATE_STEP_ID":
      return "Rename one of the duplicate step ids so every step id is unique within the run.";
    case "STEP_ID_PATH_COLLISION":
      return "Rename one of these steps so their sanitized artifact paths no longer collide.";
    case "INVALID_STEP_KIND":
    case "INVALID_PARALLEL_CHILD_KIND":
      return "Use a supported step kind for this location or restructure the run.";
    case "INVALID_HEADER_REFERENCES":
      return "Update uses.headers so it is an array of header block ids.";
    case "AUTH_CONFLICT":
      return "Choose either inline auth or uses.auth for this request, not both.";
    case "BODY_FILE_PATH_INVALID":
      return "Update body.file so it points to a real tracked file inside httpi/bodies.";
    case "BODY_FILE_NOT_FOUND":
      return "Create the referenced body file or update body.file to an existing file inside httpi/bodies.";
    case "INVALID_JSON_BODY":
      return "Change body.json so it contains valid JSON-compatible data only.";
    case "INVALID_BODY_KIND":
      return "Choose exactly one body kind supported here: file, json, or text.";
    case "INVALID_AUTH_SCHEME":
      return "Use one of the supported auth schemes here: bearer, basic, or header.";
    case "INVALID_HTTP_METHOD":
      return "Use one of the supported HTTP methods: GET, POST, PUT, PATCH, DELETE, HEAD, or OPTIONS.";
    case "INVALID_CAPTURE":
      return "Set capture to an object that matches the supported capture policy shape.";
    case "INVALID_RESPONSE_BODY_POLICY":
      return "Set capture.responseBody to one of: full, metadata, or none.";
    case "INVALID_REDACT_HEADERS":
      return "Set capture.redactHeaders to an array of header names to redact.";
    case "INVALID_PARALLEL_STEPS":
      return "Set parallel.steps to an array of request child steps.";
    case "INVALID_EXTRACT":
      return "Set extract to an object whose entries define from/required/secret fields.";
    case "INVALID_EXTRACT_ENTRY":
      return "Define this extract entry as an object with at least a string from value.";
    case "INVALID_EXPECT_STATUS":
      return "Set expect.status to a number or an array of numbers.";
    case "INVALID_EXPECT":
      return "Set expect to an object that matches the supported expectation shape.";
    case "INVALID_REQUEST_USES":
      return "Set uses to an object with supported references such as headers and auth.";
    default:
      if (diagnostic.code.startsWith("INVALID_")) {
        if (diagnostic.path) {
          return `Fix ${diagnostic.path} so it matches the supported schema for this definition.`;
        }

        return "Fix this value so it matches the supported schema for this definition.";
      }

      if (diagnostic.path) {
        return `Review ${diagnostic.path} near this location and correct the definition.`;
      }

      return "Review the definition near this location and correct it.";
  }
}
