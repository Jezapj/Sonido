/**
 * handRig
 *
 * Rigged 3D hands for the piano view, drawn on their own WebGL canvas over the
 * keyboard. Models are the WebXR "generic-hand" meshes (see assets/hands/LICENSE.md).
 * The view says where each fingertip should be on screen; each finger is then
 * turned and curled until it gets there.
 */

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import leftUrl from "./assets/hands/left.glb?url";
import rightUrl from "./assets/hands/right.glb?url";

export const HAND_TONES = {
  light:  "#f3d5c0",
  fair:   "#e8c09f",
  medium: "#d09a74",
  tan:    "#b37b54",
  brown:  "#7f5439",
  deep:   "#503427",
} as const;

export type HandTone = keyof typeof HAND_TONES;
export type HandLook = "outline" | HandTone;

const OUTLINE_COLOR = "#7a5cff";
const OUTLINE_PX = 2;
const NAIL_TINT = new THREE.Color("#ffece6");

/** Width of a real white key, which sets the size of the (life-size) model. */
export const WHITE_KEY_M = 0.0235;
/** How far the fingers slope down to the keys. */
const HAND_PITCH = 0.42;
const THUMB = 0;

const FINGER_NAMES = ["thumb", "index-finger", "middle-finger", "ring-finger", "pinky-finger"];
const JOINTS = ["metacarpal", "phalanx-proximal", "phalanx-intermediate", "phalanx-distal", "tip"];
const THUMB_JOINTS = ["metacarpal", "phalanx-proximal", "phalanx-distal", "tip"];

/** How the curl is shared between the three joints of a finger. */
const CURL_SHARE = [1, 1.25, 0.75];
const THUMB_CURL_SHARE = [0, 0.5, 0.8];   // the thumb stays out to the side instead of folding under the palm
const MAX_CURL = 1.05;
const MAX_YAW = 0.4;
const MAX_THUMB_YAW = 0.75;
const THUMB_CURL = 0.3;

const X_AXIS = new THREE.Vector3(1, 0, 0);
const NAIL_SHAPE = new THREE.SphereGeometry(1, 16, 12);

/** Where a finger starts and how long it is, in metres from the middle knuckle (screen axes, y down). */
export interface FingerGeom { baseX: number; baseY: number; length: number; }

interface FingerRig {
  aim: THREE.Bone;                 // turned to point the finger
  yawAxis: THREE.Vector3;          // in the aim bone's frame
  yawSign: number;
  bindYaw: number;
  curl: { bone: THREE.Bone; bind: THREE.Quaternion; axis: THREE.Vector3; sign: number }[];
  lengths: number[];
}

interface HandModel {
  pivot: THREE.Group;
  armature: THREE.Object3D;
  fingers: FingerRig[];
  geom: FingerGeom[];
  knuckle: THREE.Vector3;
  toScreen: THREE.Quaternion;
  nails: THREE.Mesh[];
  skin: THREE.SkinnedMesh;
  hull: THREE.SkinnedMesh;
  mask: THREE.SkinnedMesh;
}

export interface HandPose {
  x: number;                                 // screen x of the middle knuckle
  tips: { x: number; y: number }[];          // thumb → little finger
}

export interface RigFrame {
  w: number;
  top: number;                               // screen y of the canvas's top edge
  h: number;
  dpr: number;
  scale: number;                             // pixels per metre
  knuckleY: number;
  left: HandPose;
  right: HandPose;
  look: HandLook;
}

