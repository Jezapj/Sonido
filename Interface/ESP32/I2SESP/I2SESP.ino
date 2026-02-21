#include "driver/i2s_std.h"
#include "driver/gpio.h"
#include <Wire.h>

#define WM8960_ADDR 0x1A

// ===== I2C PINS (CHANGE IF NEEDED) =====
#define SDA_PIN 8
#define SCL_PIN 9

// ===== I2S HANDLES =====
i2s_chan_handle_t rx_handle;
i2s_chan_handle_t tx_handle;

// =====================================================
// WM8960 LOW LEVEL WRITE
// =====================================================
void wm8960_write(uint8_t reg, uint16_t val)
{
    Wire.beginTransmission(WM8960_ADDR);
    Wire.write((reg << 1) | ((val >> 8) & 0x01));
    Wire.write(val & 0xFF);
    Wire.endTransmission();
}

// =====================================================
// WM8960 INIT (24MHz crystal, slave I2S)
// =====================================================
void wm8960_init()
{
    wm8960_write(0x0F, 0x000); // Reset
    delay(50);

    wm8960_write(0x19, 0x1FE);
    wm8960_write(0x1A, 0x1F8);

    // I2S slave, 16-bit
    wm8960_write(0x07, 0x002);

    wm8960_write(0x05, 0x000); // DAC unmute

    wm8960_write(0x22, 0x100);
    wm8960_write(0x25, 0x100);

    wm8960_write(0x02, 0x17F);
    wm8960_write(0x03, 0x17F);
}

// =====================================================
// SETUP
// =====================================================
void setup()
{
    Serial.begin(115200);
    delay(2000);
    Serial.println("Starting...");

    Wire.begin(SDA_PIN, SCL_PIN);
    wm8960_init();

    // ================= RX (FROM STM32) =================
    i2s_chan_config_t chan_cfg =
        I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_SLAVE);

    chan_cfg.dma_desc_num = 16;
    chan_cfg.dma_frame_num = 64;

    i2s_new_channel(&chan_cfg, NULL, &rx_handle);

    i2s_std_config_t rx_std_cfg = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(48000),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(
                        I2S_DATA_BIT_WIDTH_16BIT,
                        I2S_SLOT_MODE_STEREO),
        .gpio_cfg = {
            .mclk = I2S_GPIO_UNUSED,
            .bclk = GPIO_NUM_15,
            .ws   = GPIO_NUM_16,
            .dout = I2S_GPIO_UNUSED,
            .din  = GPIO_NUM_17,
            .invert_flags = {
                .mclk_inv = false,
                .bclk_inv = false,
                .ws_inv   = false,
            },
        },
    };

    i2s_channel_init_std_mode(rx_handle, &rx_std_cfg);
    i2s_channel_enable(rx_handle);

    // ================= TX (TO WM8960) =================
    i2s_chan_config_t tx_cfg =
        I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_1, I2S_ROLE_MASTER);

    tx_cfg.dma_desc_num = 16;
    tx_cfg.dma_frame_num = 64;

    i2s_new_channel(&tx_cfg, &tx_handle, NULL);

    i2s_std_config_t tx_std_cfg = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(48000),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(
                        I2S_DATA_BIT_WIDTH_16BIT,
                        I2S_SLOT_MODE_STEREO),
        .gpio_cfg = {
            .mclk = I2S_GPIO_UNUSED,   // no MCLK needed
            .bclk = GPIO_NUM_4,
            .ws   = GPIO_NUM_5,
            .dout = GPIO_NUM_6,
            .din  = I2S_GPIO_UNUSED,
            .invert_flags = {
                .mclk_inv = false,
                .bclk_inv = false,
                .ws_inv   = false,
            },
        },
    };

    i2s_channel_init_std_mode(tx_handle, &tx_std_cfg);
    i2s_channel_enable(tx_handle);

    Serial.println("System ready");
}

// =====================================================
// LOOP
// =====================================================
void loop()
{
    int16_t samples[128];
    size_t bytes_read = 0;
    size_t bytes_written = 0;

    esp_err_t err = i2s_channel_read(
        rx_handle,
        samples,
        sizeof(samples),
        &bytes_read,
        portMAX_DELAY);

    if (err != ESP_OK) return;
    Serial.print("Value is:");
    Serial.println(samples[0]);

    // ===== DSP =====
    for (int i = 0; i < 128; i++)
    {
        float x = samples[i] / 32768.0f;
        float y = x; // passthrough
        samples[i] = (int16_t)(y * 32767.0f);
    }

    i2s_channel_write(
        tx_handle,
        samples,
        sizeof(samples),
        &bytes_written,
        portMAX_DELAY);
}
