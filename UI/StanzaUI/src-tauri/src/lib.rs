use tauri::Emitter;
use std::io::{Read, Write};
use std::sync::Mutex;
use std::collections::HashMap;
use tauri::Manager;
use tauri::Window;

const LOOPER_SAMPLE_RATE: f32 = 47991.0;

// ── Looper state machine ──────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub enum LooperState {
    Idle,
    Recording,
    Playing,
    Overdubbing,
    Stopped,
}

impl std::fmt::Display for LooperState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self)
    }
}

pub struct LoopBuffer {
    pub state:    LooperState,
    pub samples:  Vec<i16>,
    pub loop_len: usize,
    pub play_pos: usize,
    pub mix:      f32,
    pub feedback: f32,
}

impl Default for LoopBuffer {
    fn default() -> Self {
        Self {
            state:    LooperState::Idle,
            samples:  Vec::new(),
            loop_len: 0,
            play_pos: 0,
            mix:      0.7,
            feedback: 0.9,
        }
    }
}

pub struct LoopState(pub Mutex<LoopBuffer>);

#[derive(Clone, serde::Serialize)]
pub struct LooperInfo {
    pub state:         String,
    pub loop_len_secs: f32,
    pub play_pos_secs: f32,
    pub progress:      f32,
    pub mix:           f32,
    pub feedback:      f32,
}

// ── Shared state ──────────────────────────────────────────────────────────────

pub struct SerialWritePort(pub Mutex<Option<Box<dyn serialport::SerialPort + Send>>>);
pub struct LastParamsStore(pub Mutex<HashMap<u8, (bool, Vec<f32>)>>);

pub struct MuteState {
    pub is_muted:      Mutex<bool>,
    pub saved_pregain: Mutex<f32>,
}

// ── Packet builder ────────────────────────────────────────────────────────────

/// TYPE A — DSP params:  [0xAA][0x55][id][enabled][n][floats…][XOR]
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

/// TYPE B — loop audio for DAC mix: [0xAA][0x56][n][n×int16 LE][XOR]
fn build_loop_audio_packet(samples: &[i16]) -> Vec<u8> {
    let n = samples.len().min(255) as u8;
    let mut pkt: Vec<u8> = vec![0xAA, 0x56, n];
    for &s in &samples[..n as usize] {
        pkt.extend_from_slice(&s.to_le_bytes());
    }
    let checksum: u8 = pkt[2..].iter().fold(0u8, |acc, &b| acc ^ b);
    pkt.push(checksum);
    pkt
}

fn loop_sample_mixed(raw: i16, mix: f32) -> i16 {
    (raw as f32 * mix).clamp(-32768.0, 32767.0) as i16
}

// ── Shared write helper ───────────────────────────────────────────────────────

