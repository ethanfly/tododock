import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import { CreateApp } from "./CreateApp";
import { EditApp } from "./EditApp";
import { SettingsApp } from "./SettingsApp";
import { getWindowView } from "./lib/windowView";
import "./styles.css";

const view = getWindowView();
const windowApp = view === "create"
  ? <CreateApp />
  : view === "settings"
    ? <SettingsApp />
    : view === "edit"
      ? <EditApp />
      : <App />;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {windowApp}
  </StrictMode>,
);

