#include <math.h>
#include "dsp_chain.h"

static float limiter(float x, float threshold)
{
    if (x > threshold)  return threshold;
    if (x < -threshold) return -threshold;
    return x;
}

void dsp_chain_init(dsp_chain_t *dsp, float fs)
{
    dsp->sample_rate = fs;

    dcblock_init(&dsp->dc, 0.995f);

    biquad_init(&dsp->eq_low);
    biquad_init(&dsp->eq_mid);
    biquad_init(&dsp->eq_high);
}

void dsp_chain_update_params(dsp_chain_t *dsp,
                             dsp_params_t *params)
{
    biquad_set_peaking(&dsp->eq_low,
                       dsp->sample_rate,
                       params->eq_low_freq,
                       params->eq_low_q,
                       params->eq_low_gain_db);

    biquad_set_peaking(&dsp->eq_mid,
                       dsp->sample_rate,
                       params->eq_mid_freq,
                       params->eq_mid_q,
                       params->eq_mid_gain_db);

    biquad_set_peaking(&dsp->eq_high,
                       dsp->sample_rate,
                       params->eq_high_freq,
                       params->eq_high_q,
                       params->eq_high_gain_db);
}

float dsp_chain_process_sample(dsp_chain_t *dsp,
                               dsp_params_t *params,
                               float x)
{
    // DC removal
    x = dcblock_process(&dsp->dc, x);

    // Pre-gain
    x *= params->pre_gain;

    // EQ
    x = biquad_process(&dsp->eq_low, x);
    x = biquad_process(&dsp->eq_mid, x);
    x = biquad_process(&dsp->eq_high, x);

    // Output limiter
    x = limiter(x, params->limiter_threshold);

    return x;
}

void dsp_chain_process_block(dsp_chain_t *dsp,
                             dsp_params_t *params,
                             float *input,
                             float *output,
                             int block_size)
{
    for (int i = 0; i < block_size; i++)
    {
        output[i] = dsp_chain_process_sample(dsp, params, input[i]);
    }
}
