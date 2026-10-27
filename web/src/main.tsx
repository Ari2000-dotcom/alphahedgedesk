import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import "dockview/dist/styles/dockview.css";
import "./theme/tokens.css";
import "./styles.css";
import "./theme/dock.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
