import React, { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import { gsap } from 'gsap';
import './MagicBento.css';
import CircularGallery from './CircularGallery';
import RustStreamExample from './RustStreamExample';
import DashboardAudio from './DashboardAudio';
import PresetsCard from './PresetsCard';
import { PEDAL_DEFS, syncToHardware } from './PedalOverlay';
import type { PedalState } from './PedalOverlay';

export interface BentoCardProps {
  color?: string;
  title?: string;
  description?: string;
  label?: string;
  glowRgb?: string;
  textAutoHide?: boolean;
  disableAnimations?: boolean;
  content?: React.ReactNode;
  contentInteractive?: boolean;
}

export interface BentoProps {
  children?: React.ReactNode;
  textAutoHide?: boolean;
  enableStars?: boolean;
  enableSpotlight?: boolean;
  enableBorderGlow?: boolean;
  disableAnimations?: boolean;
  spotlightRadius?: number;
  particleCount?: number;
  enableTilt?: boolean;
  glowColor?: string;
  clickEffect?: boolean;
  enableMagnetism?: boolean;
  theme?: 'light' | 'dark';
  // ── Lifted pedal state (controlled from App) ──────────────────────────────
  pedalStates?:         Record<string, PedalState>;
  onPedalStatesChange?: (states: Record<string, PedalState>) => void;
  onPresetSaved?:       () => void;
}

const DEFAULT_PARTICLE_COUNT   = 12;
const DEFAULT_SPOTLIGHT_RADIUS = 300;
const DEFAULT_GLOW_COLOR       = '255, 0, 0';
const MOBILE_BREAKPOINT        = 768;

const cardColour = 'rgba(0, 0, 0, 0.92)';

const STATIC_CARDS: Omit<BentoCardProps, 'content'>[] = [
  { color: cardColour, title: 'Status',      description: 'Centralized data view', label: 'Dashboard', glowRgb: '132, 0, 255' },
  { color: cardColour, title: 'FFT',         description: 'Waveform analysis',     label: 'Waveform',  glowRgb: '0, 0, 255'   },
];

const CARD1_CONTENT = (
  <div style={{ height: '100%', position: 'relative', top: '0', color: 'black' }}>
    <DashboardAudio />
  </div>
);

const CARD2_CONTENT = (
  <div style={{ height: '100%', position: 'relative', top: '-75px', scale: '80%' }}>
    <RustStreamExample />
  </div>
);

// ── CardContent ───────────────────────────────────────────────────────────────

const CardContent: React.FC<{ content: React.ReactNode; interactive: boolean }> = ({
  content, interactive,
}) => (
  <div style={{
    pointerEvents: interactive ? 'auto' : 'none',
    position: 'relative', zIndex: interactive ? 10 : 1,
    width: '100%', height: '100%',
  }}>
    {content}
  </div>
);

// ── ParticleCard ──────────────────────────────────────────────────────────────

const createParticleElement = (x: number, y: number, color = DEFAULT_GLOW_COLOR): HTMLDivElement => {
  const el = document.createElement('div');
  el.className = 'particle';
  el.style.cssText = `
    position:absolute;width:4px;height:4px;border-radius:50%;
    background:rgba(${color},1);box-shadow:0 0 6px rgba(${color},0.6);
    pointer-events:none;z-index:100;left:${x}px;top:${y}px;
  `;
  return el;
};

const calculateSpotlightValues = (radius: number) => ({
  proximity:    radius * 0.5,
  fadeDistance: radius * 0.75,
});

const updateCardGlowProperties = (
  card: HTMLElement, mouseX: number, mouseY: number, glow: number, radius: number,
) => {
  const rect = card.getBoundingClientRect();
  card.style.setProperty('--glow-x',         `${((mouseX - rect.left) / rect.width)  * 100}%`);
  card.style.setProperty('--glow-y',         `${((mouseY - rect.top)  / rect.height) * 100}%`);
  card.style.setProperty('--glow-intensity', glow.toString());
  card.style.setProperty('--glow-radius',    `${radius}px`);
};

const ParticleCard: React.FC<{
  children: React.ReactNode;
  className?: string;
  disableAnimations?: boolean;
  style?: React.CSSProperties;
  particleCount?: number;
  glowColor?: string;
  enableTilt?: boolean;
  clickEffect?: boolean;
  enableMagnetism?: boolean;
}> = ({
  children, className = '', disableAnimations = false, style,
  particleCount = DEFAULT_PARTICLE_COUNT, glowColor = DEFAULT_GLOW_COLOR,
  enableTilt = true, clickEffect = false, enableMagnetism = false,
}) => {
  const cardRef               = useRef<HTMLDivElement>(null);
  const particlesRef          = useRef<HTMLDivElement[]>([]);
  const timeoutsRef           = useRef<ReturnType<typeof setTimeout>[]>([]);
  const isHoveredRef          = useRef(false);
  const memoizedParticles     = useRef<HTMLDivElement[]>([]);
  const particlesInitialized  = useRef(false);
  const magnetismAnimRef      = useRef<gsap.core.Tween | null>(null);

  const initializeParticles = useCallback(() => {
    if (particlesInitialized.current || !cardRef.current) return;
    const { width, height } = cardRef.current.getBoundingClientRect();
    memoizedParticles.current = Array.from({ length: particleCount }, () =>
      createParticleElement(Math.random() * width, Math.random() * height, glowColor),
    );
    particlesInitialized.current = true;
  }, [particleCount, glowColor]);

  const clearAllParticles = useCallback(() => {
    timeoutsRef.current.forEach(clearTimeout);
    timeoutsRef.current = [];
    magnetismAnimRef.current?.kill();
    particlesRef.current.forEach(p => {
      gsap.to(p, { scale: 0, opacity: 0, duration: 0.3, ease: 'back.in(1.7)', onComplete: () => p.parentNode?.removeChild(p) });
    });
    particlesRef.current = [];
  }, []);

  const animateParticles = useCallback(() => {
    if (!cardRef.current || !isHoveredRef.current) return;
    if (!particlesInitialized.current) initializeParticles();
    memoizedParticles.current.forEach((particle, index) => {
      const id = setTimeout(() => {
        if (!isHoveredRef.current || !cardRef.current) return;
        const clone = particle.cloneNode(true) as HTMLDivElement;
        cardRef.current.appendChild(clone);
        particlesRef.current.push(clone);
        gsap.fromTo(clone, { scale: 0, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.3, ease: 'back.out(1.7)' });
        gsap.to(clone, { x: (Math.random()-0.5)*100, y: (Math.random()-0.5)*100, rotation: Math.random()*360, duration: 2+Math.random()*2, ease: 'none', repeat: -1, yoyo: true });
        gsap.to(clone, { opacity: 0.3, duration: 1.5, ease: 'power2.inOut', repeat: -1, yoyo: true });
      }, index * 100);
      timeoutsRef.current.push(id);
    });
  }, [initializeParticles]);

  useEffect(() => {
    if (disableAnimations || !cardRef.current) return;
    const el = cardRef.current;

    const onEnter = () => {
      isHoveredRef.current = true;
      animateParticles();
      if (enableTilt) gsap.to(el, { rotateX: 5, rotateY: 5, duration: 0.3, ease: 'power2.out', transformPerspective: 1000 });
    };
    const onLeave = () => {
      isHoveredRef.current = false;
      clearAllParticles();
      if (enableTilt)       gsap.to(el, { rotateX: 0, rotateY: 0, duration: 0.3, ease: 'power2.out' });
      if (enableMagnetism)  gsap.to(el, { x: 0, y: 0, duration: 0.3, ease: 'power2.out' });
    };
    const onMove = (e: MouseEvent) => {
      if (!enableTilt && !enableMagnetism) return;
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left, y = e.clientY - rect.top;
      const cx = rect.width / 2, cy = rect.height / 2;
      if (enableTilt)      gsap.to(el, { rotateX: ((y-cy)/cy)*-10, rotateY: ((x-cx)/cx)*10, duration: 0.1, ease: 'power2.out', transformPerspective: 1000 });
      if (enableMagnetism) magnetismAnimRef.current = gsap.to(el, { x: (x-cx)*0.05, y: (y-cy)*0.05, duration: 0.3, ease: 'power2.out' });
    };
    const onClick = (e: MouseEvent) => {
      if (!clickEffect) return;
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left, y = e.clientY - rect.top;
      const maxD = Math.max(Math.hypot(x,y), Math.hypot(x-rect.width,y), Math.hypot(x,y-rect.height), Math.hypot(x-rect.width,y-rect.height));
      const ripple = document.createElement('div');
      ripple.style.cssText = `position:absolute;width:${maxD*2}px;height:${maxD*2}px;border-radius:50%;background:radial-gradient(circle,rgba(${glowColor},0.4) 0%,rgba(${glowColor},0.2) 30%,transparent 70%);left:${x-maxD}px;top:${y-maxD}px;pointer-events:none;z-index:1000;`;
      el.appendChild(ripple);
      gsap.fromTo(ripple, { scale: 0, opacity: 1 }, { scale: 1, opacity: 0, duration: 0.8, ease: 'power2.out', onComplete: () => ripple.remove() });
    };

    el.addEventListener('mouseenter', onEnter);
    el.addEventListener('mouseleave', onLeave);
    el.addEventListener('mousemove',  onMove);
    el.addEventListener('click',      onClick);
    return () => {
      isHoveredRef.current = false;
      el.removeEventListener('mouseenter', onEnter);
      el.removeEventListener('mouseleave', onLeave);
      el.removeEventListener('mousemove',  onMove);
      el.removeEventListener('click',      onClick);
      clearAllParticles();
    };
  }, [animateParticles, clearAllParticles, disableAnimations, enableTilt, enableMagnetism, clickEffect, glowColor]);

  return (
    <div
      ref={cardRef}
      className={`${className} particle-container`}
      style={{ ...style, position: 'relative', overflow: 'hidden', '--glow-rgb': (style as any)?.['--glow-rgb'] || glowColor } as any}
    >
      {children}
    </div>
  );
};

// ── GlobalSpotlight ───────────────────────────────────────────────────────────

const GlobalSpotlight: React.FC<{
  gridRef: React.RefObject<HTMLDivElement | null>;
  disableAnimations?: boolean;
  enabled?: boolean;
  spotlightRadius?: number;
  glowColor?: string;
}> = ({ gridRef, disableAnimations = false, enabled = true, spotlightRadius = DEFAULT_SPOTLIGHT_RADIUS, glowColor = DEFAULT_GLOW_COLOR }) => {
  const spotlightRef     = useRef<HTMLDivElement | null>(null);
  const isInsideSection  = useRef(false);

  useEffect(() => {
    if (disableAnimations || !gridRef?.current || !enabled) return;
    const spotlight = document.createElement('div');
    spotlight.className = 'global-spotlight';
    spotlight.style.cssText = `position:fixed;width:800px;height:800px;border-radius:50%;pointer-events:none;background:radial-gradient(circle,rgba(${glowColor},0.15) 0%,rgba(${glowColor},0.08) 15%,rgba(${glowColor},0.04) 25%,rgba(${glowColor},0.02) 40%,rgba(${glowColor},0.01) 65%,transparent 70%);z-index:200;opacity:0;transform:translate(-50%,-50%);mix-blend-mode:screen;`;
    document.body.appendChild(spotlight);
    spotlightRef.current = spotlight;

    const onMove = (e: MouseEvent) => {
      if (!spotlightRef.current || !gridRef.current) return;
      const section = gridRef.current.closest('.bento-section');
      const rect    = section?.getBoundingClientRect();
      const inside  = rect && e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
      isInsideSection.current = !!inside;
      const cards   = gridRef.current.querySelectorAll('.magic-bento-card');
      if (!inside) {
        gsap.to(spotlightRef.current, { opacity: 0, duration: 0.3, ease: 'power2.out' });
        cards.forEach(c => (c as HTMLElement).style.setProperty('--glow-intensity', '0'));
        return;
      }
      const { proximity, fadeDistance } = calculateSpotlightValues(spotlightRadius);
      let minDist = Infinity;
      cards.forEach(card => {
        const el   = card as HTMLElement;
        const cr   = el.getBoundingClientRect();
        const dist = Math.max(0, Math.hypot(e.clientX - (cr.left + cr.width/2), e.clientY - (cr.top + cr.height/2)) - Math.max(cr.width, cr.height)/2);
        minDist = Math.min(minDist, dist);
        const gi = dist <= proximity ? 1 : dist <= fadeDistance ? (fadeDistance - dist) / (fadeDistance - proximity) : 0;
        updateCardGlowProperties(el, e.clientX, e.clientY, gi, spotlightRadius);
      });
      gsap.to(spotlightRef.current, { left: e.clientX, top: e.clientY, duration: 0.1, ease: 'power2.out' });
      const tOpacity = minDist <= proximity ? 0.8 : minDist <= fadeDistance ? ((fadeDistance - minDist) / (fadeDistance - proximity)) * 0.8 : 0;
      gsap.to(spotlightRef.current, { opacity: tOpacity, duration: tOpacity > 0 ? 0.2 : 0.5, ease: 'power2.out' });
    };
    const onLeave = () => {
      isInsideSection.current = false;
      gridRef.current?.querySelectorAll('.magic-bento-card').forEach(c => (c as HTMLElement).style.setProperty('--glow-intensity', '0'));
      if (spotlightRef.current) gsap.to(spotlightRef.current, { opacity: 0, duration: 0.3, ease: 'power2.out' });
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseleave', onLeave);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseleave', onLeave);
      spotlightRef.current?.parentNode?.removeChild(spotlightRef.current);
    };
  }, [gridRef, disableAnimations, enabled, spotlightRadius, glowColor]);

  return null;
};

