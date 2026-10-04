import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { GuestRoom } from "./GuestRoom";
import "./room.css";

const root = document.getElementById("room-root");
if (root) createRoot(root).render(<StrictMode><GuestRoom /></StrictMode>);
