/** "Sample", "samples" or "sample-" as a word in the file or a folder name. */
export function isSamplePath(path: string): boolean {
  return /(^|[^a-z0-9])samples?([^a-z0-9]|$)/i.test(path);
}
