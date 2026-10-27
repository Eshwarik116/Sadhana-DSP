from __future__ import annotations

import json
import os
from collections import deque
from typing import Optional

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

DEFAULT_ORIGINS = "http://localhost:5173,http://127.0.0.1:5173"


def _allowed_origins() -> list[str]:
    raw = os.environ.get("ALLOWED_ORIGINS", DEFAULT_ORIGINS)
    return [origin.strip() for origin in raw.split(",") if origin.strip()]


app = FastAPI(title="Sadhana", version="0.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

MIN_RMS = 0.006
FRAME_SECONDS = 0.256
ANALYSIS_HOP_SECONDS = 0.043
F0_MIN_HZ = 65.0
F0_MAX_HZ = 1100.0
SPECTRUM_MIN_HZ = 65.0
SPECTRUM_MAX_HZ = 1600.0
SPECTRUM_POINTS = 220
WAVEFORM_POINTS = 160

SWARA_NAMES = [
    "Sa", "Re (komal)", "Re", "Ga (komal)", "Ga", "Ma",
    "Ma (tivra)", "Pa", "Dha (komal)", "Dha", "Ni (komal)", "Ni",
]


def expected_frequency(sa_hz: float, semitones: int) -> float:
    return float(sa_hz * (2.0 ** (semitones / 12.0)))


def cents_error(measured: float, target: float) -> float:
    return float(1200.0 * np.log2(measured / target))


def parabolic_peak(values: np.ndarray, index: int) -> float:
    """Refine a peak location from its neighbours using log-magnitude interpolation."""
    if index <= 0 or index >= len(values) - 1:
        return float(index)
    left, center, right = np.log(np.maximum(values[index - 1:index + 2], 1e-12))
    denominator = left - 2.0 * center + right
    if abs(denominator) < 1e-12:
        return float(index)
    offset = 0.5 * (left - right) / denominator
    return float(index + np.clip(offset, -0.5, 0.5))


def _make_spectrum_payload(freqs: np.ndarray, magnitude: np.ndarray) -> list[dict[str, float]]:
    """Max-pool FFT bins into a compact spectrum while retaining narrow peaks."""
    edges = np.linspace(SPECTRUM_MIN_HZ, SPECTRUM_MAX_HZ, SPECTRUM_POINTS + 1)
    peak_mag = float(np.max(magnitude)) + 1e-12
    output: list[dict[str, float]] = []
    for low, high in zip(edges[:-1], edges[1:]):
        start = int(np.searchsorted(freqs, low, side="left"))
        end = int(np.searchsorted(freqs, high, side="left"))
        if end <= start:
            continue
        local = magnitude[start:end]
        idx = start + int(np.argmax(local))
        db = 20.0 * np.log10((float(magnitude[idx]) + 1e-12) / peak_mag)
        output.append({"frequency": round(float(freqs[idx]), 1), "db": round(float(max(-90.0, db)), 1)})
    return output


def estimate_f0_fft(frame: np.ndarray, sr: int) -> tuple[Optional[float], float, float, list[dict[str, float]], list[float]]:
    """Estimate F0 with Hann-windowed FFT harmonic summation.

    Returns F0, RMS, heuristic confidence, compact FFT spectrum and waveform.
    Confidence is a relative heuristic, not a calibrated probability.
    """
    x = np.asarray(frame, dtype=np.float64)
    if x.size == 0:
        return None, 0.0, 0.0, [], []
    x = x[-max(1, int(sr * FRAME_SECONDS)):]
    if len(x) < int(sr * FRAME_SECONDS):
        x = np.pad(x, (int(sr * FRAME_SECONDS) - len(x), 0))
    x = np.nan_to_num(x, nan=0.0, posinf=0.0, neginf=0.0)
    x = x - np.mean(x)
    rms = float(np.sqrt(np.mean(x * x)))
    waveform = x[::max(1, len(x) // WAVEFORM_POINTS)][:WAVEFORM_POINTS]
    if len(waveform) < WAVEFORM_POINTS:
        waveform = np.pad(waveform, (0, WAVEFORM_POINTS - len(waveform)))
    waveform_scale = float(np.max(np.abs(waveform))) + 1e-12
    waveform_payload = np.round(waveform / waveform_scale, 3).tolist()

    if rms < MIN_RMS:
        return None, rms, 0.0, [], waveform_payload

    # A Hann window limits spectral leakage. Zero-padding interpolates the sampled
    # spectrum; it does not increase the true resolving power of the original frame.
    windowed = x * np.hanning(len(x))
    n_fft = 1 << int(np.ceil(np.log2(max(2, len(windowed) * 4))))
    spectrum = np.abs(np.fft.rfft(windowed, n=n_fft))
    freqs = np.fft.rfftfreq(n_fft, d=1.0 / sr)
    spectrum_payload = _make_spectrum_payload(freqs, spectrum)

    bin_hz = sr / n_fft
    low_bin = max(1, int(np.ceil(F0_MIN_HZ / bin_hz)))
    high_bin = min(len(spectrum) - 2, int(np.floor(min(F0_MAX_HZ, sr * 0.45) / bin_hz)))
    if high_bin <= low_bin:
        return None, rms, 0.0, spectrum_payload, waveform_payload

    # Harmonic summation: energy near f, 2f, 3f... contributes to a candidate.
    # This helps when the fundamental is weak but its upper harmonics are strong.
    candidates = np.arange(low_bin, high_bin + 1, dtype=np.int32)
    scores = np.zeros(candidates.size, dtype=np.float64)
    weight_total = 0.0
    for harmonic in range(1, 8):
        weight = 1.0 / (harmonic ** 0.85)
        positions = candidates * harmonic
        valid = positions < len(spectrum) - 1
        if not np.any(valid):
            break
        p = positions[valid]
        local_peak = np.maximum.reduce((spectrum[p - 1], spectrum[p], spectrum[p + 1]))
        scores[valid] += weight * local_peak
        weight_total += weight
    scores /= max(weight_total, 1e-12)

    best_local = int(np.argmax(scores))
    refined_bin = float(candidates[0] + parabolic_peak(scores, best_local))
    f0 = refined_bin * bin_hz

    # Relative prominence heuristic: compare the winning salience with the typical
    # candidate and with a second candidate outside a small neighbourhood.
    median_score = float(np.median(scores)) + 1e-12
    contrast = float(scores[best_local] / median_score)
    exclusion = max(2, int(round(0.025 * f0 / bin_hz)))
    alternatives = scores.copy()
    alternatives[max(0, best_local - exclusion):min(len(scores), best_local + exclusion + 1)] = 0.0
    second_score = float(np.max(alternatives)) if alternatives.size else 0.0
    separation = float(scores[best_local] / (second_score + 1e-12))
    confidence = float(np.clip((contrast - 1.0) / 8.0, 0.0, 1.0) * np.clip((separation - 1.0) / 0.8, 0.0, 1.0))

    if not np.isfinite(f0) or f0 < F0_MIN_HZ or f0 > min(F0_MAX_HZ, sr * 0.45):
        return None, rms, 0.0, spectrum_payload, waveform_payload
    return float(f0), rms, confidence, spectrum_payload, waveform_payload


def analyze_frame(frame: np.ndarray, sr: int, sa_hz: float, target_semitones: int,
                  tolerance_cents: float) -> dict:
    f0, rms, confidence, spectrum, waveform = estimate_f0_fft(frame, sr)
    common = {
        "rms": round(rms, 5),
        "confidence": round(confidence, 3),
        "spectrum": spectrum,
        "waveform": waveform,
        "sample_rate": sr,
        "frame_ms": round(1000 * FRAME_SECONDS, 1),
        "method": "Hann-windowed FFT + harmonic summation + parabolic interpolation",
    }
    if f0 is None:
        return {
            **common, "voiced": False, "f0": None, "target_hz": round(expected_frequency(sa_hz, target_semitones), 2),
            "status": "waiting", "message": "Sing a steady note closer to the microphone; low-level audio is ignored.",
        }

    target = expected_frequency(sa_hz, target_semitones)
    # Compare pitch class relative to the selected swara, allowing singers to use a
    # lower or higher octave without falsely reporting a full-octave error.
    octave_adjusted_f0 = f0
    while octave_adjusted_f0 / target > np.sqrt(2.0):
        octave_adjusted_f0 /= 2.0
    while octave_adjusted_f0 / target < 1.0 / np.sqrt(2.0):
        octave_adjusted_f0 *= 2.0
    error = cents_error(octave_adjusted_f0, target)

    if confidence < 0.10:
        status = "uncertain"
        message = "Pitch estimate is uncertain. Sustain the note and reduce background noise."
    elif abs(error) <= tolerance_cents:
        status = "in_tune"
        message = "Good match. Keep the note steady."
    elif error < 0:
        status = "flat"
        message = f"{SWARA_NAMES[target_semitones]} is flat by about {abs(error):.0f} cents. Raise the pitch slightly."
    else:
        status = "sharp"
        message = f"{SWARA_NAMES[target_semitones]} is sharp by about {abs(error):.0f} cents. Lower the pitch slightly."

    return {
        **common,
        "voiced": True,
        "f0": round(f0, 2),
        "comparison_f0": round(octave_adjusted_f0, 2),
        "target_hz": round(target, 2),
        "error_cents": round(error, 1),
        "status": status,
        "target_swara": SWARA_NAMES[target_semitones],
        "message": message,
    }


@app.get("/health")
def health():
    return {"status": "ok", "app": "Sadhana", "version": "0.2.0", "analysis": "FFT harmonic summation", "frame_seconds": FRAME_SECONDS}


@app.websocket("/ws/live")
async def live_pitch(websocket: WebSocket):
    await websocket.accept()
    try:
        config = await websocket.receive_json()
        input_sr = int(config.get("sample_rate", 10000))
        sa_hz = float(config.get("sa_hz", 240.0))
        target_semitones = int(config.get("target_semitones", 0))
        tolerance = float(config.get("tolerance_cents", 25.0))

        if not 8000 <= input_sr <= 192000:
            await websocket.send_json({"error": "Audio sample rate must be between 8 kHz and 192 kHz."})
            await websocket.close()
            return
        if not 60 <= sa_hz <= 600:
            await websocket.send_json({"error": "Sa must be between 60 and 600 Hz."})
            await websocket.close()
            return
        if not 0 <= target_semitones <= 11:
            target_semitones = 0
        tolerance = float(np.clip(tolerance, 5.0, 100.0))

        frame_size = max(1024, int(round(input_sr * FRAME_SECONDS)))
        hop_size = max(256, int(round(input_sr * ANALYSIS_HOP_SECONDS)))
        buffer: deque[float] = deque(maxlen=frame_size)
        samples_since_analysis = 0
        recent_errors: deque[float] = deque(maxlen=5)

        while True:
            raw = await websocket.receive_bytes()
            chunk = np.frombuffer(raw, dtype=np.float32)
            if chunk.size == 0:
                continue
            chunk = np.nan_to_num(chunk, nan=0.0, posinf=0.0, neginf=0.0)
            for value in chunk:
                buffer.append(float(value))
            samples_since_analysis += len(chunk)

            if len(buffer) == frame_size and samples_since_analysis >= hop_size:
                samples_since_analysis = 0
                result = analyze_frame(np.fromiter(buffer, dtype=np.float64), input_sr,
                                       sa_hz, target_semitones, tolerance)
                if result.get("voiced") and result.get("confidence", 0.0) >= 0.10:
                    raw_error = float(result["error_cents"])
                    recent_errors.append(raw_error)
                    smoothed_error = float(np.median(np.asarray(recent_errors)))
                    result["raw_error_cents"] = round(raw_error, 1)
                    result["error_cents"] = round(smoothed_error, 1)
                    if abs(smoothed_error) <= tolerance:
                        result["status"] = "in_tune"
                        result["message"] = "Good match. Keep the note steady."
                    elif smoothed_error < 0:
                        result["status"] = "flat"
                        result["message"] = f"{SWARA_NAMES[target_semitones]} is flat by about {abs(smoothed_error):.0f} cents. Raise the pitch slightly."
                    else:
                        result["status"] = "sharp"
                        result["message"] = f"{SWARA_NAMES[target_semitones]} is sharp by about {abs(smoothed_error):.0f} cents. Lower the pitch slightly."
                await websocket.send_text(json.dumps(result, separators=(",", ":")))

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        try:
            await websocket.send_json({"error": f"Audio analysis failed: {str(exc)}"})
        except Exception:
            pass
