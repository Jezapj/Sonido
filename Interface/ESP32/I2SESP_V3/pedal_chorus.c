#include "pedal_chorus.h"
#include "pedal_registry.h"
#include <math.h>
#include <string.h>
#include <stdint.h>

/* ── Delay buffer ─────────────────────────────────────────────────────────────
 *
 * 4096 samples at 48 kHz ≈ 85 ms — comfortably covers the maximum centre
 * delay (40 ms) plus maximum modulation depth (10 ms) with headroom.
 * Memory cost: 4096 × 4 bytes = 16 KB (well within ESP32 SRAM).
 */
#define CHORUS_BUF_SIZE 4096

/* ── Parameter struct ─────────────────────────────────────────────────────────
 *
 * Field order MUST match the 'Lush' knob array in PEDAL_DEFS (PedalOverlay.tsx)
 * so the serial packet maps correctly via memcpy.
 *
 *   rate      0.1 – 5.0   Hz   LFO frequency
 *   depth     0.0 – 10.0  ms   half-swing of the LFO modulation
 *   delay_ms  5.0 – 40.0  ms   centre (unmodulated) delay time
 *   mix       0.0 – 1.0        wet / dry blend
 *   feedback  0.0 – 0.9        recirculation amount
 */
typedef struct {
    float rate;
    float depth;
    float delay_ms;
    float mix;
    float feedback;
} chorus_params_t;

/* ── Static state ─────────────────────────────────────────────────────────────
 *
 * All state lives here; the registry callbacks are thin wrappers around it.
 * Zero-initialised at startup — cleared again by pedal_chorus_init so there
 * is no audible click if the pedal is enabled immediately after boot.
 */
static chorus_params_t s_params;
static float           s_sample_rate = 48000.0f;

static float s_buf[CHORUS_BUF_SIZE]; /* circular delay buffer              */
static int   s_write_pos = 0;        /* next write index                   */
static float s_lfo_phase = 0.0f;     /* LFO phase in [0, 1)                */

/* ── Fractional delay read (linear interpolation) ────────────────────────────
 *
 * Reads a sample that is `delay_samples` frames behind the current write
 * position.  Linear interpolation between adjacent integer-index samples
 * removes zipper noise caused by the LFO continuously varying the delay.
 *
 * Precondition: 1.0 <= delay_samples < CHORUS_BUF_SIZE - 1
 */
static float chorus_read(float delay_samples)
{
    int   d    = (int)delay_samples;
    float frac = delay_samples - (float)d;

    /* idx0 is the "floor" delay, idx1 is one sample further back. */
    int idx0 = (s_write_pos - d     + CHORUS_BUF_SIZE * 2) % CHORUS_BUF_SIZE;
    int idx1 = (s_write_pos - d - 1 + CHORUS_BUF_SIZE * 2) % CHORUS_BUF_SIZE;

    return s_buf[idx0] * (1.0f - frac) + s_buf[idx1] * frac;
}

/* ── Registry callbacks ───────────────────────────────────────────────────────
 *
 * on_params  — called when the host sends a parameter packet for this pedal.
 * on_process — called every audio block when the pedal is enabled.
 */

static void chorus_on_params(const float *params, uint8_t n_params)
{
    /* Validate exact byte count against our param struct before copying. */
    if ((uint32_t)n_params * sizeof(float) != sizeof(chorus_params_t)) return;
    memcpy(&s_params, params, sizeof(chorus_params_t));
}

