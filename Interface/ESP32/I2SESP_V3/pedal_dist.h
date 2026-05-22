#ifndef PEDAL_DIST_H
#define PEDAL_DIST_H

#include <stdint.h>

/*
 * Distortion pedal — hard-clip waveshaper with asymmetric diode-like
 * characteristic, tone control, and a presence filter.
 *
 * ── Algorithm ────────────────────────────────────────────────────────────────
 *
 *         ┌────────────────────────────────────────────────────────────┐
 *  in ────┤──► DC block ──► gain ──► hard-clip (asymmetric) ──►───────┤──► out
 *         │                                   │                        │
 *         │                          tone LP blend                     │
 *         │                               │                            │
 *         │                       + presence HP blend ──► level ───────┘
 *         └────────────────────────────────────────────────────────────┘
 *
 * Compared to the soft-clip overdrive (pedal_od), this pedal:
 *   – Uses much higher pre-gain (up to 100×) for dense harmonic saturation.
 *   – Hard-clips the driven signal at +1.0 / −0.7, mimicking the asymmetric
 *     transfer curve of a silicon diode pair. The asymmetry introduces even
 *     harmonics (2nd, 4th …) on top of the odd harmonics from clipping,
 *     producing the characteristic "sizzle" of a transistor-based distortion.
 *   – Adds a presence control that blends in a high-passed copy of the
 *     post-tone signal, emphasising upper harmonics without touching the
 *     overall gain structure.
 *
 * ── Parameter struct layout (must match PEDAL_DEFS in PedalOverlay.tsx) ─────
 *
 *   float gain;      [0.0, 1.0]   — distortion intensity  (1× → 100× pre-gain)
 *   float tone;      [0.0, 1.0]   — 0 = dark/warm,  1 = bright/cutting
 *   float presence;  [0.0, 1.0]   — upper-harmonic emphasis (1.5 kHz HP blend)
 *   float level;     [0.0, 1.0]   — post-distortion output volume
 *
 * 4 floats × 4 bytes = 16 bytes — validated by on_params.
 *
 * ── Integration steps ────────────────────────────────────────────────────────
 *
 * 1. Copy pedal_dist.c and pedal_dist.h into the I2SESP_V3 sketch folder.
 *
 * 2. In I2SESP_V3.ino:
 *      extern "C" { #include "pedal_dist.h" }
 *      #define PEDAL_DISTORTION  5   // or whichever free slot index you choose
 *      // in setup():
 *      pedal_dist_init(PEDAL_DISTORTION, (float)SAMPLE_RATE);
 *
 * 3. In PedalOverlay.tsx — add to PEDAL_IDS:
 *      'Strawberries': 5,   // must match PEDAL_DISTORTION above
 *
 *    Add to PEDAL_DEFS:
 *      'Strawberries': {
 *        label: 'Distortion',
 *        knobs: [
 *          { key: 'gain',     label: 'Gain',     min: 0, max: 1, defaultValue: 0.5, decimals: 2 },
 *          { key: 'tone',     label: 'Tone',     min: 0, max: 1, defaultValue: 0.5, decimals: 2 },
 *          { key: 'presence', label: 'Presence', min: 0, max: 1, defaultValue: 0.3, decimals: 2 },
 *          { key: 'level',    label: 'Level',    min: 0, max: 1, defaultValue: 0.6, decimals: 2 },
 *        ],
 *      },
 *
 * 4. Ensure 'Strawberries' already exists in DEFAULT_ITEMS inside
 *    CircularGallery.tsx (it is present in the current codebase).
 */

/*
 * Initialise the distortion pedal and register it at `slot_id`.
 * Call once from setup() in I2SESP_V3.ino.
 *
 *   slot_id     — must match PEDAL_DISTORTION in I2SESP_V3.ino and
 *                 PEDAL_IDS['Strawberries'] in PedalOverlay.tsx.
 *   sample_rate — pass (float)SAMPLE_RATE.
 */
void pedal_dist_init(uint8_t slot_id, float sample_rate);

#endif /* PEDAL_DIST_H */
