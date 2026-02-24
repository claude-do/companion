import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";
import { initAnalytics } from "./analytics.js";
import { AppErrorBoundary } from "./components/AppErrorBoundary.js";
import "./index.css";

if (import.meta.env.DEV) {
  const titlePrefix = "DEV ";
  if (!document.title.startsWith(titlePrefix)) {
    document.title = `${titlePrefix}${document.title}`;
  }

  const favicon = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  if (favicon) {
    favicon.href = "/favicon-dev.svg";
  }
}

initAnalytics();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>
);
