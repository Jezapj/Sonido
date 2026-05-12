import { Camera, Mesh, Plane, Program, Renderer, Texture, Transform } from 'ogl';
import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import PedalOverlay from './PedalOverlay';
import type { PedalState } from './PedalOverlay';
import './CircularGallery.css';

// ── Public types ──────────────────────────────────────────────────────────────

export interface GalleryItem {
  image: string;
  text: string;
}

interface CardPosition {
  text: string;
  cssX: number;
  cssY: number;
  halfW: number;
  halfH: number;
}

type GL = Renderer['gl'];

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_ITEMS: GalleryItem[] = [
  { image: `/L_Reverb(Spring)_pedal.png`,  text: 'Bridge' },
  { image: `/Chorus_pedal.png`,  text: 'Budapest' },
  { image: `L_Distortion_pedal.png`,  text: 'Strawberries' },
  { image: `/L_EQPreGain_pedal.png`,  text: 'Blurry Lights' },
  { image: `/L_OD_pedal.png`,  text: 'New York' },
  { image: `L_Phaser_pedal.png`, text: 'Good Boy' }
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function debounce<T extends (...args: any[]) => void>(func: T, wait: number) {
  let timeout: number;
  return function (this: any, ...args: Parameters<T>) {
    window.clearTimeout(timeout);
    timeout = window.setTimeout(() => func.apply(this, args), wait);
  };
}

function lerp(p1: number, p2: number, t: number): number {
  return p1 + (p2 - p1) * t;
}

function autoBind(instance: any): void {
  const proto = Object.getPrototypeOf(instance);
  Object.getOwnPropertyNames(proto).forEach(key => {
    if (key !== 'constructor' && typeof instance[key] === 'function') {
      instance[key] = instance[key].bind(instance);
    }
  });
}

function getFontSize(font: string): number {
  const match = font.match(/(\d+)px/);
  return match ? parseInt(match[1], 10) : 30;
}

function createTextTexture(
  gl: GL, text: string,
  font = 'bold 30px monospace', color = 'black'
): { texture: Texture; width: number; height: number } {
  const canvas  = document.createElement('canvas');
  const context = canvas.getContext('2d')!;
  context.font  = font;
  const tw      = Math.ceil(context.measureText(text).width);
  const fsize   = getFontSize(font);
  const th      = Math.ceil(fsize * 1.2);
  canvas.width  = tw + 20;
  canvas.height = th + 20;
  context.font          = font;
  context.fillStyle     = color;
  context.textBaseline  = 'middle';
  context.textAlign     = 'center';
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillText(text, canvas.width / 2, canvas.height / 2);
  const texture = new Texture(gl, { generateMipmaps: false });
  texture.image = canvas;
  return { texture, width: canvas.width, height: canvas.height };
}

// ── Title ─────────────────────────────────────────────────────────────────────

class Title {
  gl: GL; plane: Mesh; renderer: Renderer;
  text: string; textColor: string; font: string; mesh!: Mesh;

  constructor({ gl, plane, renderer, text, textColor = '#030303', font = '30px sans-serif' }:
    { gl: GL; plane: Mesh; renderer: Renderer; text: string; textColor?: string; font?: string }) {
    autoBind(this);
    this.gl = gl; this.plane = plane; this.renderer = renderer;
    this.text = text; this.textColor = textColor; this.font = font;
    this.createMesh();
  }

  createMesh() {
    const { texture, width, height } = createTextTexture(this.gl, this.text, this.font, this.textColor);
    const geometry = new Plane(this.gl);
    const program  = new Program(this.gl, {
      vertex:   `attribute vec3 position;attribute vec2 uv;uniform mat4 modelViewMatrix;uniform mat4 projectionMatrix;varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
      fragment: `precision highp float;uniform sampler2D tMap;varying vec2 vUv;void main(){vec4 c=texture2D(tMap,vUv);if(c.a<0.1)discard;gl_FragColor=c;}`,
      uniforms: { tMap: { value: texture } },
      transparent: true,
    });
    this.mesh = new Mesh(this.gl, { geometry, program });
    const aspect          = width / height;
    const textH           = this.plane.scale.y * 0.15;
    this.mesh.scale.set(textH * aspect, textH, 1);
    this.mesh.position.y  = -this.plane.scale.y * 0.5 - textH * 0.5 - 0.05;
    this.mesh.setParent(this.plane);
  }
}

// ── Media ─────────────────────────────────────────────────────────────────────

interface MediaProps {
  geometry: Plane; gl: GL; image: string; index: number; length: number;
  renderer: Renderer; scene: Transform;
  screen: { width: number; height: number };
  text: string;
  viewport: { width: number; height: number };
  bend: number; textColor: string; borderRadius?: number; font?: string;
}

class Media {
  extra   = 0; speed = 0; isBefore = false; isAfter = false;
  scale!: number; padding!: number; width!: number; widthTotal!: number; x!: number;
  program!: Program; plane!: Mesh; title!: Title;

  geometry!: Plane; gl!: GL ; image!: string ; index!: number ; length!: number;
  renderer!: Renderer; scene! : Transform;
  screen!: { width: number ; height: number };
  text!: string;
  viewport!: { width: number; height: number };
  bend!: number; textColor!: string; borderRadius: number; font?: string;

  constructor(props: MediaProps) {
    Object.assign(this, props);
    this.borderRadius = props.borderRadius ?? 0;
    this.createShader(); this.createMesh(); this.createTitle(); this.onResize();
  }

  createShader() {
    const texture = new Texture(this.gl, { generateMipmaps: true });
    this.program  = new Program(this.gl, {
      depthTest: false, depthWrite: false,
      vertex:   `precision highp float;attribute vec3 position;attribute vec2 uv;uniform mat4 modelViewMatrix;uniform mat4 projectionMatrix;uniform float uTime;uniform float uSpeed;varying vec2 vUv;void main(){vUv=uv;vec3 p=position;p.z=(sin(p.x*4.0+uTime)*1.5+cos(p.y*2.0+uTime)*1.5)*(0.1+uSpeed*0.5);gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.0);}`,
      fragment: `precision highp float;uniform vec2 uPlaneSizes;uniform vec2 uImageSizes;uniform sampler2D tMap;uniform float uBorderRadius;varying vec2 vUv;float rBox(vec2 p,vec2 b,float r){vec2 d=abs(p)-b;return length(max(d,vec2(0.0)))+min(max(d.x,d.y),0.0)-r;}void main(){vec2 ratio=vec2(min((uPlaneSizes.x/uPlaneSizes.y)/(uImageSizes.x/uImageSizes.y),1.0),min((uPlaneSizes.y/uPlaneSizes.x)/(uImageSizes.y/uImageSizes.x),1.0));vec2 uv=vec2(vUv.x*ratio.x+(1.0-ratio.x)*0.5,vUv.y*ratio.y+(1.0-ratio.y)*0.5);vec4 c=texture2D(tMap,uv);float d=rBox(vUv-0.5,vec2(0.5-uBorderRadius),uBorderRadius);gl_FragColor=vec4(c.rgb,c.a*(1.0-smoothstep(-0.002,0.002,d)));}`,
      uniforms: {
        tMap: { value: texture }, uPlaneSizes: { value: [0,0] },
        uImageSizes: { value: [0,0] }, uSpeed: { value: 0 },
        uTime: { value: 100*Math.random() }, uBorderRadius: { value: this.borderRadius },
      },
      transparent: true,
    });
    const img = new Image(); img.crossOrigin = 'anonymous'; img.src = this.image;
    img.onload = () => { texture.image = img; this.program.uniforms.uImageSizes.value = [img.naturalWidth, img.naturalHeight]; };
  }

  createMesh() {
    this.plane = new Mesh(this.gl, { geometry: this.geometry, program: this.program });
    this.plane.setParent(this.scene);
  }

  createTitle() {
    this.title = new Title({ gl: this.gl, plane: this.plane, renderer: this.renderer, text: this.text, textColor: this.textColor, font: this.font });
  }

  update(scroll: { current: number; last: number }, direction: 'right' | 'left') {
    this.plane.position.x = this.x - scroll.current - this.extra;
    const x = this.plane.position.x;
    const H = this.viewport.width / 2;
    if (this.bend === 0) {
      this.plane.position.y = 0; this.plane.rotation.z = 0;
    } else {
      const B = Math.abs(this.bend);
      const R = (H*H + B*B) / (2*B);
      const ex = Math.min(Math.abs(x), H);
      const arc = R - Math.sqrt(R*R - ex*ex);
      this.plane.position.y = this.bend > 0 ? -arc : arc;
      this.plane.rotation.z = (this.bend > 0 ? -1 : 1) * Math.sign(x) * Math.asin(ex / R);
    }
    this.speed = scroll.current - scroll.last;
    this.program.uniforms.uTime.value  += 0.04;
    this.program.uniforms.uSpeed.value  = this.speed;
    const po = this.plane.scale.x / 2;
    const vo = this.viewport.width / 2;
    this.isBefore = this.plane.position.x + po < -vo;
    this.isAfter  = this.plane.position.x - po >  vo;
    if (direction === 'right' && this.isBefore) { this.extra -= this.widthTotal; this.isBefore = this.isAfter = false; }
    if (direction === 'left'  && this.isAfter)  { this.extra += this.widthTotal; this.isBefore = this.isAfter = false; }
  }

  onResize({ screen, viewport }: { screen?: {width:number;height:number}; viewport?: {width:number;height:number} } = {}) {
    if (screen)   this.screen   = screen;
    if (viewport) this.viewport = viewport;
    this.scale  = this.screen.height / 1500;
    this.plane.scale.y = (this.viewport.height * (900 * this.scale)) / this.screen.height;
    this.plane.scale.x = (this.viewport.width  * (700 * this.scale)) / this.screen.width;
    this.program.uniforms.uPlaneSizes.value = [this.plane.scale.x, this.plane.scale.y];
    this.padding    = 2;
    this.width      = this.plane.scale.x + this.padding;
    this.widthTotal = this.width * this.length;
    this.x          = this.width * this.index;
  }
}

// ── App ───────────────────────────────────────────────────────────────────────

interface AppConfig {
  items?: GalleryItem[]; bend?: number; textColor?: string;
  borderRadius?: number; font?: string; scrollSpeed?: number; scrollEase?: number;
  onCardClick?:      (item: GalleryItem) => void;
  onFramePositions?: (positions: CardPosition[]) => void;
}

class App {
  container: HTMLElement;
  scrollSpeed: number;
  scroll: { ease: number; current: number; target: number; last: number; position?: number };
  onCheckDebounce: (...args: any[]) => void;
  onCardClick?:      (item: GalleryItem) => void;
  onFramePositions?: (positions: CardPosition[]) => void;

  private interactionEnabled = true;
  private startX = 0; private startY = 0; private lastX = 0;

  renderer!: Renderer; gl!: GL; camera!: Camera;
  scene!: Transform; planeGeometry!: Plane;
  medias: Media[] = []; mediasImages: GalleryItem[] = [];
  screen!: { width: number; height: number };
  viewport!: { width: number; height: number };
  raf = 0; isDown = false; start = 0;

  boundOnResize!: ()=>void; boundOnWheel!: (e:Event)=>void;
  boundOnTouchDown!: (e:MouseEvent|TouchEvent)=>void;
  boundOnTouchMove!: (e:MouseEvent|TouchEvent)=>void;
  boundOnTouchUp!:   ()=>void;

  constructor(container: HTMLElement, {
    items, bend=1, textColor='#ffffff', borderRadius=0,
    font='bold 30px Figtree', scrollSpeed=2, scrollEase=0.05,
    onCardClick, onFramePositions,
  }: AppConfig) {
    document.documentElement.classList.remove('no-js');
    this.container        = container;
    this.scrollSpeed      = scrollSpeed;
    this.scroll           = { ease: scrollEase, current: 0, target: 0, last: 0 };
    this.onCardClick      = onCardClick;
    this.onFramePositions = onFramePositions;
    this.onCheckDebounce  = debounce(this.onCheck.bind(this), 200);
    this.createRenderer(); this.createCamera(); this.createScene();
    this.onResize(); this.createGeometry();
    this.createMedias(items, bend, textColor, borderRadius, font);
    this.update(); this.addEventListeners();
  }

  setInteractionEnabled(v: boolean) { this.interactionEnabled = v; }

  createRenderer() {
    this.renderer = new Renderer({ alpha:true, antialias:true, dpr: Math.min(window.devicePixelRatio||1,2) });
    this.gl = this.renderer.gl;
    this.gl.clearColor(0,0,0,0);
    this.container.appendChild(this.renderer.gl.canvas as HTMLCanvasElement);
  }

  createCamera() { this.camera = new Camera(this.gl); this.camera.fov = 45; this.camera.position.z = 20; }
  createScene()  { this.scene  = new Transform(); }
  createGeometry() { this.planeGeometry = new Plane(this.gl, { heightSegments:50, widthSegments:100 }); }

  createMedias(items: GalleryItem[]|undefined, bend:number, textColor:string, borderRadius:number, font:string) {
    const gi = items?.length ? items : DEFAULT_ITEMS;
    this.mediasImages = gi.concat(gi);
    this.medias = this.mediasImages.map((data, index) => new Media({
      geometry: this.planeGeometry, gl: this.gl, image: data.image,
      index, length: this.mediasImages.length, renderer: this.renderer,
      scene: this.scene, screen: this.screen, text: data.text,
      viewport: this.viewport, bend, textColor, borderRadius, font,
    }));
  }

  private worldToCss(worldX: number, worldY: number) {
    return {
      cssX: (worldX / this.viewport.width  + 0.5) * this.screen.width,
      cssY: (0.5 - worldY / this.viewport.height) * this.screen.height,
    };
  }

  private findClickedItem(clientX: number, clientY: number): GalleryItem | null {
    const canvas = this.renderer.gl.canvas as HTMLCanvasElement;
    const rect   = canvas.getBoundingClientRect();
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null;
    const worldX = ((clientX - rect.left)*0.8 / this.screen.width - 0.5) * this.viewport.width + 1;
    let closest: Media|null = null; let minDist = Infinity;
    for (const m of this.medias) {
      const d = Math.abs(m.plane.position.x - worldX);
      if (d < m.plane.scale.x / 2 && d < minDist) { minDist = d; closest = m; }
    }
    return closest ? (this.mediasImages[closest.index] ?? null) : null;
  }

  onTouchDown(e: MouseEvent|TouchEvent) {
    if (!this.interactionEnabled) return;
    this.isDown = true; this.scroll.position = this.scroll.current;
    const cx = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const cy = 'touches' in e ? e.touches[0].clientY : e.clientY;
    this.start = cx; this.startX = cx; this.startY = cy; this.lastX = cx;
  }

  onTouchMove(e: MouseEvent|TouchEvent) {
    if (!this.interactionEnabled || !this.isDown) return;
    const x     = 'touches' in e ? e.touches[0].clientX : e.clientX;
    this.lastX  = x;
    this.scroll.target = (this.scroll.position ?? 0) + (this.start - x) * (this.scrollSpeed * 0.025);
  }

  onTouchUp() {
    if (!this.interactionEnabled) return;
    const moved = Math.abs(this.lastX - this.startX);
    this.isDown = false;
    if (moved < 6 && this.onCardClick) {
      const item = this.findClickedItem(this.startX, this.startY);
      if (item) { this.onCardClick(item); return; }
    }
    this.onCheck();
  }

  onWheel(e: Event) {
    if (!this.interactionEnabled) return;
    const ev = e as WheelEvent;
    const delta = ev.deltaY || (ev as any).wheelDelta || (ev as any).detail;
    this.scroll.target += (delta > 0 ? this.scrollSpeed : -this.scrollSpeed) * 0.2;
    this.onCheckDebounce();
  }

  onCheck() {
    if (!this.medias?.[0]) return;
    const w = this.medias[0].width;
    const i = Math.round(Math.abs(this.scroll.target) / w) * w;
    this.scroll.target = this.scroll.target < 0 ? -i : i;
  }

  onResize() {
    this.screen = { width: this.container.clientWidth, height: this.container.clientHeight };
    this.renderer.setSize(this.screen.width, this.screen.height);
    this.camera.perspective({ aspect: this.screen.width / this.screen.height });
    const fov = (this.camera.fov * Math.PI) / 180;
    const h   = 2 * Math.tan(fov / 2) * this.camera.position.z;
    this.viewport = { width: h * this.camera.aspect, height: h };
    this.medias?.forEach(m => m.onResize({ screen: this.screen, viewport: this.viewport }));
  }

  update() {
    this.scroll.current = lerp(this.scroll.current, this.scroll.target, this.scroll.ease);
    const dir = this.scroll.current > this.scroll.last ? 'right' : 'left';
    this.medias?.forEach(m => m.update(this.scroll, dir));
    this.renderer.render({ scene: this.scene, camera: this.camera });

    if (this.onFramePositions && this.screen) {
      const best = new Map<string, Media>();
      for (const m of this.medias) {
        const t = this.mediasImages[m.index].text;
        const existing = best.get(t);
        if (!existing || Math.abs(m.plane.position.x) < Math.abs(existing.plane.position.x)) best.set(t, m);
      }
      const positions: CardPosition[] = [];
      best.forEach((m, text) => {
        const { cssX, cssY } = this.worldToCss(m.plane.position.x, m.plane.position.y);
        const halfW = (m.plane.scale.x / this.viewport.width)  * this.screen.width  / 2;
        const halfH = (m.plane.scale.y / this.viewport.height) * this.screen.height / 2;
        positions.push({ text, cssX, cssY, halfW, halfH });
      });
      this.onFramePositions(positions);
    }

    this.scroll.last = this.scroll.current;
    this.raf = window.requestAnimationFrame(this.update.bind(this));
  }

  addEventListeners() {
    this.boundOnResize    = this.onResize.bind(this);
    this.boundOnWheel     = this.onWheel.bind(this);
    this.boundOnTouchDown = this.onTouchDown.bind(this);
    this.boundOnTouchMove = this.onTouchMove.bind(this);
    this.boundOnTouchUp   = this.onTouchUp.bind(this);
    window.addEventListener('resize',     this.boundOnResize);
    window.addEventListener('mousewheel', this.boundOnWheel);
    window.addEventListener('wheel',      this.boundOnWheel);
    window.addEventListener('mousedown',  this.boundOnTouchDown);
    window.addEventListener('mousemove',  this.boundOnTouchMove);
    window.addEventListener('mouseup',    this.boundOnTouchUp);
    window.addEventListener('touchstart', this.boundOnTouchDown);
    window.addEventListener('touchmove',  this.boundOnTouchMove);
    window.addEventListener('touchend',   this.boundOnTouchUp);
  }

  destroy() {
    window.cancelAnimationFrame(this.raf);
    window.removeEventListener('resize',     this.boundOnResize);
    window.removeEventListener('mousewheel', this.boundOnWheel);
    window.removeEventListener('wheel',      this.boundOnWheel);
    window.removeEventListener('mousedown',  this.boundOnTouchDown);
    window.removeEventListener('mousemove',  this.boundOnTouchMove);
    window.removeEventListener('mouseup',    this.boundOnTouchUp);
    window.removeEventListener('touchstart', this.boundOnTouchDown);
    window.removeEventListener('touchmove',  this.boundOnTouchMove);
    window.removeEventListener('touchend',   this.boundOnTouchUp);
    const c = this.renderer?.gl?.canvas as HTMLCanvasElement|undefined;
    if (c?.parentNode) c.parentNode.removeChild(c);
  }
}

// ── React component ───────────────────────────────────────────────────────────

interface CircularGalleryProps {
  items?: GalleryItem[];
  bend?: number;
  textColor?: string;
  borderRadius?: number;
  font?: string;
  scrollSpeed?: number;
  scrollEase?: number;
  // Optional controlled state — provided by MagicBento so PresetsCard can share it
  pedalStates?: Record<string, PedalState>;
  theme?: "dark" | "light";
  onPedalStatesChange?: (states: Record<string, PedalState>) => void;
}

export default function CircularGallery({
  items, bend=3, textColor='#ffffff',
  borderRadius=0.05, font='bold 30px Figtree',
  scrollSpeed=2, scrollEase=0.05,
  pedalStates: externalPedalStates,
  onPedalStatesChange, theme="dark"
}: CircularGalleryProps) {
  const containerRef  = useRef<HTMLDivElement>(null);
  const appRef        = useRef<App|null>(null);
  const dotRefs       = useRef<Record<string, HTMLDivElement>>({});

  const [clickedItem, setClickedItem] = useState<GalleryItem|null>(null);

  // ── Controlled / uncontrolled pedal state ──────────────────────────────────
  // When pedalStates prop is provided, use it (controlled by parent).
  // Otherwise manage internally as before.
  const [internalPedalStates, setInternalPedalStates] = useState<Record<string, PedalState>>({});

  const pedalStates = externalPedalStates !== undefined
    ? externalPedalStates
    : internalPedalStates;

  const updatePedalState = useCallback((text: string, state: PedalState) => {
    const newStates = { ...pedalStates, [text]: state };
    if (onPedalStatesChange) {
      onPedalStatesChange(newStates);
    } else {
      setInternalPedalStates(prev => ({ ...prev, [text]: state }));
    }
  }, [pedalStates, onPedalStatesChange]);

  // ─────────────────────────────────────────────────────────────────────────

  const uniqueTexts = useMemo(() =>
    (items?.length ? items : DEFAULT_ITEMS).map(i => i.text), [items]);

  const onFramePositions = useCallback((positions: CardPosition[]) => {
    positions.forEach(({ text, cssX, cssY, halfW, halfH }) => {
      const dot = dotRefs.current[text];
      if (!dot) return;
      const x = cssX + halfW - 16;
      const y = cssY - halfH + 6;
      dot.style.transform = `translate(${x}px,${y}px)`;
      const visible = cssX + halfW > 0 && cssX - halfW < (appRef.current?.screen.width ?? 9999);
      dot.style.opacity = visible ? '1' : '0';
    });
  }, []);

  // Update dot colours whenever pedalStates changes (reacts to preset loads too)
  useEffect(() => {
    uniqueTexts.forEach(text => {
      const dot = dotRefs.current[text];
      if (!dot) return;
      const enabled = pedalStates[text]?.enabled ?? false;
      dot.style.background = enabled ? '#22c55e' : '#ef4444';
      dot.style.boxShadow  = enabled
        ? '0 0 6px rgba(34,197,94,0.8)'
        : '0 0 6px rgba(239,68,68,0.8)';
    });
  }, [pedalStates, uniqueTexts]);

  useEffect(() => {
    if (!containerRef.current) return;
    const app = new App(containerRef.current, {
      items, bend, textColor, borderRadius, font, scrollSpeed, scrollEase,
      onCardClick:      item => setClickedItem(item),
      onFramePositions,
    });
    appRef.current = app;
    return () => { app.destroy(); appRef.current = null; };
  }, [items, bend, textColor, borderRadius, font, scrollSpeed, scrollEase, onFramePositions]);

  useEffect(() => {
    appRef.current?.setInteractionEnabled(clickedItem === null);
  }, [clickedItem]);

  return (
    <div className="circular-gallery" ref={containerRef}>
      <div className="cg-dot-layer">
        {uniqueTexts.map(text => (
          <div
            key={text}
            className="cg-status-dot"
            ref={el => { if (el) dotRefs.current[text] = el; }}
          />
        ))}
      </div>

      {clickedItem && (
        <PedalOverlay
          item={clickedItem}
          state={pedalStates[clickedItem.text]}
          onStateChange={state => updatePedalState(clickedItem.text, state)}
          onClose={() => setClickedItem(null)}
        />
      )}
    </div>
  );
}