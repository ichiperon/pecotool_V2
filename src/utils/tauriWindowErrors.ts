export function isTauriWindowNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes('window not found');
}

export function logUnlessTauriWindowNotFound(error: unknown, prefix?: string): void {
  if (isTauriWindowNotFoundError(error)) return;
  if (prefix) {
    console.error(prefix, error);
    return;
  }
  console.error(error);
}
