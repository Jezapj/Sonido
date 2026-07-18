import React from 'react';
import './Settings.css';

type Theme = 'dark' | 'light';

// ── Shared settings shape ─────────────────────────────────────────────────────
// Exported so App.tsx can own the state and pass it down.

export interface AppSettings {
  animations:  boolean;       // Card hover effects / tilt — maps to MagicBento disableAnimations (inverted)
  particles:   boolean;       // Star particles on card hover — maps to MagicBento enableStars
  parallax:    boolean;       // Mouse-reactive floating lines — maps to FloatingLines parallax
  dockMag:     number;        // Dock icon magnification on hover — maps to Dock magnification
  bgPattern:   'dots' | 'grid'; // Global background texture (both themes)
  gridSpeed:   number;        // ShapeGrid animation speed (slider 1–20 → speed 0.1–2.0)
  audioBuffer: 512 | 1024;   // ESP32 DMA buffer size preference (takes effect on firmware recompile)
}

export const DEFAULT_SETTINGS: AppSettings = {
  animations:  true,
  particles:   true,
  parallax:    true,
  dockMag:     200,
  bgPattern:   'dots',
  gridSpeed:   5,
  audioBuffer: 1024,
};

// ── Props ─────────────────────────────────────────────────────────────────────

interface SettingsProps {
  theme:            Theme;
  onThemeChange:    (t: Theme) => void;
  username:         string;
  settings:         AppSettings;
  onSettingsChange: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}

// ── Sub-components ────────────────────────────────────────────────────────────

interface ToggleProps {
  checked:     boolean;
  onChange:    (v: boolean) => void;
  label:       string;
  description?: string;
  accent?:     string;
}

const Toggle: React.FC<ToggleProps> = ({
  checked, onChange, label, description, accent = '132, 0, 255',
}) => (
  <label className="settings-toggle-row">
    <div className="settings-toggle-text">
      <span className="settings-toggle-label">{label}</span>
      {description && <span className="settings-toggle-desc">{description}</span>}
    </div>
    <button
      role="switch"
      aria-checked={checked}
      className={`settings-toggle${checked ? ' settings-toggle--on' : ''}`}
      style={{
        '--toggle-accent': `rgba(${accent}, 1)`,
        '--toggle-glow':   `rgba(${accent}, 0.4)`,
      } as React.CSSProperties}
      onClick={() => onChange(!checked)}
    >
      <span className="settings-toggle__thumb" />
    </button>
  </label>
);

interface SliderProps {
  label:        string;
  description?: string;
  value:        number;
  min:          number;
  max:          number;
  step?:        number;
  unit?:        string;
  onChange:     (v: number) => void;
}

const Slider: React.FC<SliderProps> = ({
  label, description, value, min, max, step = 1, unit = '', onChange,
}) => (
  <div className="settings-slider-row">
    <div className="settings-toggle-text">
      <span className="settings-toggle-label">{label}</span>
      {description && <span className="settings-toggle-desc">{description}</span>}
    </div>
    <div className="settings-slider-right">
      <span className="settings-slider-value">{value}{unit}</span>
      <input
        type="range" min={min} max={max} step={step} value={value}
        className="settings-slider"
        onChange={e => onChange(Number(e.target.value))}
      />
    </div>
  </div>
);

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="settings-section">
    <h3 className="settings-section-title">{title}</h3>
    <div className="settings-section-body">{children}</div>
  </div>
);

// ── Main component ────────────────────────────────────────────────────────────

