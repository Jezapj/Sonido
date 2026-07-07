#ifndef PEDAL_FUZZ_H
#define PEDAL_FUZZ_H

#include <stdint.h>

/*
 * Fuzz pedal — tanh waveshaper with asymmetric gain and tone control.
 *
 * ── Algorithm ────────────────────────────────────────────────────────────────
 *
 *                ┌────────────────────────────────────────────────┐
 *   in ──► DC ──►│ asymmetric gain (pos_gain / neg_gain) ──► tanh │──► LP blend ──► level ──► out
 *   block        └────────────────────────────────────────────────┘
 *
 *   tanh(x) saturates smoothly to ±1 as x → ±∞.  At high gain (500×) even a
 *   small input signal saturates fully, producing a near-square wave with
 *   infinite sustain — the defining quality of fuzz.
 *
 *   The BIAS knob applies differential gain to the positive and negative signal
 *   halves before the waveshaper.  Unequal gain causes unequal compression of
 *   the two halves → even-order harmonics (2nd, 4th …) emerge on top of the
 *   odd harmonics from symmetric clipping.  At extreme settings this produces
 *   the "splatty" octave-up artefact characteristic of germanium fuzz circuits.
 *
 * ── Compared to the other distortion pedals ───────────────────────────────────
 *
 *   Overdrive (New York):      cubic soft-clip,   gain up to 30×,  smooth
 *   Distortion (Strawberries): hard-clip asymm,   gain up to 100×, gritty
 *   Fuzz      (Honey):         tanh waveshaper,   gain up to 500×, infinite sustain
 *
 * ── Parameter struct layout (must match PEDAL_DEFS in PedalOverlay.tsx) ─────
 *
 *   float fuzz;    [0.0, 1.0]  gain / saturation amount
 *   float bias;    [0.0, 1.0]  asymmetry: 0.5 = symmetric, 0/1 = extreme
 *   float tone;    [0.0, 1.0]  0 = dark/woolly, 1 = bright/sizzly
 *   float level;   [0.0, 1.0]  output volume
 *
 *   4 floats × 4 bytes = 16 bytes — validated by on_params.
 *
 * ── Integration steps ─────────────────────────────────────────────────────────
 *
 * 1. Copy pedal_fuzz.c / pedal_fuzz.h into the I2SESP_V3 sketch folder.
 *
 * 2. In pedal_registry.h — bump PEDAL_REGISTRY_MAX to at least 9:
 *      #define PEDAL_REGISTRY_MAX 10
 *
 * 3. In I2SESP_V3.ino:
 *      extern "C" { #include "pedal_fuzz.h" }
 *      #define PEDAL_FUZZ  8
 *      // in setup():
 *      pedal_fuzz_init(PEDAL_FUZZ, (float)SAMPLE_RATE);
 *
 * 4. In PedalOverlay.tsx — add to PEDAL_IDS:
 *      'Honey': 8,
 *
 *    Add to PEDAL_DEFS:
 *      'Honey': {
 *        label: 'Fuzz',
 *        knobs: [
 *          { key: 'fuzz',  label: 'Fuzz',  min: 0, max: 1, defaultValue: 0.6, decimals: 2 },
 *          { key: 'bias',  label: 'Bias',  min: 0, max: 1, defaultValue: 0.5, decimals: 2 },
 *          { key: 'tone',  label: 'Tone',  min: 0, max: 1, defaultValue: 0.5, decimals: 2 },
 *          { key: 'level', label: 'Level', min: 0, max: 1, defaultValue: 0.7, decimals: 2 },
 *        ],
 *      },
 *
 * 5. In CircularGallery.tsx — add to DEFAULT_ITEMS:
 *      { image: '/L_Fuzz_pedal.png', text: 'Honey' },
 */
void pedal_fuzz_init(uint8_t slot_id, float sample_rate);

#endif /* PEDAL_FUZZ_H */
