//! std::fs::write のベンチマーク。
//!
//! 実行: `cargo run --release --example bench_write`
//!
//! 約 99MB の PDF を `test/OCR_06_...pdf` から読み込み、
//! 一時ファイル (ユーザのデスクトップ配下) への書き込み時間を計測する。
//! Tauri IPC を経由しないため、ディスク書込み自体の速度だけが計測される。

use std::time::Instant;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let src = r"C:\Users\user\Desktop\workspace20\pecotool_v2\test\OCR_06_昭和59年度長期給付実務研修会資料_マーカー消去テスト_searchable.pdf";

    println!("[bench] reading source: {}", src);
    let t0 = Instant::now();
    let bytes = std::fs::read(src)?;
    let dt_read = t0.elapsed();
    let mb = bytes.len() as f64 / 1024.0 / 1024.0;
    println!("[bench] std::fs::read ({:.1} MB): {:?}", mb, dt_read);

    // Desktop 配下の一時出力先 (ユーザの PDF 保存先と同じディスクを想定)
    let dst = r"C:\Users\user\Desktop\workspace20\pecotool_v2\test\bench_out.pdf";

    for i in 0..3 {
        println!("[bench] write iteration {}/3", i + 1);
        let t = Instant::now();
        std::fs::write(dst, &bytes)?;
        let dt = t.elapsed();
        let mb_per_s = mb / dt.as_secs_f64();
        println!("[bench]   std::fs::write: {:?} ({:.1} MB/s)", dt, mb_per_s);
    }

    // tokio spawn_blocking でも同じことをして差を測る
    let rt = tokio::runtime::Runtime::new()?;
    rt.block_on(async {
        for i in 0..3 {
            println!("[bench] async spawn_blocking write iteration {}/3", i + 1);
            let bytes_clone = bytes.clone();
            let dst_clone = dst.to_string();
            let t = Instant::now();
            tokio::task::spawn_blocking(move || std::fs::write(&dst_clone, &bytes_clone))
                .await
                .unwrap()
                .unwrap();
            let dt = t.elapsed();
            let mb_per_s = mb / dt.as_secs_f64();
            println!(
                "[bench]   spawn_blocking write: {:?} ({:.1} MB/s)",
                dt, mb_per_s
            );
        }
    });

    // 後始末
    std::fs::remove_file(dst).ok();
    println!("[bench] done");
    Ok(())
}
