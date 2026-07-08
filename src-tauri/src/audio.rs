//! WASAPI loopback capture → an 8-float `viz:bands` frame broadcast to the
//! wallpaper windows ("Attune to your music"). One "lorraine-audio" thread opens
//! the default RENDER device in loopback (the wasapi-rs idiom: a render device
//! initialized with `Direction::Render` whose *capture* client is read), keeps a
//! 1024-sample mono window, and ~45 Hz runs a Hann+realfft analysis into
//! bass/mid/high bands (auto-gained so it self-scales to the music), a loudness
//! envelope, and a spectral-flux beat. Robust by construction: any failure stops
//! the thread and emits `viz:source-changed{attuned:false}`, and the wallpaper
//! render loop never depends on this thread existing (it falls back to generative).
#![cfg(windows)]

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::Instant;

use realfft::num_complex::Complex;
use realfft::RealFftPlanner;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::{eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};

/// Below this raw window RMS the signal is treated as silence (no auto-gain
/// amplification of the noise floor). f32 loopback is full-scale ±1.0.
const SILENCE_RMS: f32 = 0.0008;

static CAPTURING: AtomicBool = AtomicBool::new(false);
static SEQ: AtomicU32 = AtomicU32::new(0);

const FFT: usize = 1024;
const SR: usize = 48_000; // we request this format with convert=true, so it holds

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BandFrame {
    bands: [f32; 8],
    loudness: f32,
    beat: bool,
    source: u8,
    seq: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceChanged {
    attuned: bool,
    reason: String,
}

pub fn is_capturing() -> bool {
    CAPTURING.load(Ordering::Relaxed)
}

pub fn stop() {
    CAPTURING.store(false, Ordering::Relaxed);
}

/// Start the loopback capture thread if not already running. Returns immediately;
/// the thread emits `viz:source-changed{attuned:true}` once the stream is live, or
/// `{attuned:false, reason}` if it can't start / when it ends.
pub fn start(app: AppHandle) {
    if CAPTURING.swap(true, Ordering::Relaxed) {
        return; // already running
    }
    let app_thread = app.clone();
    let spawned = std::thread::Builder::new()
        .name("lorraine-audio".into())
        .spawn(move || {
            let result = run_capture(&app_thread);
            CAPTURING.store(false, Ordering::Relaxed);
            let reason = match result {
                Ok(()) => "stopped".to_string(),
                Err(e) => {
                    println!("[lorraine] audio capture error: {e}");
                    e
                }
            };
            let _ = app_thread.emit("viz:source-changed", SourceChanged { attuned: false, reason });
        });
    if spawned.is_err() {
        CAPTURING.store(false, Ordering::Relaxed);
        let _ = app.emit(
            "viz:source-changed",
            SourceChanged { attuned: false, reason: "thread spawn failed".into() },
        );
    }
}

/// The default render endpoint's volume interface, for reading the system mute
/// state (WASAPI loopback keeps delivering audio even when the speakers are muted,
/// so we must check mute explicitly to go calm). None if it can't be obtained.
fn get_endpoint_volume() -> Option<IAudioEndpointVolume> {
    unsafe {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
        let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole).ok()?;
        let vol: IAudioEndpointVolume = device.Activate(CLSCTX_ALL, None).ok()?;
        Some(vol)
    }
}

/// A live loopback stream bundle, kept together so it can be torn down and re-opened on
/// the new default endpoint when Windows' default audio device changes mid-capture.
struct LoopbackStream {
    audio_client: wasapi::AudioClient,
    capture_client: wasapi::AudioCaptureClient,
    h_event: wasapi::Handle,
    block_align: usize,
    device_id: String,
}

/// Open the CURRENT default render endpoint in loopback and start its stream.
fn open_default_loopback() -> Result<LoopbackStream, String> {
    use wasapi::*;
    let device = get_default_device(&Direction::Render).map_err(|e| format!("default device: {e}"))?;
    let device_id = device.get_id().unwrap_or_default(); // endpoint id, to detect a later default change
    let mut audio_client = device.get_iaudioclient().map_err(|e| format!("audio client: {e}"))?;
    // Request f32 stereo @ 48k with conversion enabled — WASAPI resamples the device's mix
    // format to this, so downstream parsing is fixed (8 bytes/frame) across any endpoint.
    let format = WaveFormat::new(32, 32, &SampleType::Float, SR, 2, None);
    let block_align = format.get_blockalign() as usize; // 2ch * 4 bytes = 8
    let (_def_time, min_time) = audio_client.get_periods().map_err(|e| format!("periods: {e}"))?;
    // Loopback: the device is a RENDER endpoint but we request Direction::Capture in Shared
    // mode — wasapi-rs then auto-sets AUDCLNT_STREAMFLAGS_LOOPBACK (+ EVENTCALLBACK).
    // `true` = convert (accept our f32/48k format via resampling).
    audio_client
        .initialize_client(&format, min_time, &Direction::Capture, &ShareMode::Shared, true)
        .map_err(|e| format!("initialize_client (loopback): {e}"))?;
    let h_event = audio_client.set_get_eventhandle().map_err(|e| format!("event handle: {e}"))?;
    let capture_client = audio_client.get_audiocaptureclient().map_err(|e| format!("capture client: {e}"))?;
    audio_client.start_stream().map_err(|e| format!("start_stream: {e}"))?;
    Ok(LoopbackStream { audio_client, capture_client, h_event, block_align, device_id })
}

