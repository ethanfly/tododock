export type WindowView = "main" | "create" | "settings";

export function getWindowView(location: Pick<Location, "hash" | "search"> = window.location): WindowView {
  const hash = location.hash.replace(/^#\/?/, "").split("?")[0];
  if (hash === "create" || hash === "settings") return hash;
  const param = new URLSearchParams(location.search).get("window");
  if (param === "create" || param === "settings") return param;
  return "main";
}
