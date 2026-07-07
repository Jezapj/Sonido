#ifndef PEDAL_OCTAVE_H
#define PEDAL_OCTAVE_H

#include <stdint.h>

/*
 * Octave pedal — WSOLA (Waveform Similarity Overlap-Add) pitch shifter.
 *
 * ── Why WSOLA, not plain OLA ──────────────────────────────────────────────────
 *
 * Plain OLA places grain boundaries at fixed positions (write_pos − N×R)
 * with no regard for where the pitch CYCLE is in the waveform.  Each grain
 * starts at a random phase, causing flanging and unstable pitch — audible as
 * wrong intervals when playing a scale.
 *
 * WSOLA fixes this by searching ±SEARCH_WIN samples around the ideal position
 * and choosing the candidate whose signal content best matches the most recent
 * input (highest cross-correlation).  For a quasi-periodic guitar note the
 * correlation peaks at positions that are whole-period multiples from the
 * write head — i.e. natural pitch-cycle boundaries — without any explicit
 * pitch detection.  Grain boundaries lock to pitch periods; a scale played
 * through the pedal sounds like the same scale transposed by the chosen shift.
 *
 * ── Parameter layout (must match PEDAL_DEFS 'Saturn' in PedalOverlay.tsx) ───
 *
 *   float shift;   [−2.0, +2.0]  octave shift  (0 = bypass)
 *   float mix;     [ 0.0,  1.0]  wet / dry blend
 *   float level;   [ 0.0,  1.0]  output gain
 *
 *   pitch_ratio = 2^shift
 *     −2 → 0.25×   (two octaves down)
 *     −1 → 0.50×   (one octave down — bass-guitar sound)
 *     +1 → 2.00×   (one octave up)
 *     +2 → 4.00×   (two octaves up)
 */
void pedal_octave_init(uint8_t slot_id, float sample_rate);

#endif /* PEDAL_OCTAVE_H */