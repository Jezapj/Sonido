#include "pedal_phaser.h"
#include "pedal_registry.h"
#include <math.h>
#include <string.h>
#include <stdint.h>

/* ── Parameter struct ─────────────────────────────────────────────────────────
 *
 * Field order MUST match the 'Good Boy' knob array in PEDAL_DEFS inside
 * PedalOverlay.tsx so that the serial packet maps correctly via memcpy.
 *
 *   rate      0.1–5.0  Hz    LFO sweep speed
 *   depth     0.0–1.0        modulation width (fraction of the sweep range used)
 *   feedback  0.0–0.9        resonance — routes chain output back to input
 *   mix       0.0–1.0        wet/dry blend
 * ─────────────────────────────────────────────────────────────────────────── */
typedef struct {
    float rate;
    float depth;
    float feedback;
    float mix;
} phaser_params_t;

/* ── All-pass stage state ─────────────────────────────────────────────────────
 *
 * Each first-order all-pass filter needs two memory cells:
 *   x1 — the input one sample ago   (x[n-1])
 *   y1 — the output one sample ago  (y[n-1])
 *
 * Difference equation:
 *   y[n] = a·(x[n] − y[n-1]) + x[n-1]
 *
 * Transfer function (z-domain):
 *   H(z) = (a + z⁻¹) / (1 + a·z⁻¹)
 *
 * The coefficient `a` determines the frequency at which the phase shift is
 * exactly −90°.  At that frequency, when the four all-pass outputs are summed
 * with the dry signal, complete cancellation (a notch) occurs.
 * Moving `a` via the LFO sweeps the notch frequency through the spectrum.
 */
#define PHASER_STAGES 4

typedef struct {
    float x1;
    float y1;
} ap_state_t;

/* ── Static state ─────────────────────────────────────────────────────────── */

static phaser_params_t s_params;
static float           s_sample_rate = 48000.0f;

static ap_state_t s_stages[PHASER_STAGES]; /* all-pass stage memories         */
static float      s_lfo_phase  = 0.0f;    /* LFO phase in [0, 1)              */
static float      s_feedback_z1 = 0.0f;   /* last output of the AP chain      */

/* DC blocker state — prevents a biased input from generating an audible
   DC offset at the phaser output which would shift the waveform asymmetrically
   and waste headroom.                                                          */
static float s_dc_x1 = 0.0f;
static float s_dc_y1 = 0.0f;

/* ── Registry callbacks ───────────────────────────────────────────────────── */

static void phaser_on_params(const float *params, uint8_t n_params)
{
    /* Validate exact byte count before touching s_params. */
    if ((uint32_t)n_params * sizeof(float) != sizeof(phaser_params_t)) return;
    memcpy(&s_params, params, sizeof(phaser_params_t));
}

