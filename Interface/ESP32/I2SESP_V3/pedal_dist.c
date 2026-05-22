#include "pedal_dist.h"
#include "pedal_registry.h"
#include <math.h>
#include <string.h>
#include <stdint.h>

/* ── Parameter struct ─────────────────────────────────────────────────────────
 *
 * Field order MUST match the 'Strawberries' knob array in PEDAL_DEFS inside
 * PedalOverlay.tsx so that the serial packet maps correctly via memcpy.
 *
 *   gain     0.0–1.0   pre-gain scaling (maps to 1× – 100×)
 *   tone     0.0–1.0   blends low-pass → direct; 0 = warm/dark, 1 = bright
 *   presence 0.0–1.0   adds high-passed content back after tone shaping
 *   level    0.0–1.0   post output volume
 * ─────────────────────────────────────────────────────────────────────────── */
typedef struct {
    float gain;
    float tone;
    float presence;
    float level;
} dist_params_t;

/* ── Static state ─────────────────────────────────────────────────────────── */

static dist_params_t s_params;
static float s_sample_rate = 48000.0f;

/* Tone low-pass IIR memory. */
static float s_lp_z1  = 0.0f;

/* Presence high-pass IIR memory.
   y[n] = α·(y[n-1] + x[n] − x[n-1])   (first-order RC high-pass)           */
static float s_hp_x1  = 0.0f;
static float s_hp_y1  = 0.0f;

/* DC blocker state — identical scheme to the overdrive and EQ pedals.
   Prevents a biased input from causing asymmetric, buzzy distortion.          */
static float s_dc_x1  = 0.0f;
static float s_dc_y1  = 0.0f;

/* ── Asymmetric hard-clipper ──────────────────────────────────────────────────
 *
 * Silicon diode pairs in classic distortion circuits conduct asymmetrically:
 * one diode clips the positive half earlier than the complementary diode on
 * the negative half.  Modelling this with a positive ceiling of +1.0 and a
 * negative floor of −0.7 introduces even-order harmonics (2nd, 4th, …) that
 * sit on top of the odd harmonics produced by plain clipping.  The result is a
 * denser, more abrasive timbre than the soft-clip overdrive.
 *
 * At the same time, the signal within the clipping window is left completely
 * unprocessed — no smoothing polynomial — so transients punch through cleanly
 * until they hit the hard boundary.
 *
 *   +1.0 ─────────────────────────────── positive ceiling
 *          /
 *         /   (linear region — unchanged)
 *        /
 *  −0.7 ─────────────────────────────── negative floor (asymmetric)
 */
static float hard_clip_asym(float x)
{
    if (x >=  1.0f) return  1.0f;
    if (x <= -0.7f) return -0.7f;
    return x;
}

/* ── Registry callbacks ───────────────────────────────────────────────────── */

static void dist_on_params(const float *params, uint8_t n_params)
{
    /* Validate exact byte count before touching s_params. */
    if ((uint32_t)n_params * sizeof(float) != sizeof(dist_params_t)) return;
    memcpy(&s_params, params, sizeof(dist_params_t));
}

