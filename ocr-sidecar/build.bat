@echo off
REM モデルを事前にダウンロード（初回のみ実行）
python -c "from paddleocr import PaddleOCR; PaddleOCR(lang='japan', det=True, rec=True, cls=True)"

REM --onedir でビルド（--onefile は起動コストが高いため不使用）
pyinstaller --onedir --name ocr_engine --distpath ../src-tauri/resources ocr_engine.py

REM モデルをビルド成果物の中にコピー
xcopy /E /I %USERPROFILE%\.paddleocr\whl\det\ml\PP-OCRv3\ch\ch_PP-OCRv3_det_infer ../src-tauri/resources/ocr_engine/models/det/
xcopy /E /I %USERPROFILE%\.paddleocr\whl\rec\japan\japan_PP-OCRv3_rec_infer ../src-tauri/resources/ocr_engine/models/rec_h/
xcopy /E /I %USERPROFILE%\.paddleocr\whl\rec\japan\japan_vert_PP-OCRv3_rec_infer ../src-tauri/resources/ocr_engine/models/rec_v/
xcopy /E /I %USERPROFILE%\.paddleocr\whl\cls\ch_ppocr_mobile_v2.0_cls_infer ../src-tauri/resources/ocr_engine/models/cls/
