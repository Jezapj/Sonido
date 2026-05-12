use tauri::Emitter;
use std::io::{Read, Write};
use std::sync::Mutex;
use std::collections::HashMap;
use tauri::Manager;
use tauri::Window;

#[tauri::command]
fn toggle_fullscreen(window: Window) {
  let is_fullscreen = window.is_fullscreen().unwrap();
  window.set_fullscreen(!is_fullscreen).unwrap();
}

// ── Shared serial write port ───────────────────────────────────────────────────
pub struct SerialWritePort(pub Mutex<Option<Box<dyn serialport::SerialPort + Send>>>);

// ── Last-known params per pedal slot ─────────────────────────────────────────
// Populated by update_dsp_params; read by set_output_mute to restore state.
// Key = pedal_id, Value = (enabled, params_vec)
pub struct LastParamsStore(pub Mutex<HashMap<u8, (bool, Vec<f32>)>>);

// ── Mute-state bookkeeping ────────────────────────────────────────────────────
// Tracks whether hardware output is muted and the pre_gain value that was in
// effect before muting so it can be restored accurately on unmute.
pub struct MuteState {
    pub is_muted:     Mutex<bool>,
    pub saved_pregain: Mutex<f32>,
}

// ── Packet builder (unchanged) ────────────────────────────────────────────────
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

// ── Helper: write a packet to the open serial port ───────────────────────────
fn write_packet(app: &tauri::AppHandle, pkt: &[u8]) -> Result<(), String> {
    let state = app.state::<SerialWritePort>();
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    match guard.as_mut() {
        Some(port) => port.write_all(pkt).map_err(|e| e.to_string()),
        None => Ok(()), // No port open — silently ignore
    }
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
/// Stores the params in LastParamsStore so set_output_mute can restore them.
/// pedal_id must match a registered slot in pedal_registry.
/// params must be in the same order as the pedal's C param struct fields.
#[tauri::command]
async fn update_dsp_params(
    app: tauri::AppHandle,
    pedal_id: u8,
    enabled: bool,
    params: Vec<f32>,
) -> Result<(), String> {
    // Persist params for this pedal so set_output_mute can reference them.
    {
        let store = app.state::<LastParamsStore>();
        let mut guard = store.0.lock().map_err(|e| e.to_string())?;
        guard.insert(pedal_id, (enabled, params.clone()));
    }

    // If the hardware is currently muted and this is the EQ pedal (id 0),
    // intercept the packet and zero pre_gain so the mute stays in effect.
    // The full params are still stored above so unmuting restores correctly.
    let mut send_params = params.clone();
    if pedal_id == 0 {
        let mute_state = app.state::<MuteState>();
        let is_muted = *mute_state.is_muted.lock().map_err(|e| e.to_string())?;
        if is_muted && !send_params.is_empty() {
            // Save the caller's pre_gain for later restore, then zero it.
            *mute_state.saved_pregain.lock().map_err(|e| e.to_string())? = send_params[0];
            send_params[0] = 0.0;
        }
    }

    let pkt = build_param_packet(pedal_id, enabled, &send_params);
    write_packet(&app, &pkt)
}

/// Mute or unmute the hardware DAC output by adjusting the pre_gain on the
/// EQ pedal (slot 0 — always registered in the current firmware).
///
/// Mute:   sets pre_gain = 0.0 while preserving all other EQ parameters.
/// Unmute: restores pre_gain to whatever value was in use before muting,
///         falling back to 1.0 if no prior state is known.
///
/// The frontend should call this via `invoke("set_output_mute", { muted })`.
#[tauri::command]
async fn set_output_mute(app: tauri::AppHandle, muted: bool) -> Result<(), String> {
    let store      = app.state::<LastParamsStore>();
    let mute_state = app.state::<MuteState>();

    // Read the last known params for the EQ pedal; fall back to safe defaults
    // (matching pedal_eq_init in the firmware) if no params have been sent yet.
    let (enabled, mut params) = {
        let guard = store.0.lock().map_err(|e| e.to_string())?;
        guard.get(&0).cloned().unwrap_or_else(|| (
            true,
            vec![
                1.0,    // pre_gain
                0.0,    // eq_low_gain_db
                0.0,    // eq_mid_gain_db
               -2.0,    // eq_high_gain_db
               80.0,    // eq_low_freq
              800.0,    // eq_mid_freq
             6000.0,    // eq_high_freq
                1.0,    // eq_low_q
                1.0,    // eq_mid_q
                1.0,    // eq_high_q
                0.95,   // limiter_threshold
            ],
        ))
    };

    if muted {
        // Snapshot the current pre_gain so we can restore it on unmute,
        // then zero it to silence the hardware output.
        if !params.is_empty() {
            *mute_state.saved_pregain.lock().map_err(|e| e.to_string())? = params[0];
            params[0] = 0.0;
        }
        *mute_state.is_muted.lock().map_err(|e| e.to_string())? = true;
    } else {
        // Restore the snapshotted pre_gain (default to 1.0 if never saved).
        let saved = *mute_state.saved_pregain.lock().map_err(|e| e.to_string())?;
        if !params.is_empty() {
            params[0] = if saved > 0.0 { saved } else { 1.0 };
        }
        *mute_state.is_muted.lock().map_err(|e| e.to_string())? = false;
    }

    let pkt = build_param_packet(0, enabled, &params);
    write_packet(&app, &pkt)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(SerialWritePort(Mutex::new(None)))
        .manage(LastParamsStore(Mutex::new(HashMap::new())))
        .manage(MuteState {
            is_muted:      Mutex::new(false),
            saved_pregain: Mutex::new(1.0),
        })
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            list_serial_ports,
            stream_audio,
            stream_audio_serial,
            update_dsp_params,
            set_output_mute,
            toggle_fullscreen
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}