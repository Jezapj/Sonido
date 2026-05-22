#include <Arduino.h>
#include "driver/i2s_std.h"
#include <string.h>

extern "C" {
    #include "pedal_registry.h"
    #include "pedal_eq.h"
    #include "pedal_chorus.h"
    #include "pedal_od.h"
    #include "pedal_dist.h"
    #include "pedal_phaser.h"
    #include "pedal_reverb.h"

    
    /*
     * To add a new pedal:
     *   1. Create pedal_xyz.c / pedal_xyz.h in this folder.
     *   2. #include "pedal_xyz.h" here.
     *   3. Add  #define PEDAL_XYZ_ID <n>  below.
     *   4. Call pedal_xyz_init(PEDAL_XYZ_ID, SAMPLE_RATE) in setup().
     *   Nothing else in this file needs to change.
     */
}

// ── Pedal slot IDs ────────────────────────────────────────────────────────────
// Must match PEDAL_IDS in PedalOverlay.tsx and pedal_id values in lib.rs.
#define PEDAL_EQ_PREGAIN  0
#define PEDAL_CHORUS   1
#define PEDAL_PHASER   2
#define PEDAL_OVERDRIVE   3
#define PEDAL_DISTORTION   4
#define PEDAL_REVERB   5
// #define PEDAL_REVERB      3   // uncomment when pedal_reverb.c is added

// ── Audio config ──────────────────────────────────────────────────────────────
#define SAMPLE_RATE 47991
#define BLOCK_SIZE  64

// ── Packet protocol ───────────────────────────────────────────────────────────
//
// Two packet types share the same 0xAA sync byte:
//
//   TYPE A — DSP params  (host → ESP32):
//     [0xAA][0x55][pedal_id][enabled][n_params][float×n][XOR checksum]
//
//   TYPE B — Loop audio  (host → ESP32):
//     [0xAA][0x57][n_samples][int16_sample_0_lo][int16_sample_0_hi]…[XOR checksum]
//     n_samples ≤ AUDIO_PKT_MAX_SAMPLES (64)
//
//   TYPE C — Looper config (host → ESP32, uses TYPE A with pedal_id = 0xFF):
//     params[0] = active  (1.0 = mix loop into output, 0.0 = bypass)
//     params[1] = mix     (0.0 – 1.0)
//
// Checksum for both types: XOR of every byte from index 2 to the byte before
// the checksum — identical scheme to the existing param packets.

#define PKT_MAX_PARAMS      16
#define PKT_HEADER_SIZE     5
#define AUDIO_PKT_MAX_SAMPLES 64

// Unified packet buffer — sized for the larger audio packet.
// 3 header + 64×2 sample bytes + 1 checksum = 132 bytes.
#define PKT_BUF_SIZE (3 + AUDIO_PKT_MAX_SAMPLES * 2 + 1)

// ── Looper playback ring buffer (on-chip) ─────────────────────────────────────
//
// The computer owns the full loop recording; we only need a small FIFO here
// to absorb the round-trip latency between the host sending a chunk and the
// next I2S block consuming it.  512 samples ≈ 10 ms at 48 kHz → 2 KB SRAM.
#define LOOPER_PLAY_BUF 512

static int16_t  s_play_buf[LOOPER_PLAY_BUF];
static int      s_play_write = 0;
static int      s_play_read  = 0;
static volatile int s_play_avail = 0;
static bool     s_looper_active  = false;
static float    s_loop_mix       = 0.7f;

// ── Unified packet parser state ───────────────────────────────────────────────
static uint8_t  s_pkt[PKT_BUF_SIZE];
static int      s_pkt_idx    = 0;
static uint8_t  s_pkt_type   = 0;      // 0x55 = params, 0x57 = audio, 0 = waiting
static uint8_t  s_n_params   = 0;      // filled once params header is complete
static uint8_t  s_n_audio    = 0;      // filled once audio header is complete

// ── I2S handles ───────────────────────────────────────────────────────────────
static i2s_chan_handle_t tx_handle;
static i2s_chan_handle_t rx_handle;

