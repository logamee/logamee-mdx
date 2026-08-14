export async function loadLazyModuleWithRetry<T>(load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    return load();
  }
}
