/**
 * Issue #41: dropTrailingOperand / findNumericOperandStart の境界ケース回帰テスト。
 *
 * - `.3` のようなドット先頭小数 (PDF 仕様 §7.3.3 で valid な数値リテラル) を
 *   correct な offset で drop できること。
 * - 非 numeric な trailing token (オペレータ・文字列・名前) は drop されないこと
 *   (旧実装は delimiter まで丸ごと喰っていた)。
 */
import { describe, it, expect } from 'vitest';
import {
  hasTextOperatorsOutsideTextObjects,
  hasUnbalancedTextBlockBoundary,
  stripTextBlocks,
  stripStrayTextOperatorsOutsideTextObjects,
} from '../../utils/pdfContentStream';

const enc = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
};
const dec = (b: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
};

describe('stripTextBlocks numeric operand drop (#41)', () => {
  it('Tw の単一 operand が `.3` でも正しく drop される', () => {
    // Tw takes 1 operand. `.3 Tw` → `.3` 削除 → Tw も除去
    const input = enc('q\n.3 Tw\n');
    const out = dec(stripTextBlocks(input));
    expect(out).not.toMatch(/\.3/);
    expect(out).not.toContain('Tw');
    expect(out).toContain('q');
  });

  it('`/Foo .3 Tw` のように name + numeric が並ぶと .3 のみ drop、/Foo は残る', () => {
    // findNumericOperandStart は `/` を operand に含めない。Tw は 1 operand を取り、
    // numeric 専用パーサで `.3` を drop。`/Foo` は次の iteration が回らないため残る。
    const input = enc('q\n/Foo .3 Tw\n');
    const out = dec(stripTextBlocks(input));
    expect(out).not.toMatch(/\.3\b/);
    expect(out).not.toContain('Tw');
    // /Foo は preserve される
    expect(out).toContain('/Foo');
  });

  it('text operator の numeric operand を符号付き・小数混在で drop できる', () => {
    // Td takes 2 operands (numerics). `-1.5 +0.3 Td` → 両方 drop → Td 削除
    const input = enc('q\n-1.5 +0.3 Td\n');
    const out = dec(stripTextBlocks(input));
    expect(out).not.toContain('Td');
    expect(out).not.toMatch(/-1\.5/);
    expect(out).not.toMatch(/\+0\.3/);
    expect(out).toContain('q');
  });

  it('numeric ではない trailing token は drop されない (旧実装の暴走を防ぐ)', () => {
    // Tw に対し、operand 位置に non-numeric 識別子 `Foo` が来た場合 (PDF 的には不正だが
    // 念のため): numeric only パーサは `Foo` を operand と見なさず drop しない。
    // 旧実装は delimiter まで丸ごと喰っていたため、ここで `Foo` まで消える誤動作が
    // あった。
    const input = enc('q\nFoo Tw\n');
    const out = dec(stripTextBlocks(input));
    expect(out).not.toContain('Tw');
    expect(out).toContain('Foo');
  });

  it('Tm の 6 operand (整数 + 小数混在) を全て drop する', () => {
    // Tm matrix: a b c d e f Tm. e/f が小数のケース。
    const input = enc('q\n1 0 0 1 12.5 .25 Tm\n');
    const out = dec(stripTextBlocks(input));
    expect(out).not.toContain('Tm');
    expect(out).not.toMatch(/12\.5/);
    expect(out).not.toMatch(/\.25\b/);
    expect(out).toContain('q');
  });

  it('単独 `.` は numeric として drop されない', () => {
    const input = enc('q\n. Tw\n');
    const out = dec(stripTextBlocks(input));
    expect(out).not.toContain('Tw');
    // `.` は残る (numeric として扱われないため)
    expect(out).toContain('.');
  });

  it('`1.2.3` のような複数ドット混入はトークン拒否', () => {
    const input = enc('q\n1.2.3 Tw\n');
    const out = dec(stripTextBlocks(input));
    expect(out).not.toContain('Tw');
    expect(out).toContain('1.2.3');
  });
});

