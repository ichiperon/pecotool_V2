import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import App from "../App";

describe("App", () => {
  it("アプリタイトルを表示する", () => {
    render(<App />);
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent("Peco 帳票ツール");
  });

  it("ステップバーを表示する", () => {
    render(<App />);
    expect(screen.getByRole("navigation", { name: "作業ステップ" })).toBeInTheDocument();
  });

  it("欄テンプレートタブと CSV プレビュータブを表示する", () => {
    render(<App />);
    expect(screen.getByRole("tab", { name: "欄テンプレート" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "CSV プレビュー" })).toBeInTheDocument();
  });

  it("初期状態では欄テンプレートタブが選択されている", () => {
    render(<App />);
    const templateTab = screen.getByRole("tab", { name: "欄テンプレート" });
    expect(templateTab).toHaveAttribute("aria-selected", "true");
  });

  it("フッタにステータスバーを表示する", () => {
    render(<App />);
    expect(screen.getByRole("contentinfo")).toBeInTheDocument();
  });

  it("tablist で ArrowRight を押すと次のタブに移動する", () => {
    render(<App />);
    const templateTab = screen.getByRole("tab", { name: "欄テンプレート" });
    const previewTab = screen.getByRole("tab", { name: "CSV プレビュー" });

    // 初期は欄テンプレートが選択
    expect(templateTab).toHaveAttribute("aria-selected", "true");

    // tablistにArrowRightを送る
    const tablist = screen.getByRole("tablist");
    fireEvent.keyDown(tablist, { key: "ArrowRight" });

    expect(previewTab).toHaveAttribute("aria-selected", "true");
    expect(templateTab).toHaveAttribute("aria-selected", "false");
  });

  it("tablist で ArrowLeft を押すと前のタブに移動する（循環）", () => {
    render(<App />);
    const templateTab = screen.getByRole("tab", { name: "欄テンプレート" });
    const previewTab = screen.getByRole("tab", { name: "CSV プレビュー" });

    const tablist = screen.getByRole("tablist");
    // 先頭タブでArrowLeft → 末尾タブへ循環
    fireEvent.keyDown(tablist, { key: "ArrowLeft" });

    expect(previewTab).toHaveAttribute("aria-selected", "true");
    expect(templateTab).toHaveAttribute("aria-selected", "false");
  });

  it("アクティブタブは tabIndex=0、非アクティブタブは tabIndex=-1", () => {
    render(<App />);
    const templateTab = screen.getByRole("tab", { name: "欄テンプレート" });
    const previewTab = screen.getByRole("tab", { name: "CSV プレビュー" });

    expect(templateTab).toHaveAttribute("tabindex", "0");
    expect(previewTab).toHaveAttribute("tabindex", "-1");
  });
});

// StepBar アクセシビリティテスト
import StepBar from "../components/StepBar";

describe("StepBar", () => {
  it("完了ステップのバッジにスクリーンリーダー向け「完了」が含まれる", () => {
    // activeStep=2 → ステップ1が完了扱い
    render(<StepBar activeStep={2} />);
    // sr-only で「完了」テキストが存在すること
    const srOnlyItems = document.querySelectorAll(".sr-only");
    const hasCompleted = Array.from(srOnlyItems).some((el) => el.textContent === "完了");
    expect(hasCompleted).toBe(true);
  });

  it("完了ステップの視覚的「✓」は aria-hidden になっている", () => {
    render(<StepBar activeStep={2} />);
    const hiddenCheckmarks = document.querySelectorAll('[aria-hidden="true"]');
    const checkmark = Array.from(hiddenCheckmarks).find((el) => el.textContent === "✓");
    expect(checkmark).toBeTruthy();
  });
});
