#include <Arduino.h>
#include "driver/i2s_std.h"

i2s_chan_handle_t tx_handle;
i2s_chan_handle_t rx_handle;

void setup()
{
    Serial.begin(115200);
    delay(2000);
    Serial.println("Starting...");

    // ================= RX (FROM STM32 via I2S0 SLAVE) =================
    i2s_chan_config_t rx_cfg =
        I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_SLAVE);
    rx_cfg.dma_desc_num  = 16;
    rx_cfg.dma_frame_num = 64;

    ESP_ERROR_CHECK(i2s_new_channel(&rx_cfg, NULL, &rx_handle));

    i2s_std_config_t rx_std_cfg = {
        .clk_cfg  = I2S_STD_CLK_DEFAULT_CONFIG(48000),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(
                        I2S_DATA_BIT_WIDTH_16BIT,
                        I2S_SLOT_MODE_STEREO),
        .gpio_cfg = {
            .mclk  = I2S_GPIO_UNUSED,
            .bclk  = GPIO_NUM_15,
            .ws    = GPIO_NUM_16,
            .dout  = I2S_GPIO_UNUSED,
            .din   = GPIO_NUM_17,
            .invert_flags = {
                .mclk_inv = false,
                .bclk_inv = false,
                .ws_inv   = false,
            },
        },
    };

    ESP_ERROR_CHECK(i2s_channel_init_std_mode(rx_handle, &rx_std_cfg));
    ESP_ERROR_CHECK(i2s_channel_enable(rx_handle));
    Serial.println("RX I2S ready");

    // ================= TX (TO AMP via I2S1 MASTER) =================
    i2s_chan_config_t tx_cfg =
        I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_1, I2S_ROLE_MASTER);
    tx_cfg.dma_desc_num  = 16;
    tx_cfg.dma_frame_num = 64;

    ESP_ERROR_CHECK(i2s_new_channel(&tx_cfg, &tx_handle, NULL));

    i2s_std_config_t tx_std_cfg = {
        .clk_cfg  = I2S_STD_CLK_DEFAULT_CONFIG(48000),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(
                        I2S_DATA_BIT_WIDTH_16BIT,
                        I2S_SLOT_MODE_STEREO),
        .gpio_cfg = {
            .mclk  = I2S_GPIO_UNUSED,
            .bclk  = GPIO_NUM_10,
            .ws    = GPIO_NUM_11,
            .dout  = GPIO_NUM_12,
            .din   = I2S_GPIO_UNUSED,
            .invert_flags = {
                .mclk_inv = false,
                .bclk_inv = false,
                .ws_inv   = false,
            },
        },
    };

    ESP_ERROR_CHECK(i2s_channel_init_std_mode(tx_handle, &tx_std_cfg));
    ESP_ERROR_CHECK(i2s_channel_enable(tx_handle));
    Serial.println("TX I2S ready");

    Serial.println("Audio passthrough running");
}

void loop()
{
    int16_t samples[128];
    size_t bytes_read    = 0;
    size_t bytes_written = 0;

    esp_err_t err = i2s_channel_read(
        rx_handle,
        samples,
        sizeof(samples),
        &bytes_read,
        pdMS_TO_TICKS(1000));

    if (err == ESP_ERR_TIMEOUT) {
        Serial.println("Timeout - no data from STM32");
        return;
    }

    if (err != ESP_OK) {
        Serial.print("Read error: ");
        Serial.println(err);
        return;
    }

    // ================= DSP GOES HERE =================
    // samples[] contains interleaved stereo 16-bit signed PCM
    // samples[0] = Left ch 0, samples[1] = Right ch 0
    // samples[2] = Left ch 1, samples[3] = Right ch 1 etc.
    // Example: simple volume scale at 80%
    int num_samples = bytes_read / sizeof(int16_t);
    for (int i = 0; i < num_samples; i++) {
        samples[i] = (int16_t)(samples[i] * 0.8f);
    }
    // =================================================

    i2s_channel_write(
        tx_handle,
        samples,
        bytes_read,
        &bytes_written,
        pdMS_TO_TICKS(1000));
}