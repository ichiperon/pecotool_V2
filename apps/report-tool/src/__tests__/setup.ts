import "@testing-library/jest-dom";

// ---------------------------------------------------------------------------
// jsdom ポリフィル: Pointer Events API
// ---------------------------------------------------------------------------
// jsdom は Pointer Events の一部 API を未実装のため、実機動作に影響しない
// 最小限のスタブを設置してテスト中の UnhandledError を防ぐ。

if (typeof document.elementFromPoint !== "function") {
  document.elementFromPoint = () => null;
}

if (typeof Element.prototype.setPointerCapture !== "function") {
  Element.prototype.setPointerCapture = () => undefined;
}

if (typeof Element.prototype.releasePointerCapture !== "function") {
  Element.prototype.releasePointerCapture = () => undefined;
}

if (typeof Element.prototype.hasPointerCapture !== "function") {
  Element.prototype.hasPointerCapture = () => false;
}
