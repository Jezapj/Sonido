//! Native live-monitor output.
//!
//! The serial loop pushes the same `chunk_f32` it emits for visuals into a
//! lock-free ring. A dedicated thread owns the `cpal` stream (it is not `Send`
//! on every backend) and plays that ring with a few milliseconds of buffering.
//! Visuals, pitch tracking, and the looper keep using `audio_chunk`.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{BufferSize, FromSample, Sample, SampleFormat, SizedSample, StreamConfig, SupportedBufferSize};
use ringbuf::traits::{Consumer, Observer, Producer, Split};
use ringbuf::{HeapCons, HeapProd, HeapRb};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

/// Steady-state audio kept in the ring before it is played. The serial loop
/// delivers bursts of up to 1024 frames (~21 ms), so this must stay above one
/// burst or the output drains between reads and crackles.
const RING_TARGET_SECS: f32 = 0.030;
/// If the producer gets ahead of this, samples are dropped back to the target.
const RING_MAX_SECS: f32 = 0.120;
/// Smoothing for the fill level used by drift control, so bursty arrivals
/// do not wobble the pitch.
const FILL_SMOOTHING: f32 = 0.02;
/// Largest clock-drift correction applied to the resample ratio.
const DRIFT_NUDGE: f32 = 0.005;
/// Power-of-two ring. ~340 ms at 47991 Hz, well above the drop threshold.
const RING_CAP: usize = 16384;
/// Preferred device period. Falls back to the device default when unsupported.
const PREFERRED_FRAMES: u32 = 256;
/// `raw_buf` in `stream_audio_serial` is 2048 bytes = 1024 i16 frames.
const SERIAL_CHUNK_FRAMES: f32 = 1024.0;

struct Shared {
    enabled: AtomicBool,
    gain_bits: AtomicU32,
    /// Serial chunk + ring target + device buffer, as `f32` bits.
    latency_bits: AtomicU32,
    device_latency_bits: AtomicU32,
    device_latency_valid: AtomicBool,
}

struct StartOk {
    producer: HeapProd<f32>,
    latency: f32,
}

enum Cmd {
    Start { reply: Sender<Result<StartOk, String>> },
    Stop,
    Shutdown,
}

struct Opened {
    stream: cpal::Stream,
    producer: HeapProd<f32>,
    estimate: f32,
}

/// Linear resampler from [`crate::LOOPER_SAMPLE_RATE`] to the device rate.
struct Engine {
    ratio_base: f32,
    step: f32,
    target_fill: usize,
    max_fill: usize,
    avg_fill: f32,
    phase: f32,
    curr: f32,
    next: f32,
    primed: bool,
    started: bool,
}

impl Engine {
    fn new(device_rate: u32) -> Self {
        let src = crate::LOOPER_SAMPLE_RATE;
        let ratio_base = src / device_rate.max(1) as f32;
        Self {
            ratio_base,
            step: ratio_base,
            target_fill: (src * RING_TARGET_SECS) as usize,
            max_fill: (src * RING_MAX_SECS) as usize,
            avg_fill: src * RING_TARGET_SECS,
            phase: 0.0,
            curr: 0.0,
            next: 0.0,
            primed: false,
            started: false,
        }
    }

    fn next_frame(&mut self, cons: &mut HeapCons<f32>) -> f32 {
        if !self.started {
            if cons.occupied_len() < self.target_fill {
                return 0.0;
            }
            self.started = true;
        }

        if !self.primed {
            if cons.occupied_len() < 2 {
                self.started = false;
                return 0.0;
            }
            let mut tmp = [0.0f32; 2];
            if cons.pop_slice(&mut tmp) < 2 {
                self.started = false;
                return 0.0;
            }
            self.curr = tmp[0];
            self.next = tmp[1];
            self.phase = 0.0;
            self.primed = true;
        }

        let out = self.curr + (self.next - self.curr) * self.phase.clamp(0.0, 1.0);
        self.phase += self.step;
        while self.phase >= 1.0 {
            self.phase -= 1.0;
            self.curr = self.next;
            let mut sample = [0.0f32; 1];
            if cons.pop_slice(&mut sample) == 1 {
                self.next = sample[0];
            } else {
                self.primed = false;
                self.started = false;
                self.phase = 0.0;
                break;
            }
        }
        out
    }
}