// ── CardInner ─────────────────────────────────────────────────────────────────

const CardInner: React.FC<{ card: BentoCardProps }> = ({ card }) => {
  const { label, title, description, content, contentInteractive = false } = card;
  return (
    <>
      <div className="magic-bento-card__header">
        <div className="magic-bento-card__label">{label}</div>
      </div>
      <div className="magic-bento-card__content">
        {content ? (
          <CardContent content={content} interactive={contentInteractive} />
        ) : (
          <>
            <h2 className="magic-bento-card__title">{title}</h2>
            <p className="magic-bento-card__description">{description}</p>
          </>
        )}
      </div>
    </>
  );
};

// ── Mobile detection ──────────────────────────────────────────────────────────

const useMobileDetection = () => {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth <= MOBILE_BREAKPOINT);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);
  return isMobile;
};

// ── MagicBento ────────────────────────────────────────────────────────────────

const MagicBento: React.FC<BentoProps> = ({
  textAutoHide          = true,
  enableStars           = true,
  enableSpotlight       = true,
  enableBorderGlow      = true,
  disableAnimations     = false,
  spotlightRadius       = DEFAULT_SPOTLIGHT_RADIUS,
  particleCount         = DEFAULT_PARTICLE_COUNT,
  enableTilt            = false,
  glowColor             = DEFAULT_GLOW_COLOR,
  clickEffect           = true,
  enableMagnetism       = true,
  theme                 = 'dark',
  // Controlled pedal state from App
  pedalStates:          externalPedalStates,
  onPedalStatesChange:  externalOnPedalStatesChange,
  onPresetSaved,
}) => {
  const gridRef   = useRef<HTMLDivElement>(null);
  const isMobile  = useMobileDetection();
  const shouldDisableAnimations = disableAnimations || isMobile;

  // ── Controlled / uncontrolled pedal state ─────────────────────────────────
  // When App passes pedalStates down we run in controlled mode; otherwise we
  // manage it internally so MagicBento still works standalone.
  const [internalPedalStates, setInternalPedalStates] = useState<Record<string, PedalState>>({});

  const pedalStates    = externalPedalStates          !== undefined ? externalPedalStates          : internalPedalStates;
  const setPedalStates = externalOnPedalStatesChange  !== undefined ? externalOnPedalStatesChange  : setInternalPedalStates;

  // When a preset is loaded push every pedal to hardware.
  const handleLoadPreset = useCallback(async (newStates: Record<string, PedalState>) => {
    setPedalStates(newStates);
    for (const [name, state] of Object.entries(newStates)) {
      const def = PEDAL_DEFS[name];
      if (def) await syncToHardware(name, def, state);
    }
  }, [setPedalStates]);

  // Dynamic cards — rebuilt when pedalStates changes.
  const dynamicCards = useMemo<BentoCardProps[]>(() => [
    {
      color: cardColour, title: 'Effects', description: 'Pedal selector',
      label: 'DSP', glowRgb: '0, 255, 255', contentInteractive: true,
      content: (
        <div style={{ height: '190%', position: 'relative', top: '-20px', scale: '120%' }}>
          <CircularGallery
            textColor={theme === 'dark' ? '#ffffff' : '#000000'}
            scrollEase={0.3} bend={1} borderRadius={0.05} scrollSpeed={7}
            pedalStates={pedalStates}
            onPedalStatesChange={setPedalStates}
            theme={theme}
          />
        </div>
      ),
    },
    {
      color: 'rgba(0,0,0,0.92)', title: 'Load/Save Setups',
      description: 'Streamline workflows', label: 'Presets',
      glowRgb: '255, 0, 255', contentInteractive: true,
      content: (
        <PresetsCard
          pedalStates={pedalStates}
          onLoad={handleLoadPreset}
          onPresetSaved={onPresetSaved}
        />
      ),
    },
  ], [pedalStates, setPedalStates, handleLoadPreset, onPresetSaved, theme]);

  const cardData: BentoCardProps[] = useMemo(() => [
    { ...STATIC_CARDS[0], content: CARD1_CONTENT, contentInteractive: true },
    { ...STATIC_CARDS[1], content: CARD2_CONTENT, contentInteractive: true },
    ...dynamicCards,
  ], [dynamicCards]);

  const baseClassName = () =>
    `magic-bento-card ${textAutoHide ? 'magic-bento-card--text-autohide' : ''} ${enableBorderGlow ? 'magic-bento-card--border-glow' : ''}`;

  const cardStyle = (card: BentoCardProps): React.CSSProperties => ({
    backgroundColor: card.color,
    '--glow-color': glowColor,
    '--glow-rgb':   card.glowRgb || glowColor,
  } as React.CSSProperties);

  return (
    <>
      {enableSpotlight && (
        <GlobalSpotlight
          gridRef={gridRef}
          disableAnimations={shouldDisableAnimations}
          enabled={enableSpotlight}
          spotlightRadius={spotlightRadius}
          glowColor={glowColor}
        />
      )}
      <div className="card-grid bento-section" ref={gridRef}>
        {cardData.map((card, index) =>
          enableStars ? (
            <ParticleCard
              key={index}
              className={baseClassName()}
              style={cardStyle(card)}
              disableAnimations={shouldDisableAnimations}
              particleCount={particleCount}
              glowColor={glowColor}
              enableTilt={enableTilt}
              clickEffect={clickEffect}
              enableMagnetism={enableMagnetism}
            >
              <CardInner card={card} />
            </ParticleCard>
          ) : (
            <div key={index} className={baseClassName()} style={cardStyle(card)}>
              <CardInner card={card} />
            </div>
          )
        )}
      </div>
    </>
  );
};

export default MagicBento;