describe('hasTextOperatorsOutsideTextObjects', () => {
  it('BT 外の T*（BT 内限定演算子）を含む列は検出する', () => {
    // PCT-167 補足: この入力は T* (BT内限定) を含むため引き続き損傷。
    // TL/Tf 単独なら合法（下の PCT-167 ケース参照）。
    expect(hasTextOperatorsOutsideTextObjects(enc('q\n14 TL\nT*\n/F1 12 Tf\nQ\n'))).toBe(true);
  });

  it('BT...ET 内の text operators は正常扱いにする', () => {
    expect(hasTextOperatorsOutsideTextObjects(enc('q\nBT\n/F1 12 Tf\n(Hello T*) Tj\nET\nQ\n'))).toBe(false);
  });

  it('文字列リテラル内の ET/T* は誤検出しない', () => {
    expect(hasTextOperatorsOutsideTextObjects(enc('q\nBT\n(Hello ET T*) Tj\nET\nQ\n'))).toBe(false);
  });

  // PCT-167 (#398): text state 演算子 (Tc/Tw/Tz/TL/Tf/Tr/Ts) は BT 外でも合法
  // (PDF 32000-1:2008 §9.3.1)。損傷判定してしまうと sweepNonDirtyPage が
  // 未編集ページの原本テキスト層を strip し、恒久データ損失になる。
  describe('PCT-167: BT 外の text state 演算子は損傷としない', () => {
    it('BT 外の Tf 単独は合法（issue #398 の再現ケース）', () => {
      expect(hasTextOperatorsOutsideTextObjects(enc('/F1 12 Tf\nBT\n(Hello) Tj\nET\n'))).toBe(false);
    });

    it('BT 外の Tc/Tw/Tz/TL/Tr/Ts も合法', () => {
      expect(
        hasTextOperatorsOutsideTextObjects(
          enc('0.5 Tc\n0.5 Tw\n100 Tz\n14 TL\n0 Tr\n1 Ts\nBT\n(Hi) Tj\nET\n'),
        ),
      ).toBe(false);
    });

    it('BT 外の positioning 演算子 (Td/TD/Tm/T*) は引き続き損傷とする', () => {
      expect(hasTextOperatorsOutsideTextObjects(enc('1 0 Td\n'))).toBe(true);
      expect(hasTextOperatorsOutsideTextObjects(enc('1 0 TD\n'))).toBe(true);
      expect(hasTextOperatorsOutsideTextObjects(enc('1 0 0 1 0 0 Tm\n'))).toBe(true);
      expect(hasTextOperatorsOutsideTextObjects(enc('T*\n'))).toBe(true);
    });

    it('BT 外の showing 演算子 (Tj/TJ/\'/"") は引き続き損傷とする', () => {
      expect(hasTextOperatorsOutsideTextObjects(enc('(x) Tj\n'))).toBe(true);
      expect(hasTextOperatorsOutsideTextObjects(enc('[(x)] TJ\n'))).toBe(true);
      expect(hasTextOperatorsOutsideTextObjects(enc("(x) '\n"))).toBe(true);
      expect(hasTextOperatorsOutsideTextObjects(enc('1 1 (x) "\n'))).toBe(true);
    });

    it('孤児 ET は引き続き損傷とする', () => {
      expect(hasTextOperatorsOutsideTextObjects(enc('q\nET\nQ\n'))).toBe(true);
    });

    it('未クローズ BT は引き続き損傷とする（stream 跨ぎの誤判定解消は PCT-177 で別対応）', () => {
      expect(hasTextOperatorsOutsideTextObjects(enc('BT\n(Hello) Tj\n'))).toBe(true);
    });

    it('文字列リテラル内の " Tf " は誤検出しない（状態機械の非退行）', () => {
      expect(hasTextOperatorsOutsideTextObjects(enc('BT\n(set Tf here) Tj\nET\n'))).toBe(false);
    });
  });
});

