import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { TextPreviewWindow } from "./components/TextPreviewWindow";

const root: React.ReactNode = window.location.hash === '#preview'
  ? <TextPreviewWindow />
  : <App />;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {root}
  </React.StrictMode>,
);
