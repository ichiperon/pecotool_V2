import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
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
});
