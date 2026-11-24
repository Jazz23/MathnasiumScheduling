// Entry point for the React app, loaded by index.html.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

// A Radius page in the schedule iframe sometimes navigates with a
// root-relative URL ("/Calendar") from script, which lands on this app
// instead of the Radius proxy. Send it on to the proxy.
function framedByThisApp(): boolean {
  try {
    return window.self !== window.top && window.parent.location.origin === location.origin;
  } catch {
    return false; // framed by another site
  }
}
if (framedByThisApp() && !location.pathname.startsWith("/radius/")) {
  location.replace("/radius" + location.pathname + location.search + location.hash);
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