static void dist_on_process(float *in, float *out, int frames)
{
    /*
     * Pre-compute per-block constants to avoid repeated divisions inside
     * the hot per-sample loop.
     *
     * drive_gain  — maps [0, 1] → [1×, 100×]
     *               At gain=0 the signal barely clips (colour without crush).
     *               At gain=1 the signal is driven 100× into the clipper,
     *               producing wall-to-wall saturation.
     *
     * lp_alpha    — first-order low-pass coefficient for the tone control.
     *               Cutoff sweeps 300 Hz (tone=0, dark) → 8 kHz (tone=1, bright).
     *               Formula: α = fc / (fc + fs/(2π))  ≈ fc / (fc + fs·0.159154)
     *
     * hp_alpha    — first-order high-pass coefficient for the presence filter.
     *               Fixed centre at 1.5 kHz; blended in by the presence knob.
     *               Formula: α = fs·0.159154 / (fc + fs·0.159154)
     */
    const float drive_gain = 1.0f + s_params.gain * 99.0f;

    const float fc_tone  = 300.0f + s_params.tone * 7700.0f;
    const float lp_alpha = fc_tone / (fc_tone + s_sample_rate * 0.159154f);

    const float fc_pres  = 1500.0f;
    const float hp_alpha = (s_sample_rate * 0.159154f)
                           / (fc_pres + s_sample_rate * 0.159154f);

    /* Clamp presence and level so bad packets can't destabilise the chain. */
    const float presence = s_params.presence < 0.0f ? 0.0f
                         : s_params.presence > 1.0f ? 1.0f
                         : s_params.presence;
    const float level    = s_params.level    < 0.0f ? 0.0f
                         : s_params.level    > 1.0f ? 1.0f
                         : s_params.level;

    for (int i = 0; i < frames; i++)
    {
        float x = in[i];

        /* ── 1. DC block ────────────────────────────────────────────────────
         * y[n] = x[n] − x[n-1] + R·y[n-1]   (R = 0.995 ≈ 22 Hz cutoff)
         * Keeps the waveform centred around zero so the asymmetric clipper
         * produces consistent harmonic character regardless of DC offset.    */
        float dc_out = x - s_dc_x1 + 0.995f * s_dc_y1;
        s_dc_x1 = x;
        s_dc_y1 = dc_out;
        x = dc_out;

        /* ── 2. Drive stage ─────────────────────────────────────────────────
         * Multiply the signal so peaks breach the clipping thresholds.
         * The very high maximum gain (100×) ensures even low-level signals
         * saturate fully at high drive settings, unlike the 30× ceiling of
         * the overdrive pedal.                                               */
        float driven = x * drive_gain;

        /* ── 3. Asymmetric hard-clip ─────────────────────────────────────────
         * Imposes the diode-pair transfer function described above.
         * Hard clipping retains the transient "attack" of notes better than
         * soft-clip: the wave is linear until the ceiling, then flat — there
         * is no gradual rounding near the boundary.                          */
        float clipped = hard_clip_asym(driven);

        /* ── 4. Tone control ─────────────────────────────────────────────────
         * First-order IIR low-pass applied to the clipped signal.
         * The tone knob crossfades between the filtered (warm) and unfiltered
         * (bright) outputs — same scheme as pedal_od for consistency.        */
        s_lp_z1        = lp_alpha * clipped + (1.0f - lp_alpha) * s_lp_z1;
        float toned    = s_params.tone * clipped + (1.0f - s_params.tone) * s_lp_z1;

        /* ── 5. Presence ─────────────────────────────────────────────────────
         * A first-order high-pass filter extracts upper harmonics (>1.5 kHz)
         * from the tone-shaped signal.  Blending this back in adds "bite" and
         * articulation without raising the overall level — useful for cutting
         * through a dense mix.
         *
         * High-pass formula:  y[n] = α · (y[n-1] + x[n] − x[n-1])
         * This is the standard RC high-pass discretised with the forward
         * Euler method.                                                       */
        float hp_out   = hp_alpha * (s_hp_y1 + toned - s_hp_x1);
        s_hp_x1        = toned;
        s_hp_y1        = hp_out;

        float present  = toned + hp_out * presence;

        /* Hard limit the combined signal to prevent inter-stage overload.    */
        if (present >  1.0f) present =  1.0f;
        if (present < -1.0f) present = -1.0f;

        /* ── 6. Output level ─────────────────────────────────────────────────
         * Analogous to the Level knob on a hardware pedal: compensates for
         * loudness changes caused by adjusting gain, and lets the player
         * match unity gain with the bypassed signal.                         */
        out[i] = present * level;
    }
}

/* ── Public init ──────────────────────────────────────────────────────────── */

void pedal_dist_init(uint8_t slot_id, float sample_rate)
{
    s_sample_rate = sample_rate;

    /* Conservative defaults — the frontend overwrites these on connect.
     * Mid-range gain with moderate brightness and no presence boost produces
     * a recognisable distortion tone immediately on first enable.            */
    s_params.gain     = 0.5f;
    s_params.tone     = 0.5f;
    s_params.presence = 0.3f;
    s_params.level    = 0.6f;

    /* Zero all filter memory to prevent clicks when first enabled.           */
    s_lp_z1 = 0.0f;
    s_hp_x1 = 0.0f;
    s_hp_y1 = 0.0f;
    s_dc_x1 = 0.0f;
    s_dc_y1 = 0.0f;

    pedal_registry_register(slot_id, dist_on_params, dist_on_process);
}