fn write_packet(app: &tauri::AppHandle, pkt: &[u8]) -> Result<(), String> {
    let state = app.state::<SerialWritePort>();
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    match guard.as_mut() {
        Some(port) => port.write_all(pkt).map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

// ── Loop buffer helpers ───────────────────────────────────────────────────────

/// Advance play_pos by `len` frames, returning those samples as i16.
fn take_playback_chunk(lb: &mut LoopBuffer, len: usize) -> Vec<i16> {
    if lb.loop_len == 0 {
        return vec![0i16; len];
    }
    let mut out = Vec::with_capacity(len);
    for _ in 0..len {
        out.push(lb.samples[lb.play_pos]);
        lb.play_pos = (lb.play_pos + 1) % lb.loop_len;
    }
    out
}

/// Read the next `len` loop samples as normalised f32 WITHOUT advancing play_pos.
/// Used during overdub so the monitor hears a clean live+loop blend with no
/// double-counting of the live signal.
fn peek_loop_chunk(lb: &LoopBuffer, len: usize) -> Vec<f32> {
    if lb.loop_len == 0 {
        return vec![0.0f32; len];
    }
    (0..len)
        .map(|i| lb.samples[(lb.play_pos + i) % lb.loop_len] as f32 / 32767.0)
        .collect()
}

/// Blend `live` into the loop buffer (feedback decay) and advance play_pos.
fn overdub_and_advance(lb: &mut LoopBuffer, live: &[i16]) {
    if lb.loop_len == 0 {
        return;
    }
    let len = live.len().min(lb.loop_len);
    for i in 0..len {
        let blended = lb.samples[lb.play_pos] as f32 * lb.feedback + live[i] as f32;
        lb.samples[lb.play_pos] = blended.clamp(-32768.0, 32767.0) as i16;
        lb.play_pos = (lb.play_pos + 1) % lb.loop_len;
    }
}

fn snapshot(lb: &LoopBuffer) -> LooperInfo {
    let loop_len_secs = lb.loop_len as f32 / LOOPER_SAMPLE_RATE;
    let play_pos_secs = lb.play_pos as f32 / LOOPER_SAMPLE_RATE;
    let progress = if lb.loop_len > 0 {
        lb.play_pos as f32 / lb.loop_len as f32
    } else {
        0.0
    };
    LooperInfo {
        state: lb.state.to_string(),
        loop_len_secs,
        play_pos_secs,
        progress,
        mix:      lb.mix,
        feedback: lb.feedback,
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// Tauri commands — general
// ═════════════════════════════════════════════════════════════════════════════

#[tauri::command]
fn toggle_fullscreen(window: Window) {
    let is_fullscreen = window.is_fullscreen().unwrap();
    window.set_fullscreen(!is_fullscreen).unwrap();
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("{}*STANZA*", name.to_uppercase())
}

#[tauri::command]
fn list_serial_ports() -> Vec<String> {
    serialport::available_ports()
        .unwrap_or_default()
        .into_iter()
        .map(|p| p.port_name)
        .collect()
}

// ═════════════════════════════════════════════════════════════════════════════
// Tauri commands — looper
// ═════════════════════════════════════════════════════════════════════════════

/// Context-sensitive tap:
///   Idle / Stopped → Recording
///   Recording      → Playing
///   Playing        → Overdubbing
///   Overdubbing    → Playing
#[tauri::command]
async fn looper_tap(app: tauri::AppHandle) -> Result<LooperInfo, String> {
    let info;
    {
        let state = app.state::<LoopState>();
        let mut lb = state.0.lock().map_err(|e| e.to_string())?;
        match lb.state {
            LooperState::Idle | LooperState::Stopped => {
                lb.samples.clear();
                lb.loop_len = 0;
                lb.play_pos = 0;
                lb.state    = LooperState::Recording;
            }
            LooperState::Recording => {
                lb.loop_len = lb.samples.len();
                lb.play_pos = 0;
                lb.state    = LooperState::Playing;
            }
            LooperState::Playing => {
                lb.state = LooperState::Overdubbing;
            }
            LooperState::Overdubbing => {
                lb.state = LooperState::Playing;
            }
        }
        info = snapshot(&lb);
    }
    let _ = app.emit("looper_info", info.clone());
    Ok(info)
}

/// Stop playback; keeps the loop in memory.
#[tauri::command]
async fn looper_stop(app: tauri::AppHandle) -> Result<LooperInfo, String> {
    let info;
    {
        let state = app.state::<LoopState>();
        let mut lb = state.0.lock().map_err(|e| e.to_string())?;
        match lb.state {
            LooperState::Playing | LooperState::Overdubbing => {
                lb.state = LooperState::Stopped;
            }
            LooperState::Recording => {
                lb.loop_len = lb.samples.len();
                lb.play_pos = 0;
                lb.state    = LooperState::Stopped;
            }
            _ => {}
        }
        info = snapshot(&lb);
    }
    let _ = app.emit("looper_info", info.clone());
    Ok(info)
}

/// Wipe the loop buffer and return to Idle.
#[tauri::command]
async fn looper_clear(app: tauri::AppHandle) -> Result<LooperInfo, String> {
    let info;
    {
        let state = app.state::<LoopState>();
        let mut lb = state.0.lock().map_err(|e| e.to_string())?;
        let (mix, feedback) = (lb.mix, lb.feedback);
        *lb = LoopBuffer { mix, feedback, ..LoopBuffer::default() };
        info = snapshot(&lb);
    }
    let _ = app.emit("looper_info", info.clone());
    Ok(info)
}

/// Update mix and feedback levels.
#[tauri::command]
async fn set_looper_params(app: tauri::AppHandle, mix: f32, feedback: f32) -> Result<LooperInfo, String> {
    let info;
    {
        let state = app.state::<LoopState>();
        let mut lb = state.0.lock().map_err(|e| e.to_string())?;
        lb.mix      = mix.clamp(0.0, 1.0);
        lb.feedback = feedback.clamp(0.5, 1.0);
        info        = snapshot(&lb);
    }
    Ok(info)
}

/// Snapshot query — called by the overlay on first mount to sync UI state.
#[tauri::command]
async fn get_looper_info(app: tauri::AppHandle) -> Result<LooperInfo, String> {
    let state = app.state::<LoopState>();
    let lb = state.0.lock().map_err(|e| e.to_string())?;
    Ok(snapshot(&lb))
}

// ═════════════════════════════════════════════════════════════════════════════
// Tauri commands — audio streaming
// ═════════════════════════════════════════════════════════════════════════════

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

/// Open a serial port and stream audio.
///
/// Architecture: the ESP32 sends processed audio to the host one-way.
/// The looper buffer lives on the host:
///   - Recording   → append i16 samples to LoopBuffer
///   - Playing     → mix loop into monitor + send TYPE B packets to ESP32 DAC
///   - Overdubbing → peek loop for monitor/DAC, overdub into loop buffer
///
/// Loop playback is sent back as framed TYPE B serial packets (0xAA 0x56)
/// so the ESP32 can mix it into the I2S DAC output alongside live DSP.
#[tauri::command]
async fn stream_audio_serial(app: tauri::AppHandle, port_name: String, baud_rate: u32) {
    {
        let state = app.state::<SerialWritePort>();
        if state.0.lock().unwrap().is_some() {
            return;
        }
    }

    tauri::async_runtime::spawn(async move {
        let mut port = match serialport::new(port_name.clone(), baud_rate)
            .timeout(std::time::Duration::from_millis(2))
            .open()
        {
            Ok(p)  => p,
            Err(e) => { eprintln!("Failed to open {}: {}", port_name, e); return; }
        };

        match port.try_clone() {
            Ok(wc) => { *app.state::<SerialWritePort>().0.lock().unwrap() = Some(wc); }
            Err(e) => { eprintln!("Failed to clone port: {}", e); return; }
        }

        let mut raw_buf:   Vec<u8> = vec![0; 2048];
        let mut info_tick: u32     = 0;

        loop {
            match port.read(raw_buf.as_mut_slice()) {
                Ok(n) => {
                    let mut chunk_f32: Vec<f32> = Vec::with_capacity(n / 2);
                    let mut chunk_i16: Vec<i16> = Vec::with_capacity(n / 2);
                    for i in (0..n).step_by(2) {
                        if i + 1 < n {
                            let s = i16::from_le_bytes([raw_buf[i], raw_buf[i + 1]]);
                            chunk_f32.push(s as f32 / i16::MAX as f32);
                            chunk_i16.push(s);
                        }
                    }
                    if chunk_i16.is_empty() { continue; }

                    // ── Looper: capture, monitor mix, and DAC loop stream ─────────────
                    let mut loop_for_dac: Vec<i16> = Vec::new();
                    {
                        let state = app.state::<LoopState>();
                        let mut lb = state.0.lock().unwrap();
                        match lb.state {
                            LooperState::Recording => {
                                lb.samples.extend_from_slice(&chunk_i16);
                            }
                            LooperState::Playing => {
                                let slice = take_playback_chunk(&mut lb, chunk_i16.len());
                                let mix = lb.mix;
                                loop_for_dac = slice.iter().map(|&s| loop_sample_mixed(s, mix)).collect();
                                for (dst, &s) in chunk_f32.iter_mut().zip(slice.iter()) {
                                    *dst = (*dst + s as f32 / 32767.0 * mix).clamp(-1.0, 1.0);
                                }
                            }
                            LooperState::Overdubbing => {
                                let loop_preview = peek_loop_chunk(&lb, chunk_f32.len());
                                let mix = lb.mix;
                                loop_for_dac = loop_preview
                                    .iter()
                                    .map(|&ls| (ls * 32767.0 * mix).clamp(-32768.0, 32767.0) as i16)
                                    .collect();
                                overdub_and_advance(&mut lb, &chunk_i16);
                                for (dst, &ls) in chunk_f32.iter_mut().zip(loop_preview.iter()) {
                                    *dst = (*dst + ls * mix).clamp(-1.0, 1.0);
                                }
                            }
                            _ => {}
                        }
                    }

                    if !loop_for_dac.is_empty() {
                        let _ = write_packet(&app, &build_loop_audio_packet(&loop_for_dac));
                    }

                    // ── Throttled looper_info event (~10 Hz) ──────────────────────────
                    info_tick += chunk_i16.len() as u32;
                    if info_tick >= 4800 {
                        info_tick = 0;
                        let state = app.state::<LoopState>();
                        let lb    = state.0.lock().unwrap();
                        let info  = snapshot(&lb);
                        drop(lb);
                        let _ = app.emit("looper_info", info);
                    }

                    let _ = app.emit("audio_chunk", &chunk_f32);
                }

                Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {}
                Err(e) => { eprintln!("Serial read error: {}", e); break; }
            }
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }

        *app.state::<SerialWritePort>().0.lock().unwrap() = None;
    });
}

// ═════════════════════════════════════════════════════════════════════════════
// Tauri commands — DSP params + mute
// ═════════════════════════════════════════════════════════════════════════════

#[tauri::command]
async fn update_dsp_params(
    app: tauri::AppHandle,
    pedal_id: u8,
    enabled: bool,
    params: Vec<f32>,
) -> Result<(), String> {
    {
        let store = app.state::<LastParamsStore>();
        let mut g = store.0.lock().map_err(|e| e.to_string())?;
        g.insert(pedal_id, (enabled, params.clone()));
    }
    let mut send_params = params.clone();
    if pedal_id == 0 {
        let ms = app.state::<MuteState>();
        if *ms.is_muted.lock().map_err(|e| e.to_string())? && !send_params.is_empty() {
            *ms.saved_pregain.lock().map_err(|e| e.to_string())? = send_params[0];
            send_params[0] = 0.0;
        }
    }
    write_packet(&app, &build_param_packet(pedal_id, enabled, &send_params))
}

#[tauri::command]
async fn set_output_mute(app: tauri::AppHandle, muted: bool) -> Result<(), String> {
    let store = app.state::<LastParamsStore>();
    let ms    = app.state::<MuteState>();

    let (enabled, mut params) = {
        let g = store.0.lock().map_err(|e| e.to_string())?;
        g.get(&0).cloned().unwrap_or_else(|| (
            true,
            vec![1.0, 0.0, 0.0, -2.0, 80.0, 800.0, 6000.0, 1.0, 1.0, 1.0, 0.95],
        ))
    };

    if muted {
        if !params.is_empty() {
            *ms.saved_pregain.lock().map_err(|e| e.to_string())? = params[0];
            params[0] = 0.0;
        }
        *ms.is_muted.lock().map_err(|e| e.to_string())? = true;
    } else {
        let saved = *ms.saved_pregain.lock().map_err(|e| e.to_string())?;
        if !params.is_empty() { params[0] = if saved > 0.0 { saved } else { 1.0 }; }
        *ms.is_muted.lock().map_err(|e| e.to_string())? = false;
    }

    write_packet(&app, &build_param_packet(0, enabled, &params))
}

// ═════════════════════════════════════════════════════════════════════════════
// App entry point
// ═════════════════════════════════════════════════════════════════════════════

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(SerialWritePort(Mutex::new(None)))
        .manage(LastParamsStore(Mutex::new(HashMap::new())))
        .manage(MuteState {
            is_muted:      Mutex::new(false),
            saved_pregain: Mutex::new(1.0),
        })
        .manage(LoopState(Mutex::new(LoopBuffer::default())))
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            list_serial_ports,
            stream_audio,
            stream_audio_serial,
            update_dsp_params,
            set_output_mute,
            toggle_fullscreen,
            looper_tap,
            looper_stop,
            looper_clear,
            set_looper_params,
            get_looper_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}