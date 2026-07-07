#include "pedal_fuzz.h"
#include "pedal_registry.h"
#include <math.h>
#include <string.h>
#include <stdint.h>

/*
 * ── tanh Waveshaper ────────────────────────────────────────────────────────────
 *
 * tanh(x) produces smooth, bounded saturation:
 *
 *   x small  →  tanh(x) ≈ x          (linear — no distortion)
 *   x = ±1   →  tanh(x) ≈ ±0.76      (gentle knee)
 *   x = ±3   →  tanh(x) ≈ ±0.995     (near full saturation)
 *   x → ±∞   →  tanh(x) → ±1         (perfect square wave)
 *
 * At fuzz = 1.0 (gain = 500×), a guitar signal of ~0.002 amplitude already
 * saturates fully.  The output stays clipped at ±1 regardless of how hard the
 * player picks → "infinite sustain" with no dynamics (classic Big-Muff / Face
 * characteristic).  Reducing fuzz reveals the smooth curve of the knee, giving
 * a warm, slightly compressed tone closer to an overdrive.
 *
 * tanh is differentiable everywhere, so there are no abrupt discontinuities
 * to alias.  This is the key distinction from the hard-clip distortion pedal.
 *
 * ── Asymmetric Gain (BIAS control) ────────────────────────────────────────────
 *
 * In a real fuzz circuit the two transistors have slightly different bias
 * points, causing the positive and negative signal halves to be amplified
 * and clipped unequally.  Even-order harmonics (2nd, 4th …) arise from this
 * asymmetry because the waveform is no longer half-wave symmetric.
 *
 * We model this by applying differential gain before the waveshaper:
 *
 *   asym     = (bias_knob − 0.5) × 1.0  ∈ [−0.5, +0.5]
 *   pos_gain = gain × (1 + asym)         ∈ [gain×0.5, gain×1.5]
 *   neg_gain = gain × (1 − asym)         ∈ [gain×0.5, gain×1.5]
 *
 * bias = 0.5 → asym = 0   → symmetric, odd harmonics only
 * bias = 1.0 → asym = 0.5 → positive half gets 1.5× more gain → clips harder
 *                           → introduces 2nd harmonic → "warmer" timbre
 *                           → at extreme fuzz the positive half hard-saturates
 *                             while the negative half has some dynamic range left
 *                             → perceived "octave-up" spit on attack
 * bias = 0.0 → negative half clips harder (same effect, opposite polarity)
 *
 * Both pos_gain and neg_gain are always ≥ gain×0.5 > 0, so the signal is
 * never inverted and tanh's output is always bounded to (−1, 1) — no overflow.
 *
 * ── Tone Control ──────────────────────────────────────────────────────────────
 *
 * A first-order IIR low-pass filters the fuzzed signal. The tone knob
 * crossfades between the filtered (dark) and unfiltered (bright) output:
 *
 *   tone = 0.0 → LP only   (cutoff 300 Hz  — woolly, thick, synth-like)
 *   tone = 0.5 → 50/50     (cutoff felt at ~1.5 kHz, classic fuzz mid)
 *   tone = 1.0 → direct    (full brightness, all fuzz harmonics)
 *
 * The 300 Hz lower bound is intentionally very dark to emulate the "tone
 * rolled off" sound of a Fuzz Face with the guitar's tone knob turned down.
 */

/* ── Param struct ────────────────────────────────────────────────────────────── */

typedef struct {
    float fuzz;    /* [0.0, 1.0]  saturation / gain amount       */
    float bias;    /* [0.0, 1.0]  asymmetry (0.5 = symmetric)    */
    float tone;    /* [0.0, 1.0]  0 = dark/woolly, 1 = bright    */
    float level;   /* [0.0, 1.0]  output gain                    */
} fuzz_params_t;

/* ── Static state ────────────────────────────────────────────────────────────── */

static fuzz_params_t s_params;
static float         s_sample_rate = 48000.0f;

/*
 * Coefficients precomputed in update_coefficients() whenever params arrive.
 * Keeping powf / tanhf / division out of the per-sample hot loop.
 */
static float s_gain     = 1.0f;    /* pre-gain before waveshaper           */
static float s_asym     = 0.0f;    /* differential gain factor ∈ [−0.5, 0.5] */
static float s_lp_alpha = 0.5f;    /* LP coefficient for tone control      */

/* Filter state (must be zeroed in init to prevent startup click). */
static float s_lp_z1 = 0.0f;   /* tone low-pass memory                    */
static float s_dc_x1 = 0.0f;   /* input DC blocker: x[n-1]                */
static float s_dc_y1 = 0.0f;   /* input DC blocker: y[n-1]                */

/* ── Coefficient update ──────────────────────────────────────────────────────── */