/**
 * issue #431 点6 (F-ORC-4): copyInlineImage が BI...ID...EI のバイナリ内に
 * 偶発的な delimiter 境界付き "EI" バイト列が現れると誤って早期終了する問題。
 *
 * BI 辞書の /L (または /Length) キーを参照してバイナリ長を確定し、素朴な EI
 * 探索をバイパスすることで回避する。/L が無い、または実データと整合しない
 * 場合は既存の素朴探索へフォールバックする。
 *
 * copyInlineImage は hasTextOperatorsOutsideTextObjects / hasUnbalancedTextBlockBoundary /
 * stripEmptyGraphicsStateBlocks(Only) / stripTextBlocks / stripStrayTextOperatorsOutsideTextObjects
 * の全スキャナで共有されているため、ここでは代表として hasTextOperatorsOutsideTextObjects と
 * hasUnbalancedTextBlockBoundary の双方で修正の効果を確認する。
 */
describe('copyInlineImage: /L (Length) 参照による偶発 EI 誤検出の回避 (#431 点6 / F-ORC-4)', () => {
  // BI 辞書 (/L 12 …) の後、ID の 12 byte バイナリデータ内に
  // delimiter 境界付きの偽 "EI"（誤検出させる罠）と偽 "ET"（早期終了時の症状を可視化する罠）
  // を仕込む。12 byte ちょうど: \x01 \x02 ' EI ' \x03 ' ET ' \x04
  const trapBinary = '\x01\x02 EI \x03 ET \x04';
  const trapLength = trapBinary.length;

  it('前提: trapBinary は 12 byte ちょうど（テストの自己検証）', () => {
    expect(trapLength).toBe(12);
  });

  const buildStream = (biDict: string): string =>
    `q\nBI ${biDict} ID ${trapBinary}\nEI\nQ\n`;

  it('/L ありでバイナリ内の偽 EI を無視し、正しい EI まで一気に確定スキップする（false positive 解消）', () => {
    const input = enc(buildStream(`/L ${trapLength} /W 1 /H 1 /BPC 8 /CS /G`));
    // 修正前: 偽 "EI" で早期終了 → 残りバイナリ中の偽 "ET" が孤児 ET として検出され true になる
    // 修正後: /L 12 により正しい EI まで一気に確定スキップ → 偽 ET は inline image 内部として無視される
    expect(hasTextOperatorsOutsideTextObjects(input)).toBe(false);
    expect(hasUnbalancedTextBlockBoundary(input)).toBe(false);
  });

  it('/L なし（従来挙動）: 偽 EI で早期終了し、残存バイナリの偽 ET を孤児検出する', () => {
    // /L キーが無い場合は declaredLength が確定しないため、既存の素朴な EI 探索のみで動く
    // （回帰確認: 本修正が /L 非対応ケースの挙動を変えていないこと）
    const input = enc(buildStream('/W 1 /H 1 /BPC 8 /CS /G'));
    expect(hasTextOperatorsOutsideTextObjects(input)).toBe(true);
    expect(hasUnbalancedTextBlockBoundary(input)).toBe(true);
  });

  it('/L が実データと整合しない不正値の場合、素朴探索へフォールバックする（従来挙動と同じ結果）', () => {
    // /L 999 は実際のバイナリ長 (12) と一致しないため、fast path の検証に失敗し
    // 素朴探索にフォールバックする。フォールバック先は /L なしケースと同じ挙動になる。
    const input = enc(buildStream('/L 999 /W 1 /H 1 /BPC 8 /CS /G'));
    expect(hasTextOperatorsOutsideTextObjects(input)).toBe(true);
    expect(hasUnbalancedTextBlockBoundary(input)).toBe(true);
  });

  it('/L 値が非数値（不正トークン）の場合も安全にフォールバックする', () => {
    const input = enc(buildStream('/L abc /W 1 /H 1 /BPC 8 /CS /G'));
    expect(hasTextOperatorsOutsideTextObjects(input)).toBe(true);
    expect(hasUnbalancedTextBlockBoundary(input)).toBe(true);
  });

  it('/Length（非省略形）キーでも /L と同様に確定スキップが働く', () => {
    const input = enc(buildStream(`/Length ${trapLength} /W 1 /H 1 /BPC 8 /CS /G`));
    expect(hasTextOperatorsOutsideTextObjects(input)).toBe(false);
    expect(hasUnbalancedTextBlockBoundary(input)).toBe(false);
  });

  it('/L ありのケースで stripTextBlocks がバイナリを一切破壊せず素通りする（BT/ET 罠が inline image 内部として保持される）', () => {
    // stripTextBlocks は top-level の BT...ET のみ除去するため、inline image 内部の
    // 偽 BT/ET まで巻き込んで破壊していないか（境界誤認による損傷）を出力の完全一致で確認する。
    const input = enc(buildStream(`/L ${trapLength} /W 1 /H 1 /BPC 8 /CS /G`));
    const out = stripTextBlocks(input);
    expect(dec(out)).toBe(dec(input));
  });
});

