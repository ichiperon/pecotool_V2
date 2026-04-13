import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { TextPreviewWindow } from "./components/TextPreviewWindow";
import { ThumbnailWindow } from "./components/ThumbnailWindow/ThumbnailWindow";

const hash = window.location.hash;
const root: React.ReactNode = hash === '#preview'
  ? <TextPreviewWindow />
  : hash === '#thumbnails'
  ? <ThumbnailWindow />
  : <App />;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {root}
  </React.StrictMode>,
);