/// Re-open the default loopback after a device change/invalidation, retrying briefly
/// across the transition window (the new default may take a beat to settle). Aborts
/// immediately if capture was stopped meanwhile.
fn reacquire_loopback() -> Result<LoopbackStream, String> {
    let mut last = String::from("no default render device");
    for _ in 0..12 {
        if !CAPTURING.load(Ordering::Relaxed) {
            return Err("stopped".into());
        }
        match open_default_loopback() {
            Ok(s) => return Ok(s),
            Err(e) => {
                last = e;
                std::thread::sleep(std::time::Duration::from_millis(250));
            }
        }
    }
    Err(last)
}

fn run_capture(app: &AppHandle) -> Result<(), String> {
    use wasapi::*;

    initialize_mta().ok().map_err(|e| format!("COM MTA init: {e}"))?;
    let mut endpoint_vol = get_endpoint_volume();
    // The device/client bundle, re-openable so capture can follow a default-device change.
    let mut stream = open_default_loopback()?;
    let block_align = stream.block_align; // fixed 8 (2ch * 4B); identical across re-acquires
    println!("[lorraine] audio: loopback stream started (block_align={block_align})");

    let _ = app.emit("viz:source-changed", SourceChanged { attuned: true, reason: "attuned".into() });
    let mut logged_first = false;

    // Analysis scratch.
    let hann: Vec<f32> = (0..FFT)
        .map(|i| 0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / (FFT as f32 - 1.0)).cos())
        .collect();
    let mut planner = RealFftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(FFT);
    let mut indata = fft.make_input_vec();
    let mut spectrum = fft.make_output_vec();
    let mut window: VecDeque<f32> = VecDeque::with_capacity(FFT * 2);
    let mut byte_queue: VecDeque<u8> = VecDeque::new();
    let mut prev_mag = vec![0f32; spectrum.len()];

    // Auto-gain peaks + running flux mean (so it self-scales without manual tuning).
    let mut peak = [1e-4f32; 3];
    let mut loud_peak = 1e-4f32;
    let mut flux_mean = 0f32;
    let mut last_beat = Instant::now();
    let mut tempo = 0.35f32; // smoothed pace 0..1 (slow..fast); carried in bands[3]
    let mut last_emit = Instant::now();
    let mut last_dev_check = Instant::now();
    let mut need_reacquire = false;
    let mut prime_flux = false;

    while CAPTURING.load(Ordering::Relaxed) {
        // Follow the default device if the user switches it mid-capture: the old loopback
        // otherwise keeps running on the now-silent old endpoint (no error, just goes flat),
        // or errors if that endpoint was unplugged. Poll the default endpoint id ~1/s; a
        // read error (below) flags a re-acquire too.
        if last_dev_check.elapsed().as_millis() >= 1000 {
            last_dev_check = Instant::now();
            if let Ok(d) = get_default_device(&Direction::Render) {
                if d.get_id().map(|id| id != stream.device_id).unwrap_or(false) {
                    need_reacquire = true;
                }
            }
        }
        if need_reacquire {
            need_reacquire = false;
            let _ = stream.audio_client.stop_stream();
            stream = reacquire_loopback()?; // ends the thread (→ attuned:false) only if no device returns for ~3 s
            endpoint_vol = get_endpoint_volume(); // mute-state source follows the new default
            byte_queue.clear();
            window.clear();
            for m in prev_mag.iter_mut() {
                *m = 0.0;
            }
            prime_flux = true; // first frame's flux is a stale-magnitude jump, not a real onset
            println!("[lorraine] audio: re-acquired default loopback (id={})", stream.device_id);
            continue;
        }

        if stream.h_event.wait_for_event(1000).is_err() {
            continue; // periodic timeout while silent — keep looping until stopped
        }
        if stream
            .capture_client
            .read_from_device_to_deque(&mut byte_queue)
            .is_err()
        {
            need_reacquire = true; // old endpoint invalidated (unplugged) → follow the new default
            continue;
        }

        // Parse f32 stereo frames → mono, into the sliding window.
        while byte_queue.len() >= block_align {
            let mut frame = [0u8; 8];
            for b in frame.iter_mut() {
                *b = byte_queue.pop_front().unwrap();
            }
            let l = f32::from_le_bytes([frame[0], frame[1], frame[2], frame[3]]);
            let r = f32::from_le_bytes([frame[4], frame[5], frame[6], frame[7]]);
            window.push_back((l + r) * 0.5);
        }
        while window.len() > FFT {
            window.pop_front();
        }

        // ~45 Hz analysis + emit.
        if last_emit.elapsed().as_millis() < 22 || window.len() < FFT {
            continue;
        }
        last_emit = Instant::now();

        for (i, s) in window.iter().enumerate() {
            indata[i] = *s * hann[i];
        }
        if fft.process(&mut indata, &mut spectrum).is_err() {
            continue;
        }

        let bin_hz = SR as f32 / FFT as f32;
        let mag = |spec: &[Complex<f32>], lo: f32, hi: f32| -> f32 {
            let a = ((lo / bin_hz).ceil() as usize).max(1);
            let b = ((hi / bin_hz).floor() as usize).min(spec.len() - 1);
            if b < a {
                return 0.0;
            }
            let mut sum = 0.0;
            for s in &spec[a..=b] {
                sum += s.norm();
            }
            sum / (b - a + 1) as f32
        };
        let raw = [
            mag(&spectrum, 20.0, 1500.0),
            mag(&spectrum, 1500.0, 6000.0),
            mag(&spectrum, 6000.0, 15000.0),
        ];

        // Per-band auto-gain → ~0..0.45 to sit in the generative band's visual range.
        let mut bands = [0f32; 8];
        for k in 0..3 {
            peak[k] = (peak[k] * 0.995).max(raw[k]);
            let norm = if peak[k] > 1e-6 { (raw[k] / peak[k]).min(1.0) } else { 0.0 };
            bands[k] = norm * 0.45;
        }

        // Loudness (RMS of the window), auto-gained.
        let rms = (window.iter().map(|s| s * s).sum::<f32>() / window.len() as f32).sqrt();
        loud_peak = (loud_peak * 0.995).max(rms);
        let mut loudness = if loud_peak > 1e-6 { (rms / loud_peak).min(1.0) } else { 0.0 };

        // Go calm on silence (don't auto-gain the noise floor) or system mute
        // (WASAPI loopback keeps delivering audio through the endpoint mute).
        let muted = endpoint_vol
            .as_ref()
            .map_or(false, |v| unsafe { v.GetMute() }.map(|b| b.as_bool()).unwrap_or(false));
        let gated = muted || rms < SILENCE_RMS;

        // Spectral flux onset → beat (adaptive threshold + 220 ms debounce so beats
        // — and the ripples they spawn — stay sparse).
        let mut flux = 0f32;
        for (i, s) in spectrum.iter().enumerate() {
            let m = s.norm();
            let d = m - prev_mag[i];
            if d > 0.0 {
                flux += d;
            }
            prev_mag[i] = m;
        }
        flux_mean = flux_mean * 0.98 + flux * 0.02;
        let mut beat = !gated
            && flux > flux_mean * 1.8
            && flux > 1e-3
            && last_beat.elapsed().as_millis() > 220;
        if prime_flux {
            // First analysis frame after a re-acquire: prev_mag was zeroed, so the flux is
            // a full-magnitude jump, not a real onset — prime it without firing a beat.
            beat = false;
            prime_flux = false;
        }
        if beat {
            // inter-beat interval → an instantaneous pace, eased into `tempo`.
            let interval = last_beat.elapsed().as_millis() as f32;
            last_beat = Instant::now();
            let bpm = (60_000.0 / interval.max(150.0)).clamp(50.0, 200.0);
            let pace = ((bpm - 70.0) / 90.0).clamp(0.0, 1.0);
            tempo = tempo * 0.82 + pace * 0.18;
        }

        if gated {
            bands = [0.0; 8];
            loudness = 0.0;
        }

        // Tempo eases toward calm when beats are sparse/silent; carried in the spare
        // bands[3] slot so the seal's rotation can follow the music's pace (14.2).
        if gated || last_beat.elapsed().as_millis() > 1600 {
            tempo += (0.25 - tempo) * 0.03;
        }
        bands[3] = tempo;

        if !logged_first {
            logged_first = true;
            println!("[lorraine] audio: first frame bands={:?} loud={loudness:.3}", &bands[..3]);
        }
        let frame = BandFrame {
            bands,
            loudness,
            beat,
            source: 1,
            seq: SEQ.fetch_add(1, Ordering::Relaxed),
        };
        let _ = app.emit("viz:bands", frame);
    }

    let _ = stream.audio_client.stop_stream();
    Ok(())
}
