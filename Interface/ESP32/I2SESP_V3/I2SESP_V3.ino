#include <Arduino.h>
#include "driver/i2s_std.h"

extern "C" {
    #include "dsp_chain.h"
}

#define SAMPLE_RATE 47991
#define BLOCK_SIZE  64

i2s_chan_handle_t tx_handle;
i2s_chan_handle_t rx_handle;

static dsp_chain_t dsp;
static dsp_params_t params;

void setup()
{
    Serial.begin(2000000);

    // ================= RX (I2S0 SLAVE - STEREO) =================
    i2s_chan_config_t rx_cfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_SLAVE);
    rx_cfg.dma_desc_num  = 8;
    rx_cfg.dma_frame_num = 64;

    i2s_new_channel(&rx_cfg, NULL, &rx_handle);

    i2s_std_config_t rx_std_cfg = {
        .clk_cfg  = I2S_STD_CLK_DEFAULT_CONFIG(SAMPLE_RATE),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(
                        I2S_DATA_BIT_WIDTH_16BIT,
                        I2S_SLOT_MODE_STEREO),
        .gpio_cfg = {
            .mclk = I2S_GPIO_UNUSED,
            .bclk = GPIO_NUM_15,
            .ws   = GPIO_NUM_16,
            .dout = I2S_GPIO_UNUSED,
            .din  = GPIO_NUM_17,
        },
    };

    i2s_channel_init_std_mode(rx_handle, &rx_std_cfg);
    i2s_channel_enable(rx_handle);

    // ================= TX (I2S1 MASTER - STEREO) =================
    i2s_chan_config_t tx_cfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_1, I2S_ROLE_MASTER);
    tx_cfg.dma_desc_num  = 8;
    tx_cfg.dma_frame_num = 64;

    i2s_new_channel(&tx_cfg, &tx_handle, NULL);

    i2s_std_config_t tx_std_cfg = {
        .clk_cfg  = I2S_STD_CLK_DEFAULT_CONFIG(SAMPLE_RATE),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(
                        I2S_DATA_BIT_WIDTH_32BIT,
                        I2S_SLOT_MODE_STEREO),
        .gpio_cfg = {
            .mclk = I2S_GPIO_UNUSED,
            .bclk = GPIO_NUM_10,
            .ws   = GPIO_NUM_11,
            .dout = GPIO_NUM_12,
            .din  = I2S_GPIO_UNUSED,
        },
    };

    i2s_channel_init_std_mode(tx_handle, &tx_std_cfg);
    i2s_channel_enable(tx_handle);

    // ================= DSP INIT =================
    dsp_chain_init(&dsp, SAMPLE_RATE);

    params.pre_gain          = 1.0f;

    params.eq_low_freq       = 100.0f;
    params.eq_mid_freq       = 1000.0f;
    params.eq_high_freq      = 5000.0f;

    params.eq_low_q          = 0.7f;
    params.eq_mid_q          = 1.0f;
    params.eq_high_q         = 0.7f;

    params.eq_low_gain_db    = 0.0f;
    params.eq_mid_gain_db    = 0.0f;
    params.eq_high_gain_db   = -2.0f;

    params.limiter_threshold = 1.0f;

    dsp_chain_update_params(&dsp, &params);
    Serial.println("DSP ready");
}

void loop()
{
    int16_t rx_buf[BLOCK_SIZE * 2];  // stereo 16-bit from STM32
    int32_t tx_buf[BLOCK_SIZE * 2];  // stereo 32-bit to PCM5102
    float   dsp_input[BLOCK_SIZE];   // mono float into DSP
    float   dsp_output[BLOCK_SIZE];  // mono float out of DSP

    size_t bytes_read    = 0;
    size_t bytes_written = 0;

    i2s_channel_read(rx_handle, rx_buf, sizeof(rx_buf),
                     &bytes_read, portMAX_DELAY);

    int frames = bytes_read >> 2; // 4 bytes per stereo frame

    // ================= STEREO INT16 → MONO FLOAT =================
    // Match V2 exactly: sum L+R then shift, but normalise to -1.0..+1.0
    for (int i = 0; i < frames; i++) {
        int32_t s    = ((int32_t)rx_buf[i * 2] + (int32_t)rx_buf[i * 2 + 1]) << 15;
        dsp_input[i] = s / 2147483648.0f;  // one value per frame, correct index
    }

    // ================= DSP =================
    dsp_chain_process_block(&dsp, &params, dsp_input, dsp_output, frames);

    // ================= SERIAL STREAM OUT (MONO INT16 PCM) =================
    int16_t serial_buf[BLOCK_SIZE];

    for (int i = 0; i < frames; i++) {
        float s = dsp_output[i];

        // Clamp to [-1, 1]
        if (s >  1.0f) s =  1.0f;
        if (s < -1.0f) s = -1.0f;

        // Convert to int16
        serial_buf[i] = (int16_t)(s * 32767.0f);
    }

    // Send as raw bytes (IMPORTANT: not Serial.print)
    Serial.write((uint8_t*)serial_buf, frames * sizeof(int16_t));
    

    // ================= MONO FLOAT → STEREO INT32 =================
    for (int i = 0; i < frames; i++) {
        float s = dsp_output[i];
        if (s >  1.0f) s =  1.0f;   // both clamps use s, not mixed variables
        if (s < -1.0f) s = -1.0f;
        int32_t sample    = (int32_t)(s * 2147483647.0f);
        tx_buf[i * 2]     = sample;
        tx_buf[i * 2 + 1] = sample;
    }

    i2s_channel_write(tx_handle, tx_buf,
                      frames * 2 * sizeof(int32_t),
                      &bytes_written, portMAX_DELAY);
}