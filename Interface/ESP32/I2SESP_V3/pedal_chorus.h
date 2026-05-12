#ifndef PEDAL_CHORUS_H
#define PEDAL_CHORUS_H

#include <stdint.h>

/*
 * Chorus pedal — variable delay line modulated by a sine-wave LFO.
 *
 * ── Algorithm ────────────────────────────────────────────────────────────────
 *
 *           ┌─────────────────────────────────────┐
 *   in ─────┤──► delay line (variable depth) ──►──┤─► mix ──► out
 *           │                   ▲                  │
 *           │             LFO (sine)               │
 *           │        rate, depth, delay_ms         │
 *           └──────────────────────── feedback ────┘
 *
 * The LFO continuously varies the read position in the circular delay buffer.
 * This causes subtle pitch modulation on the wet signal.  Mixing it with the
 * dry signal produces the characteristic "thickening" effect of chorus.
 *
 * feedback = 0.0  → pure chorus  (no recirculation)
 * feedback > 0.0  → flanger-like character as resonance builds
 *
 * ── Parameter struct layout (must match PEDAL_DEFS in PedalOverlay.tsx) ─────
 *
 *   float rate;       [0.1, 5.0]  Hz   — LFO frequency
 *   float depth;      [0.0, 10.0] ms   — modulation depth (half-swing)
 *   float delay_ms;   [5.0, 40.0] ms   — centre delay time
 *   float mix;        [0.0, 1.0]       — wet / dry blend
 *   float feedback;   [0.0, 0.9]       — delay feedback (0 = off)
 *
 * 5 floats × 4 bytes = 20 bytes total — validated by on_params.
 *
 * ── Integration steps ────────────────────────────────────────────────────────
 *
 * 1. Copy pedal_chorus.c and pedal_chorus.h into the I2SESP_V3 sketch folder.
 *
 * 2. In I2SESP_V3.ino:
 *      extern "C" { #include "pedal_chorus.h" }
 *      #define PEDAL_CHORUS  3   // or whichever free slot index you choose
 *      // in setup():
 *      pedal_chorus_init(PEDAL_CHORUS, (float)SAMPLE_RATE);
 *
 * 3. In PedalOverlay.tsx — add to PEDAL_IDS:
 *      'Lush':  3,   // must match PEDAL_CHORUS above
 *
 *    Add to PEDAL_DEFS:
 *      'Lush': {
 *        label: 'Chorus',
 *        knobs: [
 *          { key: 'rate',      label: 'Rate',    min: 0.1,  max: 5.0,  defaultValue: 0.5,  unit: 'Hz', decimals: 2 },
 *          { key: 'depth',     label: 'Depth',   min: 0.0,  max: 10.0, defaultValue: 5.0,  unit: 'ms', decimals: 1 },
 *          { key: 'delay_ms',  label: 'Delay',   min: 5.0,  max: 40.0, defaultValue: 20.0, unit: 'ms', decimals: 1 },
 *          { key: 'mix',       label: 'Mix',     min: 0.0,  max: 1.0,  defaultValue: 0.5,              decimals: 2 },
 *          { key: 'feedback',  label: 'Feedback',min: 0.0,  max: 0.9,  defaultValue: 0.0,              decimals: 2 },
 *        ],
 *      },
 *
 * 4. Add a GalleryItem entry with key 'Lush' in CircularGallery.tsx DEFAULT_ITEMS
 *    (and supply a pedal image asset).
 */

/*
 * Initialise the chorus pedal and register it at `slot_id`.
 * Call once from setup() after pedal_eq_init / pedal_od_init.
 *
 *   slot_id     — must match PEDAL_CHORUS in I2SESP_V3.ino and
 *                 PEDAL_IDS['Lush'] in PedalOverlay.tsx.
 *   sample_rate — pass (float)SAMPLE_RATE.
 */
void pedal_chorus_init(uint8_t slot_id, float sample_rate);

#endif /* PEDAL_CHORUS_H */
