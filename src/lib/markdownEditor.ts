function escapeInlineText(value: string): string {
  return value.replace(/([\\`*_[\]<>])/g, "\\$1");
}

const PLAIN_TEXT_EDITOR_TAGS = new Set(["DIV", "P", "BR", "SPAN", "FONT"]);

function isPlainEditorElement(element: Element): boolean {
  if (element.tagName === "SPAN" && element.hasAttribute("data-markdown-image-source")) return false;
  return PLAIN_TEXT_EDITOR_TAGS.has(element.tagName);
}

function textWithBreaks(node: Node): string {
  return [...node.childNodes]
    .map((child) => child instanceof HTMLBRElement ? "\n" : child.textContent ?? "")
    .join("");
}

export function plainTextEditorToMarkdown(root: HTMLElement): string | null {
  const elements = [...root.querySelectorAll("*")];
  if (elements.some((element) => !isPlainEditorElement(element))) return null;

  return [...root.childNodes]
    .map((node) => node.nodeType === Node.TEXT_NODE ? node.textContent ?? "" : textWithBreaks(node))
    .join("\n")
    .replace(/\u00a0/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function isLikelyMarkdownSource(value: string): boolean {
  return /(^|\n)\s*(?:#{1,6}\s+|[-+*]\s+(?:\[[ xX]\]\s*)?|>\s+|\d+\.\s+)/.test(value)
    || /(?:^|[^*])\*\*[^*\n]+\*\*/.test(value)
    || /(?:^|[^_])__[^_\n]+__/.test(value)
    || /(?:^|[^*])\*[^*\n]+\*(?!\*)/.test(value)
    || /(?:^|[^_])_[^_\n]+_(?!_)/.test(value)
    || /`[^`\n]+`/.test(value)
    || /!?\[[^\]\n]*\]\([^\s)]+(?:\s+[^)]*)?\)/.test(value)
    || /~~[^~\n]+~~/.test(value)
    || /^\|.+\|\s*$/m.test(value);
}

function inlineMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return escapeInlineText(node.textContent ?? "");
  if (!(node instanceof HTMLElement)) return "";

  const children = () => [...node.childNodes].map(inlineMarkdown).join("");
  switch (node.tagName) {
    case "BR": return "\n";
    case "STRONG":
    case "B": return `**${children()}**`;
    case "EM":
    case "I": return `_${children()}_`;
    case "DEL":
    case "S": return `~~${children()}~~`;
    case "CODE": {
      const content = node.textContent ?? "";
      const fence = content.includes("`") ? "``" : "`";
      return `${fence}${content}${fence}`;
    }
    case "A": {
      const href = node.getAttribute("href") ?? "";
      return href ? `[${children()}](${href.replaceAll(")", "%29")})` : children();
    }
    case "IMG": {
      const source = node.getAttribute("src") ?? "";
      const alt = node.getAttribute("alt") ?? "";
      return source ? `![${escapeInlineText(alt)}](${source.replaceAll(")", "%29")})` : "";
    }
    case "SPAN": {
      const source = node.getAttribute("data-markdown-image-source");
      if (source === null) return children();
      const alt = node.getAttribute("data-markdown-image-alt") ?? "";
      return source ? `![${escapeInlineText(alt)}](${source.replaceAll(")", "%29")})` : "";
    }
    case "INPUT": return "";
    default: return children();
  }
}

function listMarkdown(list: HTMLElement, depth = 0): string {
  const ordered = list.tagName === "OL";
  return [...list.children]
    .filter((child): child is HTMLElement => child instanceof HTMLElement && child.tagName === "LI")
    .map((item, index) => {
      const checkbox = item.querySelector(":scope > input[type='checkbox']") as HTMLInputElement | null;
      const inline = [...item.childNodes]
        .filter((child) => !(child instanceof HTMLElement && ["UL", "OL", "INPUT"].includes(child.tagName)))
        .map(inlineMarkdown)
        .join("")
        .trim();
      const marker = checkbox
        ? `- [${checkbox.checked ? "x" : " "}] `
        : ordered ? `${index + 1}. ` : "- ";
      const indent = "  ".repeat(depth);
      const nested = [...item.children]
        .filter((child): child is HTMLElement => child instanceof HTMLElement && ["UL", "OL"].includes(child.tagName))
        .map((child) => listMarkdown(child, depth + 1))
        .join("\n");
      return `${indent}${marker}${inline}${nested ? `\n${nested}` : ""}`;
    })
    .join("\n");
}

function tableMarkdown(table: HTMLElement): string {
  const rows = [...table.querySelectorAll("tr")].map((row) => (
    [...row.querySelectorAll(":scope > th, :scope > td")]
      .map((cell) => inlineMarkdown(cell).replaceAll("|", "\\|").trim())
  ));
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((row) => row.length), 1);
  const normalize = (row: string[]) => [...row, ...Array<string>(width - row.length).fill("")];
  const header = normalize(rows[0]);
  const body = rows.slice(1).map(normalize);
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...body.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function blockMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return escapeInlineText(node.textContent ?? "");
  if (!(node instanceof HTMLElement)) return "";
  const inline = () => [...node.childNodes].map(inlineMarkdown).join("").trim();
  switch (node.tagName) {
    case "H1": return `# ${inline()}\n\n`;
    case "H2": return `## ${inline()}\n\n`;
    case "H3": return `### ${inline()}\n\n`;
    case "H4": return `#### ${inline()}\n\n`;
    case "H5": return `##### ${inline()}\n\n`;
    case "H6": return `###### ${inline()}\n\n`;
    case "P":
    case "DIV": return `${inline()}\n\n`;
    case "UL":
    case "OL": return `${listMarkdown(node)}\n\n`;
    case "BLOCKQUOTE": {
      const content = [...node.childNodes].map(blockMarkdown).join("").trim();
      return `${content.split("\n").map((line) => `> ${line}`).join("\n")}\n\n`;
    }
    case "PRE": return `\`\`\`\n${node.textContent?.replace(/\n$/, "") ?? ""}\n\`\`\`\n\n`;
    case "TABLE": return `${tableMarkdown(node)}\n\n`;
    case "HR": return "---\n\n";
    default: return `${inlineMarkdown(node)}\n\n`;
  }
}

export function editableElementToMarkdown(root: HTMLElement): string {
  return [...root.childNodes]
    .map(blockMarkdown)
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
