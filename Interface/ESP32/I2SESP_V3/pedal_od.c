#include "pedal_od.h"
#include "pedal_registry.h"
#include <string.h>
#include <stdint.h>

/* ── Parameter struct ────────────────────────────────────────────────────────
 *
 * Field order MUST match the 'New York' knob array in PEDAL_DEFS inside
 * PedalOverlay.tsx so that the serial packet maps correctly via memcpy.
 *
 *   drive  0.0–1.0   pre-gain before the waveshaper (more = more distortion)
 *   tone   0.0–1.0   blends low-pass → direct; 0 = warm/dark, 1 = bright
 *   level  0.0–1.0   post output volume
 * ─────────────────────────────────────────────────────────────────────────── */
typedef struct {
    float drive;
    float tone;
    float level;
} overdrive_params_t;

/* ── Static state ─────────────────────────────────────────────────────────── */

static overdrive_params_t s_params;
static float s_sample_rate = 48000.0f;

/* First-order IIR low-pass memory for the tone control. */
static float s_lp_z1 = 0.0f;

/* DC blocker state (simple first-order IIR high-pass).
   Removes any input offset before hard-driving the waveshaper,
   which prevents asymmetric clipping from a biased signal.       */
static float s_dc_x1 = 0.0f;
static float s_dc_y1 = 0.0f;

/* ── Waveshaper ───────────────────────────────────────────────────────────── */

/*
 * Cubic soft-clip:
 *
 *   x in (-1, 1)  →  y = 1.5x − 0.5x³   (smooth saturation curve)
 *   |x| >= 1      →  y = ±1              (hard limit)
 *
 * This gives a smooth compression of peaks while preserving the waveform
 * shape at low amplitudes — similar to the characteristic of a tube stage.
 * The cubic term introduces primarily odd harmonics (3rd, 5th, …) which
 * give the warm, musical quality associated with classic overdrive pedals.
 */
static float waveshape(float x)
{
    if (x >=  1.0f) return  1.0f;
    if (x <= -1.0f) return -1.0f;
    return 1.5f * x - 0.5f * x * x * x;
}

/* ── Registry callbacks ───────────────────────────────────────────────────── */

static void od_on_params(const float *params, uint8_t n_params)
{
    /* Validate exact byte count against our param struct. */
    if ((uint32_t)n_params * sizeof(float) != sizeof(overdrive_params_t)) return;
    memcpy(&s_params, params, sizeof(overdrive_params_t));
}

static void od_on_process(float *in, float *out, int frames)
{
    /*
     * Signal path (per sample):
     *
     *   input → DC block → drive gain → waveshaper → tone blend → level → output
     *
     * Constants are computed once per block for efficiency.
     */

    /* Drive: maps [0, 1] → pre-gain of [1×, 30×].
       At drive=0 the signal barely clips (clean with subtle harmonics).
       At drive=1 the signal is pushed 30× into the waveshaper (heavy clip). */
    const float drive_gain = 1.0f + s_params.drive * 29.0f;

    /* Tone low-pass coefficient.
       Cutoff frequency sweeps 500 Hz (tone=0, warm) → 10 kHz (tone=1, bright).
       Using the bilinear first-order IIR formula:  α = ωc / (ωc + ωs/2)
       where ωc = 2π·fc  and  ωs = 2π·fs.  Simplified:              */
    const float fc    = 500.0f + s_params.tone * 9500.0f;
    const float alpha = fc / (fc + s_sample_rate * 0.159154f);
                        /* 0.159154 ≈ 1 / (2π)                        */

    const float tone  = s_params.tone;
    const float level = s_params.level;

    for (int i = 0; i < frames; i++)
    {
        float x = in[i];

        /* ── 1. DC block ───────────────────────────────────────────────────
         * y[n] = x[n] − x[n-1] + R·y[n-1]   (R = 0.995 gives ~22 Hz cutoff)
         * Prevents a biased input from creating asymmetric, buzzy distortion. */
        float dc_out = x - s_dc_x1 + 0.995f * s_dc_y1;
        s_dc_x1 = x;
        s_dc_y1 = dc_out;
        x = dc_out;

        /* ── 2. Drive stage ────────────────────────────────────────────────
         * Multiply the signal so peaks exceed ±1 and get shaped by the
         * waveshaper.  More drive = more of the waveform gets clipped.    */
        float driven = x * drive_gain;

        /* ── 3. Soft-clip waveshaper ───────────────────────────────────────
         * Cubic curve maps the driven signal smoothly into (−1, 1).        */
        float clipped = waveshape(driven);

        /* ── 4. Tone control ───────────────────────────────────────────────
         * A first-order IIR low-pass is applied to the clipped signal.
         * The tone knob blends between the filtered and unfiltered output:
         *   tone = 0 → fully low-passed  (warm, dark)
         *   tone = 1 → fully unfiltered  (bright, cutting)                */
        s_lp_z1     = alpha * clipped + (1.0f - alpha) * s_lp_z1;
        float toned = tone * clipped + (1.0f - tone) * s_lp_z1;

        /* ── 5. Output level ───────────────────────────────────────────────
         * User-controlled post volume, analogous to the Level knob on a
         * hardware pedal.  Allows compensation for the loudness change
         * that occurs when adjusting drive.                               */
        out[i] = toned * level;
    }
}

/* ── Public init ──────────────────────────────────────────────────────────── */

void pedal_od_init(uint8_t slot_id, float sample_rate)
{
    s_sample_rate = sample_rate;

    /* Conservative safe defaults — frontend will overwrite on connect. */
    s_params.drive = 0.5f;
    s_params.tone  = 0.5f;
    s_params.level = 0.8f;

    /* Clear all filter state so there is no click on first enable. */
    s_lp_z1 = 0.0f;
    s_dc_x1 = 0.0f;
    s_dc_y1 = 0.0f;

    pedal_registry_register(slot_id, od_on_params, od_on_process);
}
