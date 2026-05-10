use tauri::Emitter;
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::Manager;
use tauri::Window;

#[tauri::command]
fn toggle_fullscreen(window: Window) {
  let is_fullscreen = window.is_fullscreen().unwrap();
  window.set_fullscreen(!is_fullscreen).unwrap();
}

pub struct SerialWritePort(pub Mutex<Option<Box<dyn serialport::SerialPort + Send>>>);

fn build_param_packet(pedal_id: u8, enabled: bool, params: &[f32]) -> Vec<u8> {
    let n = params.len() as u8;
    let mut pkt: Vec<u8> = vec![0xAA, 0x55, pedal_id, enabled as u8, n];
    for &f in params {
        pkt.extend_from_slice(&f.to_le_bytes());
    }
    let checksum: u8 = pkt[2..].iter().fold(0u8, |acc, &b| acc ^ b);
    pkt.push(checksum);
    pkt
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("{}*STANZA*", name.to_uppercase())
}

/// List all available serial ports on the host machine.
#[tauri::command]
fn list_serial_ports() -> Vec<String> {
    serialport::available_ports()
        .unwrap_or_default()
        .into_iter()
        .map(|p| p.port_name)
        .collect()
}

/// Synthetic audio stream for testing without hardware.
#[tauri::command]
async fn stream_audio(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let sample_rate = 48000.0_f32;
        let chunk_size: u64 = 1024;
        let mut sample_clock: u64 = 0;
        loop {
            let chunk: Vec<f32> = (0..chunk_size)
                .map(|i| {
                    let t = (sample_clock + i) as f32 / sample_rate;
                    (2.0 * std::f32::consts::PI * 82.0 * t).sin()
                        + (2.0 * std::f32::consts::PI * 880.0 * t).sin() * 0.5
                        + (2.0 * std::f32::consts::PI * 4500.0 * t).sin() * 0.65
                })
                .collect();
            sample_clock += chunk_size;
            let _ = app.emit("audio_chunk", &chunk);
            tokio::time::sleep(std::time::Duration::from_millis(21)).await;
        }
    });
}

/// Open a serial port, store a write-clone in shared state, then stream
/// incoming PCM audio as `audio_chunk` events.
///
/// IDEMPOTENT: if a port is already open this returns immediately without
/// opening a second stream. Multiple UI components can safely call this.
#[tauri::command]
async fn stream_audio_serial(app: tauri::AppHandle, port_name: String, baud_rate: u32) {
    {
        let state = app.state::<SerialWritePort>();
        if state.0.lock().unwrap().is_some() {
            return; // already streaming
        }
    }

    tauri::async_runtime::spawn(async move {
        let mut port = match serialport::new(port_name.clone(), baud_rate)
            .timeout(std::time::Duration::from_millis(10))
            .open()
        {
            Ok(p) => p,
            Err(e) => {
                eprintln!("Failed to open {}: {}", port_name, e);
                return;
            }
        };

        match port.try_clone() {
            Ok(write_clone) => {
                let state = app.state::<SerialWritePort>();
                *state.0.lock().unwrap() = Some(write_clone);
            }
            Err(e) => {
                eprintln!("Failed to clone port for write: {}", e);
                return;
            }
        }

        let mut buffer: Vec<u8> = vec![0; 2048];
        loop {
            match port.read(buffer.as_mut_slice()) {
                Ok(bytes_read) => {
                    let mut chunk: Vec<f32> = Vec::with_capacity(bytes_read / 2);
                    for i in (0..bytes_read).step_by(2) {
                        if i + 1 < bytes_read {
                            let sample = i16::from_le_bytes([buffer[i], buffer[i + 1]]);
                            chunk.push(sample as f32 / i16::MAX as f32);
                        }
                    }
                    if !chunk.is_empty() {
                        let _ = app.emit("audio_chunk", &chunk);
                    }
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {}
                Err(e) => {
                    eprintln!("Serial read error: {}", e);
                    break;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }

        let state = app.state::<SerialWritePort>();
        *state.0.lock().unwrap() = None;
    });
}

/// Send a DSP parameter update packet to the ESP32.
/// pedal_id must match a registered slot in pedal_registry.
/// params must be in the same order as the pedal's C param struct fields.
#[tauri::command]
async fn update_dsp_params(
    app: tauri::AppHandle,
    pedal_id: u8,
    enabled: bool,
    params: Vec<f32>,
) -> Result<(), String> {
    let pkt = build_param_packet(pedal_id, enabled, &params);
    let state = app.state::<SerialWritePort>();
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    match guard.as_mut() {
        Some(port) => port.write_all(&pkt).map_err(|e| e.to_string()),
        None => Ok(()), // no port open yet; silently ignore
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(SerialWritePort(Mutex::new(None)))
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            list_serial_ports,
            stream_audio,
            stream_audio_serial,
            update_dsp_params,
            toggle_fullscreen
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}