/**
 * M-3 (bug-hunt): stripTextBlocks / stripStrayTextOperatorsOutsideTextObjects の
 * 「BT 内モード」走査（対応する ET を探す内側ループ）には、BI...EI 検出が抜けていた。
 * guard (hasUnbalancedTextBlockBoundary) や各関数の「BT 外」走査は既に BI を認識して
 * スキップしているため、視界が食い違っていた。
 *
 * BT ブロックの中に、宣言長 (/L) の範囲内に delimiter 境界付きの偽 "ET" バイト列を
 * 仕込んだ inline image を置く。修正前は BT 内モードのループがこの偽 ET で早期終了し、
 * 本来の ET より手前で BT スキャンを終わらせてしまう。これにより:
 *  - stripTextBlocks: BT ブロック全体を discard するはずが、早期終了により残りの
 *    バイナリ・本物の EI/ET が「BT 外」の通常トークンとして誤処理され、ET 直後に
 *    続くはずのマーカーの手前にゴミバイトが混入する。
 *  - stripStrayTextOperatorsOutsideTextObjects: BT...ET をバイト等価で温存するはずが、
 *    早期終了後に本物の ET が「BT 外の孤児 ET」として誤って drop され、出力が
 *    入力とバイト不一致になる。
 */
describe('M-3 (bug-hunt): BT 内のインラインイメージに埋め込まれた偽 ET を誤認識しない', () => {
  // 宣言長ちょうど 12 byte のバイナリに、偽 EI と偽 ET を両方仕込む
  // （copyInlineImage の /L fast-forward がバイパスすべき罠であることを明示する）。
  const trapBinary = '\x01\x02 EI \x03 ET \x04';
  const trapLength = trapBinary.length; // 12
  const biDict = `/L ${trapLength} /W 1 /H 1 /BPC 8 /CS /G`;
  // BT 外の非テキスト演算子。両関数の対象外（drop されない）マーカーとして使う。
  const marker = '1 0 0 RG\n';

  const buildBtStream = (): string =>
    `BT\nBI ${biDict} ID ${trapBinary}\nEI\nET\n${marker}`;

  it('前提: trapBinary は 12 byte ちょうど（テストの自己検証）', () => {
    expect(trapLength).toBe(12);
  });

  it('stripTextBlocks: BT ブロック全体が discard され、直後の marker のみが残る', () => {
    const input = enc(buildBtStream());
    const out = dec(stripTextBlocks(input));
    // BT...ET の直後にある改行 1 文字は BT ブロックの外側なので、marker と共にそのまま残る
    // （drop 対象はあくまで BT...ET の中身のみ）。
    // 修正前: 偽 ET で早期終了し、以降の実バイナリ/実 EI がトップレベルの通常バイトとして
    // 誤って出力に混入し、この改行+marker の手前にゴミが残る（out !== '\n' + marker）。
    // 修正後: 本物の EI (/L で確定スキップ) → 本物の ET まで正しく BT 内として認識し、
    // ブロック全体が drop されて改行+marker だけが残る。
    expect(out).toBe(`\n${marker}`);
  });

  it('stripStrayTextOperatorsOutsideTextObjects: BT...ET はバイト等価で温存され、marker も無傷', () => {
    const input = enc(buildBtStream());
    const out = dec(stripStrayTextOperatorsOutsideTextObjects(input));
    // 修正前: 偽 ET で BT 内コピーが早期終了し、本物の ET が「BT 外の孤児 ET」として
    // 誤って drop されるため、出力が入力とバイト不一致になる。
    // 修正後: BI...EI を copyInlineImage でバイト等価コピーし、本物の ET まで正しく
    // BT 内として保持するため、入力全体がバイト等価で温存される。
    expect(out).toBe(dec(input));
  });
});
