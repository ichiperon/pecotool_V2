import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { TextPreviewWindow } from "./components/TextPreviewWindow";

const isPreview = window.location.hash === '#preview';

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {isPreview ? <TextPreviewWindow /> : <App />}
  </React.StrictMode>,
);
