/**
 * PDF バイト列から SHA-256 フィンガープリント（16進文字列）を計算する。
 *
 * 用途: セッション保存/復元（#446 / PCT-210）で「同じパスだが中身が違う PDF」を
 * 誤って復元しない同一性判定。pdfPath だけでは、パスが同じでも別の帳票へ
 * 上書き保存された場合や、別ファイルを同名で用意したケースを区別できない。
 *
 * PDF を開いた（bytes を読み込んだ）タイミングで一度だけ計算し pdfStore に保持する。
 * 巨大 PDF でも複数回ハッシュ計算しない（呼び出し側の責務）。
 */
export async function computePdfFingerprint(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
