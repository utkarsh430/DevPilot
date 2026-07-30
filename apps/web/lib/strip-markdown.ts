// Reduces a markdown string to plain text for one-line previews (e.g. the
// ticket card's last-comment snippet), where rendering full markdown would
// be overkill but showing literal "## Summary" / "**bold**" / `code` syntax
// reads as broken. Not a markdown parser — just strips the syntax operators
// so the underlying words survive; good enough for a truncated preview, not
// for anything that needs to round-trip or render structure.
export function stripMarkdown(input: string): string {
  return (
    input
      // Fenced code blocks — drop the fence markers, keep the content.
      .replace(/```[^\n]*\n?/g, "")
      // Inline code, bold/italic/strikethrough emphasis markers.
      .replace(/`([^`]*)`/g, "$1")
      .replace(/(\*\*\*|___)([^*_]+)\1/g, "$2")
      .replace(/(\*\*|__)([^*_]+)\1/g, "$2")
      .replace(/(\*|_)([^*_]+)\1/g, "$2")
      .replace(/~~([^~]+)~~/g, "$1")
      // Images and links — keep the alt/link text, drop the URL.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      // Headers, blockquotes, list markers at line start.
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      .replace(/^\s{0,3}>\s?/gm, "")
      .replace(/^\s*([-*+]|\d+\.)\s+/gm, "")
      // Horizontal rules.
      .replace(/^\s*([-*_]\s*){3,}$/gm, "")
      // Collapse to a single line for the preview.
      .replace(/\s+/g, " ")
      .trim()
  );
}
