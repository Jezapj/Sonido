#include "pedal_eq.h"
#include "pedal_registry.h"
#include "dsp_chain.h"
#include <string.h>

static dsp_chain_t  s_chain;
static dsp_params_t s_params;

/* ── Callbacks registered with pedal_registry ─────────────────────────────── */

static void eq_on_params(const float *params, uint8_t n_params)
{
    /*
     * Validate byte count against the C struct before memcpy-ing.
     * n_params floats must exactly fill dsp_params_t (11 × 4 = 44 bytes).
     */
    if ((uint32_t)n_params * sizeof(float) != sizeof(dsp_params_t)) return;

    memcpy(&s_params, params, sizeof(dsp_params_t));
    dsp_chain_update_params(&s_chain, &s_params);
}

static void eq_on_process(float *in, float *out, int frames)
{
    dsp_chain_process_block(&s_chain, &s_params, in, out, frames);
}

/* ── Public init ──────────────────────────────────────────────────────────── */

void pedal_eq_init(uint8_t slot_id, float sample_rate)
{
    dsp_chain_init(&s_chain, sample_rate);

    /* Safe defaults — frontend will overwrite these on connect. */
    s_params.pre_gain          = 1.0f;
    s_params.eq_low_freq       = 100.0f;
    s_params.eq_mid_freq       = 1000.0f;
    s_params.eq_high_freq      = 5000.0f;
    s_params.eq_low_q          = 0.7f;
    s_params.eq_mid_q          = 1.0f;
    s_params.eq_high_q         = 0.7f;
    s_params.eq_low_gain_db    = 0.0f;
    s_params.eq_mid_gain_db    = 0.0f;
    s_params.eq_high_gain_db   = -2.0f;
    s_params.limiter_threshold = 1.0f;

    dsp_chain_update_params(&s_chain, &s_params);

    pedal_registry_register(slot_id, eq_on_params, eq_on_process);
}