fn serial_capture_secs() -> f32 {
    SERIAL_CHUNK_FRAMES / crate::LOOPER_SAMPLE_RATE
}

fn record_device_latency(shared: &Shared, info: &cpal::OutputCallbackInfo) {
    let ts = info.timestamp();
    if let Some(delta) = ts.playback.duration_since(&ts.callback) {
        let secs = delta.as_secs_f32();
        if secs.is_finite() && secs > 0.0 && secs < 0.5 {
            shared.device_latency_bits.store(secs.to_bits(), Ordering::Relaxed);
            shared.device_latency_valid.store(true, Ordering::Release);
        }
    }
}

fn prepare_drift(engine: &mut Engine, cons: &mut HeapCons<f32>) {
    let mut fill = cons.occupied_len();
    if fill > engine.max_fill {
        let _ = cons.skip(fill - engine.target_fill);
        fill = cons.occupied_len();
        engine.avg_fill = fill as f32;
    }
    if !engine.started {
        return;
    }
    engine.avg_fill += (fill as f32 - engine.avg_fill) * FILL_SMOOTHING;
    let err = if engine.target_fill > 0 {
        (engine.avg_fill - engine.target_fill as f32) / engine.target_fill as f32
    } else {
        0.0
    };
    engine.step = engine.ratio_base * (1.0 + err.clamp(-1.0, 1.0) * DRIFT_NUDGE);
}

fn write_callback<T>(
    data: &mut [T],
    info: &cpal::OutputCallbackInfo,
    channels: usize,
    engine: &mut Engine,
    cons: &mut HeapCons<f32>,
    shared: &Shared,
) where
    T: Sample + FromSample<f32> + Copy,
{
    record_device_latency(shared, info);
    let enabled = shared.enabled.load(Ordering::Acquire);
    let gain = f32::from_bits(shared.gain_bits.load(Ordering::Relaxed));
    if enabled {
        prepare_drift(engine, cons);
    }
    let channels = channels.max(1);
    for frame in data.chunks_mut(channels) {
        let sample = if enabled {
            T::from_sample(engine.next_frame(cons) * gain)
        } else {
            T::from_sample(0.0)
        };
        for ch in frame.iter_mut() {
            *ch = sample;
        }
    }
}

fn build_stream<T>(
    device: &cpal::Device,
    config: &StreamConfig,
    channels: u16,
    device_rate: u32,
    shared: Arc<Shared>,
) -> Result<(cpal::Stream, HeapProd<f32>), String>
where
    T: SizedSample + FromSample<f32>,
{
    let rb = HeapRb::<f32>::new(RING_CAP);
    let (prod, mut cons) = rb.split();
    let mut engine = Engine::new(device_rate);
    let shared_cb = Arc::clone(&shared);
    let channels = channels as usize;
    let stream = device
        .build_output_stream(
            config,
            move |data: &mut [T], info| {
                write_callback(data, info, channels, &mut engine, &mut cons, &shared_cb);
            },
            |err| eprintln!("[monitor] stream error: {err}"),
            None,
        )
        .map_err(|e| e.to_string())?;
    Ok((stream, prod))
}

fn open_stream(shared: &Arc<Shared>) -> Result<Opened, String> {
    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or_else(|| "no default output device".to_string())?;
    let supported = device.default_output_config().map_err(|e| e.to_string())?;
    let device_rate = supported.sample_rate().0;
    let channels = supported.channels();
    let format = supported.sample_format();
    let min_frames = match supported.buffer_size() {
        SupportedBufferSize::Range { min, .. } => *min,
        SupportedBufferSize::Unknown => 0,
    };

    let mut configs = Vec::new();
    let default_config = supported.config();
    if let SupportedBufferSize::Range { min, max } = *supported.buffer_size() {
        if PREFERRED_FRAMES >= min && PREFERRED_FRAMES <= max {
            let mut fixed = default_config.clone();
            fixed.buffer_size = BufferSize::Fixed(PREFERRED_FRAMES);
            configs.push(fixed);
        }
    }
    configs.push(default_config);

    let mut last_err = "no buffer size attempted".to_string();
    for config in configs {
        let built = match format {
            SampleFormat::F32 => {
                build_stream::<f32>(&device, &config, channels, device_rate, Arc::clone(shared))
            }
            SampleFormat::I16 => {
                build_stream::<i16>(&device, &config, channels, device_rate, Arc::clone(shared))
            }
            SampleFormat::U16 => {
                build_stream::<u16>(&device, &config, channels, device_rate, Arc::clone(shared))
            }
            other => Err(format!("unsupported output sample format {other:?}")),
        };
        match built {
            Ok((stream, producer)) => {
                let frames = match config.buffer_size {
                    BufferSize::Fixed(n) => n,
                    BufferSize::Default => {
                        if min_frames > 0 {
                            min_frames
                        } else {
                            (device_rate / 100).max(1)
                        }
                    }
                };
                let estimate = frames.max(1) as f32 / device_rate.max(1) as f32;
                eprintln!(
                    "[monitor] opened {} Hz, {} ch, {:?} (fallback device latency {:.1} ms)",
                    device_rate,
                    channels,
                    config.buffer_size,
                    estimate * 1000.0
                );
                return Ok(Opened {
                    stream,
                    producer,
                    estimate,
                });
            }
            Err(e) => last_err = e,
        }
    }
    Err(last_err)
}

