import React, { useState, useRef } from 'react';
import type { PedalState } from './PedalOverlay';
import './Profile.css';

interface ProfileProps {
  username:         string;
  onUsernameChange: (name: string) => void;
  pedalStates:      Record<string, PedalState>;
  presetCount:      number;
  sessionCount:     number;
}

const AVATAR_COLORS = [
  'linear-gradient(135deg, #8400ff, #2d0630)',
  'linear-gradient(135deg, #0066ff, #001a4d)',
  'linear-gradient(135deg, #ff6600, #4d1f00)',
  'linear-gradient(135deg, #00cc88, #004d33)',
  'linear-gradient(135deg, #ff0066, #4d0022)',
];

const Profile: React.FC<ProfileProps> = ({
  username, onUsernameChange, pedalStates, presetCount, sessionCount,
}) => {
  const [editing,     setEditing]     = useState(false);
  const [draft,       setDraft]       = useState(username);
  const [avatarColor, setAvatarColor] = useState(0);
  const [saved,       setSaved]       = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const initial      = username?.[0]?.toUpperCase() || '?';
  const activeCount  = Object.values(pedalStates).filter(s => s.enabled).length;
  const totalCount   = Object.keys(pedalStates).length;
  const pedalDisplay = totalCount > 0 ? `${activeCount}/${totalCount}` : '—';

  const handleSave = () => {
    if (draft.trim()) {
      onUsernameChange(draft.trim().toUpperCase());
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
    setEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter')  handleSave();
    if (e.key === 'Escape') { setDraft(username); setEditing(false); }
  };

  const joinDate = new Date().toLocaleDateString('en-AU', {
    month: 'long', year: 'numeric',
  });

  return (
    <div className="profile-page">
      <div className="profile-card">

        {/* ── Avatar ── */}
        <div className="profile-avatar-section">
          <div
            className="profile-avatar"
            style={{ background: AVATAR_COLORS[avatarColor] }}
            onClick={() => setAvatarColor(c => (c + 1) % AVATAR_COLORS.length)}
            title="Click to change colour"
          >
            <span className="profile-avatar__initial">{initial}</span>
            <div className="profile-avatar__hint">change</div>
          </div>
          <div className="profile-swatches">
            {AVATAR_COLORS.map((bg, i) => (
              <button
                key={i}
                className={`profile-swatch${i === avatarColor ? ' profile-swatch--active' : ''}`}
                style={{ background: bg }}
                onClick={() => setAvatarColor(i)}
                aria-label={`Colour ${i + 1}`}
              />
            ))}
          </div>
        </div>

        {/* ── Username ── */}
        <div className="profile-identity">
          {editing ? (
            <div className="profile-edit-row">
              <input
                ref={inputRef}
                className="profile-name-input"
                value={draft}
                autoFocus
                maxLength={24}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Enter username…"
              />
              <button className="profile-btn profile-btn--save" onClick={handleSave}>Save</button>
              <button
                className="profile-btn profile-btn--cancel"
                onClick={() => { setDraft(username); setEditing(false); }}
              >✕</button>
            </div>
          ) : (
            <div className="profile-name-row">
              <h2 className="profile-name">{username || 'Unnamed'}</h2>
              <button
                className="profile-edit-btn"
                onClick={() => { setDraft(username); setEditing(true); }}
              >Edit</button>
            </div>
          )}
          {saved && <p className="profile-saved-notice">Username updated ✓</p>}
          <p className="profile-tag">@{(username || 'unnamed').toLowerCase().replace(/\s+/g, '_')}</p>
          <p className="profile-since">Member since {joinDate}</p>
        </div>

        <div className="profile-divider" />

        {/* ── Stats ── */}
        <div className="profile-stats">
          {[
            {
              label: 'Pedals Active',
              value: pedalDisplay,
              title: totalCount > 0
                ? `${activeCount} of ${totalCount} pedals currently enabled`
                : 'No pedals configured yet — open the Effects card',
            },
            {
              label: 'Presets Saved',
              value: presetCount > 0 ? String(presetCount) : '—',
              title: `${presetCount} preset file${presetCount !== 1 ? 's' : ''} saved this session`,
            },
            {
              label: 'Sessions',
              value: String(sessionCount),
              title: `You have entered Stanza ${sessionCount} time${sessionCount !== 1 ? 's' : ''}`,
            },
          ].map(({ label, value, title }) => (
            <div className="profile-stat" key={label} title={title}>
              <span className="profile-stat__value">{value}</span>
              <span className="profile-stat__label">{label}</span>
            </div>
          ))}
        </div>

        <div className="profile-divider" />

        {/* ── Gear / Signal Chain ── */}
        <div className="profile-gear">
          <h3 className="profile-section-title">Signal Chain</h3>
          <div className="profile-gear-grid">
            {[
              { name: 'EQ + Pre-Gain', key: 'Blurry Lights', icon: '⚡' },
              { name: 'Overdrive',     key: 'New York',      icon: '🔥' },
              { name: 'Spring Reverb', key: 'Bridge',        icon: '🌊' },
            ].map(({ name, key, icon }) => {
              const enabled = pedalStates[key]?.enabled ?? false;
              return (
                <div className="profile-gear-item" key={name}>
                  <span className="profile-gear-item__icon">{icon}</span>
                  <span className="profile-gear-item__name">{name}</span>
                  <span
                    className={`profile-gear-item__dot profile-gear-item__dot--${enabled ? 'online' : 'offline'}`}
                    title={enabled ? 'Enabled' : 'Disabled'}
                  />
                </div>
              );
            })}
          </div>
        </div>

      </div>
    </div>
  );
};

export default Profile;