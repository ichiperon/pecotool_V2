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

// ---------------------------------------------------------------------------
// jsdom ポリフィル: SubtleCrypto (crypto.subtle)
// ---------------------------------------------------------------------------
// jsdom の crypto は getRandomValues/randomUUID は実装するが subtle は未実装。
// pdfFingerprint（#446）が crypto.subtle.digest("SHA-256", ...) を使うため、
// Node 組み込みの webcrypto（実ブラウザと同じ SubtleCrypto 実装）で補う。
// このリポの tsconfig は @types/node を含めていないため、モジュール指定子を
// 変数経由にして静的な型解決（"Cannot find module 'node:crypto'"）を回避する。
if (typeof globalThis.crypto?.subtle === "undefined") {
  const nodeCryptoModuleName = "node:crypto";
  const { webcrypto } = (await import(nodeCryptoModuleName)) as {
    webcrypto: { subtle: SubtleCrypto };
  };
  Object.defineProperty(globalThis.crypto, "subtle", {
    value: webcrypto.subtle,
    configurable: true,
  });
}
