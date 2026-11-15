import { ThreadId } from "@loop/contracts";
import type {
  PersistedComposerImageAttachment,
  PersistedElementContextDraft,
  PersistedTerminalContextDraft,
} from "./schema";

export function normalizePersistedAttachment(
  value: unknown,
): PersistedComposerImageAttachment | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const id = candidate.id;
  const name = candidate.name;
  const mimeType = candidate.mimeType;
  const sizeBytes = candidate.sizeBytes;
  const dataUrl = candidate.dataUrl;
  if (
    typeof id !== "string" ||
    typeof name !== "string" ||
    typeof mimeType !== "string" ||
    typeof sizeBytes !== "number" ||
    !Number.isFinite(sizeBytes) ||
    typeof dataUrl !== "string" ||
    id.length === 0 ||
    dataUrl.length === 0
  ) {
    return null;
  }
  return {
    id,
    name,
    mimeType,
    sizeBytes,
    dataUrl,
  };
}

function normalizePersistedElementSource(
  sourceCandidate: unknown,
): PersistedElementContextDraft["source"] {
  if (!sourceCandidate || typeof sourceCandidate !== "object") {
    return null;
  }
  const sourceRecord = sourceCandidate as Record<string, unknown>;
  return {
    functionName: typeof sourceRecord.functionName === "string" ? sourceRecord.functionName : null,
    fileName: typeof sourceRecord.fileName === "string" ? sourceRecord.fileName : null,
    lineNumber:
      typeof sourceRecord.lineNumber === "number" && Number.isFinite(sourceRecord.lineNumber)
        ? sourceRecord.lineNumber
        : null,
    columnNumber:
      typeof sourceRecord.columnNumber === "number" && Number.isFinite(sourceRecord.columnNumber)
        ? sourceRecord.columnNumber
        : null,
  };
}

export function normalizePersistedElementContextDraft(
  value: unknown,
): PersistedElementContextDraft | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const id = candidate.id;
  const threadId = candidate.threadId;
  const pickedAt = candidate.pickedAt;
  const pageUrl = candidate.pageUrl;
  const tagName = candidate.tagName;
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    typeof threadId !== "string" ||
    threadId.length === 0 ||
    typeof pickedAt !== "string" ||
    pickedAt.length === 0 ||
    typeof pageUrl !== "string" ||
    pageUrl.length === 0 ||
    typeof tagName !== "string" ||
    tagName.length === 0
  ) {
    return null;
  }
  const source = normalizePersistedElementSource(candidate.source);
  return {
    id,
    threadId: threadId as ThreadId,
    pickedAt,
    pageUrl,
    pageTitle: typeof candidate.pageTitle === "string" ? candidate.pageTitle : null,
    tagName,
    selector: typeof candidate.selector === "string" ? candidate.selector : null,
    htmlPreview: typeof candidate.htmlPreview === "string" ? candidate.htmlPreview : "",
    componentName: typeof candidate.componentName === "string" ? candidate.componentName : null,
    source,
    styles: typeof candidate.styles === "string" ? candidate.styles : "",
  };
}

export function normalizePersistedTerminalContextDraft(
  value: unknown,
): PersistedTerminalContextDraft | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const id = candidate.id;
  const threadId = candidate.threadId;
  const createdAt = candidate.createdAt;
  const lineStart = candidate.lineStart;
  const lineEnd = candidate.lineEnd;
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    typeof threadId !== "string" ||
    threadId.length === 0 ||
    typeof createdAt !== "string" ||
    createdAt.length === 0 ||
    typeof lineStart !== "number" ||
    !Number.isFinite(lineStart) ||
    typeof lineEnd !== "number" ||
    !Number.isFinite(lineEnd)
  ) {
    return null;
  }
  const terminalId = typeof candidate.terminalId === "string" ? candidate.terminalId.trim() : "";
  const terminalLabel =
    typeof candidate.terminalLabel === "string" ? candidate.terminalLabel.trim() : "";
  if (terminalId.length === 0 || terminalLabel.length === 0) {
    return null;
  }
  const normalizedLineStart = Math.max(1, Math.floor(lineStart));
  const normalizedLineEnd = Math.max(normalizedLineStart, Math.floor(lineEnd));
  return {
    id,
    threadId: threadId as ThreadId,
    createdAt,
    terminalId,
    terminalLabel,
    lineStart: normalizedLineStart,
    lineEnd: normalizedLineEnd,
  };
}

