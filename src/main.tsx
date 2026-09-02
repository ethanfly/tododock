import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import { CreateApp } from "./CreateApp";
import { SettingsApp } from "./SettingsApp";
import { getWindowView } from "./lib/windowView";
import "./styles.css";

const view = getWindowView();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {view === "create" ? <CreateApp /> : view === "settings" ? <SettingsApp /> : <App />}
  </StrictMode>,
);

