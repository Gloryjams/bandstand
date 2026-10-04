import React from "react";
import { createRoot } from "react-dom/client";

import { GuestChart } from "./GuestChart";
import "./guest.css";

// The public app's HTML shell owns the mount point and stamps the token-bearing chart
// URL onto it, so nothing about the share is baked into this bundle. The optional
// attribution and setlist URL come the same way: absent attribute, absent chrome.
const el = document.getElementById("guest-root");
if (el) {
  createRoot(el, {
    // The boundary already shows the guest a dead-link page; React's default console
    // report would only hand a stranger detail about someone else's library.
    onCaughtError: () => {},
  }).render(
    <React.StrictMode>
      <GuestChart
        chartUrl={el.dataset.chartUrl ?? ""}
        attribution={el.dataset.attribution ?? ""}
        setlistUrl={el.dataset.setlistUrl ?? ""}
      />
    </React.StrictMode>,
  );
}
