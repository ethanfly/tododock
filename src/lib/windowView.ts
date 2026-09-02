export type WindowView = "main" | "create" | "settings" | "edit";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function hashPath(location: Pick<Location, "hash" | "search">): string {
  return location.hash.replace(/^#\/?/, "").split("?")[0];
}

export function getWindowView(location: Pick<Location, "hash" | "search"> = window.location): WindowView {
  const hash = hashPath(location);
  if (hash === "create" || hash === "settings") return hash;
  if (hash === "edit" || hash.startsWith("edit/")) return "edit";
  const param = new URLSearchParams(location.search).get("window");
  if (param === "create" || param === "settings" || param === "edit") return param;
  return "main";
}

export function getEditTodoId(location: Pick<Location, "hash" | "search"> = window.location): string | null {
  const hash = hashPath(location);
  const fromHash = /^edit\/([^/]+)$/.exec(hash)?.[1];
  const fromQuery = new URLSearchParams(location.search).get("id")
    ?? new URLSearchParams(location.hash.split("?")[1] ?? "").get("id");
  const id = fromHash ?? fromQuery;
  if (!id || !uuidPattern.test(id)) return null;
  return id;
}