const Settings: React.FC<SettingsProps> = ({
  theme, onThemeChange, username, settings, onSettingsChange,
}) => {
  const set = <K extends keyof AppSettings>(key: K) =>
    (value: AppSettings[K]) => onSettingsChange(key, value);

  return (
    <div className="settings-page">
      <div className="settings-panel">

        <div className="settings-header">
          <div className="settings-header__icon">⚙</div>
          <div>
            <h2 className="settings-header__title">Settings</h2>
            <p className="settings-header__sub">
              Signed in as{' '}
              <span className="settings-header__user">{username || 'Unknown'}</span>
            </p>
          </div>
        </div>

        <div className="settings-scroll">

          {/* ── Appearance ── */}
          <Section title="Appearance">
            <div className="settings-theme-row">
              <div className="settings-toggle-text">
                <span className="settings-toggle-label">Theme</span>
                <span className="settings-toggle-desc">Global light / dark mode</span>
              </div>
              <div className="settings-theme-picker">
                <button
                  className={`settings-theme-btn${theme === 'dark' ? ' settings-theme-btn--active' : ''}`}
                  onClick={() => onThemeChange('dark')}
                >
                  <span className="settings-theme-btn__swatch settings-theme-btn__swatch--dark" />
                  Dark
                </button>
                <button
                  className={`settings-theme-btn${theme === 'light' ? ' settings-theme-btn--active' : ''}`}
                  onClick={() => onThemeChange('light')}
                >
                  <span className="settings-theme-btn__swatch settings-theme-btn__swatch--light" />
                  Light
                </button>
              </div>
            </div>
            <Toggle
              checked={settings.animations}
              onChange={set('animations')}
              label="UI Animations"
              description="Card hover effects, particles, tilt"
            />
            <Toggle
              checked={settings.particles}
              onChange={set('particles')}
              label="Particle Effects"
              description="Star particles on card hover"
            />
            <Toggle
              checked={settings.parallax}
              onChange={set('parallax')}
              label="Parallax Background"
              description="Mouse-reactive floating lines (dark mode)"
            />
            <div className="settings-theme-row">
              <div className="settings-toggle-text">
                <span className="settings-toggle-label">Background Pattern</span>
                <span className="settings-toggle-desc">Dots or animated grid — both themes</span>
              </div>
              <div className="settings-theme-picker">
                <button
                  className={`settings-theme-btn${settings.bgPattern === 'dots' ? ' settings-theme-btn--active' : ''}`}
                  onClick={() => set('bgPattern')('dots')}
                >
                  Dots
                </button>
                <button
                  className={`settings-theme-btn${settings.bgPattern === 'grid' ? ' settings-theme-btn--active' : ''}`}
                  onClick={() => set('bgPattern')('grid')}
                >
                  Grid
                </button>
              </div>
            </div>
          </Section>

          {/* ── Dock ── */}
          <Section title="Dock">
            <Slider
              label="Magnification"
              description="Max icon size on hover"
              value={settings.dockMag}
              min={60}
              max={300}
              step={10}
              unit="px"
              onChange={set('dockMag')}
            />
          </Section>

          {/* ── Grid ── */}
          <Section title="Background Grid">
            <Slider
              label="Scroll Speed"
              description="ShapeGrid animation speed (grid pattern only)"
              value={settings.gridSpeed}
              min={1}
              max={20}
              onChange={set('gridSpeed')}
            />
          </Section>

          {/* ── Audio ── */}
          <Section title="Audio Engine">
            <Toggle
              checked={settings.audioBuffer === 512}
              onChange={v => set('audioBuffer')(v ? 512 : 1024)}
              label="Low-Latency Mode"
              description="512 samples buffer (requires firmware recompile)"
              accent="0, 200, 136"
            />
            <div className="settings-info-row">
              <span className="settings-info-label">Buffer Size</span>
              <span className="settings-info-value settings-info-value--mono">
                {settings.audioBuffer} samples
              </span>
            </div>
            <div className="settings-info-row">
              <span className="settings-info-label">Sample Rate</span>
              <span className="settings-info-value settings-info-value--mono">47,991 Hz</span>
            </div>
            <div className="settings-info-row">
              <span className="settings-info-label">Bit Depth</span>
              <span className="settings-info-value settings-info-value--mono">32-bit float</span>
            </div>
          </Section>

          {/* ── About ── */}
          <Section title="About">
            <div className="settings-info-row">
              <span className="settings-info-label">App</span>
              <span className="settings-info-value">StanzaUI</span>
            </div>
            <div className="settings-info-row">
              <span className="settings-info-label">Version</span>
              <span className="settings-info-value settings-info-value--mono">0.1.0</span>
            </div>
            <div className="settings-info-row">
              <span className="settings-info-label">Runtime</span>
              <span className="settings-info-value">Tauri 2 · ESP32 I²S</span>
            </div>
          </Section>

        </div>
      </div>
    </div>
  );
};

export default Settings;