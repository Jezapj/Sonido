#include "pedal_octave.h"
#include "pedal_registry.h"
#include <math.h>
#include <string.h>
#include <stdint.h>

/*
 * WSOLA Pitch Shifter
 * ───────────────────────────────────────────────────────────────────────────
 * Two Hann-windowed grains read from a circular delay buffer at pitch_ratio
 * samples per output sample.  At each grain reset, instead of jumping blindly
 * to the ideal analysis position, WSOLA searches ±SEARCH_WIN around it for
 * the candidate position whose signal most resembles the most-recently written
 * input (maximum cross-correlation).
 *
 * For a guitar playing a sustained note, the correlation peaks at positions
 * that are integer multiples of the pitch period behind the write head —
 * aligning grain boundaries to natural waveform cycles without any explicit
 * pitch-detection step.  The result is rock-solid pitch across the full guitar
 * range: a scale played through the pedal sounds like the same scale
 * transposed by the chosen interval.
 *
 * SEARCH_WIN = 150 covers the optimal alignment for every guitar string:
 *   note  period (samples @ 47991 Hz)  optimal delta for R=0.5
 *   ────  ─────────────────────────── ──────────────────────────
 *   E2      582                         −134  (within ±150 ✓)
 *   A2      436                         +  12  ✓
 *   D3      327                         +121  ✓
 *   G3      245                          + 63  ✓  (or −119)
 *   B3      194                          + 64  ✓
 *   E4      146                          + 10  ✓
 *
 * Cost:  (2 × 150 + 1) × 64 = 19 264 MACs per grain reset.
 *        Two resets per GRAIN_SIZE = 1024 samples, amortised → ~38 MACs/sample.
 *        At 240 MHz LX6: < 0.35 ms spike per block, < 2% average overhead.
 */

/* ── Constants ──────────────────────────────────────────────────────────────── */

#define GRAIN_SIZE   1024
#define GRAIN_HALF   (GRAIN_SIZE >> 1)
#define BUF_SIZE     8192
#define BUF_MASK     (BUF_SIZE - 1)   /* BUF_SIZE must be a power of 2 */

/* WSOLA search parameters */
#define CORR_LEN     64    /* cross-correlation window length (samples)   */
#define SEARCH_WIN   150   /* search range in each direction (samples)    */

/* ── Parameter struct ────────────────────────────────────────────────────────── */

typedef struct {
    float shift;   /* [−2.0, +2.0]  octave shift  */
    float mix;     /* [ 0.0,  1.0]  wet / dry      */
    float level;   /* [ 0.0,  1.0]  output gain    */
} oct_params_t;

/* ── Static state ────────────────────────────────────────────────────────────── */

static oct_params_t s_params;
static float        s_pitch_ratio = 1.0f;

static float s_buf[BUF_SIZE];   /* circular delay buffer                       */
static int   s_write_pos = 0;   /* next write index, always in [0, BUF_SIZE)   */

static float s_pos1   = 0.0f;   /* grain 1: fractional read position           */
static int   s_phase1 = 0;      /* grain 1: synthesis phase [0, GRAIN_SIZE)    */

static float s_pos2   = 0.0f;   /* grain 2: fractional read position           */
static int   s_phase2 = 0;      /* grain 2: staggered GRAIN_HALF for 50% OLA   */

static float s_hann[GRAIN_SIZE]; /* precomputed Hann window                    */

/* ── WSOLA grain-start search ────────────────────────────────────────────────── */

/*
 * wsola_start — find the pitch-aligned grain start position.
 *
 * Computes the ideal analysis start:
 *   ideal = write_pos − GRAIN_SIZE × pitch_ratio
 *
 * Then cross-correlates the CORR_LEN samples immediately before write_pos
 * (the freshest input we have) with each candidate position within
 * ±SEARCH_WIN of ideal.  Returns the candidate with the highest score.
 *
 * For a quasi-periodic guitar signal, the correlation peaks when the
 * candidate is displaced from ideal by an amount that aligns it to the
 * same phase of the pitch waveform as the current write head.  The grain
 * therefore starts at a pitch-period boundary, eliminating the flanging
 * that makes plain OLA sound out-of-tune on a scale.
 *
 * The + BUF_SIZE * 8 offset throughout ensures the argument to & BUF_MASK
 * is always strictly positive for any pitch_ratio ≤ 4 and any write_pos in
 * [0, BUF_SIZE).
 */