fn wait_device_latency(shared: &Shared, fallback: f32) -> f32 {
    let start = Instant::now();
    while start.elapsed() < Duration::from_millis(250) {
        if shared.device_latency_valid.load(Ordering::Acquire) {
            return f32::from_bits(shared.device_latency_bits.load(Ordering::Relaxed));
        }
        thread::sleep(Duration::from_millis(5));
    }
    fallback
}

fn audio_thread(rx: Receiver<Cmd>, shared: Arc<Shared>) {
    let mut current: Option<cpal::Stream> = None;
    while let Ok(cmd) = rx.recv() {
        match cmd {
            Cmd::Start { reply } => {
                drop(current.take());
                match open_stream(&shared) {
                    Ok(opened) => {
                        let estimate = opened.estimate;
                        shared.device_latency_valid.store(false, Ordering::Relaxed);
                        if let Err(e) = opened.stream.play() {
                            let _ = reply.send(Err(format!("failed to start output stream: {e}")));
                            continue;
                        }
                        let device_secs = wait_device_latency(&shared, estimate);
                        let total = serial_capture_secs() + RING_TARGET_SECS + device_secs;
                        shared.latency_bits.store(total.to_bits(), Ordering::Relaxed);
                        eprintln!(
                            "[monitor] latency {:.1} ms (device {:.1} ms)",
                            total * 1000.0,
                            device_secs * 1000.0
                        );
                        current = Some(opened.stream);
                        let _ = reply.send(Ok(StartOk {
                            producer: opened.producer,
                            latency: total,
                        }));
                    }
                    Err(e) => {
                        let _ = reply.send(Err(e));
                    }
                }
            }
            Cmd::Stop => {
                drop(current.take());
            }
            Cmd::Shutdown => {
                drop(current.take());
                break;
            }
        }
    }
}

pub struct NativeMonitor {
    shared: Arc<Shared>,
    producer: Mutex<Option<HeapProd<f32>>>,
    cmd_tx: Mutex<Option<Sender<Cmd>>>,
    join: Mutex<Option<JoinHandle<()>>>,
    /// Serializes start/stop so two toggles cannot swap the producer out of order.
    op: Mutex<()>,
    /// Latest request from the UI. Older in-flight toggles are ignored.
    epoch: AtomicU64,
}

impl NativeMonitor {
    pub fn new() -> Self {
        // Matches the UI mix slider default (0.5 → guitar gain 0.5).
        let gain = 0.5f32.to_bits();
        Self {
            shared: Arc::new(Shared {
                enabled: AtomicBool::new(false),
                gain_bits: AtomicU32::new(gain),
                latency_bits: AtomicU32::new(0),
                device_latency_bits: AtomicU32::new(0),
                device_latency_valid: AtomicBool::new(false),
            }),
            producer: Mutex::new(None),
            cmd_tx: Mutex::new(None),
            join: Mutex::new(None),
            op: Mutex::new(()),
            epoch: AtomicU64::new(0),
        }
    }

    /// Record this request if `epoch` is newer than anything already accepted.
    fn publish(&self, epoch: u64) -> bool {
        loop {
            let current = self.epoch.load(Ordering::Acquire);
            if epoch < current {
                return false;
            }
            if self
                .epoch
                .compare_exchange(current, epoch, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                return true;
            }
        }
    }

