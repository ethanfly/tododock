let markdownEditorLoad: Promise<typeof import("../components/MarkdownEditor")> | undefined;

export function preloadMarkdownEditor() {
  markdownEditorLoad ??= import("../components/MarkdownEditor");
  return markdownEditorLoad;
}
