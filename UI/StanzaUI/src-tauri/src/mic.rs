//! Microphone / line input, as an alternative to the board's serial stream.
//!
//! A dedicated thread owns the `cpal` input stream (it is not `Send` on every
//! backend). The callback takes the first channel, resamples it to
//! [`crate::LOOPER_SAMPLE_RATE`] so the looper, monitor and pitch tracking see
//! the same rate as the serial stream, and hands fixed-size chunks to a worker
//! thread that feeds the shared input path.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SampleFormat, SizedSample, StreamConfig};
use std::sync::mpsc::{self, Receiver, Sender, SyncSender};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

/// ~10.7 ms at 47991 Hz: under the monitor's ring target, so it never drains.
const CHUNK_FRAMES: usize = 512;
/// Chunks queued for the worker before new ones are dropped.
const QUEUE_CHUNKS: usize = 64;

pub struct MicInput {
    stop: Mutex<Option<Sender<()>>>,
}

/// Input device names, the system default first.
pub fn list_inputs() -> Vec<String> {
    let host = cpal::default_host();
    let default = host.default_input_device().and_then(|d| d.name().ok());
    let mut names: Vec<String> = match host.input_devices() {
        Ok(devices) => devices.filter_map(|d| d.name().ok()).collect(),
        Err(e) => {
            eprintln!("[mic] could not list input devices: {e}");
            Vec::new()
        }
    };
    let mut seen = std::collections::HashSet::new();
    names.retain(|n| seen.insert(n.clone()));
    if let Some(def) = default {
        if let Some(i) = names.iter().position(|n| *n == def) {
            let n = names.remove(i);
            names.insert(0, n);
        }
    }
    names
}

impl MicInput {
    pub fn new() -> Self {
        Self { stop: Mutex::new(None) }
    }

    /// Open `name` (or the default input if it has gone) and call `on_chunk`
    /// with each mono chunk at the looper rate. Replaces any running input.
    pub fn start(
        &self,
        name: String,
        mut on_chunk: impl FnMut(Vec<f32>) + Send + 'static,
    ) -> Result<(), String> {
        self.stop();
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
        let (chunk_tx, chunk_rx) = mpsc::sync_channel::<Vec<f32>>(QUEUE_CHUNKS);

        thread::Builder::new()
            .name("stanza-mic".into())
            .spawn(move || run_stream(&name, chunk_tx, ready_tx, stop_rx))
            .map_err(|e| e.to_string())?;

        // Ends by itself once the stream (and with it the sender) is dropped.
        thread::Builder::new()
            .name("stanza-mic-feed".into())
            .spawn(move || {
                for chunk in chunk_rx {
                    on_chunk(chunk);
                }
            })
            .map_err(|e| e.to_string())?;

        match ready_rx.recv_timeout(Duration::from_secs(3)) {
            Ok(Ok(())) => {
                *self.stop.lock().map_err(|e| e.to_string())? = Some(stop_tx);
                Ok(())
            }
            Ok(Err(e)) => Err(e),
            Err(_) => {
                let _ = stop_tx.send(());
                Err("the microphone did not start in time".into())
            }
        }
    }

    pub fn stop(&self) {
        if let Ok(mut slot) = self.stop.lock() {
            if let Some(tx) = slot.take() {
                let _ = tx.send(());
            }
        }
    }
}

impl Drop for MicInput {
    fn drop(&mut self) {
        self.stop();
    }
}

fn run_stream(
    name: &str,
    chunks: SyncSender<Vec<f32>>,
    ready: Sender<Result<(), String>>,
    stop: Receiver<()>,
) {
    match open(name, chunks) {
        Ok(stream) => {
            let _ = ready.send(Ok(()));
            // A stop message or the MicInput going away both end the stream
            let _ = stop.recv();
            drop(stream);
        }
        Err(e) => {
            let _ = ready.send(Err(e));
        }
    }
}

fn open(name: &str, chunks: SyncSender<Vec<f32>>) -> Result<cpal::Stream, String> {
    let host = cpal::default_host();
    let device = host
        .input_devices()
        .ok()
        .and_then(|mut it| it.find(|d| d.name().map(|n| n == name).unwrap_or(false)))
        .or_else(|| host.default_input_device())
        .ok_or_else(|| "no microphone found".to_string())?;
    let supported = device.default_input_config().map_err(|e| e.to_string())?;
    let format = supported.sample_format();
    let config: StreamConfig = supported.into();

    let stream = match format {
        SampleFormat::F32 => build::<f32>(&device, &config, chunks),
        SampleFormat::I16 => build::<i16>(&device, &config, chunks),
        SampleFormat::U16 => build::<u16>(&device, &config, chunks),
        SampleFormat::I32 => build::<i32>(&device, &config, chunks),
        SampleFormat::U8 => build::<u8>(&device, &config, chunks),
        other => return Err(format!("unsupported microphone sample format {other:?}")),
    }?;
    stream.play().map_err(|e| e.to_string())?;
    Ok(stream)
}

fn build<T>(
    device: &cpal::Device,
    config: &StreamConfig,
    chunks: SyncSender<Vec<f32>>,
) -> Result<cpal::Stream, String>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let channels = (config.channels as usize).max(1);
    let mut resampler = Resampler::new(config.sample_rate.0 as f32, crate::LOOPER_SAMPLE_RATE);
    let mut out: Vec<f32> = Vec::with_capacity(CHUNK_FRAMES);
    device
        .build_input_stream(
            config,
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                // First channel only: on an audio interface that is input 1,
                // and averaging in an empty second input would halve the level.
                for frame in data.chunks(channels) {
                    resampler.push(frame[0].to_sample::<f32>(), |y| {
                        out.push(y);
                        if out.len() >= CHUNK_FRAMES {
                            let full = std::mem::replace(&mut out, Vec::with_capacity(CHUNK_FRAMES));
                            let _ = chunks.try_send(full);
                        }
                    });
                }
            },
            |e| eprintln!("[mic] stream error: {e}"),
            None,
        )
        .map_err(|e| e.to_string())
}

/// Streaming linear resampler.
struct Resampler {
    step: f32, // input samples per output sample
    pos: f32,  // where the next output falls between `prev` and the next input
    prev: f32,
}

impl Resampler {
    fn new(from: f32, to: f32) -> Self {
        Self { step: from / to.max(1.0), pos: 0.0, prev: 0.0 }
    }

    fn push(&mut self, x: f32, mut emit: impl FnMut(f32)) {
        while self.pos < 1.0 {
            emit(self.prev + (x - self.prev) * self.pos);
            self.pos += self.step;
        }
        self.pos -= 1.0;
        self.prev = x;
    }
}
