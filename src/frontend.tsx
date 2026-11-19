/**
 * This file is the entry point for the React app, it sets up the root
 * element and renders the App component to the DOM.
 *
 * It is included in `src/index.html`.
 */

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

const elem = document.getElementById("root")!;
const app = (
  <StrictMode>
    <App />
  </StrictMode>
);

if (import.meta.hot) {
  // With hot module replacement, reuse the same root across updates.
  const root = (import.meta.hot.data.root ??= createRoot(elem));
  root.render(app);
} else {
  createRoot(elem).render(app);
}