static void update_coefficients(void)
{
    /* ── Fuzz → gain ──────────────────────────────────────────────────────────
     * Quadratic mapping gives more resolution at lower values where tonal
     * nuance exists, and rockets to extreme saturation at the high end.
     *
     *   fuzz = 0.0 → gain =   1×  (clean-ish, tanh knee barely reached)
     *   fuzz = 0.3 → gain =  46×  (light fuzz, single-note clarity)
     *   fuzz = 0.6 → gain = 181×  (heavy fuzz, full sustain)
     *   fuzz = 1.0 → gain = 500×  (full square wave, wall-of-sound)
     */
    float f    = s_params.fuzz  < 0.0f ? 0.0f : s_params.fuzz  > 1.0f ? 1.0f : s_params.fuzz;
    s_gain     = 1.0f + f * f * 499.0f;

    /* ── Bias → asymmetry ─────────────────────────────────────────────────────
     * Maps [0, 1] → [−0.5, +0.5].
     * pos_gain = s_gain × (1 + s_asym)
     * neg_gain = s_gain × (1 − s_asym)
     * Both are always ≥ 0 so tanh output ∈ (−1, 1) is guaranteed.
     */
    float b    = s_params.bias  < 0.0f ? 0.0f : s_params.bias  > 1.0f ? 1.0f : s_params.bias;
    s_asym     = (b - 0.5f) * 1.0f;    /* ∈ [−0.5, +0.5] */

    /* ── Tone → LP alpha ──────────────────────────────────────────────────────
     * Cutoff sweeps 300 Hz (tone=0, very dark) → 6 000 Hz (tone=1, bright).
     * Formula: α = fc / (fc + fs/(2π))  ≈ fc / (fc + fs × 0.159154)
     */
    float t    = s_params.tone  < 0.0f ? 0.0f : s_params.tone  > 1.0f ? 1.0f : s_params.tone;
    float fc   = 300.0f + t * 5700.0f;
    s_lp_alpha = fc / (fc + s_sample_rate * 0.159154f);
}

/* ── Registry callbacks ──────────────────────────────────────────────────────── */

static void fuzz_on_params(const float *params, uint8_t n_params)
{
    if ((uint32_t)n_params * sizeof(float) != sizeof(fuzz_params_t)) return;
    memcpy(&s_params, params, sizeof(fuzz_params_t));
    update_coefficients();
}

static void fuzz_on_process(float *in, float *out, int frames)
{
    /* Copy to locals so the compiler can keep them in registers. */
    const float gain    = s_gain;
    const float asym    = s_asym;
    const float alpha   = s_lp_alpha;
    const float tone    = s_params.tone  < 0.0f ? 0.0f : s_params.tone  > 1.0f ? 1.0f : s_params.tone;
    const float level   = s_params.level < 0.0f ? 0.0f : s_params.level > 1.0f ? 1.0f : s_params.level;
    const float one_m_t = 1.0f - tone;

    for (int i = 0; i < frames; i++)
    {
        float x = in[i];

        /* ── 1. Input DC block ────────────────────────────────────────────────
         * Removes any DC offset in the signal before it reaches the high-gain
         * stage.  Without this, a biased input shifts the waveshaper's
         * operating point unpredictably and generates buzzy asymmetric artefacts
         * unrelated to the BIAS knob.
         *
         *   y[n] = x[n] − x[n-1] + R·y[n-1]   (R = 0.995 ≈ 22 Hz cutoff)
         */
        float dc_out = x - s_dc_x1 + 0.995f * s_dc_y1;
        s_dc_x1 = x;
        s_dc_y1 = dc_out;
        x = dc_out;

        /* ── 2. Asymmetric gain + tanh waveshaper ─────────────────────────────
         *
         * Positive and negative halves of the signal are amplified by
         * slightly different amounts before hitting the tanh waveshaper.
         *
         *   pos_gain = gain × (1 + asym)
         *   neg_gain = gain × (1 − asym)
         *
         * Since |asym| ≤ 0.5, both gains are always ≥ gain×0.5 > 0, so
         * the signal is never inverted and tanhf output ∈ (−1, 1) always.
         *
         * At high fuzz and |asym| > 0, the two halves saturate to ±1 at
         * different input amplitudes, generating even harmonics (2nd, 4th …)
         * that add the warm, organic "spit" of germanium fuzz circuits.
         */
        float driven;
        if (x >= 0.0f)
            driven = x * (gain * (1.0f + asym));
        else
            driven = x * (gain * (1.0f - asym));

        float fuzzed = tanhf(driven);   /* always ∈ (−1, 1) */

        /* ── 3. Tone control ──────────────────────────────────────────────────
         * Low-pass filters the fuzzed signal, then crossfades with the
         * unfiltered signal.
         *
         *   tone = 0.0 → pure LP (thick, woolly, vowel-like)
         *   tone = 0.5 → equal blend (balanced fuzz texture)
         *   tone = 1.0 → full direct (all harmonics, sizzly)
         *
         * This shape is intentionally different from the tone controls in
         * the overdrive and distortion pedals: the lower cutoff floor (300 Hz
         * vs 500 Hz) makes the dark extreme more extreme, appropriate for the
         * denser harmonic content of a fuzz waveshaper.
         */
        s_lp_z1     = alpha * fuzzed + (1.0f - alpha) * s_lp_z1;
        float toned = tone * fuzzed + one_m_t * s_lp_z1;

        /* ── 4. Output level ──────────────────────────────────────────────────
         * At high gain settings the fuzz output is near a constant ±1 square
         * wave regardless of pick dynamics. The level knob lets the player
         * match the fuzz volume to the bypassed signal and to other pedals.
         */
        out[i] = toned * level;
    }
}

/* ── Public init ─────────────────────────────────────────────────────────────── */

void pedal_fuzz_init(uint8_t slot_id, float sample_rate)
{
    s_sample_rate = sample_rate;

    /* Conservative defaults: heavy but not insane, symmetric, mid-voiced. */
    s_params.fuzz  = 0.6f;
    s_params.bias  = 0.5f;   /* symmetric — user can dial in asymmetry */
    s_params.tone  = 0.5f;   /* balanced — neither dark nor bright     */
    s_params.level = 0.7f;

    /* Clear all filter memory so there is no click on first enable. */
    s_lp_z1 = 0.0f;
    s_dc_x1 = 0.0f;
    s_dc_y1 = 0.0f;

    update_coefficients();

    pedal_registry_register(slot_id, fuzz_on_params, fuzz_on_process);
}
