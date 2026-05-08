#include <Arduino.h>
#include "driver/i2s_std.h"
#include <string.h>

extern "C" {
    #include "pedal_registry.h"
    #include "pedal_eq.h"
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
// #define PEDAL_OVERDRIVE   1   // uncomment when pedal_od.c is added
// #define PEDAL_REVERB      2   // uncomment when pedal_reverb.c is added

// ── Audio config ──────────────────────────────────────────────────────────────
#define SAMPLE_RATE 47991
#define BLOCK_SIZE  64

// ── Packet protocol (host → ESP32) ───────────────────────────────────────────
// [0xAA][0x55][pedal_id][enabled][n_params][float×n][XOR checksum]
#define PKT_MAX_PARAMS  16
#define PKT_HEADER_SIZE 5
#define PKT_MAX_SIZE    (PKT_HEADER_SIZE + PKT_MAX_PARAMS * 4 + 1)

// ── I2S handles ───────────────────────────────────────────────────────────────
static i2s_chan_handle_t tx_handle;
static i2s_chan_handle_t rx_handle;

// ── Packet parser state ───────────────────────────────────────────────────────
static uint8_t pkt_buf[PKT_MAX_SIZE];
static int     pkt_idx      = 0;
static uint8_t pkt_n_params = 0;

// ─────────────────────────────────────────────────────────────────────────────
// check_serial_params()
//
// Non-blocking UART drain called once per audio block (after the blocking
// I2S read).  Parses complete packets and forwards them to the registry —
// no pedal-specific logic lives here.
// ─────────────────────────────────────────────────────────────────────────────
static void check_serial_params(void)
{
    while (Serial.available() > 0)
    {
        uint8_t b = (uint8_t)Serial.read();

        // ── Sync on magic bytes ───────────────────────────────────────────────
        if (pkt_idx == 0) {
            if (b == 0xAA) pkt_buf[pkt_idx++] = b;
            continue;
        }
        if (pkt_idx == 1) {
            if (b == 0x55) pkt_buf[pkt_idx++] = b;
            else           pkt_idx = 0;
            continue;
        }

        pkt_buf[pkt_idx++] = b;

        // Once the 5-byte header is complete we know the total packet length.
        if (pkt_idx == PKT_HEADER_SIZE) {
            pkt_n_params = pkt_buf[4];
            if (pkt_n_params > PKT_MAX_PARAMS) { pkt_idx = 0; continue; }
        }

        if (pkt_idx < PKT_HEADER_SIZE) continue;

        int expected = PKT_HEADER_SIZE + pkt_n_params * 4 + 1; // +1 checksum
        if (pkt_idx < expected) continue;

        // ── Verify XOR checksum ───────────────────────────────────────────────
        uint8_t csum = 0;
        for (int i = 2; i < expected - 1; i++) csum ^= pkt_buf[i];
        if (csum != pkt_buf[expected - 1]) { pkt_idx = 0; continue; }

        // ── Dispatch to registry (no else-if, no pedal knowledge here) ────────
        uint8_t  pedal_id = pkt_buf[2];
        bool     enabled  = (pkt_buf[3] != 0);
        float   *params   = (float *)(pkt_buf + PKT_HEADER_SIZE);

        pedal_dispatch_params(pedal_id, enabled, params, pkt_n_params);

        pkt_idx = 0;
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
    // pedal_od_init(PEDAL_OVERDRIVE, (float)SAMPLE_RATE);     // future
    // pedal_reverb_init(PEDAL_REVERB, (float)SAMPLE_RATE);    // future

    Serial.println("Pedal chain ready");
}

// ─────────────────────────────────────────────────────────────────────────────
// loop()
// ─────────────────────────────────────────────────────────────────────────────
void loop()
{
    int16_t rx_buf[BLOCK_SIZE * 2];
    int32_t tx_buf[BLOCK_SIZE * 2];
    float   dsp_input [BLOCK_SIZE];
    float   dsp_output[BLOCK_SIZE];
    float   dsp_temp  [BLOCK_SIZE]; // scratch for pedal chain ping-pong

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
        dsp_input[i] = s / 2147483648.0f;
    }

    // ── Pedal chain ───────────────────────────────────────────────────────────
    // Runs all enabled registered pedals in slot-index order.
    // Bypasses automatically when no pedals are active.
    pedal_process_chain(dsp_input, dsp_output, dsp_temp, frames);

    // ── Serial stream → host (mono int16 PCM for waveform visualisation) ─────
    int16_t serial_buf[BLOCK_SIZE];
    for (int i = 0; i < frames; i++) {
        float s = dsp_output[i];
        if (s >  1.0f) s =  1.0f;
        if (s < -1.0f) s = -1.0f;
        serial_buf[i] = (int16_t)(s * 32767.0f);
    }
    Serial.write((uint8_t *)serial_buf, frames * sizeof(int16_t));

    // ── Mono float → stereo int32 → DAC ──────────────────────────────────────
    for (int i = 0; i < frames; i++) {
        float s = dsp_output[i];
        if (s >  1.0f) s =  1.0f;
        if (s < -1.0f) s = -1.0f;
        int32_t sample    = (int32_t)(s * 2147483647.0f);
        tx_buf[i*2]       = sample;
        tx_buf[i*2 + 1]   = sample;
    }
    i2s_channel_write(tx_handle, tx_buf,
                      frames * 2 * sizeof(int32_t),
                      &bytes_written, portMAX_DELAY);
}
