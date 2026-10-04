import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import { App } from "./App";
import { captureInitialPairHash } from "./lib/pair-link";
import { applyStoredTheme } from "./lib/theme";
import "./styles.css";

// Apply the saved theme before mount so there's no flash of the wrong palette.
applyStoredTheme();

// Snapshot the entry fragment BEFORE React/router mounts — the unpaired redirect to
// /pair drops the hash, so a scanned pairing link must be captured here first.
captureInitialPairHash(window.location.hash);

const el = document.getElementById("root")!;
createRoot(el).render(
  <React.StrictMode>
    <BrowserRouter basename="/app">
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
