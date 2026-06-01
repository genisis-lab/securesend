import React from "react";
import ReactDOM from "react-dom/client";
// Import for side effects FIRST: registers the beforeinstallprompt listener at
// module-load time so we never miss Chrome's single early fire of the event.
import "./lib/install-events";
import { App } from "./App";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