    fn still_current(&self, epoch: u64) -> bool {
        self.epoch.load(Ordering::Acquire) == epoch
    }

    fn ensure_thread(&self) -> Result<(), String> {
        let mut slot = self.cmd_tx.lock().map_err(|e| e.to_string())?;
        if slot.is_some() {
            return Ok(());
        }
        let (tx, rx) = mpsc::channel();
        let shared = Arc::clone(&self.shared);
        let handle = thread::Builder::new()
            .name("stanza-monitor".into())
            .spawn(move || audio_thread(rx, shared))
            .map_err(|e| e.to_string())?;
        *slot = Some(tx);
        drop(slot);
        *self.join.lock().map_err(|e| e.to_string())? = Some(handle);
        Ok(())
    }

    /// Apply the newest monitor toggle. `on_on` / `on_off` run while the
    /// start/stop lock is still held, so a newer toggle cannot overwrite
    /// overdub latency after this returns.
    pub fn set_enabled(
        &self,
        epoch: u64,
        enabled: bool,
        on_on: impl FnOnce(f32),
        on_off: impl FnOnce(),
    ) -> Result<(), String> {
        if !self.publish(epoch) {
            return Ok(());
        }
        let _op = self.op.lock().map_err(|e| e.to_string())?;
        if !self.still_current(epoch) {
            return Ok(());
        }
        if enabled {
            let latency = self.open_output()?;
            if !self.still_current(epoch) {
                self.stop_locked();
                on_off();
                return Ok(());
            }
            self.shared.enabled.store(true, Ordering::Release);
            on_on(latency);
        } else {
            self.stop_locked();
            on_off();
        }
        Ok(())
    }

    /// Open the device and install the producer, but do not play yet.
    fn open_output(&self) -> Result<f32, String> {
        self.ensure_thread()?;
        self.shared.enabled.store(false, Ordering::Release);
        *self.producer.lock().map_err(|e| e.to_string())? = None;

        let tx = self
            .cmd_tx
            .lock()
            .map_err(|e| e.to_string())?
            .clone()
            .ok_or_else(|| "monitor thread is not running".to_string())?;
        let (reply_tx, reply_rx) = mpsc::channel();
        tx.send(Cmd::Start { reply: reply_tx })
            .map_err(|e| e.to_string())?;
        let started = match reply_rx.recv_timeout(Duration::from_secs(3)) {
            Ok(result) => result?,
            Err(e) => {
                let _ = tx.send(Cmd::Stop);
                return Err(format!("monitor start timed out: {e}"));
            }
        };

        *self.producer.lock().map_err(|e| e.to_string())? = Some(started.producer);
        self.shared
            .latency_bits
            .store(started.latency.to_bits(), Ordering::Relaxed);
        Ok(started.latency)
    }

    fn stop_locked(&self) {
        self.shared.enabled.store(false, Ordering::Release);
        if let Ok(mut prod) = self.producer.lock() {
            *prod = None;
        }
        if let Ok(guard) = self.cmd_tx.lock() {
            if let Some(tx) = guard.as_ref() {
                let _ = tx.send(Cmd::Stop);
            }
        }
    }

    pub fn push(&self, samples: &[f32]) {
        if samples.is_empty() || !self.shared.enabled.load(Ordering::Acquire) {
            return;
        }
        let Ok(mut guard) = self.producer.lock() else { return };
        if let Some(prod) = guard.as_mut() {
            let _ = prod.push_slice(samples);
        }
    }

    pub fn set_gain(&self, gain: f32) {
        let gain = if gain.is_finite() { gain.clamp(0.0, 4.0) } else { 0.0 };
        self.shared.gain_bits.store(gain.to_bits(), Ordering::Relaxed);
    }

    pub fn latency_secs(&self) -> f32 {
        f32::from_bits(self.shared.latency_bits.load(Ordering::Relaxed))
    }
}

impl Drop for NativeMonitor {
    fn drop(&mut self) {
        self.shared.enabled.store(false, Ordering::Release);
        if let Ok(guard) = self.cmd_tx.lock() {
            if let Some(tx) = guard.as_ref() {
                let _ = tx.send(Cmd::Shutdown);
            }
        }
        if let Ok(mut join) = self.join.lock() {
            if let Some(handle) = join.take() {
                let _ = handle.join();
            }
        }
    }
}
