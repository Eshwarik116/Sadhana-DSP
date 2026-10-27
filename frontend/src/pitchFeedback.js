export function calculateCentsDeviation(measuredFrequency, targetFrequency) {
  if (
    !Number.isFinite(measuredFrequency) ||
    measuredFrequency <= 0 ||
    !Number.isFinite(targetFrequency) ||
    targetFrequency <= 0
  ) {
    return null;
  }

  return 1200 * Math.log2(measuredFrequency / targetFrequency);
}

export function classifyPitch(
  measuredFrequency,
  targetFrequency,
  tolerance,
  confidence,
) {
  const centsDeviation = calculateCentsDeviation(
    measuredFrequency,
    targetFrequency,
  );
  if (
    centsDeviation === null ||
    !Number.isFinite(tolerance) ||
    tolerance < 0 ||
    !Number.isFinite(confidence) ||
    confidence < 0.1
  ) {
    return { centsDeviation: null, state: "waiting" };
  }

  const boundaryEpsilon = 1e-9;
  if (centsDeviation < -tolerance - boundaryEpsilon) {
    return { centsDeviation, state: "low" };
  }
  if (centsDeviation > tolerance + boundaryEpsilon) {
    return { centsDeviation, state: "high" };
  }
  return { centsDeviation, state: "correct" };
}

export function getStableSaSuggestion(readings) {
  const minimumReadings = 24;
  if (
    readings.length < minimumReadings ||
    readings.some(
      (frequency) =>
        !Number.isFinite(frequency) || frequency < 60 || frequency > 600,
    )
  ) {
    return null;
  }

  const sorted = [...readings].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : sorted[middle];
  const stable = readings.every(
    (frequency) =>
      Math.abs(1200 * Math.log2(frequency / median)) <= 40,
  );

  return stable ? Math.round(median * 10) / 10 : null;
}

export function noteNameFromFrequency(frequency) {
  if (!Number.isFinite(frequency) || frequency <= 0) return null;

  const noteNames = [
    "C",
    "C♯",
    "D",
    "D♯",
    "E",
    "F",
    "F♯",
    "G",
    "G♯",
    "A",
    "A♯",
    "B",
  ];
  const midiNote = Math.round(69 + 12 * Math.log2(frequency / 440));
  return `${noteNames[((midiNote % 12) + 12) % 12]}${Math.floor(midiNote / 12) - 1}`;
}
