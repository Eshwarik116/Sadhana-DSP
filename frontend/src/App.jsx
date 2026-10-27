import React, { useEffect, useRef, useState } from "react";
import {
  Line,
  LineChart,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  Area,
  AreaChart,
} from "recharts";
import {
  classifyPitch,
  getStableSaSuggestion,
  noteNameFromFrequency,
} from "./pitchFeedback.js";

const BACKEND_HOST = import.meta.env.VITE_BACKEND_HOST || "127.0.0.1:8000";

const swaras = [
  { label: "Sa", semitones: 0 },
  { label: "Re (komal)", semitones: 1 },
  { label: "Re", semitones: 2 },
  { label: "Ga (komal)", semitones: 3 },
  { label: "Ga", semitones: 4 },
  { label: "Ma", semitones: 5 },
  { label: "Ma (tivra)", semitones: 6 },
  { label: "Pa", semitones: 7 },
  { label: "Dha (komal)", semitones: 8 },
  { label: "Dha", semitones: 9 },
  { label: "Ni (komal)", semitones: 10 },
  { label: "Ni", semitones: 11 },
];

const MAX_RECONNECT_ATTEMPTS = 8;
const RECONNECT_MAX_DELAY = 15000;

export default function App() {
  const [saHz, setSaHz] = useState(240);
  const [target, setTarget] = useState(0);
  const [tolerance, setTolerance] = useState(25);
  const [running, setRunning] = useState(false);
  const [findingSa, setFindingSa] = useState(false);
  const [saFinderSamples, setSaFinderSamples] = useState(0);
  const [suggestedSaHz, setSuggestedSaHz] = useState(null);
  const [result, setResult] = useState(null);
  const [pitchFeedback, setPitchFeedback] = useState(null);
  const [calculatedCents, setCalculatedCents] = useState(null);
  const [history, setHistory] = useState([]);
  const [error, setError] = useState("");
  const [connState, setConnState] = useState("idle");
  const socketRef = useRef(null);
  const streamRef = useRef(null);
  const audioContextRef = useRef(null);
  const toneContextRef = useRef(null);
  const toneOscillatorRef = useRef(null);
  const processorRef = useRef(null);
  const sequenceRef = useRef(0);
  const configRef = useRef({
    sample_rate: 48000,
    sa_hz: 240,
    target_semitones: 0,
    tolerance_cents: 25,
  });
  const reconnectTimerRef = useRef(null);
  const reconnectAttemptRef = useRef(0);
  const closingRef = useRef(false);
  const pitchCandidateRef = useRef({ state: null, count: 0, stable: "waiting" });
  const findingSaRef = useRef(false);
  const saReadingsRef = useRef([]);

  useEffect(
    () => () => {
      stopMic();
      toneOscillatorRef.current?.stop();
      toneContextRef.current?.close().catch((e) => {
        console.error("Could not close the Sa preview audio context.", e);
      });
    },
    [],
  );

  useEffect(() => {
    configRef.current = {
      ...configRef.current,
      sample_rate:
        audioContextRef.current?.sampleRate ?? configRef.current.sample_rate,
      sa_hz: Number(saHz),
      target_semitones: Number(swaras[target].semitones),
      tolerance_cents: Number(tolerance),
    };
  }, [saHz, target, tolerance]);

  async function startMic() {
    setError("");
    setResult(null);
    setPitchFeedback("waiting");
    setCalculatedCents(null);
    pitchCandidateRef.current = { state: null, count: 0, stable: "waiting" };
    closingRef.current = false;
    reconnectAttemptRef.current = 0;
    setConnState("connecting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      streamRef.current = stream;
      const context = new AudioContext();
      audioContextRef.current = context;
      configRef.current = {
        ...configRef.current,
        sample_rate: context.sampleRate,
      };

      const source = context.createMediaStreamSource(stream);
      // ScriptProcessorNode is deprecated but widely supported for a small prototype.
      // Replace with AudioWorklet for a production low-latency app.
      const processor = context.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;
      processor.onaudioprocess = (event) => {
        const socket = socketRef.current;
        if (!socket || socket.readyState !== WebSocket.OPEN) return;
        const input = event.inputBuffer.getChannelData(0);
        socket.send(input.slice().buffer);
      };
      source.connect(processor);
      processor.connect(context.destination);
      setRunning(true);
      openSocket();
    } catch (e) {
      setError(
        e?.message || "Microphone access failed. Check browser permissions.",
      );
      stopMic();
    }
  }

  function startSaFinder() {
    findingSaRef.current = true;
    saReadingsRef.current = [];
    setFindingSa(true);
    setSaFinderSamples(0);
    setSuggestedSaHz(null);
    startMic();
  }

  function useSuggestedSa() {
    if (suggestedSaHz === null) return;
    setSaHz(suggestedSaHz.toFixed(1));
    stopMic();
  }

  async function playSuggestedSa() {
    if (suggestedSaHz === null) return;
    if (findingSaRef.current) stopMic();
    try {
      if (!toneContextRef.current) {
        toneContextRef.current = new AudioContext();
      }
      const context = toneContextRef.current;
      if (context.state === "suspended") await context.resume();
      toneOscillatorRef.current?.stop();

      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = suggestedSaHz;
      gain.gain.setValueAtTime(0.0001, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.08, context.currentTime + 0.04);
      gain.gain.setValueAtTime(0.08, context.currentTime + 1.15);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 1.3);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.onended = () => {
        if (toneOscillatorRef.current === oscillator) {
          toneOscillatorRef.current = null;
        }
        oscillator.disconnect();
        gain.disconnect();
      };
      toneOscillatorRef.current = oscillator;
      oscillator.start();
      oscillator.stop(context.currentTime + 1.3);
    } catch (e) {
      setError(e?.message || "Could not play the Sa reference tone.");
    }
  }

  function openSocket() {
    const wsProtocol = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${wsProtocol}://${BACKEND_HOST}/ws/live`);
    socketRef.current = socket;
    socket.binaryType = "arraybuffer";

    socket.onopen = () => {
      reconnectAttemptRef.current = 0;
      setConnState("live");
      socket.send(JSON.stringify(configRef.current));
    };

    socket.onmessage = (event) => {
      if (closingRef.current) return;
      const data = JSON.parse(event.data);
      if (data.error) {
        setError(data.error);
        setPitchFeedback("waiting");
        setCalculatedCents(null);
        saReadingsRef.current = [];
        setSaFinderSamples(0);
        setSuggestedSaHz(null);
        pitchCandidateRef.current = {
          state: null,
          count: 0,
          stable: "waiting",
        };
        return;
      }
      setResult(data);
      if (findingSaRef.current) {
        if (
          data.voiced &&
          Number.isFinite(data.f0) &&
          data.f0 >= 60 &&
          data.f0 <= 600 &&
          Number.isFinite(data.confidence) &&
          data.confidence >= 0.1
        ) {
          saReadingsRef.current = [...saReadingsRef.current, data.f0].slice(-31);
        } else {
          saReadingsRef.current = [];
        }
        setSaFinderSamples(saReadingsRef.current.length);
        setSuggestedSaHz(getStableSaSuggestion(saReadingsRef.current));
        return;
      }
      const targetFrequency = Number(
        data.target_hz ??
          Number(configRef.current.sa_hz) *
            2 ** (configRef.current.target_semitones / 12),
      );
      const assessment = data.voiced
        ? classifyPitch(
            data.f0,
            targetFrequency,
            Number(configRef.current.tolerance_cents),
            Number.isFinite(data.confidence) ? data.confidence : 0,
          )
        : { centsDeviation: null, state: "waiting" };

      if (assessment.state === "waiting") {
        setPitchFeedback("waiting");
        setCalculatedCents(null);
        pitchCandidateRef.current = {
          state: null,
          count: 0,
          stable: "waiting",
        };
      } else {
        setCalculatedCents(assessment.centsDeviation);
        const candidate = pitchCandidateRef.current;
        if (assessment.state === candidate.stable) {
          candidate.state = null;
          candidate.count = 0;
        } else {
          if (candidate.state === assessment.state) {
            candidate.count += 1;
          } else {
            candidate.state = assessment.state;
            candidate.count = 1;
          }
          if (candidate.count >= 2) {
            candidate.stable = assessment.state;
            candidate.state = null;
            candidate.count = 0;
            setPitchFeedback(assessment.state);
          }
        }
        const point = {
          t: sequenceRef.current++,
          cents: assessment.centsDeviation,
        };
        setHistory((old) => [...old.slice(-79), point]);
      }
    };

    socket.onerror = () => {};

    socket.onclose = () => {
      if (closingRef.current) return;
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    setPitchFeedback("waiting");
    setCalculatedCents(null);
    if (findingSaRef.current) {
      saReadingsRef.current = [];
      setSaFinderSamples(0);
      setSuggestedSaHz(null);
    }
    pitchCandidateRef.current = { state: null, count: 0, stable: "waiting" };
    const attempt = reconnectAttemptRef.current++;
    if (attempt >= MAX_RECONNECT_ATTEMPTS) {
      setConnState("failed");
      setError(
        `Lost the connection to the DSP backend at ${BACKEND_HOST}. The service may be asleep or restarting.`,
      );
      return;
    }
    setConnState("reconnecting");
    const delay =
      Math.min(1000 * 2 ** attempt, RECONNECT_MAX_DELAY) + Math.random() * 500;
    reconnectTimerRef.current = setTimeout(() => {
      if (closingRef.current) return;
      setConnState("connecting");
      openSocket();
    }, delay);
  }

  function retryConnection() {
    setError("");
    setPitchFeedback("waiting");
    setCalculatedCents(null);
    pitchCandidateRef.current = { state: null, count: 0, stable: "waiting" };
    reconnectAttemptRef.current = 0;
    setConnState("connecting");
    openSocket();
  }

  function stopMic() {
    closingRef.current = true;
    findingSaRef.current = false;
    saReadingsRef.current = [];
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    try {
      processorRef.current?.disconnect();
    } catch {}
    processorRef.current = null;
    try {
      socketRef.current?.close();
    } catch {}
    socketRef.current = null;
    try {
      streamRef.current?.getTracks().forEach((track) => track.stop());
    } catch {}
    streamRef.current = null;
    try {
      audioContextRef.current?.close();
    } catch {}
    audioContextRef.current = null;
    setRunning(false);
    setFindingSa(false);
    setSaFinderSamples(0);
    setPitchFeedback(null);
    setCalculatedCents(null);
    pitchCandidateRef.current = { state: null, count: 0, stable: "waiting" };
    setConnState("idle");
  }

  const status =
    running && pitchFeedback && pitchFeedback !== "waiting"
      ? { correct: "in_tune", low: "flat", high: "sharp" }[pitchFeedback]
      : "waiting";
  const targetHz = Number(
    result?.target_hz ?? Number(saHz) * 2 ** (swaras[target].semitones / 12),
  );
  const spectrumData = result?.spectrum || [];
  const waveformData = (result?.waveform || []).map((amplitude, i) => ({
    sample: i,
    amplitude,
  }));
  const statusLabel =
    {
      in_tune: "In tune",
      flat: "Flat",
      sharp: "Sharp",
      uncertain: "Low confidence",
      waiting: "Waiting for voice",
    }[status] || status;
  const connLabel =
    {
      idle: "Stopped",
      connecting: "Connecting",
      live: "Listening",
      reconnecting: "Reconnecting",
      failed: "Disconnected",
    }[connState] || "Stopped";
  const f0Text = result?.f0 != null ? Number(result.f0).toFixed(1) : null;
  const [f0Whole, f0Frac] = f0Text ? f0Text.split(".") : [null, null];
  const deviationClass =
    calculatedCents == null
      ? ""
      : calculatedCents < -tolerance
        ? "flat-text"
        : calculatedCents > tolerance
          ? "sharp-text"
          : "";
  const feedbackContent = {
    correct: {
      icon: "✓",
      label: "IN TUNE",
      message: "Perfect pitch — you're on the right note!",
    },
    low: {
      icon: "↓",
      label: "TOO LOW · FLAT",
      message: "Raise your voice slightly.",
    },
    high: {
      icon: "↑",
      label: "TOO HIGH · SHARP",
      message: "Lower your voice slightly.",
    },
    waiting: {
      icon: "♪",
      label: "LISTENING",
      message: "Waiting for a stable pitch…",
    },
  };
  const visibleFeedback = running
    ? feedbackContent[pitchFeedback || "waiting"]
    : null;
  const isSuggestedSaSelected =
    suggestedSaHz !== null && Number(saHz) === suggestedSaHz;

  return (
    <main className="page">
      <header className="topbar">
        <div className="brandmark">सा</div>
        <div>
          <div className="eyebrow">REAL-TIME MUSIC COACH</div>
          <h1>Sadhana</h1>
        </div>
        <div
          className={`live-pill ${running ? "active" : ""} ${
            connState === "reconnecting" || connState === "failed" ? "warn" : ""
          }`}
        >
          <span />
          {running ? connLabel : "Stopped"}
        </div>
      </header>

      <section className="intro">
        <div>
          <p className="eyebrow">INDIAN CLASSICAL · PITCH PRACTICE</p>
          <h2>
            Find your sur.
            <br />
            <span>Refine every swara.</span>
          </h2>
          <p className="subtext">
            Live pitch feedback powered by FFT-based digital signal processing.
            Your voice is analyzed, never pitch-corrected.
          </p>
        </div>
        <div className="wave-art" aria-hidden="true">
          {Array.from({ length: 25 }, (_, i) => (
            <i
              key={i}
              style={{
                height: `${18 + Math.abs(Math.sin(i * 0.65)) * (28 + (i % 5) * 8)}px`,
              }}
            />
          ))}
        </div>
      </section>

      <section className="controls card">
        <div className="section-heading">
          <div>
            <p className="eyebrow">01 / SET YOUR REFERENCE</p>
            <h3>Practice settings</h3>
          </div>
          <span className="tag">Tuning setup</span>
        </div>
        <div className="settings-grid">
          <label>
            Reference Sa <span className="unit">Hz</span>
            <input
              type="number"
              min="60"
              max="600"
              step="0.1"
              value={saHz}
              disabled={running}
              onChange={(e) => setSaHz(e.target.value)}
            />
            <small>Your personal starting note for practice.</small>
          </label>
          <label>
            Target swara
            <select
              value={target}
              disabled={running}
              onChange={(e) => setTarget(Number(e.target.value))}>
              {swaras.map((s, i) => (
                <option value={i} key={s.label}>
                  {s.label}
                </option>
              ))}
            </select>
            <small>Sing and sustain this swara.</small>
          </label>
          <label>
            Tuning tolerance <span className="unit">± cents</span>
            <select
              value={tolerance}
              disabled={running}
              onChange={(e) => setTolerance(Number(e.target.value))}>
              <option value="15">15 cents (strict)</option>
              <option value="25">25 cents (balanced)</option>
              <option value="40">40 cents (beginner)</option>
            </select>
            <small>Intonation varies by raga and style.</small>
          </label>
        </div>
        <div className="sa-finder">
          <div className="sa-finder-copy">
            <strong>Not sure what Sa to choose?</strong>
            <span>
              Hum a comfortable, steady note. We’ll listen and suggest a
              starting pitch—no male/female range selection needed.
            </span>
          </div>
          <button
            className={findingSa ? "stop-btn" : "sa-find-btn"}
            onClick={findingSa ? stopMic : startSaFinder}
            disabled={running && !findingSa}>
            {findingSa
              ? "■ Stop listening"
              : running
                ? "Stop session to find Sa"
                : "♪ Find my comfortable Sa"}
          </button>
        </div>
        {(findingSa || suggestedSaHz !== null) && (
          <div
            className={`sa-finder-result ${suggestedSaHz !== null ? "ready" : ""}`}
            role="status"
            aria-live="polite">
            {suggestedSaHz === null ? (
              <>
                <strong>Listening for your note…</strong>
                <span>
                  Keep humming comfortably and steadily. Stable readings:{" "}
                  {saFinderSamples}/24
                </span>
              </>
            ) : (
              <>
                <div className="sa-suggestion-copy">
                  <strong>
                    Suggested Sa: {suggestedSaHz.toFixed(1)} Hz
                    {noteNameFromFrequency(suggestedSaHz)
                      ? ` · near ${noteNameFromFrequency(suggestedSaHz)}`
                      : ""}
                  </strong>
                  <span>
                    Try the reference tone and keep this pitch only if it feels
                    comfortable for you.
                  </span>
                </div>
                <div className="sa-suggestion-actions">
                  <button className="sa-preview-btn" onClick={playSuggestedSa}>
                    ▶ Hear reference
                  </button>
                  <button
                    className="primary-btn"
                    onClick={useSuggestedSa}
                    disabled={isSuggestedSaSelected}>
                    {isSuggestedSaSelected ? "✓ Using this Sa" : "Use this Sa"}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
        <div className="action-row">
          {!running ? (
            <button className="primary-btn" onClick={startMic}>
              ▶ Start microphone
            </button>
          ) : (
            <button className="stop-btn" onClick={stopMic}>
              ■ {findingSa ? "Stop Sa finder" : "Stop session"}
            </button>
          )}
          <span className="privacy-note">
            Microphone runs only during your session.
          </span>
        </div>
        {error && (
          <div className="error-box">
            <span>{error}</span>
            {connState === "failed" && (
              <button className="retry-btn" onClick={retryConnection}>
                Retry connection
              </button>
            )}
          </div>
        )}
        {connState === "reconnecting" && !error && (
          <div className="notice-box">
            Backend connection lost — retrying automatically.
          </div>
        )}
      </section>

      <section className="scene-shell">
        <div className="scene">
          <div className="scene-main">
            <div className="scene-readouts">
              <div className="scene-head">
                <div>
                  <p className="eyebrow">02 / LIVE ANALYSIS</p>
                  <h3>Your pitch</h3>
                </div>
                <span className={`status status-${status}`}>{statusLabel}</span>
              </div>

              <div className="f0">
                <span
                  className={f0Whole ? "f0-whole" : "f0-whole f0-empty"}>
                  {f0Whole ?? "—"}
                </span>
                <span className="f0-frac">{f0Frac ? `.${f0Frac}` : ""}</span>
                <span className="f0-unit">Hz</span>
              </div>
              <p className="f0-caption">
                Estimated fundamental (F₀)
                {result?.comparison_f0 &&
                Math.abs(result.comparison_f0 - result.f0) > 1
                  ? ` · octave-normalized ${result.comparison_f0} Hz`
                  : ""}
              </p>
              <div className="target-note">
                <span>Practicing</span>
                <strong>{swaras[target].label}</strong>
                <span>{targetHz.toFixed(2)} Hz</span>
              </div>
              {visibleFeedback && (
                <div
                  className={`pitch-feedback pitch-feedback-${pitchFeedback || "waiting"}`}
                  role="status"
                  aria-live="polite"
                  aria-atomic="true">
                  <span className="pitch-feedback-icon" aria-hidden="true">
                    {visibleFeedback.icon}
                  </span>
                  <span className="pitch-feedback-copy">
                    <strong className="pitch-feedback-label">
                      {visibleFeedback.label}
                    </strong>
                    <span>{visibleFeedback.message}</span>
                  </span>
                </div>
              )}
              <ul className="hud">
                <li>
                  <span>Target frequency</span>
                  <strong>{targetHz.toFixed(2)} Hz</strong>
                </li>
                <li>
                  <span>Deviation</span>
                  <strong className={deviationClass}>
                    {calculatedCents == null
                      ? "—"
                      : `${calculatedCents > 0 ? "+" : ""}${calculatedCents.toFixed(1)} ¢`}
                  </strong>
                </li>
                <li>
                  <span>Confidence</span>
                  <strong>
                    {result?.confidence == null
                      ? "—"
                      : `${Math.round(result.confidence * 100)}%`}
                  </strong>
                </li>
              </ul>

            </div>

            <div className="scene-plot">
              <div className="plot-meta">
                <span className="plot-chip">
                  <i className="swatch-f0" />F₀
                </span>
                <span className="plot-chip">
                  <i className="swatch-target" />Target
                </span>
                <span className="plot-chip">
                  <i className="swatch-harm" />2× · 3×
                </span>
                <span className="plot-note">65–1600 Hz · Hann · rFFT</span>
              </div>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={spectrumData}
                  margin={{ top: 34, right: 24, left: 0, bottom: 8 }}>
                  <defs>
                    <linearGradient
                      id="spectrumFill"
                      x1="0"
                      y1="0"
                      x2="0"
                      y2="1">
                      <stop
                        offset="0%"
                        stopColor="#a69aff"
                        stopOpacity={0.34}
                      />
                      <stop
                        offset="100%"
                        stopColor="#a69aff"
                        stopOpacity={0}
                      />
                    </linearGradient>
                  </defs>
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="#1e2740"
                    vertical={false}
                  />
                  <XAxis
                    dataKey="frequency"
                    type="number"
                    domain={[65, 1600]}
                    ticks={[100, 250, 500, 750, 1000, 1250, 1500]}
                    stroke="#8892aa"
                    tick={{ fontSize: 10 }}
                    tickFormatter={(v) => `${v}`}
                  />
                  <YAxis
                    domain={[-90, 0]}
                    ticks={[-80, -60, -40, -20, 0]}
                    width={38}
                    stroke="#8892aa"
                    tick={{ fontSize: 10 }}
                    tickFormatter={(v) => `${v}`}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "#10182b",
                      border: "1px solid #303b56",
                      borderRadius: 10,
                    }}
                    formatter={(value) => [
                      `${Number(value).toFixed(1)} dB`,
                      "Relative magnitude",
                    ]}
                    labelFormatter={(v) => `${Number(v).toFixed(1)} Hz`}
                  />
                  <ReferenceLine
                    x={targetHz}
                    stroke="#f2c94c"
                    strokeWidth={3}
                    strokeDasharray="7 4"
                    strokeOpacity={0.95}
                  />
                  <ReferenceLine
                    x={targetHz * 2}
                    stroke="#7f74d8"
                    strokeDasharray="2 6"
                    strokeOpacity={0.5}
                  />
                  <ReferenceLine
                    x={targetHz * 3}
                    stroke="#7f74d8"
                    strokeDasharray="2 6"
                    strokeOpacity={0.5}
                  />
                  {result?.f0 != null && (
                    <ReferenceLine
                      x={result.f0}
                      stroke="#e7e9f8"
                      strokeOpacity={0.45}
                      strokeWidth={1}
                    />
                  )}
                  <Area
                    type="monotone"
                    dataKey="db"
                    stroke="#a69aff"
                    strokeWidth={1.8}
                    fill="url(#spectrumFill)"
                    baseValue={-90}
                    dot={false}
                    isAnimationActive={false}
                    connectNulls
                  />
                </AreaChart>
              </ResponsiveContainer>
              {spectrumData.length === 0 && (
                <div className="plot-empty">Awaiting signal</div>
              )}
            </div>
          </div>

          <div className="scene-floor">
            <span className="floor-label">Time domain · 256 ms</span>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={waveformData}
                margin={{ top: 20, right: 24, left: 38, bottom: 0 }}>
                <ReferenceLine y={0} stroke="#39435e" strokeDasharray="4 4" />
                <XAxis dataKey="sample" hide />
                <YAxis domain={[-1, 1]} hide />
                <Area
                  type="monotone"
                  dataKey="amplitude"
                  stroke="#5ce0a3"
                  fill="#5ce0a3"
                  fillOpacity={0.12}
                  strokeWidth={1.3}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      </section>

      <p className="scene-note">
        Every peak is the energy at one frequency. The fundamental is scored
        across harmonic relationships, never by taking the tallest peak alone.
      </p>

      <section className="card chart-card">
          <div className="section-heading">
            <div>
              <p className="eyebrow">03 / INTONATION</p>
              <h3>Pitch deviation</h3>
            </div>
            <span className="tag">Cents</span>
          </div>
          <div className="chart-wrap">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={history}
                margin={{ top: 12, right: 10, left: -16, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#283047" />
                <XAxis dataKey="t" hide />
                <YAxis
                  domain={[-100, 100]}
                  ticks={[-100, -50, 0, 50, 100]}
                  stroke="#8892aa"
                  tick={{ fontSize: 11 }}
                />
                <Tooltip
                  contentStyle={{
                    background: "#10182b",
                    border: "1px solid #303b56",
                    borderRadius: 10,
                  }}
                  formatter={(value) => [
                    `${Number(value).toFixed(1)} cents`,
                    "Deviation",
                  ]}
                  labelFormatter={() => ""}
                />
                <ReferenceLine y={0} stroke="#9ba7c4" strokeDasharray="5 5" />
                <ReferenceLine
                  y={tolerance}
                  stroke="#526a59"
                  strokeDasharray="3 5"
                />
                <ReferenceLine
                  y={-tolerance}
                  stroke="#526a59"
                  strokeDasharray="3 5"
                />
                <Line
                  type="monotone"
                  dataKey="cents"
                  stroke="#9c8cff"
                  strokeWidth={2.5}
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="chart-legend">
            <span>
              <i className="legend-line" /> Measured pitch
            </span>
            <span>
              <i className="legend-dash" /> Target = 0 cents
            </span>
          </div>
      </section>

      <section className="card how-card">
        <div className="section-heading">
          <div>
            <p className="eyebrow">04 / UNDER THE HOOD</p>
            <h3>DSP signal chain</h3>
          </div>
          <span className="tag">FFT first</span>
        </div>
        <div className="dsp-steps">
          {[
            ["01", "Capture", "Browser microphone frames"],
            ["02", "Condition", "Rolling frame · remove DC"],
            ["03", "Window + FFT", "Hann window · one-sided spectrum"],
            ["04", "Estimate F₀", "Harmonic summation · peak refinement"],
            ["05", "Compare", "Reference Sa · cents error · coaching"],
          ].map(([n, title, desc]) => (
            <div className="dsp-step" key={n}>
              <span>{n}</span>
              <b>{title}</b>
              <small>{desc}</small>
            </div>
          ))}
        </div>
      </section>
      <footer>
        Sadhana · DSP prototype · Equal-tempered reference ratios are a starting
        point, not a universal raga tuning.
      </footer>
    </main>
  );
}
