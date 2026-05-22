#ifndef PEDAL_PHASER_H
#define PEDAL_PHASER_H

#include <stdint.h>

/*
 * Phaser pedal — four-stage all-pass filter chain modulated by a sine LFO,
 * with resonance feedback and dry/wet mix.
 *
 * ── Algorithm ────────────────────────────────────────────────────────────────
 *
 *                     ┌─── feedback (resonance) ────────────────┐
 *                     ▼                                         │
 *   in ──► DC block ──+──► AP₀ ──► AP₁ ──► AP₂ ──► AP₃ ──────►+──► mix ──► out
 *              │                                                          │
 *              └─────────────────── dry path ──────────────────────────►─┘
 *
 *   APᵢ = first-order all-pass  H(z) = (a + z⁻¹) / (1 + a·z⁻¹)
 *
 *   coefficient  a(t) = (tan(π·fc(t)/fs) − 1) / (tan(π·fc(t)/fs) + 1)
 *   centre freq  fc(t) = 1000 + sin(2π·rate·t) × 900 × depth   [Hz]
 *
 * How it works:
 *   Each all-pass stage shifts the phase of its input by −180° at fc and
 *   leaves amplitude unchanged at all frequencies.  When the four stage
 *   outputs are combined with the dry signal the relative phase difference
 *   creates notches (cancellations) in the frequency spectrum.  The LFO
 *   continuously sweeps fc, so the notches move up and down, producing the
 *   characteristic "swooshing" phaser sound.
 *
 *   Feedback routes the chain output back to the input.  This deepens and
 *   narrows the notches (more resonance), turning a gentle shimmer into a
 *   pronounced whoosh with a distinct pitch centre.
 *
 * ── Parameter struct layout (must match PEDAL_DEFS in PedalOverlay.tsx) ─────
 *
 *   float rate;       [0.1, 5.0]  Hz   — LFO sweep speed
 *   float depth;      [0.0, 1.0]       — modulation depth (sweep width)
 *   float feedback;   [0.0, 0.9]       — resonance / notch depth
 *   float mix;        [0.0, 1.0]       — wet / dry blend
 *
 * 4 floats × 4 bytes = 16 bytes — validated by on_params.
 *
 * ── Integration steps ────────────────────────────────────────────────────────
 *
 * 1. Copy pedal_phaser.c and pedal_phaser.h into the I2SESP_V3 sketch folder.
 *
 * 2. In I2SESP_V3.ino:
 *      extern "C" { #include "pedal_phaser.h" }
 *      #define PEDAL_PHASER  6   // or whichever free slot index you choose
 *      // in setup():
 *      pedal_phaser_init(PEDAL_PHASER, (float)SAMPLE_RATE);
 *
 * 3. In PedalOverlay.tsx — add to PEDAL_IDS:
 *      'Good Boy': 6,   // must match PEDAL_PHASER above
 *
 *    Add to PEDAL_DEFS:
 *      'Good Boy': {
 *        label: 'Phaser',
 *        knobs: [
 *          { key: 'rate',     label: 'Rate',     min: 0.1, max: 5.0, defaultValue: 0.5,  unit: 'Hz', decimals: 2 },
 *          { key: 'depth',    label: 'Depth',    min: 0.0, max: 1.0, defaultValue: 0.8,              decimals: 2 },
 *          { key: 'feedback', label: 'Feedback', min: 0.0, max: 0.9, defaultValue: 0.4,              decimals: 2 },
 *          { key: 'mix',      label: 'Mix',      min: 0.0, max: 1.0, defaultValue: 0.5,              decimals: 2 },
 *        ],
 *      },
 *
 * 4. 'Good Boy' already exists in DEFAULT_ITEMS inside CircularGallery.tsx;
 *    no changes are needed there.
 */

/*
 * Initialise the phaser pedal and register it at `slot_id`.
 * Call once from setup() in I2SESP_V3.ino.
 *
 *   slot_id     — must match PEDAL_PHASER in I2SESP_V3.ino and
 *                 PEDAL_IDS['Good Boy'] in PedalOverlay.tsx.
 *   sample_rate — pass (float)SAMPLE_RATE.
 */
void pedal_phaser_init(uint8_t slot_id, float sample_rate);

#endif /* PEDAL_PHASER_H */