function buildHand(
  root: THREE.Object3D, side: 1 | -1, material: THREE.Material, hullMat: THREE.Material,
  maskMat: THREE.Material, nailMat: THREE.Material,
): HandModel {
  const armature = root.getObjectByName("Armature") ?? root;
  const named = (finger: number, joint: string) => {
    const b = root.getObjectByName(`${FINGER_NAMES[finger]}-${joint}`);
    if (!b) throw new Error(`hand model has no ${FINGER_NAMES[finger]}-${joint}`);
    return b as THREE.Bone;
  };
  const wrist = root.getObjectByName("wrist") as THREE.Bone;

  // The file's bones are all siblings in model space. Remember each one's pose,
  // then chain them so that turning a joint carries everything beyond it.
  const chains = FINGER_NAMES.map((_, f) => (f === THUMB ? THUMB_JOINTS : JOINTS).map(j => named(f, j)));
  const P = new Map<THREE.Object3D, THREE.Vector3>();
  const Q = new Map<THREE.Object3D, THREE.Quaternion>();
  for (const b of [wrist, ...chains.flat()]) { P.set(b, b.position.clone()); Q.set(b, b.quaternion.clone()); }
  const attach = (child: THREE.Object3D, parent: THREE.Object3D) => {
    const inv = Q.get(parent)!.clone().invert();
    child.position.copy(P.get(child)!).sub(P.get(parent)!).applyQuaternion(inv);
    child.quaternion.copy(inv).multiply(Q.get(child)!);
    parent.add(child);
  };
  for (const chain of chains) {
    attach(chain[0], wrist);
    for (let i = 1; i < chain.length; i++) attach(chain[i], chain[i - 1]);
  }

  // Work out how this model is oriented: back of the hand to the camera, fingers up the screen
  const knuckle = P.get(named(2, "phalanx-proximal"))!.clone();
  const up = P.get(named(2, "tip"))!.clone().sub(knuckle).normalize();
  const across = P.get(named(4, "phalanx-proximal"))!.clone().sub(P.get(named(1, "phalanx-proximal"))!);
  const screenRight = across.addScaledVector(up, -across.dot(up)).normalize().multiplyScalar(side);
  const back = new THREE.Vector3().crossVectors(screenRight, up).normalize();
  const towardsPalm = back.clone().negate();
  const toScreen = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(screenRight, up, back)).invert();

  const fingers: FingerRig[] = chains.map((chain, f) => {
    const joints = f === THUMB ? chain : chain.slice(1);   // fingers bend from the big knuckle
    const aim = joints[0], tipBone = chain[chain.length - 1];
    const tipFrom = (b: THREE.Object3D) => P.get(tipBone)!.clone().sub(P.get(b)!);
    const qAim = Q.get(aim)!;

    const yawAxis = back.clone().applyQuaternion(qAim.clone().invert());
    const along = tipFrom(aim);
    const yawSign = Math.sign(back.clone().cross(along).dot(screenRight)) || 1;
    const bindYaw = Math.atan2(along.dot(screenRight), along.dot(up));

    const lengths: number[] = [];
    for (let i = 0; i + 1 < joints.length; i++) {
      lengths.push(P.get(joints[i + 1])!.distanceTo(P.get(joints[i])!));
    }

    const curl = joints.slice(0, -1).map(bone => {
      const axis = X_AXIS.clone();
      const world = axis.clone().applyQuaternion(Q.get(bone)!);
      const dv = world.cross(tipFrom(bone));
      // Which way round is "towards the palm" (for the thumb, in across it)
      const inward = f === THUMB
        ? P.get(named(2, "phalanx-proximal"))!.clone().sub(P.get(bone)!).normalize().add(towardsPalm)
        : towardsPalm;
      return { bone, bind: bone.quaternion.clone(), axis, sign: Math.sign(dv.dot(inward)) || 1 };
    });

    return { aim, yawAxis, yawSign, bindYaw, curl, lengths };
  });

  const geom: FingerGeom[] = fingers.map(rig => {
    const base = P.get(rig.aim)!.clone().sub(knuckle);
    return { baseX: base.dot(screenRight), baseY: -base.dot(up), length: rig.lengths.reduce((a, b) => a + b, 0) };
  });

  let skin: THREE.SkinnedMesh | null = null;
  root.traverse(o => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) skin = o as THREE.SkinnedMesh; });
  if (!skin) throw new Error("hand model has no skinned mesh");
  const mesh = skin as THREE.SkinnedMesh;
  mesh.frustumCulled = false;
  mesh.material = material;

  const twin = (mat: THREE.Material, order: number) => {
    const m = new THREE.SkinnedMesh(mesh.geometry, mat);
    m.bind(mesh.skeleton, mesh.bindMatrix);
    m.frustumCulled = false;
    m.renderOrder = order;
    mesh.parent!.add(m);
    return m;
  };
  const hull = twin(hullMat, 1);
  const mask = twin(maskMat, 2);

  // The mesh has no nails, so each fingertip gets one, seated on the skin
  const positions = mesh.geometry.getAttribute("position");
  const skinIndex = mesh.geometry.getAttribute("skinIndex");
  const nails = chains.map(chain => {
    const distal = chain[chain.length - 2], tip = chain[chain.length - 1];
    const pd = P.get(distal)!, along = P.get(tip)!.clone().sub(pd);
    const length = along.length();
    const centre = pd.clone().addScaledVector(along, 0.62);
    const axis = along.clone().normalize();
    const lateral = new THREE.Vector3().crossVectors(back, axis).normalize();
    const own = new Set([mesh.skeleton.bones.indexOf(distal), mesh.skeleton.bones.indexOf(tip)]);
    let height = 0, halfWidth = 0;
    const v = new THREE.Vector3();
    for (let i = 0; i < positions.count; i++) {
      if (!own.has(skinIndex.getX(i))) continue;   // this finger's skin only
      v.fromBufferAttribute(positions, i).sub(centre);
      if (Math.abs(v.dot(axis)) > length * 0.3) continue;
      height = Math.max(height, v.dot(back));
      halfWidth = Math.max(halfWidth, Math.abs(v.dot(lateral)));
    }
    const nail = new THREE.Mesh(NAIL_SHAPE, nailMat);
    const inv = Q.get(distal)!.clone().invert();
    nail.position.copy(centre).addScaledVector(back, height * 1.04).sub(pd).applyQuaternion(inv);
    nail.quaternion.copy(inv).multiply(
      new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(lateral, back, axis)),
    );
    nail.scale.set(halfWidth * 0.74, height * 0.16, length * 0.46);
    distal.add(nail);
    return nail;
  });

  const pivot = new THREE.Group();
  pivot.add(armature);
  return { pivot, armature, fingers, geom, knuckle, toScreen, nails, skin: mesh, hull, mask };
}