static void phaser_on_process(float *in, float *out, int frames)
{
    /*
     * Pre-compute per-block scalars.
     *
     * lfo_inc   — LFO phase advance per sample.
     *             Accumulating in normalised [0, 1) phase avoids the slow
     *             drift that would occur if we accumulated the angle in radians
     *             over millions of samples.
     *
     * fc_center — the middle of the sweep range (Hz).
     *             The LFO oscillates around this point.
     *
     * fc_swing  — half-width of the frequency sweep at depth = 1.0.
     *             With center=1000 and swing=900 the range is 100–1900 Hz,
     *             covering most of the guitar/voice fundamental band.
     *
     * feedback  — clamped to keep the IIR chain stable.  Values approaching
     *             1.0 create very sharp, resonant notches; above ~0.95 the
     *             chain can ring uncontrollably.
     *
     * mix / dry — complementary blend coefficients.
     */
    const float lfo_inc    = s_params.rate / s_sample_rate;
    const float fc_center  = 1000.0f;
    const float fc_swing   = 900.0f;

    const float depth = s_params.depth    < 0.0f ? 0.0f
                      : s_params.depth    > 1.0f ? 1.0f
                      : s_params.depth;

    const float fb    = s_params.feedback < 0.0f  ? 0.0f
                      : s_params.feedback > 0.95f ? 0.95f
                      : s_params.feedback;

    const float mix   = s_params.mix < 0.0f ? 0.0f
                      : s_params.mix > 1.0f ? 1.0f
                      : s_params.mix;
    const float dry   = 1.0f - mix;

    for (int i = 0; i < frames; i++)
    {
        float x = in[i];

        /* ── 1. DC block ────────────────────────────────────────────────────
         * y[n] = x[n] − x[n-1] + R·y[n-1]   (R = 0.995 ≈ 22 Hz cutoff)
         * Keeps the signal centred so the symmetric all-pass chain produces
         * equal notch depth on positive and negative half-cycles.            */
        float dc_out = x - s_dc_x1 + 0.995f * s_dc_y1;
        s_dc_x1 = x;
        s_dc_y1 = dc_out;
        x = dc_out;

        /* ── 2. Sine LFO ────────────────────────────────────────────────────
         * Phase is normalised to [0, 1) so it never accumulates floating-point
         * error regardless of how long the pedal runs.                        */
        float lfo = sinf(2.0f * (float)M_PI * s_lfo_phase);
        s_lfo_phase += lfo_inc;
        if (s_lfo_phase >= 1.0f) s_lfo_phase -= 1.0f;

        /* ── 3. Modulated centre frequency ─────────────────────────────────
         * fc oscillates between (center − swing·depth) and (center + swing·depth).
         * Clamped to [50, 4500] Hz to keep the all-pass coefficient `a` in a
         * numerically well-behaved range and to avoid aliasing near Nyquist.  */
        float fc = fc_center + lfo * fc_swing * depth;
        if (fc <   50.0f) fc =   50.0f;
        if (fc > 4500.0f) fc = 4500.0f;

        /* ── 4. All-pass coefficient ─────────────────────────────────────────
         *
         * For a first-order all-pass the coefficient that places the −90° phase
         * point at fc is:
         *
         *   a = (tan(π·fc/fs) − 1) / (tan(π·fc/fs) + 1)
         *
         * `a` is in (−1, 0) for fc < fs/4  (i.e. below 12 kHz at 48 kHz).
         * The same coefficient is used for all four stages each sample, so
         * tanf() is called exactly once per sample regardless of stage count.  */
        float t = tanf((float)M_PI * fc / s_sample_rate);
        float a = (t - 1.0f) / (t + 1.0f);

        /* ── 5. Feedback mix ─────────────────────────────────────────────────
         * A fraction of the previous all-pass chain output is added back to the
         * input before the chain runs.  This deepens and sharpens the notches:
         *
         *   feedback = 0.0 → gentle shimmer (Phase 90 style)
         *   feedback = 0.5 → pronounced whoosh with tonal resonance
         *   feedback = 0.9 → near self-oscillation, very intense
         *
         * Using the previous frame's output introduces exactly one sample of
         * delay in the feedback path, which is inaudible at 48 kHz.          */
        float ap_in = x + s_feedback_z1 * fb;

        /* ── 6. Four-stage all-pass chain ────────────────────────────────────
         *
         * Each stage applies:
         *   y[n] = a·(x[n] − y[n-1]) + x[n-1]
         *
         * Cascading four stages creates four notches spaced through the
         * spectrum, not just one.  The exact positions depend on `a` and the
         * relative phase between stages.  As the LFO sweeps `a`, all four
         * notches move together, creating the multi-voiced phaser character
         * associated with the MXR Phase 90 and similar classics.              */
        float ap_out = ap_in;
        for (int s = 0; s < PHASER_STAGES; s++)
        {
            float y = a * (ap_out - s_stages[s].y1) + s_stages[s].x1;
            s_stages[s].x1 = ap_out;
            s_stages[s].y1 = y;
            ap_out = y;
        }

        /* Store the chain output so the next sample can use it as feedback.   */
        s_feedback_z1 = ap_out;

        /* ── 7. Dry / wet mix ────────────────────────────────────────────────
         *
         * mix = 0.0 → dry signal only  (bypass)
         * mix = 0.5 → classic phaser blend — cancellations are audible but the
         *             original attack and body of the note remain present
         * mix = 1.0 → full wet; the notches are maximally deep but the sound
         *             can become thin because the fundamentals are cancelled   */
        out[i] = x * dry + ap_out * mix;
    }
}

/* ── Public init ──────────────────────────────────────────────────────────── */

void pedal_phaser_init(uint8_t slot_id, float sample_rate)
{
    s_sample_rate = sample_rate;

    /* Zero all filter memory so there is no transient click when the pedal
     * is first enabled.  All-pass state from a previous disable / re-enable
     * cycle is discarded; the brief ~1-sample settling is inaudible.          */
    memset(s_stages, 0, sizeof(s_stages));
    s_lfo_phase   = 0.0f;
    s_feedback_z1 = 0.0f;
    s_dc_x1       = 0.0f;
    s_dc_y1       = 0.0f;

    /* Musically useful defaults — a gentle sweep at half-depth with moderate
     * resonance and a 50/50 mix produces a recognisable phaser tone
     * immediately on first enable before the frontend connects.               */
    s_params.rate     = 0.5f;
    s_params.depth    = 0.8f;
    s_params.feedback = 0.4f;
    s_params.mix      = 0.5f;

    pedal_registry_register(slot_id, phaser_on_params, phaser_on_process);
}
