export function docsMarkdownPath(id: string): string | undefined {
  if (id === "docs" || id.startsWith("docs/")) return `/${id}.md`;
}