const projected = (lengths: number[], curl: number) => {
  let sum = 0, angle = HAND_PITCH;
  lengths.forEach((l, i) => {
    angle += curl * CURL_SHARE[i];
    sum += l * Math.cos(angle);
  });
  return sum;
};

/** The curl that makes the finger span `dist` metres on screen. */
function solveCurl(lengths: number[], dist: number) {
  let lo = 0, hi = MAX_CURL;
  for (let i = 0; i < 10; i++) {
    const mid = (lo + hi) / 2;
    if (projected(lengths, mid) > dist) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

const scratch = new THREE.Quaternion();

function poseHand(model: HandModel, pose: HandPose, frame: RigFrame) {
  const { scale, knuckleY } = frame;
  model.pivot.position.set(pose.x, -knuckleY, 0);
  model.pivot.rotation.set(-HAND_PITCH, 0, 0);
  model.armature.scale.setScalar(scale);
  model.armature.quaternion.copy(model.toScreen);
  model.armature.position.copy(model.knuckle).multiplyScalar(-scale).applyQuaternion(model.toScreen);

  const cosPitch = Math.cos(HAND_PITCH);
  model.fingers.forEach((rig, f) => {
    const g = model.geom[f], tip = pose.tips[f];
    const bx = pose.x + g.baseX * scale, by = knuckleY + g.baseY * scale * cosPitch;
    const dx = tip.x - bx, dy = by - tip.y;
    const limit = f === THUMB ? MAX_THUMB_YAW : MAX_YAW;
    const yaw = Math.max(-limit, Math.min(limit, Math.atan2(dx, dy) - rig.bindYaw));
    const curl = f === THUMB ? THUMB_CURL : solveCurl(rig.lengths, Math.hypot(dx, dy) / scale);

    rig.curl.forEach((c, j) => {
      const share = (f === THUMB ? THUMB_CURL_SHARE : CURL_SHARE)[j];
      c.bone.quaternion.copy(c.bind).multiply(scratch.setFromAxisAngle(c.axis, c.sign * curl * share));
    });
    rig.aim.quaternion.multiply(scratch.setFromAxisAngle(rig.yawAxis, rig.yawSign * yaw));
  });
}

export class HandRig {
  readonly canvas = document.createElement("canvas");
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(0, 1, 0, -1, -2000, 2000);
  private skinMat = new THREE.MeshStandardMaterial({ roughness: 0.58, metalness: 0 });
  private hullMat: THREE.MeshLambertMaterial;
  private maskMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0, blending: THREE.NoBlending });
  private nailMat = new THREE.MeshStandardMaterial({ roughness: 0.28, metalness: 0 });
  private outlineWidth = { value: 0.001 };
  private left: HandModel | null = null;
  private right: HandModel | null = null;
  private tone: HandTone | null = null;
  private disposed = false;

  constructor() {
    this.canvas.style.cssText = "position:absolute;left:0;bottom:0;width:100%;pointer-events:none;display:block;";
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true, premultipliedAlpha: true });
    this.renderer.setClearColor(0x000000, 0);

    // Outline: the mesh pushed out along its normals, seen only from behind, with
    // the hand's interior then punched out so the keys show through it
    const width = this.outlineWidth;
    this.hullMat = new THREE.MeshLambertMaterial({ color: 0x000000, emissive: OUTLINE_COLOR, side: THREE.BackSide });
    this.hullMat.onBeforeCompile = shader => {
      shader.uniforms.outlineWidth = width;
      shader.vertexShader = `uniform float outlineWidth;\n${shader.vertexShader}`.replace(
        "#include <skinning_vertex>",
        "#include <skinning_vertex>\ntransformed += normalize(objectNormal) * outlineWidth;",
      );
    };

    // A warm key light raking across the back of the hand, so the knuckles and tendons model
    this.scene.add(new THREE.HemisphereLight(0xfff4ec, 0x4a3530, 1.15));
    const key = new THREE.DirectionalLight(0xfff0e2, 2.7);
    key.position.set(-0.55, 0.75, 0.75);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xffd9c9, 0.55);
    fill.position.set(0.9, -0.3, 0.45);
    this.scene.add(fill);
  }

  async load() {
    const loader = new GLTFLoader();
    const [l, r] = await Promise.all([loader.loadAsync(leftUrl), loader.loadAsync(rightUrl)]);
    if (this.disposed) return;
    this.left = buildHand(l.scene, -1, this.skinMat, this.hullMat, this.maskMat, this.nailMat);
    this.right = buildHand(r.scene, 1, this.skinMat, this.hullMat, this.maskMat, this.nailMat);
    this.scene.add(this.left.pivot, this.right.pivot);
  }

  get geometry() {
    return this.left && this.right ? { left: this.left.geom, right: this.right.geom } : null;
  }

  render(frame: RigFrame) {
    if (!this.left || !this.right) return;
    const { w, top, h, dpr } = frame;
    const height = Math.max(1, Math.round(h - top));
    const pw = Math.round(w * dpr), ph = Math.round(height * dpr);
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.renderer.setPixelRatio(dpr);
      this.renderer.setSize(w, height, false);
    }
    this.canvas.style.height = `${height}px`;

    const cam = this.camera;
    cam.left = 0; cam.right = w; cam.top = -top; cam.bottom = -h;
    cam.updateProjectionMatrix();

    const outline = frame.look === "outline";
    if (frame.look !== "outline" && frame.look !== this.tone) {
      this.tone = frame.look;
      this.skinMat.color.set(HAND_TONES[frame.look]);
      this.nailMat.color.set(HAND_TONES[frame.look]).lerp(NAIL_TINT, 0.5);
    }
    this.canvas.style.filter = outline ? "" : "drop-shadow(0 5px 6px rgba(8,4,18,0.5))";
    this.outlineWidth.value = OUTLINE_PX / frame.scale;
    for (const hand of [this.left, this.right]) {
      hand.skin.visible = !outline;
      hand.hull.visible = outline;
      hand.mask.visible = outline;
      for (const nail of hand.nails) nail.visible = !outline;
    }
    poseHand(this.left, frame.left, frame);
    poseHand(this.right, frame.right, frame);
    this.renderer.render(this.scene, cam);
  }

  dispose() {
    this.disposed = true;
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
  }
}
