#!/usr/bin/env python3
"""
PecoTool OCR サイドカー
PaddleOCR を使って画像からテキストブロックを検出・認識する。
stdout に JSON を出力し、デバッグログは stderr に出力する。
"""

import argparse
import json
import sys
import os
import traceback

def parse_args():
    parser = argparse.ArgumentParser(description='PecoTool OCR Engine')
    parser.add_argument('--input', required=True, help='入力画像ファイルパス')
    parser.add_argument('--model-dir', required=True, help='モデルディレクトリパス')
    parser.add_argument('--page-width', type=float, required=True, help='ページ幅（viewport scale=1.0）')
    parser.add_argument('--page-height', type=float, required=True, help='ページ高さ（viewport scale=1.0）')
    parser.add_argument('--render-scale', type=float, required=True, help='レンダースケール（例: 2.0）')
    return parser.parse_args()


def compute_iou(box_a, box_b):
    """2つのbboxのIoUを計算する。bbox形式: (x, y, w, h)"""
    ax, ay, aw, ah = box_a
    bx, by, bw, bh = box_b

    inter_x1 = max(ax, bx)
    inter_y1 = max(ay, by)
    inter_x2 = min(ax + aw, bx + bw)
    inter_y2 = min(ay + ah, by + bh)

    inter_w = max(0, inter_x2 - inter_x1)
    inter_h = max(0, inter_y2 - inter_y1)
    inter_area = inter_w * inter_h

    area_a = aw * ah
    area_b = bw * bh
    union_area = area_a + area_b - inter_area

    if union_area <= 0:
        return 0.0
    return inter_area / union_area


def paddle_result_to_blocks(result, render_scale, writing_mode):
    """PaddleOCR の結果を内部ブロック形式 (dict) のリストに変換する。"""
    blocks = []
    if result is None:
        return blocks

    for line in result:
        if line is None:
            continue
        pts, (text, conf) = line
        if not text or not text.strip():
            continue

        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        x = min(xs) / render_scale
        y = min(ys) / render_scale
        width = (max(xs) - min(xs)) / render_scale
        height = (max(ys) - min(ys)) / render_scale

        blocks.append({
            'text': text,
            'bbox': {'x': x, 'y': y, 'width': width, 'height': height},
            'writingMode': writing_mode,
            'confidence': float(conf),
        })

    return blocks


def merge_blocks(h_blocks, v_blocks):
    """
    横書き・縦書きの結果を統合する。
    IoU > 0.5 のペアは信頼度が高い方を採用。
    どちらか片方のみ検出されたブロックはそのまま採用。
    """
    IOU_THRESHOLD = 0.5

    used_v = [False] * len(v_blocks)
    merged = []

    for hb in h_blocks:
        hbox = (hb['bbox']['x'], hb['bbox']['y'], hb['bbox']['width'], hb['bbox']['height'])
        best_iou = 0.0
        best_vi = -1

        for vi, vb in enumerate(v_blocks):
            if used_v[vi]:
                continue
            vbox = (vb['bbox']['x'], vb['bbox']['y'], vb['bbox']['width'], vb['bbox']['height'])
            iou = compute_iou(hbox, vbox)
            if iou > best_iou:
                best_iou = iou
                best_vi = vi

        if best_iou > IOU_THRESHOLD and best_vi >= 0:
            vb = v_blocks[best_vi]
            used_v[best_vi] = True
            # 信頼度が高い方を採用
            winner = hb if hb['confidence'] >= vb['confidence'] else vb
            merged.append(winner)
        else:
            merged.append(hb)

    # 縦書き側で対応するものがなかったブロックを追加
    for vi, vb in enumerate(v_blocks):
        if not used_v[vi]:
            merged.append(vb)

    return merged


def main():
    args = parse_args()

    print(f"[OCR] 開始: {args.input}", file=sys.stderr)

    if not os.path.exists(args.input):
        print(json.dumps({'status': 'error', 'message': f'入力ファイルが見つかりません: {args.input}'}))
        sys.exit(1)

    model_dir = args.model_dir
    det_dir = os.path.join(model_dir, 'det')
    rec_h_dir = os.path.join(model_dir, 'rec_h')
    rec_v_dir = os.path.join(model_dir, 'rec_v')
    cls_dir = os.path.join(model_dir, 'cls')

    try:
        from paddleocr import PaddleOCR

        print("[OCR] 横書きモデル初期化中...", file=sys.stderr)
        ocr_h = PaddleOCR(
            det_model_dir=det_dir,
            rec_model_dir=rec_h_dir,
            cls_model_dir=cls_dir,
            use_angle_cls=True,
            lang='japan',
            use_gpu=False,
            show_log=False,
        )

        print("[OCR] 縦書きモデル初期化中...", file=sys.stderr)
        ocr_v = PaddleOCR(
            det_model_dir=det_dir,
            rec_model_dir=rec_v_dir,
            cls_model_dir=cls_dir,
            use_angle_cls=True,
            lang='japan',
            use_gpu=False,
            show_log=False,
        )

        print("[OCR] 横書きOCR実行中...", file=sys.stderr)
        result_h = ocr_h.ocr(args.input, cls=True)
        h_blocks = paddle_result_to_blocks(
            result_h[0] if result_h else [],
            args.render_scale,
            'horizontal'
        )
        print(f"[OCR] 横書き: {len(h_blocks)} ブロック検出", file=sys.stderr)

        print("[OCR] 縦書きOCR実行中...", file=sys.stderr)
        result_v = ocr_v.ocr(args.input, cls=True)
        v_blocks = paddle_result_to_blocks(
            result_v[0] if result_v else [],
            args.render_scale,
            'vertical'
        )
        print(f"[OCR] 縦書き: {len(v_blocks)} ブロック検出", file=sys.stderr)

        merged = merge_blocks(h_blocks, v_blocks)
        print(f"[OCR] 統合後: {len(merged)} ブロック", file=sys.stderr)

        print(json.dumps({'status': 'ok', 'blocks': merged}, ensure_ascii=False))

    except Exception as e:
        tb = traceback.format_exc()
        print(tb, file=sys.stderr)
        print(json.dumps({'status': 'error', 'message': str(e)}, ensure_ascii=False))
        sys.exit(1)


if __name__ == '__main__':
    main()
