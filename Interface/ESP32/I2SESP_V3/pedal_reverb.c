#include "pedal_reverb.h"
#include "pedal_registry.h"

#include <stdint.h>
#include <string.h>

/* ── Parameter struct ──────────────────────────────────────────────────────
 *
 * Field order MUST match the frontend knob ordering.
 *
 *   decay  0.0–1.0   controls reverb feedback / tail duration
 *   tone   0.0–1.0   dampening of high frequencies in reflections
 *   level  0.0–1.0   wet/dry output blend
 * ───────────────────────────────────────────────────────────────────────── */
typedef struct {
    float decay;
    float tone;
    float level;
} reverb_params_t;

/* ── Static state ───────────────────────────────────────────────────────── */

static reverb_params_t s_params;
static float s_sample_rate = 48000.0f;

/*
 * Four parallel delay lines create a dense ambience.
 * Different lengths prevent metallic ringing.
 */
#define RVB_DELAY_1 1423
#define RVB_DELAY_2 1789
#define RVB_DELAY_3 2153
#define RVB_DELAY_4 2711

static float s_delay_1[RVB_DELAY_1];
static float s_delay_2[RVB_DELAY_2];
static float s_delay_3[RVB_DELAY_3];
static float s_delay_4[RVB_DELAY_4];

static uint32_t s_idx_1 = 0;
static uint32_t s_idx_2 = 0;
static uint32_t s_idx_3 = 0;
static uint32_t s_idx_4 = 0;

/*
 * High-frequency damping filters.
 * These simulate the natural loss of treble energy in a room.
 */
static float s_lp_1 = 0.0f;
static float s_lp_2 = 0.0f;
static float s_lp_3 = 0.0f;
static float s_lp_4 = 0.0f;

/* ── Registry callbacks ─────────────────────────────────────────────────── */

static void reverb_on_params(const float *params, uint8_t n_params)
{
    if ((uint32_t)n_params * sizeof(float) != sizeof(reverb_params_t)) return;
    memcpy(&s_params, params, sizeof(reverb_params_t));
}

static void reverb_on_process(float *in, float *out, int frames)
{
    /*
     * decay:
     *   Controls the feedback amount.
     *   Higher values create longer tails.
     */
    const float feedback = 0.2f + s_params.decay * 0.77f;

    /*
     * tone:
     *   Controls damping cutoff.
     *   Lower tone values darken the reverb tail.
     */
    const float damp = 0.05f + s_params.tone * 0.45f;

    /*
     * level:
     *   Wet/dry blend.
     *   0 = fully dry, 1 = heavily reverberated.
     */
    const float wet = s_params.level;
    const float dry = 1.0f - (wet * 0.7f);

    for (int i = 0; i < frames; i++)
    {
        const float x = in[i];

        /* ── Read delay taps ───────────────────────────────────────────── */
        float d1 = s_delay_1[s_idx_1];
        float d2 = s_delay_2[s_idx_2];
        float d3 = s_delay_3[s_idx_3];
        float d4 = s_delay_4[s_idx_4];

        /* ── Tone damping filters ─────────────────────────────────────── */
        s_lp_1 += damp * (d1 - s_lp_1);
        s_lp_2 += damp * (d2 - s_lp_2);
        s_lp_3 += damp * (d3 - s_lp_3);
        s_lp_4 += damp * (d4 - s_lp_4);

        d1 = s_lp_1;
        d2 = s_lp_2;
        d3 = s_lp_3;
        d4 = s_lp_4;

        /*
         * Mix reflections together.
         * Averaging keeps the output controlled.
         */
        const float reverb_mix = (d1 + d2 + d3 + d4) * 0.25f;

        /* ── Write new samples into delay lines ───────────────────────── */
        s_delay_1[s_idx_1] = x + reverb_mix * feedback;
        s_delay_2[s_idx_2] = x + d1 * feedback;
        s_delay_3[s_idx_3] = x + d2 * feedback;
        s_delay_4[s_idx_4] = x + d3 * feedback;

        /* ── Advance circular buffers ─────────────────────────────────── */
        s_idx_1++;
        s_idx_2++;
        s_idx_3++;
        s_idx_4++;

        if (s_idx_1 >= RVB_DELAY_1) s_idx_1 = 0;
        if (s_idx_2 >= RVB_DELAY_2) s_idx_2 = 0;
        if (s_idx_3 >= RVB_DELAY_3) s_idx_3 = 0;
        if (s_idx_4 >= RVB_DELAY_4) s_idx_4 = 0;

        /* ── Final wet/dry mix ────────────────────────────────────────── */
        out[i] = (x * dry) + (reverb_mix * wet);
    }
}

/* ── Public init ────────────────────────────────────────────────────────── */

void pedal_reverb_init(uint8_t slot_id, float sample_rate)
{
    s_sample_rate = sample_rate;

    /* Default startup values */
    s_params.decay = 0.55f;
    s_params.tone  = 0.5f;
    s_params.level = 0.45f;

    /* Clear all delay memory */
    memset(s_delay_1, 0, sizeof(s_delay_1));
    memset(s_delay_2, 0, sizeof(s_delay_2));
    memset(s_delay_3, 0, sizeof(s_delay_3));
    memset(s_delay_4, 0, sizeof(s_delay_4));

    s_idx_1 = 0;
    s_idx_2 = 0;
    s_idx_3 = 0;
    s_idx_4 = 0;

    s_lp_1 = 0.0f;
    s_lp_2 = 0.0f;
    s_lp_3 = 0.0f;
    s_lp_4 = 0.0f;

    pedal_registry_register(slot_id, reverb_on_params, reverb_on_process);
}

