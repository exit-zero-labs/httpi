const serializedFileOperations = new Map<string, Promise<void>>();

export async function withSerializedFileOperation<TValue>(
  key: string,
  operation: () => Promise<TValue>,
): Promise<TValue> {
  const previous = serializedFileOperations.get(key) ?? Promise.resolve();
  let releaseCurrent: (() => void) | undefined;
  const current = new Promise<void>((resolveCurrent) => {
    releaseCurrent = resolveCurrent;
  });
  const next = previous.catch(() => undefined).then(() => current);
  serializedFileOperations.set(key, next);

  await previous.catch(() => undefined);

  try {
    return await operation();
  } finally {
    releaseCurrent?.();
    void next.finally(() => {
      if (serializedFileOperations.get(key) === next) {
        serializedFileOperations.delete(key);
      }
    });
  }
}
