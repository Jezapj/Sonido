use tauri::Emitter;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("{}*STANZA*", name.to_uppercase())
}

// Kicks off a background task that emits sine-wave chunks forever.
// The frontend just calls invoke("stream_audio") once to start it.
#[tauri::command]
async fn stream_audio(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let sample_rate = 48000.0_f32;
        let chunk_size: u64 = 1024;
        let mut sample_clock: u64 = 0;

        loop {
            // Simulate a 440 Hz sine wave as f32 samples in [-1.0, 1.0]
            let chunk: Vec<f32> = (0..chunk_size)
                .map(|i| {
                    let t = (sample_clock + i) as f32 / sample_rate;
                    (2.0 * std::f32::consts::PI * 82.0 * t).sin() +
                    (2.0 * std::f32::consts::PI * 880.0 * t).sin() * 0.5 + 
                    (2.0 * std::f32::consts::PI * 4500.0 * t).sin() * 0.65
                })
                .collect();

            sample_clock += chunk_size;

            // Emit to all frontend windows; ignore errors if window closed
            let _ = app.emit("audio_chunk", &chunk);

            // ~43 chunks/sec keeps pace with 48000 Hz / 1024 samples
            tokio::time::sleep(std::time::Duration::from_millis(21)).await;
        }
    });
}
use std::io::Read;

#[tauri::command]
async fn stream_audio_serial(app: tauri::AppHandle, port_name: String, baud_rate: u32) {
    tauri::async_runtime::spawn(async move {
        // Open serial port
        let mut port = match serialport::new(port_name.clone(), baud_rate)
            .timeout(std::time::Duration::from_millis(10))
            .open()
        {
            Ok(p) => p,
            Err(e) => {
                eprintln!("Failed to open serial port {}: {}", port_name, e);
                return;
            }
        };

        let mut buffer: Vec<u8> = vec![0; 2048];

        loop {
            match port.read(buffer.as_mut_slice()) {
                Ok(bytes_read) => {
                    // Convert incoming bytes → f32 samples
                    // ASSUMPTION: Arduino sends 16-bit signed PCM (little endian)
                    let mut chunk: Vec<f32> = Vec::with_capacity(bytes_read / 2);

                    for i in (0..bytes_read).step_by(2) {
                        if i + 1 < bytes_read {
                            let sample = i16::from_le_bytes([buffer[i], buffer[i + 1]]);
                            chunk.push(sample as f32 / i16::MAX as f32);
                        }
                    }

                    // Emit to frontend
                    let _ = app.emit("audio_chunk", &chunk);
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {
                    // normal — just no data this cycle
                }
                Err(e) => {
                    eprintln!("Serial read error: {}", e);
                    break;
                }
            }

            // Small delay to avoid busy loop
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // Both commands in one handler — two invoke_handler calls drops the first one
        .invoke_handler(tauri::generate_handler![greet, stream_audio, stream_audio_serial])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}