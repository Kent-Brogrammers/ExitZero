import "./styles/index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { StudioAppearance } from "./styles/StudioAppearance";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <StudioAppearance>
      <App />
    </StudioAppearance>
  </StrictMode>,
);
