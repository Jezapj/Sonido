#include <math.h>
#include "biquad.h"



void biquad_init(biquad_t *bq)
{
    bq->b0 = 1.0f;
    bq->b1 = 0.0f;
    bq->b2 = 0.0f;
    bq->a1 = 0.0f;
    bq->a2 = 0.0f;
    bq->z1 = 0.0f;
    bq->z2 = 0.0f;
}

float biquad_process(biquad_t *bq, float x)
{
    float y = bq->b0 * x + bq->z1;

    bq->z1 = bq->b1 * x - bq->a1 * y + bq->z2;
    bq->z2 = bq->b2 * x - bq->a2 * y;

    return y;
} 
void biquad_set_peaking(biquad_t *bq,
                        float fs,
                        float freq,
                        float Q,
                        float gain_db)
{
    float A  = powf(10.0f, gain_db / 40.0f);
    float w0 = 2.0f * M_PI * freq / fs;
    float cos_w0 = cosf(w0);
    float sin_w0 = sinf(w0);
    float alpha = sin_w0 / (2.0f * Q);

    float b0 = 1.0f + alpha * A;
    float b1 = -2.0f * cos_w0;
    float b2 = 1.0f - alpha * A;
    float a0 = 1.0f + alpha / A;
    float a1 = -2.0f * cos_w0;
    float a2 = 1.0f - alpha / A;

    bq->b0 = b0 / a0;
    bq->b1 = b1 / a0;
    bq->b2 = b2 / a0;
    bq->a1 = a1 / a0;
    bq->a2 = a2 / a0;
}