static int wsola_start(float pitch_ratio)
{
    /* Ideal position if we ignored phase alignment */
    int ideal = (s_write_pos - (int)(GRAIN_SIZE * pitch_ratio) + BUF_SIZE * 8) & BUF_MASK;

    /*
     * Source signal: the CORR_LEN samples that were just written before the
     * current write head.  This is the "template" we want the new grain to
     * continue from.
     */
    int src_base = (s_write_pos - CORR_LEN + BUF_SIZE * 8) & BUF_MASK;

    float best_score = -1e30f;
    int   best_delta = 0;

    for (int delta = -SEARCH_WIN; delta <= SEARCH_WIN; delta++)
    {
        int   cand = (ideal + delta + BUF_SIZE * 8) & BUF_MASK;
        float score = 0.0f;

        for (int k = 0; k < CORR_LEN; k++)
        {
            score += s_buf[(src_base + k) & BUF_MASK]
                   * s_buf[(cand    + k) & BUF_MASK];
        }

        if (score > best_score) {
            best_score = score;
            best_delta = delta;
        }
    }

    return (ideal + best_delta + BUF_SIZE * 8) & BUF_MASK;
}

/* ── Interpolated buffer read ────────────────────────────────────────────────── */

static float buf_read(float pos)
{
    int   i0   = (int)floorf(pos);
    float frac  = pos - (float)i0;
    int   idx0  = i0 & BUF_MASK;
    int   idx1  = (i0 + 1) & BUF_MASK;
    return s_buf[idx0] + frac * (s_buf[idx1] - s_buf[idx0]);
}

/* ── Registry callbacks ──────────────────────────────────────────────────────── */

static void oct_on_params(const float *params, uint8_t n_params)
{
    if ((uint32_t)n_params * sizeof(float) != sizeof(oct_params_t)) return;
    memcpy(&s_params, params, sizeof(oct_params_t));

    float shift = s_params.shift < -2.0f ? -2.0f
                : s_params.shift >  2.0f ?  2.0f
                : s_params.shift;
    s_pitch_ratio = powf(2.0f, shift);
}

static void oct_on_process(float *in, float *out, int frames)
{
    const float pr    = s_pitch_ratio;
    const float mix   = s_params.mix   < 0.0f ? 0.0f : s_params.mix   > 1.0f ? 1.0f : s_params.mix;
    const float level = s_params.level < 0.0f ? 0.0f : s_params.level > 1.0f ? 1.0f : s_params.level;
    const float dry   = 1.0f - mix;

    /* Bypass when shift ≈ 0: skip the grain path entirely (no added latency). */
    if (fabsf(pr - 1.0f) < 0.005f) {
        for (int i = 0; i < frames; i++) out[i] = in[i] * level;
        return;
    }

    for (int i = 0; i < frames; i++)
    {
        /* 1. Write new input sample */
        s_buf[s_write_pos] = in[i];
        s_write_pos = (s_write_pos + 1) & BUF_MASK;

        /* 2. Grain 1 */
        float g1 = buf_read(s_pos1) * s_hann[s_phase1];
        s_pos1  += pr;
        s_phase1++;

        if (s_phase1 >= GRAIN_SIZE) {
            s_phase1 = 0;
            /* WSOLA: find the pitch-aligned start rather than jumping blindly */
            s_pos1 = (float)wsola_start(pr);
        }

        /* 3. Grain 2 (staggered by GRAIN_HALF for 50% overlap) */
        float g2 = buf_read(s_pos2) * s_hann[s_phase2];
        s_pos2  += pr;
        s_phase2++;

        if (s_phase2 >= GRAIN_SIZE) {
            s_phase2 = 0;
            s_pos2 = (float)wsola_start(pr);
        }

        /*
         * 4. Sum grains.
         * Hann 50%-OLA property: hann(n) + hann(n + N/2) = 1 for all n,
         * so (g1 + g2) is already unity-normalised — no extra scale needed.
         */
        out[i] = (in[i] * dry + (g1 + g2) * mix) * level;
    }
}

/* ── Public init ─────────────────────────────────────────────────────────────── */

void pedal_octave_init(uint8_t slot_id, float sample_rate)
{
    (void)sample_rate;

    for (int k = 0; k < GRAIN_SIZE; k++)
        s_hann[k] = 0.5f * (1.0f - cosf(2.0f * (float)M_PI * (float)k / (float)GRAIN_SIZE));

    memset(s_buf, 0, sizeof(s_buf));

    /*
     * Start the write position in the middle of the buffer so both grain
     * heads have GRAIN_SIZE × 4 = 4096 samples of silent history available
     * immediately, covering even the largest pitch_ratio (4.0 for +2 octaves).
     */
    s_write_pos = BUF_SIZE / 2;

    s_phase1 = 0;
    s_pos1   = (float)(s_write_pos - GRAIN_SIZE);

    s_phase2 = GRAIN_HALF;
    s_pos2   = (float)(s_write_pos - GRAIN_SIZE + GRAIN_HALF);

    s_params.shift = -1.0f;
    s_params.mix   =  0.5f;
    s_params.level =  0.8f;
    s_pitch_ratio  =  0.5f;

    pedal_registry_register(slot_id, oct_on_params, oct_on_process);
}