// ─────────────────────────────────────────────────────────────────────────────
// check_serial_params()
//
// Non-blocking UART drain called once per audio block.  Handles both TYPE A
// (param) and TYPE B (audio) packets in a single unified state machine.
// ─────────────────────────────────────────────────────────────────────────────
static void check_serial_params(void)
{
    while (Serial.available() > 0)
    {
        uint8_t b = (uint8_t)Serial.read();

        // ── Always re-sync on the magic start byte ────────────────────────
        if (b == 0xAA && s_pkt_idx == 0) {
            s_pkt[s_pkt_idx++] = b;
            continue;
        }

        // ── Second byte determines packet type ────────────────────────────
        if (s_pkt_idx == 1) {
            if (b == 0x55 || b == 0x57) {
                s_pkt_type = b;
                s_pkt[s_pkt_idx++] = b;
            } else {
                s_pkt_idx = 0; // lost sync — wait for next 0xAA
            }
            continue;
        }

        // ── Guard: abort on buffer overrun ────────────────────────────────
        if (s_pkt_idx >= PKT_BUF_SIZE) { s_pkt_idx = 0; continue; }

        s_pkt[s_pkt_idx++] = b;

        // ══════════════════════════════════════════════════════════════════
        // TYPE A — DSP parameter packet  [0xAA][0x55][id][en][n][data][cs]
        // ══════════════════════════════════════════════════════════════════
        if (s_pkt_type == 0x55)
        {
            // Once we have the 5-byte header we know the total length.
            if (s_pkt_idx == PKT_HEADER_SIZE) {
                s_n_params = s_pkt[4];
                if (s_n_params > PKT_MAX_PARAMS) { s_pkt_idx = 0; continue; }
            }
            if (s_pkt_idx < PKT_HEADER_SIZE) continue;

            int expected = PKT_HEADER_SIZE + s_n_params * 4 + 1;
            if (s_pkt_idx < expected) continue;

            // Verify checksum.
            uint8_t csum = 0;
            for (int i = 2; i < expected - 1; i++) csum ^= s_pkt[i];
            if (csum != s_pkt[expected - 1]) { s_pkt_idx = 0; continue; }

            uint8_t pedal_id = s_pkt[2];
            bool    enabled  = (s_pkt[3] != 0);
            float  *params   = (float *)(s_pkt + PKT_HEADER_SIZE);

            if (pedal_id == 0xFF) {
                // ── Looper config (outside pedal registry) ────────────────
                if (s_n_params >= 2) {
                    s_looper_active = (params[0] > 0.5f);
                    s_loop_mix      = params[1];
                }
            } else {
                pedal_dispatch_params(pedal_id, enabled, params, s_n_params);
            }

            s_pkt_idx = 0;
        }

        // ══════════════════════════════════════════════════════════════════
        // TYPE B — Loop audio packet  [0xAA][0x57][n][int16×n][cs]
        // ══════════════════════════════════════════════════════════════════
        else if (s_pkt_type == 0x57)
        {
            // Third byte is the sample count.
            if (s_pkt_idx == 3) {
                s_n_audio = s_pkt[2];
                if (s_n_audio > AUDIO_PKT_MAX_SAMPLES) { s_pkt_idx = 0; continue; }
            }
            if (s_pkt_idx < 3) continue;

            int expected = 3 + s_n_audio * 2 + 1;
            if (s_pkt_idx < expected) continue;

            // Verify checksum.
            uint8_t csum = 0;
            for (int i = 2; i < expected - 1; i++) csum ^= s_pkt[i];
            if (csum != s_pkt[expected - 1]) { s_pkt_idx = 0; continue; }

            // Push samples into the playback ring buffer.
            // Silently drop if the FIFO is full (host is faster than drain).
            int16_t *samps = (int16_t *)(s_pkt + 3);
            for (int i = 0; i < s_n_audio; i++) {
                if (s_play_avail < LOOPER_PLAY_BUF) {
                    s_play_buf[s_play_write] = samps[i];
                    s_play_write = (s_play_write + 1) % LOOPER_PLAY_BUF;
                    s_play_avail++;
                }
            }

            s_pkt_idx = 0;
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// setup()
// ─────────────────────────────────────────────────────────────────────────────
void setup()
{
    Serial.begin(2000000); // must match BAUD_RATE in useSerialStream.ts

    // ── RX: I2S0 slave — receives stereo 16-bit from STM32 ───────────────────
    i2s_chan_config_t rx_cfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_SLAVE);
    rx_cfg.dma_desc_num  = 8;
    rx_cfg.dma_frame_num = 64;
    i2s_new_channel(&rx_cfg, NULL, &rx_handle);

    i2s_std_config_t rx_std_cfg = {
        .clk_cfg  = I2S_STD_CLK_DEFAULT_CONFIG(SAMPLE_RATE),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(
                        I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO),
        .gpio_cfg = {
            .mclk = I2S_GPIO_UNUSED, .bclk = GPIO_NUM_15,
            .ws   = GPIO_NUM_16,     .dout = I2S_GPIO_UNUSED,
            .din  = GPIO_NUM_17,
        },
    };
    i2s_channel_init_std_mode(rx_handle, &rx_std_cfg);
    i2s_channel_enable(rx_handle);

    // ── TX: I2S1 master — sends 32-bit audio to PCM5102 DAC ──────────────────
    i2s_chan_config_t tx_cfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_1, I2S_ROLE_MASTER);
    tx_cfg.dma_desc_num  = 8;
    tx_cfg.dma_frame_num = 64;
    i2s_new_channel(&tx_cfg, &tx_handle, NULL);

    i2s_std_config_t tx_std_cfg = {
        .clk_cfg  = I2S_STD_CLK_DEFAULT_CONFIG(SAMPLE_RATE),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(
                        I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_STEREO),
        .gpio_cfg = {
            .mclk = I2S_GPIO_UNUSED, .bclk = GPIO_NUM_10,
            .ws   = GPIO_NUM_11,     .dout = GPIO_NUM_12,
            .din  = I2S_GPIO_UNUSED,
        },
    };
    i2s_channel_init_std_mode(tx_handle, &tx_std_cfg);
    i2s_channel_enable(tx_handle);

    // ── Register pedals ───────────────────────────────────────────────────────
    pedal_eq_init(PEDAL_EQ_PREGAIN, (float)SAMPLE_RATE);
    pedal_chorus_init(PEDAL_CHORUS, (float)SAMPLE_RATE);
    pedal_phaser_init(PEDAL_PHASER, (float)SAMPLE_RATE); 
    pedal_od_init(PEDAL_OVERDRIVE, (float)SAMPLE_RATE);  
    pedal_dist_init(PEDAL_DISTORTION, (float)SAMPLE_RATE);   
    pedal_reverb_init(PEDAL_REVERB, (float)SAMPLE_RATE);    

    Serial.println("Pedal chain ready");
}

// ─────────────────────────────────────────────────────────────────────────────
// loop()
// ─────────────────────────────────────────────────────────────────────────────
void loop()
{
    int16_t rx_buf[BLOCK_SIZE * 2];
    int32_t tx_buf[BLOCK_SIZE * 2];
    float   dsp_in  [BLOCK_SIZE];
    float   dsp_out [BLOCK_SIZE];
    float   dsp_temp[BLOCK_SIZE];

    size_t bytes_read    = 0;
    size_t bytes_written = 0;

    // Blocking I2S read — lowest jitter.
    i2s_channel_read(rx_handle, rx_buf, sizeof(rx_buf),
                     &bytes_read, portMAX_DELAY);

    // ── Check for incoming param packets (non-blocking) ───────────────────────
    // Called after the blocking read so it adds no latency to the audio path,
    // but drains the UART FIFO once per block (~1.3 ms @ 48 kHz, 64 frames).
    check_serial_params();

    int frames = bytes_read >> 2; // 4 bytes per stereo int16 frame

    // ── Stereo int16 → mono float ─────────────────────────────────────────────
    for (int i = 0; i < frames; i++) {
        int32_t s    = ((int32_t)rx_buf[i*2] + (int32_t)rx_buf[i*2+1]) << 15;
        dsp_in[i]    = s / 2147483648.0f;
    }

    // ── Pedal DSP chain ───────────────────────────────────────────────────────
    pedal_process_chain(dsp_in, dsp_out, dsp_temp, frames);

    // ── Looper playback mix ───────────────────────────────────────────────────
    //
    // When the host has sent loop audio and activated the looper (pedal_id 0xFF),
    // drain exactly `frames` samples from the ring buffer and add them to the
    // DSP output.  If the buffer runs dry (host latency spike) we skip silently
    // rather than reading stale data — a brief glitch is preferable to a click.
    if (s_looper_active && s_play_avail >= frames) {
        for (int i = 0; i < frames; i++) {
            float loop_s   = (float)s_play_buf[s_play_read] / 32767.0f;
            s_play_read    = (s_play_read + 1) % LOOPER_PLAY_BUF;
            dsp_out[i]    += loop_s * s_loop_mix;
            // Soft-clip the combined signal
            if (dsp_out[i] >  1.0f) dsp_out[i] =  1.0f;
            if (dsp_out[i] < -1.0f) dsp_out[i] = -1.0f;
        }
        s_play_avail -= frames;
    }

    // ── Serial stream → host (mono int16 PCM for waveform / looper capture) ──
    int16_t serial_buf[BLOCK_SIZE];
    for (int i = 0; i < frames; i++) {
        float s = dsp_out[i];
        if (s >  1.0f) s =  1.0f;
        if (s < -1.0f) s = -1.0f;
        serial_buf[i] = (int16_t)(s * 32767.0f);
    }
    Serial.write((uint8_t *)serial_buf, frames * sizeof(int16_t));

    // ── Mono float → stereo int32 → DAC ──────────────────────────────────────
    for (int i = 0; i < frames; i++) {
        float s = dsp_out[i];
        if (s >  1.0f) s =  1.0f;
        if (s < -1.0f) s = -1.0f;
        int32_t samp      = (int32_t)(s * 2147483647.0f);
        tx_buf[i*2]       = samp;
        tx_buf[i*2 + 1]   = samp;
    }
    i2s_channel_write(tx_handle, tx_buf,
                      frames * 2 * sizeof(int32_t),
                      &bytes_written, portMAX_DELAY);
}
