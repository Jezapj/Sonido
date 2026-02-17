#include <stdio.h>
#include <math.h>
#include "dsp/dsp_chain.h"

#define FS 48000
#define BLOCK 64

int main()
{
    dsp_chain_t dsp;
    dsp_params_t params;

    dsp_chain_init(&dsp, FS);

    // Default params
    params.pre_gain = 1.0f;

    params.eq_low_freq  = 100.0f;
    params.eq_mid_freq  = 1000.0f;
    params.eq_high_freq = 5000.0f;

    params.eq_low_q  = 0.7f;
    params.eq_mid_q  = 1.0f;
    params.eq_high_q = 0.7;

    params.eq_low_gain_db  = 0.0f;
    params.eq_mid_gain_db  = 0.0f;
    params.eq_high_gain_db = 0.0f;

    params.limiter_threshold = 0.995f;

    dsp_chain_update_params(&dsp, &params);

    float input[BLOCK];
    float output[BLOCK];

    for (int n = 0; n < FS; n += BLOCK)
    {
        for (int i = 0; i < BLOCK; i++)
        {
            float t = (float)(n + i) / FS;
            input[i] = sinf(2.0f * M_PI * 100.0f * t);
        }

        dsp_chain_process_block(&dsp, &params, input, output, BLOCK);

        for (int i = 0; i < BLOCK; i++)
            printf("Input: %f, Output: %f\n", input[i], output[i]);
    }

    return 0;
}