static void chorus_on_process(float *in, float *out, int frames)
{
    /*
     * Pre-compute per-block constants so we do not repeat the divisions
     * or multiplications inside the hot per-sample loop.
     *
     * lfo_inc    — how much the LFO phase advances each sample
     * base_samps — centre delay in samples
     * depth_samp — LFO swing in samples (peak-to-peak is 2 × this)
     */
    const float lfo_inc    = s_params.rate    / s_sample_rate;
    const float base_samps = s_params.delay_ms * s_sample_rate * 0.001f;
    const float depth_samp = s_params.depth    * s_sample_rate * 0.001f;

    /* Clamp feedback to a safe range even if the host sends bad data. */
    const float fb  = s_params.feedback < 0.0f ? 0.0f
                    : s_params.feedback > 0.95f ? 0.95f
                    : s_params.feedback;
    const float mix = s_params.mix < 0.0f ? 0.0f
                    : s_params.mix > 1.0f ? 1.0f
                    : s_params.mix;
    const float dry = 1.0f - mix;

    for (int i = 0; i < frames; i++)
    {
        float x = in[i];

        /* ── 1. Sine LFO ─────────────────────────────────────────────────────
         *
         * lfo_phase runs in [0, 1).  Multiplying by 2π before sinf gives a
         * full cycle per unit increment.  Using phase normalised to [0, 1)
         * avoids phase accumulation errors that would occur if we accumulated
         * the angle directly in radians over millions of samples.
         */
        float lfo = sinf(2.0f * (float)M_PI * s_lfo_phase);
        s_lfo_phase += lfo_inc;
        if (s_lfo_phase >= 1.0f) s_lfo_phase -= 1.0f;

        /* ── 2. Modulated delay time ─────────────────────────────────────────
         *
         * delay_samps oscillates between (base - depth) and (base + depth).
         * Clamped to [1, BUF_SIZE-2] to keep the interpolation indices valid
         * and to prevent reading the sample we are about to overwrite.
         */
        float delay_samps = base_samps + depth_samp * lfo;
        if (delay_samps < 1.0f)                    delay_samps = 1.0f;
        if (delay_samps > CHORUS_BUF_SIZE - 2.0f)  delay_samps = CHORUS_BUF_SIZE - 2.0f;

        /* ── 3. Read wet signal from delay buffer ────────────────────────────
         *
         * chorus_read() interpolates between adjacent samples so the output
         * is smooth even as delay_samps changes continuously.
         */
        float wet = chorus_read(delay_samps);

        /* ── 4. Write to delay buffer ────────────────────────────────────────
         *
         * The value stored is the dry input plus a scaled copy of the delayed
         * output (feedback).  feedback = 0 → pure chorus; feedback > 0 adds
         * a resonant, flanger-like character as the signal recirculates.
         */
        s_buf[s_write_pos] = x + wet * fb;
        s_write_pos = (s_write_pos + 1) % CHORUS_BUF_SIZE;

        /* ── 5. Dry / wet mix ────────────────────────────────────────────────
         *
         * mix = 0.0 → dry signal only (bypass)
         * mix = 0.5 → equal blend (typical chorus sweet spot)
         * mix = 1.0 → wet only (strong effect, loses definition)
         */
        out[i] = x * dry + wet * mix;
    }
}

/* ── Public init ──────────────────────────────────────────────────────────────
 *
 * Zeroes all state so there is no click on first enable, sets conservative
 * defaults that produce a pleasant chorus immediately on connect, then
 * registers the callbacks with the pedal registry.
 */
void pedal_chorus_init(uint8_t slot_id, float sample_rate)
{
    s_sample_rate = sample_rate;

    /* Clear delay buffer and reset pointers / phase. */
    memset(s_buf, 0, sizeof(s_buf));
    s_write_pos = 0;
    s_lfo_phase = 0.0f;

    /* Safe, pleasant-sounding defaults — the frontend will overwrite these
     * as soon as the user opens the pedal overlay. */
    s_params.rate     = 0.5f;   /* gentle 0.5 Hz sweep                    */
    s_params.depth    = 5.0f;   /* ±5 ms modulation                       */
    s_params.delay_ms = 20.0f;  /* 20 ms centre — classic chorus range    */
    s_params.mix      = 0.5f;   /* 50 / 50 dry-wet                        */
    s_params.feedback = 0.0f;   /* pure chorus, no flanger character       */

    pedal_registry_register(slot_id, chorus_on_params, chorus_on_process);
}
