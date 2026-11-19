#!/usr/bin/env python3
"""Synthesize original short folk-like placeholder clips. Not based on any existing song."""
import math
import random
import struct
import wave
from pathlib import Path

SR = 44100
OUT = Path(__file__).resolve().parent

def midi(n):
    return 440.0 * (2 ** ((n - 69) / 12.0))

def env_pluck(t, dur, attack=0.008, decay=0.35):
    if t < 0 or t > dur:
        return 0.0
    if t < attack:
        return t / attack
    # exponential-ish decay, leave a soft tail
    return math.exp(-(t - attack) / decay)

def tone(freq, t, bright=0.35):
    # soft plucked-string spectrum: fundamental + weak octaves / fifths
    w = 2 * math.pi * freq * t
    s = math.sin(w)
    s += 0.45 * bright * math.sin(2 * w)
    s += 0.18 * bright * math.sin(3 * w)
    s += 0.08 * bright * math.sin(4 * w)
    s += 0.05 * math.sin(2 * math.pi * (freq * 1.5) * t) * bright * 0.35
    return s

def noise_burst(t, amt=0.12):
    if t < 0 or t > 0.03:
        return 0.0
    return amt * (1 - t / 0.03) * (random.random() * 2 - 1)

def render_notes(notes, bpm, root_bright=0.4, drone=None, drone_amp=0.08):
    """notes: list of (midi or None for rest, beats)."""
    beat = 60.0 / bpm
    total = sum(b for _, b in notes) * beat + 0.35
    n = int(total * SR)
    buf = [0.0] * n
    t0 = 0.0
    for mid, beats in notes:
        dur = beats * beat
        if mid is not None:
            freq = midi(mid)
            start = int(t0 * SR)
            length = int((dur + 0.28) * SR)
            for i in range(length):
                t = i / SR
                if start + i >= n:
                    break
                amp = env_pluck(t, dur + 0.28, attack=0.006, decay=0.22 + beats * 0.12)
                # slight vibrato on longer notes
                vib = 1 + 0.0035 * math.sin(2 * math.pi * 5.2 * t) if beats >= 1.5 else 1
                buf[start + i] += amp * tone(freq * vib, t, root_bright)
                if t < 0.02:
                    buf[start + i] += noise_burst(t, 0.07)
        t0 += dur
    if drone:
        df = midi(drone)
        for i in range(n):
            t = i / SR
            fade = min(1, t / 0.15, (n / SR - t) / 0.3)
            if fade < 0:
                fade = 0
            buf[i] += fade * drone_amp * (
                math.sin(2 * math.pi * df * t) * 0.7
                + math.sin(2 * math.pi * df * 2 * t) * 0.15
            )
    # very short cheap "room"
    delayed = [0.0] * n
    d = int(0.086 * SR)
    for i in range(n):
        delayed[i] = buf[i] + (0.22 * delayed[i - d] if i >= d else 0)
    buf = delayed
    peak = max(1e-9, max(abs(x) for x in buf))
    gain = 0.86 / peak
    # fade ends
    fade_n = int(0.04 * SR)
    fade_out = int(0.18 * SR)
    samples = []
    for i, x in enumerate(buf):
        g = gain
        if i < fade_n:
            g *= i / fade_n
        if i > n - fade_out:
            g *= max(0, (n - i) / fade_out)
        v = int(max(-32767, min(32767, x * g * 32767)))
        samples.append(v)
    return samples

def write_wav(path, samples):
    with wave.open(str(path), "w") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(b"".join(struct.pack("<h", s) for s in samples))

# Distinct original motifs, pentatonic (no copyrighted tunes).
# Midis around C4=60. Chinese-ish 宫商角徵羽 shapes, original orderings.

clips = {
    # 烟台山的晚风 — slow descending dusk
    "01.wav": dict(
        bpm=72,
        bright=0.32,
        drone=57,  # A3
        drone_amp=0.07,
        notes=[
            (69, 1.0), (72, 0.5), (74, 0.5),  # A C D
            (76, 1.5), (74, 0.5),             # E D
            (72, 1.0), (69, 1.5), (67, 0.5),  # C A G
            (69, 2.0),                        # A
        ],
    ),
    # 青石路上的灯 — stepwise lantern walk, medium
    "02.wav": dict(
        bpm=96,
        bright=0.48,
        drone=62,
        drone_amp=0.06,
        notes=[
            (62, 0.5), (64, 0.5), (67, 0.5), (69, 0.5),
            (71, 1.0), (69, 0.5), (67, 0.5),
            (64, 0.5), (67, 0.5), (69, 0.5), (71, 0.5),
            (74, 1.5), (71, 0.5),
            (69, 1.0),
        ],
    ),
    # 湖面上的旧船票 — wider intervals, flowing 6/8 feel (written in 2-beat groups)
    "03.wav": dict(
        bpm=84,
        bright=0.38,
        drone=55,
        drone_amp=0.08,
        notes=[
            (67, 2/3), (71, 2/3), (74, 2/3),
            (79, 1.0), (76, 0.5), (74, 0.5),
            (71, 2/3), (67, 2/3), (71, 2/3),
            (74, 2.0),
        ],
    ),
    # 雪山下的一封信 — spacious, higher, long notes
    "04.wav": dict(
        bpm=64,
        bright=0.28,
        drone=64,
        drone_amp=0.05,
        notes=[
            (76, 2.0),
            (79, 1.5), (76, 0.5),
            (74, 2.0),
            (71, 1.0), (67, 1.0),
            (69, 2.5),
        ],
    ),
    # 店里还存着那杯酒 — warm, closer, short toast-like phrase
    "05.wav": dict(
        bpm=88,
        bright=0.42,
        drone=60,
        drone_amp=0.07,
        notes=[
            (60, 0.5), (64, 0.5), (67, 1.0),
            (69, 0.5), (67, 0.5), (64, 1.0),
            (62, 0.5), (60, 0.5), (64, 0.75), (67, 0.75),
            (60, 2.0),
        ],
    ),
}

random.seed(20)
for name, spec in clips.items():
    samples = render_notes(spec["notes"], spec["bpm"], spec["bright"], spec.get("drone"), spec.get("drone_amp", 0.07))
    path = OUT / name
    write_wav(path, samples)
    dur = len(samples) / SR
    print(f"{name}  {dur:.2f}s  {path.stat().st_size} bytes")
